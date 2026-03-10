import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import Anthropic from 'npm:@anthropic-ai/sdk@0.39.0';
import {
  getIdleConversationsNeedingSummary,
  getUnsummarisedMessages,
  saveConversationSummary,
} from '../_shared/state.ts';
import { processMemoryExtraction, type ExtractionResult } from '../_shared/memory.ts';
import { EXTRACTOR_VERSION } from '../_shared/env.ts';

const client = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY'),
});

const SUMMARY_PROMPT = `You are a memory extraction system for a messaging assistant called Nest. Given a conversation segment, produce a structured JSON summary.

Respond with ONLY valid JSON in this exact format:
{
  "summary": "2-4 sentence summary. Preserve uncertainty. Mention unresolved tasks. Do not invent claims about user identity unless explicitly stated.",
  "topics": ["short", "topic", "tags"],
  "open_loops": ["any unresolved questions or tasks, or empty array"]
}

Rules:
- Summary must be 2-4 sentences, accurate and compact
- Preserve uncertainty where present ("they mentioned they might..." not "they will...")
- Preserve corrections where present
- Mention unresolved tasks or questions in open_loops
- Avoid strong claims about user identity unless explicitly stated
- topics should be 1-3 word tags, lowercase
- If the conversation is trivial small talk with nothing worth summarising, still provide a brief summary but keep topics minimal`;

interface SummaryOutput {
  summary: string;
  topics: string[];
  openLoops: string[];
}

async function generateSummary(conversationText: string): Promise<SummaryOutput | null> {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: SUMMARY_PROMPT,
      messages: [{ role: 'user', content: conversationText }],
    });

    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') return null;

    const parsed = JSON.parse(text.text);
    if (!parsed?.summary || typeof parsed.summary !== 'string') return null;

    return {
      summary: parsed.summary.trim(),
      topics: Array.isArray(parsed.topics)
        ? parsed.topics.filter((t: unknown): t is string => typeof t === 'string').slice(0, 10)
        : [],
      openLoops: Array.isArray(parsed.open_loops)
        ? parsed.open_loops.filter((l: unknown): l is string => typeof l === 'string').slice(0, 5)
        : [],
    };
  } catch (error) {
    console.error('[summarise] Summary generation error:', error);
    return null;
  }
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    let body: { batchSize?: number } = {};
    try {
      body = await req.json();
    } catch {
      // empty body is fine
    }

    const batchSize = Math.max(1, Math.min(body.batchSize ?? 10, 20));
    const idleConversations = await getIdleConversationsNeedingSummary(15, batchSize);

    if (idleConversations.length === 0) {
      return jsonResponse({ message: 'No idle conversations to summarise', count: 0 });
    }

    let summariesCreated = 0;
    let totalMemoriesWritten = 0;
    const errors: string[] = [];

    for (const conv of idleConversations) {
      try {
        const messages = await getUnsummarisedMessages(conv.chatId, conv.sinceTs);
        if (messages.length === 0) continue;

        const conversationText = messages
          .map((m) => {
            const sender = m.role === 'assistant' ? 'Nest' : (m.handle || 'User');
            return `[${sender}]: ${m.content}`;
          })
          .join('\n');

        const summaryOutput = await generateSummary(conversationText);
        if (!summaryOutput) {
          console.error(`[summarise] Failed to generate summary for ${conv.chatId}`);
          continue;
        }

        const primaryHandle = messages.find((m) => m.role === 'user' && m.handle)?.handle ?? null;
        const messageIds = messages.map((m) => m.id);

        const summaryId = await saveConversationSummary({
          chatId: conv.chatId,
          senderHandle: primaryHandle,
          summary: summaryOutput.summary,
          topics: summaryOutput.topics,
          openLoops: summaryOutput.openLoops,
          firstMessageAt: conv.firstMessageAt,
          lastMessageAt: conv.lastMessageAt,
          messageCount: messages.length,
          sourceMessageIds: messageIds,
          extractorVersion: EXTRACTOR_VERSION,
        });

        if (summaryId === null) {
          console.log(`[summarise] Summary already exists for ${conv.chatId}, skipping`);
          continue;
        }

        summariesCreated += 1;

        const extractionResult: ExtractionResult = await processMemoryExtraction(messages, summaryId);
        totalMemoriesWritten += extractionResult.memoriesWritten;

        console.log(
          `[summarise] ${conv.chatId}: summary=${summaryId} candidates=${extractionResult.candidatesExtracted} written=${extractionResult.memoriesWritten} rejected=${extractionResult.memoriesRejected} confirmed=${extractionResult.memoriesConfirmed}`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[summarise] Error processing ${conv.chatId}:`, msg);
        errors.push(`${conv.chatId}: ${msg}`);
      }
    }

    return jsonResponse({
      message: `Processed ${idleConversations.length} conversation(s)`,
      summariesCreated,
      memoriesWritten: totalMemoriesWritten,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[summarise] Fatal error:', error);
    return jsonResponse({ error: msg }, 500);
  }
});

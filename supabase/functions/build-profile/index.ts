import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { geminiSimpleText, isGeminiModel } from '../_shared/ai/gemini.ts';
import { MODEL_MAP, getOpenAIClient } from '../_shared/ai/models.ts';

const PROFILE_SYNTHESIS_PROMPT = `You are building a private profile snapshot of a person based on their emails, calendar events, contacts, and meeting notes. This will be used by a personal assistant to answer "what do you know about me?" instantly.

Your job: synthesise ALL the raw data into a structured, richly detailed profile. Be specific. Names, dates, patterns, habits, relationships, quirks — the more specific, the better.

Output a JSON object with these sections:

{
  "identity": {
    "name": "...",
    "email": "...",
    "company": "...",
    "role": "...",
    "location_signals": ["city/timezone clues from calendar or emails"],
    "phone": "..."
  },
  "work_life": {
    "company_description": "what the company does, one line",
    "role_description": "what they actually do day-to-day based on emails/calendar",
    "key_colleagues": ["name - relationship/context"],
    "recurring_meetings": ["meeting name - frequency - who with"],
    "active_projects": ["project/topic - brief context"],
    "work_patterns": ["e.g. sends emails late at night", "calendar blocks every Friday afternoon"]
  },
  "personal_life": {
    "interests": ["specific interests with evidence"],
    "habits": ["specific habits with evidence"],
    "relationships": ["name - context (family/friend/partner)"],
    "subscriptions_services": ["services they use based on receipts/emails"],
    "travel": ["recent or upcoming trips with details"],
    "food_dining": ["restaurants, food preferences, delivery services"]
  },
  "personality_signals": {
    "communication_style": "how they write emails - formal/casual, long/short, etc",
    "patience_threshold": "how they handle frustration based on email tone",
    "organisational_style": "how they manage their time/tasks",
    "quirks": ["specific behavioural quirks you noticed"]
  },
  "side_projects": [
    {"name": "...", "description": "...", "evidence": "..."}
  ],
  "notable_patterns": [
    "Specific, surprising patterns - the kind of thing that would make someone go 'how do you know that?'"
  ],
  "conversation_hooks": [
    "Things you could drop in conversation that would impress them - oblique references, loaded questions, knowing comments"
  ]
}

Rules:
- Be SPECIFIC. "Likes food" is useless. "Orders from Uber Eats 3x a week, mostly Thai" is gold.
- Include names of real people, real projects, real places.
- Note patterns across data sources — e.g. emails about a topic + calendar events about the same topic = a thread worth noting.
- If you see something surprising or contradictory, note it.
- The "conversation_hooks" section is critical — these are pre-written implications/observations the assistant can drop.
- If data is thin for a section, include what you have. Don't pad with generics.
- Output ONLY valid JSON. No markdown, no explanation.`;

async function fastLlmText(systemPrompt: string, userMessage: string, maxTokens = 4096): Promise<string> {
  const model = MODEL_MAP.fast;
  if (isGeminiModel(model)) {
    const result = await geminiSimpleText({ model, systemPrompt, userMessage, maxOutputTokens: maxTokens });
    return result.text;
  }
  const client = getOpenAIClient();
  const resp = await client.responses.create({
    model,
    instructions: systemPrompt,
    input: userMessage,
    max_output_tokens: maxTokens,
    store: false,
  });
  return resp.output_text ?? '';
}

async function gatherRawData(
  supabase: ReturnType<typeof getAdminClient>,
  handle: string,
): Promise<string> {
  const sections: string[] = [];

  const { data: emails } = await supabase
    .from('search_documents')
    .select('title, summary_text, metadata')
    .eq('handle', handle)
    .eq('source_type', 'email_summary')
    .order('created_at', { ascending: false })
    .limit(100);

  if (emails && emails.length > 0) {
    sections.push('## EMAILS (most recent 100 threads)\n');
    for (const e of emails) {
      const meta = e.metadata as Record<string, unknown> ?? {};
      const participants = (meta.participants as string[])?.join(', ') ?? '';
      const date = (meta.last_date as string) ?? '';
      sections.push(`Subject: ${e.title}\nParticipants: ${participants}\nDate: ${date}\n${e.summary_text ?? ''}\n---`);
    }
  }

  const { data: calendar } = await supabase
    .from('search_documents')
    .select('title, summary_text, metadata')
    .eq('handle', handle)
    .eq('source_type', 'calendar_summary')
    .order('created_at', { ascending: false })
    .limit(80);

  if (calendar && calendar.length > 0) {
    sections.push('\n## CALENDAR EVENTS (most recent 80)\n');
    for (const c of calendar) {
      const meta = c.metadata as Record<string, unknown> ?? {};
      sections.push(`Event: ${c.title}\nWhen: ${meta.start ?? ''} to ${meta.end ?? ''}\nAttendees: ${meta.attendees ?? ''}\nLocation: ${meta.location ?? ''}\n${c.summary_text ?? ''}\n---`);
    }
  }

  const { data: meetings } = await supabase
    .from('search_documents')
    .select('title, summary_text, metadata')
    .eq('handle', handle)
    .eq('source_type', 'meeting_summary')
    .order('created_at', { ascending: false })
    .limit(30);

  if (meetings && meetings.length > 0) {
    sections.push('\n## MEETING NOTES (most recent 30)\n');
    for (const m of meetings) {
      const meta = m.metadata as Record<string, unknown> ?? {};
      sections.push(`Meeting: ${m.title}\nDate: ${meta.meeting_date ?? ''}\nAttendees: ${meta.attendees ?? ''}\n${m.summary_text ?? ''}\n---`);
    }
  }

  const { data: memories } = await supabase
    .from('memory_items')
    .select('category, value_text, memory_type')
    .eq('handle', handle)
    .eq('is_active', true)
    .limit(50);

  if (memories && memories.length > 0) {
    sections.push('\n## STORED MEMORIES\n');
    for (const m of memories) {
      sections.push(`[${m.memory_type}/${m.category}] ${m.value_text}`);
    }
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('name, facts, pdl_profile')
    .eq('handle', handle)
    .maybeSingle();

  if (profile) {
    sections.push('\n## EXISTING PROFILE DATA\n');
    if (profile.name) sections.push(`Name: ${profile.name}`);
    if (profile.facts && Array.isArray(profile.facts)) {
      sections.push(`Facts: ${(profile.facts as string[]).join('; ')}`);
    }
    if (profile.pdl_profile) {
      const pdl = profile.pdl_profile as Record<string, unknown>;
      const pdlFields = ['jobTitle', 'jobCompanyName', 'jobCompanyIndustry', 'locationName', 'skills', 'interests'];
      for (const f of pdlFields) {
        if (pdl[f]) sections.push(`PDL ${f}: ${JSON.stringify(pdl[f])}`);
      }
    }
  }

  return sections.join('\n');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
    });
  }

  if (req.method !== 'POST') {
    return jsonResp({ error: 'method_not_allowed' }, 405);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token || !isServiceRoleToken(token)) {
    return jsonResp({ error: 'unauthorized' }, 401);
  }

  try {
    const body = await req.json();
    const handle: string = body.handle;
    const authUserId: string | undefined = body.auth_user_id;

    if (!handle) {
      return jsonResp({ error: 'missing handle' }, 400);
    }

    const supabase = getAdminClient();
    const start = Date.now();

    console.log(`[build-profile] Starting profile synthesis for ${handle}`);

    const rawData = await gatherRawData(supabase, handle);
    const gatherMs = Date.now() - start;

    if (rawData.length < 200) {
      console.log(`[build-profile] Insufficient data for ${handle} (${rawData.length} chars, ${gatherMs}ms) — skipping`);
      return jsonResp({ status: 'skipped', reason: 'insufficient_data', data_length: rawData.length }, 200);
    }

    console.log(`[build-profile] Gathered ${rawData.length} chars of raw data in ${gatherMs}ms — synthesising...`);

    const truncatedData = rawData.slice(0, 60_000);

    const synthesisStart = Date.now();
    const profileText = await fastLlmText(
      PROFILE_SYNTHESIS_PROMPT,
      `Here is all the data for this person:\n\n${truncatedData}`,
      4096,
    );
    const synthesisMs = Date.now() - synthesisStart;

    let profileJson: Record<string, unknown>;
    try {
      const cleaned = profileText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      profileJson = JSON.parse(cleaned);
    } catch {
      console.error(`[build-profile] Failed to parse LLM output as JSON for ${handle}`);
      console.error(`[build-profile] Raw output (first 500): ${profileText.substring(0, 500)}`);
      return jsonResp({ status: 'error', reason: 'json_parse_failed' }, 500);
    }

    const { error: updateErr } = await supabase
      .from('user_profiles')
      .update({
        deep_profile_snapshot: profileJson,
        deep_profile_built_at: new Date().toISOString(),
      })
      .eq('handle', handle);

    if (updateErr) {
      console.error(`[build-profile] DB update failed for ${handle}:`, updateErr.message);
      return jsonResp({ status: 'error', reason: 'db_update_failed', detail: updateErr.message }, 500);
    }

    const totalMs = Date.now() - start;
    console.log(
      `[build-profile] Profile built for ${handle} in ${totalMs}ms ` +
      `(gather: ${gatherMs}ms, synthesis: ${synthesisMs}ms, ` +
      `data: ${rawData.length} chars)`
    );

    return jsonResp({
      status: 'completed',
      handle,
      timing: { total_ms: totalMs, gather_ms: gatherMs, synthesis_ms: synthesisMs },
      data_chars: rawData.length,
      sections: Object.keys(profileJson),
    }, 200);
  } catch (e) {
    console.error('[build-profile] Error:', (e as Error).message);
    return jsonResp({ error: 'internal', detail: (e as Error).message }, 500);
  }
});

function isServiceRoleToken(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1]));
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

function jsonResp(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

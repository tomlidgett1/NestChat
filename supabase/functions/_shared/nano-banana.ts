// Nano Banana Pro 2 — native Gemini image generation & editing
// Model: gemini-3-pro-image-preview (via Gemini REST API)
// Docs: https://ai.google.dev/gemini-api/docs/image-generation

import { getGeminiApiKey } from './ai/gemini.ts';
import { logApiCost } from './cost-tracker.ts';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const NANO_BANANA_MODEL = 'gemini-3-pro-image-preview';
const TIMEOUT_MS = 60_000;

// ─── Upload base64 image to Supabase Storage → public URL ───────────────────

async function uploadBase64ToStorage(
  base64Data: string,
  mimeType: string,
): Promise<string> {
  const { getAdminClient } = await import('./supabase.ts');
  const supabase = getAdminClient();
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const filename = `nano-banana/${crypto.randomUUID()}.${ext}`;

  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const { error } = await supabase.storage
    .from('generated-images')
    .upload(filename, bytes, {
      contentType: mimeType,
      cacheControl: '31536000',
      upsert: false,
    });

  if (error) {
    console.error('[nano-banana] Storage upload failed:', error.message);
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  const { data: urlData } = supabase.storage
    .from('generated-images')
    .getPublicUrl(filename);

  return urlData.publicUrl;
}

// ─── Fetch an image URL → base64 inline_data for Gemini ─────────────────────

async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const data = btoa(binary);
  const mimeType = resp.headers.get('content-type') || 'image/jpeg';
  return { data, mimeType };
}

// ─── Core Gemini image generation call ──────────────────────────────────────

interface GeminiImageResult {
  imageUrl: string;
  inputTokens: number;
  outputTokens: number;
}

async function callGeminiImage(
  parts: Array<Record<string, unknown>>,
): Promise<GeminiImageResult> {
  const apiKey = getGeminiApiKey();
  const url = `${GEMINI_API_BASE}/models/${NANO_BANANA_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Gemini image API ${resp.status}: ${errBody.substring(0, 300)}`);
    }

    // deno-lint-ignore no-explicit-any
    const data: any = await resp.json();
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts) {
      throw new Error('Gemini returned no image candidates');
    }

    // Find the image part in the response
    // deno-lint-ignore no-explicit-any
    const imagePart = candidate.content.parts.find((p: any) => p.inlineData);
    if (!imagePart?.inlineData?.data) {
      throw new Error('Gemini response contained no image data');
    }

    const mimeType = imagePart.inlineData.mimeType || 'image/png';
    const imageUrl = await uploadBase64ToStorage(imagePart.inlineData.data, mimeType);

    const usage = data.usageMetadata ?? {};
    return {
      imageUrl,
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Image editing (image-to-image) ─────────────────────────────────────────

export async function editImage(
  prompt: string,
  imageUrls: string[],
): Promise<string | null> {
  const t0 = Date.now();

  try {
    // Build parts: user images + text prompt
    const parts: Array<Record<string, unknown>> = [];

    for (const imgUrl of imageUrls) {
      const { data, mimeType } = await fetchImageAsBase64(imgUrl);
      parts.push({
        inlineData: { mimeType, data },
      });
    }

    parts.push({ text: prompt });

    const result = await callGeminiImage(parts);

    // Log cost (fire-and-forget)
    import('./supabase.ts').then(({ getAdminClient }) => {
      logApiCost(getAdminClient(), {
        userId: null,
        provider: 'gemini',
        model: NANO_BANANA_MODEL,
        endpoint: 'image_gen',
        description: 'Nano Banana Pro 2 image edit',
        messageType: 'image',
        tokensIn: result.inputTokens,
        tokensOut: result.outputTokens,
        latencyMs: Date.now() - t0,
        metadata: { prompt: prompt.substring(0, 500), image_count: imageUrls.length },
      });
    }).catch(() => {});

    return result.imageUrl;
  } catch (error) {
    console.error('[nano-banana] edit error:', error);

    import('./supabase.ts').then(({ getAdminClient }) => {
      logApiCost(getAdminClient(), {
        userId: null,
        provider: 'gemini',
        model: NANO_BANANA_MODEL,
        endpoint: 'image_gen',
        description: 'Nano Banana Pro 2 image edit (failed)',
        messageType: 'image',
        tokensIn: 0,
        tokensOut: 0,
        costUsdOverride: 0,
        latencyMs: Date.now() - t0,
        status: 'error',
        errorMessage: (error as Error).message,
      });
    }).catch(() => {});

    return null;
  }
}

// ─── Text-to-image generation ───────────────────────────────────────────────

export async function generateImageNanoBanana(
  prompt: string,
): Promise<string | null> {
  const t0 = Date.now();

  try {
    const parts = [{ text: prompt }];
    const result = await callGeminiImage(parts);

    import('./supabase.ts').then(({ getAdminClient }) => {
      logApiCost(getAdminClient(), {
        userId: null,
        provider: 'gemini',
        model: NANO_BANANA_MODEL,
        endpoint: 'image_gen',
        description: 'Nano Banana Pro 2 text-to-image',
        messageType: 'image',
        tokensIn: result.inputTokens,
        tokensOut: result.outputTokens,
        latencyMs: Date.now() - t0,
        metadata: { prompt: prompt.substring(0, 500) },
      });
    }).catch(() => {});

    return result.imageUrl;
  } catch (error) {
    console.error('[nano-banana] generate error:', error);

    import('./supabase.ts').then(({ getAdminClient }) => {
      logApiCost(getAdminClient(), {
        userId: null,
        provider: 'gemini',
        model: NANO_BANANA_MODEL,
        endpoint: 'image_gen',
        description: 'Nano Banana Pro 2 text-to-image (failed)',
        messageType: 'image',
        tokensIn: 0,
        tokensOut: 0,
        costUsdOverride: 0,
        latencyMs: Date.now() - t0,
        status: 'error',
        errorMessage: (error as Error).message,
      });
    }).catch(() => {});

    return null;
  }
}

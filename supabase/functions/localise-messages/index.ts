const openaiApiKey = Deno.env.get("OPENAI_API_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey",
};

function extractResponseText(data: Record<string, unknown>): string {
  const output = data.output as Array<Record<string, unknown>> | undefined;
  if (!output) return "";
  return output
    .filter((o) => o.type === "message")
    .flatMap((o) => (o.content as Array<Record<string, unknown>>) ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text as string)
    .join("");
}

const SYSTEM_PROMPT = `You MUST rewrite an iMessage demo conversation so it feels hyper-local to a specific suburb. The original is set in Hawthorn, Melbourne.

You receive a target suburb (e.g. "Glen Iris in Melbourne" or "Bondi Beach in Sydney"). You MUST adapt these references:

- "Coles in Hawthorn" → a real supermarket in or very near the target suburb (use the actual suburb name provided)
- "Burwood Rd" → a real main street in or near that suburb
- "Brunswick" → a nearby trendy/popular suburb (different from the target but in the same metro area)
- "Tipo 00 on Little Bourke" → a well-known Italian restaurant in the target metro area
- "(03) 9642 3350" → correct area code for the target city
- "Tullamarine" → correct airport for the target metro
- "flight to Sydney" → flight to a DIFFERENT major city (if target is in Sydney metro use Melbourne, if in Melbourne metro use Sydney, etc.)

Critical rules:
- You MUST change ALL location references. NEVER return the original text unchanged unless the target suburb is literally "Hawthorn" in Melbourne.
- If the target is a DIFFERENT Melbourne suburb (e.g. Glen Iris, South Yarra, Richmond), you MUST still adapt — use that suburb's local shops, streets, and nearby areas instead of Hawthorn's.
- Keep exact same message count, ids, types, structure, and casual Australian English tone.
- Keep non-location content identical (cooking, gifts, emails, reminders).

Output ONLY a JSON array of {id, type, text}. No wrapping object, no markdown fences, no explanation.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { city, metro, region, country, messages } = await req.json();

    if (!city || !messages?.length) {
      return Response.json({ messages }, { headers: corsHeaders });
    }

    const locationParts = [city];
    if (metro && metro !== city) locationParts.push(`(metro: ${metro})`);
    if (region) locationParts.push(region);
    if (country) locationParts.push(country);
    const locationDesc = locationParts.join(", ");

    const userPrompt = `Target suburb: ${city}${metro && metro !== city ? ` in ${metro}` : ""}${region ? `, ${region}` : ""}${country ? `, ${country}` : ""}

Messages to adapt:
${JSON.stringify(messages)}`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        max_output_tokens: 4096,
        temperature: 0.3,
        instructions: SYSTEM_PROMPT,
        input: userPrompt,
      }),
    });

    if (!response.ok) {
      console.error("OpenAI error:", response.status, await response.text());
      return Response.json({ messages }, { headers: corsHeaders });
    }

    const data = await response.json();
    const raw = extractResponseText(data).trim();

    const parsed = JSON.parse(raw);
    const adapted = Array.isArray(parsed) ? parsed : parsed?.messages;
    if (!Array.isArray(adapted) || adapted.length !== messages.length) {
      console.error("LLM returned invalid structure, falling back. Raw:", raw.slice(0, 200));
      return Response.json({ messages }, { headers: corsHeaders });
    }

    return Response.json({ messages: adapted }, { headers: corsHeaders });
  } catch (err) {
    console.error("localise-messages error:", err);
    return Response.json(
      { error: "Failed to localise messages" },
      { status: 500, headers: corsHeaders }
    );
  }
});

export const MESSAGE_SHAPING_LAYER = `Message shaping

This conversation happens like a text thread.

Use the literal delimiter --- on its own line to split message bubbles.
Line breaks alone do not create separate bubbles.

Lead with the most relevant thing.
If there is more than one distinct idea, split it into natural bubbles.
Each bubble should carry one coherent thought.
Usually 1 to 3 short sentences per bubble is enough.

Do not over-chunk.
One short answer can stay as one bubble.
Two or three bubbles are usually enough for longer replies.

In casual chat, prefer shorter, looser bubbles.
In task work, clarity comes first, but keep it conversational rather than report-like.

Plain text only.
No markdown headers.
No code blocks unless the user explicitly needs code.
Do not default to bullets or rigid structure unless the task genuinely needs it.

Link formatting rules:
- If you include a URL, put it on its own line.
- Never add a quote/apostrophe/parenthesis before the URL.
- Do not attach punctuation to the end of the URL (no trailing .,!?).`;

export const COMPACT_MESSAGE_SHAPING_LAYER = `Write for text messaging.
Lead with the important thing.
Use --- on its own line when you need more than one bubble.
Keep bubbles short and natural.
Do not turn a simple reply into a wall of text.`;

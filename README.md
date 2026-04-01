# Nest Sendblue Agent

![Demo Screenshot](demo.png)

A Claude-powered messaging bot built on Sendblue. It uses a fast webhook pattern: acknowledge the webhook immediately, then process the message in-process so inbound delivery stays quick.

## Features

- Claude AI replies over text
- Web search for current information
- Image generation with DALL-E 3
- Image analysis from inbound photos
- Reactions, including a custom emoji path
- Expressive iMessage effects via Sendblue `send_style`
- Voice memo transcription with Whisper
- Conversation memory and persistent user facts stored in Supabase
- Group chat awareness with lightweight respond/react/ignore filtering
- Multi-message replies for more natural texting
- Best-effort read receipts and typing indicators on supported conversations

## Quick Start

1. Copy `.env.example` to `.env` and fill in your keys.
2. Run the SQL in `supabase/schema.sql` in your Supabase SQL editor so the required tables and policies exist.
3. Install dependencies:

```bash
npm install
```

4. Start the app:

```bash
npm run dev
```

5. Expose it locally:

```bash
ngrok http 3000
```

6. Configure the ngrok URL as your Sendblue `receive` webhook, then text your Sendblue line.

## Configuration

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key from Anthropic |
| `OPENAI_API_KEY` | OpenAI API key for Whisper and DALL-E |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Optional Supabase publishable key |
| `SUPABASE_SECRET_KEY` | Supabase server secret key for backend/admin access |
| `NEW_SUPABASE_SECRET_KEY` | Same value as `SUPABASE_SECRET_KEY` when Supabase Edge secrets require the reserved-name workaround |
| `SUPABASE_CONVERSATIONS_TABLE` | Conversations table name, defaults to `conversations` |
| `SUPABASE_USER_PROFILES_TABLE` | User profiles table name, defaults to `user_profiles` |
| `SENDBLUE_API_KEY` | Sendblue API key ID |
| `SENDBLUE_API_SECRET` | Sendblue API secret |
| `SENDBLUE_API_BASE_URL` | Sendblue API base URL, defaults to `https://api.sendblue.co` |
| `SENDBLUE_BOT_NUMBERS` | Sendblue phone numbers this bot should answer from |
| `SENDBLUE_WEBHOOK_SECRET` | Optional webhook secret to validate incoming Sendblue requests |
| `SENDBLUE_WEBHOOK_SECRET_HEADER` | Optional webhook secret header name, defaults to `x-sendblue-secret` |
| `PORT` | Server port, defaults to `3000` |
| `IGNORED_SENDERS` | Sender numbers to skip |
| `ALLOWED_SENDERS` | If set, only these senders receive replies |
| `NODE_ENV` | Set to `production` to reduce debug logging |

## Commands

- `/clear` resets the current conversation
- `/forget me` erases saved user profile data
- `/help` shows the available commands

## Sendblue Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `POST /api/send-message` | Send a 1:1 message |
| `POST /api/send-group-message` | Send a group message |
| `POST /api/send-reaction` | Add a reaction to an inbound message |
| `POST /api/mark-read` | Mark a 1:1 iMessage conversation as read |
| `POST /api/send-typing-indicator` | Show typing in supported 1:1 iMessage chats |

## Webhook Shape Used

This app handles Sendblue `receive` webhooks. It derives:

- a stable message ID from `message_handle`
- a stable conversation key from `group_id` or `from_number` plus bot line
- group context from `group_id`, `participants`, and `group_display_name`
- media context from `media_url`

## Architecture

```text
[User] --message--> [Sendblue] --webhook--> [This App] --API--> [Claude]
                                              |                  |
                                              |    <-- tools <---|
                                              |    (reactions,   |
                                              |     web search,  |
                                              |     images)      |
                                              |                  v
                                              |              [OpenAI]
                                              |        (DALL-E, Whisper)
                                              v
[User] <--message-- [Sendblue] <--API----- [Reply + Media + Reactions]
```

### Flow

1. User sends a message to a Sendblue line.
2. Sendblue calls `POST /webhook`.
3. The app returns `200` immediately.
4. The webhook handler normalises the payload, dedupes by `message_handle`, and filters senders.
5. The app starts best-effort read/typing actions where supported.
6. Claude receives text, media, memory, and group context.
7. Claude may respond with text, reactions, effects, image generation, or web search.
8. The app sends the response back through Sendblue.

## File Structure

```text
src/
├── index.ts              # Express app and main orchestration
├── claude/
│   └── client.ts         # Claude integration, prompts, and tool parsing
├── sendblue/
│   └── client.ts         # Sendblue API adapter
├── webhook/
│   ├── handler.ts        # Fast webhook handling, filtering, dedupe
│   └── types.ts          # Sendblue webhook normalisation
└── state/
    └── conversation.ts   # Supabase storage for history and user profiles
```

## Notes

- Group messaging support in Sendblue is beta and plan-gated.
- Read receipts and typing indicators are best-effort and primarily iMessage-specific.
- Custom emoji reactions are implemented as a direct Sendblue reaction payload assumption and should be validated against your account behaviour.
- The included `supabase/schema.sql` uses permissive policies for local iteration. For production, prefer tighter RLS plus the server secret key for backend/admin access.

## Models Used

- Main replies: Claude Sonnet 4
- Group filtering: Claude Haiku 3.5

## Documentation

- Sendblue docs: https://docs.sendblue.com/api-v2

## License

MIT

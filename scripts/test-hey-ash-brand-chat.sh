#!/usr/bin/env bash
# Call deployed Supabase edge function `brand-chat` as Ashburton Cycles (`ash`).
# Uses the same path as production iMessage brand mode (handleBrandChat).
#
# Env (from Nest/.env or export manually):
#   SUPABASE_URL          e.g. https://xxx.supabase.co
#   SUPABASE_PUBLISHABLE_KEY  (Bearer for functions)
#
# Optional:
#   BRAND_CHAT_URL        override full URL (default: $SUPABASE_URL/functions/v1/brand-chat)
#
# Deputy roster/timesheet data is fetched for any sender when the message matches workforce wording.
# Optional: nest_brand_chat_config.internal_admin_phone_e164s (portal) is not used to gate access.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

URL="${BRAND_CHAT_URL:-${SUPABASE_URL%/}/functions/v1/brand-chat}"
KEY="${SUPABASE_PUBLISHABLE_KEY:-}"

if [[ -z "${SUPABASE_URL:-}" || -z "$KEY" ]]; then
  echo "Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY in environment or Nest/.env"
  exit 1
fi

CHAT_BASE="TEST#hey-ash#${RANDOM:-$$}"
INTERNAL="${1:-+61414187820}"
EXTERNAL="${2:-+61400999888}"

call_brand_chat() {
  local chat_id="$1"
  local sender="$2"
  local message="$3"
  local payload
  payload=$(jq -nc \
    --arg cid "$chat_id" \
    --arg sh "$sender" \
    --arg bk "ash" \
    --arg msg "$message" \
    '{chatId:$cid, senderHandle:$sh, brandKey:$bk, message:$msg}')
  curl -sS "$URL" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -H "apikey: $KEY" \
    -d "$payload"
}

print_reply() {
  local label="$1"
  local json="$2"
  if echo "$json" | jq -e .ok >/dev/null 2>&1; then
    echo "$label"
    echo "$json" | jq -r '.text' | head -c 1200
    echo ""
    echo "---"
  else
    echo "$label [error]"
    echo "$json" | jq . 2>/dev/null || echo "$json"
    echo "---"
  fi
}

echo "Endpoint: $URL"
echo "Chat thread: $CHAT_BASE (internal sender $INTERNAL)"
echo ""

# Same chatId = one session thread (like one iMessage thread after Hey Ash)
JSON1=$(call_brand_chat "$CHAT_BASE" "$INTERNAL" "Who is working tomorrow?")
print_reply "Q1 (internal): Who is working tomorrow?" "$JSON1"

JSON2=$(call_brand_chat "$CHAT_BASE" "$INTERNAL" "Who worked last week?")
print_reply "Q2 (internal): Who worked last week?" "$JSON2"

JSON3=$(call_brand_chat "$CHAT_BASE" "$INTERNAL" "How many hours were logged last week?")
print_reply "Q3 (internal): How many hours were logged last week?" "$JSON3"

EXT_CHAT="TEST#hey-ash-cust#${RANDOM:-$$}"
JSON4=$(call_brand_chat "$EXT_CHAT" "$EXTERNAL" "Who is working tomorrow?")
print_reply "Q4 (customer $EXTERNAL): Who is working tomorrow?" "$JSON4"

echo "Done."

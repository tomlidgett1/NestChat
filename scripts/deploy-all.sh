#!/usr/bin/env bash
set -euo pipefail

PROJECT_REF="oypzijwqmkxktvgtsqkp"
FUNCTIONS_DIR="$(cd "$(dirname "$0")/../supabase/functions" && pwd)"

FUNCTIONS=()
for dir in "$FUNCTIONS_DIR"/*/; do
  name="$(basename "$dir")"
  [[ "$name" == _shared ]] && continue
  [[ -f "$dir/index.ts" ]] || continue
  FUNCTIONS+=("$name")
done

if [[ ${#FUNCTIONS[@]} -eq 0 ]]; then
  echo "No functions found to deploy."
  exit 0
fi

echo "Deploying ${#FUNCTIONS[@]} functions to project $PROJECT_REF:"
printf "  • %s\n" "${FUNCTIONS[@]}"
echo ""

FAILED=()
for fn in "${FUNCTIONS[@]}"; do
  echo "→ Deploying $fn..."
  if supabase functions deploy "$fn" --project-ref "$PROJECT_REF" 2>&1 | tail -1; then
    echo "  ✓ $fn deployed"
  else
    echo "  ✗ $fn FAILED"
    FAILED+=("$fn")
  fi
  echo ""
done

echo "================================"
echo "Deployed: $(( ${#FUNCTIONS[@]} - ${#FAILED[@]} ))/${#FUNCTIONS[@]}"
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "Failed:"
  printf "  • %s\n" "${FAILED[@]}"
  exit 1
fi
echo "All functions deployed successfully."

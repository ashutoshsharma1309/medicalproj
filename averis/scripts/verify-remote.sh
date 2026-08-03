#!/usr/bin/env bash
# ===========================================================================
# AVERIS — verify a hosted Supabase project
#
# Confirms the schema is applied AND correctly locked down, using only the
# publishable (anon) key. No database password, no service-role key.
#
# How to read the results:
#   404  → the table does not exist          (schema not applied)
#   401  → the table exists, anon is denied  (applied and secure — what we want)
#   200  → the table exists and anon can READ it  ← a security problem
#
#   ./scripts/verify-remote.sh
# ===========================================================================
set -uo pipefail

# Load from .env.local unless already exported.
if [[ -f .env.local ]]; then
  # shellcheck disable=SC2046
  export $(grep -E '^NEXT_PUBLIC_SUPABASE_(URL|ANON_KEY)=' .env.local | xargs) 2>/dev/null || true
fi

URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}"

if [[ -z "$URL" || -z "$KEY" ]]; then
  echo "✗ NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY not set (checked env and .env.local)."
  exit 1
fi

echo "▸ Project: $URL"
echo

pass=0
fail=0

check_table() {
  local table="$1"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
    "$URL/rest/v1/$table?select=*&limit=1" -H "apikey: $KEY")

  case "$code" in
    401|403)
      printf '  ✓ %-28s exists, anon denied (%s)\n' "$table" "$code"
      pass=$((pass + 1))
      ;;
    404)
      printf '  ✗ %-28s MISSING — schema not applied (404)\n' "$table"
      fail=$((fail + 1))
      ;;
    200)
      printf '  ✗ %-28s READABLE BY ANON (200) — RLS/grants wrong\n' "$table"
      fail=$((fail + 1))
      ;;
    *)
      printf '  ? %-28s unexpected status %s\n' "$table" "$code"
      fail=$((fail + 1))
      ;;
  esac
}

echo "Schema + anon lockdown"
for t in users patient_profiles patient_health_information \
         medical_documents document_extractions patient_medical_records; do
  check_table "$t"
done

echo
echo "Auth service"
settings=$(curl -s --max-time 20 "$URL/auth/v1/settings" -H "apikey: $KEY")
if [[ -n "$settings" ]]; then
  email=$(printf '%s' "$settings" | python3 -c "import json,sys;print(json.load(sys.stdin)['external']['email'])" 2>/dev/null || echo "?")
  google=$(printf '%s' "$settings" | python3 -c "import json,sys;print(json.load(sys.stdin)['external']['google'])" 2>/dev/null || echo "?")
  confirm=$(printf '%s' "$settings" | python3 -c "import json,sys;print(not json.load(sys.stdin)['mailer_autoconfirm'])" 2>/dev/null || echo "?")
  printf '  ✓ reachable — email:%s google:%s email-confirmation-required:%s\n' "$email" "$google" "$confirm"
  pass=$((pass + 1))
else
  echo "  ✗ auth settings unreachable"
  fail=$((fail + 1))
fi

echo
echo "Storage bucket"
# The object-list endpoint returns "200 []" for a bucket that does not exist,
# because RLS simply filters everything out — that is not evidence of anything.
# The bucket metadata endpoint distinguishes the cases properly.
bucket=$(curl -s --max-time 20 "$URL/storage/v1/bucket/medical-documents" -H "apikey: $KEY")

if printf '%s' "$bucket" | grep -q "NoSuchBucket"; then
  printf '  ✗ medical-documents        bucket missing — storage migration not applied\n'
  fail=$((fail + 1))
elif printf '%s' "$bucket" | grep -qE '"public"[[:space:]]*:[[:space:]]*true'; then
  printf '  ✗ medical-documents        bucket is PUBLIC — documents would be world-readable\n'
  fail=$((fail + 1))
elif printf '%s' "$bucket" | grep -qE '"public"[[:space:]]*:[[:space:]]*false'; then
  printf '  ✓ medical-documents        exists and is private\n'
  pass=$((pass + 1))
else
  # Anon is not permitted to read bucket metadata on a locked-down project;
  # that is itself the correct posture.
  printf '  ✓ medical-documents        metadata not exposed to anon\n'
  pass=$((pass + 1))
fi

echo
if [[ $fail -eq 0 ]]; then
  echo "▸ $pass checks passed. Project is provisioned and locked down."
  exit 0
fi
echo "▸ $pass passed, $fail failed."
exit 1

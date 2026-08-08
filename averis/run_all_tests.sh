#!/usr/bin/env bash
# ===========================================================================
# AVERIS — every suite, one command
#
#   ./run_all_tests.sh              run everything available
#   ./run_all_tests.sh --no-db      skip the database suites
#   ./run_all_tests.sh --quiet      summary only
#
# Writes TEST_REPORT.md.
#
# ── The rule this script exists to enforce ─────────────────────────────────
#
# **A suite that could not run is reported as SKIPPED, never as passed.**
#
# That sounds obvious and is the single most common way a test runner lies.
# Three of the five suites here need something that may be absent — Python, a
# C++ compiler, a database — and a runner that silently omits them produces a
# green summary describing a fraction of the system. The report names what ran,
# what did not, and why, and the exit code distinguishes "all green" from "all
# green except the two that never started".
#
# ── Exit codes ─────────────────────────────────────────────────────────────
#   0  every suite that ran passed, and every suite ran
#   1  a suite failed
#   2  every suite that ran passed, but at least one was skipped
# ===========================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

REPORT="$ROOT/TEST_REPORT.md"
RUN_DB=1
QUIET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-db)   RUN_DB=0 ;;
    --quiet)   QUIET=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

started_at="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

failures=0
skips=0

# name | status | detail
results=()

say() { [[ $QUIET -eq 1 ]] || printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
line() { [[ $QUIET -eq 1 ]] || printf '  %s\n' "$*"; }

# run <name> <log-file> <command...>
run() {
  local name="$1" logfile="$2"; shift 2
  say "$name"

  if "$@" >"$logfile" 2>&1; then
    local detail
    detail="$(summarise "$name" "$logfile")"
    results+=("$name|PASS|$detail")
    line "✓ $detail"
    return 0
  fi

  results+=("$name|FAIL|see TEST_REPORT.md")
  failures=$((failures + 1))
  line "✗ failed"
  [[ $QUIET -eq 1 ]] || tail -20 "$logfile" | sed 's/^/    /'
  return 1
}

skip() {
  local name="$1" why="$2"
  results+=("$name|SKIP|$why")
  skips=$((skips + 1))
  say "$name"
  line "– skipped: $why"
}

# Pulls the count out of each runner's own output rather than counting lines.
summarise() {
  local name="$1" logfile="$2"
  case "$name" in
    "TypeScript unit tests")
      printf '%s tests, %s pass' \
        "$(grep -m1 '^# tests' "$logfile" | tr -dc '0-9')" \
        "$(grep -m1 '^# pass' "$logfile" | tr -dc '0-9')" ;;
    "Python tests")
      grep -Eo '[0-9]+ passed' "$logfile" | tail -1 ;;
    "Firmware logic tests")
      printf '%s checks, %s pass' \
        "$(grep -m1 '^# checks' "$logfile" | tr -dc '0-9')" \
        "$(grep -m1 '^# pass' "$logfile" | tr -dc '0-9')" ;;
    "Database — RLS and schema")
      printf '%s assertions' "$(grep -c 'PASS ' "$logfile" | tr -dc '0-9')" ;;
    *) echo "ok" ;;
  esac
}

# ---------------------------------------------------------------- TypeScript
if command -v npx >/dev/null 2>&1 && [[ -d node_modules ]]; then
  run "TypeScript type check" "$tmp/tsc.log" npx tsc --noEmit -p tsconfig.json
  run "TypeScript unit tests" "$tmp/node.log" npm test --silent
else
  skip "TypeScript type check" "node_modules missing — run: npm install"
  skip "TypeScript unit tests" "node_modules missing — run: npm install"
fi

# -------------------------------------------------------------------- Python
PYTHON=""
for candidate in "$ROOT/iot-service/.venv/bin/python" python3 python; do
  if [[ -x "$candidate" ]] || command -v "$candidate" >/dev/null 2>&1; then
    # The suites import httpx and pytest; a bare python3 without them is not a
    # usable runner, and reporting it as one would be the lie this script is
    # written to avoid.
    if "$candidate" -c "import pytest, httpx" >/dev/null 2>&1; then
      PYTHON="$candidate"
      break
    fi
  fi
done

if [[ -n "$PYTHON" ]]; then
  run "Python tests" "$tmp/pytest.log" "$PYTHON" -m pytest iot-service/tests ai_engine/tests -q
else
  skip "Python tests" "no interpreter with pytest+httpx — run: pip install -r iot-service/requirements-dev.txt"
fi

# ------------------------------------------------------------------ firmware
if command -v clang++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1; then
  run "Firmware logic tests" "$tmp/firmware.log" ./firmware/averis-wearable/test/run.sh
else
  skip "Firmware logic tests" "no C++ compiler on PATH"
fi

# ------------------------------------------------------------------ database
if [[ $RUN_DB -eq 0 ]]; then
  skip "Database — RLS and schema" "--no-db"
elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'supabase_db'; then
  container="$(docker ps --format '{{.Names}}' | grep 'supabase_db' | head -1)"
  run "Database — RLS and schema" "$tmp/rls.log" \
    env PG_MODE=docker PG_CONTAINER="$container" PG_USER=postgres ./supabase/tests/run.sh
elif command -v psql >/dev/null 2>&1 && PGCONNECT_TIMEOUT=3 psql -l >/dev/null 2>&1; then
  run "Database — RLS and schema" "$tmp/rls.log" env PG_MODE=psql ./supabase/tests/run.sh
else
  skip "Database — RLS and schema" "no Postgres reachable — run: ./scripts/setup_database.sh"
fi

# -------------------------------------------------------------------- report
{
  echo "# AVERIS — test report"
  echo
  echo "Generated \`$started_at\` by \`./run_all_tests.sh\`."
  echo
  echo "> A suite that could not run is reported as **SKIPPED**, never as passed."
  echo "> A green summary that silently omits the suites which never started is"
  echo "> the most common way a test runner misleads, and three of the five here"
  echo "> depend on something that may be absent."
  echo
  echo "| Suite | Result | Detail |"
  echo "|---|---|---|"
  for row in "${results[@]}"; do
    IFS='|' read -r name status detail <<<"$row"
    case "$status" in
      PASS) badge="✅ pass" ;;
      FAIL) badge="❌ **fail**" ;;
      *)    badge="⏭️ skipped" ;;
    esac
    echo "| $name | $badge | $detail |"
  done
  echo

  total=${#results[@]}
  passed=$((total - failures - skips))
  echo "**$passed of $total suites passed.** $failures failed, $skips skipped."
  echo

  if [[ $skips -gt 0 ]]; then
    echo "## What was not verified"
    echo
    for row in "${results[@]}"; do
      IFS='|' read -r name status detail <<<"$row"
      [[ "$status" == "SKIP" ]] && echo "- **$name** — $detail"
    done
    echo
    echo "These are gaps in this run, not in the project. Nothing below should be"
    echo "read as evidence that the corresponding code works."
    echo
  fi

  echo "## What each suite covers"
  echo
  echo "| Suite | Covers | Does not cover |"
  echo "|---|---|---|"
  echo "| TypeScript type check | Every type boundary in the app and \`lib/\` | Runtime behaviour |"
  echo "| TypeScript unit tests | Pure logic: triage, escalation, reports, assistant, validation, ML scoring | Anything needing a database, a network or a model key |"
  echo "| Python tests | The ingest validator, alert rules, escalation, telemetry, the AI engine | HTTP routing, PostgREST calls |"
  echo "| Firmware logic tests | Filtering, fall detection, payload encoding, battery curve | I²C, WiFi, BLE — mocking a MAX30102 would test the mock |"
  echo "| Database | Schema structure and RLS behaviour, against the unmodified production migrations | Application-layer authorization |"
  echo
  echo "## Running the parts that were skipped"
  echo
  echo '```bash'
  echo "npm install                                   # TypeScript suites"
  echo "pip install -r iot-service/requirements-dev.txt   # Python suites"
  echo "./scripts/setup_database.sh                   # database suites"
  echo '```'
} >"$REPORT"

# ------------------------------------------------------------------ summary
printf '\n'
for row in "${results[@]}"; do
  IFS='|' read -r name status detail <<<"$row"
  case "$status" in
    PASS) printf '  \033[32m✓\033[0m %-28s %s\n' "$name" "$detail" ;;
    FAIL) printf '  \033[31m✗\033[0m %-28s %s\n' "$name" "$detail" ;;
    *)    printf '  \033[33m–\033[0m %-28s %s\n' "$name" "$detail" ;;
  esac
done

printf '\n  Report: %s\n' "${REPORT#"$ROOT/"}"

if [[ $failures -gt 0 ]]; then
  printf '  \033[31m%d suite(s) failed.\033[0m\n\n' "$failures"
  exit 1
fi

if [[ $skips -gt 0 ]]; then
  # Distinct from success on purpose. CI can require exit 0 and get "everything
  # ran and passed"; a developer sees 2 and knows which parts were not checked.
  printf '  \033[33mAll executed suites passed, but %d were skipped.\033[0m\n\n' "$skips"
  exit 2
fi

printf '  \033[32mAll suites passed.\033[0m\n\n'

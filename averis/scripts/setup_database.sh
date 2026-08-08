#!/usr/bin/env bash
# ===========================================================================
# AVERIS — database setup, one command
#
#   ./scripts/setup_database.sh                 # Supabase CLI (needs Docker)
#   ./scripts/setup_database.sh --psql          # a Postgres you already have
#   ./scripts/setup_database.sh --remote        # a hosted Supabase project
#   ./scripts/setup_database.sh --check         # validate, change nothing
#
# What it does, in order: apply every migration, apply the reference seeds,
# validate the schema, and — unless told not to — run the RLS suite.
#
# ── What it will not do ────────────────────────────────────────────────────
#
# **It does not insert patient data.** Not a single row of invented vitals, no
# demo patients, no sample charts. Two of the seeds it applies are reference
# data — lab ranges and model metrics — and neither describes a person.
#
# The reason is not squeamishness. AVERIS stores measured and generated data in
# one table and separates them with a provenance flag set at write time; a
# setup script that inserted rows directly would bypass that flag entirely and
# produce readings nothing downstream could classify. If you want data to look
# at, run the simulator against a device registered as a simulator — that path
# stamps every row.
#
# ── Exit codes ─────────────────────────────────────────────────────────────
#   0  everything applied and validated
#   1  a prerequisite is missing (Docker, psql, a connection string)
#   2  migrations or validation failed
# ===========================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="supabase"
RUN_RLS=1
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --psql)      MODE="psql" ;;
    --remote)    MODE="remote" ;;
    --check)     CHECK_ONLY=1 ;;
    --no-rls)    RUN_RLS=0 ;;
    -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
    *)           echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }

MIGRATIONS=("$ROOT"/supabase/migrations/*.sql)
if [[ ${#MIGRATIONS[@]} -eq 0 ]]; then
  bad "No migrations found under supabase/migrations."
  exit 2
fi

# ---------------------------------------------------------------------------
# Transport
#
# Every mode ends up calling `psql_run <file>`. Keeping the three paths behind
# one function is what stops "which migrations, in what order" existing in
# three places — the copy that drifts is always the one that stops catching the
# thing it was written for.
# ---------------------------------------------------------------------------
case "$MODE" in
  supabase)
    # The CLI is a devDependency, so a repo that has run `npm install` already
    # has it. Checking the local binary first means the common case needs no
    # global install at all.
    if [[ -x "$ROOT/node_modules/.bin/supabase" ]]; then
      supabase() { "$ROOT/node_modules/.bin/supabase" "$@"; }
    elif ! command -v supabase >/dev/null 2>&1; then
      bad "The Supabase CLI is not available."
      echo "     npm install          (it is a devDependency of this project)"
      echo "     Or run against a Postgres you already have: $0 --psql"
      exit 1
    fi
    if ! docker info >/dev/null 2>&1; then
      bad "Docker is not running — the Supabase CLI needs it for the local stack."
      echo "     Start Docker, or use: $0 --psql   /   $0 --remote"
      exit 1
    fi
    ;;

  psql)
    if ! command -v psql >/dev/null 2>&1; then
      bad "psql is not installed."
      echo "     macOS: brew install libpq && brew link --force libpq"
      echo "     Debian/Ubuntu: sudo apt-get install postgresql-client"
      exit 1
    fi
    : "${PGHOST:=localhost}"
    : "${PGPORT:=5432}"
    : "${PGUSER:=postgres}"
    : "${PGDATABASE:=averis}"
    export PGHOST PGPORT PGUSER PGDATABASE
    psql_run() { psql -v ON_ERROR_STOP=1 --quiet -f "$1"; }
    ;;

  remote)
    if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
      bad "SUPABASE_DB_URL is not set."
      echo "     Supabase dashboard → Project Settings → Database → Connection string (URI)."
      echo "     export SUPABASE_DB_URL='postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres'"
      exit 1
    fi
    if ! command -v psql >/dev/null 2>&1; then
      bad "psql is not installed — needed to apply migrations to a hosted project."
      exit 1
    fi
    psql_run() { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 --quiet -f "$1"; }
    ;;
esac

# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------
if [[ $CHECK_ONLY -eq 0 ]]; then
  if [[ "$MODE" == "supabase" ]]; then
    say "Starting the local Supabase stack"
    supabase start
    ok "stack up"

    # `db reset` drops, recreates and replays every migration in order, then
    # applies supabase/seed. Deliberately preferred over `db push`: a
    # setup script that leaves an old schema partly in place produces the
    # hardest class of bug to diagnose — one that reproduces on one machine.
    say "Applying migrations (${#MIGRATIONS[@]} files)"
    supabase db reset
    ok "migrations applied"

    # Everything below runs through the CLI's psql.
    psql_run() { supabase db query --file "$1" >/dev/null; }

  else
    say "Applying migrations (${#MIGRATIONS[@]} files)"
    for migration in "${MIGRATIONS[@]}"; do
      name="$(basename "$migration")"

      # The storage migration needs Supabase's `storage` schema, which a plain
      # Postgres does not have. Skipped rather than failed, and said out loud —
      # a silent skip is how someone discovers document upload is broken in an
      # environment they thought was complete.
      if [[ "$name" == *_phase2_document_storage.sql && "$MODE" == "psql" ]]; then
        printf '  – %s (skipped: needs Supabase Storage)\n' "$name"
        continue
      fi

      printf '  · %s\n' "$name"
      if ! psql_run "$migration"; then
        bad "$name failed. Nothing after it has been applied."
        exit 2
      fi
    done
    ok "migrations applied"

    say "Applying reference seeds"
    for seed in "$ROOT"/supabase/seed/*.sql; do
      [[ -f "$seed" ]] || continue
      printf '  · %s\n' "$(basename "$seed")"
      psql_run "$seed" || { bad "seed failed"; exit 2; }
    done
    # Neither of these describes a person: lab reference ranges and model
    # evaluation metrics.
    ok "reference data loaded (no patient data — by design)"
  fi
fi

# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------
say "Validating the schema"
if psql_run "$ROOT/supabase/tests/schema_validation.sql"; then
  ok "every public table has RLS, policies, and no anon grants"
else
  bad "schema validation failed — see the warnings above"
  exit 2
fi

if [[ $RUN_RLS -eq 1 && "$MODE" != "remote" ]]; then
  say "Running the RLS suite"
  # Behavioural assertions: one patient cannot read another's records, a doctor
  # sees only assigned patients, a revoked caregiver loses access immediately.
  # Skipped against a hosted project on purpose — it seeds fixture patients,
  # and a suite that writes test people into a real project is a suite that
  # eventually writes them into a production one.
  if [[ "$MODE" == "supabase" ]]; then
    PG_MODE=docker PG_CONTAINER="$(docker ps --filter 'name=supabase_db' --format '{{.Names}}' | head -1)" \
      PG_USER=postgres "$ROOT/supabase/tests/run.sh" || { bad "RLS assertions failed"; exit 2; }
  else
    PG_MODE=psql "$ROOT/supabase/tests/run.sh" || { bad "RLS assertions failed"; exit 2; }
  fi
  ok "RLS assertions passed"
elif [[ "$MODE" == "remote" ]]; then
  printf '\n  RLS suite skipped: it seeds fixture patients, which do not belong in a hosted project.\n'
  printf '  Verify a hosted project from outside instead:  ./scripts/verify-remote.sh\n'
fi

# ---------------------------------------------------------------------------
say "Done"
cat <<'NEXT'
  The schema is applied and validated. There is no patient data, deliberately.

  To see the system with data flowing:

    1. npm run dev
    2. Sign up, complete onboarding
    3. Devices → Register a device → tick "This is a simulator"
    4. python3 sensor_simulator/simulate.py \
         --token avd_... --device-key AVR001 --mode normal

  Every row the simulator writes is stamped as simulated, so it stays
  distinguishable from a measurement afterwards.
NEXT

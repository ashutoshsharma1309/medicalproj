#!/usr/bin/env bash
# ===========================================================================
# AVERIS — Row Level Security verification runner
#
# Applies the local auth stub, then the *unmodified* production migrations,
# then every phase's RLS assertions. Exits non-zero on the first failure, so
# it gates CI.
#
# Two transports, one sequence:
#
#   ./supabase/tests/run.sh                              # docker exec (default)
#   PG_CONTAINER=supabase_db_averis PG_USER=postgres ./supabase/tests/run.sh
#   PG_MODE=psql PGHOST=localhost PGUSER=averis ./supabase/tests/run.sh
#
# CI uses the psql transport against a service container. It calls this script
# rather than reimplementing the sequence, because two copies of "which
# migrations to apply, in what order, with which stubs" is exactly the kind of
# duplication that drifts — and the copy that drifts is the one that stops
# catching the policy regression it was written for.
#
# The storage migration is skipped: it needs Supabase's `storage` schema, which
# a plain Postgres does not have. It applies unchanged against a real project.
#
# pgvector is required from Phase 5 onward. Use pgvector/pgvector:pgNN or the
# Supabase Postgres image; a stock postgres image cannot apply the migration.
# ===========================================================================
set -euo pipefail

PG_MODE="${PG_MODE:-docker}"
PG_CONTAINER="${PG_CONTAINER:-meridian-pg}"
PG_USER="${PG_USER:-${PGUSER:-meridian}}"
TEST_DB="${TEST_DB:-averis_test}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ "$PG_MODE" = "psql" ]; then
  admin_sql() { psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 --quiet "$@"; }
  run_sql() { psql -U "$PG_USER" -d "$TEST_DB" -v ON_ERROR_STOP=1 -f "$1"; }
else
  admin_sql() { docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -q "$@"; }
  # Piped on stdin rather than copied in with `docker cp`. Two reasons, both
  # found the hard way: `docker cp` into a running container can block
  # indefinitely on some Docker Desktop versions, and it leaves the file behind
  # inside the container. Redirecting is faster and stateless.
  run_sql() {
    docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$TEST_DB" \
      -v ON_ERROR_STOP=1 -q < "$1"
  }
fi

echo "▸ Recreating $TEST_DB (transport: $PG_MODE)"
admin_sql -c "DROP DATABASE IF EXISTS $TEST_DB;" -c "CREATE DATABASE $TEST_DB;"

echo "▸ Applying local auth stub"
run_sql "$ROOT/supabase/tests/00_local_auth_stub.sql"

for migration in "$ROOT"/supabase/migrations/*.sql; do
  case "$migration" in
    *_phase2_document_storage.sql)
      echo "▸ Skipping $(basename "$migration") (requires Supabase Storage)"
      continue
      ;;
  esac
  echo "▸ Applying migration: $(basename "$migration")"
  run_sql "$migration"
done

# Structural checks first: every table has RLS, no policy grants to PUBLIC, no
# anon privileges. They run before the behavioural suites because a missing
# policy presents there as a confusing pass — a test asserting "patient B sees
# nothing" succeeds trivially when the whole table is unreadable.
echo "▸ Running schema_validation.sql"
run_sql "$ROOT/supabase/tests/schema_validation.sql"

# Ordered by filename so a new phase is picked up automatically. Phase 1's file
# predates the naming convention, so it is applied first by name.
# An explicit, ordered list — not a glob, and not a sort.
#
# These suites share one database and build on each other's fixtures: Phase 4b
# asserts on a care team Phase 4 created. That makes the order part of the
# contract, and encoding a contract in a filename sort is how it gets broken by
# accident.
#
# Two sorts were tried here and both were wrong. A plain glob puts `iot_phase11`
# before `iot_phase1`, because '1' sorts below '_'. `sort -V` fixes that and
# then puts `iot_phase4b` before `iot_phase4`. Each failure presented as an
# assertion failing deep inside an unrelated suite.
#
# The guard below makes the list self-maintaining: any *_verification.sql file
# in this directory that is not named here fails the run, so a new suite cannot
# be silently skipped by being forgotten.
suites=(
  "rls_verification.sql"
  "phase2_rls_verification.sql"
  "phase3_rls_verification.sql"
  "phase4_rls_verification.sql"
  "phase5_rls_verification.sql"
  "phase6_rls_verification.sql"
  "iot_phase1_rls_verification.sql"
  "iot_phase4_rls_verification.sql"
  "iot_phase4b_rls_verification.sql"
  "iot_phase5_rls_verification.sql"
  "iot_phase7_rls_verification.sql"
  "iot_phase9_rls_verification.sql"
  # Phase 11 last: it is a whole-system suite and adds a third patient, so it
  # must not perturb the per-feature suites that run before it.
  "iot_phase11_rls_verification.sql"
  "device_auth_verification.sql"
)

for name in "${suites[@]}"; do
  path="$ROOT/supabase/tests/$name"
  if [ ! -f "$path" ]; then
    echo "▸ ERROR: $name is listed in run.sh but does not exist." >&2
    exit 1
  fi
  echo "▸ Running $name"
  run_sql "$path"
done

# Every verification file must be in the list above.
#
# A file that is not runs never, while the summary reports success — the worst
# failure a test runner has, because it is indistinguishable from passing. This
# caught a Phase 11 suite sitting unexecuted in the directory.
missed=0
for candidate in "$ROOT"/supabase/tests/*_verification.sql; do
  base="$(basename "$candidate")"
  found=0
  for name in "${suites[@]}"; do
    [ "$name" = "$base" ] && found=1 && break
  done
  if [ "$found" -eq 0 ]; then
    echo "▸ ERROR: $base exists but is not listed in run.sh — it did NOT run." >&2
    missed=$((missed + 1))
  fi
done

if [ "$missed" -gt 0 ]; then
  echo "▸ $missed verification file(s) were skipped. Refusing to report success." >&2
  exit 1
fi

echo "▸ All checks passed."

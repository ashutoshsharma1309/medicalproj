#!/usr/bin/env bash
# ===========================================================================
# AVERIS — Row Level Security verification runner
#
# Applies the local auth stub, then the *unmodified* production migrations,
# then the RLS assertions for each phase. Exits non-zero on the first failed
# assertion, so it can gate CI.
#
#   ./supabase/tests/run.sh                        # uses a Docker Postgres
#   PG_CONTAINER=my-pg PG_USER=postgres ./run.sh   # override
#
# The storage migration is skipped: it needs Supabase's `storage` schema,
# which a plain Postgres instance does not have. It applies unchanged against
# any real Supabase project.
# ===========================================================================
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-meridian-pg}"
PG_USER="${PG_USER:-meridian}"
TEST_DB="${TEST_DB:-averis_test}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "▸ Recreating $TEST_DB"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -q \
  -c "DROP DATABASE IF EXISTS $TEST_DB;" -c "CREATE DATABASE $TEST_DB;"

run_sql() {
  docker cp "$1" "$PG_CONTAINER:/tmp/averis_step.sql" >/dev/null
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$TEST_DB" \
    -v ON_ERROR_STOP=1 -f /tmp/averis_step.sql
}

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

echo "▸ Running Phase 1 RLS assertions"
run_sql "$ROOT/supabase/tests/rls_verification.sql"

echo "▸ Running Phase 2 RLS assertions"
run_sql "$ROOT/supabase/tests/phase2_rls_verification.sql"

echo "▸ All checks passed."

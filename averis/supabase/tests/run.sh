#!/usr/bin/env bash
# ===========================================================================
# AVERIS — Row Level Security verification runner
#
# Applies the local auth stub, then the *unmodified* production migration,
# then the RLS assertions. Exits non-zero on the first failed assertion, so
# it can gate CI.
#
#   ./supabase/tests/run.sh                        # uses a Docker Postgres
#   PG_CONTAINER=my-pg PG_USER=postgres ./run.sh   # override
# ===========================================================================
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-meridian-pg}"
PG_USER="${PG_USER:-meridian}"
TEST_DB="${TEST_DB:-averis_test}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION="$(ls "$ROOT"/supabase/migrations/*_averis_core_schema.sql | head -1)"

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

echo "▸ Applying production migration: $(basename "$MIGRATION")"
run_sql "$MIGRATION"

echo "▸ Running RLS assertions"
run_sql "$ROOT/supabase/tests/rls_verification.sql"

echo "▸ All checks passed."

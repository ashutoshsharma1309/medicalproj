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
  run_sql() {
    docker cp "$1" "$PG_CONTAINER:/tmp/averis_step.sql" >/dev/null
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$TEST_DB" \
      -v ON_ERROR_STOP=1 -f /tmp/averis_step.sql
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

# Ordered by filename so a new phase is picked up automatically. Phase 1's file
# predates the naming convention, so it is applied first by name.
for assertions in \
  "$ROOT/supabase/tests/rls_verification.sql" \
  "$ROOT"/supabase/tests/phase*_rls_verification.sql
do
  [ -f "$assertions" ] || continue
  echo "▸ Running $(basename "$assertions")"
  run_sql "$assertions"
done

echo "▸ All checks passed."

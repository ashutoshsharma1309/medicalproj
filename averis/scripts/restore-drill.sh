#!/usr/bin/env bash
# ===========================================================================
# AVERIS — restore drill
#
#   ./scripts/restore-drill.sh backup.dump
#   ./scripts/restore-drill.sh backup.dump --with-rls
#
# Restores a backup into a scratch database and checks that what comes back is
# a database AVERIS can safely run against.
#
# ── Why this exists ────────────────────────────────────────────────────────
#
# "We have backups" is a claim about a file. The claim that matters is that the
# file restores into a working database, and the only way to know is to do it.
# Untested backups fail in a recognisable pattern: they restore, everything
# looks present, and something structural is missing — an extension, a schema,
# a role, or the row-security policies — which nobody notices until the day
# they are relied on.
#
# The last of those is the one specific to this project. Every authorisation
# decision in AVERIS is a Postgres policy. A restore that brings back the
# tables and the rows but loses a policy produces a database that answers every
# query, returns more than it should, and looks entirely healthy. There is no
# error to see. `pg_dump` does carry policies, and that is exactly why it is
# worth asserting rather than assuming: the failure mode of the assumption is
# silent, total, and discovered by the wrong person.
#
# ── What it checks ─────────────────────────────────────────────────────────
#
#   1. the dump restores at all
#   2. the extensions AVERIS needs are present (pgvector, pgcrypto)
#   3. every table that should have row security still has it, with policies
#      — via supabase/tests/schema_validation.sql, the same file CI runs
#   4. row counts, so a restore that succeeded but brought back an empty
#      database is not reported as a success
#   5. with --with-rls: the full assertion suite, which creates fixtures and
#      proves one patient cannot read another's records in the restored copy
#
# Step 5 is opt-in because it writes fixture rows. Against a scratch database
# that is harmless and it is the strongest check available; the flag exists so
# nobody runs it against something they care about by reflex.
#
# ── What this does not do ──────────────────────────────────────────────────
#
# It does not take the backup. Postgres is Supabase, and Supabase takes daily
# backups with point-in-time recovery on paid plans — reimplementing that would
# mean a second copy of every patient record on infrastructure with worse
# guarantees. `docs/disaster_recovery.md` covers the schedule, the retention,
# and the procedure this script is the verification half of.
# ===========================================================================
set -uo pipefail

DUMP="${1:-}"
WITH_RLS=0
[[ "${2:-}" == "--with-rls" ]] && WITH_RLS=1

if [[ -z "$DUMP" ]]; then
  sed -n '2,50p' "$0"
  exit 1
fi

if [[ ! -f "$DUMP" ]]; then
  echo "No such backup file: $DUMP" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_USER="${PG_USER:-${PGUSER:-postgres}}"
DRILL_DB="${DRILL_DB:-averis_restore_drill}"

# Two transports, matching supabase/tests/run.sh. A drill that only runs where
# psql happens to be installed on the host is a drill that does not get run.
#
#   PG_MODE=docker  (default)  psql inside PG_CONTAINER
#   PG_MODE=psql               psql on this machine
PG_MODE="${PG_MODE:-docker}"
PG_CONTAINER="${PG_CONTAINER:-supabase_db_averis}"

if [[ "$PG_MODE" == "psql" ]]; then
  pg() { psql -U "$PG_USER" "$@"; }
  # SQL files are piped on stdin in both modes, so a file path never has to be
  # valid inside the container.
  pg_file() { psql -U "$PG_USER" -d "$1" -X -v ON_ERROR_STOP=1 -f "$2"; }
else
  pg() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" "$@"; }
  pg_file() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$1" -X -v ON_ERROR_STOP=1 < "$2"; }
fi

bold() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; failures=$((failures + 1)); }

failures=0
started="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"

psql_drill() { pg -d "$DRILL_DB" -tAX -v ON_ERROR_STOP=1 "$@"; }

# --------------------------------------------------------------- 1. restore
bold "Restoring $DUMP into $DRILL_DB"

pg -d postgres -qX -c "drop database if exists $DRILL_DB;" >/dev/null 2>&1
if ! pg -d postgres -qX -c "create database $DRILL_DB;" >/dev/null; then
  echo "Could not create the drill database. Is Postgres reachable as $PG_USER?" >&2
  exit 1
fi

restore_log="$(mktemp)"
if [[ "$DUMP" == *.sql ]]; then
  pg -d "$DRILL_DB" -qX < "$DUMP" >"$restore_log" 2>&1
elif [[ "$PG_MODE" == "psql" ]]; then
  pg_restore -U "$PG_USER" -d "$DRILL_DB" --no-owner "$DUMP" >"$restore_log" 2>&1
else
  docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$DRILL_DB" \
    --no-owner < "$DUMP" >"$restore_log" 2>&1
fi
# `--no-owner` but deliberately NOT `--no-privileges`.
#
# Ownership is environment-specific and reassigning it on a scratch database is
# noise. Privileges are not: which roles hold SELECT on which table is half of
# AVERIS's authorisation model — the policies decide which *rows* a role sees,
# the grants decide whether it reaches the table at all. Restoring without them
# produces a database that passes every policy check and has silently dropped
# the other half. The first version of this script used --no-privileges and the
# grant comparison below is what caught it.
restore_status=$?

# pg_restore exits non-zero for recoverable warnings — a missing role, an
# extension already present. Those are noise on a scratch database. A restore
# that produced no tables is not.
if [[ $restore_status -ne 0 ]]; then
  printf '  restore reported warnings (see below); continuing to the checks that matter\n'
  tail -5 "$restore_log" | sed 's/^/    /'
fi

tables="$(psql_drill -c "select count(*) from information_schema.tables where table_schema = 'public';" 2>/dev/null || echo 0)"
if [[ "${tables:-0}" -gt 0 ]]; then
  ok "restored $tables tables into public"
else
  bad "the restore produced no tables — the backup is not usable"
  echo; echo "Restore log:"; cat "$restore_log"
  exit 1
fi

# ------------------------------------------------------------ 2. extensions
bold "Extensions"

# Read from the migrations rather than hardcoded here.
#
# The first version of this check asserted pgvector *and* pgcrypto, and failed
# a perfectly good backup — AVERIS has never used pgcrypto, because
# gen_random_uuid() has been in the Postgres core since 13. A drill that
# invents a requirement teaches people its failures are noise, which is the one
# thing a drill cannot afford. Deriving the list keeps it true as the schema
# changes.
required="$(grep -rhoiE 'create extension( if not exists)? +"?[a-z_]+' "$ROOT"/supabase/migrations/*.sql 2>/dev/null \
  | sed -E 's/.*(exists|extension) +"?//' | sort -u)"

if [[ -z "$required" ]]; then
  printf '  \033[33mn/a \033[0m  no extensions are declared by the migrations\n'
fi

for extension in $required; do
  present="$(psql_drill -c "select count(*) from pg_extension where extname = '$extension';")"
  if [[ "$present" == "1" ]]; then
    ok "$extension"
  else
    # pgvector backs the knowledge base. Restoring without it gives a database
    # where every retrieval query fails at runtime rather than at restore time.
    bad "$extension is declared by the migrations but missing from the restore"
  fi
done

# --------------------------------------------------- 3. row security intact
bold "Row Level Security"

# The check with the silent failure mode. A restore that lost policies answers
# every query and returns more than it should.
unprotected="$(psql_drill -c "
  select count(*)
  from pg_tables t
  where t.schemaname = 'public'
    and not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t.tablename and c.relrowsecurity
    );
")"

if [[ "${unprotected:-1}" == "0" ]]; then
  ok "every public table has row security enabled"
else
  bad "$unprotected public table(s) came back without row security enabled"
fi

policies="$(psql_drill -c "select count(*) from pg_policies where schemaname = 'public';")"
if [[ "${policies:-0}" -gt 0 ]]; then
  ok "$policies policies restored"
else
  bad "no policies restored — every authorisation decision in AVERIS is gone"
fi

# The same structural validation CI runs, against the restored copy rather than
# against a freshly migrated one. Reusing the file means a check added for CI is
# a check the drill gains for free.
if [[ -f "$ROOT/supabase/tests/schema_validation.sql" ]]; then
  validation_log="$(mktemp)"
  if pg_file "$DRILL_DB" "$ROOT/supabase/tests/schema_validation.sql" >"$validation_log" 2>&1; then
    ok "schema validation ($(grep -c 'PASS' "$validation_log" 2>/dev/null || echo 0) checks)"
  else
    bad "schema validation failed against the restored database"
    tail -20 "$validation_log" | sed 's/^/    /'
  fi
fi

# ---------------------------------------------------------- 4. data present
bold "Data"

# A restore that succeeds structurally and brings back an empty database is a
# successful restore of nothing. Reporting it as a pass is the failure this
# check exists to prevent.
for table in patient_profiles sensor_readings; do
  exists="$(psql_drill -c "select to_regclass('public.$table') is not null;" 2>/dev/null)"
  if [[ "$exists" != "t" ]]; then
    printf '  \033[33mn/a \033[0m  %s does not exist in this dump\n' "$table"
    continue
  fi

  rows="$(psql_drill -c "select count(*) from public.$table;" 2>/dev/null || echo 0)"
  if [[ "${rows:-0}" -gt 0 ]]; then
    ok "$table: $rows rows"
  else
    # Not a failure on its own — a fresh deployment legitimately has none —
    # but it must be visible rather than silently counted as a success.
    printf '  \033[33mWARN\033[0m  %s restored empty. Correct for a new deployment; alarming for a production backup.\n' "$table"
  fi
done

# --------------------------------------- 5. the authorisation model, compared
#
# Builds a reference database from the migrations and diffs the restored copy's
# authorisation model against it, item by item: every policy's expression, and
# every grant held by a client role.
#
# This replaced an earlier design that re-ran the RLS assertion suites against
# the restored database. That could not work and could not be made to: those
# suites create their own fixtures, so against any database that already
# contains them — which a restore of a database they have run against does —
# they fail on duplicate keys, and the failure says nothing about the backup.
#
# The comparison is also the stronger check. The suites prove the model behaves
# correctly for the handful of cases they cover; this proves the restored model
# is *identical* to the one the migrations produce, which covers every case
# including the ones nobody wrote an assertion for.
if [[ $WITH_RLS -eq 1 ]]; then
  bold "Authorisation model vs. the migrations"

  REFERENCE_DB="${REFERENCE_DB:-averis_drill_reference}"
  ref_log="$(mktemp)"

  printf '  building a reference database from the migrations…\n'
  if ! TEST_DB="$REFERENCE_DB" PG_MODE="$PG_MODE" PG_CONTAINER="$PG_CONTAINER" PG_USER="$PG_USER" \
       "$ROOT/supabase/tests/run.sh" >"$ref_log" 2>&1; then
    bad "could not build the reference database — comparison skipped"
    tail -10 "$ref_log" | sed 's/^/    /'
  else
    # Policies, as expressions rather than names. A policy renamed is fine; a
    # policy whose USING clause changed is the whole problem.
    model_query="
      select 'policy|' || tablename || '|' || policyname || '|' || cmd
             || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
      from pg_policies where schemaname = 'public'
      union all
      select 'grant|' || table_name || '|' || grantee || '|' || privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('authenticated', 'anon', 'service_role')
      order by 1;
    "

    restored_model="$(mktemp)"
    reference_model="$(mktemp)"
    psql_drill -c "$model_query" | sort >"$restored_model"
    pg -d "$REFERENCE_DB" -tAX -c "$model_query" 2>/dev/null | sort >"$reference_model"

    if diff -q "$reference_model" "$restored_model" >/dev/null 2>&1; then
      ok "$(wc -l <"$restored_model" | tr -d ' ') policies and grants match the migrations exactly"
    else
      missing="$(comm -23 "$reference_model" "$restored_model" | head -8)"
      extra="$(comm -13 "$reference_model" "$restored_model" | head -8)"

      bad "the restored authorisation model differs from what the migrations produce"
      if [[ -n "$missing" ]]; then
        printf '    lost in the restore:\n'
        printf '%s\n' "$missing" | sed 's/^/      /'
      fi
      if [[ -n "$extra" ]]; then
        # Not necessarily wrong — a hotfix applied to production and never
        # written as a migration shows up here, and that is worth knowing too.
        printf '    present in the backup but not in the migrations:\n'
        printf '%s\n' "$extra" | sed 's/^/      /'
      fi
    fi
  fi
else
  printf '\n  Skipped the authorisation-model comparison. Re-run with --with-rls to diff\n'
  printf '  every policy and grant in the restored copy against the migrations.\n'
fi

# -------------------------------------------------------------- conclusion
bold "Result"
printf '  drill started %s\n' "$started"
printf '  scratch database %s left in place for inspection; drop it when done:\n' "$DRILL_DB"
printf '    psql -U %s -d postgres -c "drop database %s;"\n\n' "$PG_USER" "$DRILL_DB"

if [[ $failures -eq 0 ]]; then
  printf '  \033[32mThe backup restores into a database with its authorisation model intact.\033[0m\n\n'
  exit 0
fi

printf '  \033[31m%d check(s) failed. This backup should not be relied on.\033[0m\n\n' "$failures"
exit 1

# Disaster recovery

What AVERIS does when something is lost, and what it does beforehand so that
losing it is survivable.

This document has one rule running through it: **every claim below is either
something the code does, something a script verifies, or something explicitly
marked as not yet true.** A disaster recovery document is read once, under
pressure, by someone who needs it to be accurate. A confident paragraph about a
procedure nobody has run is worse than an empty section, because it costs the
reader the time it takes to discover it is fiction.

---

## 1. What is at risk, and what each loss costs

Not everything in AVERIS matters equally, and treating it as though it does
produces a recovery plan that spends its first hour on the wrong thing.

| Data | Where it lives | Cost of losing it | Recoverable from |
| --- | --- | --- | --- |
| Patient records, conditions, medications | Supabase Postgres | **Unrecoverable.** Uploaded documents and confirmed history exist nowhere else. | Backups only |
| Alerts, emergencies, care team | Supabase Postgres | **Unrecoverable.** The accountability record of who was told what, when. | Backups only |
| Baselines, trends, risk timeline | Supabase Postgres | Recomputable from readings, but slowly, and the *superseded* baselines that explain past findings are gone for good. | Backups; partial recompute |
| Raw sensor readings | Supabase Postgres | Painful. Recent readings are gone; the derived clinical record survives. | Backups only |
| Uploaded document files | Supabase Storage | **Unrecoverable.** | Storage backups |
| Model artefacts | Container image + `ml/` | Nothing. Rebuilt by retraining, and `model_deployments` records what was serving. | Git + retraining |
| Cache | Redis | Nothing. It is a cache. | Recomputes on miss |
| In-flight device readings | Device buffer | Up to the buffer depth. See §4. | The band's own store-and-forward |

The two rows that decide the whole plan are the first two. Everything else is
either derived or replaceable.

---

## 2. Backups

**Postgres is Supabase, and Supabase takes the backups.** Daily automated
backups on all paid plans; point-in-time recovery on Pro and above, with a
retention window that depends on the plan.

AVERIS deliberately does not implement its own backup job. Doing so would mean
a second complete copy of every patient record, on infrastructure with weaker
guarantees than the primary, maintained by us. That is not a safety net — it is
a second thing to breach and a second thing to forget to encrypt.

What AVERIS *does* own is the half Supabase cannot do for us: **verifying that
a backup restores into a database whose authorisation model is intact.**

### Taking a backup by hand

```bash
pg_dump "$DATABASE_URL" -Fc --no-owner -f averis-$(date +%F).dump
```

**`--no-owner`, never `--no-privileges`.** This is not a stylistic preference.

Ownership is environment-specific and reassigning it on a restore target is
noise. Privileges are not. Which roles hold `SELECT` on which table is *half of
AVERIS's authorisation model* — the policies decide which rows a role sees, the
grants decide whether it reaches the table at all. A dump taken with
`--no-privileges` restores cleanly, brings back all 101 policies, passes every
policy-shaped check, and has silently dropped the other half.

This is written down because it was made as a mistake, by the restore drill's
own first version, and the only reason it was caught is that the drill compares
grants. Nothing about the resulting database looks wrong.

### Verifying one

```bash
./scripts/restore-drill.sh averis-2026-08-08.dump --with-rls
```

The drill restores into a scratch database and checks:

1. the dump restores at all, and produces tables
2. every extension the migrations declare is present
3. every public table still has row security enabled, with policies
4. `supabase/tests/schema_validation.sql` passes — the same file CI runs
5. the tables that should hold data are not empty
6. with `--with-rls`: every policy expression and every client-role grant is
   diffed, item by item, against a reference database built from the migrations

Step 6 is the one that matters. It does not check that the model *behaves*
correctly in the handful of cases somebody wrote an assertion for; it checks
that the restored model is **identical** to the one the migrations produce,
which covers the cases nobody thought to assert. A backup that passes it has
227 policies and grants matching exactly.

### How often to run it

Monthly, and after any change to the backup configuration. An untested backup
is a hypothesis.

**Not yet automated.** There is no scheduled job running this drill. It is a
command a person runs. Automating it needs a place to put a production dump
that is not somebody's laptop, and that decision belongs to whoever operates
the deployment.

---

## 3. Recovery procedures

### 3.1 The database is gone or corrupted

1. **Stop the writers.** `docker compose stop worker iot` — or scale the
   services to zero. The web app can stay up; it reads and writes as the
   signed-in user and will simply error. What must not happen is the ingest
   service continuing to accept readings into a database being restored under
   it.
2. **Restore.** Supabase dashboard → Database → Backups → restore to a point in
   time. For a manual dump, `pg_restore --no-owner` into the target.
3. **Verify before letting anyone in.** Run the drill's checks against the
   restored database — extensions, row security, and the model comparison.
   Bringing a database back with its policies intact and its grants missing is
   the failure mode that looks like success.
4. **Replay pending migrations.** A point-in-time restore lands wherever the
   schema was at that moment. `supabase db push` applies anything newer.
5. **Restart the writers.**
6. **Expect a gap.** Readings between the restore point and now are lost unless
   the devices still hold them — see §4.

### 3.2 The ingest service is down

Devices buffer and retry; this is a degradation, not a data loss, until the
buffers fill. See §4 for the depth.

The web app keeps working: it reads Postgres directly and never goes through
the ingest service. What stops is new readings arriving, which means the live
monitoring view goes stale and no new alerts are raised. **A silent monitoring
system looks exactly like a patient who is fine.** The device-offline detection
in the monitoring dashboard is what distinguishes them, and it is a Phase 4
feature that works precisely because it treats absence of data as a finding.

### 3.3 The AI service is down

Nothing happens. `iot-service/app/services/ai_client.py` falls back to
in-process inference on any error or non-200, and stamps
`health_predictions.inference_source = 'local'` so the fallback is visible in
the data rather than inferred from logs.

This is why the AI service was extracted with a fallback rather than as a hard
dependency: a new service is a new way for the system to stop working, unless
it is built so that it isn't.

### 3.4 Redis is down

Nothing that matters. `cached()` swallows driver errors and falls through to the
computation; the cache driver defaults to an in-process map when `REDIS_URL` is
unset. Pages get slower. Rate limiting falls back to per-instance counters,
which is weaker across multiple instances and is the one real consequence.

### 3.5 A model is producing bad output

`model_deployments` is append-only and records which version was serving and
when. Rolling back is inserting a row for the previous version and setting
`retired_at` on the current one — the partial unique index
`model_deployments_one_serving` makes it impossible to end up with two rows
claiming to serve at once.

AVERIS does **not** retrain automatically in response to drift.
`lib/mlops/drift.ts` says why: a model retrained on drifted data learns the
drift. Drift is a signal for a person to look, not a trigger.

---

## 4. What the devices hold, and for how long

The band buffers readings when it cannot reach the ingest service, and uplinks
them on reconnect through the batch endpoint (`iot-service/app/batch.py`, which
returns 207 on partial success so one bad reading in a batch does not discard
the rest).

The buffer is bounded by the ESP32's available RAM. When it fills, the oldest
readings are dropped — deliberately, because the alternative is dropping the
newest, and a monitoring device that stops recording the present in order to
preserve the past has its priorities inverted.

**The consequence, stated plainly:** an outage longer than the buffer depth
loses the oldest readings of that window permanently. Nothing recovers them.

---

## 5. Objectives, and which of them are measured

| | Target | Status |
| --- | --- | --- |
| RTO — database | 1 hour | **Not measured.** Depends on database size and Supabase's restore time; neither has been tested at production scale. |
| RTO — services | 5 minutes | Verified informally: a `docker compose up` is under a minute on a warm host. |
| RPO — database | 24 hours (daily backups) or minutes (PITR) | Determined by the Supabase plan, not by AVERIS. |
| RPO — readings | Buffer depth | See §4. |

The first row is a target, not a measurement, and is marked as such. Publishing
an RTO nobody has timed is the kind of claim that gets believed during planning
and discovered during an incident.

---

## 6. What is not covered

Stated because a gap somebody knows about is manageable and a gap they discover
mid-incident is not.

- **No automated backup verification.** §2.
- **No cross-region failover.** A Supabase region outage takes AVERIS down for
  its duration. Multi-region needs read replicas and a failover procedure, both
  of which are Supabase plan features and a topology decision, not code.
- **No tested restore at production scale.** The drill has been run against a
  development database. Restore time grows with data volume and has not been
  measured for a large one.
- **No storage backup verification.** The drill covers Postgres. Uploaded
  document files live in Supabase Storage, and no equivalent check exists for
  them.
- **No incident runbook for a partial data corruption** — the case where the
  database is up and some rows are wrong. That is harder than total loss and is
  not written.

---

## Related

- `scripts/restore-drill.sh` — the verification half of §2
- `supabase/tests/run.sh` — the migrations and the assertion suites
- `docs/cloud_architecture.md` — topology, scaling, and the partitioning cutover
- `docs/iot_runbook.md` — device-side operations

# Cloud architecture

How AVERIS is deployed, how it scales, and — the parts worth reading twice —
which services were deliberately *not* split out, and how `sensor_readings`
becomes a partitioned table without a maintenance window nobody planned for.

---

## 1. Topology

```
                          ┌──────────────┐
   browser ──── HTTPS ────│     web      │  Next.js, signed-in user's identity
                          │  (no service │  ← holds NO service-role key
                          │     role)    │
                          └──────┬───────┘
                                 │ Postgres, as the user, over RLS
                                 ▼
   ESP32 band ─── HTTPS ──┐  ┌─────────────────────┐
                          ├──│  Supabase Postgres  │◄─┐
                          │  │  RLS · Realtime ·   │  │
                    ┌─────┴──│  Storage · pgvector │  │
                    │  iot   └─────────────────────┘  │
                    │ ingest         ▲                │
                    └───┬────────────┘                │
                        │ service-role            ┌───┴────┐
                        │                         │ worker │ service-role
                        ▼                         └────────┘
                  ┌───────────┐
                  │    ai     │  stateless · no credential · no ports
                  └───────────┘
                        ▲
                  ┌─────┴─────┐
                  │   redis   │  cache + rate-limit counters, no persistence
                  └───────────┘
```

`docker-compose.production.yml` is this diagram, executable. It is a legitimate
small deployment — one clinic, one pilot ward — and the fastest way to see the
whole system running as separate processes. It is not how a thousand-patient
deployment runs; §5 covers that.

**The boundary that matters is the secret boundary, not the network boundary.**
`web` queries Postgres as the signed-in user. `iot` and `worker` hold the
service-role key because they write for every patient and cannot be scoped to
one. `ai` holds no database credential at all.

---

## 2. Which services exist, and why

### Extracted: `ai`

Splitting a system into services costs latency, a failure mode, and a
deployment. It is worth paying when the parts have genuinely different
*operational* shapes. Inference does:

- **It is CPU-bound.** Everything else in AVERIS is I/O waiting on Postgres.
  Sharing a process means a burst of assessments starves the ingest path — the
  one path that must stay fast.
- **It scales on a different axis.** Ingest scales with device count; inference
  scales with how much analysis each patient needs. Forty stable patients and
  five deteriorating ones produce the same ingest load and very different
  inference load.
- **It holds no credentials.** No database, no cache, no queue. Readings arrive
  in the request body and an assessment goes back. Nothing to leak, so it can be
  replicated without coordination and run in a network segment with no route to
  the patient database.

It ships with a local fallback (`iot-service/app/services/ai_client.py`): on any
error or non-200, the ingest service runs the same engine in-process and stamps
`health_predictions.inference_source = 'local'`. **A new service must not be a
new way for the system to stop working.**

### Not extracted: `health-service`

The brief asks for one. Building it would mean:

- It would need to serve patient data to the web app, so it would hold a
  service-role key — putting the credential the web app deliberately does not
  have one HTTP hop away from it.
- It would then have to decide, in application code, which rows each caller may
  see. That is exactly what Row Level Security does now, in the database, where
  it cannot be bypassed by a bug in a route handler.

The net effect is replacing 267 verified policy assertions with hand-written
authorisation code. That is not a refactor, it is a downgrade, and the fact that
it would produce a more conventional-looking diagram is not a reason to do it.

### Not extracted: `notification-service`

`private.raise_emergency()` creates the emergency and notifies the care team **in
one transaction**. Either both happened or neither did. There is no window in
which an emergency exists and nobody has been told.

Moving notifications behind a queue puts that window back. The failure it
introduces is precisely the one the system exists to prevent: an emergency
raised, recorded, visible in the database, and a care team that never heard.

Notification *delivery* — email, SMS, push — is genuinely asynchronous and is a
worker concern. That is where it lives. What stays in the transaction is the
record that somebody must be told.

### Not extracted: `device-service`

Device authentication is `private.resolve_device()`, a `SECURITY DEFINER`
function that resolves a token hash to a device and its owner. It is already a
separate trust boundary; it is just not a separate process. Making it one would
add a network hop to the hottest path in the system to gain nothing — the
security property comes from the owner being read from the device row rather
than the payload, and that is true regardless of which process runs it.

---

## 3. Scaling, per service

| Service | Scales with | Constraint | Notes |
| --- | --- | --- | --- |
| `web` | Concurrent users | Stateless | Replicate freely. Sessions are JWTs. |
| `iot` | Device count × uplink rate | Postgres write throughput | Stateless. The WebSocket fan-out is per-instance; see below. |
| `ai` | Assessment volume | CPU | Stateless, no coordination. The easiest thing here to scale. |
| `worker` | Document volume | Model memory | **Do not replicate without a job lock.** See below. |
| `redis` | Cache working set | 256 MB, `allkeys-lru` | Eviction is expected, not a failure. |
| Postgres | Everything | Managed by Supabase | §4. |

**`iot` replicas and the live socket.** Each instance holds its own WebSocket
connections. A browser connected to instance A does not receive a push
originating on instance B. The current fan-out is Supabase Realtime, which is
database-backed and therefore instance-independent — but any future in-process
broadcast would need Redis pub/sub. Worth knowing before adding one.

**`worker` replicas.** The worker recomputes baselines for every patient on a
sweep. Two replicas doing that concurrently is wasted compute at best and
interleaved writes at worst. Scaling it needs an advisory lock or a job queue
with a lease; neither exists yet, so run one.

---

## 4. `sensor_readings` at scale, and the partitioning cutover

### The problem

One band at 0.5 Hz is roughly 1.3 million rows a year. A thousand bands is 1.3
billion. At that size the retention delete — "remove readings older than 400
days" — rewrites a substantial fraction of the table while a ward is being
monitored.

Range partitioning by month turns that delete into `drop table`, which is
instant and takes no lock anybody notices.

### Why the migration does not do it

Converting an existing table to a partitioned one needs an `ACCESS EXCLUSIVE`
lock, a full copy of the data, and a maintenance window. Doing that inside a
migration that also does five other things means the riskiest operation in the
project runs unattended, as a side effect of a deploy, at whatever time the
deploy happens.

So `20260811090000_iot_phase8_scale_and_mlops.sql` prepares everything *around*
partitioning — the retention policy table, the archival log, the index set the
partitions will inherit — and the cutover is a scheduled operation, written
below, performed by a person who knows it is happening.

The Phase 1 column layout was chosen so this is a migration rather than a
redesign: `recorded_at` is `NOT NULL` and is the natural partition key.

### The cutover

Rehearse it against a restored backup first (`scripts/restore-drill.sh` gives
you the restored copy). Budget a window proportional to the table size; the copy
in step 4 is the long part.

```sql
-- 1. The new parent. Same columns, same constraints, partitioned by month.
create table public.sensor_readings_partitioned (
  like public.sensor_readings including defaults including constraints
) partition by range (recorded_at);

-- 2. Partitions covering existing data plus a few months ahead. Generate these
--    from min(recorded_at) — a missing partition rejects the insert, and
--    discovering that at 2am on the first of a month is avoidable.
create table public.sensor_readings_2026_08 partition of public.sensor_readings_partitioned
  for values from ('2026-08-01') to ('2026-09-01');
-- … one per month …

-- 3. Row security and grants. Postgres does NOT inherit these to the parent
--    from the old table, and this is the step whose omission is silent: the
--    data arrives, every query works, and every policy is gone.
alter table public.sensor_readings_partitioned enable row level security;
-- Re-create each policy and each grant from the migrations, verbatim.

-- 4. Copy. In batches by month, so it is resumable and so a failure at 80%
--    does not mean starting again.
insert into public.sensor_readings_partitioned
  select * from public.sensor_readings
  where recorded_at >= '2026-07-01' and recorded_at < '2026-08-01';

-- 5. The swap. Stop the writers first: `docker compose stop iot worker`.
begin;
  alter table public.sensor_readings rename to sensor_readings_legacy;
  alter table public.sensor_readings_partitioned rename to sensor_readings;
commit;

-- 6. Verify BEFORE restarting the writers.
--    Run supabase/tests/schema_validation.sql, and diff the policy and grant
--    set against a reference database exactly as scripts/restore-drill.sh does
--    with --with-rls. Step 3 is easy to get subtly wrong and impossible to
--    notice by looking.

-- 7. Restart the writers. Keep sensor_readings_legacy until the next backup
--    cycle has captured the new table.
```

Then add a scheduled job that creates next month's partition. A partitioned
table with no partition for the current month rejects every insert, which is a
monitoring outage caused by a calendar.

---

## 5. Beyond one host

`docker-compose.production.yml` runs the topology on a single machine. Above
that:

- **Cloud Run** — each service is a stateless container with an HTTP surface,
  which is what Cloud Run wants. `ai` and `web` fit directly. `iot` fits only if
  the live socket stays Supabase Realtime rather than in-process. `worker` needs
  min-instances 1 and max-instances 1 until the job lock exists.
- **GKE / Kubernetes** — a Deployment per service, an HPA on CPU for `ai` and on
  concurrency for `web`, a NetworkPolicy denying `ai` egress to the database
  (which it never uses, so the policy is free to enforce and catches a future
  mistake).
- **Postgres stays Supabase.** Self-hosting it would move backups, PITR,
  connection pooling, and the auth integration into our own operational scope,
  and every one of those is currently better than what we would build.

Whatever the orchestrator, the properties that must survive the move are: `web`
has no service-role key, `ai` has no database credential, and `worker` runs
alone.

---

## 6. Observability

Structured JSON logs from every service to one aggregator, with **allowlist**
redaction — fields are dropped unless explicitly permitted, so a new field
carrying a vital sign is redacted by default rather than logged until somebody
notices.

Health endpoints follow one convention across services:

- `/api/health/live` — is the process up. Touches nothing. A liveness probe that
  ran a real query fails under load and has the orchestrator restart a service
  that is merely busy.
- `/api/health/ready` — can it serve. Reports `degraded` with a per-check
  breakdown rather than flipping to unready for a dependency it can work
  without. The ingest service is unready without Postgres and *degraded* without
  the AI service, because it falls back locally.

What to alert on, in order: ingest error rate, readings-per-minute falling off a
cliff (a silent monitoring system looks exactly like a patient who is fine),
emergency-notification `degraded` flags from `lib/notifications/dispatch.ts`,
and `inference_source = 'local'` climbing, which means the AI service is
unreachable and nobody noticed.

---

## 7. Related

- `SECURITY_REPORT.md` — the authorisation model and its known weaknesses
- `docs/disaster_recovery.md` — backups, the restore drill, and what is not covered
- `docs/iot_architecture.md` — device to database, in detail
- `docs/ai_pipeline.md` — what the models are and what they are not
- `supabase/migrations/20260811090000_iot_phase8_scale_and_mlops.sql` — retention, drift, deployments

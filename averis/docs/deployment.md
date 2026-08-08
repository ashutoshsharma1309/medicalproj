# AVERIS — deployment

Four runtimes, one image for two of them.

```
Browser ──▶ Next.js (Cloud Run) ──▶ Supabase (Postgres + pgvector + Auth + Storage)
                 │                        ▲          ▲
                 └──▶ Redis               │          │ service role
                                    Worker (Cloud Run)│
                                                      │
ESP32 band ──▶ FastAPI ingest (Cloud Run) ────────────┘
```

| Runtime | What it does | Holds a service-role key |
|---|---|---|
| `averis-web` | Patient, clinician and caregiver UI | No |
| `averis-worker` | Document processing queue | Yes |
| `averis-iot` | Device ingest, websockets, escalation | Yes |
| Supabase | Postgres, Auth, Storage, Realtime | — |

**The web app never holds a service-role key.** It talks to Postgres as the
signed-in user, over RLS. That is the property the whole access model rests on:
a bug in a page cannot read a chart the policy would refuse, because the page
has no credential that bypasses the policy.

---

## 1. Database

```bash
export SUPABASE_DB_URL='postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres'
./scripts/setup_database.sh --remote
```

Applies all migrations in order and validates the schema afterwards — every
table has RLS, no policy grants to `PUBLIC`, `anon` holds nothing.

It **skips the RLS behavioural suite** against a hosted project, deliberately:
that suite seeds fixture patients, and a suite that writes test people into a
real project is one that eventually writes them into a production one.

Verify a hosted project from outside instead, with only the anon key:

```bash
./scripts/verify-remote.sh
```

`404` = not applied · `401` = applied and locked down · **`200` = a security
problem**.

### The one migration trap

Several migrations add values to enums created by earlier ones, and Postgres
refuses to *use* such a value in the same transaction. The Supabase SQL editor
wraps a paste in one transaction — which is exactly the case that breaks. Every
`ALTER TYPE ... ADD VALUE` is isolated from anything referencing it; keep it
that way, or apply migrations file by file rather than as one paste.

---

## 2. Images

One Dockerfile, two targets, selected by `SERVICE_ROLE` at runtime:

```bash
docker build -t averis:latest .
docker run -e SERVICE_ROLE=web    -p 3100:3100 averis:latest
docker run -e SERVICE_ROLE=worker              averis:latest
```

The ML model is baked into the image at build time rather than downloaded on
first request. A cold start that pulls 90 MB from a third party is a cold start
that fails when that third party is down, and the first request after a deploy
is the one most likely to be a health check.

The ingest service is a separate image (`iot-service/`) because it is a
different language and a different risk profile — it is the one component
exposed to devices on untrusted networks.

---

## 3. Environment

Full list in `.env.example`. The ones that change behaviour rather than
addresses:

| Variable | Runtime | Effect if unset |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | web | The app cannot start |
| `SUPABASE_SERVICE_ROLE_KEY` | worker, iot | Those services refuse to start — deliberately, at startup rather than at the first request |
| `GROQ_API_KEY` (or `GROK_API_KEY`) | web, worker | Every generative feature falls back to deterministic output and says so |
| `REDIS_URL` | web, worker | Cache and rate limits fall back to in-process — correct on one instance, wrong on several |
| `NEXT_PUBLIC_IOT_WS_URL` | web | The live monitor cannot connect |
| `NEXT_PUBLIC_DEMO_MODE` | web | `/demo` returns 404. Leave it unset in production |
| `UPLINK_INTERVAL_MS` | iot | Bands are told 2000 ms at handshake |
| `CORS_ORIGINS` | iot | Defaults to `localhost:3100` — set it, or the browser cannot open the live socket |

**`REDIS_URL` is the one that fails quietly.** With several instances and no
Redis, each holds its own rate-limit counters, so the effective limit is
`N × configured`. Nothing errors; the limit is simply not the limit.

---

## 4. CI

`.github/workflows/ci.yml` — four jobs, cheapest first.

| Job | Runs |
|---|---|
| `verify` | Type check, 443 TypeScript tests, 67 firmware checks, a committed-credential scan |
| `ingest` | 125 Python tests — the validator that accepts a band's payload in production |
| `rls` | 237 assertions against the **unmodified** production migrations, on pgvector/pg17 |
| `image` | Container build |

The `rls` job is the one that matters. Every other check verifies that AVERIS
works; that one verifies one patient cannot read another's records, and it runs
the real migrations to do it — so a policy change that opens a hole fails in CI
rather than in production.

It calls `./supabase/tests/run.sh`, the same script developers run locally,
rather than reimplementing the sequence. Two copies of "which migrations, in
what order, with which stubs" drift, and the copy that drifts is the one that
stops catching the regression it was written for.

---

## 5. Health checks

| Endpoint | Checks | Use for |
|---|---|---|
| `/api/health/live` | Nothing | Liveness |
| `/api/health/ready` | Database reachable | Readiness |

Liveness deliberately touches no dependency. A liveness probe that checks the
database fails during a database outage, the orchestrator restarts healthy
processes, and the restarts achieve nothing except adding load to a struggling
database.

The ingest service exposes the same pair, and its readiness response also
reports websocket connection counts.

---

## 6. Ordering a deploy

Schema first, services second, and never the reverse:

1. `./scripts/setup_database.sh --remote` — additive migrations only.
2. Deploy `averis-iot`. Bands reconnect and re-handshake on their own.
3. Deploy `averis-web` and `averis-worker`.

Migrations are written to be additive — new tables, new columns, new policies
beside existing ones — so a running old version tolerates a new schema. The
reverse is not true: a new version against an old schema fails on a missing
column, and on this system that surfaces as a clinician's caseload failing to
load.

**Bands need no coordination.** A device buffers what it cannot send and
replays it with the original timestamps, so a deploy window shows up in a chart
as a gap that fills in, not as lost readings.

---

## 7. Scaling notes

- **The web app is stateless.** Scale horizontally; set `REDIS_URL` before you
  do, or rate limits multiply by instance count.
- **The ingest service holds websockets**, so it is not freely horizontally
  scalable: a dashboard socket is pinned to the instance ingesting that
  patient's readings. Sticky sessions, or a shared pub/sub, are the next step
  and neither is implemented.
- **`sensor_readings` is the table that grows.** A BRIN index on time plus a
  composite btree on `(device_id, recorded_at desc)`. Partitioning by month is
  the next step and is deliberately not done: it adds operational overhead a
  table with no rows cannot justify, and the column layout is chosen so
  partitioning later is a migration rather than a redesign.

---

## 8. Not implemented

- **No blue/green or canary.** Cloud Run's default revision switch.
- **No automated rollback.** Migrations are additive, so rolling a service back
  is safe; rolling the schema back is not scripted.
- **No backup or restore procedure** beyond Supabase's own.
- **No secret rotation procedure** for the service-role key. Device tokens can
  be rotated per device from the UI.
- **No metrics or alerting.** See [LOGGING_ARCHITECTURE.md](../LOGGING_ARCHITECTURE.md)
  for the four signals worth wiring first.

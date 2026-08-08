# AVERIS — deployment guide

From an empty cloud account to a running platform. Follow it in order; each
step ends in something you can check.

Architecture, environment reference and scaling notes are in
**[docs/deployment.md](docs/deployment.md)**. This is the procedure.

---

## What you are deploying

| Runtime | What it is | Holds a service-role key |
|---|---|---|
| `averis-web` | Next.js — patient, clinician and caregiver UI | **No** |
| `averis-worker` | Document processing queue | Yes |
| `averis-iot` | FastAPI — device ingest, websockets, escalation | Yes |
| Supabase | Postgres, Auth, Storage, Realtime | — |
| Redis | Cache and rate-limit counters | — |

**The web app never holds a service-role key.** It queries Postgres as the
signed-in user, over Row Level Security. Keep it that way: the entire access
model rests on a bug in a page being unable to reach a chart the policy would
refuse, and one convenient environment variable would undo it.

---

## 1 · Database

```bash
export SUPABASE_DB_URL='postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres'
./scripts/setup_database.sh --remote
```

Applies 16 migrations in order, then validates: every table has RLS, no policy
grants to `PUBLIC`, `anon` holds nothing, no string-typed token column is
selectable.

**Verify from outside**, with only the publishable key — this is the check that
matters, because it tests what the internet can reach rather than what you
believe you configured:

```bash
./scripts/verify-remote.sh
```

`404` = not applied · `401` = applied and locked down · **`200` = a security
problem, stop and fix it.**

### The migration trap

Several migrations add values to enums created by earlier ones, and Postgres
refuses to *use* such a value in the same transaction. **The Supabase SQL
editor wraps a paste in one transaction**, which is exactly the case that
breaks. Use the script, or apply files one at a time. `supabase/apply-all.sql`
exists for convenience and carries the same warning at the top.

### Enable Realtime

The clinician's inbox subscribes to `care_notifications`. The migration adds it
to the `supabase_realtime` publication *if that publication exists*. On a
hosted project it does — confirm in **Database → Replication** that
`care_notifications` is included.

Without it the inbox still works: it falls back to a 60-second re-read. That is
by design, and it is also why a missing publication is easy not to notice.

---

## 2 · Secrets

Generate these before deploying anything. None of them belongs in the
repository.

| Secret | Where it goes | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | web | Public by design |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web | Public by design — RLS, not secrecy, protects the data |
| `SUPABASE_SERVICE_ROLE_KEY` | worker, iot | **Never** to the web app |
| `GROQ_API_KEY` or `GROK_API_KEY` | web, worker | Optional — everything degrades to deterministic output |
| `REDIS_URL` | web, worker | Required before scaling past one instance |

CI fails the build if a credential-shaped string is committed. That check is a
backstop, not a policy.

---

## 3 · The ingest service

Deploy this **before** the web app: bands reconnect on their own, and a band
that cannot reach the ingest service buffers rather than losing readings.

```bash
cd iot-service
docker build -t averis-iot .
gcloud run deploy averis-iot \
  --image averis-iot --region <region> --allow-unauthenticated \
  --set-env-vars "SUPABASE_URL=...,CORS_ORIGINS=https://<your-web-host>" \
  --set-secrets "SUPABASE_SERVICE_ROLE_KEY=averis-service-role:latest"
```

`--allow-unauthenticated` is correct here and worth understanding: devices
authenticate with their own bearer tokens, which the service verifies against
hashed values. Cloud Run's IAM layer cannot check a device token, so the check
that matters is the one inside the application.

**`CORS_ORIGINS` must list the web app's origin**, or the browser cannot open
the live monitoring socket. It defaults to `localhost:3100`, which is right for
a laptop and wrong for everything else.

Check: `curl https://<iot-host>/api/health/ready` → `{"status":"ready"}`.

---

## 4 · Web and worker

One image, two roles, selected by `SERVICE_ROLE` at runtime.

```bash
docker build -t averis .

gcloud run deploy averis-web \
  --image averis --region <region> --allow-unauthenticated \
  --set-env-vars "SERVICE_ROLE=web,NEXT_PUBLIC_SUPABASE_URL=...,NEXT_PUBLIC_IOT_WS_URL=wss://<iot-host>/api/live"

gcloud run deploy averis-worker \
  --image averis --region <region> --no-allow-unauthenticated \
  --set-env-vars "SERVICE_ROLE=worker,..." \
  --set-secrets "SUPABASE_SERVICE_ROLE_KEY=averis-service-role:latest"
```

The worker is `--no-allow-unauthenticated`. It has no HTTP surface anyone
should reach and it holds a key that bypasses RLS.

**`NEXT_PUBLIC_*` variables are baked in at build time.** Changing one needs a
rebuild, not a restart — a redeploy with a new value and the same image does
nothing, which is a confusing hour if you have not hit it before.

The ML model is baked into the image rather than fetched on first request. A
cold start that pulls 90 MB from a third party fails when that third party is
down, and the first request after a deploy is usually a health check.

---

## 5 · Content Security Policy

The CSP's `connect-src` is built from environment variables at build time:

- `NEXT_PUBLIC_SUPABASE_URL` — and its `wss://` form, for Realtime
- `NEXT_PUBLIC_IOT_WS_URL` — the live monitoring socket
- `NEXT_PUBLIC_IOT_HTTP_URL` — the ingest origin, used by the demonstration

**If a fetch or socket fails in production but works locally, check this
first.** A missing origin here produces a blocked request with a console error
and no server-side trace, and it is the one class of bug that only appears
after deployment.

---

## 6 · Demonstration mode

```
NEXT_PUBLIC_DEMO_MODE=true
NEXT_PUBLIC_IOT_HTTP_URL=https://<iot-host>/api/device/upload
```

**Leave both unset in any deployment serving real patients.** `/demo` returns
404 without the first. It seeds nothing and cannot fabricate data — every
reading it produces goes through the real ingest path and is stamped as
simulated — but it is a page whose purpose is to make the system easy to drive,
and that is not a property an unattended clinical deployment wants.

---

## 7 · Verify the deployment

In order. Each one fails differently, so do not skip ahead.

```bash
curl https://<web-host>/api/health/live      # {"status":"ok"}
curl https://<web-host>/api/health/ready     # {"status":"ready"}
curl https://<iot-host>/api/health/ready     # {"status":"ready"}
./scripts/verify-remote.sh                   # 401s, not 200s
```

Then, in a browser:

1. Sign up, complete onboarding.
2. **Devices → Register** — tick "This is a simulator". Copy the token.
3. Run the simulator against the deployed ingest service:
   ```bash
   python3 sensor_simulator/simulate.py \
     --token avd_... --device-key AVR001 \
     --url https://<iot-host>/api/device/upload --mode normal
   ```
4. **Dashboard** — vitals appear, the monitoring score computes.
5. `--mode emergency` — an alert, an emergency event, and a clinician notice.

If step 3 returns 401, the token is wrong. If it returns a network error, check
`CORS_ORIGINS` and that the service is reachable.

---

## 8 · Deploy ordering, on every release

Schema first, ingest second, web last:

1. `./scripts/setup_database.sh --remote`
2. `averis-iot`
3. `averis-web` and `averis-worker`

Migrations are additive — new tables, new columns, new policies beside existing
ones — so a running old version tolerates a new schema. **The reverse is not
true:** a new version against an old schema fails on a missing column, and on
this system that surfaces as a clinician's caseload failing to load.

Bands need no coordination. A device buffers what it cannot send and replays it
with the original timestamps, so a deploy window appears in a chart as a gap
that fills in rather than as lost readings.

---

## 9 · After deploying

- **Set `REDIS_URL` before scaling past one web instance.** Without it each
  instance keeps its own rate-limit counters, so the effective limit is
  `N × configured`. Nothing errors; the limit is simply not the limit.
- **The ingest service is not freely horizontally scalable.** A dashboard
  websocket is pinned to the instance ingesting that patient's readings.
  Sticky sessions or a shared pub/sub are the next step, and neither is
  implemented — run one instance until then.
- **Watch the ingest service's logs for `escalation failed`.** It is logged at
  `error` and means alerts were stored and nobody was notified. Nothing
  currently alerts on it.

---

## 10 · Not implemented

Stated so nobody assumes otherwise:

- No blue/green or canary — Cloud Run's default revision switch.
- No automated rollback. Rolling a service back is safe; rolling the schema
  back is not scripted.
- No backup or restore procedure beyond Supabase's own.
- No rotation procedure for the service-role key. Device tokens rotate per
  device from the UI.
- No metrics or alerting. The four signals worth wiring first are listed in
  [LOGGING_ARCHITECTURE.md](LOGGING_ARCHITECTURE.md).

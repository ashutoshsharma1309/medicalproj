# AVERIS IoT — architecture report

Phase 1 of the IoT monitoring track. Written before any code changed, per the
brief's instruction not to rewrite blindly.

---

## 1. Current state

AVERIS today is a Next.js 16 application on Supabase Postgres, six phases deep:

| Layer | What exists |
|---|---|
| Web | Next.js App Router, server components, server actions. Routes: `/dashboard`, `/twin`, `/risk`, `/intelligence`, `/records`, `/activity` |
| Data | 19 tables across 7 migrations, all with deny-by-default RLS |
| Auth | Supabase Auth (email + Google OAuth), `proxy.ts` for token refresh |
| Identity helper | `private.current_patient_profile_id()` — SECURITY DEFINER, resolves the signed-in user to their patient profile. Every RLS policy in the system is built on it |
| ML | Python training pipeline → JSON artifacts → TypeScript inference in-process |
| RAG | pgvector + MiniLM embeddings, retrieval scoped by RLS |
| Platform | Structured logging, audit trail, rate limiting, cache, job queue, plan limits |

Two properties matter for what follows:

- **Every authorization decision lives in an RLS policy**, expressed in terms of
  the signed-in user. Nothing in application code re-checks ownership, on
  purpose — a second copy of an authorization rule is one more thing that can
  drift out of agreement with the first.
- **Everything runs in one process.** Phases 4 and 5 explicitly rejected
  sidecar services so that patient data never crosses a process boundary.

---

## 2. Why this phase reverses the "one process" decision

The brief asks for a FastAPI service. That is the opposite of the call I made in
Phases 4, 5 and 6 — and here it is the right one, for reasons that did not apply
before.

**Device authentication is a different trust boundary.** Every existing endpoint
answers to a browser holding a Supabase session cookie. An ESP32 has no browser,
no cookie, and no way to complete an OAuth flow. It authenticates as *itself*,
with a credential provisioned at registration time. Bolting a second, weaker
auth scheme onto the app that serves patient dashboards means one
misconfiguration exposes both. A separate ingress lets the device credential be
the *only* thing that service accepts.

**The workload is inverted.** Web serving is read-heavy, bursty, and tolerant of
100 ms. Ingestion is write-heavy, steady, and continuous — one device at 0.5 Hz
is 43,200 writes a day, and a hundred devices is 4.3 million. Sharing a runtime
means a slow OCR job adds latency to sensor writes, and a burst of sensor writes
adds latency to someone reading their own medical record.

**WebSocket and MQTT need a process that stays up.** Next.js route handlers are
request-scoped; they cannot hold a fan-out socket open or maintain a broker
subscription. That is not a limitation to work around — it is a signal that this
belongs somewhere else.

**Considered and rejected: Supabase Realtime.** It would give live dashboard
updates with no socket server to operate, and it already respects RLS. But an
ingest service has to exist regardless for the device-auth reason above, and
once it exists, having it own the socket too is strictly simpler than running
two push mechanisms with different failure modes. Realtime remains the fallback
if operating the socket proves painful.

---

## 3. Target architecture

```
  ESP32 / simulator
        │  HTTPS POST, device token         (later: MQTT / BLE)
        ▼
  ┌──────────────────────────┐
  │  iot-service  (FastAPI)  │   validates → authenticates device →
  │                          │   resolves owner → writes → broadcasts
  └────────┬─────────────┬───┘
           │             │
     write │             │ WebSocket fan-out
           ▼             ▼
   Supabase Postgres   Dashboard  (Next.js)
   sensor_readings          │
   iot_devices              │ reads history over RLS
   alerts   ◄───────────────┘
```

The dashboard reads history through the existing RLS-scoped Supabase client and
receives live values over the socket. History and live data therefore travel
different paths on purpose: a dropped socket costs the live tile, never the
record.

---

## 4. The security decision that shapes everything

**The ingest endpoint must never trust `patient_id` from the payload.**

The brief's example body carries `device_id` and readings. If the service stored
whatever patient the caller named, any device credential would be able to write
readings into any patient's chart — and the readings would look entirely
legitimate afterwards, because nothing downstream can tell a forged row from a
real one.

So the flow is:

1. Device presents a bearer token.
2. Service hashes it and looks up the device. No match → 401.
3. **Patient is read from the device row**, never from the request.
4. Reading is written with that patient id.

`device_id` in the payload is used only to confirm it matches the authenticated
device, so a mismatch is a loud error rather than silent cross-writing.

Tokens are stored as SHA-256 hashes, shown once at registration. A database leak
therefore yields no usable device credentials.

---

## 5. Schema changes

| Table | Purpose | Notes |
|---|---|---|
| `user_role` enum | add `CAREGIVER`, `ADMIN` | Postgres cannot drop enum values, so `HOSPITAL_ADMIN` stays |
| `iot_devices` | registered wearables | token hash, owner, status, battery, last seen |
| `sensor_readings` | time-series readings | BRIN on time, composite btree for "latest" |
| `alerts` | threshold breaches | severity, status, links to reading |

**Time-series indexing.** A btree over a monotonically increasing timestamp on
an append-only table grows without bound and is mostly wasted — the table is
already in time order on disk. A BRIN index stores one summary per block range
and is orders of magnitude smaller for the same range scans. A composite btree
on `(device_id, recorded_at desc)` covers the other query that matters: "the
most recent reading for this device". Both, because they serve different reads.

Partitioning by month is the next step and is deliberately *not* done now — it
adds operational overhead that a table with no rows cannot justify. The BRIN
index and the column layout are chosen so partitioning later is a migration, not
a redesign.

---

## 6. What this phase does not do

Stated so the boundaries are explicit rather than discovered later:

- No hardware. The simulator speaks the same HTTP contract an ESP32 will.
- No MQTT broker. The device-transport interface is written so MQTT is another
  implementation rather than a rewrite.
- No BLE. Same.
- No AI on the sensor stream. Alerts in this phase are threshold rules, not
  predictions — a predicted alert nobody can explain is worse than none.
- No doctor or caregiver UI. The roles exist in the enum; only patient
  functionality is built.

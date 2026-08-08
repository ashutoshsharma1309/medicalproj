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

---

## 7. Phase 4 — the care team

Phase 1 through 3 built a monitoring system with one user in it. This phase is
the first time one person reads another person's health record, which makes it
the highest-risk change in the project and the one with the least visible
failure mode: a doctor browsing an unassigned chart sees a perfectly normal
page.

### The two decisions that make cross-patient access safe

**Additive policies.** Postgres ORs permissive policies together, so a new
"doctors read assigned patients" policy sits beside the untouched "patients
read their own" policy. The consequence is what matters — the care-team
migration *cannot* narrow patient self-access, because it does not modify those
policies at all. The only remaining failure mode is a doctor policy that is too
broad: one thing to get right instead of sixty-six.

**One helper owns the rule.** `private.can_access_patient()` is the single
place the question "may this user see this patient?" is answered. Every new
policy calls it; none reimplement it. The revocation check therefore exists
once rather than in every predicate that could forget it.

The one policy that broke this rule broke the feature. `users` was given an
inline `exists` over `patient_profiles` instead of a helper — and a subquery
inside a policy is subject to the referenced table's RLS for the querying user.
A caregiver holding `VIEW_ALERTS` deliberately cannot read `patient_profiles`,
so they could see an emergency and not the name of the person it was about.
Fixed in `20260808094500` with `private.is_care_subject()` and
`public.care_patient_directory()`.

### Three grants, not one role

| Grant | Sees |
|---|---|
| Doctor (`ACTIVE` assignment) | Everything clinical: vitals, alerts, risk, records, timeline |
| Caregiver `FULL` | The same, minus documents and the patient's questions to AVERIS |
| Caregiver `VIEW_VITALS` | Alerts, emergencies and measurements |
| Caregiver `VIEW_ALERTS` | Alerts and emergencies only — not a single measurement |

`ai_conversations`, `audit_logs`, `notifications` and `subscriptions` are
extended to **nobody**. A patient's questions are theirs; the audit trail is the
subject's own and would otherwise become a surveillance channel.

### Escalation: alert → emergency → person

An alert says a measurement crossed a threshold. An emergency says a human has
to respond, and it stays in a queue until one does. `lib/care/escalation.ts`
owns the distance between those claims, with `iot-service/app/escalation.py` as
the copy that runs on the ingest path.

Rules, not a model — an escalation wakes someone up, and the person woken
deserves to know what tripped it. The AI engine may still raise one, because a
slow decline in which every reading sits inside the normal band is the one
thing thresholds structurally cannot see, but only when risk is critical *and*
rising. A critical temperature deliberately does not escalate: it is a real
finding and not a minutes-matter event, and diluting the queue would not
improve the fever.

**Raising and notifying are one transaction.** `private.raise_emergency()`
inserts the event and fans out the notices together. Split them and the failure
is silent: the event lands, the fan-out fails, and a clinician's queue shows an
emergency nobody was told about. Nothing looks broken. The patient waits.

Deduplication is a partial unique index — one open event per patient per type.
A device below the SpO2 threshold at 0.5 Hz would otherwise raise one every two
seconds, and 300 unanswered emergencies is a queue nobody can triage at the
moment it matters. The function returns `NULL` for a suppressed escalation so
the caller stops rather than retrying into a constraint violation.

### Delivery

`care_notifications` is addressed to a **user**, not a patient — reusing the
patient-scoped `notifications` table would have put a doctor's inbox under the
patient's row, where the patient's own policy hands it back to them. Notices
link to `/clinical/:id` or `/care/:id` depending on the recipient's role,
because a caregiver sent to a doctor's route follows a link into a 404 during
an emergency.

The inbox has two delivery paths on purpose: a Postgres realtime subscription
for the normal case, and a 60-second re-read regardless. A websocket can die
quietly — closed lid, proxy timeout, sleeping tab — and a notification system
whose failure mode is silence is indistinguishable from "no emergencies". The
pushed payload is ignored and the page re-reads through RLS; trusting the row on
the channel would mean trusting the channel to have filtered another
clinician's patient out of it.

### Generative features, and where the line is

Two: patient summaries and the assistant. Both follow the rule the rest of
AVERIS follows — **the numbers are computed, the model only phrases them.**

`lib/care/report.ts` assembles the arithmetic. A model asked whether oxygen
saturation fell over 24 hours will produce a confident direction from nothing;
handed a decline it did not compute, it cannot invent one. Drift is measured
first-fifth to last-fifth rather than first-to-last, so two readings taken
during a cough and during sleep do not become a trend, and under ten readings no
direction is reported at all.

The assistant classifies a question into the small set of things monitoring data
can answer, and refuses diagnosis, prescription and prognosis requests **before
a model is called**. A refusal that depends on the model honouring its system
prompt can be argued out of, and "should I stop my beta blocker" is exactly the
question someone will keep rephrasing until something answers.

Voice is browser-only. Recognition runs through the Web Speech API and AVERIS
receives the transcript, never the audio: a health platform that streams a
microphone to a server has acquired a recording of a patient's home. Commands
("show critical patients") navigate rather than asking, and a misheard
utterance says so instead of being forwarded — a fluent answer to a question
nobody asked is worse than admitting the miss.

### What Phase 4 does not do

- **No email, SMS or push.** In-app only. A channel that silently does nothing
  is worse than an absent one, and an emergency notification that quietly fails
  is the worst version of that.
- **No clinician onboarding.** `doctors` rows are created out of band and
  `verified_at` is never set by anything; the UI says so rather than implying a
  verification that has not happened.
- **No admin console.** The ADMIN role exists in the enum and nothing grants it
  anything.
- **No escalation ladder.** If nobody acknowledges an emergency, it stays open
  and nothing else happens — no timeout, no on-call rotation, no fallback
  contact. That is the next honest piece of work, and pretending otherwise
  would be the dangerous kind of gap.

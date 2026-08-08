# AVERIS — logging and observability

Three runtimes produce logs: the Next.js application, the FastAPI ingest
service, and the browser. They emit the same shape so one aggregator can read
all three.

---

## The rule everything else follows

> **Log identifiers and outcomes. Never content.**

`"Patient viewed document 3f2a"` is auditable.
`"Patient viewed document 3f2a containing HbA1c 8.2%"` is a second copy of the
medical record — in a store with different access rules, a longer retention
period, more readers, and an export path to a third-party aggregator.

A log line is the easiest way for patient data to leave a system that is
otherwise careful with it, and a leak into logs outlives every control on the
data it copied. So redaction is enforced by the logger rather than left to call
sites: `lib/observability/logger.ts` refuses a set of key names outright,
truncates free text at 200 characters, and collapses objects deeper than three
levels — because a deeply nested object in a log line is almost always someone
having passed a whole database row.

`lib/observability/__tests__` — via `lib/platform/__tests__/platform.test.ts` —
asserts the redaction, so a future key that leaks fails a test rather than a
review.

---

## Shape

One line of JSON per event. Logs are read by an aggregator during an incident,
not by a person scrolling a terminal.

```json
{
  "level": "info",
  "msg": "risk assessment ok",
  "time": "2026-08-09T12:00:00.000Z",
  "service": "averis-web",
  "patientId": "3f2a…",
  "durationMs": 142,
  "model": "cardiovascular-v2"
}
```

| Field | Always present | Notes |
|---|---|---|
| `level` | ✓ | `debug` \| `info` \| `warn` \| `error` |
| `msg` | ✓ | Stable string. Never interpolated with values — interpolation is what makes a log unsearchable and is how content leaks in. |
| `time` | ✓ | ISO-8601 UTC |
| `service` | ✓ | `averis-web`, `averis-worker`, `averis-iot` |
| `durationMs` | on `timed()` | Latency for every external call |

`warn` and `error` go to stderr, everything else to stdout, so a container
platform separates them without configuration.

---

## What is logged, by runtime

### Next.js application (`averis-web`)

| Event | Level | Where |
|---|---|---|
| Audit-worthy actions | — | **Not logs.** `audit_logs`, a database table with its own RLS |
| External call latency and failure | info / error | `timed()` in `logger.ts` |
| Cache and rate-limit backend failures | warn | `lib/cache/redis-driver.ts` |
| Audit write failures | error | `lib/audit/audit-service.ts` — loudly, because a silently missing audit trail is worse than a noisy one |
| Readiness probe results | info | `app/api/health/ready` |
| Browser errors | error | `app/api/observability/client-error` |

**Auditing is not logging, and the split is deliberate.** Who read whose chart
goes to `audit_logs` — a table a patient can read about themselves, that
survives log rotation, and that is queryable. Logs are for operating the
system; the audit trail is for answering "who looked at my record in March".

### Ingest service (`averis-iot`)

| Event | Level | Why it is there |
|---|---|---|
| Service start | info | |
| Device key mismatch | warn | The payload named a device the token did not prove — a misconfigured band or a replayed token |
| Device status update failure | warn | Best-effort; the reading is already stored |
| Escalation created | info | `escalated SEVERE_HYPOXIA for patient …` |
| **Escalation failed** | **error** | The most serious thing this service can do silently. The alerts are stored and nobody was notified |
| Clock skew > 5 minutes | info | Distinguishes a buffering device from one whose clock is wrong |

The ingest path never logs a vital sign. A reading's *identifiers* and the fact
that it was processed are logged; the values live in `sensor_readings`, which
is the record.

### Browser

Two sources, because React's error boundaries cannot see everything:

- **Boundaries** (`app/error.tsx`, `app/global-error.tsx`) catch exceptions
  thrown during render.
- **`components/observability/ErrorReporter.tsx`** catches what they cannot: a
  rejected promise in the monitoring socket, a failed realtime subscription, a
  throw from an event handler. On this application those are the interesting
  failures — they leave a dashboard looking fine while showing nothing new.

Both post to `/api/observability/client-error`, which re-sanitises and emits an
`error` line.

**Reports are scrubbed twice.** React error messages quote props, so a stack
from a page rendering vital signs can contain vital signs. The client scrubs
UUIDs, emails, bearer and device tokens, JWTs, and anything shaped like
`heart_rate: 168`; the server scrubs again, because the client is the component
that just crashed and a caller can post whatever it likes.

### Firmware

Serial only, and **off by default** (`AVERIS_SERIAL_DEBUG 0`). On a worn device
a debug UART printing every reading is a vital-sign stream out of a port.

What the fleet reports instead is *telemetry*, which is structured and goes to
the database rather than to a log: signal strength, uptime, boot count,
per-sensor state, buffered count. That is what `/devices/hardware` and the
engineering view read, and what turns "device offline" into "the MAX30102 is
not answering while WiFi holds at -55 dBm".

Discrete hardware events — boots, sensor faults, firmware changes, buffer
overruns — are written to `device_events`, **on change only**. A band uplinks
every two seconds; an event per uplink would be a second readings-sized table
describing a sensor that has been fine all day.

---

## Levels

| Level | Means | Example |
|---|---|---|
| `debug` | Development detail | Cache hit ratios |
| `info` | Something normal happened, with a duration | An assessment completed |
| `warn` | Degraded, recovered | Redis unreachable, fell back to in-process |
| `error` | Something did not happen that should have | An escalation was not delivered |

Default threshold is `info` in production, `debug` otherwise, overridable with
`LOG_LEVEL`.

**`error` means a human should look.** Nothing routine is logged at error, so
an alert on error rate is meaningful. The counter-example, deliberately kept at
`warn`: a device status update failing. The reading it accompanies is already
stored, and paging someone for a stale battery indicator is how an on-call
rotation learns to ignore the pager.

---

## Correlation

Three runtimes, one patient journey. What ties them together today:

- `patientId` and `deviceId` appear in application and ingest logs.
- `durationMs` on every external call, from `timed()`.
- `digest` on browser errors — the id Next assigns to the server-side stack,
  which is also the reference shown to the user, so a support conversation
  starts with a string that finds the trace.

**What is missing, stated rather than implied:** there is no distributed trace
id propagated from browser → app → ingest. A single reading's journey cannot be
followed end to end from the logs alone. This is the largest observability gap
and the honest next step — an OpenTelemetry-style `traceparent` generated at
the edge in `proxy.ts` and carried through.

---

## Metrics and alerting

**Not implemented.** No metrics endpoint, no dashboards, no alert rules.

`/api/health/live` and `/api/health/ready` exist and are the correct shape —
liveness touches no dependency, so a database outage does not cause an
orchestrator to restart healthy processes and add load to a struggling
database. Readiness reports websocket connection counts. Neither is a metrics
system.

The four signals worth wiring first, in order:

1. **Escalations not delivered** — the `error` from the ingest service. A
   patient in trouble and nobody told.
2. **Devices that went silent** — derivable today from `last_reading_at`, not
   currently alerted on.
3. **Ingest error rate** by status, particularly 401s: a spike means a fleet
   with a bad token.
4. **Model provider latency and failure**, already timed, not currently
   collected.

---

## Retention and access

Not implemented in code, and a deployment decision rather than a code one — so
it is stated here as an obligation rather than a feature:

- Application logs contain identifiers, not health content. They still identify
  which patient was active when, which is itself sensitive.
- **A log aggregator holding AVERIS logs is in scope for whatever regime covers
  the deployment.** Access to it should be no broader than access to the
  database.
- `audit_logs` is the record with legal weight and lives in Postgres, subject to
  RLS. It is not shipped to the log aggregator, and should not be.

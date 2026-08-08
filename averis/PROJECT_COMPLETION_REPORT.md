# AVERIS AI — project completion report

Audit of the repository against the five phase briefs, written after an
automated completion pass. Every claim below is either verified by an executed
test or marked as unverified.

**Date of audit:** 2026-08-09
**Verification state:** all five suites executed, zero skipped.

| Suite | Result |
|---|---|
| TypeScript type check | pass |
| TypeScript unit tests | 443 / 443 |
| Python tests | 125 / 125 |
| Firmware logic checks | 67 / 67 |
| Database — schema + RLS | 237 assertions, all pass |

Regenerate with `./run_all_tests.sh` → `TEST_REPORT.md`.

---

## The headline change in this pass

**Two of the four known limitations are now resolved.**

The previous report stated that the Phase 5 migration had never been executed
and that RLS assertions had never run, because no PostgreSQL environment was
available. One became available during this pass. All **16 migrations were
applied to Postgres 17** and **237 assertions executed**.

That was not a formality. Executing them found **five defects that reading them
had not**, three in tests and two in the product:

| Found | Kind | Status |
|---|---|---|
| `iot_devices.token_hash` had no `UNIQUE` constraint | **Product** | Fixed |
| A patient could not read the identity of their own caregiver | **Product** | Fixed |
| Three RLS assertions passed vacuously — subqueries over tables the acting role could not read, inserting zero rows | Test | Fixed |
| A fixture collided with another suite's token hash | Test | Fixed |
| A fixture omitted a `NOT NULL` column | Test | Fixed |

The second product defect is the more serious. `/care-team` is the page the
entire Phase 4 access model rests on — it is where a patient grants and
withdraws access. Without the caregiver's identity, every row rendered as an
unnamed "Caregiver", and a patient looking at two identical rows cannot revoke
the right one. Consent that cannot be exercised specifically is barely consent.

It is the exact mirror of a Phase 4 defect found earlier: that one stopped a
caregiver seeing the patient, this one stopped the patient seeing the
caregiver. Both came from assuming an identity policy written for one direction
covered both.

---

## Phase-by-phase

### Phase 1 — IoT-ready foundation · **complete**

| Requirement | State |
|---|---|
| Patient authentication | Built — Supabase Auth, email/password + Google, JWT re-validated server-side |
| IoT device architecture | Built — `iot_devices`, hashed tokens, rotation, retirement |
| Device management | Built — `/devices`, register / rename / rotate / retire |
| Sensor data APIs | Built — FastAPI ingest, shared wire contract, 3 validators held to one vector file |

**Verified:** 28 IoT Phase 1 assertions + 12 device-authentication assertions.
A token resolves to exactly one device and owner; retirement and rotation both
revoke immediately; no client role can call the resolver, write a reading, or
select `token_hash`.

### Phase 2 — Real-time monitoring · **complete**

| Requirement | State |
|---|---|
| Real-time monitoring system | Built — websocket hub, per-patient isolation, no broadcast path exists |
| Sensor simulator | Built — separate HTTP client, 5 scenarios, 3 modes, fault injection |
| Live dashboard | Built — `/monitoring`, tiles grey out when stale rather than showing a stale number |
| Real-time graphs | Built — SVG small multiples, extreme-preserving downsampling |

**One design note worth restating:** the charts downsample by keeping each
bucket's *extreme*, not its first or mean. Taking every Nth point makes a
two-second spike to 165 BPM vanish, rendering an hour of data as a calm line
through the exact event the monitor exists to show.

### Phase 3 — AI health intelligence · **complete**

| Requirement | State |
|---|---|
| AI anomaly detection | Built — `ai_engine/models/anomaly.py` |
| Risk prediction | Built — rule-based stream engine + logistic models with exact SHAP |
| Explainable AI | Built — contributions stored *with* the prediction |

Explanations are stored alongside the prediction rather than recomputed: a
later engine version would produce different contributions, and the patient
would have no way to see what they were actually shown at the time.

**Not built:** drift detection. Prerequisites exist (model registry, inference
logging); the detector does not.

### Phase 4 — Doctor / caregiver platform · **complete**

| Requirement | State |
|---|---|
| Doctor dashboard | Built — `/clinical`, triage-ordered caseload, per-patient chart |
| Caregiver system | Built — `/care`, three permission levels, patient-controlled |
| Emergency alerts | Built — escalation rules, `raise_emergency()` atomic with fan-out, real-time inbox |
| Healthcare assistant | Built — context-aware, refuses diagnosis before a model is called |

**Verified:** 32 + 34 assertions. `VIEW_ALERTS` sees emergencies and not one
measurement; `VIEW_VITALS` sees measurements and not the medical record; a
`PENDING` assignment grants nothing; a `REVOKED` one ends access immediately
across every table.

**Not built, and the most important gap in the project:**

> **There is no escalation ladder.** An emergency nobody acknowledges stays
> open and nothing further happens — no timeout, no on-call rotation, no
> fallback contact, no re-notification. A clinician who misses the first notice
> misses it permanently.

Also absent: email/SMS/push (in-app only, deliberately — a channel that
silently does nothing is worse than an absent one), clinician verification
(`verified_at` is never set by anything, and the UI says so), and any admin
console (the `ADMIN` role exists in the enum and grants nothing).

### Phase 5 — Hardware integration · **complete in software, unvalidated on hardware**

| Requirement | State |
|---|---|
| ESP32 firmware | Built — 13 source files, sensors / OLED / buzzer / WiFi / BLE / power |
| Sensor processing on device | Built — outlier rejection, resync, fall state machine, 67 host-run checks |
| JSON data format | Built — matches the Phase 1 contract exactly; no `patient_id` on the wire |
| Communication layer | WiFi + HTTP built. **MQTT not implemented** — the transport interface is written so it is another implementation rather than a rewrite |
| BLE | Built, **read-only by design** — see below |
| WiFi cloud communication | Built — `/api/device/upload`, `/api/device/hello` handshake |
| Device authentication | Built and verified |
| OLED / buzzer / fall detection | Built |
| Backend hardware adaptation | Built — one pipeline, simulator and band are both clients of it |
| Hardware status dashboard | Built — `/devices/hardware` |
| Hardware testing mode | Built — `/devices/<key>/diagnostics` |
| Power optimisation | Built — deep sleep, sampling intervals, battery curve. **Ships disabled** |
| Documentation | Built — `docs/hardware.md`, `HARDWARE_INTEGRATION_GUIDE.md` |

**BLE is read-only and will stay that way.** It is not a second ingest path. A
GATT characteristic cannot prove a device's identity the way a hashed token
does — pairing proves proximity, not identity — so a "relay to cloud" phone app
built on a writable characteristic would be an unauthenticated write path into
a medical record.

**Deep sleep ships disabled** because a sleeping band is not monitoring anyone.
That trade belongs to a deployment, not to a default.

**The firmware has never run on an ESP32.** Everything above is verified by
compilation, by 67 host-executed logic checks, and by the simulator exercising
the identical server path. None of it is evidence that a MAX30102 on a wrist
produces a usable signal.

---

## Broken or incomplete workflows

Honest list. Nothing here is presented as working.

| Workflow | State | Why |
|---|---|---|
| **Clinician onboarding** | No UI path | `doctors` rows are created out of band with SQL. A patient cannot grant access to a clinician who is not already in the table |
| **Document upload on plain Postgres** | Unavailable | Needs Supabase Storage; the migration is skipped outside a Supabase project, and `setup_database.sh` says so rather than skipping silently |
| **Multi-instance rate limiting** | Silently wrong without Redis | Each instance keeps its own counters, so the effective limit is `N × configured`. Nothing errors |
| **Websocket scaling** | Single instance only | A dashboard socket is pinned to the instance ingesting that patient's readings. No sticky sessions, no shared pub/sub |
| **Emergency follow-up** | Missing | See the escalation ladder above |
| **Password reset** | Not implemented | Supabase supports it; no UI |
| **Account deletion / data export** | Not implemented | A GDPR obligation if deployed in scope |

---

## Technical debt

Ranked by what would hurt first.

1. **No distributed trace id.** Three runtimes, and one reading's journey
   cannot be followed end to end from logs. The largest observability gap.
2. **`'unsafe-inline'` in the CSP `script-src`.** Next.js injects an inline
   bootstrap; removing it needs a per-request nonce from middleware, which
   exists (`proxy.ts`) and is unused for this.
3. **Three copies of the threshold constants** — TypeScript, Python, firmware.
   Justified (the buzzer must work with no network) and bounded (only the
   critical levels are duplicated), but it is still three places.
4. **`sensor_readings` is unpartitioned.** BRIN plus a composite btree carry it
   for now; the column layout is chosen so partitioning later is a migration
   rather than a redesign.
5. **`database.types.ts` is hand-maintained.** `npm run types:gen` needs a
   running local stack; the file has been extended by hand for four phases and
   will drift eventually.
6. **No dependency CVE gate in CI.**
7. **The RLS suites share one database and depend on file order.** One suite's
   teardown is another's fixture — documented where it happens, but fragile.

---

## Security

Full detail in [SECURITY_AUDIT.md](SECURITY_AUDIT.md). Seven findings: four
fixed this pass, three accepted and recorded.

Fixed: no Content-Security-Policy, no HSTS, firmware shipping with TLS
validation disabled, firmware shipping with serial debug on. The last two
matter because `config.example.h` is the file people copy, and nobody reviews
the line they did not have to change.

Accepted with stated mitigations: the caregiver-invite enumeration oracle, the
unauthenticated client-error endpoint, and the ingest service holding a
service-role key.

**Not covered:** no penetration test, no formal HIPAA/GDPR mapping, no key
rotation procedure, no SBOM. AVERIS has an audit trail and an access model —
that is a foundation, not compliance.

---

## Production blockers

Ranked. These are the things that should stop a deployment serving real
patients.

1. **No escalation ladder.** An unacknowledged emergency is dropped silently.
   For a system whose purpose is timely intervention, this is the blocker.
2. **No alerting on the system itself.** The ingest service logs an `error`
   when an escalation fails to notify anyone; nothing watches that log.
3. **Uncalibrated SpO₂ presented as a percentage.** The number is the
   datasheet's generic curve. It is labelled everywhere, and a label is weaker
   than a calibration.
4. **No clinician verification.** Anyone with a `doctors` row can be granted
   access by a patient who types their licence number.
5. **No account deletion or data export.**
6. **Single-instance constraints** (Redis, websockets) not enforced anywhere —
   nothing stops someone scaling to three instances and quietly tripling every
   rate limit.

---

## What this pass changed

| # | Change |
|---|---|
| 1 | Executed 16 migrations and 237 assertions against Postgres 17 for the first time |
| 2 | Fixed two product defects and three vacuous tests that execution exposed |
| 3 | Added error boundaries — the app previously had **none**, so a thrown Server Component produced a bare "Application error" with nothing recorded |
| 4 | Added client-side error reporting, scrubbed twice, with a rate-limited endpoint |
| 5 | Added a loading skeleton — without one, Next shows the *previous* page during navigation, so a clinician moving between patients saw the first patient's vitals under the second patient's name |
| 6 | `scripts/setup_database.sh` — migrations, seeds, schema validation, RLS, one command |
| 7 | `schema_validation.sql` — structural checks that fail on the table nobody remembered to write a test for |
| 8 | `device_auth_verification.sql` — 12 assertions on the device credential model |
| 9 | `run_all_tests.sh` + `TEST_REPORT.md`, where a skipped suite is never reported as passed |
| 10 | Simulator `--mode normal\|warning\|emergency` |
| 11 | Demo mode at `/demo` — a live checklist that seeds nothing |
| 12 | CSP, HSTS, and firmware defaults that validate certificates |
| 13 | `LOGGING_ARCHITECTURE.md`, `SECURITY_AUDIT.md`, `HARDWARE_INTEGRATION_GUIDE.md`, `docs/ai_pipeline.md`, `docs/deployment.md` |

---

## Remaining manual tasks

These cannot be completed by software. Nothing above claims otherwise.

### Requires physical hardware

- **Flash and run the firmware on an ESP32.** It has never executed on a
  microcontroller. Compilation and 67 host-run logic checks are not evidence
  that the I²C bus enumerates or that the OLED initialises.
- **Verify the fall detector on a real fall.** The thresholds
  (0.45 g free fall, 2.6 g impact, 2 s stillness) are reasoned, not measured.
  They need a weighted dummy and a mat.
- **Resolve the dropped-band false positive.** An accelerometer cannot
  distinguish a still wrist from a still table. The MAX30102's skin-contact
  signal is the obvious suppressor and is not wired into the fall path.
- **Measure battery life.** The figures in `docs/hardware.md` are bench
  estimates at ±15%.
- **Confirm I²C stability with four devices** sharing the bus and their
  pull-ups in parallel.

### Requires clinical validation

- **Calibrate SpO₂ against a reference oximeter.** Real calibration is an
  empirical process against arterial blood gas measurements across many
  subjects. Until then the number is an indicator of change, not a value.
- **Establish the skin-to-core temperature offset**, or relabel the thresholds
  as skin temperature. The thresholds upstream were chosen for body
  temperature; that mismatch is real.
- **Clinical review of the alert thresholds.** They are published escalation
  triggers for a resting adult. Age, fitness and pregnancy all move them.

### Requires a production environment

- **Apply migrations to a hosted Supabase project** — `--remote` mode exists
  and has not been run against one.
- **Confirm Realtime is enabled** for `care_notifications`. The migration adds
  it to the publication when the publication exists; that path has only been
  exercised where it does not.
- **Load-test the ingest service.** No fleet has ever connected.
- **Configure Redis** before running more than one web instance.

---

## Exact commands

```bash
# ── Database ───────────────────────────────────────────────────────────────
./scripts/setup_database.sh                 # local (Supabase CLI + Docker)
./scripts/setup_database.sh --psql          # a Postgres you already have
SUPABASE_DB_URL='postgresql://...' \
  ./scripts/setup_database.sh --remote      # a hosted project
./scripts/setup_database.sh --check         # validate only, change nothing
./scripts/verify-remote.sh                  # probe a hosted project with the anon key

# ── Tests ──────────────────────────────────────────────────────────────────
./run_all_tests.sh                          # everything, writes TEST_REPORT.md
./run_all_tests.sh --no-db                  # skip the database suites
firmware/averis-wearable/test/run.sh        # firmware logic, no ESP32 needed
PG_MODE=docker PG_CONTAINER=supabase_db_averis PG_USER=postgres \
  ./supabase/tests/run.sh                   # RLS only

# ── Running it ─────────────────────────────────────────────────────────────
npm run dev                                 # web, :3100
cd iot-service && .venv/bin/uvicorn app.main:app --port 8000
npx tsx scripts/worker.ts                   # document worker

python3 sensor_simulator/simulate.py \
  --token avd_... --device-key AVR001 --mode normal
python3 sensor_simulator/simulate.py \
  --token avd_... --device-key AVR001 --mode emergency --fall-after 5
python3 sensor_simulator/simulate.py \
  --token avd_... --device-key AVR001 --break-sensor imu   # fault injection

NEXT_PUBLIC_DEMO_MODE=true npm run dev      # then /demo

# ── Hardware ───────────────────────────────────────────────────────────────
cd firmware/averis-wearable
cp src/config.example.h src/config.h        # key, token, WiFi, ingest URL
pio run -t upload && pio device monitor
```

---

## Standing statements

**AVERIS does not diagnose.** Enforced by guardrails in code, asserted in
tests, stated in every disclaimer. Every generative feature degrades to
deterministic output rather than to silence, and says which produced what you
are reading.

**The wearable is a prototype.** Uncalibrated SpO₂, uncorrected skin
temperature, a fall detector with a known false positive. None of it is
certified, and no number it produces should decide anything clinical.

**Simulated data is permanently labelled.** Provenance is stamped on the
reading at write time, not joined from the device — so a chart drawn today does
not change meaning because a device was reclassified in June.

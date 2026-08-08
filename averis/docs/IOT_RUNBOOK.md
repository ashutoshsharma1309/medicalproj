# AVERIS IoT — running it end to end

No hardware required. The simulator speaks the same HTTP contract the ESP32
will, so this is the real path, not a mock.

## 1. Apply the migration

Paste `supabase/migrations/20260806090000_iot_phase1_monitoring.sql` into the
Supabase SQL editor (or re-generate `supabase/apply-all.sql`).

## 2. Configure and start the ingest service

```bash
cd averis/iot-service
cp .env.example .env          # fill in SUPABASE_URL and the service-role key
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
set -a && . ./.env && set +a
.venv/bin/uvicorn app.main:app --port 8000
```

The service-role key belongs **only** here. It bypasses RLS, which is why the
ingest path is a separate process from the app that serves patient dashboards.

## 3. Register a device

In the web app: **Devices → Register a device**.

The token is shown once. AVERIS stores a SHA-256 hash, so it cannot be shown
again — losing it means rotating, not recovering.

## 4. Start the simulator

```bash
cd averis
python3 sensor_simulator/simulate.py \
  --token avd_...          \
  --device-key AVR001      \
  --scenario resting
```

Scenarios: `resting` (nothing should alert), `active`, `deteriorating` (drifts
into alert territory, for exercising the alerting path).

## 5. Watch it arrive

**Monitoring** shows the live tiles once the first reading lands. Nothing is
displayed before then — no placeholder values.

---

## Verifying the security properties

```bash
# 28 IoT assertions, plus every prior phase
PG_CONTAINER=supabase_db_averis PG_USER=postgres ./supabase/tests/run.sh

# Both validators against one set of vectors
npx tsx --test "lib/iot/__tests__/iot.test.ts"
iot-service/.venv/bin/python -m pytest iot-service/tests -q
```

Worth trying by hand, because it is the property everything else rests on:

```bash
# Send AVR002's key using AVR001's token → 403, not a cross-write
curl -X POST localhost:8000/api/device/data \
  -H "Authorization: Bearer <AVR001 token>" \
  -H "Content-Type: application/json" \
  -d '{"device_id":"AVR002","heart_rate":80}'
```

---

## When the ESP32 arrives

Replace the simulator process. Nothing else changes.

The firmware needs to: hold its token in NVS, POST the same JSON to
`/api/device/data` with `Authorization: Bearer <token>`, and stamp
`recorded_at` if it has an RTC (buffered readings then keep their real times
through a network outage).

MQTT and BLE are deliberately not built. The device-transport boundary is HTTP
today; adding a broker means another producer calling the same ingest path, not
a redesign.

---

## 7. Seeing the care team work

Everything below needs the Phase 4 migrations applied
(`20260808090000` through `20260808095000`, or a regenerated
`supabase/apply-all.sql`).

### Create a clinician

There is no clinician sign-up flow — a `doctors` row is created out of band, on
purpose, because self-registering as a doctor is not a thing this platform
should let anyone do. Sign the account up normally, then:

```sql
insert into public.doctors (user_id, full_name, license_number, specialization, hospital_name)
select id, 'Dr Meera Iyer', 'MED-99117', 'Internal medicine', 'City General'
from public.users where email = 'doctor@example.com';
```

`verified_at` stays null and the UI says the licence is unverified. Nothing in
AVERIS sets it, so a verification badge would be a claim nobody checked.

### Grant access as the patient

Sign in as the patient → **Care team**.

- **Doctors** are added by exact licence number. The lookup shows the name and
  hospital before the grant, because consenting to a string is not consent.
- **Caregivers** are added by the email address they signed up with, at one of
  three levels. `VIEW_ALERTS` is the default: emergencies only, no measurements.

### Trigger an emergency

```bash
cd averis
python3 sensor_simulator/simulate.py \
  --token avd_... --device-key AVR001 --scenario hypoxia
```

A reading below the 90% SpO2 escalation threshold raises a `SEVERE_HYPOXIA`
alert, escalates it once, and writes a notice to every active care team member
in the same transaction.

Watch it land: the clinician's **Clinical** page shows the notice within about a
second over Postgres realtime, and re-reads every 60 seconds regardless. To
prove the poll works, block the websocket in devtools — the notice still
appears, just later.

Repeat readings below the threshold raise **no** further emergencies while the
first is open. That is the partial unique index, not a bug.

### Respond

Open the patient from the caseload → acknowledge → start response → resolve
with a note. The database refuses a resolution with nobody named, so
"resolved by nobody" is not a state the workflow can reach.

Dismissing the notification does not close the emergency. They are different
claims and are deliberately not wired together.

### Summaries and the assistant

Both work with no `GROQ_API_KEY` configured — the deterministic narration is
the fallback, and it says which one you are reading. To check the guardrail,
run without a key and confirm the summary still reports real numbers.

Voice needs a Chromium-based browser; Firefox has no Web Speech API and the
button is not rendered at all rather than rendered dead.

---

## 8. Running with real hardware

Full wiring, pin map and bring-up: **[HARDWARE.md](HARDWARE.md)**.

The short version — and the point of this section is that it is short:

```bash
cd averis/firmware/averis-wearable
cp src/config.example.h src/config.h    # key, token, WiFi, ingest URL
pio run -t upload
```

Nothing else changes. The band posts to `/api/device/upload`, the ingest
service authenticates it against the same hashed token the simulator uses, and
the readings flow through the same pipeline into the same dashboards. Sections
1–7 above still apply verbatim; the only difference is which process is sending.

### Both inputs at once

A simulator and a band can run side by side against the same backend. They need
**different device registrations** — one key and one token each — because a
shared identity would merge two sources into one patient's chart.

Register the simulator with "This is a simulator" ticked. Its readings are then
stamped `is_simulated` on every row, and the hardware page shows the badge. A
simulated device pointed at a registration that was not marked as one produces
data nothing can distinguish from measurements afterwards, which is the failure
this flag exists to prevent.

### Exercising the failure paths without a soldering iron

```bash
# A sensor that has broken — raises a SENSOR_FAULT device event
python3 sensor_simulator/simulate.py --token avd_... --device-key AVR001 \
  --break-sensor imu

# A minimal third-party device that sends no telemetry at all
python3 sensor_simulator/simulate.py --token avd_... --device-key AVR001 \
  --no-telemetry
```

Both should leave the readings flowing. That is the property under test: bad or
absent telemetry never costs a measurement.

# AVERIS — ESP32 integration guide

Getting a wearable from a bag of components to a reading on a clinician's
screen. Follow it top to bottom; each step ends in something observable.

Reference tables — full pin map, BLE UUIDs, power measurements, accuracy limits
— are in **[docs/hardware.md](docs/hardware.md)**. This document is the
procedure.

> **Prototype, not a medical device.** Nothing here is calibrated against a
> reference instrument or certified for clinical use. Read the accuracy section
> of `docs/hardware.md` before anyone draws a conclusion from a number.

---

## 0. Before you start

You need, in this order:

1. **A database.** `./scripts/setup_database.sh` — one command, and it
   validates the schema afterwards.
2. **The ingest service running**, because that is what the band talks to.
3. **A registered device**, because that is where the token comes from.

A band cannot be brought up without those three. Doing them first turns
"nothing works" into a specific failure at a specific step.

---

## 1. Components

| Part | Role | Bus | Address |
|---|---|---|---|
| ESP32-WROOM-32 | MCU, WiFi, BLE | — | — |
| MAX30102 | Heart rate, SpO₂ | I²C | `0x57` |
| MLX90614 | Skin temperature | I²C | `0x5A` |
| MPU6050 | Motion, falls | I²C | `0x68` |
| SSD1306 128×64 OLED | Live vitals | I²C | `0x3C` |
| Passive buzzer | Local alert | GPIO 25 | — |
| Tactile button | "I'm fine" | GPIO 26 | — |
| 3.7 V LiPo + TP4056 | Power | — | — |
| 2 × 100 kΩ | Battery divider | GPIO 34 | — |

All four I²C parts share one bus — the addresses are distinct, so they can.

---

## 2. Wiring

```
GPIO21 ── SDA ──┬── MAX30102 ── MLX90614 ── MPU6050 ── SSD1306
GPIO22 ── SCL ──┘   (all four in parallel)

GPIO25 ─────────── Buzzer (+)              GND ── Buzzer (−)
GPIO26 ─────────── Button ── GND           (INPUT_PULLUP)
GPIO34 ─────────── Battery divider midpoint

3V3    ─────────── VIN on all four I²C boards
GND    ─────────── common
```

**Battery divider** — GPIO34 is ADC1 and input-only. Use it, not an ADC2 pin:
ADC2 stops working the moment WiFi is active, and a battery reading that dies
silently with the radio is a fault that takes a day to find.

```
BAT+ ──[100k]──┬──[100k]── GND
               │
             GPIO34            4.2 V cell → 2.1 V at the pin
```

**Pull-ups.** Most breakouts carry their own 4.7 kΩ I²C pull-ups. Four in
parallel is about 1.2 kΩ, at the edge of what the ESP32 drives at 400 kHz. If
the bus is flaky, remove the pull-ups from all but one board — do not lower the
clock, which hides the problem instead of fixing it.

---

## 3. Libraries

Pinned in `firmware/averis-wearable/platformio.ini`; PlatformIO fetches them.

| Library | Version | For |
|---|---|---|
| `sparkfun/SparkFun MAX3010x` | 1.1.2 | MAX30102 |
| `adafruit/Adafruit MLX90614` | 2.1.5 | MLX90614 |
| `adafruit/Adafruit MPU6050` | 2.2.6 | MPU6050 |
| `adafruit/Adafruit Unified Sensor` | 1.1.14 | MPU6050 dependency |
| `adafruit/Adafruit SSD1306` | 2.5.13 | OLED |
| `adafruit/Adafruit GFX Library` | 1.11.11 | OLED dependency |

Versions are pinned, not floating. A wearable that builds differently on two
machines is one whose field behaviour cannot be traced to a commit, and "it
worked on the bench" is not a defensible answer about something a patient wore.

---

## 4. Register the device

In AVERIS: **Devices → Register a device**.

- Leave **"This is a simulator"** unticked for real hardware.
- Note the **device key** (e.g. `AVR001`) — the firmware announces it in every
  payload and the server refuses a mismatch.
- Copy the **token**. It is shown once. AVERIS stores only a SHA-256 hash, so
  losing it means rotating, not recovering.

**One band, one key, one token.** Cloning a config across a fleet means one
revocation kills every band, and two bands writing under one identity produce a
single patient's chart containing two people's vital signs — which nothing on
the dashboard would reveal.

---

## 5. Configure and flash

```bash
cd averis/firmware/averis-wearable
cp src/config.example.h src/config.h
```

Edit `src/config.h`:

```c
#define AVERIS_DEVICE_KEY    "AVR001"
#define AVERIS_DEVICE_TOKEN  "avd_..."          // shown once at registration
#define AVERIS_WIFI_SSID     "your-network"
#define AVERIS_WIFI_PASSWORD "your-password"
#define AVERIS_INGEST_URL    "http://192.168.1.50:8000/api/device/upload"
#define AVERIS_HELLO_URL     "http://192.168.1.50:8000/api/device/hello"
```

Use your machine's **LAN address**, not `localhost` — the band is not on your
machine. `config.h` is gitignored because it holds a credential.

```bash
pio run -t upload && pio device monitor
```

---

## 6. What you should see

On the OLED, in order:

```
Starting → Self-test → HR+ T+ M+ → WiFi → Verified
```

A `-` in the self-test line means that sensor did not answer on I²C. **The band
carries on without it** — a device that refused to boot without a thermometer
would stop watching a heart because a temperature sensor came loose. The
hardware page will name which one.

Then the vitals screen. `--` means the channel has nothing trustworthy to
report; it is never a stale value and never a plausible placeholder.

In AVERIS, within a few seconds: **Devices → Hardware status** shows online, a
signal figure, and three healthy sensors.

---

## 7. The API

Two endpoints. Both authenticate with `Authorization: Bearer <device token>`.

### `POST /api/device/hello` — at boot

```json
{ "device_id": "AVR001", "firmware": "1.0.0", "hardware": "esp32" }
```

```json
{ "status": "ok", "verified": true, "device_name": "Wrist band",
  "server_time": 1786581000, "uplink_interval_ms": 2000 }
```

Three jobs: the band learns its token is accepted *before* streaming (so the
OLED says "Verified" while someone is still holding it), it collects server
time (an ESP32 has no RTC across a power cycle, and unstamped readings would
sort before everything the patient has ever produced), and it receives its
cadence (so a ward can be slowed down without reflashing bands on wrists).

The response says nothing about the patient. A device credential identifies a
device; answering with a name would make it a key to somebody's record.

### `POST /api/device/upload` — every reading

`POST /api/device/data` is the same handler under its original name. Both are
kept: a band already in the field cannot be told to use a new URL.

```json
{
  "device_id": "AVR001",
  "heart_rate": 82,
  "spo2": 97,
  "temperature": 36.8,
  "movement": "ACTIVE",
  "battery": 85,
  "recorded_at": "2026-08-09T10:30:00Z",
  "telemetry": {
    "rssi": -57, "uptime_s": 3600, "boot_count": 4,
    "firmware": "1.0.0", "transport": "wifi", "buffered": 0,
    "sensors": { "pulse": "ok", "thermometer": "ok", "imu": "ok" }
  }
}
```

**Two rules the format enforces:**

*No `patient_id`.* Ownership is read from the authenticated device row. A
patient id on the wire is either redundant or an attempt to write into someone
else's chart, and there is no code path in the firmware that could carry one.

*Missing values are omitted, never zeroed.* A sensor with nothing trustworthy
to say contributes no key; the server stores NULL and the chart draws a gap.
`"heart_rate": 0` would be stored as a measurement of zero that nothing
downstream could tell from a flatline.

| Status | Meaning | What the firmware does |
|---|---|---|
| `201` | Stored | Continues |
| `401` / `403` | Token rejected, or key mismatch | **Stops transmitting.** Keeps alerting locally |
| `422` | Payload invalid | Drops that reading, continues |
| `429` | Rate limited | Backs off, buffers |
| `5xx` / network | Transient | Backs off exponentially to 30 s, buffers |

Buffered readings replay with their **original timestamps**, so a patient who
walked into a basement returns with history rather than a hole.

---

## 8. Debugging

| Symptom | Cause |
|---|---|
| `No sensors / Check I2C wiring` | SDA/SCL swapped, or 3V3 not connected |
| One sensor shows `-` | That address is not answering — check its solder joints |
| `Not verified` after WiFi | Token wrong, or device key ≠ registration |
| Online, chart has holes | Signal. Past −80 dBm uplinks drop; check the hardware page |
| `clock ahead` on latency | Band's clock is ahead of the server's; re-syncs at next boot |
| Reboots repeatedly | Almost always power — a LiPo that cannot supply the WiFi transmit burst browns out the regulator |
| Vitals show `--` while worn | Not skin contact. The MAX30102 needs to be snug |

**Where to look, in order:**

1. `pio device monitor` — the band's own view. Set `AVERIS_SERIAL_DEBUG 1`
   while bringing it up, and **back to 0 before it goes on a wrist**: a debug
   UART printing every reading is a vital-sign stream out of a port.
2. `/devices/<KEY>/diagnostics` — raw stored rows with nulls shown as `null`,
   the device event log, and latency.
3. The ingest service's stdout — device key mismatches and escalation failures
   are logged there.

### Verify the path without hardware

If a band will not talk, prove the rest of the chain works first:

```bash
python3 sensor_simulator/simulate.py \
  --token avd_YOUR_TOKEN --device-key AVR001 --mode normal --count 5
```

Same endpoint, same JSON, same authentication. If that succeeds and the band
does not, the problem is on the band.

---

## 9. Firmware logic tests

```bash
firmware/averis-wearable/test/run.sh      # 67 checks, no ESP32 required
```

Filtering, fall detection, payload encoding and the battery curve are in
Arduino-free headers so they compile with any C++17 compiler and run in CI.

They do **not** cover I²C, WiFi or BLE — mocking a MAX30102 would test the
mock. Those are exercised on hardware, which is what section 6 is.

---

## 10. Before a band goes on a person

- [ ] `AVERIS_SERIAL_DEBUG 0`
- [ ] `AVERIS_TLS_INSECURE 0` and an `https://` ingest URL
- [ ] Its own device key and its own token — not a copy
- [ ] Self-test shows all three sensors
- [ ] A reading visible in `/devices/hardware` within 10 seconds
- [ ] Buzzer audible through the enclosure
- [ ] Battery percentage plausible against a multimeter reading of the cell
- [ ] The wearer knows the button silences a fall alert locally and does
      **not** tell the care team they are fine

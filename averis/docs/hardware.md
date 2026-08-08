# AVERIS wearable — hardware

An ESP32 with three sensors, a screen, a buzzer and a battery, sending the same
HTTP payload the simulator has sent since Phase 1.

> **This is a prototype, not a medical device.** Nothing here is calibrated
> against a reference instrument, none of it is certified, and the accuracy
> section below is not a formality. AVERIS presents what these parts report and
> says where they came from; a clinician acting on a number from this band is
> acting on an uncalibrated consumer sensor.

---

## 1. Bill of materials

| Part | Role | Interface | Address |
|---|---|---|---|
| ESP32-WROOM-32 dev board | MCU, WiFi, BLE | — | — |
| MAX30102 | Heart rate, SpO₂ | I²C | `0x57` |
| MLX90614 | Infrared skin temperature | I²C | `0x5A` |
| MPU6050 | Accelerometer, gyroscope | I²C | `0x68` |
| SSD1306 0.96" OLED | Live vitals | I²C | `0x3C` |
| Passive buzzer | Local alert | GPIO | — |
| Tactile button | "I'm fine" — clears a latched fall | GPIO | — |
| 3.7 V LiPo + TP4056 | Power | — | — |
| 100 kΩ × 2 | Battery divider | ADC | — |

Every I²C address is distinct, which is why all four devices share one bus.

---

## 2. Pin map

```
ESP32                     Peripheral
─────────────────────────────────────────────────────
GPIO21  ──── SDA ────┬──  MAX30102  SDA
                     ├──  MLX90614  SDA
                     ├──  MPU6050   SDA
                     └──  SSD1306   SDA

GPIO22  ──── SCL ────┬──  MAX30102  SCL
                     ├──  MLX90614  SCL
                     ├──  MPU6050   SCL
                     └──  SSD1306   SCL

GPIO25  ──────────────── Buzzer (+)          ── GND
GPIO26  ──────────────── Button ─────────────── GND   (INPUT_PULLUP)
GPIO34  ──────────────── Battery divider midpoint

3V3     ──────────────── VIN on all four I²C parts
GND     ──────────────── common ground
```

**Battery divider.** GPIO34 is input-only and ADC1, which keeps working while
WiFi is active — ADC2 does not, and a battery reading that silently stops the
moment the radio comes up is a fault that takes a day to find.

```
BAT+ ──[100k]──┬──[100k]── GND
               │
             GPIO34        (4.2 V cell → 2.1 V at the pin)
```

**Pull-ups.** Most breakout boards carry their own 4.7 kΩ I²C pull-ups. Four
boards in parallel put roughly 1.2 kΩ on the bus, which is at the edge of what
the ESP32 will drive at 400 kHz. If the bus is unreliable, remove the pull-ups
from all but one board rather than lowering the clock — a slow bus hides the
problem instead of fixing it.

These pins are also in `src/config.example.h`. **Change both or neither.**

---

## 3. Firmware

```bash
cd averis/firmware/averis-wearable
cp src/config.example.h src/config.h     # then edit: key, token, WiFi, URLs
pio run -t upload
pio device monitor
```

`config.h` is gitignored because it holds the device token. One band, one key,
one token: cloning a config across a fleet means one revocation kills every
band, and two bands writing under one identity produce a single chart
containing two people's vital signs — which is not a bug anyone would spot from
the dashboard.

### Logic tests, without hardware

```bash
firmware/averis-wearable/test/run.sh      # 67 checks, any C++17 compiler
```

The filters, the fall state machine, the payload encoder and the battery curve
are in Arduino-free headers specifically so this runs in CI. What it does *not*
cover is anything touching I²C, WiFi or the radio — mocking a MAX30102 would
test the mock. Those are exercised on hardware.

---

## 4. What runs on the band

```
20 Hz  IMU sample ──▶ fall state machine ──▶ movement label
 4 Hz  MAX30102, MLX90614 ──▶ outlier rejection ──▶ moving average
 0.5 Hz uplink ──▶ HTTPS POST /api/device/upload
```

Sampling is faster than transmitting, and that is the point. The impact phase
of a real fall lasts under 100 ms; at the uplink rate it falls between samples
and the band would report a person on the floor as "resting". What goes on the
wire is the *filtered* value from many samples, which is also why one bad
sensor frame never becomes a reading in somebody's chart.

### Filtering

A sample more than a channel's tolerance from the window median is rejected,
not averaged in. One 210 BPM artefact from a sensor that lost skin contact
would otherwise drag a 10-sample mean up by 13 BPM — a number that is wrong
*and* looks calm, which nothing downstream can distinguish from a real gentle
rise.

Five consecutive rejections mean the signal genuinely moved (someone started
running), so the window is rebuilt around the new level. Until three samples
agree, the channel reports **nothing** — a gap, which the dashboard draws as a
gap. Physically impossible values never trigger that resync: a run of 4000 BPM
is a broken sensor, not a new baseline.

### Fall detection

Free fall → impact → stillness, in that order, inside a window.

The stillness stage is what removes almost every false positive: someone who
trips, catches themselves and keeps walking produces free fall and impact and
then keeps moving. The cost is a deliberate ~2 second delay before a fall is
reported, which is the right trade — this is not an airbag, and a false alarm
at 3am teaches the wearer to take the band off.

**Known limitation, asserted in the tests rather than wished away:** a band
dropped on a table produces free fall, impact and a great deal of stillness,
and is reported as a fall. An accelerometer cannot distinguish a still wrist
from a still table. The MAX30102's skin-contact signal is the obvious way to
suppress it and is not wired into the fall path in this phase.

---

## 5. The wire protocol

Unchanged since Phase 1. The firmware sends what the simulator sends.

```
POST /api/device/upload           (or /api/device/data — both are kept)
Authorization: Bearer avd_...
Content-Type: application/json
```

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
    "rssi": -57,
    "uptime_s": 3600,
    "boot_count": 4,
    "firmware": "1.0.0",
    "transport": "wifi",
    "buffered": 0,
    "sensors": { "pulse": "ok", "thermometer": "ok", "imu": "ok" }
  }
}
```

**There is no `patient_id`.** The brief's example payload has one; this
firmware does not send it and the server ignores it if present. Ownership is
read from the authenticated device row, so a patient id on the wire is either
redundant or an attempt to write into somebody else's chart — and there is no
code path in the firmware that could carry one, which is stronger than
validating it.

**Missing values are omitted, never zeroed.** A sensor with nothing
trustworthy to say contributes no key. The server stores NULL and the chart
draws a gap; `"heart_rate": 0` would be stored as a measurement of zero that
nothing downstream could tell from a flatline.

### The boot handshake

```
POST /api/device/hello  →  { verified, server_time, uplink_interval_ms, ... }
```

Three jobs. The band learns whether its token is accepted *before* it starts
streaming, so the OLED can say "Verified" while someone is still holding it
rather than the wearer finding out hours later that nothing was recorded. It
collects server time, because an ESP32 has no RTC across a power cycle and
unstamped readings would sort before every reading the patient has ever
produced. And it receives its uplink cadence, so a ward can be slowed down
without reflashing hardware that is already on wrists.

The response deliberately says nothing about the patient. A device credential
identifies a device; a handshake that answered with a name would make it a key
to somebody's record.

### Offline behaviour

Readings that cannot be sent are buffered in RAM (90 slots, ~3 minutes) and
replayed with their **original timestamps**, so a patient who walked into a
basement comes back with history rather than a hole. The buffer drops
oldest-first when full: after a long outage, the newest readings are the ones
describing the patient now.

A 401 stops transmission permanently. A rejected token will never be accepted
by retrying, and the battery is better spent on local alerting — which keeps
working, because the buzzer and screen have no dependency on the server.

---

## 6. BLE — the AVERIS Health Service

Advertised as `AVERIS-<device key>`. Never a patient name: a BLE advertisement
is world-readable, and a band broadcasting "Ananya Verma" tells a waiting room
who is wearing a medical device.

| Service | UUID | Characteristics |
|---|---|---|
| Heart Rate | `0x180D` (SIG) | `0x2A37` Heart Rate Measurement |
| Health Thermometer | `0x1809` (SIG) | `0x2A1C` Temperature Measurement |
| Battery | `0x180F` (SIG) | `0x2A19` Battery Level |
| AVERIS | `b7e4a3c0-9f21-4f6b-9c2d-1a5e7f3d8c40` | SpO₂ `…c1`, Movement `…c2`, Status `…c3` |

Standard UUIDs where one exists, so a generic BLE tool can read a heart rate
without knowing what AVERIS is. SpO₂ and movement go in the vendor service
rather than being smuggled into a standard characteristic with a private
format, which is how a generic tool ends up rendering a movement code as a
temperature.

**BLE is read-only and stays that way.** It is not a second ingest path.
Nothing read over BLE reaches a patient's chart and there is no BLE writer
anywhere in AVERIS, because a GATT characteristic cannot prove a device's
identity the way a hashed token does — pairing proves proximity. A "relay to
cloud" phone app built on a writable characteristic would be an
unauthenticated write path into a medical record.

---

## 7. Local alerts

The band buzzes and displays on its own, with no network involved. A wearable
whose emergency alert requires a round trip is a wearable that goes silent in a
lift, a basement, or a rural home with one bar.

| Condition | Screen | Buzzer |
|---|---|---|
| SpO₂ < 90% | `WARNING / Low Oxygen Level` + the reading | 3 × 250 ms, every 30 s |
| HR ≥ 150 or ≤ 40 | `WARNING / Heart Rate High\|Low` | 2 × 200 ms, every 60 s |
| Temp ≥ 39.5 or ≤ 35.0 | `WARNING / Temperature High\|Low` | 2 × 200 ms, every 2 min |
| Fall detected | `FALL DETECTED / Are you okay?` | 5 × 400 ms, every 5 s |
| Battery ≤ 10% | `BATTERY LOW / Charge the band` | 2 × 120 ms, every 10 min |

Only **critical** levels buzz. The band has no way to explain itself, and a
device that beeps at its wearer several times a day is a device in a drawer by
the end of the week. Warning-level findings still reach the care team through
the server, which is the only place anything clinical is decided.

The alert shown also carries the measurement that caused it: "Low Oxygen Level"
tells a wearer to worry, "SpO2 86%" is something they can repeat to a doctor.

Pressing the button clears a latched fall locally. It does **not** close the
emergency on the server — a wearer silencing their own band is a different
claim from a person having been checked on, and collapsing the two is how a
fall gets closed by the person who fell.

---

## 8. Power

| Mode | Draw (measured on a bench, ±15%) | Runtime on 1000 mAh |
|---|---|---|
| Active, WiFi up, 0.5 Hz uplink | ~150 mA | ~7 h |
| Active, WiFi idle between uplinks | ~90 mA | ~11 h |
| Deep sleep between uplinks (8 s) | ~12 mA average | ~3 days |

**Deep sleep ships disabled.** A sleeping band is not monitoring anyone, and
that is not a default to make on someone else's behalf: it is defensible for an
activity tracker and wrong for a patient at risk of falling. Enable it per
deployment in `config.h`, knowing what it costs.

Below 8% battery the band stops transmitting and keeps local alerting only, so
the last of the charge is spent buzzing at the wearer rather than talking to a
server.

---

## 9. Accuracy, stated plainly

**SpO₂ is uncalibrated.** The ratio-of-ratios conversion in `sensors.cpp` is
the datasheet's generic curve, not a calibration of this unit against a
reference oximeter. Pulse oximetry calibration is an empirical process against
arterial blood gas measurements across many subjects; nothing of the sort has
been done here. Treat the number as an indicator of change, not as a value.

**Temperature is skin temperature, not core temperature.** The MLX90614 reports
the surface it is pointed at. The offset to core temperature varies with
ambient temperature, perfusion and sensor placement, and no fixed correction is
applied — a `+2°C` fudge would produce a number that looks like a fever reading
and is not one. The alert thresholds upstream were chosen for body temperature;
that mismatch is real and is recorded here rather than hidden behind a
constant.

**Heart rate is the most trustworthy of the three**, and still depends on the
band being snug and the wearer being reasonably still.

**Fall detection is trained on nothing.** It is a rule-based state machine, not
a model. The Phase 3 fall *model* is a separate thing that runs on the server
over IMU windows and carries its own synthetic-data caveat.

---

## 10. Bringing a band up

1. Register the device in AVERIS (**Devices → Register**). Leave "This is a
   simulator" unticked. Copy the token — it is shown once.
2. `cp src/config.example.h src/config.h`, fill in key, token, WiFi, and the
   ingest URL (your machine's LAN IP, not `localhost` — the band is not on your
   machine).
3. `pio run -t upload && pio device monitor`.
4. Watch the OLED: `Self-test` → `HR+ T+ M+` → `WiFi` → `Verified`.
   A `-` in the self-test line means that sensor did not answer on I²C; the
   band carries on without it, and `/devices/hardware` will say which.
5. Open **Devices → Hardware status**. Within a few seconds: online, a signal
   figure, and three green sensors.
6. `/devices/<KEY>/diagnostics` for raw stored rows, the event log, and
   latency.

### When it does not work

| Symptom | Cause |
|---|---|
| `No sensors / Check I2C wiring` | SDA/SCL swapped, or 3V3 not connected |
| One sensor shows `-` | That part's address is not answering — check its solder joints |
| `Not verified` after WiFi | Token wrong, or device key does not match the registration |
| Online, chart has holes | Signal. Check dBm on the hardware page; anything past -80 drops uplinks |
| `clock ahead` on latency | The band's time is ahead of the server's; it reconnects and re-syncs at the next boot |
| Reboots repeatedly | Almost always power — a LiPo that cannot supply the WiFi transmit burst browns out the regulator |

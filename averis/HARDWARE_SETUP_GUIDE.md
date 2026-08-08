# AVERIS wearable — hardware setup guide

Building a band from parts and getting it reporting to the platform.

**This document does not repeat the pin map or the API.** Those live in
[docs/hardware.md](docs/hardware.md) and
[HARDWARE_INTEGRATION_GUIDE.md](HARDWARE_INTEGRATION_GUIDE.md), and a second
copy of a pin map is a copy that will eventually disagree with the first — at
which point somebody wires a board from the wrong one and spends an evening on
an I²C bus that was never going to work. What is here is what those two do not
cover: the **power path**, the **order to build it in**, and a **decision tree
for when it does not work**.

Where a number appears in both places it is marked as canonical elsewhere.

---

## 1. What you are building

```
                    ┌──────────────────────────────────┐
                    │        AVERIS wearable           │
                    └──────────────────────────────────┘

    ┌─────────┐   JST    ┌──────────┐        ┌──────────────┐
    │  LiPo   ├──────────┤  TP4056  ├────────┤ slide switch │
    │ 3.7V    │          │ + DW01   │        │   (BAT+)     │
    │ 500 mAh │          │protection│        └──────┬───────┘
    └────┬────┘          └────┬─────┘               │
         │                    │ USB-C in            │
         │                    │ (charge only)       │
         │                                          ▼
         │                                   ┌─────────────┐
         │              ┌────────────────────┤   ESP32     │
         │              │  3V3 rail          │  DevKit v1  │
         │              │                    └──────┬──────┘
         │              │                           │ GPIO34
         │              ▼                           │
         │      ┌───────────────┐                   │
         │      │ I²C bus       │            ┌──────┴──────┐
         │      │ GPIO21 / 22   │            │  100k/100k  │
         │      ├───────────────┤            │   divider   │
         │      │ MAX30102 0x57 │            └──────┬──────┘
         │      │ MLX90614 0x5A │                   │
         │      │ MPU6050  0x68 │                   └────── BAT+
         │      │ SSD1306  0x3C │
         │      └───────────────┘
         │
         └────────────────────────────────── common GND
                                                    │
                              GPIO25 ── buzzer ─────┤
                              GPIO26 ── button ─────┘
```

Pin assignments are canonical in [docs/hardware.md §2](docs/hardware.md) and in
`firmware/averis-wearable/src/config.example.h`. **Change both or neither.**

### The power path, which is the part that is not in the other documents

Three things here are easy to get wrong and unpleasant to diagnose:

**The switch goes between the protection board and the ESP32, not between the
cell and the charger.** Putting it on the cell side means the band cannot charge
while switched off, and — worse — the TP4056 sees an open circuit and its
charge-complete indication becomes meaningless.

**Feed the ESP32's 5V/VIN pin, not 3V3, if your board has an onboard
regulator.** A 3.7 V cell into VIN is fine; a 3.7 V cell into the 3V3 pin
bypasses the regulator and puts 3.7 V onto a 3.3 V rail that the sensors share.
The MLX90614 is rated to 3.6 V absolute maximum.

**The divider is 100 kΩ/100 kΩ and it is always draining.** Two 100 kΩ resistors
across a 4.2 V cell draw 21 µA continuously, which is about 0.5 mAh a day —
negligible against a 500 mAh cell, and the reason not to use 10 kΩ, which would
draw 210 µA and cost 5 mAh a day doing nothing but measuring itself.

### Bill of materials

In [docs/hardware.md §1](docs/hardware.md). One addition worth stating: buy the
**MAX30102** and not the MAX30100. They look identical in listings, the pinouts
differ, and the MAX30100's I²C implementation has a well-known errata that the
common libraries work around inconsistently.

---

## 2. Build it in this order

The instinct is to wire everything and flash once. Resist it. Four I²C devices
on one bus fail as a group, and a bus that does not enumerate tells you nothing
about which board is holding SDA low.

Each stage below ends in something observable. Do not proceed past a stage that
does not.

### Stage 1 — the ESP32 alone

Flash the blink example. You are checking the board, the cable (many USB cables
are charge-only), and the driver.

> **Observable:** the onboard LED blinks.

### Stage 2 — power

Wire the cell, protection board and switch. Do not connect the sensors.

> **Observable:** the board runs from the cell with USB unplugged, and charges
> with USB in and the switch off.

Measure the 3V3 rail before going further. Anything below 3.2 V under load means
the regulator or the cell is marginal, and every symptom after this point will
be blamed on the sensors.

### Stage 3 — one I²C device

Connect **only** the SSD1306 and run an I²C scanner. The display first because
it is the most forgiving and because it gives you an output device for
everything after it.

> **Observable:** the scanner reports `0x3C`.

### Stage 4 — the rest of the bus, one at a time

Add each of MAX30102 (`0x57`), MLX90614 (`0x5A`), MPU6050 (`0x68`), rescanning
after each. Adding them together means a bus failure has four possible causes.

> **Observable:** the scanner reports all four addresses.

If addresses start disappearing as you add boards, read the pull-up note in
[docs/hardware.md §2](docs/hardware.md) — four breakouts in parallel put roughly
1.2 kΩ on the bus, which is at the edge of what the ESP32 will drive.

### Stage 5 — self-test firmware

Build with the self-test flag. It exercises each sensor and prints what it
found, without needing WiFi or a token.

> **Observable:** every sensor reports a plausible value, and the OLED shows the
> boot screen.

### Stage 6 — register the device and flash for real

Registration and configuration are in
[HARDWARE_INTEGRATION_GUIDE.md §4–5](HARDWARE_INTEGRATION_GUIDE.md). The token is
shown once.

> **Observable:** readings appear on `/monitoring` within a few seconds.

### Stage 7 — validate

Two halves, and they are different kinds of work:

```bash
# The transport half — measured, automatically.
python3 scripts/hardware-validation/transport_validation.py \
    --url https://your-ingest-host --token avd_...
```

The sensor half needs a person and a reference instrument:
[docs/hardware_validation.md](docs/hardware_validation.md).

---

## 3. When it does not work

Work down this tree. Each branch ends in a specific thing to change, because
"check your wiring" is not a diagnosis.

### Nothing on the serial monitor

```
Does the onboard LED do anything at boot?
├─ no  → USB cable (try another — many are charge-only), then the board
└─ yes → baud rate is 115200, and the port is the one that appears and
         disappears when you unplug the board
```

### The board boots, then reboots, repeatedly

Almost always power. The ESP32 draws a current spike when the radio comes up
that a marginal supply cannot meet.

```
Does it boot cleanly on USB with the cell disconnected?
├─ yes → the cell, the protection board, or the switch contact
└─ no  → a sensor is loading the 3V3 rail. Disconnect all four and retry;
         add them back one at a time (this is stage 4 again, and it is
         why stage 4 exists)
```

Brownout messages in the serial log confirm it. So does a band that only
reboots when it tries to transmit.

### The I²C scanner finds nothing

```
Are SDA and SCL swapped?
├─ possibly → GPIO21 is SDA, GPIO22 is SCL. This is the single most
│             common wiring error and costs an hour every time
└─ no       → is GND common between the ESP32 and every board? A sensor
              powered from 3V3 with its ground on the other side of a
              breadboard rail is a sensor that does not exist
```

### The scanner finds some devices but not others

```
Do they appear when connected alone?
├─ yes → bus loading. Remove the pull-up resistors from all but one
│        board. Do NOT lower the I²C clock — a slower bus hides the
│        problem and it comes back as intermittent dropouts later
└─ no  → that board is faulty or is a different part than advertised
         (see the MAX30100 note in §1)
```

### Heart rate reads zero or jumps wildly

This is usually not a fault.

```
Is the finger covering both the LED and the photodiode?
├─ no  → reposition. The MAX30102's window is small and partial
│        coverage produces exactly this
└─ yes → is there ambient light reaching the sensor? Direct sunlight
         and overhead LED panels both swamp it. Shield it
```

The firmware's outlier filter will reject implausible values rather than send
them, so the dashboard shows a gap rather than a wrong number. A gap here is the
system working. See [docs/hardware.md §4](docs/hardware.md).

### Temperature reads several degrees low

Expected, and not a fault. The MLX90614 measures **skin**, which runs 1–2 °C
below core temperature and tracks ambient. If you are comparing against an oral
thermometer you should expect a consistent negative offset — that is what the
calibration workflow is for, and the protocol says so before you start.

A reading that is *inconsistent* is a fault. A reading that is consistently low
is physics.

### It reports for a while, then stops

```
Does the OLED still show readings?
├─ yes → the link, not the sensors. Check the buffered count on the
│        device screen — if it is climbing, the band is measuring and
│        cannot deliver, and readings are being kept
└─ no  → check the battery. Below the low-power threshold the band
         deliberately stops transmitting and keeps local alerting only,
         so the last of the charge buzzes at the wearer rather than
         talking to a server
```

A rejected token never recovers by retrying, and the band stops rather than
looping. That is deliberate — see `net.h`.

### Readings arrive, but far fewer than expected

Probably correct behaviour. The band suppresses readings that would tell the
server nothing new — see `firmware/averis-wearable/src/edge_policy.h`. A resting
patient legitimately produces very few transmissions, bounded by a two-minute
heartbeat.

The serial log prints the suppression rate. If it reads near 0% on a still
wrist, the sensor is noisier than expected, which is a hardware finding.

---

## 4. Where everything else is

| Question | Document |
|---|---|
| Pin map, bill of materials, wire protocol, BLE | [docs/hardware.md](docs/hardware.md) |
| Registering a device, configuring, flashing, the API | [HARDWARE_INTEGRATION_GUIDE.md](HARDWARE_INTEGRATION_GUIDE.md) |
| Validating the sensors against references | [docs/hardware_validation.md](docs/hardware_validation.md) |
| Running the fleet, device events, offline handling | [docs/iot_runbook.md](docs/iot_runbook.md) |
| What the band decides locally and why | `firmware/averis-wearable/src/signal_core.h` |
| When the band stays quiet | `firmware/averis-wearable/src/edge_policy.h` |

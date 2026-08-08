# Hardware validation

What has been validated, what has not, and the protocol for the parts that need
a person and a board.

---

## 0. Current status

**No AVERIS band has been validated against physical sensors.** This document is
the protocol, not a report of results. Every table below is empty by design and
is filled in by whoever runs it.

That sentence is the most important one here, and it is first because a
validation document whose status is buried under a protocol will be quoted as
though the protocol had been run.

| Area | Method | Status |
| --- | --- | --- |
| Transport — latency, loss, auth, replay | `scripts/hardware-validation/transport_validation.py` | **Automated.** Run it against a deployment; it prints measured numbers. |
| Firmware decision logic | `firmware/averis-wearable/test/run.sh` | **91 checks passing**, on the host, on every commit |
| Wire contract | Shared vectors, TypeScript + Python | **Passing** in CI |
| Sensor agreement | §2 below | **Not performed.** Needs a board and reference instruments. |
| Fall detection on a body | §3 below | **Not performed.** Needs a person and a crash mat. |
| Battery life | §4 below | **Not performed.** Needs a board and a day. |
| Boot and recovery | §5 below | **Not performed.** |

The split between rows 1–3 and rows 4–7 is the whole point. Everything
automatable is automated and runs in CI; everything else is a written procedure
marked as not done. A "hardware validated ✓" claim covering only the first group
would be the comfortable version and would be false.

---

## 1. Before you start

You need:

- an assembled band that has completed [HARDWARE_SETUP_GUIDE.md](../HARDWARE_SETUP_GUIDE.md) stage 6
- a **fingertip pulse oximeter** with a stated accuracy specification. Not a
  smartwatch — you need to be able to look up the reference's own error, or the
  comparison cannot be interpreted
- a **digital thermometer**, oral or tympanic
- a way to record paired readings: the calibration page at
  `/devices/<key>/calibration` does the statistics for you

Record the reference's make, model and stated accuracy. "A commercial pulse
oximeter" is not a reference.

---

## 2. Sensor agreement

### The method, and why it is not a correlation

Compare the band against a reference on the same person at the same moment,
twenty times or more, and analyse with **Bland–Altman**: bias, limits of
agreement, and a check for proportional bias.

Do **not** report a correlation coefficient. A device reading a consistent 8
percentage points low correlates at r = 0.99 while telling a clinician a patient
at 92% is at 84%. `lib/calibration/agreement.ts` implements the right analysis
and refuses to report anything below twenty pairs.

### 2.1 MAX30102 — heart rate

| Condition | Pairs | Notes |
| --- | --- | --- |
| Resting, seated, still, 2 min settled | ≥ 10 | |
| After 30 s of stair climbing | ≥ 10 | Covers a raised rate |
| Hand cool (below 20 °C ambient) | ≥ 5 | Perfusion is the dominant error |

Both readings at the same moment. Heart rate changes between two measurements a
minute apart, and that change becomes fake disagreement.

Record: bias, limits of agreement, worst single difference, conditions.

### 2.2 MAX30102 — SpO₂

| Condition | Pairs | Notes |
| --- | --- | --- |
| Resting, both sensors same hand, adjacent fingers | ≥ 20 | |

Same hand matters: perfusion differs between hands and that difference will look
like device error.

**What this cannot establish.** Every reading here will be between roughly 95%
and 100%, because the subject is a healthy person breathing room air. The
clinically important range is 88–94%, and nothing in this protocol reaches it.

Establishing accuracy there requires a controlled desaturation study under ISO
80601-2-61: healthy volunteers brought to roughly 70% arterial saturation in
stages, arterial blood gas as the reference, ≥200 paired points across ≥10
subjects with varied skin pigmentation, pass criterion A_rms ≤ 4%.

**AVERIS cannot run that study**, and no amount of bench comparison substitutes
for it. What this protocol detects is a broken or misassembled unit. That is
worth detecting and is a different claim.

### 2.3 MLX90614 — temperature

| Condition | Pairs | Notes |
| --- | --- | --- |
| Wrist, constant distance, stable room | ≥ 20 | Record ambient temperature |
| After 10 min in a cooler room | ≥ 10 | Skin temperature tracks ambient |

Expect a **consistent negative offset of 1–2 °C** against an oral reference. That
is not a fault; the sensor measures skin and skin is not core. What matters is
that the offset is stable — which is why the acceptance bound on RMS is tighter
than the bound on bias in `ACCEPTABLE`.

Hold the distance constant. This sensor's field of view means 2 cm and 5 cm are
different measurements.

---

## 3. MPU6050 — motion and falls

### 3.1 Movement classification

Wear the band and perform each activity for two minutes. Compare the reported
`movement_status` against what you were actually doing.

| Activity | Expected | Observed | Notes |
| --- | --- | --- | --- |
| Sitting still | `RESTING` | | |
| Walking, normal pace | `ACTIVE` | | |
| Climbing stairs | `ACTIVE` | | |
| Typing | `RESTING` or `NORMAL` | | Hand motion without body motion |
| Riding in a car | `RESTING` | | Vibration must not read as activity |

The last row is the interesting one. A band that reports a passenger as active
will also mistake road vibration for something else later.

### 3.2 Falls — and how to test them safely

**Do not fall over to test a fall detector.** Use a crash mat, or drop the band
onto a mattress from waist height, or have a volunteer perform controlled
descents onto padding under supervision.

| Event | Should detect? | Detected? |
| --- | --- | --- |
| Controlled fall onto a mat, lying still after | **yes** | |
| Fall, then getting up within 10 s | yes (with recovery) | |
| Sitting down heavily in a chair | **no** | |
| Dropping the band on a table from 1 m | **no** | |
| Jumping | **no** | |
| Lying down deliberately | **no** | |

The four "no" rows carry more weight than the two "yes" rows. A fall detector
that fires on sitting down is one whose alerts get muted, and a muted detector
misses the real fall. The firmware's state machine is tested against these
sequences on the host — `test_stumble_is_not_a_fall`,
`test_dropped_band_is_not_a_fall` — but synthetic IMU traces are not a body, and
that is the gap this section exists to close.

**Known limitation, carried from Phase 5:** the trained fall model is fitted on
synthetic data. Its model card says so. Real falls from real wrists would change
its thresholds, and none have been recorded.

---

## 4. Battery

Run from a full charge until the band stops reporting. Record:

| Measurement | Value |
| --- | --- |
| Cell capacity (stated) | |
| Uplink interval during the test | |
| Suppression rate reported in the serial log | |
| Time to low-power threshold | |
| Time to shutdown | |

The suppression rate is worth recording alongside the runtime: the edge policy's
whole justification is that it buys battery, and a runtime measured without the
corresponding suppression rate cannot be compared against another run.

Test with the radio in a **weak-signal** location as well. Transmit power rises
as signal falls, and a runtime measured next to the access point is the best
case rather than the typical one.

---

## 5. Boot, recovery and communication stability

| Test | Expected | Observed |
| --- | --- | --- |
| Cold boot to first reading | under 30 s with a known network | |
| Boot with WiFi unavailable | boots, buffers, no crash | |
| WiFi lost mid-session for 5 min | buffers, replays on reconnect, **no reading lost** | |
| Power cycle with a full buffer | buffer survives in NVS, replays | |
| Invalid token | stops cleanly, does not loop | |
| 24 h continuous | no reboot, no memory exhaustion | |

Row 3 and row 4 are the ones that matter. Replayed readings must land at the
timestamp they were **measured**, not the timestamp they were delivered — an
outage that rewrites a patient's history into a spike at the reconnection moment
is worse than an outage that loses the data, because the spike looks like a
clinical event.

The transport harness exercises the replay path against a live service:

```bash
python3 scripts/hardware-validation/transport_validation.py \
    --url https://your-ingest-host --token avd_...
```

---

## 6. Recording results

Sensor agreement goes into the product, at `/devices/<key>/calibration` — it
computes the statistics, refuses to report below twenty pairs, and keeps the raw
pairs so somebody can re-examine the conclusion.

The rest of this document is tables to fill in. When you fill one in, **change
§0** in the same commit. A status table that says "not performed" beside a
completed section is worse than no status table, because the next reader will
trust it.

---

## 7. What will still be unvalidated afterwards

Even with every section above completed:

- **Accuracy in the hypoxic range.** §2.2.
- **Fall detection across body types, ages and real falls.** §3.2. A protocol
  run by two developers on a crash mat is not a population.
- **Long-term drift.** Whether a sensor still agrees after six months on a wrist
  is a question only six months answers.
- **Skin pigmentation effects on SpO₂.** Pulse oximeter bias by pigmentation is
  a documented and clinically significant problem. Detecting it requires a
  diverse cohort and the hypoxic range, and this protocol has neither.
- **Any claim of clinical accuracy.** Nothing here supports one, and
  `SECURITY_REPORT.md` §6 and the model cards say the same.

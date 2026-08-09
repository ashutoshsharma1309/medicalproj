# Validation report

Methodology, results, limitations, and what would have to happen next.

**Date:** 2026-08-13 · **Scope:** AVERIS as of Phase 11.

---

## 1. Methodology

### 1.1 The principle

**A check that could not run is reported as skipped, never as passed.** Every
harness in this project is built around that, because the alternative — a green
summary describing a fraction of the system — is the failure mode that makes
validation worthless while looking like validation.

It is enforced rather than intended: `run_all_tests.sh` reports SKIPPED for a
suite whose prerequisites are missing and exits 2 rather than 0; the RLS runner
refuses to report success if any verification file is not in its list; the
transport harness reports `n/a` with a reason rather than 0 ms; the benchmark
exits non-zero when the path it claims to measure never executed.

Three of those four guards were added in this phase, each after the
corresponding failure actually occurred.

### 1.2 The four levels

| Level | What it establishes | Where |
| --- | --- | --- |
| **Unit** | A function does what it says | 668 TypeScript, 153 Python |
| **Contract** | Two implementations agree | Shared wire-contract vectors, run by both validators |
| **Integration** | Components compose correctly | Scenario suites through real rules and real escalation |
| **Authorization** | One patient cannot reach another | 280 assertions against the **unmodified production migrations** |

The fourth is the one that matters most for a healthcare product and is the one
most projects skip. It runs against the real migration files rather than a test
schema, so a policy change that opens a hole fails CI rather than production.

### 1.3 Verifying the instruments

A harness that has never been pointed at a known-bad target is not a harness.
Three were checked this way:

- **Transport harness** — run against four deliberately broken stubs (accepts
  any token, drops 25%, loses 2 of 5 on replay, drops everything). It went red
  on each and reported `n/a` rather than 0 ms when nothing landed.
- **RLS runner guard** — an unlisted verification file was dropped into the
  directory; the run failed and refused to report success.
- **Audit gate** — removing `sharp` from the allowlist failed the run, proving
  the gate is not `--audit-level=critical` wearing a costume.

---

## 2. Results

### 2.1 Automated checks

| Suite | Result |
| --- | --- |
| TypeScript type check | pass |
| TypeScript unit tests | 668 / 668 |
| Python tests | 153 |
| Firmware logic checks | 91 / 91 |
| Schema and Row Level Security | 280 assertions |
| Dependency audit | 0 critical; 4 high, each individually argued |
| **Total** | **1,192** |

### 2.2 Decision latency

| Path | p50 | p95 | p99 | Throughput |
| --- | --- | --- | --- | --- |
| Raises nothing | 1.83 µs | 2.71 µs | 3.25 µs | ~484,000/s/core |
| Escalates | 3.21 µs | 4.75 µs | 6.04 µs | ~287,000/s/core |

A thousand bands at 0.5 Hz is 500 readings/second: **0.2% of one core.**

### 2.3 Fall detector

Cross-validated, 5 folds × 3 seeds, 12,000 held-out predictions, on **synthetic**
data:

| Metric | Mean | Range |
| --- | --- | --- |
| Precision | 0.882 | 0.808 – 0.933 |
| Recall | 0.990 | 0.971 – 1.000 |
| F1 | 0.932 | 0.890 – 0.960 |
| ROC-AUC | 0.997 | 0.994 – 0.999 |

The model card previously reported precision 0.9014 from a single split. The
cross-validated mean is 0.882 with a range spanning 0.808 to 0.933 — so the
original figure was that split's precision, not the model's.

**The result that matters more than any of the above**, from expressing the
false-positive rate in field units:

| Threshold | Recall | False alarms/day (gated) | False alarms/day (ungated) |
| --- | --- | --- | --- |
| 0.5 (default) | 0.990 | 0.31 | **45.7** |
| 0.7 | 0.958 | 0.16 | 24.7 |
| 0.8 | 0.919 | 0.08 | 11.8 |

**The device-side state machine is load-bearing.** Gated as designed — only
windows the free-fall → impact → stillness sequence has already flagged reach
the classifier — the projection is about one false alarm every three days. If
that gate were removed and every movement window scored, the same model projects
46 a day, which is a device in a drawer by the second day.

Both projections are pessimistic by an unknown factor: the false-positive rate
is measured against synthetic negatives deliberately generated to *resemble*
falls, and ordinary motion is far easier to reject.

### 2.4 Anomaly detection

**Precision and recall are not defined for it, and none are reported.** The
Isolation Forest is unsupervised and there is no labelled set of "readings that
should have been flagged". A number here would have to be invented.

What *can* be said: it flags readings far from the fitted distribution, and the
system treats that as a signal to look rather than as a finding on its own —
which is why anomaly output never escalates by itself.

---

## 3. Known limitations

Ordered by how much they should affect a reader's confidence.

### 3.1 No sensor has been validated

No AVERIS band has been compared against a reference instrument. Every
sensor-side result in this report is about firmware logic compiled on a host,
not about a MAX30102 on a wrist. `docs/hardware_validation.md` is the protocol;
its results tables are empty by design.

**Consequence:** nothing here supports any statement about measurement accuracy.

### 3.2 The fall model has never seen a real fall

Trained entirely on a synthetic generator. §2.3's numbers describe whether the
model learned the generator. Real falls would change its thresholds and probably
its features.

### 3.3 No browser-level testing

No Playwright, no Cypress. The data path behind every screen is tested; the
screens are not. "Heart rate sensor unavailable" is rendered from a null
channel that is verified, but nothing asserts a user sees it.

**This is the largest gap that could be closed without hardware.**

### 3.4 No load or soak testing

Phase 11 §5 asks for 1/6/24-hour continuous operation with memory,
connection-stability and battery measurements. None was run. §2.2's figures are
single-process and in-memory; they say nothing about behaviour after six hours
with a real connection pool.

### 3.5 No deployed-stack performance figures

API response time, database write latency under concurrency, WebSocket
stability and streaming delay are all unmeasured. They need a deployment under
load. Numbers produced from a laptop would transfer nowhere.

### 3.6 No penetration test

§5 of the end-to-end report covers the attacks we thought of. Nobody
adversarial has looked at this system.

### 3.7 Clinical validation

Absent entirely, and not obtainable without a study AVERIS cannot run. No claim
of clinical accuracy is made anywhere in the product or its documentation.

---

## 4. What this phase changed

Nine defects, all found by execution. Seven were in the **test infrastructure**,
which is worth dwelling on: a validation harness with defects reports success
while measuring nothing, and there is no external signal that it is wrong.

The three most serious were the same failure — *something silently not
happening*:

1. A whole assertion suite sat in the directory unexecuted because its filename
   did not match the runner's glob.
2. Suite ordering depended on a filename sort that put `iot_phase11` before
   `iot_phase1`, then (after a fix) `phase4b` before `phase4`.
3. `docker exec -i` consumed the loop's stdin and silently dropped five of seven
   suites.

Each reported success. The runner now maintains an explicit ordered list and
**refuses to report success if any verification file is missing from it** —
verified by dropping an unlisted file in and watching the run fail.

---

## 5. Future improvements

In the order that would most change what this report can claim:

1. **Attach a board and run `docs/hardware_validation.md` §2.** Twenty paired
   readings against a fingertip oximeter is one afternoon and moves §3.1 from
   "no data" to "measured".
2. **Record real falls.** Even a few dozen supervised descents onto a crash mat
   would let §2.3 say something about reality rather than about a generator.
3. **Browser-level tests.** The largest gap closable today.
4. **A soak run.** 24 hours against a deployed stack, watching memory and
   connections.
5. **Load testing** with 100+ simulated devices against a real deployment, to
   produce the figures §3.5 lists as missing.
6. **A penetration test** by somebody who did not write this.
7. **A pilot with defined outcomes**, which is the only thing that converts any
   of this into clinical evidence.

---

## 6. Conclusion

AVERIS's software is verified to an unusual standard for a project at this
stage: 1,192 automated checks, an authorization model asserted against the real
migrations, and harnesses that have themselves been tested against known-bad
inputs.

Its **sensors are unvalidated**, its **fall model has never seen a real fall**,
and its **user interface is untested at the browser level**. Those three
sentences are the honest summary, and no count of passing tests changes them.

The claim this report supports is: *AVERIS is engineered as a reliable
healthcare monitoring platform.* The claim it does not support, and which
nothing in this repository makes, is that it is a validated medical device.

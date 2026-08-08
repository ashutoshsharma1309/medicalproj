# AVERIS — final test report

Full verification after the product-polish phase. Every suite executed; none
skipped.

**Run:** `./run_all_tests.sh` · **Date:** 2026-08-10

| Suite | Result | Covers |
|---|---|---|
| TypeScript type check | ✅ pass | Every type boundary in `app/` and `lib/` |
| TypeScript unit tests | ✅ **478 / 478** | Pure logic — triage, escalation, reports, assistant, health score, validation, ML scoring |
| Python tests | ✅ **125 / 125** | Ingest validator, alert rules, escalation, telemetry, AI engine |
| Firmware logic checks | ✅ **67 / 67** | Filtering, fall detection, payload encoding, battery curve |
| Database — schema + RLS | ✅ **237 assertions** | Structure and access control, against the unmodified production migrations |
| Production build | ✅ pass | 29 routes, landing page prerendered |

**907 automated checks.** Regenerate with `./run_all_tests.sh`, which writes
`TEST_REPORT.md` alongside this file.

---

## What this phase added to the suites

| Area | Tests | The property being pinned |
|---|---|---|
| Health score | 18 | It refuses to produce a number rather than producing a reassuring one |
| Clinical chart zones | 4 | A shaded band can never disagree with the alert that fires beside it |
| Emergency demo script | 13 | Each stage does what the narration claims, checked against the real rules |

### The health score's tests are mostly about refusal

Eleven of the eighteen assert what it does *not* do. That ratio is deliberate:
a number out of 100 on a health dashboard is the most dangerous component in
the product, and its failure modes are all reassurance.

- No readings → `null`, never 100, never 50, never a default.
- Fewer than ten readings → `null`, because a score from six readings looks
  identical on screen to one from six hundred.
- An open emergency forces the band to CRITICAL whatever the arithmetic says —
  six quiet hours must never render as "Stable" while somebody waits for a
  response.
- A missing AI assessment scores as *neutral*, not healthy, so a patient whose
  analysis never ran cannot outscore one whose analysis found nothing wrong.
- The factor points sum to the score, and the weights sum to one — the panel
  cannot show a decomposition that does not add up.

### The demo script is checked against production rules, not a copy

`emergency-script.test.ts` imports `evaluateReading` and `escalationsFor` and
asserts the script's claims against them:

- Step 1 raises **nothing** — the half that is harder to believe.
- Step 3 raises a warning and **provably does not escalate**.
- Step 5 crosses both critical thresholds and raises two distinct emergencies.
- Step 6's fall is not suppressed by the hypoxia already open.

If a published threshold ever moves, these fail in CI rather than during a
demonstration.

### Chart zones cannot drift from the alerts

The zones are *derived* from the alerting rules rather than declared, and a
test samples every band and asserts the classifier agrees. A hand-written zone
table would be a fourth copy of the thresholds, and the copy that drifts is the
one that shades a value green while a critical alert fires next to it.

---

## Bugs found by testing during this phase

| Found by | Bug | Kind |
|---|---|---|
| Writing the score tests | Two test scenarios were physically impossible — a device "not reporting" with a reading timestamped *now*. The code respected the arithmetic over the categorical signal | Product + test |
| Security review of new code | The CSP's `connect-src` did not include the ingest origin, so the emergency simulator's fetch would be **blocked in production while working locally** | Product |

The second is the one worth noting. It is invisible in development, produces a
console error and no server-side trace, and would have failed on stage.

---

## Cumulative bug record

Defects found by *executing* rather than reading, across the last three phases:

| Phase | Bug | Where |
|---|---|---|
| 5 | Outlier filter was a lock — a genuine climb would be rejected forever against a stale median | Firmware |
| 5 | Payload encoder walked past its buffer via `snprintf`'s return value | Firmware |
| 5 | ISO-8601 test expectation wrong, code correct | Test |
| Completion | `iot_devices.token_hash` had no `UNIQUE`; `resolve_device` reads `rows[0]` | Database |
| Completion | A patient could not read their own caregiver's identity — `/care-team` rendered every caregiver as an unnamed "Caregiver" | Product |
| Completion | Three RLS assertions passed vacuously — subqueries over tables the acting role could not read | Test |
| Polish | CSP blocked the ingest origin | Product |

Seven of eleven were found only by running the code.

---

## What the suites do not cover

Stated plainly, because a green report is exactly where an unstated gap does
the most damage.

**No end-to-end browser test.** There is no Playwright or Cypress suite. Sign
up → onboarding → register device → stream → alert → clinician has been
verified by hand, and is not verified on every commit. This is the largest
testing gap in the project.

**No visual regression testing.** The design system is verified by type
checking and by eye. A component whose contrast or layout regresses would ship.

**No hardware in the loop.** 67 firmware checks compile and run on a
development machine. None of them touches I²C, WiFi or BLE — mocking a
MAX30102 would test the mock. **The firmware has never executed on an ESP32.**

**No load testing.** No fleet has ever connected. The websocket hub's
per-patient isolation is asserted structurally, not under concurrency.

**No accuracy validation of any kind.** No sensitivity, no specificity, no
comparison against a reference instrument. AVERIS has no outcome data, so
claims of that shape are not merely unproven — nothing has been set up that
could produce them.

---

## Verification commands

```bash
./run_all_tests.sh                    # everything, writes TEST_REPORT.md
./run_all_tests.sh --no-db            # skip the database suites

npx tsc --noEmit                      # types
npm test                              # 478 TypeScript tests
iot-service/.venv/bin/python -m pytest iot-service/tests ai_engine/tests -q
firmware/averis-wearable/test/run.sh  # 67 checks, no ESP32 needed
./scripts/setup_database.sh           # migrations + schema validation + 237 assertions
npm run build                         # production build
```

A suite that cannot run is reported as **SKIPPED**, never as passed, and
`run_all_tests.sh` exits `2` rather than `0` when anything was skipped — so
"all green" and "all green except the two that never started" are
distinguishable by a machine as well as by a reader.

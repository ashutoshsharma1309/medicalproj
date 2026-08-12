# AVERIS — test report

Generated `2026-08-12 12:15:58 UTC` by `./run_all_tests.sh`.

> A suite that could not run is reported as **SKIPPED**, never as passed.
> A green summary that silently omits the suites which never started is
> the most common way a test runner misleads, and three of the five here
> depend on something that may be absent.

| Suite | Result | Detail |
|---|---|---|
| TypeScript type check | ✅ pass | ok |
| TypeScript unit tests | ✅ pass | 668 tests, 668 pass |
| Dependency audit | ✅ pass | ok |
| Python tests | ✅ pass | 153 passed |
| Firmware logic tests | ✅ pass | 91 checks, 91 pass |
| Database — RLS and schema | ✅ pass | 280 assertions |

**6 of 6 suites passed.** 0 failed, 0 skipped.

## What each suite covers

| Suite | Covers | Does not cover |
|---|---|---|
| TypeScript type check | Every type boundary in the app and `lib/` | Runtime behaviour |
| TypeScript unit tests | Pure logic: triage, escalation, reports, assistant, validation, ML scoring | Anything needing a database, a network or a model key |
| Python tests | The ingest validator, alert rules, escalation, telemetry, the AI engine | HTTP routing, PostgREST calls |
| Firmware logic tests | Filtering, fall detection, payload encoding, battery curve | I²C, WiFi, BLE — mocking a MAX30102 would test the mock |
| Database | Schema structure and RLS behaviour, against the unmodified production migrations | Application-layer authorization |

## Running the parts that were skipped

```bash
npm install                                   # TypeScript suites
pip install -r iot-service/requirements-dev.txt   # Python suites
./scripts/setup_database.sh                   # database suites
```

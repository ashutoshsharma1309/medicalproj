# End-to-end test report

Test cases across the full path, with expected results, actual results, and the
issues found.

**Run date:** 2026-08-13 · **Command:** `./run_all_tests.sh`
**Environment:** one developer machine; Postgres 17 with pgvector in Docker; no
physical device attached.

---

## Summary

| Suite | Result |
| --- | --- |
| TypeScript type check | pass |
| TypeScript unit tests | **668 pass / 668** |
| Dependency audit | pass — 0 critical, 4 argued high |
| Python tests | **153 pass** |
| Firmware logic checks | **91 pass / 91** |
| Database — schema and RLS | **280 assertions** |
| **Total automated checks** | **1,192** |

Every suite ran; none was skipped.

**Issues found during this phase: 9.** All were found by *executing* something,
none by reading it, and seven of them were in the test infrastructure rather
than the product — which is its own finding and is discussed in §7.

---

## 1. The path under test

```
Wearable → sensor reading → validation → transport → ingest → database
         → threshold rules → escalation → notification → dashboard
```

Which stages can be exercised without hardware and without a deployment, and
which cannot, is the thing that decides what this report can honestly claim:

| Stage | Automated here | Notes |
| --- | --- | --- |
| Sensor acquisition | ✗ | Needs a board. `docs/hardware_validation.md` |
| Firmware filtering, fall state machine, edge policy | ✓ | 91 host checks |
| Payload encoding | ✓ | Shared wire-contract vectors |
| Transport | Partial | Harness exists and is verified; needs a running service to measure |
| Ingest validation | ✓ | TypeScript + Python validators run the same vectors |
| Database write and RLS | ✓ | 280 assertions against unmodified migrations |
| Threshold rules | ✓ | Scenario suites |
| Escalation | ✓ | Scenario suites |
| Notification planning | ✓ | Dispatch tests |
| Dashboard rendering | ✗ | No browser-level tests. §8 |

---

## 2. Sensor data validation (§2)

| # | Case | Expected | Actual |
| --- | --- | --- | --- |
| 2.1 | HR 60–100, SpO₂ 95–100, temp 36–37.5 | No alert | **Pass** — asserted for every reading above the 94% line in the oxygen scenario |
| 2.2 | SpO₂ 93 (below warning, above escalation) | WARNING, no emergency | **Pass** |
| 2.3 | SpO₂ 88 | CRITICAL + `SEVERE_HYPOXIA` | **Pass** |
| 2.4 | HR 141 at rest | Warning, no escalation | **Pass** |
| 2.5 | HR 165 at rest | CRITICAL + `EXTREME_HEART_RATE` | **Pass** |
| 2.6 | `FALL_SUSPECTED` with normal vitals | CRITICAL + `FALL_DETECTED` | **Pass** — escalates on the movement channel alone |
| 2.7 | Temperature above 39.5 | Alert raised, no emergency | **Pass** — deliberate: a critical temperature is a real finding but not a minutes-matter event |

Every threshold in these cases is read from `THRESHOLDS` rather than copied, so a
change to the real constants breaks the assertion instead of leaving it quietly
claiming something untrue.

---

## 3. Sensor failure handling (§3)

| # | Case | Expected | Actual |
| --- | --- | --- | --- |
| 3.1 | Physically impossible value (HR 300) | Rejected at the device; never transmitted | **Pass** — firmware plausibility ranges |
| 3.2 | Sensor drops out mid-session | Channel reports null; a gap, not a fabricated value | **Pass** |
| 3.3 | Repeated outliers (contact lost) | Filter rejects, then resyncs after 5 rejections | **Pass** — the resync exists because the filter was once a lock |
| 3.4 | Reading with no measurable channel | Not transmitted at all | **Pass** — spending the radio to be told it is invalid costs battery |
| 3.5 | Absent channel across a dropout | Last *sent* value retained as reference | **Pass** — otherwise every dropout forces a transmission, and dropouts come in runs |
| 3.6 | Malformed payload at ingest | 4xx with a reason, nothing stored | **Pass** |
| 3.7 | Payload accepted by one validator and rejected by the other | Impossible | **Pass** — shared vectors run against both |

**Gap:** the dashboard string "Heart rate sensor unavailable" is rendered from
the null channel, but there is no browser-level test asserting the user sees it.
The data path is verified; the rendering is not. §8.

---

## 4. Network failure (§4)

| # | Case | Expected | Actual |
| --- | --- | --- | --- |
| 4.1 | Link down for 16 minutes | 8 readings buffered, none lost | **Pass** |
| 4.2 | Reconnection | Whole backlog replayed at once | **Pass** — a band that dribbles never converges on a worse link |
| 4.3 | Replayed timestamps | Land at measurement time, not delivery time | **Pass** — the assertion the rural scenario exists for |
| 4.4 | Buffer overflow | Oldest dropped, newest kept | **Pass** |
| 4.5 | Power cycle with a full buffer | Buffer survives in NVS | **Not automated** — needs hardware |
| 4.6 | AI service unreachable | Ingest falls back locally, stamps `inference_source` | **Pass** |
| 4.7 | Redis unreachable | Cache falls through to computation | **Pass** |
| 4.8 | Invalid token | Band stops cleanly, does not loop | **Pass** |

---

## 5. Multi-patient separation and abuse (§9, §10)

Thirteen assertions, organised by attack rather than by feature. **Three**
patients, not two — with two, a policy returning "everything except mine" passes
every cross-patient check while being catastrophically wrong.

| # | Attempt | Expected | Actual |
| --- | --- | --- | --- |
| 5.1 | Patient reads another's readings | 0 rows | **Pass** — and asserted against the global total, not against zero |
| 5.2 | Patient reads another's device | 0 rows | **Pass** |
| 5.3 | Client writes a reading into another chart | Refused | **Pass** — at the grant level, stronger than a policy |
| 5.4 | Client writes a reading into their *own* chart | Refused | **Pass** — a patient who can author vitals can manufacture a history |
| 5.5 | Client forges an emergency | Refused | **Pass** |
| 5.6 | Client downgrades another's critical alert | 0 rows affected | **Pass** |
| 5.7 | `anon` reads any patient table | No privilege | **Pass** — checked by privilege, not by an empty select |
| 5.8 | Client calls the device resolver | Refused | **Pass** |
| 5.9 | Client reads `token_hash` | Refused | **Pass** |
| 5.10 | Client edits an audit entry | Refused | **Pass** |
| 5.11 | Client deletes audit entries | Refused | **Pass** |
| 5.12 | Client reassigns another's device to themselves | 0 rows affected | **Pass** |

---

## 6. Alert latency (§7) and performance (§8)

Measured with `node --import tsx scripts/bench-pipeline.mjs`, 20,000 readings
after a discarded warmup:

| Path | p50 | p95 | p99 | Throughput |
| --- | --- | --- | --- | --- |
| Reading that raises nothing | 1.83 µs | 2.71 µs | 3.25 µs | ~484,000/s/core |
| Reading that escalates | 3.21 µs | 4.75 µs | 6.04 µs | ~287,000/s/core |

A thousand bands at 0.5 Hz is 500 readings/second — about **0.2% of one core**.
The decision layer is not where scale will hurt.

**What was not measured, and why:** API response time, database write latency,
WebSocket delivery and dashboard rendering all need a deployed stack under load.
A figure for them produced on a laptop transfers to no deployment.

---

## 7. Issues found

Nine, all found by executing rather than reading. The distribution is the
interesting part: **seven were in the test infrastructure, not the product.**

| # | Issue | Where | Severity | Status |
| --- | --- | --- | --- | --- |
| 1 | A whole assertion suite never ran — the runner globbed one filename pattern, the file used another | Runner | **High** | Fixed: explicit list + a guard that fails the run if any file is unlisted |
| 2 | Suite ordering encoded in a filename sort; a glob puts `iot_phase11` before `iot_phase1`, and `sort -V` puts `phase4b` before `phase4` | Runner | **High** | Fixed: explicit ordered list |
| 3 | `docker exec -i` consumed the loop's stdin, silently dropping 5 of 7 suites | Runner | **High** | Fixed: array instead of `while read` |
| 4 | Fixture user id collided with an existing one; `ON CONFLICT DO NOTHING` swallowed it | Fixtures | Medium | Fixed: distinct id, clause removed so a collision fails at the collision |
| 5 | Fixture token hash collided | Fixtures | Low | Fixed — the Phase 5 uniqueness constraint caught it loudly |
| 6 | An abuse assertion used an invalid enum value, so the statement failed on the enum before the privilege was checked | Assertions | Medium | Fixed — it proved nothing about who may write |
| 7 | Benchmark payloads used `device_key` where the validator wants `device_id`; every reading was rejected and the first run measured the *rejection* path at a flattering 553k/s | Benchmark | Medium | Fixed; the benchmark now exits non-zero when nothing escalates |
| 8 | Benchmark printed `p50 NaN µs` for a path that never executed | Benchmark | Low | Fixed — reports "this path never executed" |
| 9 | Model card's precision came from one split with one seed | Model card | Medium | Cross-validation added: 0.882 mean, 0.808–0.933 range |

**The pattern worth naming.** Every one of the first three is the same failure:
*something silently not happening while the output looked fine.* A test runner
that skips a file, drops five suites, or orders them wrongly reports success in
each case. That is the worst failure a validation harness can have, because it
is indistinguishable from passing — and it is the same failure mode the product
itself is engineered against, which is why the guard now refuses to report
success when any verification file is unlisted.

---

## 8. What is not covered

- **No browser-level tests.** No Playwright or Cypress. Rendering, dashboard
  updates and the actual visibility of "sensor unavailable" to a user are
  unverified. This is the largest gap in this report.
- **No load testing.** No sustained multi-device run against a deployed stack.
  §6's figures are in-process only.
- **No 1/6/24-hour soak.** Phase 11 §5 asks for continuous-operation testing;
  memory growth, connection stability and battery consumption over time are not
  measured, and the battery figure needs hardware regardless.
- **No hardware in the loop.** Every sensor-side row above that says "Pass" is a
  statement about firmware logic compiled on the host, not about a MAX30102.
- **No penetration test.** §5 covers the attacks we thought of.

---

## 9. Conclusion

The path from a validated payload to a notified clinician is verified end to
end, by 1,192 automated checks, with the authorization boundary asserted against
the real migrations.

The path from a *sensor* to a validated payload is not, and no amount of the
former substitutes for the latter. `VALIDATION_REPORT.md` §3 and
`FINAL_PROJECT_REVIEW.md` §3 say the same thing.

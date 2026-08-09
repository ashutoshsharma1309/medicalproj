# Final project review

An assessment of AVERIS across six dimensions, written to be useful rather than
flattering.

**Verification state at review, measured not remembered** — `./run_all_tests.sh`,
all suites ran, none skipped:

| Suite | Result |
| --- | --- |
| TypeScript type check | pass |
| TypeScript unit tests | **650 tests, 650 pass** |
| Dependency audit | pass (0 critical, 4 argued high) |
| Python tests | **153 pass** |
| Firmware logic checks | **91 checks, 91 pass** |
| Database — schema and RLS | **267 assertions** |

---

## How to read this

A self-review that concludes "excellent across the board" is worth nothing,
because nobody writes one that doesn't. This one grades each dimension against
what a *deployed medical device* would need, not against what a hackathon
prototype usually achieves. Two dimensions come out strong, three come out
adequate-with-named-gaps, and one comes out weak.

The weak one is the most important section in this document.

---

## 1. Engineering — architecture quality

**Assessment: strong.**

What supports that:

- **The authorization model is structural, not procedural.** The web application
  holds no service-role key in any configuration, so there is no code path by
  which a bug in a page can read a row the database would refuse. This is not a
  convention that reviewers enforce; it is an absent credential.
- **267 assertions run against the unmodified production migrations** in CI.
  Not against a test schema — against the real files. A policy change that opens
  a hole fails the build.
- **The firmware's decision logic is host-testable**, which is why 91 checks run
  on every commit rather than by wearing the device.
- **Service boundaries were argued, not defaulted.** One service was extracted
  (inference: CPU-bound, holds no credentials). Two were deliberately not, each
  with the specific property extraction would have destroyed — a health service
  would replace verified database policies with hand-written authorization code,
  and a notification service would reintroduce the window in which an emergency
  exists and nobody has been told.

**Where it is weaker:**

- The worker cannot be replicated without a job lock that does not exist. Named
  in `docs/cloud_architecture.md` §3.
- `sensor_readings` needs partitioning before a thousand-band deployment. The
  cutover procedure is written and deliberately not automated, because the
  riskiest operation in the project should not run unattended as a side effect
  of a deploy.
- Rate limiting is per-instance without Redis, so a deployment that scales
  without setting `REDIS_URL` multiplies its effective limit by the replica
  count.

---

## 2. AI — model quality and explanation

**Assessment: strong on explanation, weak on validation.**

These are genuinely separate and grading them together would hide both.

**The explanation architecture is the strongest part of the AI work.** Rules
decide, models score, generative text only ever phrases. The consequence is
unusual: the explanation cannot disagree with the decision, because the
explanation *is* the decision, reworded. Most systems put a model in the decision
path and an explainer beside it, producing a reconstruction that can drift from
what actually happened.

Supporting decisions that hold up under questioning:

- **Personalisation may only add findings.** A learned baseline can say "unusual
  for you"; it can never say "normal for you" about a threshold breach. The
  obvious design suppresses alerts for patients whose baseline has drifted —
  which is to say, for exactly the patients who are deteriorating.
- **No accuracy column anywhere in the schema.** Measuring whether predictions
  were right needs outcome data AVERIS does not have, and a nullable column would
  eventually be filled with an invented figure. The absence is the design.
- **Concept drift is reported as explicitly unmeasurable**, with the reason,
  rather than as a plausible number.
- **AVERIS does not retrain on drift.** A model retrained on drifted data learns
  the drift.

**The validation gaps, stated:**

- The fall model is fitted on **synthetic data**. No real fall is in its training
  set. This is the single largest weakness in the AI story and its model card
  says so.
- The risk model is fitted on a public cohort that is not any deployment's
  population, and is not calibrated for one.
- Explainability for the ML score is per-channel contributions, which is weaker
  than a genuine attribution method.
- Personalisation needs about two weeks of history. A post-discharge patient is
  most at risk in exactly that window, and gets population thresholds. The system
  says "learning your baseline" rather than pretending otherwise.

---

## 3. Hardware — integration readiness

**Assessment: weak, and this is the honest bottom line of the review.**

**No AVERIS band has been validated against physical sensors.** Not "partially",
not "pending final checks" — the sensor validation protocol in
`docs/hardware_validation.md` has not been run, and its results tables are empty
by design.

What *has* been done:

- The firmware decision logic is tested — 91 host checks covering filtering, the
  fall state machine, payload encoding and the edge policy.
- The transport is measurable and the measuring tool is itself verified: the
  validation harness was checked against four known-bad targets to confirm it
  goes red when it should. A measuring instrument never pointed at a known
  quantity is not a measuring instrument.
- The build, wiring, power path and troubleshooting are documented to the point
  where somebody else can assemble one.

What has not:

- Sensor agreement against reference instruments — no data.
- Fall detection on a real body — no data.
- Battery life — not measured.
- Long-term stability — not measured.

**Why this is graded weak rather than "in progress".** Because for a healthcare
device the sensors are the product. Everything above them is infrastructure for
moving numbers around, and if the numbers are wrong the infrastructure is
irrelevant. A review that graded this dimension on the quality of the
*surrounding* engineering would be measuring the wrong thing.

---

## 4. UX — professional experience

**Assessment: adequate, with one distinctive strength.**

The distinctive strength is that **the interface refuses to present absence as
reassurance.** A silent device is shown as a finding, not as a well patient. An
undermeasured calibration reads "insufficient" rather than showing a bias figure.
An unconfigured notification channel marks the notice degraded rather than
logging nothing. A metric that cannot be computed shows null with a reason rather
than zero.

That is unusual and it is the correct behaviour for a monitoring product, where
the dangerous failure is a quiet dashboard over a broken sensor.

Also solid: three distinct audiences (patient, clinician, caregiver) with genuinely
different views rather than one dashboard with fields hidden; caseload triage that
orders by who needs attention; English and Hindi composed from reviewed templates
rather than machine-translated, because a mistranslated clinical instruction is a
safety problem.

**Where it is weaker:**

- No accessibility audit. No screen-reader testing, no contrast verification
  against WCAG. For a product aimed partly at elderly users this is a real gap
  and it is not a small one.
- No usability testing with actual clinicians or patients. The clinician views
  were designed from reasoning about the workflow, not from watching one.
- Mobile layouts work but were not designed mobile-first, and the primary user
  of a rural deployment is on a phone.

---

## 5. Security — healthcare data protection

**Assessment: strong.**

- Row Level Security is the sole authorization mechanism, verified by 267
  assertions against the real migrations.
- The web application holds no service-role key. There is no configuration in
  which it needs one, and `docker-compose.production.yml` says so at the point
  where somebody would be tempted to add it.
- Device tokens are stored only as SHA-256 hashes, and the owner is read from the
  device row rather than the payload — so a device cannot write into another
  patient's chart by claiming a different id.
- Audit entries record *that* something happened, never what it contained,
  enforced by a sanitiser rather than by call-site discipline.
- Logging redacts by allowlist, so a new field carrying a vital sign is redacted
  by default rather than logged until somebody notices.
- Backups are verified by a restore drill that diffs the restored authorization
  model against the migrations — which caught that a dump taken with
  `--no-privileges` restores all 101 policies and silently loses every grant.

**Eight authorization defects were found by executing the assertions rather than
reading the code.** Three of them were assertions that were *passing while testing
nothing*, which is the finding that should most concern a reviewer: a test
suite's own correctness is not self-evident.

**Known weaknesses**, all in `SECURITY_REPORT.md` §5: `'unsafe-inline'` in
`script-src` (a Next.js concession), device tokens that do not expire, no mutual
TLS between services, best-effort audit writes, and **no penetration test —
nobody has attacked this system.**

---

## 6. Presentation — storytelling

**Assessment: adequate.**

The material exists and takes a defensible position: state precisely what has
and has not been established, and point at tests for the difference. Slide 7
volunteers the sensor-validation gap before a judge finds it. Slide 8 refuses a
lives-saved figure and describes the study that would produce one.

**Where it is weaker:** the deck has never been delivered to an audience, and
timing estimates are arithmetic rather than rehearsal. The demo has not been run
in a room with an unreliable network. Both are the kind of thing that only
practice fixes.

---

## Summary

| Dimension | Grade | The one-line reason |
| --- | --- | --- |
| Engineering | **Strong** | Authorization is structural and verified, not procedural |
| AI — explanation | **Strong** | The explanation is the decision, so it cannot disagree with it |
| AI — validation | **Weak** | Fall model on synthetic data; nothing clinically validated |
| Hardware | **Weak** | No band validated against physical sensors |
| UX | **Adequate** | Refuses to present absence as reassurance; no accessibility audit |
| Security | **Strong** | 267 assertions, no service-role key in the web app, verified backups |
| Presentation | **Adequate** | Defensible position, never rehearsed |

## What AVERIS is, in one paragraph

A remote health-monitoring platform whose engineering is unusually careful about
what it claims: every alert traceable to a measurement and a threshold, every
model carrying its training cohort as a caveat on screen, every reading stamped
with whether a real device produced it, and a consistent refusal to present
absence of data as reassurance. Its infrastructure is production-shaped and
verified by 1,161 automated checks across four suites.

It is **not** a validated medical device, has never monitored a patient, and its
sensors have never been compared against a reference instrument. Those are the
next things it needs, and no amount of further software work substitutes for
either.

## If you do one more thing

Attach a board and run `docs/hardware_validation.md` §2. Twenty paired readings
against a fingertip pulse oximeter would move the hardware dimension from "weak"
to "measured", and it is a single afternoon's work. Nothing else available in
one afternoon changes this review as much.

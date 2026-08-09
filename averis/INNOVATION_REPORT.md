# Innovation report

What is genuinely different about AVERIS, argued at the level of engineering
decisions rather than feature names.

---

## The honest framing

None of AVERIS's individual components is novel research. Pulse oximetry,
threshold alerting, Isolation Forests, personal baselines, store-and-forward
buffering — all are established. A report claiming otherwise would be checkable
and wrong.

**The novelty is in the composition and in a constraint held consistently
across it:** the whole path from a sensor on a wrist to a sentence on a
clinician's screen preserves provenance and explicability, and refuses to
fabricate at every point where fabricating would be easier and would look
better.

That sounds like a soft claim. It is not, because it is enforced by structure
rather than by intention, and the structure is inspectable. Each section below
names the decision, the failure it prevents, and where to look.

---

## 1. The Digital Health Twin, built only from confirmed information

**What it is.** A per-patient model assembled from their documents, conditions,
medications, timeline, learned baselines and trends.

**What is different.** Most "health twin" features are a dashboard with a new
name. AVERIS's has one constraint that changes what it is: **nothing enters the
twin that the patient has not confirmed.** Document extraction produces
candidates; a candidate becomes part of the record only after review.

**The failure it prevents.** An OCR misread of "Metformin 500mg" as "5000mg"
that silently becomes part of a patient's medication list, and is then read by a
clinician as fact. Extraction confidence is not consent.

*Where:* `lib/services/twin/digital-twin-service.ts`, the review flow at
`/records/[id]/review`.

---

## 2. Personal baselines that can only add findings

**What it is.** Each patient's normal range learned from their own history —
median, percentiles, IQR — with contaminated periods excluded and an anchor lag
so a deterioration cannot quietly become the new normal.

**What is different.** The invariant, which is the actual innovation:
**personalisation may only ever add findings, never remove one.** A learned
baseline can say "this is unusual *for you*" on a reading inside the population
range. It can never say "this is normal for you" about a reading that crosses a
published threshold.

**The failure it prevents.** The obvious personalisation design suppresses
alerts for patients whose baseline has drifted — which is to say, for exactly
the patients who are deteriorating. A baseline learned during a decline
normalises the decline. This system cannot do that, because the invariant is
asserted in tests rather than left to reviewers.

*Where:* `lib/health/baseline.ts`, with the additive invariant as a test case.

---

## 3. Explainability as an architectural rule, not a feature

**What it is.** Every alert names its measurement, its threshold and its rule.
Every risk score arrives with per-channel contributions.

**What is different.** The rule that produces it: **rules decide, models score,
and generative text only ever phrases.** The LLM in AVERIS never introduces a
finding. It rewords something the deterministic layer already produced, and if
it is unavailable the finding still exists — in plainer language.

**The failure it prevents.** The standard architecture puts a model in the
decision path and an explainer beside it, so the explanation is a *reconstruction*
of the decision and can disagree with it. Here the explanation is the decision,
phrased. There is nothing for it to disagree with.

*Where:* `lib/iot/alert-rules.ts`, `lib/ml/explanation-service.ts`, and the
Phase 3 insight engine.

---

## 4. Provenance stamped at write time

**What it is.** Every reading carries `is_simulated`, set by the server from the
device's registration — not from the payload.

**What is different.** It is a column, not a view; it is set at write time, not
derived later; and it cannot be overridden by the client. A simulator that could
declare itself real would defeat the flag's only purpose.

**Why it matters more than it sounds.** It is what makes an honest demonstration
possible at all. AVERIS can run a full emergency simulation into the production
database and still tell you afterwards exactly which rows were real. Every
metric on `/impact` is split on it. Most projects cannot make that distinction
after the fact, which is why their impact numbers cannot be interrogated.

*Where:* Phase 1 schema, `iot-service/app/store.py`, `/impact`.

---

## 5. Rural optimisation as a design centre, not a mode

**What it is.** NVS-backed buffering across outages, batch replay preserving
measurement timestamps, edge suppression to conserve radio, local alerting
independent of the server, English/Hindi output.

**What is different, specifically:**

- **Replayed readings land where they were measured**, not where they were
  delivered. An outage that rewrites six hours of vitals into a burst at
  reconnection is worse than one that loses them: the burst looks like a
  clinical event.
- **The buffer drops oldest-first.** After an hour offline, the newest readings
  describe the patient now.
- **Edge suppression is bounded by four rules** so it can only ever delay a
  boring reading — including that drift is measured against the last *sent*
  value, so saturation cannot walk 98% → 88% a point at a time unnoticed.
- **Multi-language by template composition**, not machine translation. A
  mistranslated clinical instruction is a safety problem, so the Hindi output is
  composed from reviewed fragments.

*Where:* `firmware/.../net.h`, `edge_policy.h`, `lib/i18n/health-messages.ts`,
and the rural scenario in `lib/demo/scenarios.ts`.

---

## 6. Authorization in the database, verified

**What it is.** Row Level Security is the only authorization mechanism. The web
application holds no service-role key in any configuration.

**What is different.** Not that RLS is used — many projects enable it. That
**267 assertions run against the unmodified production migrations in CI**, and
that six of them were written because executing them found real holes: a
caregiver who could not read their patient's name, a patient who could not read
their own caregiver's, a missing uniqueness constraint on device tokens, three
assertions that were passing while testing nothing, and a calibration record that
could be attached to another patient's device.

**Why this belongs in an innovation report.** Because for a healthcare product it
is the innovation that matters most, and it is the one most projects skip. A
system that cannot demonstrate that one patient's data is unreachable by another
has not built a healthcare product; it has built a demo with a login page.

*Where:* `supabase/tests/*_rls_verification.sql`, `SECURITY_REPORT.md` §3.

---

## 7. A system that says what it does not know

**What it is.** A consistent refusal, at every layer, to present absence as
reassurance.

Collected, because the pattern is the point:

| Situation | The easy version | What AVERIS does |
| --- | --- | --- |
| Fall model absent | return "no fall" | 503 `no_model` — an absent model must not read as a patient who did not fall |
| Not enough calibration pairs | show a bias figure | "insufficient" — neither pass nor fail |
| No alert traceable to a reading | report 0 ms latency | null, with the reason and the count excluded |
| Device silent | show the last reading | flag it as stale; silence is a finding |
| SMS unconfigured | log and continue | mark the notice degraded so "we thought they were told" is visible |
| Model accuracy unmeasurable | a nullable column | no column at all, so nobody fills it in with an invented number |
| Concept drift unmeasurable | report a plausible number | explicitly unavailable, with the reason |

**The failure this prevents** is the one that kills people in monitoring
systems: a quiet dashboard that looks like a well patient and is actually a
broken sensor.

---

## 8. What is *not* novel, said plainly

So the list above is believable:

- The sensors, the ESP32, the I²C bus — commodity parts, standard libraries.
- Isolation Forest for anomaly detection — a 2008 algorithm, used as intended.
- The risk model — logistic regression on a public cohort. Ordinary, and its
  model card says which cohort and that it is not this population.
- The fall detector — a small classifier on IMU windows, **fitted on synthetic
  data**, which is a real weakness and is on the model card.
- Threshold values — published escalation triggers, not clinical judgements of
  ours.
- Next.js, FastAPI, Postgres, Redis — conventional choices, chosen because they
  are conventional.

If a judge asks "what did you actually invent?", the answer is: not an
algorithm. A system in which every claim is traceable to the measurement that
produced it, and which refuses to manufacture the ones it cannot support. In a
healthcare product that is the harder thing to build and the rarer thing to
find.

---

## 9. Where the innovation is weakest

- **The fall model's training data is synthetic.** Real falls would change its
  thresholds. This is the single biggest gap in the AI story.
- **No clinical validation of anything.** Every model card says so.
- **Personalisation needs history.** A new patient gets population thresholds
  for their first two weeks, which is when a post-discharge patient is most at
  risk. The system says "learning your baseline" rather than pretending.
- **Explainability stops at the rules.** For the threshold layer the explanation
  is complete. For the ML risk score it is per-channel contributions, which is
  weaker than a true attribution method.
- **The edge suppression is unmeasured on hardware.** Its battery justification
  is arithmetic, not a measurement — `docs/hardware_validation.md` §4 is the
  protocol, and it has not been run.

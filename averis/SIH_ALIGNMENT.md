# SIH alignment

Where AVERIS fits against the MedTech problem statements, and — the section
that matters more — where it does not.

---

## 1. The problem, stated without inflation

Continuous physiological monitoring outside a hospital is available to almost
nobody who needs it. The people who would benefit most — elderly patients living
alone, post-discharge patients in the first fortnight, chronic respiratory and
cardiac patients in areas with one clinic per several villages — are the least
likely to have it.

**A note on the statistics that usually go here.** A deck at this point normally
cites a mortality figure and a market size. This document does not, because
those numbers get quoted back at you in a Q&A and the honest answer to "where is
that from?" has to be a citation, not a recollection. If you cite figures in the
pitch, cite them from a source you have read and can name — ICMR, NFHS-5, the
Lancet's India state-level disease burden work — and say the year. A judge who
catches one unsourced number stops believing the sourced ones.

What AVERIS's design *rests* on is not a statistic. It is three structural
observations that are true by inspection:

1. **Deterioration is gradual and monitoring is episodic.** A patient's
   saturation falling from 97% to 89% over six hours is invisible to a system
   that measures once a day.
2. **The people who need continuous monitoring are the least connected.** Rural
   deployment means intermittent power and intermittent network — conditions
   under which most monitoring products simply stop.
3. **An alert nobody can check is an alert nobody trusts.** A clinician handed
   "risk: 0.86" with no reason cannot act on it and will eventually stop
   reading it.

Each of those shaped a specific engineering decision, listed in §3.

---

## 2. Which problem statements this addresses

AVERIS is a general remote-monitoring platform, so it maps onto several MedTech
statement families rather than one. Judge alignment by which of these the actual
statement you are assigned emphasises:

| Statement theme | How AVERIS addresses it | Strength |
| --- | --- | --- |
| Remote patient monitoring for rural/underserved areas | Store-and-forward buffering with NVS persistence, multi-language output (English/Hindi), low-bandwidth edge suppression | **Strong** — designed for it, not adapted to it |
| Early warning / deterioration prediction | Personal baselines, trend fitting over daily medians, threshold + trend escalation | **Strong** |
| AI in healthcare with explainability | Rules decide, models score, generative text only ever phrases. Every alert carries value, threshold and rule | **Strong** |
| Affordable medical devices | ~₹2,000–2,500 in parts at prototype quantity | **Moderate** — a bill of materials is not a manufacturable product |
| Elderly care / fall detection | IMU fall detection with a state machine tuned against false positives | **Moderate** — the model is fitted on synthetic data, stated in its model card |
| Hospital workflow / EMR integration | Not addressed | **Weak** — no HL7/FHIR, no EMR connector |
| Telemedicine consultation | Not addressed | **Weak** — no video, no scheduling, no prescription flow |

**Use this table honestly in the room.** If your assigned statement is in the
bottom two rows, say so and pivot to what AVERIS does have rather than claiming
coverage. Overclaiming on a statement the judges know well is the fastest way to
lose a panel.

---

## 3. Why existing approaches are insufficient — and what AVERIS actually does differently

The weak version of this section lists competitors and asserts AVERIS is better.
The useful version names a specific limitation and points at the code that
addresses it.

### 3.1 Consumer wearables (Fitbit, Mi Band, Apple Watch)

**What they do well:** sensors, battery life, industrial design — all far beyond
a prototype's reach.

**The limitation:** they are built for the wearer. Data goes to the wearer's
phone, in the wearer's app, under the wearer's account. There is no clinician,
no care team, no escalation path, and no concept of somebody else needing to be
told. Apple's fall detection calls emergency services — it does not tell a named
caregiver, and it does not put the event in a record a doctor reviews on Monday.

**AVERIS's difference:** the care team is a first-class entity with per-permission
grants (`VIEW_ALERTS` versus full access), and an emergency and the notice to the
care team are written **in the same database transaction**. There is no window in
which an emergency exists and nobody has been told.

*Where:* `private.raise_emergency()`, `lib/care/escalation.ts`, 267 RLS
assertions covering who may see what.

### 3.2 Clinical telemetry (hospital patient monitors)

**What they do well:** medically validated, accurate, reliable.

**The limitation:** they exist inside a hospital, cost lakhs, and require mains
power and a nurse. The patient who deteriorates at home on day nine after
discharge is not attached to one.

**AVERIS's difference:** designed to work where they cannot — battery, buffered
uplink, and a device that keeps measuring and alerting locally when the network
and even the server are gone.

*Where:* `firmware/.../net.h` (NVS-backed buffer, oldest-first drop),
`alert_levels.h` (local buzzer alerting independent of the server).

### 3.3 Threshold-alarm telehealth products

**What they do well:** simple, understandable, cheap.

**The limitation:** a fixed threshold is the same for everyone. A resting heart
rate of 52 is an athlete and a bradycardic 80-year-old, and one threshold cannot
serve both. Fixed thresholds also cannot see a *trend*: every individual reading
in a six-day decline can sit inside the normal band.

**AVERIS's difference:** per-patient baselines learned from the patient's own
history, with a trend fit over daily medians. Crucially, personalisation only
ever **adds** findings — it never suppresses a threshold breach, because a
learned baseline that silences an alert is a learned baseline that can kill
somebody.

*Where:* `lib/health/baseline.ts` (the additive invariant, asserted in tests),
`lib/health/deterioration.ts`.

### 3.4 Black-box AI health scores

**What they do well:** headline numbers, good demos.

**The limitation:** "risk 0.86" is not actionable and not checkable. A clinician
cannot argue with it, and at 3am an unexplainable alert is worse than silence.

**AVERIS's difference:** rules decide, models score, and generative text only
ever phrases something the rules already produced. Every alert carries the
measurement, the threshold and the rule. Every risk score arrives with its
per-channel contributions.

*Where:* `lib/iot/alert-rules.ts`, `ai_engine/prediction/engine.py`, and the
model cards that state the cohort each model was fitted on.

---

## 4. Social impact — the honest version

What AVERIS could plausibly help with, framed as a hypothesis rather than a
result:

- **Earlier detection of gradual deterioration**, because continuous measurement
  can see what daily measurement cannot. *Unproven for this system.*
- **Care that reaches a village**, because the device works through outages and
  the interface speaks Hindi as well as English. *Built, not deployed.*
- **A clinician overseeing more patients**, because triage ordering puts the
  deteriorating ones first. *Built, not measured.*

**What AVERIS has not established, and must not claim:**

- that it detects deterioration earlier than existing care
- that any patient outcome would improve
- that its SpO₂ readings are accurate in the range that matters clinically
  (88–94%), which needs a controlled desaturation study it cannot run
- any figure involving lives, mortality, or cost saved

`docs/hardware_validation.md` §0 and `SECURITY_REPORT.md` §5–6 carry these in
full. The `/impact` page in the product shows only what the prototype has
processed, split by whether it came from a device or a simulator.

**This is the strongest position to argue from, not the weakest.** Every team in
the room will claim their prototype saves lives. Being the team that says
precisely what it has and has not established — and can point at the tests that
back the difference — is a distinguishable position, and it is the one a
medically literate judge is looking for.

---

## 5. Feasibility

| Dimension | Position |
| --- | --- |
| Component cost | ~₹2,000–2,500 at prototype quantity; the ESP32 and sensors are commodity parts |
| Manufacturability | Not designed for it. No enclosure, no PCB, no certification path. A real product needs all three. |
| Regulatory | Would be a medical device under CDSCO if it made diagnostic claims. AVERIS makes none, and the distinction is deliberate rather than convenient. |
| Deployment | Runs on managed infrastructure (Supabase) with a documented container topology; `docs/cloud_architecture.md` |
| Data protection | RLS as the sole authorization mechanism, verified by 267 assertions; `SECURITY_REPORT.md` |
| Sustainability | Open architecture, no proprietary cloud dependency beyond Postgres |

---

## 6. What to say when a judge finds the gap

They will. These are the four most likely questions and the answers that hold up:

**"Is this medically accurate?"**
No, and we can tell you exactly what would be needed to establish it: a
controlled desaturation study under ISO 80601-2-61 — 200 paired points across 10
subjects spanning 70–100% saturation, arterial blood gas as reference. We wrote
the protocol; we cannot run it. What we have validated is that the system is
correct as software: 650 tests, 267 row-security assertions, 91 firmware checks.

**"Your fall model is trained on synthetic data."**
It is, and the model card says so before anyone asks. The state machine around it
is tuned against false positives and tested on the host — a detector that fires
when you sit down gets muted, and a muted detector misses the real fall.

**"Anyone can build an IoT dashboard."**
Agreed, and that is not what this is. Ask us what happens when the network drops
for sixteen minutes, or which of two patients a caregiver with `VIEW_ALERTS` can
see, or what the system does when the AI service is unreachable. The answers are
in tests, and that is the difference.

**"What is actually novel here?"**
See `INNOVATION_REPORT.md`. The short version: the novelty is not any single
component, it is that the whole path from a sensor to a clinician preserves
provenance and explicability end to end, and refuses to fabricate at every point
where fabricating would be easier.

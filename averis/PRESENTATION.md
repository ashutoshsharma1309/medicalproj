# SIH presentation

Ten slides, speaker notes, and the questions you will actually be asked.

**The strategic decision this deck makes:** AVERIS does not out-claim the room.
Every other team will say their prototype saves lives. This one says precisely
what it has established and what it has not, and points at tests for the
difference. That is a distinguishable position and it is the one a medically
literate judge is looking for — but it only works if you commit to it. Half-doing
it reads as hedging.

---

## Slide 1 — The problem

**On the slide**
> Deterioration is gradual. Monitoring is episodic.
>
> A patient's blood oxygen falling from 97% to 89% over six hours is invisible
> to a system that measures once a day.

**Say (30 s).** Open with a person, not a statistic. *"A 68-year-old is
discharged after a chest infection. On day nine at home, his oxygen starts
falling. Nobody measures it until he is breathless enough to call someone."*

**Do not** open with a mortality number unless you can name the source and the
year. A judge who catches one unsourced statistic stops believing the sourced
ones.

---

## Slide 2 — Why existing approaches fall short

**On the slide** — four rows, one limitation each:

| | Limitation |
|---|---|
| Consumer wearables | Built for the wearer. No clinician, no care team, no escalation. |
| Hospital telemetry | Accurate, validated — and inside a hospital, on mains power. |
| Threshold alarms | One threshold for everyone, and blind to a trend. |
| Black-box AI scores | "Risk 0.86" cannot be checked or argued with. |

**Say (45 s).** Take the threshold row: *"A resting heart rate of 52 is an
athlete and it's also a bradycardic 80-year-old. One number cannot serve both.
And every individual reading in a six-day decline can sit inside the normal
band — thresholds structurally cannot see that."*

---

## Slide 3 — AVERIS

**On the slide**
> A wearable that keeps working when the network doesn't.
> A baseline learned from **this** patient.
> An alert that names the measurement, the threshold and the rule.
> A care team told in the same transaction the emergency is created.

**Say (45 s).** Land the last line — it is the one nobody else has. *"When an
emergency is raised, the notice to the care team is written in the same database
transaction. There is no window where an emergency exists and nobody has been
told. That's why we deliberately did not split notifications into a
microservice."*

---

## Slide 4 — Architecture

**On the slide** — the system diagram from `PROJECT_DOCUMENTATION.md` §3.1.

**Say (60 s).** One sentence per layer, then the point:

> *"The web application holds no service-role key. It queries Postgres as the
> signed-in user, over Row Level Security. A bug in a page cannot read a row the
> database would refuse — not because we were careful, but because the
> application doesn't possess the credential that would let it."*

**If asked why that matters:** every authorization decision is a Postgres policy,
and 267 assertions run against the real migrations in CI. A policy change that
opens a hole fails the build.

---

## Slide 5 — Technology

**On the slide**

```
Device     ESP32 · MAX30102 · MLX90614 · MPU6050 · Arduino C++
Transport  HTTPS + hashed bearer tokens · BLE provisioning
Cloud      FastAPI · Supabase Postgres 17 · Redis · Docker
AI         scikit-learn · Isolation Forest · logistic regression
Web        Next.js 16 · TypeScript · Tailwind v4
Verified   650 tests · 267 RLS assertions · 91 firmware checks
```

**Say (30 s).** Move fast. The stack is not the story; the last line is. *"The
firmware's decision logic has no Arduino symbols in it, so it compiles and runs
on a laptop — which is why it's tested on every commit rather than by wearing
the device and hoping."*

---

## Slide 6 — The AI, and what it is allowed to do

**On the slide** — the pipeline diagram, §3.2, plus:

> **Rules decide. Models score. Generative text only ever phrases.**

**Say (60 s).** The strongest technical slide.

> *"The language model never introduces a finding. It rewords something the
> deterministic layer already produced. If it's unavailable, the finding still
> exists — in plainer language. That means the explanation can't disagree with
> the decision, because the explanation IS the decision, phrased."*

Then the personalisation invariant:

> *"Baselines only ever ADD findings. A learned baseline can say 'this is
> unusual for you'. It can never say 'this is normal for you' about a reading
> that crosses a published threshold — because a baseline learned during a
> decline would normalise the decline."*

---

## Slide 7 — The hardware

**On the slide** — a photo of the band if you have one, the BOM, ~₹2,000–2,500.

**Say (45 s).** Then the line that pre-empts the hardest question:

> *"We should be clear: we have not validated these sensors against reference
> instruments. We wrote the protocol — it's in the repository — and it needs a
> hypoxia lab we don't have. What we have validated is the firmware's decision
> logic, 91 checks on every commit, and the transport, measured end to end."*

**Why volunteer this.** Because they will find it, and finding it is worse than
being told. Volunteering it costs thirty seconds and buys credibility for
everything else you say.

---

## Slide 8 — Impact

**On the slide**

> **What we can show:** readings processed, alerts raised, detection latency —
> split by whether they came from a device or a simulator.
>
> **What we cannot show:** that anybody's health improved. No deployment, no
> cohort, no outcome data.

**Say (45 s).**

> *"Every reading in our database is stamped at write time with whether it came
> from a real device. So we can run a full emergency simulation into production
> and still tell you afterwards exactly which rows were real. That's why our
> metrics can be interrogated — most demos can't make that distinction after the
> fact."*

**Do not** put a lives-saved figure on this slide. If a judge asks for one, the
answer is: *"We'd need a pilot with defined outcomes. Here's what that study
would look like."*

---

## Slide 9 — Demo

**Live: `/demo` → "Start SIH demonstration".** Six steps, about 90 seconds.

**Before you click:** *"This posts to the same endpoint the ESP32 does, with a
device token. There is no demo path through our backend."*

**During:** let it narrate. Do not talk over it. Each step shows what it proves
**and what it does not** — point at that once, on step 1.

**If there's no hardware:** step 1 will report degraded and say the simulator is
standing in. **Let it.** Then say: *"That's the honest state — and notice the
system says so itself rather than us mentioning it."*

**Fallback if the network fails:** the run needs the ingest service. Have a
screen recording ready, and say it is a recording.

---

## Slide 10 — What's next

**On the slide**

1. Clinical validation — desaturation study, real fall data
2. Manufacturable device — PCB, enclosure, certification path
3. EMR integration — HL7/FHIR
4. A pilot with defined outcomes

**Close (30 s).**

> *"AVERIS is an intelligent healthcare monitoring ecosystem that combines
> affordable IoT wearables with explainable AI to detect health risks early and
> enable timely intervention. We've built the engineering honestly — every claim
> traceable to a measurement, and a refusal to manufacture the ones we can't
> support. What it needs next is clinical evidence, and we know exactly what
> that study looks like."*

---

## Timing

| Slides | Minutes |
|---|---|
| 1–3 problem and solution | 2:00 |
| 4–6 architecture and AI | 3:00 |
| 7–8 hardware and impact | 1:30 |
| 9 demo | 2:00 |
| 10 close | 0:30 |
| **Total** | **9:00** |

Leaves buffer in a 10-minute slot. If cut to five: slides 1, 3, 6, 9, 10.

---

## The questions you will be asked

**"Is it medically accurate?"**
> No, and we can tell you exactly what would establish it: ISO 80601-2-61 — 200
> paired points across 10 subjects spanning 70–100% saturation, arterial blood
> gas as reference. We wrote the protocol; we can't run it. What we validated is
> that the system is correct as software.

**"Your fall model is trained on synthetic data."**
> It is, and the model card says so before anyone asks. It's the biggest gap in
> our AI story. The state machine around it is tuned against false positives,
> because a detector that fires when you sit down gets muted — and a muted
> detector misses the real fall.

**"Anyone can build an IoT dashboard."**
> Agreed, and that's not what this is. Ask what happens when the network drops
> for sixteen minutes, or which of two patients a caregiver with VIEW_ALERTS can
> see, or what happens when the AI service is unreachable. The answers are in
> tests.

**"What did you actually invent?"**
> Not an algorithm. A system where every claim is traceable to the measurement
> that produced it, and which refuses to manufacture the ones it can't support.
> In healthcare that's the harder thing to build.

**"Why not microservices everywhere?"**
> We extracted one — inference, because it's CPU-bound and holds no credentials.
> We deliberately didn't extract health data, because that service would need a
> service-role key and would replace 267 verified database policies with
> hand-written authorization code. And we didn't extract notifications, because
> that would reintroduce the window where an emergency exists and nobody's been
> told.

**"How does it work with no internet?"**
> The band buffers to RAM mirrored into flash, so it survives a power cycle. On
> reconnection it replays the whole backlog at once — and each reading lands at
> the time it was *measured*, not delivered. An outage that rewrote six hours of
> vitals into a burst at reconnection would look like a clinical event.

**"What's your business model?"**
> Not a question we've built for, and we'd rather say that than invent one. The
> component cost is ₹2,000–2,500; the software runs on managed infrastructure.
> Beyond that would be speculation.

---

## Two rules for the room

**Never invent a number under pressure.** "I don't know, and here's how we'd find
out" is a stronger answer than a plausible fabrication, and a panel that catches
one invented figure discounts everything else.

**Volunteer the limitation before they find it.** Every gap in this project is
already written down in the repository. Saying it first costs seconds and buys
credibility for the rest.

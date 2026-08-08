# AVERIS — personalised health intelligence

How AVERIS answers *"is this normal for **this** patient?"* rather than only
*"is this value inside a published range?"*

---

## The claim, and its one hard limit

A published range says a resting adult's heart rate is 50–120. A personal
baseline says this patient sits at 62–74 and is currently at 105 — a finding
the published range structurally cannot produce, because 105 is inside it.

> **Personalisation may only ADD findings. It may never suppress one.**

This is the invariant the whole feature is built around, and it is asserted
directly in `lib/health/__tests__/baseline.test.ts`.

A patient whose personal range runs high does **not** get a higher escalation
threshold. SpO₂ of 86% is critical for everybody. An adaptive system that
learned to tolerate it would go quiet on exactly the patient who needs it most
— the one whose readings have been drifting for weeks. `personalFindings()`
returns findings *alongside* the threshold rules and has no return value
meaning "ignore the rule engine".

The database schema cannot express that constraint, so
`20260810090000_iot_phase7_personalisation.sql` states it in a comment where
someone would look first: a migration that wired `patient_baselines` into an
alert predicate would be the single most dangerous change available in this
repository.

---

## Three ways a personal baseline goes wrong

Each is handled, and each costs something.

### 1 · Contamination

If the window used to learn "normal" contains the patient's illness, the
baseline encodes the illness — and the system goes quiet exactly when it should
not.

`refreshTwin` builds an exclusion list from open emergencies and the hour
either side of every critical alert, and those samples are dropped.
`excluded_samples` is stored, so a clinician can see the baseline describes the
patient *well* rather than unwell.

### 2 · Drift absorption

**The failure mode that makes naive adaptive baselines dangerous.** A resting
heart rate rising 1 BPM a day is the signal a monitoring platform exists to
catch — and a baseline that keeps up with it will never report it, because
every day looks normal against the day before.

So the baseline window is **anchored**: 30 days ending 48 hours ago. The gap is
the point. `lib/health/deterioration.ts` then compares the recent window
against that anchor, across the gap, so a shift cannot cancel itself.

### 3 · Too little data

Six readings produce a confident-looking range that means nothing.
`computeBaseline` returns `null` below 200 samples **or** below 3 distinct
days — both floors, because 500 readings inside one afternoon is a dense sample
of one afternoon rather than a description of a person.

---

## Why median and percentiles, not mean and standard deviation

Vital-sign distributions are skewed and contain artefacts that survive the
device-side filter. One 180 BPM sample from a shifted sensor moves a mean; it
moves a median by nothing.

And an interval built from the 10th and 90th percentiles describes **where this
patient's readings actually fell** — a checkable claim — rather than where a
Gaussian says they should have.

Deviation is measured in **interquartile ranges**, which makes it scale-free: a
reading of 90 BPM is a bigger event for a patient whose heart rate never moves
than for one whose readings swing. That is the entire point of personalising.

A floor on the spread (`minimumSpread`) stops a patient whose SpO₂ reads 98
every time from registering an infinite deviation at 97 — below the sensor's
resolution, a difference is the instrument rather than the person.

---

## Detecting decline over days

`ai_engine/prediction/trends.py` watches 15-minute windows and catches a
desaturation while it happens. `lib/health/deterioration.ts` answers a harder
question: **is this patient slowly getting worse?**

The two need opposite instruments. A five-day decline is invisible at 15-minute
resolution — every window inside it looks flat — and only appears when each day
is reduced to one number and the days are compared.

| Guard | Why |
|---|---|
| **Daily median, not mean** | One bout of exercise would otherwise become the day |
| **≥ 4 days** | Fewer is two points and a line drawn between them |
| **≥ 20 readings per day** | A day too thin to summarise contributes no point |
| **Material slope AND fit ≥ 0.5** | A steep slope through scattered points is not a trend; a beautifully-fitted 0.05 BPM/day is not worth saying |
| **Direction matters per channel** | Rising SpO₂ is a rise and is good news |

A steady channel still returns a trend. The absence of decline is a finding a
clinician wants, and a panel that only ever shows problems cannot be used to
confirm there are none.

---

## The tables

| Table | Holds | Written by |
|---|---|---|
| `patient_baselines` | What this patient's vitals usually look like | Worker, hourly |
| `health_trends` | Direction per metric, with the fit | Worker, hourly |
| `risk_events` | The patient's story, in sequence | Worker and ingest |

**Baselines are append-only.** A superseded baseline is *what the system
believed at the time*, and explanations reference it — when a clinician asks
why AVERIS said a patient was 45% above normal last Tuesday, the answer has to
be Tuesday's baseline, not one recomputed today from data that now includes
Tuesday.

**`risk_events` is deliberately not `emergency_events`.** An emergency is
something a person must respond to *now* and lives in a queue that empties. A
risk event is something that happened and is worth seeing in order; most need
no response at all. Merging them would either fill the response queue with
history or bury the history inside a queue nobody reads once cleared — and
"how did this patient get here?" has to survive the first being dealt with.

---

## Where the work happens

```
ingest (every 2s)  ──▶  readings
                          │
worker (hourly)  ─────────┴──▶  refreshTwin()
                                  ├─ computeBaseline()   30d window, anchored, contamination excluded
                                  ├─ detectDeterioration()  daily medians → slope + fit
                                  └─ writes baseline, trends, risk events (only when changed)
                          │
page load  ───────────────┴──▶  loadVitalsTwin()   reads; computes nothing
```

Recomputing on the ingest path would put a 20,000-row scan behind every uplink
— the one code path that must stay fast, because a slow ingest is a reading
that arrives late. Recomputing on page load would make dashboard speed a
function of how long the patient has been monitored.

The sweep is scoped to patients with readings in the last 48 hours: a patient
with nothing new has nothing to learn from, and sweeping the whole table would
make the job's cost a function of how many people *ever* used AVERIS.

---

## Rural connectivity

Rural connectivity is not a link that is up or down. It is a few minutes an
hour.

### Readings survive a power cycle

RAM is gone at reset, and a band on a village supply gets reset. The buffer is
mirrored into **NVS**, the ESP32's wear-levelled flash, and restored at boot.

Persisted every 30 seconds rather than per reading: NVS is wear-levelled but
not free, and writing 90 entries every two seconds would burn the partition in
weeks. The trade is at most fifteen readings lost to a brownout.

### One connection, not ninety

`POST /api/device/batch` takes up to 240 readings in one request.

**The win is connections, not payload size.** One TLS handshake costs several
kilobytes and a second or two of radio time; ninety uplinks pay that ninety
times, and on a battery the radio is the expensive part by a wide margin. That
is also why the endpoint takes plain JSON rather than a compressed format —
compression would save a few hundred bytes on a request whose cost is dominated
by setting it up, in exchange for a format nobody can read with `curl` when a
band in a village is misbehaving.

A batch is a convenience for the radio, **never a shortcut through the
pipeline**: every reading is validated, evaluated and escalated identically. A
malformed reading is counted and skipped rather than costing the batch, and the
endpoint answers **207** when some were rejected — so a band does not clear a
buffer it should have kept.

---

## Multi-language insights

**Translation is composition, not machine translation.**

Health findings are structured — a channel, two numbers, a direction — so the
language layer renders them from templates. A model asked to translate *"blood
oxygen fell to 88%, below the 90% escalation threshold"* can drop a negation,
swap two numbers, or soften "below", and nobody in the loop reads both
languages well enough to catch it.

A template cannot lose a number, because the number is a parameter rather than
a token in a sentence being rewritten. `renderDeviation` takes structure and
the test suite asserts both numbers and the direction survive in every locale.

| Decision | Reason |
|---|---|
| English and Hindi complete; 8 more locales scaffolded | `missingKeys()` fails CI on an untranslated string |
| Whole sentences per locale, not fragments | Hindi is subject-object-verb; concatenated fragments read as a machine |
| Western Arabic numerals in Hindi | Devanagari numerals are correct Hindi and are not what a clinician reading a chart expects |
| Unknown key renders as `[key]` | A blank line in a health insight is indistinguishable from a finding with nothing to say |
| Missing translation falls back to English | A Hindi user seeing one English sentence is a gap; an error page is an outage |

The not-a-diagnosis and emergency-guidance lines are asserted present in every
locale. A language in which AVERIS forgets to say it does not diagnose is a
language in which it implies it does.

---

## What this does not do

- **No model is trained on patient data.** A baseline is descriptive
  statistics over one person's own readings — there is no learning across
  patients, no shared model, and nothing leaves the patient's own row.
- **No prediction of *when*.** "Blood oxygen has fallen 1.4% a day for five
  days" is a description. "This patient will deteriorate on Thursday" would
  require outcome data AVERIS does not have.
- **No baseline for a channel the device does not report.** A chest strap with
  no thermometer gets no temperature baseline rather than an invented one.
- **No clinical validation.** The thresholds that decide when a deviation is
  "notable" (1.5 and 3 interquartile ranges) are the conventional outlier
  fences. They decide what is *said*, never what is escalated.

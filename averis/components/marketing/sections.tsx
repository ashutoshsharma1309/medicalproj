import Link from "next/link";
import { Wordmark } from "@/components/brand/Logo";
import { ButtonLink } from "@/components/ui";

/**
 * The landing page.
 *
 * ── What this page is allowed to claim ─────────────────────────────────────
 *
 * Every number on it is a fact about the *system* — a sampling rate, a test
 * count, an architectural property — and none is a claim about clinical
 * performance. AVERIS has no outcome data: nobody has measured how often its
 * risk assessments are right, because doing so requires following patients and
 * comparing against what actually happened.
 *
 * So there is no accuracy figure, no sensitivity, no specificity, and no
 * "detects deterioration N hours earlier". Those are the numbers that would
 * make the strongest slide and the ones this product has not earned. What it
 * has earned is a different claim, which the page makes instead: that
 * everything it reports can be traced back to a measurement.
 *
 * The one metric that is *about* the models — the cohorts they were fitted on
 * — is stated as a limitation rather than a feature, in the same section as
 * the technology.
 */

/* ------------------------------------------------------------------ Header */

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-paper/90 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Wordmark />
        <nav className="hidden items-center gap-7 text-[14px] text-ink-soft md:flex">
          <a href="#problem" className="hover:text-brand">The problem</a>
          <a href="#how-it-works" className="hover:text-brand">How it works</a>
          <a href="#technology" className="hover:text-brand">Technology</a>
          <a href="#impact" className="hover:text-brand">Impact</a>
          <a href="#security" className="hover:text-brand">Security</a>
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/login" className="btn btn-ghost">Sign in</Link>
          <ButtonLink href="/signup">Get started</ButtonLink>
        </div>
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------- Hero */

export function Hero() {
  return (
    <section className="section">
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 lg:grid-cols-[1.05fr_0.95fr]">
        <div>
          <p className="eyebrow">AI-powered remote patient monitoring</p>
          <h1 className="mt-4 text-[clamp(2.1rem,4.6vw,3.35rem)] leading-[1.08] font-semibold">
            Early risk prediction for people nobody is watching.
          </h1>
          <p className="mt-5 max-w-xl text-[16.5px] leading-relaxed text-ink-soft">
            A wearable streams heart rate, blood oxygen, temperature and movement to AVERIS.
            An AI engine reads the pattern, not just the numbers — and when something crosses
            a line, the right person hears about it within seconds.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <ButtonLink href="/signup">Get started</ButtonLink>
            <ButtonLink href="#how-it-works" variant="secondary">
              See how it works
            </ButtonLink>
          </div>

          <p className="mt-5 text-[13.5px] leading-relaxed text-muted">
            AVERIS reports measurements and the thresholds they crossed. It does not diagnose.
          </p>
        </div>

        {/* The product's actual claim, rendered as the thing it is: a chain
            from sensor to clinician where every link is inspectable. A hero
            image of a dashboard would say "we made a dashboard". */}
        <div className="surface p-7">
          <p className="eyebrow">Sensor to clinician</p>
          <ol className="mt-5 space-y-4">
            {[
              ["ESP32 wearable", "MAX30102 · MLX90614 · MPU6050, sampled at 20 Hz"],
              ["Filtered on the device", "One artefact never becomes a reading"],
              ["FastAPI ingest", "Token-authenticated, owner read from the device row"],
              ["AI engine", "Anomalies, trends, falls — over a window, not a value"],
              ["Escalation", "Event raised and care team notified in one transaction"],
              ["Clinician", "Sorted by who needs attention, not by name"],
            ].map(([title, detail], index) => (
              <li key={title} className="flex gap-3.5">
                <span
                  aria-hidden="true"
                  className="mono mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-rule text-[11px] text-muted"
                >
                  {index + 1}
                </span>
                <span>
                  <span className="block text-[14.5px] font-medium">{title}</span>
                  <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">
                    {detail}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- Problem */

export function Problem() {
  return (
    <section id="problem" className="section border-t border-rule bg-surface">
      <div className="mx-auto max-w-6xl px-6">
        <p className="eyebrow">The gap</p>
        <h2 className="mt-3 max-w-3xl text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight">
          Monitoring stops at the hospital door.
        </h2>

        <div className="mt-10 grid gap-8 md:grid-cols-3">
          {[
            {
              title: "Deterioration is gradual",
              body: "The hours before an emergency usually contain a signal — oxygen easing down, heart rate creeping up. Every individual reading can still sit inside the normal range, so nothing looks wrong until it is.",
            },
            {
              title: "Nobody is measuring at home",
              body: "An elderly patient living alone, a rural household hours from a clinic, someone discharged after a cardiac event. The period with the least observation is often the one with the most risk.",
            },
            {
              title: "An alarm nobody hears is not an alarm",
              body: "Consumer wearables notify the wearer. If that person has collapsed, the notification reaches the one participant who cannot act on it.",
            },
          ].map((item) => (
            <div key={item.title}>
              <h3 className="text-[16px] font-semibold">{item.title}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- Solution */

export function HowItWorks() {
  return (
    <section id="how-it-works" className="section border-t border-rule">
      <div className="mx-auto max-w-6xl px-6">
        <p className="eyebrow">The platform</p>
        <h2 className="mt-3 max-w-3xl text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight">
          A wearable, an engine that reads trends, and somebody who answers.
        </h2>

        <div className="mt-10 grid gap-x-10 gap-y-9 md:grid-cols-2">
          {[
            {
              step: "01",
              title: "The band measures continuously",
              body: "Heart rate and SpO₂ from a MAX30102, skin temperature from an MLX90614, motion from an MPU6050 at 20 Hz — fast enough that the impact phase of a fall does not fall between samples.",
            },
            {
              step: "02",
              title: "The device decides what is worth sending",
              body: "A finger shifting on a sensor produces a plausible, wrong number. The band filters it out and sends nothing rather than something — a gap on a chart is honest, a wrong reading is indistinguishable from a real one forever.",
            },
            {
              step: "03",
              title: "AVERIS analyses the window",
              body: "Threshold rules fire immediately. The AI engine looks across hours, which is how it catches a decline in which no single reading was ever abnormal.",
            },
            {
              step: "04",
              title: "The right person is told",
              body: "A critical finding becomes an event that stays in a clinician's queue until somebody responds. Raising it and notifying the care team happen in one transaction — there is no state where the event exists and nobody was told.",
            },
            {
              step: "05",
              title: "The patient decides who can see",
              body: "Doctors and caregivers get access because the patient granted it, at one of three levels, withdrawable at any time. The database enforces it, not the interface.",
            },
            {
              step: "06",
              title: "Every number can be taken apart",
              body: "A risk score arrives with the measurements that produced it and their exact shares. A number nobody can check is a number nobody should act on.",
            },
          ].map((item) => (
            <div key={item.step} className="flex gap-5">
              <span className="mono text-[12px] text-brass">{item.step}</span>
              <div>
                <h3 className="text-[16px] font-semibold">{item.title}</h3>
                <p className="mt-1.5 text-[14.5px] leading-relaxed text-ink-soft">{item.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- Technology */

export function Technology() {
  return (
    <section id="technology" className="section border-t border-rule bg-surface">
      <div className="mx-auto max-w-6xl px-6">
        <p className="eyebrow">Technology</p>
        <h2 className="mt-3 max-w-3xl text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight">
          Four runtimes, one contract between them.
        </h2>

        <div className="mt-10 grid gap-8 md:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: "IoT",
              items: ["ESP32 · Arduino C++", "MAX30102 · MLX90614 · MPU6050", "WiFi HTTP · BLE read-only", "Offline buffering with original timestamps"],
            },
            {
              label: "AI / ML",
              items: ["Rule engine over sensor windows", "Anomaly detection · trend analysis", "Logistic models with exact SHAP", "Language models phrase, never compute"],
            },
            {
              label: "Cloud",
              items: ["Next.js 16 · Server Components", "FastAPI ingest · websockets", "Postgres · pgvector · Realtime", "Docker · GitHub Actions · Cloud Run"],
            },
            {
              label: "Security",
              items: ["Row Level Security on every table", "Hashed device tokens", "Audit trail on every chart opened", "No service-role key in the web app"],
            },
          ].map((group) => (
            <div key={group.label}>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-brand">
                {group.label}
              </p>
              <ul className="mt-3 space-y-2">
                {group.items.map((item) => (
                  <li key={item} className="text-[14px] leading-relaxed text-ink-soft">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Stated here, on the technology section, rather than buried. A
            product that names its own limits is easier to believe about
            everything else. */}
        <div className="mt-10 rounded-lg border border-rule bg-paper px-6 py-5">
          <p className="text-[14px] font-semibold">What this is not</p>
          <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-ink-soft">
            AVERIS is a monitoring platform, not a diagnostic device. The wearable is a
            prototype: its SpO₂ conversion is the sensor datasheet&rsquo;s generic curve
            rather than a calibration against a reference oximeter, and it reports skin
            temperature rather than core temperature. The risk models are fitted on public
            research cohorts that do not transfer cleanly to an arbitrary patient, and the
            interface shows each cohort beside its number for that reason.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- Metrics */

export function Metrics() {
  return (
    <section className="section border-t border-rule">
      <div className="mx-auto max-w-6xl px-6">
        <p className="eyebrow">By the numbers</p>
        <h2 className="mt-3 text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight">
          Facts about the system, not claims about outcomes.
        </h2>
        <p className="mt-3 max-w-2xl text-[14.5px] leading-relaxed text-ink-soft">
          There is no accuracy figure here, and that is deliberate. Measuring how often a risk
          assessment is right means following patients and comparing against what actually
          happened, and nobody has done that yet. These are properties anyone can verify from
          the repository.
        </p>

        <dl className="mt-10 grid gap-x-8 gap-y-9 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["24/7", "Continuous monitoring", "A reading every two seconds while the band is worn"],
            ["< 1s", "Alert to clinician", "Threshold evaluation, escalation and notification are one transaction"],
            ["20 Hz", "Motion sampling", "Fast enough that a fall's impact phase is not missed between samples"],
            ["670", "Automated checks", "Across TypeScript, Python and the firmware — every one runs in CI"],
            ["237", "Database security assertions", "Executed against the unmodified production migrations"],
            ["30", "Tables, all with Row Level Security", "Enforced in Postgres, not in the interface"],
            ["3 min", "Offline buffer", "Readings replay with their original timestamps, so a gap fills in"],
            ["0", "Patient data in logs", "An allowlist refuses the fields, rather than trusting call sites"],
          ].map(([value, label, detail]) => (
            <div key={label}>
              <dt className="mono text-[30px] font-semibold leading-none tabular-nums">
                {value}
              </dt>
              <dd className="mt-2 text-[14.5px] font-medium">{label}</dd>
              <dd className="mt-1 text-[13px] leading-relaxed text-muted">{detail}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ Impact */

export function Impact() {
  return (
    <section id="impact" className="section border-t border-rule bg-surface">
      <div className="mx-auto max-w-6xl px-6">
        <p className="eyebrow">Who this is for</p>
        <h2 className="mt-3 max-w-3xl text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight">
          The people between appointments.
        </h2>

        <div className="mt-10 grid gap-8 md:grid-cols-3">
          {[
            {
              title: "Elderly care",
              body: "Someone living alone, where a fall is dangerous mostly because of how long it takes for anyone to know. The band detects the impact and the stillness that follows, and reaches a family member who is not in the building.",
            },
            {
              title: "Rural healthcare",
              body: "Where the nearest clinician is hours away, the decision that matters is whether to travel. A chart showing six hours of measurements makes that a decision rather than a guess.",
            },
            {
              title: "Post-discharge monitoring",
              body: "The days after leaving hospital carry real risk and almost no observation. Continuous vitals turn a follow-up appointment in two weeks into a signal that arrives on the day it changes.",
            },
          ].map((item) => (
            <div key={item.title}>
              <h3 className="text-[16px] font-semibold">{item.title}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ Architecture */

export function Architecture() {
  return (
    <section className="section border-t border-rule">
      <div className="mx-auto max-w-6xl px-6">
        <p className="eyebrow">Architecture</p>
        <h2 className="mt-3 text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight">
          One pipeline. The simulator and the band are both clients of it.
        </h2>
        <p className="mt-3 max-w-2xl text-[14.5px] leading-relaxed text-ink-soft">
          The wire contract was written before the hardware existed, so replacing the
          simulator with an ESP32 changed nothing else in the system. That is the property
          the whole build was arranged around.
        </p>

        <div className="mt-8 overflow-x-auto rounded-lg border border-rule bg-field p-7">
          <pre className="mono text-[12px] leading-[1.85] text-field-text">
{`  ESP32 wearable                          Browser
  MAX30102 · MLX90614 · MPU6050              │
  OLED · buzzer · LiPo                       │
        │                                    │
        │  HTTPS + bearer token              │
        ▼                                    ▼
  FastAPI ingest  ────────────────▶   Next.js (Cloud Run)
  validate · alert · escalate                │        │
        │            ▲                       │        └──▶ Redis
        │            │ service role          │  RLS, as the signed-in user
        ▼            │                       ▼
     Supabase  ◀─────┴──── Worker  ──▶  Groq / xAI
     Postgres · pgvector · Auth · Storage · Realtime
        │
        ▼
  AI engine (Python)  ──▶  risk · anomalies · falls
        │
        ▼
  Emergency event  ──▶  doctor · caregiver  (one transaction)`}
          </pre>
        </div>

        <p className="mt-4 max-w-3xl text-[13.5px] leading-relaxed text-muted">
          The web application never holds a service-role key. It queries Postgres as the
          signed-in user, so a bug in a page cannot reach a chart the policy would refuse —
          the page has no credential that bypasses the policy.
        </p>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- Security */

export function Security() {
  return (
    <section id="security" className="section border-t border-rule bg-surface">
      <div className="mx-auto max-w-6xl px-6">
        <p className="eyebrow">Security and privacy</p>
        <h2 className="mt-3 max-w-3xl text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight">
          Access is decided by the database, not the interface.
        </h2>

        <div className="mt-10 grid gap-8 md:grid-cols-2">
          {[
            {
              title: "One patient cannot reach another's record",
              body: "Every table carries Row Level Security, and 237 assertions run against the real migrations in CI. A policy change that opens a hole fails the build.",
            },
            {
              title: "The patient grants access, and withdraws it",
              body: "A clinician sees a chart because the patient assigned them. Revocation takes effect on the next query, across every table, and the record of who had access stays so the past remains explicable.",
            },
            {
              title: "Devices authenticate, and cannot impersonate",
              body: "A token is stored only as a SHA-256 hash. The owner of a reading is read from the device row, never from the payload — there is no field on the wire that could name a different patient.",
            },
            {
              title: "Logs carry identifiers, never content",
              body: "An allowlist refuses the fields most likely to leak, rather than trusting each call site. A log line outlives every control on the data it copied.",
            },
          ].map((item) => (
            <div key={item.title}>
              <h3 className="text-[16px] font-semibold">{item.title}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- Demo */

export function DemoSection() {
  return (
    <section className="section border-t border-rule">
      <div className="mx-auto max-w-6xl px-6">
        <p className="eyebrow">See it work</p>
        <h2 className="mt-3 max-w-3xl text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight">
          Five minutes, from a resting pulse to a clinician&rsquo;s queue.
        </h2>
        <p className="mt-3 max-w-2xl text-[14.5px] leading-relaxed text-ink-soft">
          The demonstration drives the production pipeline — same endpoint, same
          authentication, same rules. Nothing is seeded, and every reading it produces is
          permanently marked as generated so it can never be mistaken for a measurement.
        </p>

        <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            "A wearable connects and authenticates",
            "Live vitals appear on the patient's screen",
            "The AI engine scores the window",
            "A threshold is crossed and an alert is raised",
            "An emergency reaches the clinician's queue",
            "AVERIS explains which measurements produced it",
          ].map((step, index) => (
            <li key={step} className="flex gap-3 rounded-lg border border-rule px-4 py-3.5">
              <span className="mono text-[12px] text-brass">{`0${index + 1}`}</span>
              <span className="text-[14px] leading-relaxed">{step}</span>
            </li>
          ))}
        </ol>

        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink href="/signup">Create an account</ButtonLink>
          <ButtonLink href="/login" variant="secondary">Sign in</ButtonLink>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- Closing */

export function FinalCta() {
  return (
    <section className="section border-t border-rule bg-field">
      <div className="mx-auto max-w-4xl px-6 text-center">
        <h2 className="text-[clamp(1.7rem,3.2vw,2.4rem)] font-semibold leading-tight text-field-bright">
          AVERIS does not only detect risk. It connects the people who can act on it.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-[15.5px] leading-relaxed text-field-text">
          Patients, caregivers and clinicians on one platform, with every number traceable to
          the measurement that produced it.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/signup" variant="onfield">Get started</ButtonLink>
          <Link href="/login" className="btn btn-onfield">Sign in</Link>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ Footer */

export function SiteFooter() {
  return (
    <footer className="bg-field py-12 text-field-text">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex flex-wrap items-start justify-between gap-8">
          <div>
            <Wordmark tone="light" href={null} />
            <p className="mt-4 max-w-sm text-[13.5px] leading-relaxed">
              AI-powered IoT healthcare monitoring and early risk prediction. AVERIS reports
              measurements and the thresholds they crossed — it does not diagnose.
            </p>
          </div>
          <nav className="flex gap-14 text-[13.5px]">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-field-bright">
                Platform
              </p>
              <ul className="mt-3 space-y-2">
                <li><a href="#how-it-works" className="hover:text-field-bright">How it works</a></li>
                <li><a href="#technology" className="hover:text-field-bright">Technology</a></li>
                <li><a href="#impact" className="hover:text-field-bright">Impact</a></li>
                <li><a href="#security" className="hover:text-field-bright">Security</a></li>
              </ul>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-field-bright">
                Account
              </p>
              <ul className="mt-3 space-y-2">
                <li><Link href="/signup" className="hover:text-field-bright">Get started</Link></li>
                <li><Link href="/login" className="hover:text-field-bright">Sign in</Link></li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="mt-10 border-t border-field-rule pt-6 font-mono text-[10.5px] uppercase tracking-[0.13em]">
          AVERIS · Remote patient monitoring · Prototype hardware, not a certified medical
          device · Not a substitute for professional medical advice
        </div>
      </div>
    </footer>
  );
}

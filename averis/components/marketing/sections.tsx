import Link from "next/link";
import { Wordmark } from "@/components/brand/Logo";
import { ButtonLink } from "@/components/ui";
import { HealthIdentityCard } from "@/components/health/HealthIdentityCard";

/* ------------------------------------------------------------------ Header */

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-paper/90 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Wordmark />
        <nav className="hidden items-center gap-7 text-[14px] text-ink-soft md:flex">
          <a href="#how-it-works" className="hover:text-brand">How it works</a>
          <a href="#benefits" className="hover:text-brand">Benefits</a>
          <a href="#security" className="hover:text-brand">Security</a>
          <a href="#roadmap" className="hover:text-brand">Roadmap</a>
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/login" className="btn btn-ghost">Sign in</Link>
          <ButtonLink href="/signup">Create profile</ButtonLink>
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
          <p className="eyebrow">Patient health platform</p>
          <h1 className="mt-4 text-[clamp(2.1rem,4.6vw,3.35rem)] leading-[1.08] font-semibold">
            Your intelligent healthcare journey starts here.
          </h1>
          <p className="mt-5 max-w-xl text-[16.5px] leading-relaxed text-ink-soft">
            AVERIS helps patients organize their health information and create a personalized
            healthcare profile — one accurate record of your conditions, medications and
            allergies that you own and control.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <ButtonLink href="/signup">Create Your AVERIS Profile</ButtonLink>
            <ButtonLink href="/login" variant="secondary">I already have an account</ButtonLink>
          </div>
          <p className="mt-5 text-[13.5px] text-muted">
            Free to create · Takes about three minutes · Your data is never sold
          </p>
        </div>

        <div className="flex justify-center lg:justify-end">
          <HealthIdentityCard
            specimen
            identity={{
              fullName: "Ananya Krishnan",
              averisId: "AV-7F2C-91B4-0A3D",
              bloodGroup: "B+",
              dateOfBirth: "14 Mar 1991",
              age: 35,
              issuedOn: "2026",
              allergyCount: 2,
            }}
          />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ How it works */

const STEPS = [
  {
    n: "01",
    title: "Create your account",
    body: "Sign up with an email address or continue with Google. Your account is yours alone — AVERIS never shares it with a clinic or insurer.",
  },
  {
    n: "02",
    title: "Complete your health profile",
    body: "A short guided form captures your personal details, blood group, allergies, existing conditions and current medications.",
  },
  {
    n: "03",
    title: "Carry one accurate record",
    body: "Your health identity is assembled and kept current in one place, ready whenever a clinician needs an accurate picture of you.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="section rule-top bg-surface">
      <div className="mx-auto max-w-6xl px-6">
        <p className="eyebrow">How AVERIS works</p>
        <h2 className="mt-3 max-w-2xl text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight">
          Three steps to a complete health profile.
        </h2>

        <ol className="mt-12 grid gap-x-10 gap-y-10 md:grid-cols-3">
          {STEPS.map((step) => (
            <li key={step.n} className="border-t border-rule-strong pt-5">
              <span className="mono text-[13px] font-medium text-brand">{step.n}</span>
              <h3 className="mt-2 text-[17px] font-semibold">{step.title}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- Benefits */

const BENEFITS = [
  {
    title: "Nothing important gets forgotten",
    body: "Allergies, conditions and medications live in one record instead of scattered across appointments, apps and paperwork.",
  },
  {
    title: "Answer intake questions once",
    body: "Stop reconstructing your medical history from memory in a waiting room. Your profile is already accurate and up to date.",
  },
  {
    title: "Safer conversations with clinicians",
    body: "A clinician who can see your full picture — including what you react badly to — makes better and faster decisions.",
  },
  {
    title: "A record that follows you",
    body: "Change city, clinic or country and your health identity comes with you. It belongs to you, not to a provider.",
  },
];

export function Benefits() {
  return (
    <section id="benefits" className="section rule-top">
      <div className="mx-auto max-w-6xl px-6">
        <p className="eyebrow">Why patients use AVERIS</p>
        <h2 className="mt-3 max-w-2xl text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight">
          Built around what patients actually struggle with.
        </h2>

        <div className="mt-12 grid gap-x-12 gap-y-9 md:grid-cols-2">
          {BENEFITS.map((b) => (
            <div key={b.title} className="border-t border-rule-strong pt-5">
              <h3 className="text-[17px] font-semibold">{b.title}</h3>
              <p className="mt-2 max-w-lg text-[14.5px] leading-relaxed text-ink-soft">{b.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- Security */

const SECURITY = [
  {
    title: "Only you can read your record",
    body: "Access rules are enforced in the database itself, on every single query — not just in the interface. A request for someone else's record returns nothing.",
  },
  {
    title: "Encrypted in transit",
    body: "Every connection between your browser and AVERIS is encrypted, and session cookies are inaccessible to page scripts.",
  },
  {
    title: "No selling, no ad targeting",
    body: "Your health information is never sold, rented or used to target advertising. It exists to serve your care.",
  },
  {
    title: "You control what is stored",
    body: "You decide what goes into your profile, and you can correct or update any part of it at any time.",
  },
];

export function Security() {
  return (
    <section id="security" className="section bg-field text-field-bright">
      <div className="mx-auto max-w-6xl px-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-field-text">
          Security and privacy
        </p>
        <h2 className="mt-3 max-w-2xl text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight text-field-bright">
          Health data deserves more than a promise.
        </h2>
        <p className="mt-4 max-w-2xl text-[15.5px] leading-relaxed text-field-text">
          AVERIS is built so that a mistake in the application cannot expose your record.
          Authorization lives in the database, closest to the data.
        </p>

        <div className="mt-12 grid gap-x-12 gap-y-9 md:grid-cols-2">
          {SECURITY.map((s) => (
            <div key={s.title} className="border-t border-field-rule pt-5">
              <h3 className="text-[16.5px] font-semibold text-field-bright">{s.title}</h3>
              <p className="mt-2 max-w-lg text-[14.5px] leading-relaxed text-field-text">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- Roadmap */

const ROADMAP = [
  {
    title: "Medical document analysis",
    body: "Upload a prescription or lab report and have the details read out and added to your profile — with your review before anything is saved.",
  },
  {
    title: "Health timeline",
    body: "Your conditions, treatments and results arranged over time, so change is visible at a glance.",
  },
  {
    title: "Personal health insights",
    body: "Risk signals explained in plain language, always showing which parts of your record drove them.",
  },
];

export function Roadmap() {
  return (
    <section id="roadmap" className="section rule-top bg-surface">
      <div className="mx-auto max-w-6xl px-6">
        <p className="eyebrow">What comes next</p>
        <h2 className="mt-3 max-w-2xl text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight">
          A health profile today. Health intelligence next.
        </h2>
        <p className="mt-4 max-w-2xl text-[15.5px] leading-relaxed text-ink-soft">
          A complete, accurate profile is the foundation everything else is built on. These
          capabilities are in development — they are not available yet, and AVERIS will not
          pretend otherwise.
        </p>

        <div className="mt-12 grid gap-x-12 gap-y-9 md:grid-cols-3">
          {ROADMAP.map((r) => (
            <div key={r.title} className="border-t border-rule-strong pt-5">
              <span className="chip">In development</span>
              <h3 className="mt-3 text-[17px] font-semibold">{r.title}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">{r.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- Final CTA */

export function FinalCta() {
  return (
    <section className="section rule-top">
      <div className="mx-auto max-w-3xl px-6 text-center">
        <h2 className="text-[clamp(1.7rem,3.2vw,2.4rem)] font-semibold leading-tight">
          Start with the part that matters most: an accurate record.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-[15.5px] leading-relaxed text-ink-soft">
          Creating your AVERIS profile takes about three minutes, and you can update it whenever
          something changes.
        </p>
        <div className="mt-8 flex justify-center">
          <ButtonLink href="/signup">Create Your AVERIS Profile</ButtonLink>
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
              AVERIS helps patients organize their health information into a personalized
              healthcare profile they own.
            </p>
          </div>
          <nav className="flex gap-14 text-[13.5px]">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-field-bright">
                Product
              </p>
              <ul className="mt-3 space-y-2">
                <li><a href="#how-it-works" className="hover:text-field-bright">How it works</a></li>
                <li><a href="#benefits" className="hover:text-field-bright">Benefits</a></li>
                <li><a href="#roadmap" className="hover:text-field-bright">Roadmap</a></li>
              </ul>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-field-bright">
                Account
              </p>
              <ul className="mt-3 space-y-2">
                <li><Link href="/signup" className="hover:text-field-bright">Create profile</Link></li>
                <li><Link href="/login" className="hover:text-field-bright">Sign in</Link></li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="mt-10 border-t border-field-rule pt-6 font-mono text-[10.5px] uppercase tracking-[0.13em]">
          AVERIS · Health information platform · Not a substitute for professional medical advice
        </div>
      </div>
    </footer>
  );
}

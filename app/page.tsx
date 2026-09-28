import { CareBridgeShell } from "@/components/carebridge/CareBridgeShell";
import { PrimaryButton } from "@/components/carebridge/PrimaryButton";
import { SecondaryButton } from "@/components/carebridge/SecondaryButton";
import { IconChevronRight, IconInfo } from "@/components/carebridge/icons";

const STEPS = [
  {
    title: "Tell us what you're experiencing",
    body: "Describe your symptoms in your own words, the way you'd explain them to a friend.",
  },
  {
    title: "Answer a few relevant questions",
    body: "CareBridge asks focused follow-up questions to understand your situation — nothing more than it needs.",
  },
  {
    title: "Get a structured health summary",
    body: "Review a clear summary of what was discussed, plus a doctor-ready version you can share.",
  },
];

export default function Home() {
  return (
    <CareBridgeShell>
      <section className="flex flex-col items-center gap-5 py-10 text-center sm:py-16">
        <span className="cb-status cb-status-neutral">CareBridge AI</span>
        <h1 className="max-w-2xl text-[32px] font-semibold leading-tight tracking-tight text-cb-ink sm:text-[40px]">
          Prepare better for your healthcare consultation.
        </h1>
        <p className="max-w-xl text-[15.5px] leading-relaxed text-cb-muted">
          Describe your symptoms naturally. CareBridge asks relevant follow-up questions, organizes
          your information, and prepares a concise summary you can share with a healthcare
          professional.
        </p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          <PrimaryButton href="/assessment" icon={<IconChevronRight />}>
            Start Health Assessment
          </PrimaryButton>
          <SecondaryButton href="#how-it-works">How it works</SecondaryButton>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-20 py-10">
        <h2 className="text-center text-[13px] font-semibold uppercase tracking-wide text-cb-muted">
          How it works
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <div key={step.title} className="cb-card p-5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-cb-primary-wash text-[13px] font-semibold text-cb-primary">
                {i + 1}
              </span>
              <h3 className="mt-3 text-[14.5px] font-semibold text-cb-ink">{step.title}</h3>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-cb-muted">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="cb-card mt-6 flex items-start gap-3 p-4">
        <IconInfo className="mt-0.5 h-5 w-5 shrink-0 text-cb-primary" />
        <p className="text-[13px] leading-relaxed text-cb-muted">
          CareBridge provides informational support and does not replace professional medical
          advice.
        </p>
      </section>
    </CareBridgeShell>
  );
}

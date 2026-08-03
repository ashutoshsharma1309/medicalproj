import { Wordmark } from "@/components/brand/Logo";

const ASSURANCES = [
  "Only you can read your health record",
  "Encrypted in transit, access enforced in the database",
  "Never sold, never used for ad targeting",
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      {/* Institutional panel — reinforces trust at the moment of commitment */}
      <aside className="hidden w-[44%] flex-col justify-between bg-field p-12 lg:flex">
        <Wordmark tone="light" />

        <div>
          <h2
            className="max-w-md text-[clamp(1.7rem,2.4vw,2.15rem)] leading-tight text-field-bright"
            style={{ fontWeight: 600 }}
          >
            One accurate health record, issued to you.
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-field-text">
            AVERIS brings your conditions, medications and allergies into a single profile you
            own — so the people treating you start with the full picture.
          </p>
          <ul className="mt-8 space-y-3">
            {ASSURANCES.map((item) => (
              <li key={item} className="flex items-start gap-3 text-[14.5px] text-field-text">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brass-soft" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-field-text">
          AVERIS · Health information platform
        </p>
      </aside>

      <main id="main" className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Wordmark />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

import { LogoMark } from "@/components/brand/Logo";

export type HealthIdentity = {
  fullName: string;
  averisId: string;
  bloodGroup: string;
  dateOfBirth: string;
  age: number | null;
  issuedOn: string;
  allergyCount: number;
};

/**
 * The AVERIS Health Identity — the product's signature artifact.
 *
 * Rendered from one typed contract so the landing page can show a specimen
 * and the dashboard can show the patient's real record with identical markup.
 * The guilloché engraving and brass foil come from `.identity-card` in
 * globals.css and evoke an officially issued document.
 */
export function HealthIdentityCard({
  identity,
  specimen = false,
}: {
  identity: HealthIdentity;
  specimen?: boolean;
}) {
  return (
    <article
      className="identity-card w-full max-w-[420px] p-6"
      aria-label={specimen ? "Specimen AVERIS health identity card" : "Your AVERIS health identity"}
    >
      <header className="flex items-start justify-between gap-4">
        <span className="flex items-center gap-2">
          <LogoMark className="h-6 w-6 text-brass-soft" />
          <span>
            <span
              className="block font-display text-[13px] tracking-[0.18em] text-field-bright"
              style={{ fontWeight: 700 }}
            >
              AVERIS
            </span>
            <span className="block font-mono text-[8.5px] uppercase tracking-[0.2em] text-field-text">
              Health Identity
            </span>
          </span>
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-brass-soft">
          {specimen ? "Specimen" : "Issued"}
        </span>
      </header>

      <div className="identity-foil my-5" />

      <div>
        <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-field-text">
          Registered name
        </p>
        <p className="mt-1 font-display text-[21px] leading-tight text-field-bright" style={{ fontWeight: 600 }}>
          {identity.fullName}
        </p>
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-4">
        <div>
          <dt className="font-mono text-[9px] uppercase tracking-[0.16em] text-field-text">Blood</dt>
          <dd className="mono mt-0.5 text-[15px] font-medium text-field-bright">
            {identity.bloodGroup}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[9px] uppercase tracking-[0.16em] text-field-text">
            Date of birth
          </dt>
          <dd className="mono mt-0.5 text-[15px] font-medium text-field-bright">
            {identity.dateOfBirth}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[9px] uppercase tracking-[0.16em] text-field-text">Age</dt>
          <dd className="mono mt-0.5 text-[15px] font-medium text-field-bright">
            {identity.age ?? "—"}
          </dd>
        </div>
      </dl>

      <div className="identity-foil my-5" />

      <footer className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-field-text">
            AVERIS identifier
          </p>
          <p className="mono mt-0.5 text-[13px] tracking-wider text-brass-soft">
            {identity.averisId}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-field-text">
            {identity.allergyCount > 0 ? "Allergies on file" : "Issued"}
          </p>
          <p className="mono mt-0.5 text-[13px] text-field-bright">
            {identity.allergyCount > 0 ? identity.allergyCount : identity.issuedOn}
          </p>
        </div>
      </footer>
    </article>
  );
}

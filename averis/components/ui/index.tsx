import type { ReactNode, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ButtonHTMLAttributes } from "react";
import Link from "next/link";

/* ------------------------------------------------------------------ Button */

type ButtonVariant = "primary" | "secondary" | "onfield" | "ghost";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button className={`btn btn-${variant} ${className}`} {...props} />;
}

export function ButtonLink({
  href,
  variant = "primary",
  className = "",
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={`btn btn-${variant} ${className}`}>
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------------- Field */

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {!required && <span className="ml-1.5 font-normal text-muted">(optional)</span>}
      </label>
      {children}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`field-input ${className}`} {...props} />;
}

export function Select({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`field-input ${className}`} {...props}>
      {children}
    </select>
  );
}

export function TextArea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`field-input ${className}`} {...props} />;
}

/* ------------------------------------------------------------------ Layout */

export function Card({
  children,
  className = "",
  id,
}: {
  children: ReactNode;
  className?: string;
  /** For in-page anchors — "jump to the caseload" from a banner above it. */
  id?: string;
}) {
  return (
    <section id={id} className={`surface ${className}`}>
      {children}
    </section>
  );
}

export function CardHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-rule px-6 py-4">
      <div>
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h2 className="text-[17px] font-semibold">{title}</h2>
      </div>
      {action}
    </header>
  );
}

/* ----------------------------------------------------------------- Callout */

export function Callout({
  tone = "notice",
  title,
  children,
}: {
  tone?: "notice" | "critical" | "positive" | "brand";
  title?: string;
  children: ReactNode;
}) {
  const styles: Record<string, string> = {
    notice: "border-notice-rule bg-notice-wash text-notice",
    critical: "border-critical-rule bg-critical-wash text-critical",
    positive: "border-positive-rule bg-positive-wash text-positive",
    brand: "border-brand bg-wash text-brand-deep",
  };
  return (
    <div className={`rounded-lg border px-4 py-3 text-[14px] leading-relaxed ${styles[tone]}`}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? "mt-0.5" : ""}>{children}</div>
    </div>
  );
}

export function Chip({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "brand" | "critical" | "positive" | "notice";
}) {
  return <span className={`chip${tone === "default" ? "" : ` chip-${tone}`}`}>{children}</span>;
}

/* ------------------------------------------------------- Definition list */

export function DataPoint({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className={`mt-1 text-[15px] font-medium ${mono ? "mono" : ""}`}>{value}</dd>
    </div>
  );
}

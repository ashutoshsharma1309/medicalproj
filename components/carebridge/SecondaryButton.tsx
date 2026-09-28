import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type CommonProps = {
  children: ReactNode;
  icon?: ReactNode;
  href?: string;
  className?: string;
  tone?: "secondary" | "ghost";
};

type Props = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

/** A lower-emphasis action alongside a PrimaryButton (e.g. "How it works"). */
export function SecondaryButton({ children, icon, href, className = "", tone = "secondary", ...rest }: Props) {
  const classes = `cb-btn ${tone === "ghost" ? "cb-btn-ghost" : "cb-btn-secondary"} ${className}`;
  if (href) {
    return (
      <Link href={href} className={classes}>
        {icon}
        {children}
      </Link>
    );
  }
  return (
    <button type="button" className={classes} {...rest}>
      {icon}
      {children}
    </button>
  );
}

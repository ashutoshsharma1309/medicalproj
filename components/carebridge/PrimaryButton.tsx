import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type CommonProps = {
  children: ReactNode;
  icon?: ReactNode;
  href?: string;
  className?: string;
};

type Props = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

/** The one high-emphasis call to action per screen (e.g. "Start Health Assessment"). */
export function PrimaryButton({ children, icon, href, className = "", ...rest }: Props) {
  const classes = `cb-btn cb-btn-primary ${className}`;
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

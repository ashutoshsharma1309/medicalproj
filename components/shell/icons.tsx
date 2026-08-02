/** Minimal 16px stroke icon set — deliberately plain, chart-room aesthetic. */
type P = { className?: string };
const base = "h-4 w-4 shrink-0";
const s = (className?: string) => ({
  className: `${base} ${className ?? ""}`,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
});

export const IconGrid = (p: P) => (
  <svg {...s(p.className)}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
);
export const IconUsers = (p: P) => (
  <svg {...s(p.className)}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c.8-3 3-4.5 5.5-4.5S13.7 16 14.5 19" /><circle cx="17" cy="9" r="2.4" /><path d="M16 14.7c2 .3 3.6 1.6 4.3 4" /></svg>
);
export const IconPulse = (p: P) => (
  <svg {...s(p.className)}><path d="M3 12h4l2.5-6 4 12 2.5-6h5" /></svg>
);
export const IconNote = (p: P) => (
  <svg {...s(p.className)}><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4" /><path d="M9 12h7M9 16h7" /></svg>
);
export const IconBook = (p: P) => (
  <svg {...s(p.className)}><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 19a2 2 0 0 1 2-2h13" /></svg>
);
export const IconShield = (p: P) => (
  <svg {...s(p.className)}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9.5 12l2 2 3.5-4" /></svg>
);
export const IconDoc = (p: P) => (
  <svg {...s(p.className)}><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></svg>
);
export const IconGauge = (p: P) => (
  <svg {...s(p.className)}><path d="M4 14a8 8 0 1 1 16 0" /><path d="M12 14l4-4" /><path d="M4 19h16" /></svg>
);
export const IconAudit = (p: P) => (
  <svg {...s(p.className)}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-3.8-3.8" /></svg>
);
export const IconHeart = (p: P) => (
  <svg {...s(p.className)}><path d="M12 20s-7-4.5-9-9c-1.2-2.8.7-6 3.8-6C9 5 10.5 6.5 12 8.5 13.5 6.5 15 5 17.2 5c3.1 0 5 3.2 3.8 6-2 4.5-9 9-9 9z" /></svg>
);

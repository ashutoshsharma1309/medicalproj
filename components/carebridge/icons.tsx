/** CareBridge icon set — same minimal stroke style as components/shell/icons.tsx. */
type P = { className?: string };
const base = "h-4 w-4 shrink-0";
const s = (className?: string) => ({
  className: `${base} ${className ?? ""}`,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
});

export const IconCheckCircle = (p: P) => (
  <svg {...s(p.className)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.3l2.4 2.4 4.6-5.4" />
  </svg>
);
export const IconCircle = (p: P) => (
  <svg {...s(p.className)}>
    <circle cx="12" cy="12" r="9" />
  </svg>
);
export const IconSend = (p: P) => (
  <svg {...s(p.className)}>
    <path d="M4 12l16-8-6.5 16-2.5-6.5L4 12z" />
  </svg>
);
export const IconChevronRight = (p: P) => (
  <svg {...s(p.className)}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);
export const IconAlertTriangle = (p: P) => (
  <svg {...s(p.className)}>
    <path d="M12 3.5l9.5 16.5H2.5z" />
    <path d="M12 9.5v5" />
    <circle cx="12" cy="17.3" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);
export const IconInfo = (p: P) => (
  <svg {...s(p.className)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <circle cx="12" cy="7.6" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);
export const IconUser = (p: P) => (
  <svg {...s(p.className)}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20c1-4 4-6 7.5-6s6.5 2 7.5 6" />
  </svg>
);
export const IconClose = (p: P) => (
  <svg {...s(p.className)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconDownload = (p: P) => (
  <svg {...s(p.className)}>
    <path d="M12 4v11" />
    <path d="M7.5 11.5L12 16l4.5-4.5" />
    <path d="M4.5 19h15" />
  </svg>
);
export const IconCopy = (p: P) => (
  <svg {...s(p.className)}>
    <rect x="9" y="9" width="11" height="11" rx="1.5" />
    <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
  </svg>
);
export const IconRefresh = (p: P) => (
  <svg {...s(p.className)}>
    <path d="M4 12a8 8 0 0 1 14-5.3L20 9" />
    <path d="M20 4v5h-5" />
    <path d="M20 12a8 8 0 0 1-14 5.3L4 15" />
    <path d="M4 20v-5h5" />
  </svg>
);

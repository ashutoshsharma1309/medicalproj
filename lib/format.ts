export function ageOf(dob: Date | string): number {
  const d = typeof dob === "string" ? new Date(dob) : dob;
  return Math.floor((Date.now() - d.getTime()) / 31557600000);
}

export function fmtDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDateTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function initials(first: string, last: string) {
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}

export function minutesSince(d: Date | string): number {
  const date = typeof d === "string" ? new Date(d) : d;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
}

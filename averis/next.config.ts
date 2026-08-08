import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Container target for GCP Cloud Run
  output: "standalone",
  outputFileTracingRoot: __dirname,
  reactStrictMode: true,
  poweredByHeader: false,
  // TypeScript 7 ships a native compiler without the Node compiler API that
  // Next.js links against; the TS CLI path is the supported route.
  experimental: {
    useTypeScriptCli: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
          {
            // A year, with subdomains. Only meaningful over HTTPS and harmless
            // otherwise — and the case it exists for is a patient on hospital
            // wifi whose first request would otherwise go out in plaintext.
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            // Microphone is *not* blanket-denied: the voice assistant needs it.
            // Restricted to same-origin so an embedded third party cannot
            // reach it — and X-Frame-Options DENY means there are no embeds.
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
};

/**
 * Content Security Policy.
 *
 * The header that matters most here. AVERIS renders vital signs, medical
 * documents and AI narration; an injected script on any of those pages can
 * read all of it and post it anywhere. `connect-src` is the specific control —
 * even with script execution, exfiltration has to have somewhere to go.
 *
 * ── The compromise, stated rather than hidden ──────────────────────────────
 *
 * `'unsafe-inline'` is present for scripts. Next.js injects an inline
 * bootstrap and inline flight data on every page, and the supported way to
 * avoid it is a per-request nonce generated in middleware — which this project
 * has (`proxy.ts`) and which is the right next step. Until then the policy is
 * honest about being weaker than it looks: it constrains *where* data can go
 * and what can be framed, not whether an injected inline script runs.
 *
 * Styles are inline by necessity — Tailwind v4 and next/font both emit them.
 */
function contentSecurityPolicy(): string {
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

  // The live monitor connects straight to the ingest service's websocket. Its
  // configured value is already a ws:// URL, so it is used as-is rather than
  // being derived — deriving it would guess at a port the deployment chose.
  const iotSocket = process.env.NEXT_PUBLIC_IOT_WS_URL ?? "";

  // Supabase Realtime upgrades the same origin to a websocket, so that one
  // *is* derived — from configuration, never wildcarded.
  const supabaseSocket = supabase ? supabase.replace(/^http/, "ws") : "";

  // The demonstration's "Simulate emergency" button POSTs readings to the
  // ingest service from the browser, exactly as a band does. Without this the
  // CSP blocks that fetch — and it would fail in production while working in
  // development, which is the worst place for a header to differ.
  //
  // Only the origin is allowed, not the path: a CSP source is an origin, and
  // writing the full URL here silently widens it to the whole host anyway.
  const iotHttp = originOf(process.env.NEXT_PUBLIC_IOT_HTTP_URL);

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // Belt and braces with X-Frame-Options: that header is ignored by some
    // browsers when a CSP is present.
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    // blob: is required for the OCR worker; data: for inline SVG and the
    // document previews rendered client-side.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    `connect-src 'self' ${[supabase, supabaseSocket, iotSocket, iotHttp].filter(Boolean).join(" ")}`.trim(),
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * The origin of a configured URL, or "" when it is unset or unparseable.
 *
 * Unparseable resolves to nothing rather than throwing: a typo in an
 * environment variable should not stop the server booting, and a missing CSP
 * source fails visibly at the one feature that needs it.
 */
function originOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export default nextConfig;

"use client";

import { useEffect } from "react";

/**
 * The last boundary.
 *
 * Catches what `app/error.tsx` cannot: a failure in the root layout itself.
 * At that point React has unmounted everything, so this file has to render its
 * own `<html>` and `<body>` — and it cannot import the design system, because
 * whatever broke the layout may be the design system.
 *
 * Hence the inline styles. They are not a shortcut; they are the only thing
 * guaranteed to work here.
 *
 * The reporting call is a bare fetch for the same reason: importing the client
 * reporter would pull in a module graph that may be exactly what failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    void fetch("/api/observability/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "global-error",
        message: error.message,
        digest: error.digest,
      }),
      keepalive: true,
    }).catch(() => {
      // Nothing left to do. A reporter that throws here would replace the
      // error page with a blank screen.
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          margin: 0,
          padding: "3rem 1.5rem",
          background: "#fbfaf8",
          color: "#1a1a1a",
        }}
      >
        <main style={{ maxWidth: "34rem", margin: "0 auto" }}>
          <h1 style={{ fontSize: "1.35rem", fontWeight: 600, margin: 0 }}>
            AVERIS could not start
          </h1>
          <p style={{ marginTop: "0.75rem", lineHeight: 1.6 }}>
            Something failed before the application could load. Your data is unaffected, and
            your device continues to record and send readings.
          </p>
          {error.digest && (
            <p style={{ marginTop: "1rem", fontFamily: "monospace", fontSize: "0.8rem", color: "#6b6b6b" }}>
              Reference: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              padding: "0.6rem 1.1rem",
              border: "1px solid #1a1a1a",
              borderRadius: "0.4rem",
              background: "#1a1a1a",
              color: "#fff",
              cursor: "pointer",
              font: "inherit",
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}

"use client";

import { useState } from "react";
import { Callout } from "@/components/ui";

/**
 * The one and only time a device token is shown.
 *
 * Two deliberate choices.
 *
 * **The warning comes before the token, not after.** A patient who reads
 * "copy this now" only after they have closed the panel has already lost the
 * credential and has to rotate it.
 *
 * **The token is not pre-selected or auto-copied.** Writing to the clipboard
 * without an explicit action puts a long-lived credential into a buffer the
 * patient did not ask to fill and may paste somewhere else entirely.
 */
export function TokenReveal({ token, deviceKey }: { token: string; deviceKey: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access can be refused; the token is selectable either way.
    }
  };

  return (
    <div className="px-6 py-5">
      <Callout tone="notice" title="Copy this token now — it is shown only once">
        AVERIS stores a one-way hash of this token, not the token itself, so it cannot be shown
        again. If you lose it, generate a new one from the device list; the old one stops working
        immediately.
      </Callout>

      <div className="mt-4">
        <p className="eyebrow mb-2">Device key</p>
        <p className="mono text-[15px] font-semibold">{deviceKey}</p>
      </div>

      <div className="mt-4">
        <p className="eyebrow mb-2">Device token</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="mono flex-1 overflow-x-auto rounded border border-rule-strong bg-sunken px-3 py-2.5 text-[13px]">
            {token}
          </code>
          <button type="button" onClick={copy} className="btn btn-secondary shrink-0">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="mt-5 border-t border-rule pt-4">
        <p className="eyebrow mb-2">Point a device at AVERIS</p>
        <p className="mb-3 text-[13.5px] leading-relaxed text-ink-soft">
          Until the hardware exists, the simulator speaks the same contract the firmware will:
        </p>
        <pre className="mono overflow-x-auto rounded border border-rule bg-sunken p-3 text-[12.5px] leading-relaxed">
{`python sensor_simulator/simulate.py \\
  --token ${token.slice(0, 12)}… \\
  --device-key ${deviceKey}`}
        </pre>
      </div>

      <p className="mt-4 text-[13px] text-muted">
        Reload this page once you have copied the token.
      </p>
    </div>
  );
}

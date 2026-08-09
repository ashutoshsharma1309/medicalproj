import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SILENCE_THRESHOLD_MS,
  fleetHealth,
  interpretReadiness,
  notChecked,
  rollUp,
  summarise,
  type ComponentHealth,
} from "../system-health";

function component(overrides: Partial<ComponentHealth> = {}): ComponentHealth {
  return {
    id: "x",
    label: "Component",
    status: "healthy",
    detail: "ok",
    critical: false,
    ...overrides,
  };
}

describe("a component that could not be checked is never green", () => {
  it("rolls an unknown component up to degraded, not healthy", () => {
    // The most common lie a status page tells: catch the exception, leave the
    // tile as it was, and show a healthy system precisely when the thing that
    // checks health has stopped working.
    const status = rollUp([
      component({ status: "healthy" }),
      component({ id: "y", status: "unknown" }),
    ]);

    assert.equal(status, "degraded");
  });

  it("says so in words, not only in a colour", () => {
    const text = summarise([
      component({ label: "Database", status: "healthy" }),
      component({ id: "ai", label: "AI service", status: "unknown" }),
    ]);

    assert.match(text, /AI service could not be checked/);
    assert.match(text, /nothing is known about it/);
  });

  it("reports nothing-checked as unknown rather than healthy", () => {
    assert.equal(rollUp([]), "unknown");
    assert.match(summarise([]), /nothing can be said/);
  });

  it("gives an unchecked component a reason", () => {
    const health = notChecked("ai", "AI service", false, "No URL is configured.");

    assert.equal(health.status, "unknown");
    assert.match(health.detail, /No URL is configured/);
  });
});

describe("down and degraded are different states", () => {
  it("takes the system down only for a critical component", () => {
    // The AI service failing is degraded — ingest falls back locally and keeps
    // accepting readings. Waking somebody at 3am for that is how on-call gets
    // ignored.
    const nonCritical = rollUp([
      component({ status: "healthy", critical: true }),
      component({ id: "ai", status: "down", critical: false }),
    ]);
    assert.equal(nonCritical, "degraded");

    const critical = rollUp([component({ id: "db", status: "down", critical: true })]);
    assert.equal(critical, "down");
  });

  it("is healthy only when every component is", () => {
    assert.equal(rollUp([component(), component({ id: "b" })]), "healthy");
    assert.equal(rollUp([component(), component({ id: "b", status: "degraded" })]), "degraded");
  });
});

describe("reading a readiness response", () => {
  it("treats a service reporting itself degraded as degraded", () => {
    const health = interpretReadiness("ai", "AI service", false, {
      ok: true,
      body: { degraded: true, checks: { fall_model: false, vitals_engine: true } },
      latencyMs: 12,
    });

    assert.equal(health.status, "degraded");
    assert.match(health.detail, /fall_model is unavailable/);
    assert.equal(health.latencyMs, 12);
  });

  it("treats a failing check as degraded even without the flag", () => {
    // A service that forgets to set `degraded` but reports a failing check must
    // not read as healthy on the strength of the missing flag.
    const health = interpretReadiness("iot", "Ingest", true, {
      ok: true,
      body: { checks: { database: true, ai_service: false } },
    });

    assert.equal(health.status, "degraded");
    assert.match(health.detail, /ai_service/);
  });

  it("treats a non-200 as down rather than degraded", () => {
    const health = interpretReadiness("iot", "Ingest", true, { ok: false, status: 503 });

    assert.equal(health.status, "down");
    assert.match(health.detail, /HTTP 503/);
  });

  it("treats a transport error as down and names it", () => {
    const health = interpretReadiness("iot", "Ingest", true, {
      ok: false,
      error: "ECONNREFUSED",
    });

    assert.equal(health.status, "down");
    assert.match(health.detail, /ECONNREFUSED/);
    assert.equal(health.latencyMs, null);
  });

  it("is healthy only when everything passes", () => {
    const health = interpretReadiness("ai", "AI service", false, {
      ok: true,
      body: { degraded: false, checks: { fall_model: true, vitals_engine: true } },
      latencyMs: 8,
    });

    assert.equal(health.status, "healthy");
  });

  it("never leaves a status without an explanation", () => {
    const responses = [
      { ok: true, body: {} },
      { ok: false, status: 500 },
      { ok: false, error: "timeout" },
    ];

    for (const response of responses) {
      const health = interpretReadiness("x", "X", false, response);
      assert.ok(health.detail.length > 5, "a status with no explanation is just a colour");
    }
  });
});

describe("fleet health counts silent devices, not a percentage", () => {
  const now = new Date("2026-08-13T12:00:00Z");

  function device(minutesAgo: number | null) {
    return {
      lastReadingAt:
        minutesAgo === null ? null : new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    };
  }

  it("reports the count of patients nobody is watching", () => {
    // A percentage hides the number that matters: a fleet at 95% with 200
    // devices has ten patients nobody is watching.
    const health = fleetHealth([device(1), device(2), device(60), device(120)], now);

    assert.equal(health.reporting, 2);
    assert.equal(health.silent, 2);
    assert.match(health.detail, /2 of 4 devices have not reported/);
  });

  it("treats any silent device as degraded", () => {
    // Absence of data is a finding, not a rounding error.
    const health = fleetHealth([device(1), device(1), device(1), device(99)], now);
    assert.equal(health.status, "degraded");
  });

  it("is healthy when everything is reporting", () => {
    assert.equal(fleetHealth([device(1), device(5)], now).status, "healthy");
  });

  it("counts a device that has never reported separately from a silent one", () => {
    // Different problems: never-reported is a provisioning failure, silent is a
    // device that worked and stopped.
    const health = fleetHealth([device(null), device(null)], now);

    assert.equal(health.neverReported, 2);
    assert.equal(health.silent, 0);
    assert.equal(health.status, "unknown");
    assert.match(health.detail, /none has ever reported/);
  });

  it("says there is no fleet rather than reporting a healthy empty one", () => {
    const health = fleetHealth([], now);

    assert.equal(health.status, "unknown");
    assert.match(health.detail, /no fleet to report on/);
  });

  it("puts the silence boundary where the monitoring dashboard puts it", () => {
    const justInside = fleetHealth([device(SILENCE_THRESHOLD_MS / 60_000 - 1)], now);
    const justOutside = fleetHealth([device(SILENCE_THRESHOLD_MS / 60_000 + 1)], now);

    assert.equal(justInside.silent, 0);
    assert.equal(justOutside.silent, 1);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deduplicationKey,
  dispatchPlan,
  isInQuietHours,
  suppressionWindowMs,
  type ChannelAvailability,
  type NotificationRequest,
} from "../dispatch";

const ALL_AVAILABLE: ChannelAvailability = {
  in_app: true,
  email: true,
  sms: true,
  push: true,
};

/** A fresh deployment: only the channel that needs no third party. */
const NOTHING_CONFIGURED: ChannelAvailability = {
  in_app: true,
  email: false,
  sms: false,
  push: false,
};

function request(overrides: Partial<NotificationRequest> = {}): NotificationRequest {
  return {
    recipientId: "user-1",
    priority: "CRITICAL",
    kind: "emergency",
    title: "Rahul Sharma — Fall detected",
    body: "The device reported a movement pattern consistent with a fall.",
    ...overrides,
  };
}

describe("priority decides the channels", () => {
  it("a critical notice uses every configured channel", () => {
    const plan = dispatchPlan(request(), ALL_AVAILABLE);
    const channels = plan.deliver.map((d) => d.channel).sort();

    assert.deepEqual(channels, ["email", "in_app", "push", "sms"]);
  });

  it("a routine notice never reaches a phone", () => {
    const plan = dispatchPlan(request({ priority: "ROUTINE" }), ALL_AVAILABLE);

    // An SMS at 3am for a low battery is how a carer mutes the number the
    // emergency will arrive on.
    assert.deepEqual(plan.deliver.map((d) => d.channel), ["in_app"]);
    assert.ok(plan.skipped.some((s) => s.channel === "sms" && s.reason === "not_for_priority"));
  });

  it("an urgent notice reaches a phone but does not ring it", () => {
    const plan = dispatchPlan(request({ priority: "URGENT" }), ALL_AVAILABLE);
    const channels = plan.deliver.map((d) => d.channel).sort();

    assert.deepEqual(channels, ["email", "in_app", "push"]);
    assert.ok(!channels.includes("sms"));
  });
});

describe("unconfigured channels are reported, never silently skipped", () => {
  it("names every channel that did not go out and why", () => {
    const plan = dispatchPlan(request(), NOTHING_CONFIGURED);

    // The rule this codebase has held since Phase 6: a channel that silently
    // does nothing is worse than an absent one.
    const notConfigured = plan.skipped.filter((s) => s.reason === "not_configured");
    assert.equal(notConfigured.length, 3);

    for (const skip of notConfigured) {
      assert.match(skip.detail, /not configured/);
      assert.match(skip.detail, /did not go out/);
    }
  });

  it("flags a critical notice that reached only the in-app channel as degraded", () => {
    const plan = dispatchPlan(request(), NOTHING_CONFIGURED);

    // The most important assertion in this file. This is how "we thought they
    // were told" becomes visible instead of assumed.
    assert.equal(plan.degraded, true);
    assert.deepEqual(plan.deliver.map((d) => d.channel), ["in_app"]);
  });

  it("does not call an urgent notice degraded for lacking SMS", () => {
    // Degradation is about critical notices failing to escape the app, not
    // about a routine channel being absent.
    const plan = dispatchPlan(
      request({ priority: "URGENT" }),
      { ...ALL_AVAILABLE, sms: false },
    );

    assert.equal(plan.degraded, false);
  });

  it("says so when nothing at all can be delivered", () => {
    const plan = dispatchPlan(request(), {
      in_app: false,
      email: false,
      sms: false,
      push: false,
    });

    assert.deepEqual(plan.deliver, []);
    assert.match(plan.undeliverable!, /Nobody was told/);
  });
});

describe("opt-out", () => {
  it("is honoured for a routine notice", () => {
    const plan = dispatchPlan(
      request({ priority: "ROUTINE" }),
      ALL_AVAILABLE,
      { optedOut: ["in_app"] },
    );

    assert.ok(plan.skipped.some((s) => s.channel === "in_app" && s.reason === "opted_out"));
  });

  it("is ignored for a critical notice", () => {
    const plan = dispatchPlan(request({ priority: "CRITICAL" }), ALL_AVAILABLE, {
      optedOut: ["sms", "push", "email", "in_app"],
    });

    // A patient who muted alerts muted convenience, not an emergency — and a
    // carer who turned off SMS for battery warnings did not consent to missing
    // a fall.
    assert.equal(plan.deliver.length, 4);
    assert.equal(plan.skipped.filter((s) => s.reason === "opted_out").length, 0);
  });
});

describe("quiet hours", () => {
  const quiet = { optedOut: [], quietHours: { fromHour: 22, toHour: 7 }, timeZone: "Asia/Kolkata" };

  it("handles a window that wraps midnight", () => {
    // The naive `hour >= from && hour < to` comparison silences nothing at all
    // for 22:00–07:00, which is the only window anyone actually configures.
    assert.equal(isInQuietHours(quiet, new Date("2026-08-11T18:00:00Z")), true); // 23:00 IST
    assert.equal(isInQuietHours(quiet, new Date("2026-08-11T20:00:00Z")), true); // 01:00 IST
    assert.equal(isInQuietHours(quiet, new Date("2026-08-11T08:00:00Z")), false); // 13:00 IST
  });

  it("treats the end hour as the moment quiet hours stop", () => {
    // 07:00 with a window of 22→7 is the first hour that is *not* quiet. The
    // boundary is worth pinning: an off-by-one here either wakes someone an
    // hour early or holds an urgent notice an hour too long.
    assert.equal(isInQuietHours(quiet, new Date("2026-08-11T02:00:00Z")), false); // 07:00 IST
    assert.equal(isInQuietHours(quiet, new Date("2026-08-11T01:00:00Z")), true); // 06:00 IST
  });

  it("uses the recipient's timezone, not the server's", () => {
    const inIndia = isInQuietHours(quiet, new Date("2026-08-11T20:00:00Z")); // 01:30 IST
    const inUtc = isInQuietHours(
      { ...quiet, timeZone: "UTC" },
      new Date("2026-08-11T20:00:00Z"),
    ); // 20:00 UTC

    // Quiet hours evaluated in the server's timezone silence the wrong eight
    // hours — for a deployment in India served from Europe, the working day.
    assert.equal(inIndia, true);
    assert.equal(inUtc, false);
  });

  it("defers a routine notice but never a critical one", () => {
    const night = new Date("2026-08-11T20:00:00Z"); // 01:30 IST

    const routine = dispatchPlan(
      request({ priority: "ROUTINE" }),
      ALL_AVAILABLE,
      quiet,
      night,
    );
    const critical = dispatchPlan(request(), ALL_AVAILABLE, quiet, night);

    // in_app is never deferred: it does not make a noise.
    assert.equal(routine.deliver.find((d) => d.channel === "in_app")!.deferUntil, null);

    for (const delivery of critical.deliver) {
      assert.equal(delivery.deferUntil, null, `${delivery.channel} was deferred for a fall`);
    }
  });

  it("defers an urgent email to the end of quiet hours", () => {
    const plan = dispatchPlan(
      request({ priority: "URGENT" }),
      ALL_AVAILABLE,
      quiet,
      new Date("2026-08-11T20:00:00Z"),
    );

    const email = plan.deliver.find((d) => d.channel === "email")!;
    assert.ok(email.deferUntil !== null);
    assert.ok(Date.parse(email.deferUntil!) > Date.parse("2026-08-11T20:00:00Z"));
  });

  it("does nothing when no quiet hours are set", () => {
    assert.equal(isInQuietHours({ optedOut: [] }, new Date()), false);
  });
});

describe("deduplication", () => {
  it("keys on the emergency, not the wording", () => {
    // Two systems describing the same event in different words are still
    // describing one event.
    const a = deduplicationKey(request({ emergencyId: "e-1", title: "Fall detected" }));
    const b = deduplicationKey(request({ emergencyId: "e-1", title: "Possible fall" }));

    assert.equal(a, b);
  });

  it("separates recipients", () => {
    const doctor = deduplicationKey(request({ recipientId: "doc", emergencyId: "e-1" }));
    const carer = deduplicationKey(request({ recipientId: "carer", emergencyId: "e-1" }));

    // One event, two people who each need telling.
    assert.notEqual(doctor, carer);
  });

  it("falls back to the kind when there is no emergency", () => {
    assert.equal(
      deduplicationKey(request({ kind: "summary_ready", emergencyId: undefined })),
      "user-1:summary_ready",
    );
  });
});

describe("repeat suppression", () => {
  it("lets a critical notice repeat soonest", () => {
    // An unanswered emergency should be raised again: the first notification
    // arriving while a phone was face-down is not somebody having seen it.
    assert.ok(suppressionWindowMs("CRITICAL") < suppressionWindowMs("URGENT"));
    assert.ok(suppressionWindowMs("URGENT") < suppressionWindowMs("ROUTINE"));
    assert.ok(suppressionWindowMs("CRITICAL") <= 5 * 60_000);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IMPACT_DISCLAIMER,
  computeImpact,
  detectionLatency,
  emptyMetrics,
  provenanceCaption,
  type AlertRow,
  type EmergencyRow,
  type ReadingRow,
} from "../impact-metrics";

function reading(overrides: Partial<ReadingRow> = {}): ReadingRow {
  return {
    isSimulated: false,
    patientId: "p1",
    recordedAt: "2026-08-12T10:00:00Z",
    receivedAt: "2026-08-12T10:00:01Z",
    ...overrides,
  };
}

function alert(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    severity: "WARNING",
    isSimulated: false,
    createdAt: "2026-08-12T10:00:03Z",
    triggeredByReceivedAt: "2026-08-12T10:00:01Z",
    ...overrides,
  };
}

function emergency(overrides: Partial<EmergencyRow> = {}): EmergencyRow {
  return {
    isSimulated: false,
    createdAt: "2026-08-12T10:00:03Z",
    acknowledgedAt: null,
    status: "NEW",
    ...overrides,
  };
}

describe("provenance is never collapsed into a total", () => {
  it("splits every count into measured and simulated", () => {
    const metrics = computeImpact(
      [
        reading({ isSimulated: false, patientId: "p1" }),
        reading({ isSimulated: true, patientId: "p2" }),
        reading({ isSimulated: true, patientId: "p2" }),
      ],
      [alert({ isSimulated: false }), alert({ isSimulated: true })],
      [emergency({ isSimulated: true })],
    );

    // The reason this matters: in a demo most rows are simulated, so a single
    // total flatters by construction.
    assert.deepEqual(metrics.readings, { measured: 1, simulated: 2 });
    assert.deepEqual(metrics.alerts, { measured: 1, simulated: 1 });
    assert.deepEqual(metrics.emergencies, { measured: 0, simulated: 1 });
  });

  it("counts accounts, not 'patients monitored'", () => {
    const metrics = computeImpact(
      [
        reading({ patientId: "p1" }),
        reading({ patientId: "p1" }),
        reading({ patientId: "p2", isSimulated: true }),
      ],
      [],
      [],
    );

    assert.equal(metrics.accountsWithReadings.measured, 1);
    assert.equal(metrics.accountsWithReadings.simulated, 1);
  });

  it("flags a deployment that has never seen a physical device", () => {
    const metrics = computeImpact([reading({ isSimulated: true })], [], []);

    assert.equal(metrics.noMeasuredData, true);
    assert.match(provenanceCaption(metrics), /No physical device has reported/);
    assert.match(provenanceCaption(metrics), /nothing here describes a real patient/);
  });

  it("distinguishes 'nothing happened' from 'nothing recorded'", () => {
    const caption = provenanceCaption(computeImpact([], [], []));

    // Zeroes on a dashboard read as a rendering bug. This says which it is.
    assert.match(caption, /processed no readings yet/);
    assert.match(caption, /not because nothing was recorded/);
  });
});

describe("detection latency is machine latency, and says so", () => {
  it("measures reading-received to alert-raised", () => {
    const summary = detectionLatency([
      alert({ triggeredByReceivedAt: "2026-08-12T10:00:00Z", createdAt: "2026-08-12T10:00:02Z" }),
      alert({ triggeredByReceivedAt: "2026-08-12T10:00:00Z", createdAt: "2026-08-12T10:00:04Z" }),
      alert({ triggeredByReceivedAt: "2026-08-12T10:00:00Z", createdAt: "2026-08-12T10:00:06Z" }),
    ]);

    assert.equal(summary.n, 3);
    assert.equal(summary.medianMs, 4000);
  });

  it("keeps the tail visible where a mean would bury it", () => {
    // Nine alerts at 1 s and one at 60 s. The mean is 6.9 s — a figure that
    // describes none of them and makes the system look uniformly mediocre. The
    // median says most alerts are fast; p95 says one was not. Both are true and
    // the pair is what an alerting system should be judged on.
    const fast = Array.from({ length: 9 }, () =>
      alert({ triggeredByReceivedAt: "2026-08-12T10:00:00Z", createdAt: "2026-08-12T10:00:01Z" }),
    );
    const slow = alert({
      triggeredByReceivedAt: "2026-08-12T10:00:00Z",
      createdAt: "2026-08-12T10:01:00Z",
    });

    const summary = detectionLatency([...fast, slow]);

    assert.equal(summary.medianMs, 1000);
    assert.equal(summary.p95Ms, 60000, "the slow one must be visible in p95");
  });

  it("says it cannot measure rather than reporting zero", () => {
    const summary = detectionLatency([alert({ triggeredByReceivedAt: null })]);

    // Zero milliseconds reads as an instantaneous system. Null plus a reason
    // reads as what it is.
    assert.equal(summary.medianMs, null);
    assert.equal(summary.n, 0);
    assert.match(summary.unavailableReason!, /could not be traced back/);
  });

  it("excludes an alert that precedes its own cause rather than clamping it", () => {
    // A negative interval is a clock problem, not a fast system. Clamping to
    // zero would report an impossible result as an excellent one.
    const summary = detectionLatency([
      alert({ triggeredByReceivedAt: "2026-08-12T10:00:05Z", createdAt: "2026-08-12T10:00:00Z" }),
      alert({ triggeredByReceivedAt: "2026-08-12T10:00:00Z", createdAt: "2026-08-12T10:00:02Z" }),
    ]);

    assert.equal(summary.n, 1);
    assert.equal(summary.medianMs, 2000);
    assert.match(summary.unavailableReason!, /1 of 2 alerts could not be traced/);
  });

  it("discloses how many alerts were excluded", () => {
    const summary = detectionLatency([
      alert(),
      alert({ triggeredByReceivedAt: null }),
      alert({ triggeredByReceivedAt: null }),
    ]);

    // Silently dropping the untraceable ones reports the latency of the subset
    // that happened to be easy to measure.
    assert.equal(summary.n, 1);
    assert.match(summary.unavailableReason!, /2 of 3/);
  });

  it("says nothing has been raised when nothing has", () => {
    assert.match(detectionLatency([]).unavailableReason!, /No alerts have been raised/);
  });
});

describe("the words on the screen", () => {
  it("refuses the phrase that would make it a clinical claim", () => {
    // The whole risk of this panel in one assertion.
    assert.match(IMPACT_DISCLAIMER, /not clinical outcomes/);
    assert.match(IMPACT_DISCLAIMER, /not a trial result/);
    assert.match(IMPACT_DISCLAIMER, /not evidence that AVERIS improves anyone's health/);
  });

  it("explains what detection latency is not", () => {
    assert.match(IMPACT_DISCLAIMER, /not how long a clinician took to arrive/);
  });
});

describe("supporting figures", () => {
  it("counts only emergencies a human actually acknowledged", () => {
    const metrics = computeImpact(
      [],
      [],
      [
        emergency({ acknowledgedAt: "2026-08-12T10:01:00Z" }),
        emergency({ acknowledgedAt: null }),
        emergency({ acknowledgedAt: null }),
      ],
    );

    assert.equal(metrics.emergenciesAcknowledged, 1);
  });

  it("measures the span of data rather than assuming one", () => {
    const metrics = computeImpact(
      [
        reading({ recordedAt: "2026-08-01T10:00:00Z" }),
        reading({ recordedAt: "2026-08-11T10:00:00Z" }),
      ],
      [],
      [],
    );

    assert.equal(metrics.daysOfData, 10);
  });

  it("reports an empty deployment without dividing by zero", () => {
    const metrics = computeImpact([], [], []);

    assert.deepEqual(metrics, emptyMetrics());
    assert.equal(metrics.daysOfData, 0);
  });
});

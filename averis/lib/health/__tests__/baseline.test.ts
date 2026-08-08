import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeBaseline,
  deviationFrom,
  personalFindings,
  MIN_DAYS,
  MIN_SAMPLES,
  type BaselineSample,
} from "../baseline";
import { evaluateReading } from "@/lib/iot/alert-rules";

const DAY = 86_400_000;
const START = Date.parse("2026-07-01T00:00:00.000Z");

/**
 * `days` days of readings, `perDay` each, around the given centres with a
 * deterministic wobble. Seeded arithmetic rather than Math.random so a failure
 * reproduces exactly.
 */
function series(
  days: number,
  perDay: number,
  centres: { hr?: number; spo2?: number; temp?: number },
  drift: { hr?: number; spo2?: number; temp?: number } = {},
): BaselineSample[] {
  const out: BaselineSample[] = [];

  for (let day = 0; day < days; day += 1) {
    for (let i = 0; i < perDay; i += 1) {
      const wobble = ((day * perDay + i) % 7) - 3;
      out.push({
        heart_rate:
          centres.hr === undefined ? null : centres.hr + wobble + (drift.hr ?? 0) * day,
        spo2:
          centres.spo2 === undefined
            ? null
            : centres.spo2 + (wobble % 2) + (drift.spo2 ?? 0) * day,
        temperature:
          centres.temp === undefined
            ? null
            : Number((centres.temp + wobble * 0.05 + (drift.temp ?? 0) * day).toFixed(1)),
        recorded_at: new Date(START + day * DAY + i * 120_000).toISOString(),
      });
    }
  }

  return out;
}

describe("refusing to invent a baseline", () => {
  it("returns null below the sample floor", () => {
    assert.equal(computeBaseline(series(5, 10, { hr: 72 })), null);
  });

  it("returns null when dense data covers too few days", () => {
    // 500 readings inside one afternoon is a dense sample of one afternoon,
    // not a description of a person.
    const oneDay = series(1, 600, { hr: 72 });
    assert.ok(oneDay.length > MIN_SAMPLES);
    assert.equal(computeBaseline(oneDay), null);
  });

  it("produces a baseline once both floors are met", () => {
    const baseline = computeBaseline(series(MIN_DAYS, 100, { hr: 72, spo2: 98, temp: 36.7 }));

    assert.ok(baseline !== null);
    assert.equal(baseline!.daysCovered, MIN_DAYS);
    assert.ok(baseline!.channels.heartRate);
  });

  it("omits a channel the device never reported rather than fabricating one", () => {
    // A chest strap has no thermometer. An invented range would be worse than
    // an absent one, because a deviation could then be computed from it.
    const baseline = computeBaseline(series(7, 100, { hr: 72, spo2: 98 }));

    assert.ok(baseline!.channels.heartRate);
    assert.equal(baseline!.channels.temperature, undefined);
  });
});

describe("contamination", () => {
  it("does not learn from a period the caller excluded", () => {
    const healthy = series(7, 100, { hr: 70 });
    // Three days of illness at the end, at a much higher heart rate.
    const ill = series(3, 100, { hr: 115 }).map((s) => ({
      ...s,
      recorded_at: new Date(Date.parse(s.recorded_at) + 7 * DAY).toISOString(),
    }));

    const contaminated = computeBaseline([...healthy, ...ill]);
    const clean = computeBaseline([...healthy, ...ill], {
      exclude: [
        {
          from: new Date(START + 7 * DAY).toISOString(),
          to: new Date(START + 11 * DAY).toISOString(),
          reason: "open emergency",
        },
      ],
    });

    // The whole point: a baseline that learned the illness would go quiet
    // exactly when the patient needs it not to.
    assert.ok(contaminated!.channels.heartRate!.median > clean!.channels.heartRate!.median);
    assert.ok(Math.abs(clean!.channels.heartRate!.median - 70) <= 3);
    assert.ok(clean!.excludedSamples > 0);
  });

  it("anchors by ignoring everything after a cutoff", () => {
    const old = series(10, 100, { hr: 68 });
    const recent = series(4, 100, { hr: 96 }).map((s) => ({
      ...s,
      recorded_at: new Date(Date.parse(s.recorded_at) + 10 * DAY).toISOString(),
    }));

    const anchored = computeBaseline([...old, ...recent], {
      excludeAfter: new Date(START + 10 * DAY).toISOString(),
    });

    // A baseline that kept up with the recent rise could never report it:
    // every day would look normal against the day before.
    assert.ok(Math.abs(anchored!.channels.heartRate!.median - 68) <= 3);
  });
});

describe("robustness", () => {
  it("a handful of artefacts does not move the baseline", () => {
    const clean = series(7, 100, { hr: 72 });
    const withArtefacts = [...clean];
    // Twenty implausible spikes that survived the device filter.
    for (let i = 0; i < 20; i += 1) {
      withArtefacts.push({ ...clean[i * 10], heart_rate: 210 });
    }

    const a = computeBaseline(clean)!;
    const b = computeBaseline(withArtefacts)!;

    // A mean would have moved by several BPM. A median moves by nothing.
    assert.ok(Math.abs(a.channels.heartRate!.median - b.channels.heartRate!.median) <= 1);
  });

  it("confidence grows with days observed", () => {
    const three = computeBaseline(series(3, 200, { hr: 72 }))!;
    const fourteen = computeBaseline(series(14, 200, { hr: 72 }))!;

    assert.ok(fourteen.confidence > three.confidence);
    assert.ok(fourteen.confidence <= 1);
  });
});

describe("personal deviation", () => {
  const baseline = computeBaseline(series(14, 100, { hr: 72, spo2: 98, temp: 36.7 }))!;

  it("measures against the patient's own median, not a published range", () => {
    const deviation = deviationFrom(baseline, "heartRate", 105)!;

    // 105 BPM is inside the published 50–120 range and raises no alert. It is
    // 45% above *this* patient, which is the finding the fixed range cannot
    // produce.
    assert.deepEqual(evaluateReading({
      deviceKey: "AVR001",
      heartRate: 105,
      spo2: 98,
      temperature: 36.7,
      movementStatus: "RESTING",
      batteryPercentage: 90,
      recordedAt: new Date().toISOString(),
    }), []);

    assert.ok(deviation.percentDelta > 40);
    assert.equal(deviation.direction, "above");
    assert.notEqual(deviation.severity, "NONE");
  });

  it("is scale-free, so a steady patient deviates sooner than a variable one", () => {
    const steady = computeBaseline(series(14, 100, { hr: 72 }))!;
    const variable = computeBaseline(
      series(14, 100, { hr: 72 }).map((s, i) => ({
        ...s,
        heart_rate: 72 + ((i % 40) - 20),
      })),
    )!;

    const sameReading = 90;
    const a = deviationFrom(steady, "heartRate", sameReading)!;
    const b = deviationFrom(variable, "heartRate", sameReading)!;

    // The identical reading is a bigger event for the patient whose heart rate
    // never moves. That is the entire point of personalisation.
    assert.ok(a.iqrDistance > b.iqrDistance);
  });

  it("does not divide by a zero spread", () => {
    // A patient whose SpO2 reads 98 every single time has an IQR of zero.
    const flat = computeBaseline(
      series(7, 100, { spo2: 98 }).map((s) => ({ ...s, spo2: 98 })),
    )!;

    const deviation = deviationFrom(flat, "spo2", 97)!;
    assert.ok(Number.isFinite(deviation.iqrDistance));
    assert.equal(deviation.severity, "NONE", "one point of noise is not a marked deviation");
  });

  it("returns null for a channel with no baseline", () => {
    const noTemp = computeBaseline(series(7, 100, { hr: 72 }))!;

    // Absence of a baseline is not evidence of normality, and a caller must
    // not be able to mistake one for the other.
    assert.equal(deviationFrom(noTemp, "temperature", 39.5), null);
  });
});

describe("the invariant: personalisation only ever adds", () => {
  /**
   * A patient whose personal baseline runs high. If personalisation could
   * suppress, this is the patient it would silence — and they are exactly the
   * patient whose readings have been drifting for weeks.
   */
  const highBaseline = computeBaseline(series(14, 100, { hr: 108, spo2: 92, temp: 37.6 }))!;

  it("a critical reading still raises a threshold alert regardless of baseline", () => {
    const alerts = evaluateReading({
      deviceKey: "AVR001",
      heartRate: 155,
      spo2: 86,
      temperature: 39.8,
      movementStatus: "RESTING",
      batteryPercentage: 90,
      recordedAt: new Date().toISOString(),
    });

    const critical = alerts.filter((a) => a.severity === "CRITICAL");
    assert.ok(critical.length >= 3, "the published rules must fire independently");
  });

  it("a reading that is normal *for the patient* can still be critical", () => {
    // 92% SpO2 is this patient's median, so there is no personal finding.
    const findings = personalFindings(highBaseline, {
      heartRate: 108,
      spo2: 92,
      temperature: 37.6,
    });
    assert.deepEqual(findings, [], "no deviation from their own normal");

    // And the published rules still say it is a warning. Both statements are
    // true at once, and the published one is the one that escalates.
    const alerts = evaluateReading({
      deviceKey: "AVR001",
      heartRate: 108,
      spo2: 92,
      temperature: 37.6,
      movementStatus: "RESTING",
      batteryPercentage: 90,
      recordedAt: new Date().toISOString(),
    });

    assert.ok(alerts.some((a) => a.alertType === "SPO2_LOW"));
  });

  it("exposes no way to cancel an alert", () => {
    // Structural: the module's public surface returns findings and never a
    // suppression, so there is no call a future caller could make to silence
    // the rule engine from here.
    const findings = personalFindings(highBaseline, {
      heartRate: 155,
      spo2: 86,
      temperature: 39.8,
    });

    for (const finding of findings) {
      assert.ok("message" in finding && "deviation" in finding);
      assert.equal("suppress" in finding, false);
      assert.equal("cancel" in finding, false);
    }
  });
});

describe("what personal findings say", () => {
  const baseline = computeBaseline(series(14, 100, { hr: 72, spo2: 98, temp: 36.7 }))!;

  it("carries both numbers and the window they came from", () => {
    const [finding] = personalFindings(baseline, {
      heartRate: 110,
      spo2: 98,
      temperature: 36.7,
    });

    assert.match(finding.message, /110/);
    assert.match(finding.message, /72/);
    assert.match(finding.message, /14 days/);
  });

  it("says nothing about a reading that is normal for the patient", () => {
    assert.deepEqual(
      personalFindings(baseline, { heartRate: 74, spo2: 98, temperature: 36.7 }),
      [],
    );
  });

  it("does not report oxygen saturation above the patient's usual", () => {
    // There is no such thing as too much oxygen saturation, and reporting it
    // would train readers to skim.
    const findings = personalFindings(baseline, {
      heartRate: 72,
      spo2: 100,
      temperature: 36.7,
    });

    assert.equal(findings.find((f) => f.channel === "spo2"), undefined);
  });

  it("does report a heart rate well below the patient's usual", () => {
    const findings = personalFindings(baseline, {
      heartRate: 48,
      spo2: 98,
      temperature: 36.7,
    });

    assert.ok(findings.some((f) => f.channel === "heartRate" && f.deviation.direction === "below"));
  });

  it("orders the most marked deviation first", () => {
    const findings = personalFindings(baseline, {
      heartRate: 140,
      spo2: 90,
      temperature: 37.2,
    });

    for (let i = 1; i < findings.length; i += 1) {
      const order = { NONE: 0, MILD: 1, NOTABLE: 2, MARKED: 3 };
      assert.ok(order[findings[i - 1].severity] >= order[findings[i].severity]);
    }
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareToBaseline,
  dailyMedians,
  detectDeterioration,
  MIN_SAMPLES_PER_DAY,
  MIN_TREND_DAYS,
  trendFor,
} from "../deterioration";
import { computeBaseline, type BaselineSample } from "../baseline";

const DAY = 86_400_000;
const START = Date.parse("2026-07-01T00:00:00.000Z");

/** One value per day, repeated `perDay` times, with a small deterministic wobble. */
function daily(
  values: { hr?: number; spo2?: number; temp?: number }[],
  perDay = 40,
): BaselineSample[] {
  const out: BaselineSample[] = [];

  values.forEach((day, index) => {
    for (let i = 0; i < perDay; i += 1) {
      const wobble = ((i % 5) - 2) * 0.5;
      out.push({
        heart_rate: day.hr === undefined ? null : day.hr + wobble,
        spo2: day.spo2 === undefined ? null : day.spo2 + (i % 3 === 0 ? 0.5 : 0),
        temperature: day.temp === undefined ? null : Number((day.temp + wobble * 0.05).toFixed(2)),
        recorded_at: new Date(START + index * DAY + i * 300_000).toISOString(),
      });
    }
  });

  return out;
}

describe("daily reduction", () => {
  it("gives one median per calendar day", () => {
    const points = dailyMedians(daily([{ hr: 70 }, { hr: 72 }, { hr: 74 }]), "heartRate");

    assert.equal(points.length, 3);
    assert.ok(Math.abs(points[0].median - 70) < 1);
  });

  it("drops a day with too few readings to summarise", () => {
    const thin = daily([{ hr: 70 }], MIN_SAMPLES_PER_DAY - 5);
    assert.deepEqual(dailyMedians(thin, "heartRate"), []);
  });

  it("uses the median so one bout of exercise does not become the day", () => {
    const day = daily([{ hr: 68 }], 60);
    // An hour of exertion — twelve readings much higher.
    for (let i = 0; i < 12; i += 1) day[i].heart_rate = 150;

    const [point] = dailyMedians(day, "heartRate");

    // A mean would land near 84 and report a day the patient did not have.
    assert.ok(point.median < 75, `median was ${point.median}`);
  });

  it("returns days in chronological order", () => {
    const shuffled = daily([{ hr: 70 }, { hr: 71 }, { hr: 72 }, { hr: 73 }]).reverse();
    const points = dailyMedians(shuffled, "heartRate");

    for (let i = 1; i < points.length; i += 1) {
      assert.ok(points[i - 1].day < points[i].day);
    }
  });
});

describe("trend detection", () => {
  it("needs enough days before it will call a direction", () => {
    const short = daily([{ spo2: 98 }, { spo2: 96 }, { spo2: 94 }]);
    assert.equal(trendFor(short, "spo2"), null);
  });

  it("catches the brief's example: a five-day oxygen decline", () => {
    // 98 → 91 over five days, every reading inside the published range until
    // the last. The threshold rules see nothing; this is the finding.
    const trend = trendFor(
      daily([{ spo2: 98 }, { spo2: 97 }, { spo2: 95 }, { spo2: 93 }, { spo2: 91 }]),
      "spo2",
    )!;

    assert.equal(trend.direction, "FALLING");
    assert.equal(trend.concerning, true);
    assert.ok(trend.slopePerDay < -1.5, `slope was ${trend.slopePerDay}`);
    assert.ok(trend.fit > 0.9, "a straight decline should fit a line well");
  });

  it("catches a rising resting heart rate", () => {
    const trend = trendFor(
      daily([{ hr: 62 }, { hr: 65 }, { hr: 68 }, { hr: 71 }, { hr: 75 }]),
      "heartRate",
    )!;

    assert.equal(trend.direction, "RISING");
    assert.equal(trend.concerning, true);
  });

  it("calls a wobble steady rather than inventing a shape", () => {
    // Has a slope. Does not have a trend.
    const trend = trendFor(
      daily([{ spo2: 98 }, { spo2: 91 }, { spo2: 99 }, { spo2: 90 }, { spo2: 97 }]),
      "spo2",
    )!;

    assert.equal(trend.direction, "STEADY", `fit was ${trend.fit}`);
    assert.equal(trend.concerning, false);
  });

  it("calls a tiny but tidy slope steady", () => {
    // A beautifully-fitted 0.05 BPM/day is not worth telling anyone about.
    const trend = trendFor(
      daily([{ hr: 70 }, { hr: 70.05 }, { hr: 70.1 }, { hr: 70.15 }, { hr: 70.2 }]),
      "heartRate",
    )!;

    assert.equal(trend.direction, "STEADY");
  });

  it("does not call an improving channel concerning", () => {
    // Oxygen recovering is a rise, and a rise in SpO2 is good news.
    const trend = trendFor(
      daily([{ spo2: 91 }, { spo2: 93 }, { spo2: 95 }, { spo2: 97 }, { spo2: 98 }]),
      "spo2",
    )!;

    assert.equal(trend.direction, "RISING");
    assert.equal(trend.concerning, false);
  });

  it("honours a gap rather than collapsing it", () => {
    // Two clusters a fortnight apart is a different claim from five
    // consecutive days, and the slope per *day* should reflect that.
    const early = daily([{ hr: 70 }, { hr: 71 }]);
    const late = daily([{ hr: 78 }, { hr: 79 }]).map((s) => ({
      ...s,
      recorded_at: new Date(Date.parse(s.recorded_at) + 14 * DAY).toISOString(),
    }));

    const trend = trendFor([...early, ...late], "heartRate")!;

    assert.ok(Math.abs(trend.slopePerDay) < 1.5, `slope was ${trend.slopePerDay} per day`);
  });

  it("survives a flat series without dividing by zero", () => {
    const trend = trendFor(
      daily([{ hr: 70 }, { hr: 70 }, { hr: 70 }, { hr: 70 }, { hr: 70 }]),
      "heartRate",
    )!;

    assert.ok(Number.isFinite(trend.fit));
    assert.equal(trend.direction, "STEADY");
  });
});

describe("deterioration findings", () => {
  it("reports the declining channel and stays quiet about the steady ones", () => {
    const samples = daily([
      { hr: 70, spo2: 98, temp: 36.7 },
      { hr: 70, spo2: 97, temp: 36.7 },
      { hr: 71, spo2: 95, temp: 36.8 },
      { hr: 70, spo2: 93, temp: 36.7 },
      { hr: 71, spo2: 91, temp: 36.7 },
    ]);

    const { trends, findings } = detectDeterioration(samples);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].channel, "spo2");

    // Every channel still returns a trend: the absence of decline is a finding
    // a clinician wants, and a panel that only shows problems cannot confirm
    // there are none.
    assert.equal(trends.length, 3);
    assert.ok(trends.some((t) => t.channel === "heartRate" && t.direction === "STEADY"));
  });

  it("states the rate, the total and both endpoints", () => {
    const { findings } = detectDeterioration(
      daily([{ spo2: 98 }, { spo2: 97 }, { spo2: 95 }, { spo2: 93 }, { spo2: 91 }]),
    );

    // A trend claim without its numbers is unfalsifiable.
    assert.match(findings[0].message, /98/);
    assert.match(findings[0].message, /91/);
    assert.match(findings[0].message, /a day/);
  });

  it("escalates severity for a steeper, tidier decline", () => {
    const gentle = detectDeterioration(
      daily([{ spo2: 98 }, { spo2: 97.5 }, { spo2: 97 }, { spo2: 96.5 }, { spo2: 96 }]),
    );
    const steep = detectDeterioration(
      daily([{ spo2: 98 }, { spo2: 96 }, { spo2: 94 }, { spo2: 92 }, { spo2: 90 }]),
    );

    assert.equal(steep.findings[0].severity, "CONCERNING");
    assert.ok(
      gentle.findings.length === 0 || gentle.findings[0].severity === "WATCH",
      "a gentle decline should not be the loudest thing on the page",
    );
  });

  it("says nothing at all about a stable patient", () => {
    const { findings } = detectDeterioration(
      daily(Array.from({ length: 10 }, () => ({ hr: 70, spo2: 98, temp: 36.7 }))),
    );

    assert.deepEqual(findings, []);
  });
});

describe("comparing a recent window against the anchor", () => {
  const anchor = computeBaseline(
    daily(Array.from({ length: 14 }, () => ({ hr: 68, spo2: 98, temp: 36.6 })), 30),
  )!;

  it("catches a shift too slow for a slope to reach significance", () => {
    // Flat within the window, but a different level from the anchor. No trend
    // line would find this; comparing distributions does.
    const recent = daily(Array.from({ length: 3 }, () => ({ hr: 82, spo2: 98, temp: 36.6 })), 30);

    const findings = compareToBaseline(anchor, recent);

    assert.ok(findings.some((f) => f.channel === "heartRate"));
    assert.match(findings[0].message, /68/);
    assert.match(findings[0].message, /82/);
  });

  it("says nothing when the recent window matches the anchor", () => {
    const recent = daily(Array.from({ length: 3 }, () => ({ hr: 68, spo2: 98, temp: 36.6 })), 30);

    assert.deepEqual(compareToBaseline(anchor, recent), []);
  });

  it("does not report a shift in the reassuring direction", () => {
    // A heart rate that has settled *lower* than the anchor is not a
    // deterioration finding.
    const recent = daily(Array.from({ length: 3 }, () => ({ hr: 58, spo2: 98, temp: 36.6 })), 30);

    assert.equal(compareToBaseline(anchor, recent).find((f) => f.channel === "heartRate"), undefined);
  });

  it("ignores a recent window too thin to summarise", () => {
    const barely = daily([{ hr: 95 }], MIN_SAMPLES_PER_DAY - 5);

    assert.deepEqual(compareToBaseline(anchor, barely), []);
  });
});

describe("the numbers this module refuses to produce", () => {
  it("never reports a trend from fewer than the minimum days", () => {
    for (let days = 1; days < MIN_TREND_DAYS; days += 1) {
      const samples = daily(Array.from({ length: days }, () => ({ spo2: 90 })));
      assert.equal(trendFor(samples, "spo2"), null, `${days} days produced a trend`);
    }
  });
});

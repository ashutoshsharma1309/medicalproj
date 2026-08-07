import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHART_DOMAIN,
  NORMAL_BAND,
  STATUS_GLYPH,
  STATUS_LABEL,
  axisTicks,
  classifyVital,
  scaleX,
  scaleY,
  worstStatus,
  type VitalKind,
} from "../vital-status";
import {
  buildPath,
  downsample,
  gapThreshold,
  groupByDay,
  summarise,
  windowed,
  WINDOW_MS,
  type SeriesPoint,
} from "../series";
import { evaluateReading, THRESHOLDS } from "../alert-rules";
import { PLAUSIBLE } from "../reading-validation";

const KINDS: VitalKind[] = ["heartRate", "spo2", "temperature"];

function point(t: number, overrides: Partial<SeriesPoint> = {}): SeriesPoint {
  return { t, heartRate: 72, spo2: 98, temperature: 36.7, ...overrides };
}

/* ------------------------------------------------------- classification */

describe("vital classification", () => {
  it("calls an ordinary resting reading normal", () => {
    assert.equal(classifyVital("heartRate", 72), "NORMAL");
    assert.equal(classifyVital("spo2", 98), "NORMAL");
    assert.equal(classifyVital("temperature", 36.7), "NORMAL");
  });

  it("escalates through warning to critical", () => {
    assert.equal(classifyVital("heartRate", 130), "WARNING");
    assert.equal(classifyVital("heartRate", 155), "CRITICAL");
    assert.equal(classifyVital("spo2", 92), "WARNING");
    assert.equal(classifyVital("spo2", 88), "CRITICAL");
    assert.equal(classifyVital("temperature", 38.6), "WARNING");
    assert.equal(classifyVital("temperature", 39.8), "CRITICAL");
  });

  it("classifies low as well as high", () => {
    assert.equal(classifyVital("heartRate", 45), "WARNING");
    assert.equal(classifyVital("heartRate", 38), "CRITICAL");
    assert.equal(classifyVital("temperature", 35.2), "WARNING");
    assert.equal(classifyVital("temperature", 34.8), "CRITICAL");
  });

  it("reports UNKNOWN rather than guessing when there is no value", () => {
    for (const kind of KINDS) {
      assert.equal(classifyVital(kind, null), "UNKNOWN");
      assert.equal(classifyVital(kind, Number.NaN), "UNKNOWN");
    }
  });

  it("agrees with the alert engine, so a card never contradicts an alert", () => {
    // A card saying "Critical" while no alert was raised — or the reverse — is
    // worse than either on its own.
    const cases: { hr: number; expectAlert: boolean }[] = [
      { hr: 72, expectAlert: false },
      { hr: 130, expectAlert: true },
      { hr: 155, expectAlert: true },
      { hr: 38, expectAlert: true },
    ];

    for (const { hr, expectAlert } of cases) {
      const status = classifyVital("heartRate", hr);
      const alerts = evaluateReading({
        deviceKey: "AVR001",
        heartRate: hr,
        spo2: 98,
        temperature: 36.7,
        movementStatus: "RESTING",
        batteryPercentage: 90,
        recordedAt: new Date().toISOString(),
      }).filter((a) => a.alertType.startsWith("HEART_RATE"));

      assert.equal(
        alerts.length > 0,
        expectAlert,
        `alert expectation wrong at ${hr} BPM`,
      );
      assert.equal(
        status !== "NORMAL",
        expectAlert,
        `card says ${status} at ${hr} BPM but alerts=${alerts.length}`,
      );
    }
  });

  it("ranks a set by its worst member", () => {
    assert.equal(worstStatus(["NORMAL", "WARNING", "NORMAL"]), "WARNING");
    assert.equal(worstStatus(["WARNING", "CRITICAL"]), "CRITICAL");
    assert.equal(worstStatus(["UNKNOWN", "NORMAL"]), "NORMAL");
    assert.equal(worstStatus([]), "UNKNOWN");
  });

  it("gives every status a word and a distinct shape, not colour alone", () => {
    // AVERIS's amber and red measure ΔE 1.7 apart under deuteranopia, so these
    // two encodings are what actually carry status.
    const glyphs = Object.values(STATUS_GLYPH);
    assert.equal(new Set(glyphs).size, glyphs.length, "two statuses share a glyph");

    for (const status of ["NORMAL", "WARNING", "CRITICAL", "UNKNOWN"] as const) {
      assert.ok(STATUS_LABEL[status].length > 0);
      assert.ok(STATUS_GLYPH[status].length > 0);
    }
  });
});

/* --------------------------------------------------------- chart scales */

describe("chart scales", () => {
  it("puts the domain maximum at the top and the minimum at the bottom", () => {
    for (const kind of KINDS) {
      const { min, max } = CHART_DOMAIN[kind];
      assert.equal(scaleY(kind, max, 100), 0);
      assert.equal(scaleY(kind, min, 100), 100);
    }
  });

  it("clamps out-of-domain values to the edge rather than off-canvas", () => {
    // An extreme reading must stay visible at the boundary; drawn outside the
    // viewBox it simply vanishes, which is the worst possible outcome for the
    // one reading that mattered.
    assert.equal(scaleY("heartRate", 500, 100), 0);
    assert.equal(scaleY("heartRate", 0, 100), 100);
  });

  it("keeps the domain wide enough to contain every alert threshold", () => {
    // A threshold outside the plotted range would fire an alert the chart
    // cannot show.
    assert.ok(CHART_DOMAIN.heartRate.max >= THRESHOLDS.heartRate.criticalHigh);
    assert.ok(CHART_DOMAIN.heartRate.min <= THRESHOLDS.heartRate.criticalLow);
    assert.ok(CHART_DOMAIN.spo2.min <= THRESHOLDS.spo2.critical);
    assert.ok(CHART_DOMAIN.temperature.max >= THRESHOLDS.temperature.criticalHigh);
    assert.ok(CHART_DOMAIN.temperature.min <= THRESHOLDS.temperature.criticalLow);
  });

  it("keeps the normal band inside the plotted domain", () => {
    for (const kind of KINDS) {
      assert.ok(NORMAL_BAND[kind].min >= CHART_DOMAIN[kind].min, `${kind} band underflows`);
      assert.ok(NORMAL_BAND[kind].max <= CHART_DOMAIN[kind].max, `${kind} band overflows`);
    }
  });

  it("keeps the domain inside what validation would accept", () => {
    assert.ok(CHART_DOMAIN.heartRate.max <= PLAUSIBLE.heartRate.max);
    assert.ok(CHART_DOMAIN.spo2.max <= PLAUSIBLE.spo2.max);
  });

  it("maps time left to right within the window", () => {
    const start = 1_000_000;
    const end = start + 60_000;
    assert.equal(scaleX(start, start, end, 600), 0);
    assert.equal(scaleX(end, start, end, 600), 600);
    assert.equal(scaleX(start + 30_000, start, end, 600), 300);
  });

  it("clamps timestamps outside the window", () => {
    const start = 1_000_000;
    const end = start + 60_000;
    assert.equal(scaleX(start - 10_000, start, end, 600), 0);
    assert.equal(scaleX(end + 10_000, start, end, 600), 600);
  });

  it("produces ticks spanning the domain", () => {
    for (const kind of KINDS) {
      const ticks = axisTicks(kind);
      assert.ok(ticks.length >= 2, `${kind} has too few ticks`);
      assert.equal(ticks[0], CHART_DOMAIN[kind].min);
      assert.ok(ticks[ticks.length - 1] <= CHART_DOMAIN[kind].max);
    }
  });
});

/* -------------------------------------------------------------- series */

describe("windowing", () => {
  const now = 2_000_000;

  it("keeps only points inside the window, oldest first", () => {
    const points = [
      point(now - 5_000),
      point(now - 120_000), // outside a 1m window
      point(now - 30_000),
    ];
    const result = windowed(points, "1m", now);

    assert.equal(result.length, 2);
    assert.deepEqual(result.map((p) => p.t), [now - 30_000, now - 5_000]);
  });

  it("excludes future points", () => {
    assert.equal(windowed([point(now + 10_000)], "1m", now).length, 0);
  });

  it("scales the gap threshold to the window", () => {
    assert.ok(gapThreshold("1h") > gapThreshold("1m"));
    assert.ok(gapThreshold("1m") >= 10_000);
  });

  it("orders windows from shortest to longest", () => {
    assert.ok(WINDOW_MS["1m"] < WINDOW_MS["10m"]);
    assert.ok(WINDOW_MS["10m"] < WINDOW_MS["1h"]);
    assert.ok(WINDOW_MS["1h"] < WINDOW_MS.today);
    assert.ok(WINDOW_MS.today < WINDOW_MS.week);
  });
});

describe("downsampling", () => {
  it("leaves a short series untouched", () => {
    const points = Array.from({ length: 50 }, (_, i) => point(i * 1000));
    assert.equal(downsample(points, 220).length, 50);
  });

  it("reduces a long series to roughly the cap", () => {
    const points = Array.from({ length: 5000 }, (_, i) => point(i * 1000));
    const result = downsample(points, 200);
    assert.ok(result.length <= 201, `got ${result.length}`);
    assert.ok(result.length >= 190);
  });

  it("preserves a spike that naive sampling would drop", () => {
    // The failure this exists to prevent: a two-second excursion to 165 BPM
    // falling between samples, so an hour renders as a calm line through the
    // exact event the monitor is for.
    const points = Array.from({ length: 2000 }, (_, i) => point(i * 1000));
    points[977] = point(977 * 1000, { heartRate: 165 });

    const result = downsample(points, 100);
    const peak = Math.max(...result.map((p) => p.heartRate ?? 0));

    assert.equal(peak, 165, "the spike was lost in downsampling");
  });

  it("always keeps the newest reading", () => {
    // The cards show it; a line stopping short of its own headline looks broken.
    const points = Array.from({ length: 1000 }, (_, i) => point(i * 1000));
    const result = downsample(points, 50);
    assert.equal(result[result.length - 1].t, points[points.length - 1].t);
  });

  it("keeps all three channels from the same instant", () => {
    const points = Array.from({ length: 500 }, (_, i) =>
      point(i * 1000, { heartRate: 70 + i, spo2: 99 - (i % 5), temperature: 36.5 }),
    );
    const result = downsample(points, 50);

    for (const p of result) {
      const original = points.find((o) => o.t === p.t);
      assert.ok(original, "downsampling invented a timestamp");
      assert.equal(p.spo2, original.spo2, "channels came from different instants");
    }
  });
});

describe("path building", () => {
  const x = (t: number) => t / 1000;
  const y = (v: number) => 100 - v;

  it("draws a continuous line through contiguous points", () => {
    const points = [point(0), point(1000), point(2000)];
    const path = buildPath(points, (p) => p.heartRate, x, y, 5000);

    assert.equal((path.match(/M/g) ?? []).length, 1, "line broke unnecessarily");
    assert.equal((path.match(/L/g) ?? []).length, 2);
  });

  it("breaks the line across a gap instead of spanning it", () => {
    // A straight line across ten minutes of silence is a measurement claim
    // about a period when nothing was measured.
    const points = [point(0), point(1000), point(600_000), point(601_000)];
    const path = buildPath(points, (p) => p.heartRate, x, y, 10_000);

    assert.equal((path.match(/M/g) ?? []).length, 2, "the line spanned the gap");
  });

  it("breaks the line where a channel is missing", () => {
    const points = [point(0), point(1000, { heartRate: null }), point(2000)];
    const path = buildPath(points, (p) => p.heartRate, x, y, 10_000);

    assert.equal((path.match(/M/g) ?? []).length, 2);
  });

  it("returns an empty path for no data rather than throwing", () => {
    assert.equal(buildPath([], (p) => p.heartRate, x, y, 1000), "");
  });
});

describe("history helpers", () => {
  it("groups by day, newest first", () => {
    const day = 86_400_000;
    const points = [point(day * 3), point(day * 3 + 1000), point(day * 5)];
    const groups = groupByDay(points, (t) => new Date(t).toISOString().slice(0, 10));

    assert.equal(groups.length, 2);
    assert.equal(groups[0].points.length, 1); // the later day
    assert.equal(groups[1].points.length, 2);
  });

  it("summarises a window", () => {
    const points = [
      point(0, { heartRate: 60 }),
      point(1000, { heartRate: 80 }),
      point(2000, { heartRate: 100 }),
    ];
    const summary = summarise(points, (p) => p.heartRate)!;

    assert.equal(summary.min, 60);
    assert.equal(summary.max, 100);
    assert.equal(summary.mean, 80);
    assert.equal(summary.count, 3);
  });

  it("returns null rather than zero when nothing was measured", () => {
    // A mean of 0 BPM would render as a real measurement.
    const points = [point(0, { heartRate: null }), point(1000, { heartRate: null })];
    assert.equal(summarise(points, (p) => p.heartRate), null);
  });
});

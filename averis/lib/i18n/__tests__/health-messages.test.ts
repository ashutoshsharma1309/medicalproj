import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isLocale,
  LOCALES,
  localeFromHeader,
  missingKeys,
  renderDeviation,
  renderTrend,
  t,
} from "../health-messages";

describe("translation completeness", () => {
  for (const locale of LOCALES) {
    it(`${locale} has every key`, () => {
      // An untranslated string should fail here rather than appear in English
      // on a Hindi screen and be noticed by a user.
      assert.deepEqual(missingKeys(locale), []);
    });
  }

  it("renders the brief's example in both languages", () => {
    assert.equal(t("alert.spo2Low", "en"), "Low oxygen level detected");
    assert.equal(t("alert.spo2Low", "hi"), "ऑक्सीजन स्तर कम पाया गया");
  });
});

describe("what a missing or unknown key does", () => {
  it("falls back to English rather than throwing", () => {
    // A Hindi user seeing one English sentence is a gap. A Hindi user seeing
    // an error page is an outage.
    assert.equal(typeof t("alert.fallDetected", "hi"), "string");
  });

  it("shows an unknown key visibly instead of an empty string", () => {
    // A blank line in a health insight is indistinguishable from a finding
    // with nothing to say.
    assert.equal(t("does.not.exist", "en"), "[does.not.exist]");
  });

  it("leaves an unsupplied placeholder visible", () => {
    const rendered = t("baseline.learned", "en", {});
    assert.match(rendered, /\{days\}/);
  });
});

describe("numbers survive translation", () => {
  const deviation = {
    vitalKey: "vital.heartRate" as const,
    observed: 105,
    baseline: 72,
    percent: 45.8,
    direction: "above" as const,
    unit: " BPM",
  };

  for (const locale of LOCALES) {
    it(`keeps both numbers and the direction in ${locale}`, () => {
      const rendered = renderDeviation(deviation, locale);

      // The property the whole composition approach exists for. A model asked
      // to translate this sentence could drop a number or flip "above" into
      // "below"; a template cannot, because the numbers are parameters rather
      // than tokens being rewritten.
      assert.match(rendered, /105/);
      assert.match(rendered, /72/);
      assert.match(rendered, /46/);
    });
  }

  it("uses Western Arabic numerals in Hindi", () => {
    const rendered = renderDeviation(deviation, "hi");

    // Devanagari numerals are correct Hindi and are not what a clinician
    // reading a chart expects. A number a reader has to convert before quoting
    // is a number they will quote wrongly.
    assert.match(rendered, /105/);
    assert.ok(!/[०-९]/.test(rendered), "should not contain Devanagari digits");
  });

  it("renders a fall and a rise as different sentences in Hindi", () => {
    const falling = renderTrend(
      { vitalKey: "vital.spo2", direction: "FALLING", from: 98, to: 91, days: 5, unit: "%" },
      "hi",
    );
    const rising = renderTrend(
      { vitalKey: "vital.spo2", direction: "RISING", from: 91, to: 98, days: 5, unit: "%" },
      "hi",
    );

    assert.notEqual(falling, rising);
    assert.match(falling, /98/);
    assert.match(falling, /91/);
  });

  it("renders a below-baseline deviation differently from an above one", () => {
    const above = renderDeviation(deviation, "hi");
    const below = renderDeviation({ ...deviation, direction: "below" }, "hi");

    // If these were identical, a Hindi reader would be told a patient's heart
    // rate was high when it was low.
    assert.notEqual(above, below);
  });
});

describe("locale selection", () => {
  it("reads the primary subtag from Accept-Language", () => {
    assert.equal(localeFromHeader("hi-IN,hi;q=0.9,en;q=0.8"), "hi");
    assert.equal(localeFromHeader("en-GB,en;q=0.9"), "en");
  });

  it("skips languages with no translations", () => {
    // Tamil is planned, not present. Falling through to English is correct.
    assert.equal(localeFromHeader("ta-IN,ta;q=0.9,en;q=0.5"), "en");
  });

  it("defaults to English for a missing or malformed header", () => {
    assert.equal(localeFromHeader(null), "en");
    assert.equal(localeFromHeader(""), "en");
    assert.equal(localeFromHeader(";;;"), "en");
  });

  it("narrows an arbitrary string", () => {
    assert.equal(isLocale("hi"), true);
    assert.equal(isLocale("fr"), false);
    assert.equal(isLocale(undefined), false);
  });
});

describe("safety wording exists in every language", () => {
  for (const locale of LOCALES) {
    it(`the not-a-diagnosis line is present in ${locale}`, () => {
      const text = t("guidance.notDiagnosis", locale);

      // The one sentence that must never be missing from a localisation. A
      // language in which AVERIS forgets to say it does not diagnose is a
      // language in which it implies it does.
      assert.ok(text.length > 20);
      assert.notEqual(text, "[guidance.notDiagnosis]");
    });

    it(`the emergency guidance is present in ${locale}`, () => {
      assert.notEqual(t("guidance.emergency", locale), "[guidance.emergency]");
    });
  }
});

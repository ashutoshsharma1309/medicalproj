/**
 * Health insights in more than one language.
 *
 * ── The decision this file makes, and why it is not "call a translation API" ─
 *
 * Health findings are **structured, not prose**. A deviation is a channel, a
 * pair of numbers and a direction; a trend is a metric, a rate and a span.
 * Every message AVERIS shows is assembled from those parts.
 *
 * That means translation can be *composition* rather than machine translation,
 * and the difference is safety-critical. A model asked to translate "blood
 * oxygen fell to 88%, below the 90% escalation threshold" can drop a negation,
 * swap two numbers, or soften "below" into something a reader acts on
 * differently — and nobody in the loop reads both languages well enough to
 * catch it. Composing from templates cannot lose a number, because the number
 * is a parameter rather than a token in a sentence being rewritten.
 *
 * So: **findings carry structure, and the language layer renders it.** The
 * language model is used for narration only, in the language the clinician
 * reads, and never as a translator of clinical claims.
 *
 * ── Adding a language ──────────────────────────────────────────────────────
 *
 * Add a `Locale`, add its entry to each template. Missing keys fall back to
 * English rather than throwing — a Hindi user seeing one English sentence is a
 * gap; a Hindi user seeing an error page is an outage. `missingKeys()` reports
 * the gaps so they are visible rather than discovered.
 *
 * Numerals stay Western Arabic (98, not ९८) in every locale. Devanagari
 * numerals are correct Hindi and are *not* what a clinician reading a chart
 * expects, and a number a reader has to convert before quoting is a number they
 * will quote wrongly.
 *
 * Pure and fully tested.
 */

export type Locale = "en" | "hi";

export const LOCALES: Locale[] = ["en", "hi"];

export const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  hi: "हिन्दी",
};

/** Locales the architecture is ready for but which have no translations yet. */
export const PLANNED_LOCALES = ["bn", "ta", "te", "mr", "gu", "kn", "ml", "pa"] as const;

export type MessageParams = Record<string, string | number>;

type Template = Record<Locale, string>;

/**
 * Every sentence AVERIS shows about a finding.
 *
 * Placeholders are `{name}`. Word order differs between the languages —
 * Hindi is subject-object-verb — which is exactly why these are whole
 * sentences per locale rather than fragments concatenated at runtime. A
 * sentence assembled from translated fragments reads as a machine in every
 * language.
 */
const MESSAGES: Record<string, Template> = {
  /* ---------------------------------------------------------- vitals */
  "vital.heartRate": { en: "Heart rate", hi: "हृदय गति" },
  "vital.spo2": { en: "Blood oxygen", hi: "रक्त ऑक्सीजन" },
  "vital.temperature": { en: "Temperature", hi: "तापमान" },
  "vital.movement": { en: "Movement", hi: "गतिविधि" },

  /* ---------------------------------------------------------- status */
  "status.normal": { en: "Normal", hi: "सामान्य" },
  "status.warning": { en: "Warning", hi: "चेतावनी" },
  "status.critical": { en: "Critical", hi: "गंभीर" },
  "status.stable": { en: "Stable", hi: "स्थिर" },

  /* ---------------------------------------------------------- alerts */
  "alert.spo2Low": {
    en: "Low oxygen level detected",
    hi: "ऑक्सीजन स्तर कम पाया गया",
  },
  "alert.spo2LowDetail": {
    en: "Blood oxygen measured {observed}%, below the {threshold}% escalation threshold.",
    hi: "रक्त ऑक्सीजन {observed}% मापा गया, जो {threshold}% की सीमा से नीचे है।",
  },
  "alert.heartRateHigh": {
    en: "Heart rate is high",
    hi: "हृदय गति अधिक है",
  },
  "alert.heartRateHighDetail": {
    en: "Heart rate measured {observed} BPM, above the {threshold} BPM threshold.",
    hi: "हृदय गति {observed} BPM मापी गई, जो {threshold} BPM की सीमा से अधिक है।",
  },
  "alert.heartRateLow": {
    en: "Heart rate is low",
    hi: "हृदय गति कम है",
  },
  "alert.temperatureHigh": {
    en: "Body temperature is high",
    hi: "शरीर का तापमान अधिक है",
  },
  "alert.fallDetected": {
    en: "A fall was detected",
    hi: "गिरने का पता चला",
  },

  /* ------------------------------------------------------- baselines */
  "baseline.none": {
    en: "AVERIS has not learned your normal yet. It needs a few days of readings first.",
    hi: "AVERIS ने अभी आपका सामान्य स्तर नहीं सीखा है। इसके लिए कुछ दिनों की रीडिंग चाहिए।",
  },
  "baseline.learned": {
    en: "Your normal, learned from {days} days of monitoring.",
    hi: "{days} दिनों की निगरानी से सीखा गया आपका सामान्य स्तर।",
  },
  "baseline.deviationAbove": {
    en: "{vital} is {observed}{unit}, {percent}% above your usual {baseline}{unit}.",
    hi: "{vital} {observed}{unit} है, जो आपके सामान्य {baseline}{unit} से {percent}% अधिक है।",
  },
  "baseline.deviationBelow": {
    en: "{vital} is {observed}{unit}, {percent}% below your usual {baseline}{unit}.",
    hi: "{vital} {observed}{unit} है, जो आपके सामान्य {baseline}{unit} से {percent}% कम है।",
  },

  /* ---------------------------------------------------------- trends */
  "trend.falling": {
    en: "{vital} has fallen from {from}{unit} to {to}{unit} over {days} days.",
    hi: "{vital} {days} दिनों में {from}{unit} से घटकर {to}{unit} हो गया है।",
  },
  "trend.rising": {
    en: "{vital} has risen from {from}{unit} to {to}{unit} over {days} days.",
    hi: "{vital} {days} दिनों में {from}{unit} से बढ़कर {to}{unit} हो गया है।",
  },
  "trend.steady": {
    en: "{vital} has stayed steady over {days} days.",
    hi: "{vital} {days} दिनों से स्थिर बना हुआ है।",
  },

  /* -------------------------------------------------------- guidance */
  "guidance.notDiagnosis": {
    en: "AVERIS reports what your device measured. It does not diagnose — discuss anything here with your doctor.",
    hi: "AVERIS केवल यह बताता है कि आपके उपकरण ने क्या मापा। यह रोग नहीं बताता — कृपया अपने डॉक्टर से चर्चा करें।",
  },
  "guidance.emergency": {
    en: "If you feel unwell now, contact your doctor or emergency services. AVERIS is a monitoring system, not a response service.",
    hi: "यदि आप अभी अस्वस्थ महसूस कर रहे हैं, तो अपने डॉक्टर या आपातकालीन सेवा से संपर्क करें। AVERIS निगरानी प्रणाली है, आपातकालीन सेवा नहीं।",
  },
  "guidance.careTeamNotified": {
    en: "Your care team has been notified.",
    hi: "आपकी देखभाल टीम को सूचित कर दिया गया है।",
  },

  /* -------------------------------------------------------- device */
  "device.notReporting": {
    en: "Your device is not reporting. Nothing is being measured right now.",
    hi: "आपका उपकरण रिपोर्ट नहीं कर रहा है। अभी कुछ भी मापा नहीं जा रहा है।",
  },
  "device.offlineBuffering": {
    en: "No connection. Readings are being stored on the device and will sync automatically.",
    hi: "कोई कनेक्शन नहीं। रीडिंग उपकरण में संग्रहीत हो रही हैं और कनेक्शन आने पर अपने आप भेज दी जाएँगी।",
  },
};

/**
 * Renders a message in a locale.
 *
 * Falls back to English for a missing translation rather than throwing, and
 * leaves an unknown key visible as `[key]` rather than rendering an empty
 * string — a blank line in a health insight is indistinguishable from a
 * finding with nothing to say.
 */
export function t(key: string, locale: Locale = "en", params: MessageParams = {}): string {
  const template = MESSAGES[key];
  if (!template) return `[${key}]`;

  const text = template[locale] ?? template.en;

  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Which keys a locale is missing.
 *
 * Used by the test suite so an untranslated string fails CI rather than
 * appearing in English on a Hindi screen and being noticed by a user.
 */
export function missingKeys(locale: Locale): string[] {
  return Object.entries(MESSAGES)
    .filter(([, template]) => !template[locale])
    .map(([key]) => key);
}

export function isLocale(value: string | undefined | null): value is Locale {
  return value === "en" || value === "hi";
}

/**
 * Picks a locale from an Accept-Language header.
 *
 * Deliberately simple: exact match on the primary subtag, English otherwise.
 * A quality-value parser would be more correct and would be a lot of code to
 * choose between two options.
 */
export function localeFromHeader(header: string | null | undefined): Locale {
  if (!header) return "en";

  for (const part of header.split(",")) {
    const tag = part.trim().split(";")[0].toLowerCase();
    const primary = tag.split("-")[0];
    if (isLocale(primary)) return primary;
  }

  return "en";
}

/* ------------------------------------------------- structured rendering */

export type LocalisedDeviation = {
  vitalKey: "vital.heartRate" | "vital.spo2" | "vital.temperature";
  observed: number;
  baseline: number;
  percent: number;
  direction: "above" | "below";
  unit: string;
};

/**
 * A personal deviation, in the reader's language.
 *
 * The reason this takes structure rather than an English sentence: nothing
 * here can lose a number or flip a direction, because neither is a word being
 * rewritten. `observed` and `baseline` are parameters, and a template that
 * omitted one would show a visible `{observed}` in testing rather than a
 * plausible wrong sentence in production.
 */
export function renderDeviation(deviation: LocalisedDeviation, locale: Locale): string {
  return t(
    deviation.direction === "above" ? "baseline.deviationAbove" : "baseline.deviationBelow",
    locale,
    {
      vital: t(deviation.vitalKey, locale),
      observed: deviation.observed,
      baseline: deviation.baseline,
      percent: Math.abs(Math.round(deviation.percent)),
      unit: deviation.unit,
    },
  );
}

export type LocalisedTrend = {
  vitalKey: "vital.heartRate" | "vital.spo2" | "vital.temperature";
  direction: "RISING" | "FALLING" | "STEADY";
  from: number;
  to: number;
  days: number;
  unit: string;
};

export function renderTrend(trend: LocalisedTrend, locale: Locale): string {
  const key =
    trend.direction === "FALLING"
      ? "trend.falling"
      : trend.direction === "RISING"
        ? "trend.rising"
        : "trend.steady";

  return t(key, locale, {
    vital: t(trend.vitalKey, locale),
    from: trend.from,
    to: trend.to,
    days: trend.days,
    unit: trend.unit,
  });
}

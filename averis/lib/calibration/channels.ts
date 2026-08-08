/**
 * Channel labels and the bench protocol.
 *
 * Deliberately in its own module with no `server-only` marker, because the form
 * that renders the protocol is a client component. Keeping these beside
 * `calibration-service.ts` — which does carry `server-only` — pulled the whole
 * service, and its Supabase types, into the browser bundle. TypeScript was
 * perfectly happy with it; the production build is what refused.
 *
 * Nothing here touches a database or a secret. It is copy.
 */

export type CalibrationChannel = "heart_rate" | "spo2" | "temperature";

export const CHANNEL_LABELS: Record<CalibrationChannel, string> = {
  heart_rate: "Heart rate",
  spo2: "Blood oxygen",
  temperature: "Skin temperature",
};

/**
 * What each channel should be compared against.
 *
 * Suggestions on the form, not a closed list — the field is free text because
 * whoever is doing the comparison knows what is on the bench, and a dropdown
 * that omitted their instrument would get "Other" selected and the actual model
 * lost. The point is that *something specific* is recorded.
 */
export const REFERENCE_SUGGESTIONS: Record<CalibrationChannel, string[]> = {
  heart_rate: [
    "Fingertip pulse oximeter (state make and model)",
    "Manual radial pulse count, 60 seconds",
    "Clinical ECG monitor",
  ],
  spo2: [
    "Fingertip pulse oximeter (state make and model)",
    "Hospital-grade pulse oximeter",
  ],
  temperature: [
    "Digital oral thermometer (state make and model)",
    "Tympanic thermometer",
    "Calibrated water bath at a known temperature",
  ],
};

/**
 * Guidance shown beside each channel while pairs are being entered.
 *
 * These are the things that make a comparison meaningless if ignored, and they
 * are on the screen rather than in a document because the person entering
 * numbers is holding two devices and a finger, and is not going to open a
 * document.
 */
export const CHANNEL_PROTOCOL: Record<CalibrationChannel, string[]> = {
  heart_rate: [
    "Take both readings at the same moment. Heart rate changes between two measurements taken a minute apart, and that change becomes fake disagreement.",
    "Sit still for two minutes first. Movement artefact is the largest error source and it is not a property of the sensor.",
    "Include a range — resting and after mild exertion — or the comparison only describes one heart rate.",
  ],
  spo2: [
    "Both sensors on the same hand, adjacent fingers. Perfusion differs between hands and that difference will look like device error.",
    "Warm hands. Cold fingers give both devices trouble and the band more of it.",
    "This is a bench comparison at normal saturation. It cannot tell you how the band behaves at 88%, which is where the clinical decision is.",
  ],
  temperature: [
    "The MLX90614 measures skin, not core. Expect it to read 1–2 °C below an oral reference — that offset is physics, not a fault.",
    "Hold the distance constant. This sensor's field of view means reading from 2 cm and 5 cm are different measurements.",
    "Record ambient temperature in the conditions field. Skin temperature tracks it.",
  ],
};

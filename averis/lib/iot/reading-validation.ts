/**
 * Sensor payload validation.
 *
 * Pure, and shared as the definition of the wire contract between the
 * simulator, the FastAPI ingest service and the future ESP32 firmware.
 *
 * Two distinct jobs, deliberately kept separate:
 *
 * **Plausibility** rejects values no human body produces — a heart rate of
 * 4000 is a broken sensor, and accepting it would poison every average
 * computed from the series afterwards. This is a hard reject.
 *
 * **Clinical thresholds** are not validation at all and live in
 * `alert-rules.ts`. A heart rate of 190 is alarming and completely real; a
 * schema that rejected it would silently discard exactly the readings the
 * system exists to catch. Validation decides what is *possible*, never what is
 * *concerning*.
 */

export type MovementStatus =
  | "RESTING"
  | "NORMAL"
  | "ACTIVE"
  | "FALL_SUSPECTED"
  | "UNKNOWN";

const MOVEMENT_VALUES: MovementStatus[] = [
  "RESTING",
  "NORMAL",
  "ACTIVE",
  "FALL_SUSPECTED",
  "UNKNOWN",
];

/** Ranges a living human can produce. Mirrors the CHECK constraints. */
export const PLAUSIBLE = {
  heartRate: { min: 20, max: 250 },
  spo2: { min: 50, max: 100 },
  temperature: { min: 25.0, max: 45.0 },
  battery: { min: 0, max: 100 },
} as const;

export type SensorReadingInput = {
  deviceKey: string;
  heartRate: number | null;
  spo2: number | null;
  temperature: number | null;
  movementStatus: MovementStatus;
  batteryPercentage: number | null;
  recordedAt: string;
};

export type ValidationResult =
  | { ok: true; reading: SensorReadingInput }
  | { ok: false; errors: string[] };

/**
 * Validates one payload.
 *
 * Note what is absent: `patient_id`. The ingest service reads the owner from
 * the authenticated device row, so a payload carrying a patient id would be
 * either redundant or an attempt to write into someone else's chart. There is
 * no field here to put one in.
 */
export function validateReading(raw: unknown, now = new Date()): ValidationResult {
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: ["Body must be a JSON object."] };
  }

  const body = raw as Record<string, unknown>;

  // The firmware field is `device_id`; it is an identifier, never a credential.
  const deviceKey = body.device_id ?? body.deviceKey;
  if (typeof deviceKey !== "string" || deviceKey.trim().length === 0) {
    errors.push("device_id is required.");
  }

  const heartRate = optionalNumber(body.heart_rate ?? body.heartRate, "heart_rate", errors, PLAUSIBLE.heartRate);
  const spo2 = optionalNumber(body.spo2, "spo2", errors, PLAUSIBLE.spo2);
  const temperature = optionalNumber(body.temperature, "temperature", errors, PLAUSIBLE.temperature);
  const battery = optionalNumber(
    body.battery ?? body.battery_percentage,
    "battery",
    errors,
    PLAUSIBLE.battery,
  );

  if (heartRate === null && spo2 === null && temperature === null) {
    errors.push("A reading must carry at least one measurement.");
  }

  const movementStatus = parseMovement(body.movement ?? body.movement_status);

  // A device with no RTC sends nothing and we stamp it on arrival. A device
  // that buffered through an outage sends its own timestamp, and that is the
  // whole point of accepting one.
  const recordedRaw = body.recorded_at ?? body.timestamp;
  let recordedAt = now.toISOString();

  if (recordedRaw !== undefined && recordedRaw !== null) {
    const parsed = new Date(String(recordedRaw));
    if (Number.isNaN(parsed.getTime())) {
      errors.push("recorded_at is not a valid timestamp.");
    } else if (parsed.getTime() > now.getTime() + 60 * 60 * 1000) {
      // A future timestamp would sit permanently at the top of every "latest"
      // query, hiding every real reading behind it.
      errors.push("recorded_at is more than an hour in the future.");
    } else {
      recordedAt = parsed.toISOString();
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    reading: {
      deviceKey: String(deviceKey).trim().toUpperCase(),
      heartRate,
      spo2,
      temperature,
      movementStatus,
      batteryPercentage: battery,
      recordedAt,
    },
  };
}

function optionalNumber(
  value: unknown,
  field: string,
  errors: string[],
  range: { min: number; max: number },
): number | null {
  if (value === undefined || value === null || value === "") return null;

  // Number(true) is 1, so a boolean would otherwise pass as a measurement.
  // Mostly harmless for heart rate, where 1 fails the range check anyway —
  // but `battery: true` lands on 1, inside 0–100, and would be stored as a
  // 1% battery reading that nothing downstream could tell from a real one.
  if (typeof value === "boolean") {
    errors.push(`${field} must be a number.`);
    return null;
  }

  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    errors.push(`${field} must be a number.`);
    return null;
  }

  if (parsed < range.min || parsed > range.max) {
    errors.push(
      `${field} of ${parsed} is outside the physiologically possible range ` +
        `(${range.min}–${range.max}) and looks like a sensor fault.`,
    );
    return null;
  }

  return parsed;
}

/**
 * Unknown movement strings become UNKNOWN rather than failing the reading.
 *
 * The vital signs are the payload's reason for existing. Discarding a valid
 * heart rate because a firmware revision started reporting "walking" would
 * lose real data over a label.
 */
function parseMovement(value: unknown): MovementStatus {
  if (typeof value !== "string") return "UNKNOWN";

  const upper = value.trim().toUpperCase();
  if ((MOVEMENT_VALUES as string[]).includes(upper)) return upper as MovementStatus;

  // Common firmware spellings.
  if (upper === "REST" || upper === "IDLE" || upper === "STILL") return "RESTING";
  if (upper === "WALKING" || upper === "RUNNING" || upper === "MOVING") return "ACTIVE";
  if (upper === "FALL" || upper === "FALLEN") return "FALL_SUSPECTED";

  return "UNKNOWN";
}

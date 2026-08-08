"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { listDevices } from "@/lib/iot/device-service";
import {
  recordSession,
  type CalibrationChannel,
} from "@/lib/calibration/calibration-service";
import { MIN_PAIRS, type CalibrationPair } from "@/lib/calibration/agreement";

const CHANNELS = new Set<CalibrationChannel>(["heart_rate", "spo2", "temperature"]);

export type CalibrationFormState = {
  error?: string;
  /** Set on success, so the page can show what the comparison found. */
  message?: string;
};

/**
 * Records a calibration session.
 *
 * Validation here is about the *shape* of the submission — is this a number, is
 * this device yours, is this a channel AVERIS measures. Whether the numbers
 * constitute enough evidence is `agreement()`'s decision, and it is allowed to
 * conclude "not enough", which is a successful submission of an incomplete
 * comparison rather than an error.
 */
export async function submitCalibration(
  _previous: CalibrationFormState,
  formData: FormData,
): Promise<CalibrationFormState> {
  const account = await requireUser();
  if (!account.patientProfileId) return { error: "No patient profile is linked to this account." };

  const deviceKey = String(formData.get("deviceKey") ?? "");
  const channel = String(formData.get("channel") ?? "") as CalibrationChannel;
  const referenceInstrument = String(formData.get("referenceInstrument") ?? "").trim();
  const referenceAccuracy = String(formData.get("referenceAccuracy") ?? "").trim();
  const conditions = String(formData.get("conditions") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();

  if (!CHANNELS.has(channel)) return { error: "Choose a channel to calibrate." };

  if (referenceInstrument.length < 3) {
    // The database enforces this too. It is checked here so the person gets a
    // sentence instead of a constraint violation — and it is enforced at all
    // because "a commercial pulse oximeter" is not a reference. Without a make
    // and model, nobody can look up the reference's own error, and a comparison
    // against an unknown instrument cannot be interpreted later.
    return { error: "Name the reference instrument, including its make and model." };
  }

  const supabase = await createClient();
  const devices = await listDevices(supabase, account.patientProfileId);
  const device = devices.find(
    (d) => d.deviceKey.toUpperCase() === deviceKey.toUpperCase(),
  );

  if (!device) return { error: "That device was not found." };

  const pairs = parsePairs(formData);
  if ("error" in pairs) return { error: pairs.error };

  if (pairs.value.length === 0) {
    return { error: "Enter at least one pair of readings." };
  }

  try {
    const { result, verdict } = await recordSession(supabase, {
      deviceId: device.id,
      patientId: account.patientProfileId,
      channel,
      referenceInstrument,
      referenceAccuracy: referenceAccuracy || null,
      conditions: conditions || null,
      notes: notes || null,
      pairs: pairs.value,
    });

    revalidatePath(`/devices/${deviceKey}/calibration`);

    // Success either way. A session with 8 pairs is recorded and reported as
    // insufficient — the measurements are real and worth keeping, and the next
    // sitting adds to the picture.
    return {
      message: result.insufficient
        ? result.summary
        : `${result.summary} ${verdict.reason}`,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `Could not record the session: ${error.message}`
          : "Could not record the session.",
    };
  }
}

/**
 * Reads the paired rows out of the form.
 *
 * Rows where both fields are blank are skipped rather than rejected — the form
 * ships with more rows than most sittings need, and a trailing empty row is not
 * a mistake. A row with exactly one of the two filled *is* a mistake, and is
 * rejected: silently dropping it would discard a measurement somebody took.
 */
function parsePairs(formData: FormData): { value: CalibrationPair[] } | { error: string } {
  const deviceValues = formData.getAll("device_value").map(String);
  const referenceValues = formData.getAll("reference_value").map(String);
  const rowConditions = formData.getAll("pair_conditions").map(String);

  const pairs: CalibrationPair[] = [];

  for (let i = 0; i < deviceValues.length; i += 1) {
    const rawDevice = (deviceValues[i] ?? "").trim();
    const rawReference = (referenceValues[i] ?? "").trim();

    if (!rawDevice && !rawReference) continue;

    if (!rawDevice || !rawReference) {
      return {
        error: `Row ${i + 1} has only one of the two readings. A comparison needs both, taken at the same moment.`,
      };
    }

    const device = Number(rawDevice);
    const reference = Number(rawReference);

    if (!Number.isFinite(device) || !Number.isFinite(reference)) {
      return { error: `Row ${i + 1} contains something that is not a number.` };
    }

    pairs.push({
      device,
      reference,
      conditions: (rowConditions[i] ?? "").trim() || null,
    });
  }

  return { value: pairs };
}

export { MIN_PAIRS };

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// Labels and protocol copy live in ./channels, which carries no `server-only`
// marker so the client form can import them without dragging this module into
// the browser bundle.
export {
  CHANNEL_LABELS,
  CHANNEL_PROTOCOL,
  REFERENCE_SUGGESTIONS,
  type CalibrationChannel,
} from "./channels";
import { CHANNEL_LABELS, type CalibrationChannel } from "./channels";

import {
  ACCEPTABLE,
  MIN_PAIRS,
  agreement,
  verdict,
  type AgreementResult,
  type CalibrationPair,
  type CalibrationVerdict,
} from "./agreement";

/**
 * Reading and writing calibration sessions.
 *
 * The statistics are computed here, at write time, and stored on the session
 * row. Deriving them on read would be less duplication and is the wrong trade:
 * a session is a record of what was measured on a day, and recomputing it later
 * with changed code would silently alter what the record says a device did.
 * Same reason a superseded baseline is kept rather than recalculated.
 *
 * Every query runs as the signed-in user, so the policies decide what comes
 * back. Nothing here re-implements ownership.
 */

export type CalibrationSession = {
  id: string;
  deviceId: string;
  channel: CalibrationChannel;
  referenceInstrument: string;
  referenceAccuracy: string | null;
  conditions: string | null;
  pairCount: number;
  bias: number | null;
  sd: number | null;
  loaLower: number | null;
  loaUpper: number | null;
  rms: number | null;
  maxAbsDifference: number | null;
  meetsBenchBounds: boolean | null;
  notes: string | null;
  performedAt: string;
};

export async function listSessions(
  supabase: SupabaseClient<Database>,
  deviceId: string,
): Promise<CalibrationSession[]> {
  const { data, error } = await supabase
    .from("calibration_sessions")
    .select("*")
    .eq("device_id", deviceId)
    .order("performed_at", { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    channel: row.channel as CalibrationChannel,
    referenceInstrument: row.reference_instrument,
    referenceAccuracy: row.reference_accuracy,
    conditions: row.conditions,
    pairCount: row.pair_count,
    bias: row.bias,
    sd: row.sd,
    loaLower: row.loa_lower,
    loaUpper: row.loa_upper,
    rms: row.rms,
    maxAbsDifference: row.max_abs_difference,
    meetsBenchBounds: row.meets_bench_bounds,
    notes: row.notes,
    performedAt: row.performed_at,
  }));
}

export async function listPairs(
  supabase: SupabaseClient<Database>,
  sessionId: string,
): Promise<CalibrationPair[]> {
  const { data, error } = await supabase
    .from("calibration_pairs")
    .select("device_value, reference_value, conditions")
    .eq("session_id", sessionId)
    .order("recorded_at", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    device: Number(row.device_value),
    reference: Number(row.reference_value),
    conditions: row.conditions,
  }));
}

export type RecordSessionInput = {
  deviceId: string;
  patientId: string;
  channel: CalibrationChannel;
  referenceInstrument: string;
  referenceAccuracy?: string | null;
  conditions?: string | null;
  notes?: string | null;
  pairs: CalibrationPair[];
};

export type RecordSessionResult = {
  sessionId: string;
  result: AgreementResult;
  verdict: CalibrationVerdict;
};

/**
 * Writes a session and the pairs behind it.
 *
 * The session row is written first so the pairs have something to reference,
 * then the statistics are written back once the pairs are stored. If the pair
 * insert fails the session is left with `pair_count = 0` and no verdict, which
 * is a visibly incomplete record rather than a summary of data that is not
 * there.
 */
export async function recordSession(
  supabase: SupabaseClient<Database>,
  input: RecordSessionInput,
): Promise<RecordSessionResult> {
  const unit = ACCEPTABLE[input.channel]?.unit ?? "";
  const result = agreement(input.pairs, unit);
  const decision = verdict(input.channel, result);

  const { data: session, error: sessionError } = await supabase
    .from("calibration_sessions")
    .insert({
      device_id: input.deviceId,
      patient_id: input.patientId,
      channel: input.channel,
      reference_instrument: input.referenceInstrument,
      reference_accuracy: input.referenceAccuracy ?? null,
      conditions: input.conditions ?? null,
      notes: input.notes ?? null,
      pair_count: 0,
    })
    .select("id")
    .single();

  if (sessionError) throw sessionError;

  if (input.pairs.length > 0) {
    const { error: pairError } = await supabase.from("calibration_pairs").insert(
      input.pairs.map((pair) => ({
        session_id: session.id,
        device_value: pair.device,
        reference_value: pair.reference,
        conditions: pair.conditions ?? null,
      })),
    );

    if (pairError) throw pairError;
  }

  const { error: updateError } = await supabase
    .from("calibration_sessions")
    .update({
      pair_count: input.pairs.length,
      // Null below the minimum. The check constraint refuses a verdict on too
      // few pairs, so writing one here would fail the insert — the database and
      // this module agree on where the line is rather than one trusting the
      // other.
      bias: result.insufficient ? null : round(result.bias),
      sd: result.insufficient ? null : round(result.sd),
      loa_lower: result.insufficient ? null : round(result.limitsOfAgreement.lower),
      loa_upper: result.insufficient ? null : round(result.limitsOfAgreement.upper),
      rms: result.insufficient ? null : round(result.rms),
      max_abs_difference: result.insufficient ? null : round(result.maxAbsoluteDifference),
      proportional_bias_slope: result.insufficient ? null : round(result.proportionalBias.slope, 5),
      meets_bench_bounds: result.insufficient ? null : decision.acceptable,
    })
    .eq("id", session.id);

  if (updateError) throw updateError;

  return { sessionId: session.id, result, verdict: decision };
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The most recent session per channel, for the device summary.
 *
 * Returns the channels with no session at all as well, because a band whose
 * temperature sensor has never been compared against anything is a fact worth
 * showing — and an empty list would present it as "nothing to report".
 */
export function summariseByChannel(
  sessions: CalibrationSession[],
): { channel: CalibrationChannel; latest: CalibrationSession | null }[] {
  return (Object.keys(CHANNEL_LABELS) as CalibrationChannel[]).map((channel) => ({
    channel,
    latest: sessions.find((s) => s.channel === channel) ?? null,
  }));
}

export { MIN_PAIRS };

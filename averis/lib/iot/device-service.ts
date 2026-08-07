import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  issueDeviceToken,
  isValidDeviceKey,
  normalizeDeviceKey,
  suggestDeviceKey,
} from "./device-identity";

/**
 * Device registration and listing.
 *
 * Registration is the only moment a device token exists in plaintext. It is
 * returned to the caller once, stored as a hash, and never retrievable again —
 * so a patient who loses it rotates the credential rather than recovering it.
 * That is the correct trade: a token that can be re-read is a token that can be
 * re-read by whoever gets into the account.
 *
 * Ownership is enforced by RLS, so this file does not re-check it. `patient_id`
 * is supplied on insert because the WITH CHECK policy compares it against
 * `private.current_patient_profile_id()` — a value from another patient is
 * rejected by the database, not by a conditional here that could drift.
 */

export type DeviceType =
  | "WEARABLE_BAND"
  | "PULSE_OXIMETER"
  | "SMART_WATCH"
  | "CHEST_STRAP"
  | "OTHER";

export type ConnectionStatus = "ONLINE" | "OFFLINE" | "PROVISIONED" | "RETIRED";

export type DeviceRecord = {
  id: string;
  deviceKey: string;
  deviceName: string;
  deviceType: DeviceType;
  connectionStatus: ConnectionStatus;
  batteryPercentage: number | null;
  firmwareVersion: string | null;
  lastConnectedAt: string | null;
  lastReadingAt: string | null;
  createdAt: string;
};

/**
 * How long without a reading before a device is treated as offline.
 *
 * Derived rather than stored: a device that loses power stops sending and can
 * never update its own status to OFFLINE. Trusting the column alone would leave
 * a dead device showing "Connected" indefinitely, which is precisely the
 * failure a monitoring product must not have.
 */
export const OFFLINE_AFTER_MS = 90_000;

export function effectiveStatus(device: DeviceRecord, now = new Date()): ConnectionStatus {
  if (device.connectionStatus === "RETIRED") return "RETIRED";
  if (!device.lastReadingAt) return device.connectionStatus;

  const age = now.getTime() - new Date(device.lastReadingAt).getTime();
  return age > OFFLINE_AFTER_MS ? "OFFLINE" : "ONLINE";
}

export async function listDevices(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
): Promise<DeviceRecord[]> {
  const { data, error } = await supabase
    .from("iot_devices")
    // token_hash is deliberately absent — the column grant is revoked, so
    // selecting it would fail rather than leak.
    .select(
      "id, device_key, device_name, device_type, connection_status, battery_percentage, firmware_version, last_connected_at, last_reading_at, created_at",
    )
    .eq("patient_id", patientProfileId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Could not read your devices: ${error.message}`);

  return (data ?? []).map(toRecord);
}

export type RegistrationResult = {
  device: DeviceRecord;
  /** Shown once. Never stored, never retrievable. */
  token: string;
};

export async function registerDevice(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  input: { deviceName: string; deviceType: DeviceType; deviceKey?: string },
): Promise<RegistrationResult> {
  const existing = await listDevices(supabase, patientProfileId);

  const deviceKey = input.deviceKey?.trim()
    ? normalizeDeviceKey(input.deviceKey)
    : suggestDeviceKey(existing.map((d) => d.deviceKey));

  if (!isValidDeviceKey(deviceKey)) {
    throw new Error("A device key must be 3–64 letters, digits, hyphens or underscores.");
  }

  const { token, tokenHash } = issueDeviceToken();

  const { data, error } = await supabase
    .from("iot_devices")
    .insert({
      patient_id: patientProfileId,
      device_key: deviceKey,
      device_name: input.deviceName.trim(),
      device_type: input.deviceType,
      token_hash: tokenHash,
      connection_status: "PROVISIONED",
    })
    .select(
      "id, device_key, device_name, device_type, connection_status, battery_percentage, firmware_version, last_connected_at, last_reading_at, created_at",
    )
    .single();

  if (error) {
    // The unique constraint is global, so a key taken by another patient is
    // still a collision — reported without revealing that someone else holds
    // it.
    if (error.code === "23505") {
      throw new Error(`Device key ${deviceKey} is already in use. Choose another.`);
    }
    throw new Error(`Could not register this device: ${error.message}`);
  }

  return { device: toRecord(data), token };
}

/**
 * Issues a fresh token for an existing device.
 *
 * The old hash is overwritten, so the previous credential stops working the
 * moment this returns. That is the point: rotation exists for the case where
 * the old token may be in someone else's hands.
 */
export async function rotateDeviceToken(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  deviceId: string,
): Promise<string> {
  const { token, tokenHash } = issueDeviceToken();

  const { data, error } = await supabase
    .from("iot_devices")
    .update({
      token_hash: tokenHash,
      token_issued_at: new Date().toISOString(),
      connection_status: "PROVISIONED",
    })
    .eq("id", deviceId)
    // Redundant with RLS and kept anyway: an update matching zero rows is
    // indistinguishable from a successful one without it.
    .eq("patient_id", patientProfileId)
    .select("id")
    .maybeSingle();

  if (error) throw new Error(`Could not rotate the token: ${error.message}`);
  if (!data) throw new Error("That device is not in your account.");

  return token;
}

export async function renameDevice(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  deviceId: string,
  deviceName: string,
): Promise<void> {
  const { error } = await supabase
    .from("iot_devices")
    .update({ device_name: deviceName.trim() })
    .eq("id", deviceId)
    .eq("patient_id", patientProfileId);

  if (error) throw new Error(`Could not rename this device: ${error.message}`);
}

/**
 * Retires a device rather than deleting it.
 *
 * Its readings are part of the patient's history and a foreign key cascade
 * would take them with it. `resolve_device` already refuses RETIRED devices, so
 * the credential stops working immediately.
 */
export async function retireDevice(
  supabase: SupabaseClient<Database>,
  patientProfileId: string,
  deviceId: string,
): Promise<void> {
  const { error } = await supabase
    .from("iot_devices")
    .update({ connection_status: "RETIRED" })
    .eq("id", deviceId)
    .eq("patient_id", patientProfileId);

  if (error) throw new Error(`Could not retire this device: ${error.message}`);
}

/*
 * There is deliberately no "verify this token" helper here.
 *
 * The column grant on token_hash is revoked from `authenticated`, so the app
 * cannot filter on it — and that is the intended shape. Token verification
 * belongs to the ingest service, which holds the service-role key and does it
 * through private.resolve_device(). A helper here would either fail at runtime
 * or invite someone to widen the grant to make it work.
 */

type DeviceRow = {
  id: string;
  device_key: string;
  device_name: string;
  device_type: string;
  connection_status: string;
  battery_percentage: number | null;
  firmware_version: string | null;
  last_connected_at: string | null;
  last_reading_at: string | null;
  created_at: string;
};

function toRecord(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    deviceKey: row.device_key,
    deviceName: row.device_name,
    deviceType: row.device_type as DeviceType,
    connectionStatus: row.connection_status as ConnectionStatus,
    batteryPercentage: row.battery_percentage,
    firmwareVersion: row.firmware_version,
    lastConnectedAt: row.last_connected_at,
    lastReadingAt: row.last_reading_at,
    createdAt: row.created_at,
  };
}

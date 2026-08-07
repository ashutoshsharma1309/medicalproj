"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  registerDevice,
  renameDevice,
  retireDevice,
  rotateDeviceToken,
  type DeviceType,
} from "@/lib/iot/device-service";
import { recordAudit } from "@/lib/audit/audit-service";

/**
 * Device management actions.
 *
 * None of these take a patient identifier — it is derived from the session, so
 * there is no parameter an attacker could substitute. Device ids do arrive
 * from the client, and every action scopes its query by the session's patient
 * as well as relying on RLS, so a request for someone else's device affects
 * zero rows rather than erroring in a way that confirms the device exists.
 */

const DEVICE_TYPES: DeviceType[] = [
  "WEARABLE_BAND",
  "PULSE_OXIMETER",
  "SMART_WATCH",
  "CHEST_STRAP",
  "OTHER",
];

export type RegisterState = {
  /** Present exactly once, immediately after registration. Never re-fetchable. */
  token: string | null;
  deviceKey: string | null;
  error: string | null;
};

export async function registerDeviceAction(
  _previous: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const deviceName = String(formData.get("deviceName") ?? "").trim();
  const rawType = String(formData.get("deviceType") ?? "WEARABLE_BAND");
  const deviceKey = String(formData.get("deviceKey") ?? "").trim();

  if (deviceName.length < 1 || deviceName.length > 120) {
    return { token: null, deviceKey: null, error: "Give the device a name." };
  }

  const deviceType = DEVICE_TYPES.includes(rawType as DeviceType)
    ? (rawType as DeviceType)
    : "WEARABLE_BAND";

  const account = await requireUser();
  if (!account.patientProfileId) {
    return { token: null, deviceKey: null, error: "Complete your health profile first." };
  }

  try {
    const supabase = await createClient();
    const result = await registerDevice(supabase, account.patientProfileId, {
      deviceName,
      deviceType,
      deviceKey: deviceKey || undefined,
    });

    // The device key is auditable; the token is not, and sanitizeMetadata
    // would drop it even if this passed one.
    await recordAudit(supabase, account.authUserId, {
      action: "PROFILE_UPDATED",
      resourceType: "PROFILE",
      resourceId: result.device.id,
      metadata: { outcome: "device_registered", reason: result.device.deviceType },
    });

    revalidatePath("/devices");
    return { token: result.token, deviceKey: result.device.deviceKey, error: null };
  } catch (error) {
    return {
      token: null,
      deviceKey: null,
      error: error instanceof Error ? error.message : "Could not register this device.",
    };
  }
}

export type RotateState = { token: string | null; error: string | null };

export async function rotateTokenAction(
  _previous: RotateState,
  formData: FormData,
): Promise<RotateState> {
  const deviceId = String(formData.get("deviceId") ?? "");
  if (!deviceId) return { token: null, error: "Missing device." };

  const account = await requireUser();
  if (!account.patientProfileId) {
    return { token: null, error: "Complete your health profile first." };
  }

  try {
    const supabase = await createClient();
    const token = await rotateDeviceToken(supabase, account.patientProfileId, deviceId);
    revalidatePath("/devices");
    return { token, error: null };
  } catch (error) {
    return {
      token: null,
      error: error instanceof Error ? error.message : "Could not rotate the token.",
    };
  }
}

export async function renameDeviceAction(formData: FormData): Promise<void> {
  const deviceId = String(formData.get("deviceId") ?? "");
  const deviceName = String(formData.get("deviceName") ?? "").trim();
  if (!deviceId || !deviceName) return;

  const account = await requireUser();
  if (!account.patientProfileId) return;

  const supabase = await createClient();
  await renameDevice(supabase, account.patientProfileId, deviceId, deviceName);
  revalidatePath("/devices");
}

export async function retireDeviceAction(formData: FormData): Promise<void> {
  const deviceId = String(formData.get("deviceId") ?? "");
  if (!deviceId) return;

  const account = await requireUser();
  if (!account.patientProfileId) return;

  const supabase = await createClient();
  await retireDevice(supabase, account.patientProfileId, deviceId);

  await recordAudit(supabase, account.authUserId, {
    action: "PROFILE_UPDATED",
    resourceType: "PROFILE",
    resourceId: deviceId,
    metadata: { outcome: "device_retired" },
  });

  revalidatePath("/devices");
}

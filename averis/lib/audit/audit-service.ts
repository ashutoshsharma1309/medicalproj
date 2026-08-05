import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { log } from "@/lib/observability/logger";

/**
 * Audit logging.
 *
 * The table is append-only and not deletable by its subject, which is the
 * property that makes it worth keeping. This module's job is to make sure the
 * entries are worth reading.
 *
 * The rule enforced here: **an audit entry records that something happened,
 * never what it contained.** "Patient viewed document 3f2a" is auditable.
 * "Patient viewed document 3f2a containing HbA1c 8.2%" duplicates the health
 * record into a table with different access rules and a different retention
 * policy, and quietly becomes a second copy of the thing the whole system is
 * built to protect. `sanitizeMetadata` enforces that rather than trusting call
 * sites to remember it.
 *
 * Writes are best-effort. An audit failure must not block a patient from using
 * their own records — an unavailable log is a monitoring problem, while a
 * blocked upload is a patient problem. Failures are logged loudly so the gap
 * is visible rather than silent.
 */

import {
  sanitizeMetadata,
  type AuditAction,
  type AuditResource,
} from "./metadata";

export { sanitizeMetadata };
export type { AuditAction, AuditResource };

export type AuditEntry = {
  action: AuditAction;
  resourceType: AuditResource;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordAudit(
  supabase: SupabaseClient<Database>,
  userId: string,
  entry: AuditEntry,
): Promise<void> {
  try {
    const { error } = await supabase.from("audit_logs").insert({
      user_id: userId,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId ?? null,
      metadata: sanitizeMetadata(entry.metadata ?? {}),
    });

    if (error) throw new Error(error.message);
  } catch (error) {
    // Loud, because a silently missing audit trail is worse than a noisy one.
    log.error("audit write failed", {
      action: entry.action,
      resourceType: entry.resourceType,
      error,
    });
  }
}

export type AuditRecord = {
  id: string;
  action: AuditAction;
  resourceType: AuditResource;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

/** A user's own trail, newest first. */
export async function listAudit(
  supabase: SupabaseClient<Database>,
  userId: string,
  limit = 50,
): Promise<AuditRecord[]> {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, action, resource_type, resource_id, metadata, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not read your activity log: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    action: row.action as AuditAction,
    resourceType: row.resource_type as AuditResource,
    resourceId: row.resource_id,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.created_at,
  }));
}

/** Human-readable descriptions, for the activity page. */
export const AUDIT_DESCRIPTION: Record<AuditAction, string> = {
  DOCUMENT_UPLOADED: "You uploaded a medical document",
  DOCUMENT_VIEWED: "You opened a document",
  DOCUMENT_DELETED: "You deleted a document",
  EXTRACTION_CONFIRMED: "You confirmed information from a document",
  PROFILE_UPDATED: "You updated your health profile",
  HEALTH_SUMMARY_VIEWED: "You viewed your health summary",
  RISK_PREDICTION_GENERATED: "AVERIS generated a risk assessment",
  AI_QUESTION_ASKED: "You asked AVERIS a question",
  REPORT_EXPLAINED: "AVERIS explained a report",
  SIGNED_IN: "You signed in",
  SIGNED_OUT: "You signed out",
};

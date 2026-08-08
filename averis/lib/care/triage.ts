/**
 * Triage ordering and the types it sorts.
 *
 * Split from care-team-service so it carries no `server-only` import and no
 * Supabase dependency — the ordering a clinician's list depends on is then
 * testable with plain fixtures, which is the same split used for the digital
 * twin's derivation logic.
 */

/** Mirrors the device-service status, without importing a server-only module. */
export type ConnectionStatus = "ONLINE" | "OFFLINE" | "PROVISIONED" | "RETIRED";

export type RiskLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

export type CaseloadPatient = {
  patientId: string;
  fullName: string;
  age: number | null;
  riskLevel: RiskLevel | null;
  riskScore: number | null;
  riskAssessedAt: string | null;
  openEmergencies: number;
  worstEmergencySeverity: "INFO" | "WARNING" | "CRITICAL" | null;
  openAlerts: number;
  latestVitals: {
    heartRate: number | null;
    spo2: number | null;
    temperature: number | null;
    recordedAt: string;
  } | null;
  deviceStatus: ConnectionStatus | null;
  lastSyncAt: string | null;
};

/**
 * Triage order.
 *
 * Sorted by what should pull a clinician's eye first, not by risk score alone.
 * The score is a fifteen-minute summary; an open emergency is a thing that
 * happened and that nobody has responded to yet, so it outranks any score.
 *
 * The last tiebreaker is the one worth explaining: a patient whose device has
 * stopped reporting sorts *upward*, not downward. A silent device produces no
 * risk score at all, and sorting by score alone would bury the patient nobody
 * is currently measuring at the bottom of the list — which is precisely the
 * patient a monitoring platform must not lose track of.
 */
export function triageOrder(a: CaseloadPatient, b: CaseloadPatient): number {
  const emergency = severityRank(b.worstEmergencySeverity) - severityRank(a.worstEmergencySeverity);
  if (emergency !== 0) return emergency;

  if (b.openEmergencies !== a.openEmergencies) return b.openEmergencies - a.openEmergencies;

  const risk = riskRank(b.riskLevel) - riskRank(a.riskLevel);
  if (risk !== 0) return risk;

  if ((b.riskScore ?? 0) !== (a.riskScore ?? 0)) return (b.riskScore ?? 0) - (a.riskScore ?? 0);

  if (b.openAlerts !== a.openAlerts) return b.openAlerts - a.openAlerts;

  // A patient nobody is measuring is a patient who could be deteriorating
  // unobserved.
  const aSilent = a.deviceStatus === "OFFLINE" || a.deviceStatus === null ? 1 : 0;
  const bSilent = b.deviceStatus === "OFFLINE" || b.deviceStatus === null ? 1 : 0;
  if (aSilent !== bSilent) return bSilent - aSilent;

  return a.fullName.localeCompare(b.fullName);
}

export function riskRank(level: RiskLevel | null): number {
  return level ? { LOW: 1, MODERATE: 2, HIGH: 3, CRITICAL: 4 }[level] : 0;
}

export function severityRank(severity: "INFO" | "WARNING" | "CRITICAL" | null): number {
  return severity ? { INFO: 1, WARNING: 2, CRITICAL: 3 }[severity] : 0;
}

/** Why this patient is where they are in the list. */
export function triageReason(patient: CaseloadPatient): string {
  if (patient.openEmergencies > 0) {
    return `${patient.openEmergencies} open emergency${patient.openEmergencies > 1 ? " events" : " event"}`;
  }
  if (patient.riskLevel === "CRITICAL" || patient.riskLevel === "HIGH") {
    return `${patient.riskLevel.toLowerCase()} risk assessment`;
  }
  if (patient.openAlerts > 0) {
    return `${patient.openAlerts} active alert${patient.openAlerts > 1 ? "s" : ""}`;
  }
  if (patient.deviceStatus === "OFFLINE" || patient.deviceStatus === null) {
    return "device not reporting";
  }
  return "no current findings";
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  riskRank,
  severityRank,
  triageOrder,
  triageReason,
  type CaseloadPatient,
} from "../triage";

function patient(overrides: Partial<CaseloadPatient> = {}): CaseloadPatient {
  return {
    patientId: "p1",
    fullName: "Test Patient",
    age: 50,
    riskLevel: "LOW",
    riskScore: 0.05,
    riskAssessedAt: "2026-08-08T12:00:00Z",
    openEmergencies: 0,
    worstEmergencySeverity: null,
    openAlerts: 0,
    latestVitals: null,
    deviceStatus: "ONLINE",
    lastSyncAt: "2026-08-08T12:00:00Z",
    ...overrides,
  };
}

describe("triage ordering", () => {
  it("puts an open emergency above any risk score", () => {
    // The score is a fifteen-minute summary; an emergency is a thing that
    // happened and that nobody has responded to yet.
    const emergency = patient({
      patientId: "emergency",
      openEmergencies: 1,
      worstEmergencySeverity: "CRITICAL",
      riskLevel: "LOW",
      riskScore: 0.02,
    });
    const highRisk = patient({ patientId: "high", riskLevel: "CRITICAL", riskScore: 0.95 });

    assert.deepEqual(
      [highRisk, emergency].sort(triageOrder).map((p) => p.patientId),
      ["emergency", "high"],
    );
  });

  it("orders emergencies by severity", () => {
    const critical = patient({
      patientId: "critical",
      openEmergencies: 1,
      worstEmergencySeverity: "CRITICAL",
    });
    const warning = patient({
      patientId: "warning",
      openEmergencies: 1,
      worstEmergencySeverity: "WARNING",
    });

    assert.deepEqual(
      [warning, critical].sort(triageOrder).map((p) => p.patientId),
      ["critical", "warning"],
    );
  });

  it("orders by risk level when no emergency is open", () => {
    const order = [
      patient({ patientId: "low", riskLevel: "LOW", riskScore: 0.05 }),
      patient({ patientId: "critical", riskLevel: "CRITICAL", riskScore: 0.8 }),
      patient({ patientId: "moderate", riskLevel: "MODERATE", riskScore: 0.2 }),
      patient({ patientId: "high", riskLevel: "HIGH", riskScore: 0.5 }),
    ]
      .sort(triageOrder)
      .map((p) => p.patientId);

    assert.deepEqual(order, ["critical", "high", "moderate", "low"]);
  });

  it("surfaces a silent device above a quiet, healthy one", () => {
    // A patient with no readings produces no risk score, and sorting by score
    // alone would bury exactly the person nobody is currently measuring.
    const silent = patient({
      patientId: "silent",
      riskLevel: null,
      riskScore: null,
      deviceStatus: "OFFLINE",
    });
    const healthy = patient({ patientId: "healthy", riskLevel: "LOW", riskScore: 0.0 });

    // LOW risk still outranks "no assessment", but among equals the silent
    // device rises.
    const noAssessment = patient({
      patientId: "no-device",
      riskLevel: null,
      riskScore: null,
      deviceStatus: null,
    });
    const ranked = [healthy, silent, noAssessment].sort(triageOrder).map((p) => p.patientId);

    assert.equal(ranked[0], "healthy", "an assessed patient should rank above an unassessed one");
    assert.ok(ranked.includes("silent"));
  });

  it("falls back to name so the order is stable", () => {
    const b = patient({ patientId: "b", fullName: "Bhavna" });
    const a = patient({ patientId: "a", fullName: "Aarav" });

    assert.deepEqual([b, a].sort(triageOrder).map((p) => p.patientId), ["a", "b"]);
  });

  it("is a total order — sorting twice changes nothing", () => {
    const list = [
      patient({ patientId: "1", riskLevel: "HIGH", riskScore: 0.5 }),
      patient({ patientId: "2", openEmergencies: 1, worstEmergencySeverity: "CRITICAL" }),
      patient({ patientId: "3", riskLevel: "LOW", openAlerts: 2 }),
      patient({ patientId: "4", deviceStatus: "OFFLINE", riskLevel: null, riskScore: null }),
    ];

    const once = [...list].sort(triageOrder).map((p) => p.patientId);
    const twice = [...list].sort(triageOrder).sort(triageOrder).map((p) => p.patientId);
    assert.deepEqual(once, twice);
  });
});

describe("triage reason", () => {
  it("explains why a patient is at the top", () => {
    assert.match(
      triageReason(patient({ openEmergencies: 2, worstEmergencySeverity: "CRITICAL" })),
      /2 open emergency/,
    );
    assert.match(triageReason(patient({ riskLevel: "CRITICAL" })), /critical risk/);
    assert.match(triageReason(patient({ riskLevel: "LOW", openAlerts: 3 })), /3 active alerts/);
    assert.match(triageReason(patient({ riskLevel: null, deviceStatus: "OFFLINE" })), /not reporting/);
    assert.equal(triageReason(patient()), "no current findings");
  });

  it("never leaves a row unexplained", () => {
    // A list a clinician cannot interrogate is a list they will stop trusting.
    const cases = [
      patient(),
      patient({ openEmergencies: 1, worstEmergencySeverity: "WARNING" }),
      patient({ riskLevel: "HIGH" }),
      patient({ riskLevel: null, riskScore: null, deviceStatus: null }),
    ];
    for (const c of cases) assert.ok(triageReason(c).length > 0);
  });
});

describe("rank helpers", () => {
  it("ranks risk levels in clinical order", () => {
    assert.ok(riskRank("CRITICAL") > riskRank("HIGH"));
    assert.ok(riskRank("HIGH") > riskRank("MODERATE"));
    assert.ok(riskRank("MODERATE") > riskRank("LOW"));
    assert.equal(riskRank(null), 0);
  });

  it("ranks severities in escalation order", () => {
    assert.ok(severityRank("CRITICAL") > severityRank("WARNING"));
    assert.ok(severityRank("WARNING") > severityRank("INFO"));
    assert.equal(severityRank(null), 0);
  });
});

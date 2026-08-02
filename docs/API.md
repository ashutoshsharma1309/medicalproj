# Meridian — API Contracts

All endpoints are JSON over HTTPS, authenticated by the `meridian_session` httpOnly cookie.
Errors return `{ "error": "<human-readable message>" }` with an appropriate status
(400 validation, 401 unauthenticated, 403 role denied, 404 missing, 500 engine failure).

## Auth

### POST /api/auth/login
```jsonc
// request
{ "email": "dr.reyes@meridian.health", "password": "demo1234" }
// 200
{ "ok": true, "redirect": "/dashboard" }
```

### POST /api/auth/logout → `{ "ok": true }`

## Document intelligence — roles: DOCTOR, ADMIN

### POST /api/documents/extract
```jsonc
// request
{ "text": "<document text>", "filename": "lab.txt", "patientId": "optional — files to record" }
// 200
{
  "extraction": {
    "patientName": "Eleanor Vance",
    "documentType": "lab_report",
    "conditions": ["Diabetes", "Hypertension"],
    "symptoms": ["Fatigue"],
    "allergies": ["Penicillin"],
    "medications": [{ "name": "Metformin", "dose": "1000 mg", "frequency": "twice daily" }],
    "labValues": [{ "analyte": "HbA1c", "value": 8.5, "unit": "%", "refLow": 4, "refHigh": 5.6, "flag": "H" }],
    "riskFactors": ["HbA1c elevated (8.5 %)"],
    "keyFindings": ["HbA1c 8.5 % — above reference range (4–5.6)"],
    "summary": "…"
  },
  "engine": "claude-opus-5 | deterministic-parser-v1",
  "documentId": "…|null"
}
```

## Decision support — roles: DOCTOR, ADMIN

### POST /api/risk/assess
```jsonc
// request
{ "patientId": "…" }
// 200 — one result per domain; persisted to RiskAssessment
{
  "results": [{
    "domain": "cardiovascular",
    "score": 65, "band": "HIGH",
    "factors": [{ "label": "Hypertension", "weightPct": 34, "evidence": "Active diagnosis…" }],
    "recommendations": ["…"],
    "narrative": "…|null",
    "engine": "rules-v1 | rules-v1 + claude-opus-5"
  }]
}
```

## Triage — roles: DOCTOR, ADMIN

### POST /api/triage
```jsonc
// request
{
  "patientId": "…",
  "chiefComplaint": "Crushing chest pain",
  "symptoms": ["chest pain"],
  "vitals": { "hr": 118, "sbp": 92, "dbp": 60, "rr": 24, "spo2": 93, "tempC": 36.9, "gcs": 15 }
}
// 200
{ "case": { …TriageCase }, "result": { "score": 69, "acuity": 2, "priority": "HIGH",
  "rationale": [{ "factor": "Chest Pain", "points": 18, "why": "…" }], "disposition": "…" } }
```

### PATCH /api/triage/:id
`{ "status": "WAITING" | "IN_TREATMENT" | "DISCHARGED" }` → updated case.

## Medication safety — roles: DOCTOR, ADMIN

### POST /api/medications/check
```jsonc
// request — proposedDrug optional (tests a prescription-to-be against the regimen)
{ "patientId": "…", "proposedDrug": "ibuprofen" }
// 200
{ "alerts": [{
  "level": "HIGH", "kind": "interaction | allergy | duplication",
  "title": "Warfarin + Ibuprofen",
  "detail": "NSAIDs impair platelet function…",
  "involves": ["warfarin", "ibuprofen"]
}] }
```

## Documentation — role: DOCTOR

### POST /api/notes/generate
```jsonc
// request
{ "patientId": "…", "kind": "soap", "rawInput": "F/u diabetes. BP 142/88 …" }
// 200 — note saved as DRAFT
{ "note": { "id": "…", "subjective": "…", "objective": "…", "assessment": "…",
  "plan": "…", "summary": "…", "followUp": "…", "status": "DRAFT" },
  "engine": "claude-opus-5 | template-v1" }
```

### PATCH /api/notes/:id
Any subset of the SOAP fields plus `"status": "FINALIZED"` to sign.

## Knowledge — roles: DOCTOR, ADMIN

### POST /api/knowledge/ask
```jsonc
// request
{ "query": "Can a patient with penicillin allergy receive amoxicillin?" }
// 200
{ "answer": "…", "engine": "bm25 + claude-opus-5 | bm25-extractive",
  "citations": [{ "id": "…", "source": "Meridian Antimicrobial Stewardship (2025)",
    "section": "Beta-lactam allergy assessment", "excerpt": "…" }] }
```

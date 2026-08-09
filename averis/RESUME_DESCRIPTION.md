# Resume and portfolio descriptions

Ready to paste. Every claim here is checkable against the repository, which is
the only useful test for a resume line — an interviewer will open the code.

**What is deliberately absent:** "improved patient outcomes", "reduced response
time by X%", "clinically validated", any user count. None of those are true of
this project, and a fabricated metric on a resume is the one that ends an
interview when it is probed.

---

## One line

> **AVERIS AI** — IoT health-monitoring platform: ESP32 wearable, FastAPI
> ingest, Next.js clinical dashboard, and an explainable risk-prediction pipeline
> with per-patient baselines. 650 tests, 267 database-authorization assertions.

---

## Short (3 bullets — a resume with limited space)

> **AVERIS AI — AI-Powered IoT Health Monitoring** · *TypeScript, Python, C++*
>
> - Built an ESP32 wearable (MAX30102, MLX90614, MPU6050) with host-testable
>   firmware logic — filtering, fall-detection state machine and an
>   edge-transmission policy, verified by 91 checks running in CI without
>   hardware.
> - Designed the platform so Postgres Row Level Security is the only
>   authorization mechanism, with the web app holding no service-role key;
>   verified by 267 assertions running against the unmodified production
>   migrations in CI.
> - Implemented an explainable risk pipeline where deterministic rules decide and
>   generative text only phrases — every alert carries the measurement, the
>   threshold and the rule that fired.

---

## Standard (6 bullets)

> **AVERIS AI — AI-Powered IoT Healthcare Monitoring and Early Risk Prediction**
> *ESP32 · FastAPI · Next.js · Supabase Postgres · scikit-learn · Docker*
>
> - Built a wearable on ESP32 with four I²C sensors, writing the firmware's
>   decision logic free of Arduino symbols so it compiles and runs on a
>   development machine — 91 logic checks execute in CI on every commit rather
>   than requiring the device.
> - Implemented store-and-forward buffering (RAM mirrored to NVS) with batch
>   replay that preserves measurement timestamps, so a network outage delays
>   readings rather than rewriting a patient's history into a spike at
>   reconnection.
> - Designed an edge-transmission policy that suppresses redundant uplinks to
>   conserve battery, bounded by four rules — including measuring drift against
>   the last *transmitted* value, so a gradual decline cannot pass unnoticed one
>   step at a time.
> - Built the ingest service in FastAPI with hashed bearer-token device
>   authentication, deriving the patient from the device record rather than the
>   payload so a device cannot write into another patient's chart.
> - Made Row Level Security the sole authorization mechanism — the Next.js app
>   queries Postgres as the signed-in user and holds no service-role key — and
>   verified it with 267 assertions run against the unmodified migrations in CI,
>   which surfaced eight authorization defects during development.
> - Implemented an explainable analysis pipeline: threshold rules and per-patient
>   baselines produce findings, ML models score, and the generative layer only
>   rephrases — so an explanation cannot disagree with the decision it describes.

---

## Detailed (portfolio or LinkedIn project section)

> **AVERIS AI — AI-Powered IoT Healthcare Monitoring and Early Risk Prediction**
>
> A remote health-monitoring platform spanning firmware, cloud services, machine
> learning and a clinical web application.
>
> **Hardware and firmware.** An ESP32-based wearable measuring heart rate and
> SpO₂ (MAX30102), skin temperature (MLX90614) and motion (MPU6050), with an
> OLED display and local buzzer alerting. The firmware's decision-making logic —
> outlier filtering, a fall-detection state machine, and the policy deciding
> whether a reading is worth a radio transmission — is written free of Arduino
> symbols so it compiles with a host compiler; 91 logic checks run in CI without
> hardware. The device buffers to RAM mirrored into flash and replays through a
> batch endpoint on reconnection, preserving each reading's measurement time.
>
> **Backend.** A FastAPI ingest service authenticating devices by SHA-256 hashed
> bearer token, with the patient derived from the device record rather than the
> request payload. A separate stateless inference service holding no database
> credential, with in-process fallback so a new service is not a new way for the
> system to stop working. Postgres (Supabase) with pgvector, Redis for caching
> and rate limiting, Docker Compose for the production topology, and four
> GitHub Actions pipelines.
>
> **Security.** Row Level Security is the only authorization mechanism; the web
> application queries the database as the signed-in user and holds no
> service-role key in any configuration. 267 assertions run against the
> unmodified production migrations in CI, so a policy change that opens a hole
> fails the build. Eight authorization defects were found by executing those
> assertions during development, including three that were passing while testing
> nothing.
>
> **Machine learning.** Per-patient baselines (median, IQR, percentiles) with
> contamination exclusion, trend fitting over daily medians, Isolation Forest
> anomaly detection, and a logistic-regression risk model. Population Stability
> Index drift monitoring, an append-only model deployment registry, and model
> cards recording each model's training cohort and limitations. The architectural
> rule throughout: deterministic rules decide, models score, and generative text
> only ever phrases a finding the rules already produced.
>
> **Frontend.** Next.js 16 with Server Components and Server Actions,
> TypeScript, Tailwind v4. Patient, clinician and caregiver views with
> per-permission care-team grants, English/Hindi output composed from reviewed
> templates rather than machine translation.
>
> **Verification.** 650 TypeScript tests, 153 Python tests, 91 firmware checks
> and 267 database-authorization assertions, all runnable with one command.
>
> **Stated limitations.** The system has not been clinically validated and makes
> no diagnostic claim. Sensor accuracy against reference instruments has not been
> measured, and the fall-detection model is fitted on synthetic data. These are
> documented in the repository's security report, model cards and hardware
> validation protocol rather than omitted.

---

## Skills this evidences

**Languages** TypeScript, Python, C++, SQL
**Embedded** ESP32, I²C sensors, BLE, power management, NVS
**Backend** FastAPI, PostgreSQL, Row Level Security, Redis, Docker
**Frontend** Next.js, React Server Components, Tailwind
**ML** scikit-learn, feature engineering, drift monitoring (PSI), model cards
**Practices** CI/CD, host-testable firmware, structured logging, threat-aware
schema design, method-comparison statistics (Bland–Altman)

---

## Two notes on using these

**Match the bullets to the role.** For an embedded role, lead with the
host-testable firmware and the edge policy. For a backend or security role, lead
with RLS-as-sole-authorization and the 267 assertions. For an ML role, lead with
the rules-decide/models-score architecture and drift monitoring.

**Keep the limitations line in the detailed version.** It is unusual on a resume
and it works: it signals that you know the difference between a working prototype
and a validated medical device, which is exactly the judgement a healthcare
employer is screening for. Delete it and the same interviewer may assume you
don't.

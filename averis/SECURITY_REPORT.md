# AVERIS — security review

**Date:** 2026-08-08 · **Scope:** the whole system as of Phase 8 — web
application, ingest service, AI inference service, database, and device
firmware.

This is a review, not a certification. It is written to be useful to someone
deciding whether to deploy AVERIS, which means it has to be as clear about what
is missing as about what is present. **Section 8 is the important one.** A
security document that only lists controls is a marketing document with
footnotes.

**AVERIS has not been penetration tested, formally audited, or assessed for
compliance with HIPAA, the DPDP Act, or any other regime.** Nothing below
should be read as a compliance claim.

---

## 1. The model in one paragraph

Every authorisation decision in AVERIS is a Postgres Row Level Security policy.
The web application connects to the database **as the signed-in user** and holds
no service-role key in any configuration. A bug in a React component, a Server
Action, or a route handler cannot read a row the policy would refuse, because
the query is executed under the user's own identity and the database — not the
application — decides what comes back.

This is the single most consequential design choice in the project, and
everything else in this document is downstream of it.

The consequence worth stating: **there is no code path where the web app can
bypass authorisation, because it does not possess the credential that would let
it.** Adding `SUPABASE_SERVICE_ROLE_KEY` to the web service to make a feature
work would not be a configuration change — it would remove the security model.
`docker-compose.production.yml` says so at the point where somebody would be
tempted.

---

## 2. What is verified, and how

| Control | Verified by | Count |
| --- | --- | --- |
| Row Level Security policies | `supabase/tests/*_rls_verification.sql`, run against the **unmodified production migrations** | 267 assertions |
| Application logic | `npm test` | 650 tests |
| Device firmware decision logic | `firmware/averis-wearable/test/run.sh`, compiled and executed on the host | 91 checks |
| Schema invariants | `supabase/tests/schema_validation.sql` | in CI |
| Backup integrity | `scripts/restore-drill.sh --with-rls` | 227 policies and grants diffed |
| Dependency advisories | `scripts/audit-gate.mjs` | blocks in CI |

The RLS suites run against the real migrations rather than a test schema. A
policy change that opens a hole fails CI rather than production. This is the
part of the test suite that would be worth keeping if everything else were
deleted.

---

## 3. Findings from actually running things

Eight defects in the authorisation model were found by executing the migrations
and assertions rather than by reading them. They are listed because a review
that reports only the final state hides how the final state was reached — and
because the pattern generalises.

| Finding | Severity | Status |
| --- | --- | --- |
| `iot_devices.token_hash` had no `UNIQUE` constraint — two devices could share a token | High | Fixed |
| Three RLS assertions were vacuous: subqueries over tables the acting role could not read, inserting zero rows and passing | High (in the tests, not the product) | Fixed |
| A patient could not read their own caregiver's name — an inline `exists` in a policy is itself subject to the referenced table's RLS | Medium | Fixed via `my_care_team_directory()` |
| A caregiver could not read their patient's name, same root cause | Medium | Fixed via `private.is_care_subject()` |
| Content Security Policy blocked the ingest origin — worked locally, would have failed in production | Medium | Fixed with `originOf()` |
| A dump taken with `--no-privileges` restores with all 101 policies and no grants | High | Documented; drill checks it |
| A patient could attach a calibration record to another patient's device — the policy's with-check inspects `patient_id` only, and two independent foreign keys were each satisfied alone | Medium | Fixed with a composite foreign key |
| A `private.` helper was revoked from `PUBLIC` without being granted back, leaving a policy unable to evaluate its own predicate | Low | Fixed |

The third and fourth are the same misconception and are worth internalising: **a
policy that references another table is evaluated under the querying role's
permissions on that table too.** A policy that looks correct in isolation can
deny access it means to grant. Both were found only because an assertion
executed.

The second is the one that should worry a reviewer most. Three assertions were
*passing while testing nothing*. A test suite's own correctness is not
self-evident, and vacuous assertions are the failure mode that leaves a green
pipeline over an unverified system.

---

## 4. Controls, by layer

### 4.1 Database

- Row Level Security enabled on **every** table in `public`. `schema_validation.sql`
  fails the build if a table has a client-role grant and no policy, and
  separately if a table has no policies but does have an `anon` grant.
- Privileged logic lives in `private.*` `SECURITY DEFINER` functions with
  `search_path` pinned. No client role has `EXECUTE` on them.
- `iot_devices.token_hash` is withheld by column-level grant. Postgres has no
  `revoke select (column)`, so the grant enumerates the readable columns and
  omits this one.
- `audit_logs` is insert-and-select for `authenticated`, with no `update` or
  `delete` grant to anyone but `service_role`. A subject can read their own trail
  and cannot alter it.
- Provenance is stamped at write time: `is_simulated` distinguishes demo data
  from measured data in the row itself, not in a view.

### 4.2 Device authentication

Devices authenticate with a bearer token. The database stores **only** a SHA-256
hash (`^[a-f0-9]{64}$`, enforced by a check constraint), and the plaintext token
is shown once at provisioning and never again.

The property that matters: `private.resolve_device()` returns the owner **from
the device row**, never from the payload. A device cannot write a reading
attributed to another patient by claiming a different `patient_id`, because the
`patient_id` in the request is not read. Rotation invalidates the previous token
immediately; retiring a device stops its token resolving. Both are asserted.

### 4.3 Ingest service

Holds a service-role key — it must, because it writes for every patient and
cannot be scoped to a signed-in user. It is therefore the highest-value target
in the system, and is treated accordingly: no published surface beyond the
ingest endpoints, per-device rate limiting, and payload validation with a shared
wire-contract vector set that the TypeScript and Python validators both run,
so a payload accepted by one and rejected by the other fails in CI.

### 4.4 AI inference service

Holds **no database credential of any kind**. Readings arrive in the request
body; no patient identifier crosses the boundary, and there is no field for one.
That is what makes it safe to run at a lower trust level and to replicate freely.

Service-to-service authentication is a shared secret compared with
`hmac.compare_digest`. **When `AI_SERVICE_TOKEN` is unset the service refuses
every request** rather than serving them — the opposite default is the one that
ends up on a reachable network. Asserted by test.

Exposes no ports in the production topology; it is reachable only from the
compose network.

### 4.5 Web application

- Content Security Policy with `object-src 'none'` and `frame-ancestors 'none'`,
  and `connect-src` built from the configured origins rather than a wildcard.
- HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and a `Permissions-Policy`
  denying the sensor and media APIs the app does not use.
- Structured JSON logging with **allowlist** redaction — fields are dropped
  unless explicitly permitted, so a new field carrying a vital sign is redacted
  by default rather than logged until someone notices.
- Audit entries record **that** something happened, never what it contained.
  `sanitizeMetadata` enforces it rather than trusting call sites: "viewed
  document 3f2a" is auditable, "viewed document 3f2a containing HbA1c 8.2%"
  would make the audit table a second copy of the health record with different
  access rules and a different retention policy.
- Caching of patient-derived values happens **only when the viewer is the
  subject**. Caching an RLS-filtered read under the subject's id alone would
  serve one reader's permission-scoped view to another; the rule is enforced in
  `lib/cache/patient-cache.ts` and stated as a test.

### 4.6 Containers

Both service images build multi-stage and run as a non-root user (uid 10001).
Both CI pipelines fail the build if the image runs as root. The AI service in
particular takes arbitrary numeric input through a scientific stack, which is
the last place to be root.

### 4.7 Secrets

`SUPABASE_SERVICE_ROLE_KEY` is held by exactly two services — `worker` and
`iot` — and by neither `web` nor `ai`. CI scans for the credential shapes this
project actually uses (`gsk_`, `xai-`, `sb_secret_`, service-role JWTs, `avd_`
device tokens) rather than running a generic entropy scan that fires on every
hash and gets ignored.

---

## 5. Known weaknesses

Present, understood, not fixed.

| # | Weakness | Why it is not fixed |
| --- | --- | --- |
| 1 | **Rate limiting is per-instance without Redis.** The default counter store is in-process. Behind multiple replicas, the effective limit multiplies by the replica count. | Redis is configured in the production topology; the weakness is in a single-instance deployment that then scales without setting `REDIS_URL`. |
| 2 | **`script-src` allows `'unsafe-inline'`.** | Next.js inlines bootstrap scripts. Removing it requires nonce-based CSP through the framework's script loading, which is a real change and has not been done. Stated rather than omitted. |
| 3 | **Device tokens do not expire.** Rotation is manual. | A band with no user interface cannot re-authenticate on its own; automatic expiry would silently stop a patient's monitoring. Rotation is supported and immediate. |
| 4 | **No mutual TLS between services.** The AI service trusts a bearer token over the internal network. | Adequate for a single-host or single-VPC deployment. Not adequate for a shared network, and the topology does not currently span one. |
| 5 | **Audit logging is best-effort.** A failed audit write does not block the action. | An unavailable audit log is a monitoring problem; a blocked upload is a patient problem. Failures are logged loudly. This is a deliberate trade and a reviewer may disagree with it. |
| 6 | **Four high dependency advisories remain.** `sharp`/libvips and `adm-zip`, neither with a fixed release. | Assessed as unreachable — no user-supplied images, no runtime-fetched archives — and argued in `scripts/audit-gate.mjs`. A *new* high advisory still blocks CI. |
| 7 | **No cross-region failover, no tested restore at production scale.** | See `docs/disaster_recovery.md` §6. |
| 8 | **No penetration test.** | Nobody has attacked this system. |
| 9 | **No AVERIS band has been validated against physical sensors.** The transport half is automated and measured; sensor agreement, fall detection on a body, and battery life are written protocols marked as not performed. | No hardware has been attached. `docs/hardware_validation.md` §0 carries the status and refuses to be read as a report. |

---

## 6. What AVERIS deliberately does not claim

- **No medical accuracy claim.** The risk model is fitted on a public cohort
  that is not the deployment population, and the fall detector is trained on
  synthetic data. Both carry that caveat in their model cards and on screen
  beside the number.
- **No concept-drift measurement.** `lib/mlops/drift.ts` measures input
  distribution drift and reports concept drift as explicitly unavailable,
  because measuring whether predictions were *right* requires outcome data
  AVERIS does not have. `model_drift_reports` has no accuracy column — the
  absence is the design, because a nullable one would eventually be filled in
  with an invented number.
- **No claim of regulatory compliance.** See the header.

---

## 7. If you are deploying this

1. Set `AI_SERVICE_TOKEN`, or the AI service refuses everything and ingest
   falls back to local inference (which is a supported configuration).
2. Set `REDIS_URL` before running more than one replica, or weakness #1 applies.
3. Set `CORS_ORIGINS` to the real web origin. The default is `localhost:3100`.
4. Never add `SUPABASE_SERVICE_ROLE_KEY` to `web`.
5. Take backups with `--no-owner` and **not** `--no-privileges`, and verify one
   with `./scripts/restore-drill.sh` before you need it.
6. Read `docs/disaster_recovery.md` §6 before assuming a failure mode is covered.

---

## 8. Overall assessment

The authorisation model is the strongest part of the system and is verified by
267 assertions against the real migrations. The design decision to keep the
service-role key out of the web application removes an entire class of bug, and
it holds across every phase because there is no code path that could use the key
if it were there.

The weakest parts are listed in §5 and are weaknesses of *coverage*, not of
design: no penetration test, no scaled restore test, no mutual TLS, a CSP
concession to the framework. None of them is a hole somebody argued for; all of
them are work not yet done.

AVERIS is suitable for a pilot deployment by an operator who reads §5 and §7.
It is not suitable for unsupervised clinical use, and no part of this document
should be read as saying otherwise.

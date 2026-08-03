# AVERIS

**Your intelligent healthcare journey starts here.**

AVERIS is an AI-powered personalized healthcare intelligence platform. It helps patients
organize their health information and create a personalized healthcare profile — a single,
accurate health identity they own and control.

This repository contains **Phase 1 (Patient Identity + Health Profile)** and
**Phase 2 (Medical Document Intelligence)**.

---

## What Phase 1 delivers

A patient can discover AVERIS, create an account, sign in securely, complete a guided health
onboarding, and reach a private healthcare dashboard.

| Capability | Status |
|---|---|
| Premium healthcare landing page | ✅ |
| Email + password authentication | ✅ |
| Google OAuth authentication | ✅ (needs Google credentials configured) |
| Supabase PostgreSQL backend with Row Level Security | ✅ |
| Three-step patient onboarding | ✅ |
| Patient profile management | ✅ |
| Health dashboard foundation | ✅ |
| Container + GCP Cloud Run deployment | ✅ |

## What Phase 2 delivers

The Medical Records Center: a patient uploads a document, AVERIS reads it, and the patient
verifies what it found before anything touches their health profile.

```
Upload  →  Text extraction  →  Medical entity extraction  →  Review  →  Health profile
(PDF/JPG/PNG)  (PDF layer / OCR)      (Grok, JSON contract)   (patient)   (additive merge)
```

| Capability | Status |
|---|---|
| Drag-and-drop upload with document categories | ✅ |
| Private Supabase Storage, per-patient folders | ✅ |
| PDF text extraction; OCR for images and scanned PDFs | ✅ |
| Structured medical extraction via Grok, JSON-contract validated | ✅ |
| Per-field confidence scoring with low-confidence flagging | ✅ |
| Patient verification workflow (confirm / edit / reject) | ✅ |
| Additive health-profile integration on confirmation | ✅ |
| Document viewer with original + AVERIS summary | ✅ |

**The rule that governs the whole phase:** an extraction never modifies a health profile.
Items reach `patient_medical_records` and the profile only after an explicit `CONFIRM`
decision — asserted directly in the test suite.

**Still deliberately not built:** health timeline and predictive insights. The dashboard
reserves labelled space for both rather than simulating them.

## Tech stack

- **Next.js 16** (App Router) · **TypeScript** · **Tailwind CSS v4**
- **Supabase** — authentication, PostgreSQL, Row Level Security
- **Google Cloud Platform** — Cloud Build → Artifact Registry → Cloud Run
- **Grok (xAI)** — scaffolded in `lib/ai/grok.ts` for Phase 2

Architecture, schema rationale and the auth flow are documented in
[ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Getting started

### 1. Apply the schema

Create a project at [supabase.com](https://supabase.com), then apply the schema. The simplest
route needs no credentials beyond dashboard access — open the **SQL Editor** and paste the
contents of [`supabase/apply-all.sql`](./supabase/apply-all.sql), which concatenates every
migration in order.

It creates 6 tables, 24 RLS policies, 7 helper functions in the non-exposed `private` schema,
and the private `medical-documents` storage bucket.

Alternatively, with the CLI:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push        # prompts for the database password
```

Regenerating `apply-all.sql` after adding a migration:

```bash
for m in supabase/migrations/*.sql; do echo "-- $(basename "$m")"; cat "$m"; echo; done \
  > supabase/apply-all.sql
```

### 1b. Confirm it worked

```bash
./scripts/verify-remote.sh
```

Uses only the publishable key. Every table should report **"exists, anon denied"** — a `401`
proves the table is there *and* that anonymous callers cannot read it. A `200` would mean RLS
or grants are wrong, and `404` means the schema hasn't been applied.

### 2. Configure environment

```bash
cp .env.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from
**Project Settings → API**.

### 3. Enable Google OAuth (optional)

Email/password works without this. Until Google is configured, the "Continue with Google"
button will fail — the provider reports `google: false` in `/auth/v1/settings`, which
`scripts/verify-remote.sh` prints on every run.

1. **Google Cloud Console** → Credentials → OAuth 2.0 Client ID (Web application).
2. Add this authorized redirect URI:
   ```
   https://<project-ref>.supabase.co/auth/v1/callback
   ```
3. **Supabase → Authentication → Providers → Google** — paste the client ID and secret.
4. **Supabase → Authentication → URL Configuration → Redirect URLs** — add
   `http://localhost:3100/auth/callback` (and your deployed origin).

### 4. Email confirmation

New projects require email confirmation by default (`mailer_autoconfirm: false`). Sign-up
therefore returns *"check your inbox"* rather than an immediate session — the app handles this
explicitly. To test the full flow without a mail round-trip, turn off **Confirm email** under
**Authentication → Providers → Email**.

### 4. Run

```bash
npm install
npm run dev          # http://localhost:3100
```

### Local Supabase (optional)

```bash
npm run db:start     # requires Docker
npm run db:reset     # applies migrations
npm run types:gen    # regenerate lib/supabase/database.types.ts
```

---

## Security

Health data is protected in the database, not just in the interface.

- **Row Level Security on every table**, deny-by-default. Policies pair `TO authenticated` with
  an ownership predicate — never role checks alone.
- **`anon` has no privileges** on any application table.
- **UPDATE policies carry `USING` *and* `WITH CHECK`**, so a record's owner cannot be reassigned.
- **`SECURITY DEFINER` helpers live in a non-exposed `private` schema** with `EXECUTE` revoked
  from `PUBLIC`, and resolve identity from `auth.uid()` internally.
- **Authorization is re-checked in every Server Action and protected page.** `proxy.ts` is
  defence in depth, not the only gate — Server Functions are POSTs to their host route, so a
  matcher change must not be able to silently remove coverage.
- **Secrets never reach the browser.** Only `NEXT_PUBLIC_*` values are shipped to the client;
  `lib/ai/grok.ts` imports `server-only` so a client import fails the build.

### Verifying the security model

Two executable suites, both runnable offline:

```bash
npm test                     # 32 pipeline tests (Grok stubbed, no network)
./supabase/tests/run.sh      # 34 RLS assertions against real Postgres
```

`run.sh` applies the **unmodified production migrations** to a throwaway database and asserts
that a patient cannot read or write another patient's profile, health information, documents,
extractions or confirmed records; that ownership cannot be reassigned; and that anonymous
callers are denied outright.

`npm test` covers the pipeline logic that decides what reaches a health profile: the extraction
contract, JSON recovery from imperfect model output, confidence scoring and low-confidence
flagging, the no-diagnosis guardrail, upload validation including magic-byte checks, and the
reconciliation rule that **nothing is written without an explicit confirmation**.

## Phase 2 configuration

| Variable | Purpose |
|---|---|
| `GROK_API_KEY` | Required for extraction. Server-only. |
| `GROK_MODEL` | Defaults to `grok-4`. |
| `OCR_PROVIDER` | `tesseract` (default, no external dependency) or `google-vision`. |
| `GOOGLE_CLOUD_VISION_API_KEY` | Required only when `OCR_PROVIDER=google-vision`. |

Apply the Phase 2 migrations to your Supabase project (`npx supabase db push`). They create the
three tables plus the private `medical-documents` storage bucket and its policies.

---

## Deployment (GCP Cloud Run)

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=asia-south1,\
_SUPABASE_URL=https://<ref>.supabase.co,\
_SUPABASE_ANON_KEY=<publishable-key>,\
_SITE_URL=https://<your-domain>
```

`NEXT_PUBLIC_*` values are build args because Next.js inlines them into the client bundle.
Server-only secrets (`GROK_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) are bound at deploy time from
**Secret Manager** so they never enter an image layer.

After deploying, add `https://<your-domain>/auth/callback` to the Supabase redirect allowlist.

---

## Project structure

```
app/
  page.tsx              landing page
  (auth)/               login · signup · auth server actions
  auth/callback/        OAuth PKCE exchange
  (app)/                protected: onboarding · dashboard
components/
  brand/ ui/ marketing/ health/
lib/
  supabase/  auth/  validation/  ai/  utils/
supabase/
  migrations/           versioned schema
  tests/                executable RLS verification
proxy.ts                Next.js 16 route protection + token refresh
```

# AVERIS

**Your intelligent healthcare journey starts here.**

AVERIS is an AI-powered personalized healthcare intelligence platform. It helps patients
organize their health information and create a personalized healthcare profile — a single,
accurate health identity they own and control.

This repository contains **Phase 1: the Patient Identity + Health Profile platform**.

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

**Deliberately not built yet:** medical document analysis, health timeline, and risk insights.
The dashboard reserves labelled space for each, and the Grok client is scaffolded — but AVERIS
does not simulate AI output it cannot actually produce.

## Tech stack

- **Next.js 16** (App Router) · **TypeScript** · **Tailwind CSS v4**
- **Supabase** — authentication, PostgreSQL, Row Level Security
- **Google Cloud Platform** — Cloud Build → Artifact Registry → Cloud Run
- **Grok (xAI)** — scaffolded in `lib/ai/grok.ts` for Phase 2

Architecture, schema rationale and the auth flow are documented in
[ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Getting started

### 1. Create a Supabase project

Create a project at [supabase.com](https://supabase.com), then apply the schema — either by
pasting `supabase/migrations/20260802165525_averis_core_schema.sql` into the SQL editor, or:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from
**Project Settings → API**.

### 3. Enable Google OAuth (optional)

In the Supabase dashboard: **Authentication → Providers → Google**. Add your Google client ID
and secret, and register this authorized redirect URI with Google:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

Then add `http://localhost:3100/auth/callback` to **Authentication → URL Configuration →
Redirect URLs**.

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

The RLS policies ship with an executable test suite that proves cross-patient isolation:

```bash
./supabase/tests/run.sh
```

It applies the **unmodified production migration** to a throwaway database and asserts that a
patient cannot read or write another patient's profile or health information, that ownership
cannot be reassigned, and that anonymous callers are denied outright.

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

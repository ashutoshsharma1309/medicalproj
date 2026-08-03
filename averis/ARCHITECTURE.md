# AVERIS — Architecture Plan (Phase 1)

> Phase 1 scope: **Patient Identity + Health Profile Platform**.
> Discover → Sign up → Sign in → Onboard → Health profile → Private dashboard.

## 1. Product architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│  Landing (public) · Auth screens · Onboarding · Dashboard        │
└───────────────┬──────────────────────────────────────────────────┘
                │ HTTPS · httpOnly session cookies
┌───────────────▼──────────────────────────────────────────────────┐
│  Next.js 16 (App Router, TypeScript, Tailwind v4)                │
│                                                                  │
│  proxy.ts ──────────► token refresh + route protection           │
│  Server Components ─► read patient data (per-request client)     │
│  Server Actions ────► writes; re-authorize on every call         │
│  /auth/callback ────► OAuth PKCE code exchange                   │
└───────────────┬──────────────────────────────────────────────────┘
                │ @supabase/ssr (publishable key, RLS enforced)
┌───────────────▼──────────────────────────────────────────────────┐
│  Supabase                                                        │
│  Auth (GoTrue): email+password, Google OAuth                     │
│  PostgreSQL: users · patient_profiles · patient_health_information│
│  Row Level Security on every table (deny-by-default)             │
└──────────────────────────────────────────────────────────────────┘
                │ future
┌───────────────▼──────────────────────────────────────────────────┐
│  Grok (xAI) — scaffolded, not user-facing in Phase 1             │
│  GCP Cloud Run — container deployment target                     │
└──────────────────────────────────────────────────────────────────┘
```

### Version-verified decisions

These were checked against the installed packages, not assumed — both changed recently:

| Area | Decision | Why |
|---|---|---|
| Route protection | **`proxy.ts`**, `export function proxy()` | Next.js 16 deprecated `middleware.ts` and renamed the convention to `proxy`. |
| Cookie handling | `getAll` / `setAll` | `get`/`set`/`remove` are deprecated in `@supabase/ssr` and will be removed. |
| Session read in proxy | `supabase.auth.getClaims()` | Current recommended refresh call; must run before the response is committed. |
| Authorization | Re-checked inside **every** Server Action and page | Next.js docs: Server Functions are POSTs to the host route, so a proxy matcher change can silently drop coverage. Proxy is defence-in-depth, never the only gate. |

## 2. Folder structure

```
averis/
├── app/
│   ├── layout.tsx                 # root shell, fonts, metadata (AVERIS)
│   ├── globals.css                # design tokens + primitives
│   ├── page.tsx                   # landing page (public)
│   ├── (auth)/                    # unauthenticated route group
│   │   ├── layout.tsx             # split-panel auth shell
│   │   ├── login/page.tsx
│   │   └── signup/page.tsx
│   ├── auth/
│   │   ├── callback/route.ts      # OAuth PKCE exchange
│   │   └── auth-code-error/page.tsx
│   └── (app)/                     # authenticated route group
│       ├── layout.tsx             # requires session; app chrome
│       ├── onboarding/            # 3-step wizard
│       └── dashboard/             # health dashboard
├── components/
│   ├── brand/                     # Logo, wordmark
│   ├── ui/                        # Button, Input, Select, Field, Card…
│   ├── marketing/                 # landing sections
│   └── health/                    # HealthIdentityCard (signature element)
├── lib/
│   ├── supabase/{client,server,proxy,database.types}.ts
│   ├── auth/session.ts            # requireUser, getAccountState
│   ├── validation/patient.ts      # zod schemas (shared client+server)
│   ├── ai/grok.ts                 # Phase 2 scaffold, not wired to UI
│   └── utils/                     # formatting, constants
├── supabase/migrations/           # versioned SQL
├── proxy.ts                       # Next.js 16 proxy
├── Dockerfile / cloudbuild.yaml   # GCP Cloud Run
└── .env.example
```

## 3. Database schema

Normalized into three tables so identity, demographics, and clinical facts evolve
independently (health information will grow substantially in later phases).

```
auth.users (Supabase-managed)
   │ 1:1  auth_user_id
   ▼
public.users                     id, auth_user_id, email, full_name,
   │                             profile_image, role, timestamps
   │ 1:1  user_id
   ▼
public.patient_profiles          id, user_id, date_of_birth, gender,
   │                             phone_number, blood_group,
   │                             emergency_contact, timestamps
   │ 1:1  patient_id
   ▼
public.patient_health_information id, patient_id, allergies[],
                                  existing_conditions[], current_medications[],
                                  medical_notes, timestamps
```

**Role architecture.** `user_role` is a Postgres enum with `PATIENT`, `DOCTOR`,
`HOSPITAL_ADMIN` from day one. Only `PATIENT` is issued in Phase 1 — the column
and enum exist so future roles need no destructive migration.

**Why arrays for allergies/conditions/medications:** they are patient-entered
lists in Phase 1. `text[]` keeps them queryable (`&&` overlap operator) without
premature junction tables; Phase 2 promotes them to coded clinical entities when
AI extraction supplies structure.

## 4. Security model

- **Deny by default.** RLS enabled on all three tables. No grants to `anon` at
  all — every table is `authenticated`-only, and every policy pairs
  `TO authenticated` with an ownership predicate.
- **No `TO authenticated`-only policies** (that is authentication without
  authorization — the BOLA/IDOR trap).
- **UPDATE policies carry both `USING` and `WITH CHECK`** so a row's owner
  cannot be reassigned.
- **Ownership resolution via `private.current_app_user_id()`** — a
  `SECURITY DEFINER` helper in a non-exposed schema, execute revoked from
  `PUBLIC`, that derives the app user from `auth.uid()` internally. This avoids
  nested-RLS recursion and per-row subquery cost in policies.
- **`handle_new_user` trigger** lives in the `private` schema (not `public`),
  so it is not a callable API endpoint.
- **Keys.** Only the publishable/anon key reaches the browser. The service-role
  key is never imported by client code and is not required by Phase 1.
- **Validation.** One zod schema per form, shared by client and server; the
  server action re-validates regardless of what the client sent.

## 5. Authentication flow

```
Email + password
  signup  → supabase.auth.signUp() → trigger creates public.users row
          → redirect /onboarding
  login   → signInWithPassword()  → /onboarding or /dashboard by profile state

Google OAuth
  click   → signInWithOAuth({ provider:'google', redirectTo:/auth/callback })
  return  → /auth/callback?code=… → exchangeCodeForSession(code)
          → trigger creates public.users row (idempotent)
          → redirect by profile state

Every request
  proxy.ts → getClaims() refreshes tokens, writes cookies, gates /dashboard
             and /onboarding; signed-in users are bounced off /login,/signup
Every write
  server action → requireUser() re-checks session before touching data
```

**Routing state machine** (`lib/auth/session.ts`):

| Session | Profile complete | `/onboarding` | `/dashboard` |
|---|---|---|---|
| none | — | → `/login` | → `/login` |
| yes | no | render wizard | → `/onboarding` |
| yes | yes | → `/dashboard` | render |

## 6. Component structure

- `components/ui/*` — unstyled-logic primitives (`Button`, `Field`, `Input`,
  `Select`, `TextArea`, `Card`, `Callout`, `Chip`). One responsibility each,
  variant-driven, no page knowledge.
- `components/health/HealthIdentityCard.tsx` — the product's signature
  artifact, rendered from a typed props contract so the landing page can show a
  specimen and the dashboard can show the real record with the same component.
- `components/marketing/*` — one component per landing section, composed by
  `app/page.tsx`.
- Server Components by default; `"use client"` only where state or events are
  required (forms, wizard).

## 7. Phase 2 — Medical Document Intelligence

### Layering

```
Server Action (app/(app)/records/actions.ts)   ← authorization, validation
        ↓
Processing Service (processing-service.ts)      ← sequence + status machine
        ↓
  storage-service   → fetch bytes from private bucket
  text-extraction   → PDF text layer, or OCR (pluggable provider)
  grok-service      → structured extraction, JSON contract enforced
        ↓
Database (RLS-scoped Supabase client)
```

Each service owns one capability and none reach past their neighbour. The
orchestrator is the only place that knows the order of operations or writes
status transitions:

```
PENDING → PROCESSING → PENDING_REVIEW → COMPLETED
                    ↘ FAILED (error_message explains, retry offered)
```

### Testability as a design constraint

Two decisions exist purely so the pipeline can be verified without a network:

- **`grok-service` takes its completion function as a parameter.** The real
  (server-only) client is imported lazily, so tests inject a stub and the whole
  extraction path runs offline and deterministically.
- **Upload rules live in `storage-validation.ts`**, separate from the
  `server-only` I/O in `storage-service.ts`, so they are directly unit-testable.

### The verification invariant

An extraction never modifies a health profile. `reconciliation.ts` is a pure
function from *(extracted items, patient decisions, existing profile)* to
*(records to write, additive profile changes)*. Absence of a decision is
treated as rejection — silence is not consent — and the merge is additive, so
confirming a document can never delete something the patient entered.

### Guardrail on patient-facing prose

`enforceNoDiagnosis()` scans the model's summary for diagnostic or prescriptive
phrasing and replaces it with a referral to the patient's clinician. The system
prompt asks for observational language; this enforces it regardless.

### Still deliberately unbuilt

Health timeline and predictive insights. The dashboard reserves labelled space
for both rather than simulating them.

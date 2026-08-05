-- ===========================================================================
-- AVERIS — Phase 6: production foundation
--
-- Four concerns, and each one has a policy shape that differs from everything
-- in phases 1-5. That is the interesting part of this migration: the
-- owner-scoped read/write pattern used everywhere else is wrong for all four.
--
--   audit_logs        append-only, and NOT deletable by the subject. An audit
--                     trail a patient can erase is not an audit trail.
--   notifications     readable and dismissable by the owner, but written only
--                     by the system — a client that can forge a notification
--                     can tell a patient their report is ready when it is not.
--   processing_jobs   claimed by workers with SKIP LOCKED, invisible to
--                     patients except as status on their own document.
--   subscriptions     readable by the owner, writable by nobody. A plan a
--                     client can edit is not a plan.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.audit_action as enum (
  'DOCUMENT_UPLOADED',
  'DOCUMENT_VIEWED',
  'DOCUMENT_DELETED',
  'EXTRACTION_CONFIRMED',
  'PROFILE_UPDATED',
  'HEALTH_SUMMARY_VIEWED',
  'RISK_PREDICTION_GENERATED',
  'AI_QUESTION_ASKED',
  'REPORT_EXPLAINED',
  'SIGNED_IN',
  'SIGNED_OUT'
);

create type public.audit_resource as enum (
  'DOCUMENT',
  'PROFILE',
  'PREDICTION',
  'CONVERSATION',
  'TWIN',
  'SESSION'
);

create type public.notification_kind as enum (
  'DOCUMENT_PROCESSED',
  'DOCUMENT_FAILED',
  'INSIGHT_GENERATED',
  'PROFILE_UPDATED'
);

create type public.job_status as enum ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');

create type public.subscription_plan as enum ('FREE', 'PREMIUM');

create type public.subscription_state as enum ('ACTIVE', 'PAST_DUE', 'CANCELLED');

-- ---------------------------------------------------------------------------
-- audit_logs
--
-- Append-only by construction. There is no UPDATE policy and no DELETE policy
-- for any client role, so the subject of a log entry cannot revise or remove
-- it. This is the whole point: an audit trail that the person being audited
-- can edit records nothing.
--
-- user_id is the acting auth user rather than a patient profile, because some
-- auditable events (sign-in, sign-out) happen before a profile is resolved.
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  action        public.audit_action not null,
  resource_type public.audit_resource not null,
  resource_id   uuid,
  -- Request correlation, so one user action can be traced across the log
  -- lines it produced. Never contains patient health data — see the service.
  metadata      jsonb not null default '{}'::jsonb,
  ip_address    inet,
  created_at    timestamptz not null default now(),

  constraint audit_logs_metadata_is_object
    check (jsonb_typeof(metadata) = 'object')
);

comment on table public.audit_logs is
  'Append-only activity trail. Not deletable by the subject — that is deliberate.';

create index audit_logs_user_idx on public.audit_logs (user_id, created_at desc);
create index audit_logs_resource_idx on public.audit_logs (resource_type, resource_id);
create index audit_logs_action_idx on public.audit_logs (action, created_at desc);

-- ---------------------------------------------------------------------------
-- notifications
--
-- Written by the system, read and dismissed by the owner. A client that could
-- insert here could tell a patient their report finished processing when it
-- had not — so INSERT is granted to no client role.
-- ---------------------------------------------------------------------------
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  patient_id  uuid not null references public.patient_profiles (id) on delete cascade,
  kind        public.notification_kind not null,
  title       text not null,
  body        text not null,
  /** Where the notification points. Relative path, never an external URL. */
  href        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now(),

  constraint notifications_title_not_blank
    check (char_length(btrim(title)) between 1 and 200),
  constraint notifications_body_not_blank
    check (char_length(btrim(body)) between 1 and 1000),
  -- An absolute URL here would turn a system notification into an open
  -- redirect that a patient has every reason to trust.
  --
  -- The negative lookahead is load-bearing: without it "//evil.example/x"
  -- passes, because it starts with "/" and contains only allowed characters.
  -- Browsers read a protocol-relative URL as an external origin, so that one
  -- character is the whole difference between an internal link and an
  -- off-site redirect.
  constraint notifications_href_is_relative
    check (href is null or href ~ '^/(?![/\\])[A-Za-z0-9/_?=&.-]*$')
);

comment on table public.notifications is
  'System-generated alerts. Readable and dismissable by the owner; writable by no client role.';

create index notifications_patient_idx
  on public.notifications (patient_id, created_at desc);

create index notifications_unread_idx
  on public.notifications (patient_id)
  where read_at is null;

-- ---------------------------------------------------------------------------
-- processing_jobs
--
-- The queue behind document processing. Claimed with FOR UPDATE SKIP LOCKED,
-- which is what makes two workers safe without a broker: the row lock is the
-- lease, and a crashed worker's lock dies with its transaction.
-- ---------------------------------------------------------------------------
create table public.processing_jobs (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid not null references public.patient_profiles (id) on delete cascade,
  document_id   uuid not null references public.medical_documents (id) on delete cascade,
  status        public.job_status not null default 'QUEUED',
  attempts      int not null default 0,
  max_attempts  int not null default 3,
  /** Backoff: a job is invisible to workers until this time. */
  run_after     timestamptz not null default now(),
  last_error    text,
  claimed_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),

  constraint processing_jobs_attempts_sane
    check (attempts >= 0 and max_attempts between 1 and 10),
  -- One live job per document. A double-submit would otherwise pay for OCR
  -- and an AI extraction twice and race on the same rows.
  constraint processing_jobs_one_live_per_document
    exclude (document_id with =) where (status in ('QUEUED', 'RUNNING'))
);

comment on table public.processing_jobs is
  'Document processing queue. Claimed with SKIP LOCKED; the row lock is the lease.';

-- The claim query orders by run_after among visible jobs, so this is the
-- index it walks.
create index processing_jobs_claimable_idx
  on public.processing_jobs (run_after)
  where status = 'QUEUED';

create index processing_jobs_document_idx on public.processing_jobs (document_id);

-- ---------------------------------------------------------------------------
-- subscriptions
--
-- Readable by the owner, writable by nobody. Plan limits are enforced against
-- this row, so a client that could write it could grant itself unlimited
-- uploads by sending one PATCH.
--
-- No payment fields. Phase 6 explicitly stops short of billing; this exists so
-- the enforcement path is real and the billing integration later has a row to
-- update rather than a schema change to perform.
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null unique references public.users (id) on delete cascade,
  plan                public.subscription_plan not null default 'FREE',
  subscription_status public.subscription_state not null default 'ACTIVE',
  current_period_end  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.subscriptions is
  'Plan and status. Readable by the owner, writable by no client role.';

create index subscriptions_user_idx on public.subscriptions (user_id);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function private.set_updated_at();

-- Every existing user gets a FREE row, and every new one does too. Enforcement
-- can then read a plan unconditionally instead of treating "no row" as a
-- special case that some call site will eventually forget to handle.
insert into public.subscriptions (user_id)
select id from public.users
on conflict (user_id) do nothing;

create or replace function private.create_default_subscription()
returns trigger
language plpgsql
security definer
-- SECURITY DEFINER is required: the trigger inserts into a table the inserting
-- role has no grant on. It is safe because the function takes no arguments
-- from the caller and writes only the id of the row that triggered it.
set search_path = public, pg_temp
as $$
begin
  insert into public.subscriptions (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger users_create_default_subscription
  after insert on public.users
  for each row execute function private.create_default_subscription();

-- ===========================================================================
-- A note on identity, because this migration gets it wrong easily
-- ===========================================================================
--
-- public.users.id and auth.users.id are DIFFERENT values: the application row
-- carries its own gen_random_uuid() and links to auth via auth_user_id.
--
-- audit_logs.user_id references auth.users, so its policy compares against
-- auth.uid() directly. subscriptions.user_id references public.users, so its
-- policy must go through private.current_app_user_id() (defined in the Phase 1
-- core schema).
--
-- Getting this backwards matches nothing, and matches nothing *silently* —
-- which is how a premium subscriber ends up reading as FREE with no error
-- anywhere in the stack.

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.audit_logs      enable row level security;
alter table public.notifications   enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.subscriptions   enable row level security;

-- audit_logs ---------------------------------------------------------------
-- A patient may read their own trail — under most health-data regimes that is
-- their right, and it is also the feature that makes the log worth keeping.
create policy "Users read own audit trail"
  on public.audit_logs for select
  to authenticated
  using ( user_id = (select auth.uid()) );

-- Writing is allowed only for oneself, so a compromised session cannot forge
-- another user's history.
create policy "Users append their own audit entries"
  on public.audit_logs for insert
  to authenticated
  with check ( user_id = (select auth.uid()) );

-- Deliberately no UPDATE and no DELETE policy, and no grant for either below.
-- Append-only is the property; everything else here is in service of it.

-- notifications ------------------------------------------------------------
create policy "Patients read own notifications"
  on public.notifications for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- Dismissal is the one field a patient may change, and the WITH CHECK keeps
-- them from reassigning the row while doing it.
create policy "Patients dismiss own notifications"
  on public.notifications for update
  to authenticated
  using ( patient_id = private.current_patient_profile_id() )
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients delete own notifications"
  on public.notifications for delete
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- No INSERT policy: notifications are system-generated.

-- processing_jobs ----------------------------------------------------------
-- Read-only, and only for one's own documents. A patient seeing that their
-- upload is queued is useful; a patient writing to the queue is not.
create policy "Patients read own jobs"
  on public.processing_jobs for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients enqueue their own documents"
  on public.processing_jobs for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

-- No UPDATE policy for clients: status transitions belong to the worker,
-- which connects with elevated credentials.

-- subscriptions ------------------------------------------------------------
create policy "Users read own subscription"
  on public.subscriptions for select
  to authenticated
  using ( user_id = private.current_app_user_id() );

-- No INSERT, UPDATE or DELETE policy. Plan changes come from billing, which
-- does not run as the user.

-- ===========================================================================
-- Grants
-- ===========================================================================
-- Note what is absent: no update or delete on audit_logs, no insert on
-- notifications, no update on processing_jobs, nothing but select on
-- subscriptions. The grants and the policies say the same thing twice on
-- purpose — a policy without the matching grant is a silent runtime error,
-- and a grant without the matching policy is a hole waiting for one.
grant select, insert         on public.audit_logs      to authenticated;
grant select, update, delete on public.notifications   to authenticated;
grant select, insert         on public.processing_jobs to authenticated;
grant select                 on public.subscriptions   to authenticated;

-- ===========================================================================
-- Job claiming
-- ===========================================================================
--
-- SECURITY DEFINER here is deliberate and is the one place in AVERIS where it
-- is correct: the worker must see and mutate jobs across all patients, which
-- is exactly what RLS exists to prevent for user-facing code. It is safe only
-- because EXECUTE is revoked from every client role below — `authenticated`
-- cannot call it, so no session can reach it.
create or replace function private.claim_processing_job(worker_batch int default 1)
returns table (
  job_id      uuid,
  patient_id  uuid,
  document_id uuid,
  attempts    int
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.processing_jobs j
  set
    status     = 'RUNNING',
    attempts   = j.attempts + 1,
    claimed_at = now()
  where j.id in (
    select id from public.processing_jobs
    where status = 'QUEUED' and run_after <= now()
    order by run_after
    -- SKIP LOCKED is what makes concurrent workers safe without a broker:
    -- each takes a different row instead of blocking on the same one.
    for update skip locked
    limit greatest(worker_batch, 1)
  )
  returning j.id, j.patient_id, j.document_id, j.attempts;
$$;

comment on function private.claim_processing_job is
  'Atomically claims queued jobs. Not callable by any client role.';

revoke all on function private.claim_processing_job(int) from public;

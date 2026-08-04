-- ===========================================================================
-- AVERIS — Phase 5: medical knowledge intelligence (RAG)
--
-- Three tables and one decision that drives all of them.
--
-- THE DECISION: retrieval runs inside Postgres, not in an in-process index.
--
-- The obvious alternative is FAISS. It is faster and it is the wrong choice
-- here, because a FAISS index is one flat array of vectors with no notion of
-- who owns each row. Isolation would depend on filtering the *results* in
-- application code, which means a single missing predicate silently returns
-- another patient's blood report as context for someone else's question — and
-- nothing about the response would look wrong.
--
-- With pgvector, the RLS policy is part of the query plan. The similarity
-- search cannot see rows the policy excludes, so cross-patient retrieval is
-- not "prevented by a check" but unrepresentable. For a personal health
-- record that trade is worth far more than the latency.
--
-- Embeddings are all-MiniLM-L6-v2, 384 dimensions, L2-normalised at write
-- time — so cosine distance and inner product agree and `<=>` is exact.
-- ===========================================================================

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- The `authenticated` role needs USAGE to reach the `<=>` operator; without
-- it every retrieval fails at runtime with "operator does not exist".
grant usage on schema extensions to authenticated;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- The separation the product requires, made structural. A chunk is either
-- about one patient or it is general medical knowledge — never both, and the
-- check constraint below makes the ambiguous state impossible to store.
create type public.knowledge_source_type as enum ('PATIENT_DOCUMENT', 'MEDICAL_KNOWLEDGE');

create type public.knowledge_category as enum (
  'LAB_REFERENCE',
  'CONDITION',
  'MEDICATION',
  'PROCEDURE',
  'GENERAL_HEALTH'
);

-- ---------------------------------------------------------------------------
-- knowledge_documents — the general medical knowledge base
--
-- Contains no patient data. Every signed-in user reads the same rows.
-- ---------------------------------------------------------------------------
create table public.knowledge_documents (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  category    public.knowledge_category not null,
  source_type public.knowledge_source_type not null default 'MEDICAL_KNOWLEDGE',
  body        text not null,
  -- Where the claim comes from. A knowledge base a patient cannot trace is
  -- indistinguishable from a model making things up.
  citation    text not null,
  created_at  timestamptz not null default now(),

  constraint knowledge_documents_title_not_blank
    check (char_length(btrim(title)) between 1 and 300),
  constraint knowledge_documents_body_not_blank
    check (char_length(btrim(body)) between 1 and 20000),
  constraint knowledge_documents_citation_not_blank
    check (char_length(btrim(citation)) between 1 and 500),
  -- This table is the knowledge base; a patient document does not belong here.
  constraint knowledge_documents_is_knowledge
    check (source_type = 'MEDICAL_KNOWLEDGE'),
  constraint knowledge_documents_unique_title unique (title)
);

comment on table public.knowledge_documents is
  'General medical knowledge. Public reference material — contains no patient data.';

-- ---------------------------------------------------------------------------
-- knowledge_embeddings — retrievable chunks, both sources
-- ---------------------------------------------------------------------------
create table public.knowledge_embeddings (
  id                    uuid primary key default gen_random_uuid(),
  source_type           public.knowledge_source_type not null,

  -- Set if and only if this chunk came from a patient's own document.
  patient_id            uuid references public.patient_profiles (id) on delete cascade,
  document_id           uuid references public.medical_documents (id) on delete cascade,

  -- Set if and only if this chunk came from the knowledge base.
  knowledge_document_id uuid references public.knowledge_documents (id) on delete cascade,

  chunk_index           int not null,
  content               text not null,
  embedding             extensions.vector(384) not null,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),

  -- The separation rule, enforced by the database rather than by discipline.
  -- A patient chunk must name its owner; a knowledge chunk must not have one.
  constraint knowledge_embeddings_source_shape check (
    (source_type = 'PATIENT_DOCUMENT'
      and patient_id is not null
      and document_id is not null
      and knowledge_document_id is null)
    or
    (source_type = 'MEDICAL_KNOWLEDGE'
      and patient_id is null
      and document_id is null
      and knowledge_document_id is not null)
  ),

  constraint knowledge_embeddings_content_not_blank
    check (char_length(btrim(content)) between 1 and 8000),
  constraint knowledge_embeddings_chunk_index_non_negative
    check (chunk_index >= 0),
  constraint knowledge_embeddings_metadata_is_object
    check (jsonb_typeof(metadata) = 'object'),

  -- Re-indexing a document must replace its chunks, not duplicate them.
  constraint knowledge_embeddings_unique_patient_chunk
    unique (document_id, chunk_index),
  constraint knowledge_embeddings_unique_knowledge_chunk
    unique (knowledge_document_id, chunk_index)
);

comment on table public.knowledge_embeddings is
  'Retrievable text chunks with 384-dim MiniLM embeddings. RLS scopes patient chunks to their owner.';

-- Ownership filters run before the distance ordering on a corpus this size,
-- so these matter more than the vector index does.
create index knowledge_embeddings_patient_idx
  on public.knowledge_embeddings (patient_id)
  where source_type = 'PATIENT_DOCUMENT';

create index knowledge_embeddings_document_idx
  on public.knowledge_embeddings (document_id);

create index knowledge_embeddings_knowledge_idx
  on public.knowledge_embeddings (knowledge_document_id);

-- HNSW for when the corpus outgrows a sequential scan.
--
-- Worth knowing: with an RLS predicate, Postgres takes candidates from the
-- index and *then* applies the policy, so an approximate scan can return
-- fewer rows than requested. At AVERIS's corpus size the planner picks an
-- exact sequential scan anyway, which is both correct and fast; the retrieval
-- code over-fetches regardless so that growing the corpus cannot quietly
-- start dropping results.
create index knowledge_embeddings_vector_idx
  on public.knowledge_embeddings
  using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- ai_conversations — what a patient asked and what AVERIS answered
-- ---------------------------------------------------------------------------
create table public.ai_conversations (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.patient_profiles (id) on delete cascade,
  question     text not null,
  response     text not null,
  -- Which chunks the answer was built from. Stored so the citation a patient
  -- saw can be reconstructed later, rather than re-derived from a corpus that
  -- may since have changed.
  sources_used jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),

  constraint ai_conversations_question_not_blank
    check (char_length(btrim(question)) between 1 and 2000),
  constraint ai_conversations_response_not_blank
    check (char_length(btrim(response)) between 1 and 20000),
  constraint ai_conversations_sources_is_array
    check (jsonb_typeof(sources_used) = 'array')
);

comment on table public.ai_conversations is
  'Questions a patient asked about their own record, with the sources used.';

create index ai_conversations_patient_idx
  on public.ai_conversations (patient_id, created_at desc);

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.knowledge_documents  enable row level security;
alter table public.knowledge_embeddings enable row level security;
alter table public.ai_conversations     enable row level security;

-- knowledge_documents ------------------------------------------------------
-- Public reference material: every signed-in patient reads the same rows and
-- none of them can write.
create policy "Signed-in users read the knowledge base"
  on public.knowledge_documents for select
  to authenticated
  using ( true );

-- knowledge_embeddings -----------------------------------------------------
--
-- This single policy is the entire isolation story for retrieval. Because it
-- is part of the query plan, a similarity search physically cannot rank a
-- chunk belonging to another patient — there is no ordering of results that
-- could surface one.
create policy "Patients read their own chunks and all knowledge chunks"
  on public.knowledge_embeddings for select
  to authenticated
  using (
    source_type = 'MEDICAL_KNOWLEDGE'
    or patient_id = private.current_patient_profile_id()
  );

create policy "Patients index their own documents"
  on public.knowledge_embeddings for insert
  to authenticated
  with check (
    source_type = 'PATIENT_DOCUMENT'
    and patient_id = private.current_patient_profile_id()
  );

-- Re-indexing replaces chunks, so a patient must be able to remove their own.
create policy "Patients remove their own chunks"
  on public.knowledge_embeddings for delete
  to authenticated
  using (
    source_type = 'PATIENT_DOCUMENT'
    and patient_id = private.current_patient_profile_id()
  );

-- No UPDATE policy: a chunk's text and its vector must agree, and an update
-- that changed one without the other would leave the index quietly wrong.
-- Re-indexing deletes and re-inserts.

-- ai_conversations ---------------------------------------------------------
create policy "Patients read own conversations"
  on public.ai_conversations for select
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

create policy "Patients create own conversations"
  on public.ai_conversations for insert
  to authenticated
  with check ( patient_id = private.current_patient_profile_id() );

create policy "Patients delete own conversations"
  on public.ai_conversations for delete
  to authenticated
  using ( patient_id = private.current_patient_profile_id() );

-- ===========================================================================
-- Grants
-- ===========================================================================
grant select                         on public.knowledge_documents  to authenticated;
grant select, insert, delete         on public.knowledge_embeddings to authenticated;
grant select, insert, delete         on public.ai_conversations     to authenticated;

-- ===========================================================================
-- Retrieval
-- ===========================================================================
--
-- SECURITY INVOKER, and that word is doing all the work.
--
-- A SECURITY DEFINER function here would run as its owner and bypass RLS
-- entirely — every similarity search would range over every patient's chunks,
-- and the isolation argument this whole migration rests on would be worth
-- nothing. It would also look completely fine in testing, because a single
-- patient's results are identical either way.
--
-- INVOKER means the caller's policies apply inside the ORDER BY, so the
-- ranking only ever sees rows that patient is allowed to read.
create or replace function public.match_knowledge(
  query_embedding extensions.vector(384),
  match_count     int default 8,
  filter_source   public.knowledge_source_type default null
)
returns table (
  id                    uuid,
  source_type           public.knowledge_source_type,
  document_id           uuid,
  knowledge_document_id uuid,
  chunk_index           int,
  content               text,
  metadata              jsonb,
  similarity            double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    e.id,
    e.source_type,
    e.document_id,
    e.knowledge_document_id,
    e.chunk_index,
    e.content,
    e.metadata,
    -- Vectors are L2-normalised at write time, so cosine distance is exact
    -- and this maps cleanly onto a 0..1 similarity.
    1 - (e.embedding <=> query_embedding) as similarity
  from public.knowledge_embeddings e
  where filter_source is null or e.source_type = filter_source
  order by e.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

comment on function public.match_knowledge is
  'Similarity search over retrievable chunks. SECURITY INVOKER so RLS scopes the ranking.';

revoke all on function public.match_knowledge(extensions.vector, int, public.knowledge_source_type) from public;
grant execute on function public.match_knowledge(extensions.vector, int, public.knowledge_source_type) to authenticated;

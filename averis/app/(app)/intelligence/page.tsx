import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildDigitalTwin } from "@/lib/services/twin/digital-twin-service";
import { generateHealthSummary } from "@/lib/services/twin/health-summary-service";
import { listConversations } from "@/lib/rag/rag-service";
import { Card, CardHeader, Callout, ButtonLink, Chip } from "@/components/ui";
import { formatDate } from "@/lib/utils/format";
import { AskPanel } from "./AskPanel";
import { SourceList } from "./SourceList";
import type { AnswerSource } from "@/lib/rag/types";

export const metadata = { title: "Health Intelligence" };
export const dynamic = "force-dynamic";

export default async function HealthIntelligencePage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();

  const [twin, history, knowledge] = await Promise.all([
    buildDigitalTwin(supabase, account.patientProfileId),
    listConversations(supabase, account.patientProfileId).catch(() => []),
    supabase
      .from("knowledge_documents")
      .select("id, title, category, citation")
      .order("category", { ascending: true })
      .then(({ data }) => data ?? []),
  ]);

  const summary = await generateHealthSummary(twin);
  const indexed = twin.documentCount > 0;

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">AVERIS Health Intelligence</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">
          Make sense of your health information
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          Ask questions about your own records and AVERIS will answer from them — showing which
          document each part of the answer came from. It explains what is on file; it does not
          diagnose.
        </p>
      </header>

      {!indexed && (
        <Callout tone="brand" title="Add a document to ask questions about it">
          AVERIS answers from the documents you have uploaded. With nothing on file it can only
          explain general medical terms.{" "}
          <Link href="/records" className="font-semibold underline underline-offset-2">
            Add a document
          </Link>
        </Callout>
      )}

      {/* ------------------------------------------------- 1. Ask AVERIS */}
      <Card>
        <CardHeader
          eyebrow="Section 1"
          title="Ask AVERIS"
          action={
            <span className="mono text-[12.5px] text-muted">
              {twin.documentCount} {twin.documentCount === 1 ? "document" : "documents"} searchable
            </span>
          }
        />
        <AskPanel />
      </Card>

      {/* ---------------------------------------------- 2. Health summary */}
      <Card>
        <CardHeader
          eyebrow="Section 2"
          title="Health summary"
          action={
            <Link href="/twin" className="text-[13.5px] font-medium text-brand hover:underline">
              Full Health Twin
            </Link>
          }
        />
        <div className="px-6 py-5">
          <p className="max-w-3xl text-[15px] leading-relaxed">{summary.summary}</p>

          <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
            <Stat label="Conditions" value={String(twin.conditions.length)} />
            <Stat
              label="Current medication"
              value={String(twin.medications.filter((m) => m.endDate === null).length)}
            />
            <Stat label="Documents" value={String(twin.documentCount)} />
            <Stat
              label="Last added"
              value={twin.lastDocumentAt ? formatDate(twin.lastDocumentAt) : "—"}
            />
          </dl>

          <p className="mt-4 font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted">
            {summary.fallback
              ? "Assembled directly from your record — AI summary unavailable"
              : `Written by ${summary.model} from facts already in your record`}
            {summary.guardrailTriggered && " · adjusted to remove clinical interpretation"}
          </p>
        </div>
      </Card>

      {/* ------------------------------------------- 3. Report explanation */}
      <Card>
        <CardHeader eyebrow="Section 3" title="Report explanation" />
        <div className="px-6 py-5">
          <p className="max-w-3xl text-[14.5px] leading-relaxed text-ink-soft">
            Open any report in your Medical Records Center and choose{" "}
            <strong>Explain this report</strong>. AVERIS reads the whole document rather than
            searching inside it, so nothing in the report is skipped, and pairs it with reference
            material on the terms it actually contains.
          </p>
          <div className="mt-4">
            <ButtonLink href="/records">Go to Medical Records</ButtonLink>
          </div>
        </div>
      </Card>

      {/* -------------------------------------------- 4. Medical knowledge */}
      <Card>
        <CardHeader
          eyebrow="Section 4"
          title="Medical knowledge"
          action={
            <span className="mono text-[12.5px] text-muted">
              {knowledge.length} {knowledge.length === 1 ? "article" : "articles"}
            </span>
          }
        />
        <div className="px-6 py-5">
          <p className="mb-4 max-w-3xl text-[14.5px] leading-relaxed text-ink-soft">
            The reference material AVERIS draws on. It is kept entirely separate from your
            records — these articles describe measurements in general, never your results.
          </p>

          {knowledge.length === 0 ? (
            <p className="text-[14px] text-muted">
              The knowledge base has not been seeded yet.
            </p>
          ) : (
            <ul className="divide-y divide-rule border-t border-rule">
              {knowledge.map((article) => (
                <li key={article.id} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-[14.5px] font-medium">{article.title}</span>
                    <Chip>{article.category.toLowerCase().replace(/_/g, " ")}</Chip>
                  </div>
                  <p className="mt-1 text-[12.5px] text-muted">{article.citation}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* ------------------------------------------------------- history */}
      {history.length > 0 && (
        <Card>
          <CardHeader
            eyebrow="Previously"
            title="Questions you have asked"
            action={
              <span className="mono text-[12.5px] text-muted">{history.length} saved</span>
            }
          />
          <ul className="divide-y divide-rule">
            {history.map((entry) => (
              <li key={entry.id} className="px-6 py-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[14.5px] font-medium">{entry.question}</p>
                  <span className="mono text-[12px] text-muted">
                    {formatDate(entry.createdAt)}
                  </span>
                </div>
                <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-ink-soft">
                  {entry.response}
                </p>
                <SourceList sources={entry.sources as AnswerSource[]} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        This information is for awareness and should not replace professional medical advice.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted">{label}</dt>
      <dd className="mono mt-1 text-[15px] font-semibold">{value}</dd>
    </div>
  );
}

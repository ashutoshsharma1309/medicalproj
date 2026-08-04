"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { SourceList } from "@/app/(app)/intelligence/SourceList";
import { explainReportAction, type ExplainState } from "../actions";

/**
 * "Explain this report".
 *
 * Collapsed until asked for. A patient opening a report wants the report; an
 * explanation that generates itself on every page load would be noise most of
 * the time and would spend a model call each visit.
 */

const INITIAL: ExplainState = { answer: null, error: null };

export function ExplainReport({ documentId, label }: { documentId: string; label: string }) {
  const [state, formAction] = useActionState(explainReportAction, INITIAL);

  return (
    <div className="px-6 py-5">
      {!state.answer && (
        <>
          <p className="max-w-2xl text-[14.5px] leading-relaxed text-ink-soft">
            AVERIS can read this report and explain what the tests measure, using the reference
            ranges printed on the document itself. It will not tell you what your values mean
            clinically — that is a conversation for your healthcare provider.
          </p>

          <form action={formAction} className="mt-4">
            <input type="hidden" name="documentId" value={documentId} />
            <input type="hidden" name="label" value={label} />
            <SubmitButton />
          </form>
        </>
      )}

      {state.error && (
        <p className="field-error mt-2" role="alert">
          {state.error}
        </p>
      )}

      {state.answer && (
        <div>
          <p className="max-w-3xl text-[15px] leading-relaxed">{state.answer.answer}</p>

          <SourceList sources={state.answer.sources} />

          <p className="mt-4 font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted">
            {state.answer.abstained
              ? "This report has not been indexed yet"
              : state.answer.generatedBy === "deterministic"
                ? "Assembled directly from the report — AI narration unavailable"
                : `Phrased by ${state.answer.generatedBy} from the sources above`}
            {state.answer.guardrailTriggered && " · adjusted to remove clinical interpretation"}
          </p>

          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            {state.answer.disclaimer}
          </p>
        </div>
      )}
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Reading the report…" : "Explain this report"}
    </button>
  );
}

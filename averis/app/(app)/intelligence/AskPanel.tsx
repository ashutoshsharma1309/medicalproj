"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { askAction, type AskState } from "./actions";
import { SourceList } from "./SourceList";

/**
 * Ask AVERIS.
 *
 * Deliberately not a chat transcript. A message thread invites open-ended
 * conversation, and open-ended conversation with a health record is exactly
 * the product this is not: one question, one grounded answer, sources shown
 * beneath it. There is no follow-up box under the reply, because a follow-up
 * would carry conversational context the retriever never saw.
 *
 * The suggested questions are not decoration. Patients do not know what a
 * record-grounded system can answer, and an empty box tends to produce either
 * nothing or "am I going to be okay" — a question AVERIS must decline. These
 * demonstrate the shape of question that works.
 */

const SUGGESTIONS = [
  "What does my most recent blood report show?",
  "When was my diabetes first recorded?",
  "What medications appear in my records?",
  "What does HbA1c measure?",
];

const INITIAL: AskState = { answer: null, error: null };

export function AskPanel() {
  const [state, formAction] = useActionState(askAction, INITIAL);

  return (
    <div>
      <form action={formAction} className="px-6 py-5">
        <label htmlFor="question" className="sr-only">
          Ask a question about your health records
        </label>

        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="question"
            name="question"
            type="text"
            required
            minLength={3}
            maxLength={500}
            autoComplete="off"
            defaultValue={state.answer?.question ?? ""}
            placeholder="Ask about your records — for example, what your last report showed"
            className="field-input flex-1"
          />
          <SubmitButton />
        </div>

        {state.error && (
          <p className="field-error mt-2" role="alert">
            {state.error}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="submit"
              name="question"
              value={suggestion}
              className="rounded-full border border-rule px-3 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:border-brand hover:text-brand"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </form>

      {state.answer && (
        <div className="border-t border-rule px-6 py-5">
          <p className="eyebrow mb-2">Your question</p>
          <p className="text-[14px] text-ink-soft">{state.answer.question}</p>

          <p className="eyebrow mb-2 mt-5">AVERIS</p>
          <p className="max-w-3xl text-[15px] leading-relaxed">{state.answer.answer}</p>

          <SourceList sources={state.answer.sources} />

          <p className="mt-4 font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted">
            {state.answer.abstained
              ? "No matching information found in your records"
              : state.answer.generatedBy === "deterministic"
                ? "Assembled directly from your records — AI narration unavailable"
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
    <button type="submit" className="btn btn-primary sm:w-40" disabled={pending}>
      {pending ? "Looking…" : "Ask AVERIS"}
    </button>
  );
}

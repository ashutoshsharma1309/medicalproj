"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { askAssistantAction, type AssistantState } from "./actions";
import { VoiceButton } from "@/components/health/VoiceButton";

/**
 * Ask AVERIS about this patient.
 *
 * One question, one grounded answer, the facts underneath it — the same shape
 * as the record assistant, and deliberately not a chat transcript. A thread
 * invites follow-ups that carry conversational context the grounding never
 * saw, and "and what about the other one?" is a question this assistant cannot
 * answer safely.
 *
 * The suggestions are not decoration. Nobody guesses what a monitoring
 * assistant can answer, and an empty box tends to produce either nothing or
 * "is he going to be alright" — the one question AVERIS must decline.
 */

const SUGGESTIONS = [
  "Why is this patient high risk?",
  "What alerts were raised today?",
  "Has anything changed in the last 24 hours?",
  "Is the device still reporting?",
];

const INITIAL: AssistantState = { question: "", answer: null, error: null };

export function AssistantPanel({ patientId }: { patientId: string }) {
  const [state, formAction] = useActionState(askAssistantAction, INITIAL);
  const [question, setQuestion] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const [pendingSubmit, setPendingSubmit] = useState(false);

  // A spoken question submits itself. Making someone dictate and then reach
  // for the mouse defeats the point of asking out loud.
  useEffect(() => {
    if (!pendingSubmit) return;
    setPendingSubmit(false);
    formRef.current?.requestSubmit();
  }, [pendingSubmit]);

  return (
    <div>
      <form ref={formRef} action={formAction} className="px-6 py-5">
        <input type="hidden" name="patientId" value={patientId} />
        <label htmlFor="care-question" className="sr-only">
          Ask about this patient&rsquo;s monitoring data
        </label>

        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="care-question"
            name="question"
            type="text"
            required
            minLength={3}
            maxLength={300}
            autoComplete="off"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask about vitals, risk, alerts or monitoring coverage"
            className="field-input flex-1"
          />
          <VoiceButton
            audience="CLINICIAN"
            onTranscript={(text) => {
              setQuestion(text);
              setPendingSubmit(true);
            }}
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
          <p className="eyebrow mb-2">Question</p>
          <p className="text-[14px] text-ink-soft">{state.question}</p>

          <p className="eyebrow mb-2 mt-5">AVERIS</p>
          <p className="max-w-3xl text-[15px] leading-relaxed">{state.answer.answer}</p>

          {state.answer.grounds.length > 0 && (
            <>
              <p className="eyebrow mb-2 mt-5">Measured</p>
              <ul className="space-y-1">
                {state.answer.grounds.map((ground) => (
                  <li key={ground} className="mono text-[12px] text-muted">
                    {ground}
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="mt-4 font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted">
            {state.answer.declined
              ? "Outside what AVERIS can answer"
              : state.answer.generatedBy === "rule" ||
                  state.answer.generatedBy === "deterministic"
                ? "Assembled directly from the monitoring data"
                : `Phrased by ${state.answer.generatedBy} from the measurements above`}
          </p>
        </div>
      )}
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary sm:w-32" disabled={pending}>
      {pending ? "Asking…" : "Ask"}
    </button>
  );
}

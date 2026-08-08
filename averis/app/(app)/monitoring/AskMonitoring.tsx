"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { askAboutMyMonitoring, EMPTY_ASK } from "./actions";
import { VoiceButton } from "@/components/health/VoiceButton";

/**
 * "How is my health today?"
 *
 * The patient-facing half of the same assistant, with the same grounding and
 * the same refusals. The wording of those refusals differs — a patient asking
 * "am I going to be okay?" is directed to their doctor and to emergency
 * services, where a clinician asking the same thing is told that the judgement
 * is theirs.
 *
 * This is separate from Ask AVERIS on the records page on purpose. That
 * assistant answers from uploaded documents; this one answers from the last 24
 * hours of measurements. Merging them would mean one box whose answer depends
 * on which retriever happened to match, and a patient could not tell which
 * they got.
 */

const SUGGESTIONS = [
  "How is my health today?",
  "Do I have any alerts?",
  "Has anything changed?",
  "Is my band still recording?",
];

export function AskMonitoring() {
  const [state, formAction] = useActionState(askAboutMyMonitoring, EMPTY_ASK);
  const [question, setQuestion] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const [pendingSubmit, setPendingSubmit] = useState(false);

  useEffect(() => {
    if (!pendingSubmit) return;
    setPendingSubmit(false);
    formRef.current?.requestSubmit();
  }, [pendingSubmit]);

  return (
    <div>
      <form ref={formRef} action={formAction} className="px-6 py-5">
        <label htmlFor="monitoring-question" className="sr-only">
          Ask about your monitoring
        </label>

        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="monitoring-question"
            name="question"
            type="text"
            required
            minLength={3}
            maxLength={300}
            autoComplete="off"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask about your vitals, alerts or whether anything has changed"
            className="field-input flex-1"
          />
          <VoiceButton
            audience="PATIENT"
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
          <p className="eyebrow mb-2">You asked</p>
          <p className="text-[14px] text-ink-soft">{state.question}</p>

          <p className="eyebrow mb-2 mt-5">AVERIS</p>
          <p className="max-w-3xl text-[15px] leading-relaxed">{state.answer.answer}</p>

          {state.answer.grounds.length > 0 && (
            <>
              <p className="eyebrow mb-2 mt-5">From these measurements</p>
              <ul className="space-y-1">
                {state.answer.grounds.map((ground) => (
                  <li key={ground} className="mono text-[12px] text-muted">
                    {ground}
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="mt-4 text-[13px] leading-relaxed text-muted">
            AVERIS reports what your device measured. It does not diagnose or advise — talk to
            your doctor about what any of it means.
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

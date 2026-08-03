"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, Card, Chip } from "@/components/ui";
import { confidencePercent, confidenceTone } from "@/lib/services/documents/labels";
import type { ReviewItem, ReviewSubmission } from "@/lib/services/documents/types";
import { confirmExtractionAction } from "../../actions";

const KIND_LABEL: Record<ReviewItem["kind"], string> = {
  CONDITION: "Condition",
  MEDICATION: "Medication",
  ALLERGY: "Allergy",
  LAB_RESULT: "Test result",
};

const GROUP_ORDER: ReviewItem["kind"][] = [
  "ALLERGY",
  "CONDITION",
  "MEDICATION",
  "LAB_RESULT",
];

type RowState = {
  decision: "CONFIRM" | "REJECT";
  editing: boolean;
  label: string;
};

export function ReviewForm({
  documentId,
  items,
}: {
  documentId: string;
  items: ReviewItem[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Default to confirm for high-confidence items; anything AVERIS is unsure
  // about starts unconfirmed so the patient has to make a deliberate choice.
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(
      items.map((item) => [
        item.id,
        {
          decision: item.needsAttention ? "REJECT" : "CONFIRM",
          editing: false,
          label: item.label,
        } satisfies RowState,
      ]),
    ),
  );

  const grouped = useMemo(() => {
    return GROUP_ORDER.map((kind) => ({
      kind,
      entries: items.filter((i) => i.kind === kind),
    })).filter((g) => g.entries.length > 0);
  }, [items]);

  const confirmedCount = Object.values(rows).filter((r) => r.decision === "CONFIRM").length;
  const attentionCount = items.filter((i) => i.needsAttention).length;

  function update(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function setAll(decision: "CONFIRM" | "REJECT") {
    setRows((prev) =>
      Object.fromEntries(Object.entries(prev).map(([id, row]) => [id, { ...row, decision }])),
    );
  }

  function submit() {
    setError(null);
    const submissions: ReviewSubmission[] = items.map((item) => {
      const row = rows[item.id];
      return {
        id: item.id,
        decision: row.decision,
        editedLabel: row.label !== item.label ? row.label : undefined,
      };
    });

    startTransition(async () => {
      const result = await confirmExtractionAction(documentId, submissions);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.push(`/records/${documentId}?confirmed=${result.confirmed ?? 0}`);
      router.refresh();
    });
  }

  if (items.length === 0) {
    return (
      <Card>
        <div className="px-6 py-10 text-center">
          <p className="text-[15px] font-medium">
            AVERIS didn&rsquo;t find any health information in this document
          </p>
          <p className="mx-auto mt-1.5 max-w-md text-[14px] leading-relaxed text-ink-soft">
            The document is stored in your records. If you expected conditions, medications or
            test results, a clearer copy may read better.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {attentionCount > 0 && (
        <Callout tone="notice" title={`${attentionCount} item${attentionCount > 1 ? "s need" : " needs"} a closer look`}>
          AVERIS was less confident about these, so they start unconfirmed. Check them against
          the document and correct anything that is wrong.
        </Callout>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-6 py-4">
          <div>
            <p className="eyebrow">Verification</p>
            <h2 className="mt-1 text-[17px] font-semibold">
              AVERIS detected the following information
            </h2>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setAll("CONFIRM")}>
              Confirm all
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setAll("REJECT")}>
              Clear all
            </button>
          </div>
        </div>

        {grouped.map((group) => (
          <section key={group.kind}>
            <h3 className="eyebrow border-b border-rule bg-paper px-6 py-2.5">
              {KIND_LABEL[group.kind]}
              {group.entries.length > 1 ? "s" : ""}
            </h3>
            <ul className="divide-y divide-rule">
              {group.entries.map((item) => {
                const row = rows[item.id];
                const confirmed = row.decision === "CONFIRM";
                return (
                  <li key={item.id} className="px-6 py-4">
                    <div className="flex flex-wrap items-start gap-4">
                      <label className="flex flex-1 cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          checked={confirmed}
                          onChange={(e) =>
                            update(item.id, {
                              decision: e.target.checked ? "CONFIRM" : "REJECT",
                            })
                          }
                          className="mt-1 h-4 w-4 accent-[var(--color-brand)]"
                          aria-label={`Confirm ${item.label}`}
                        />
                        <span className="min-w-0 flex-1">
                          {row.editing ? (
                            <input
                              className="field-input"
                              value={row.label}
                              autoFocus
                              onChange={(e) => update(item.id, { label: e.target.value })}
                              onBlur={() => update(item.id, { editing: false })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  update(item.id, { editing: false });
                                }
                              }}
                            />
                          ) : (
                            <span
                              className={`block text-[15px] font-medium ${
                                confirmed ? "" : "text-muted line-through"
                              }`}
                            >
                              {row.label}
                            </span>
                          )}
                          {row.label !== item.label && (
                            <span className="mt-1 block text-[12.5px] text-muted">
                              Originally read as &ldquo;{item.label}&rdquo;
                            </span>
                          )}
                        </span>
                      </label>

                      <div className="flex items-center gap-3">
                        <span
                          className="text-right"
                          title="How confident AVERIS is that it read this correctly"
                        >
                          <Chip tone={confidenceTone(item.confidence)}>
                            {confidencePercent(item.confidence)}
                          </Chip>
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => update(item.id, { editing: !row.editing })}
                        >
                          {row.editing ? "Done" : "Edit"}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        <div className="space-y-4 border-t border-rule px-6 py-5">
          {error && <Callout tone="critical">{error}</Callout>}

          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-[13.5px] text-ink-soft">
              <strong>{confirmedCount}</strong> of {items.length} will be added to your health
              profile. Anything left unchecked is discarded.
            </p>
            <Button onClick={submit} disabled={pending}>
              {pending ? "Saving…" : `Confirm ${confirmedCount} and save`}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

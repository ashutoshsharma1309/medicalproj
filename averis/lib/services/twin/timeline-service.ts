import type {
  ConfirmedRecordRow,
  DocumentRow,
  TimelineEvent,
  TrackedCondition,
  MedicationRecord,
} from "./types";

/**
 * Timeline service.
 *
 * Derives a chronological health journey from records the patient has already
 * confirmed. Pure — no database, no model, no network — so the ordering and
 * de-duplication rules are directly testable.
 *
 * The event date is the clinical date where one exists (`record_date`), not
 * the upload date. A report from 2019 belongs in 2019 even if it was scanned
 * last week; putting it at the upload date would misrepresent the journey.
 */

export function deriveTimelineEvents(
  records: ConfirmedRecordRow[],
  documents: DocumentRow[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const record of records) {
    const date = record.record_date ?? isoDate(record.created_at);

    switch (record.record_type) {
      case "CONDITION":
        if (!record.condition) break;
        events.push({
          eventType: "DIAGNOSIS",
          eventTitle: `${record.condition} recorded`,
          description: "Confirmed from an uploaded document.",
          eventDate: date,
          sourceDocumentId: record.source_document_id,
        });
        break;

      case "MEDICATION":
        if (!record.medication) break;
        events.push({
          eventType: "MEDICATION_STARTED",
          eventTitle: `${record.medication} recorded`,
          description: "Appears in your medication history.",
          eventDate: date,
          sourceDocumentId: record.source_document_id,
        });
        break;

      case "ALLERGY":
        if (!record.allergy) break;
        events.push({
          eventType: "ALLERGY_RECORDED",
          eventTitle: `Allergy recorded: ${record.allergy}`,
          description: "Shown prominently on your health profile.",
          eventDate: date,
          sourceDocumentId: record.source_document_id,
        });
        break;

      case "LAB_RESULT": {
        if (!record.test_name) break;
        const measured = [record.test_value, record.test_unit].filter(Boolean).join(" ");
        events.push({
          eventType: "LAB_RESULT",
          eventTitle: `${record.test_name}: ${measured}`,
          description: record.reference_range
            ? `Reference range on the document: ${record.reference_range}.`
            : null,
          eventDate: date,
          sourceDocumentId: record.source_document_id,
        });
        break;
      }
    }
  }

  // Documents themselves are part of the journey — but only add one when it
  // contributed no records, otherwise every upload doubles up with its content.
  const documentsWithRecords = new Set(
    records.map((r) => r.source_document_id).filter(Boolean) as string[],
  );
  for (const document of documents) {
    if (documentsWithRecords.has(document.id)) continue;
    events.push({
      eventType: "DOCUMENT_ADDED",
      eventTitle: `${document.file_name} added`,
      description: `${humanizeType(document.document_type)} added to your records.`,
      eventDate: isoDate(document.uploaded_at),
      sourceDocumentId: document.id,
    });
  }

  return sortAndDedupe(events);
}

/** Newest first; identical title + date collapses to one entry. */
export function sortAndDedupe(events: TimelineEvent[]): TimelineEvent[] {
  const seen = new Set<string>();
  const unique: TimelineEvent[] = [];

  for (const event of events) {
    const key = `${event.eventDate}|${event.eventTitle.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }

  return unique.sort((a, b) => b.eventDate.localeCompare(a.eventDate));
}

/** Groups the timeline by year for the vertical timeline UI. */
export function groupByYear(
  events: TimelineEvent[],
): { year: string; events: TimelineEvent[] }[] {
  const years = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const year = event.eventDate.slice(0, 4);
    if (!years.has(year)) years.set(year, []);
    years.get(year)!.push(event);
  }
  return [...years.entries()]
    .map(([year, list]) => ({ year, events: list }))
    .sort((a, b) => b.year.localeCompare(a.year));
}

/**
 * Collapses confirmed CONDITION records into one tracked condition each,
 * keeping the earliest date as "first detected" and the highest confidence.
 */
export function deriveConditions(records: ConfirmedRecordRow[]): TrackedCondition[] {
  const byName = new Map<string, TrackedCondition>();

  for (const record of records) {
    if (record.record_type !== "CONDITION" || !record.condition) continue;

    const key = record.condition.trim().toLowerCase();
    const date = record.record_date ?? isoDate(record.created_at);
    const existing = byName.get(key);

    if (!existing) {
      byName.set(key, {
        conditionName: record.condition.trim(),
        firstDetected: date,
        severity: "UNKNOWN",
        currentStatus: "ACTIVE",
        confidenceScore: record.confidence_score,
      });
      continue;
    }

    if (existing.firstDetected && date < existing.firstDetected) {
      existing.firstDetected = date;
    }
    if ((record.confidence_score ?? 0) > (existing.confidenceScore ?? 0)) {
      existing.confidenceScore = record.confidence_score;
    }
  }

  return [...byName.values()].sort((a, b) =>
    (a.firstDetected ?? "").localeCompare(b.firstDetected ?? ""),
  );
}

/**
 * Builds medication history from confirmed MEDICATION records.
 *
 * A medication seen in a more recent document is treated as still current;
 * an earlier entry for the same drug is closed off at the newer start date, so
 * the history reads as a sequence rather than a pile of duplicates.
 */
export function deriveMedicationHistory(
  records: ConfirmedRecordRow[],
): MedicationRecord[] {
  const entries = records
    .filter((r) => r.record_type === "MEDICATION" && r.medication)
    .map((r) => ({
      raw: r.medication!.trim(),
      date: r.record_date ?? isoDate(r.created_at),
      sourceDocumentId: r.source_document_id,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byDrug = new Map<string, MedicationRecord[]>();

  for (const entry of entries) {
    const { name, dosage, frequency } = splitMedicationLabel(entry.raw);
    const key = name.toLowerCase();
    const history = byDrug.get(key) ?? [];

    const previous = history[history.length - 1];
    if (previous && previous.endDate === null && previous.startDate !== entry.date) {
      previous.endDate = entry.date;
    }

    history.push({
      medicineName: name,
      dosage,
      frequency,
      startDate: entry.date,
      endDate: null,
      sourceDocumentId: entry.sourceDocumentId,
    });
    byDrug.set(key, history);
  }

  return [...byDrug.values()]
    .flat()
    .sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""));
}

/** "Metformin 500 mg — twice daily" → its three parts. */
export function splitMedicationLabel(label: string): {
  name: string;
  dosage: string | null;
  frequency: string | null;
} {
  const [head, ...tail] = label.split("—");
  const frequency = tail.join("—").trim() || null;

  const match = head.trim().match(/^(.*?)\s*(\d[\d.]*\s*(?:mg|mcg|g|ml|units?|iu)\b.*)$/i);
  if (match) {
    return { name: match[1].trim(), dosage: match[2].trim(), frequency };
  }
  return { name: head.trim(), dosage: null, frequency };
}

function humanizeType(value: string): string {
  return value.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function isoDate(value: string): string {
  return value.slice(0, 10);
}

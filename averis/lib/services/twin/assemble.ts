import {
  deriveTimelineEvents,
  deriveConditions,
  deriveMedicationHistory,
} from "./timeline-service";
import { generateInsights } from "./insight-service";
import { computeHealthOverview } from "./overview-service";
import type {
  ConfirmedRecordRow,
  DigitalTwin,
  DocumentRow,
  ProfileSnapshot,
} from "./types";

/**
 * Assembles the twin from already-fetched data.
 *
 * Split out from digital-twin-service so it carries no `server-only` import and
 * no Supabase dependency — the whole derivation can therefore be exercised in
 * unit tests with plain fixtures.
 */
export function assembleTwin(input: {
  profile: ProfileSnapshot;
  age: number | null;
  records: ConfirmedRecordRow[];
  documents: DocumentRow[];
  now?: Date;
}): DigitalTwin {
  const { profile, age, records, documents } = input;
  const now = input.now ?? new Date();

  const conditions = deriveConditions(records);
  const medications = deriveMedicationHistory(records);
  const timeline = deriveTimelineEvents(records, documents);
  const insights = generateInsights({ records, documents, conditions, medications, now });
  const overview = computeHealthOverview({ profile, records, documents, medications, now });

  const lastDocumentAt =
    documents.length > 0
      ? documents.map((d) => d.uploaded_at).sort().reverse()[0]
      : null;

  return {
    profile,
    age,
    conditions,
    medications,
    timeline,
    insights,
    overview,
    documentCount: documents.length,
    lastDocumentAt,
  };
}

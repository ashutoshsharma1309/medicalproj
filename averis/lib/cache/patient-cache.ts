/**
 * Caching patient-derived reads.
 *
 * `lib/cache/cache.ts` provides the driver, the key discipline and the
 * read-through helper. This module adds the one rule that makes it safe to put
 * an RLS-filtered read behind a cache, and it is not obvious enough to leave to
 * whoever writes the next caching call site.
 *
 * ── The hazard ─────────────────────────────────────────────────────────────
 *
 * Every read in AVERIS is filtered by Row Level Security against the person
 * making it. `buildDigitalTwin(supabase, patientId)` does not return "the
 * patient's twin" — it returns *the part of the patient's twin the caller is
 * allowed to see*. A patient reading their own record sees all of it. A
 * caregiver sees what the care-team policy grants. A doctor with an active
 * assignment sees something else again.
 *
 * Cache that result under `twin:<patientId>` and the second caller gets the
 * first caller's view. Whichever of them has the narrower grant, the outcome is
 * wrong, and in one direction it is a disclosure: a caregiver with limited
 * access reads a twin assembled while the patient themself was signed in. The
 * database refused nothing, because the database was never asked — the answer
 * came out of Redis.
 *
 * Nothing errors. It is precisely the class of bug that survives review and a
 * single-account test environment.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * **A patient-derived value is cached only when the viewer is the subject.**
 *
 * Not "the key includes the viewer" — that would be correct and would also
 * quietly cache one entry per doctor per patient, which is a cache that never
 * hits and a store that grows with the cross product. The patient's own
 * dashboard is where the repeated reads actually are: a page they open several
 * times a day, recomputing the same assembly from a dozen tables.
 *
 * Everyone else computes. A clinician's view of a caseload is not a hot path,
 * it is a handful of reads per shift, and it is the view where being current
 * matters most.
 *
 * This is enforced here rather than documented, because a rule that depends on
 * every future caller remembering it is a rule that holds until the next
 * feature.
 */

import { cached, invalidatePatient, patientKey } from "./cache";

/** Namespaces this module will cache. Mirrors the patient-scoped set. */
export type SubjectNamespace = "summary" | "twin" | "risk";

/**
 * How long each kind of derived value stays warm.
 *
 * Short. These are convenience caches over data that changes when the patient
 * uploads a document or their band reports something — and the invalidation
 * below handles the changes we know about. The TTL is the backstop for the
 * changes we do not, so it is measured in minutes rather than hours.
 *
 * `risk` is shortest because it moves with incoming vitals. `twin` is longest
 * because it is assembled from documents, which change when somebody uploads
 * one and not otherwise — and that upload invalidates explicitly.
 */
export const TTL_SECONDS: Record<SubjectNamespace, number> = {
  risk: 60,
  summary: 180,
  twin: 300,
};

/**
 * Read-through cache for a value derived from one patient's record.
 *
 * Caches only when `viewerId === subjectId`. Every other caller runs `compute`
 * and stores nothing, so a clinician's narrower or broader view can never be
 * served to anybody, including themselves on a later request.
 *
 * @param namespace  which kind of derived value
 * @param subjectId  the patient the data is about
 * @param viewerId   the patient profile id of the person reading, or null when
 *                   the reader is not a patient (a doctor, a caregiver, a job)
 */
export async function cachedForSubject<T>(
  namespace: SubjectNamespace,
  subjectId: string,
  viewerId: string | null,
  compute: () => Promise<T>,
  suffix?: string,
): Promise<T> {
  // The whole rule, in one comparison. A clinician viewing a patient, a
  // caregiver, a background job — all of them recompute.
  if (!viewerId || viewerId !== subjectId) {
    return compute();
  }

  return cached(
    patientKey(namespace, subjectId, suffix),
    TTL_SECONDS[namespace],
    compute,
  );
}

/**
 * Drops everything derived for a patient.
 *
 * Call after anything that changes what those values would be: a document
 * ingested, a condition confirmed, a medication ended, a baseline recomputed.
 *
 * Deliberately coarse — it clears all three namespaces rather than reasoning
 * about which ones a given change affects. The precise version would be a set
 * of rules about which writes invalidate which derived values, and the first
 * one that turned out to be wrong would leave a patient looking at a stale
 * summary of their own health with no way to tell.
 *
 * The cost of being coarse is a few recomputations. The cost of being wrong is
 * a patient making a decision on last week's picture.
 */
export async function invalidateForPatient(patientId: string): Promise<void> {
  await invalidatePatient(patientId);
}

/**
 * Whether a read will be served from cache for this viewer.
 *
 * Exported for the tests and for diagnostics — a cache whose hit conditions
 * cannot be inspected is one nobody can debug when a page shows something old.
 */
export function isCacheable(subjectId: string, viewerId: string | null): boolean {
  return viewerId !== null && viewerId === subjectId;
}

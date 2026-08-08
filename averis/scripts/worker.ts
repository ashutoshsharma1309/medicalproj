/**
 * Document processing worker.
 *
 *     node --experimental-strip-types scripts/worker.ts
 *
 * Claims queued jobs and runs the Phase 2 pipeline on them. Runs as its own
 * process rather than inside a request, for two reasons.
 *
 * **Latency isolation.** OCR plus an extraction call takes tens of seconds. In
 * the request-serving container that competes with every page a patient loads,
 * and on Cloud Run it holds a request slot for the duration.
 *
 * **Independent scaling.** Web scales with concurrent readers, the worker with
 * queue depth. They are different signals and conflating them means
 * over-provisioning one to serve the other.
 *
 * This is the one component that holds a service-role key, because claiming
 * work necessarily crosses patients — which is exactly what RLS prevents for
 * user-facing code. The key is never given to the web container, and the claim
 * function is not callable by any client role.
 */

import { createClient } from "@supabase/supabase-js";
import { log } from "../lib/observability/logger.ts";
import { isRetryable, nextRunAt, onFailure } from "../lib/jobs/queue.ts";
import { refreshTwin } from "../lib/health/twin-service.ts";

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 5000);
const BATCH = Number(process.env.WORKER_BATCH ?? 1);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail at boot rather than on the first job. A worker that starts and then
    // cannot claim anything looks alive to the orchestrator while the queue
    // silently backs up.
    throw new Error(`${name} is required for the worker.`);
  }
  return value;
}

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

let running = true;
let inFlight = 0;

/**
 * Drains signals gracefully.
 *
 * A worker killed mid-job leaves the row RUNNING until its transaction dies.
 * Refusing new work and letting the current job finish avoids that entirely
 * for the ordinary case of a deploy.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (!running) return;
    running = false;
    log.info("worker draining", { signal, inFlight });
  });
}

type ClaimedJob = {
  job_id: string;
  patient_id: string;
  document_id: string;
  attempts: number;
};

async function claim(): Promise<ClaimedJob[]> {
  const { data, error } = await supabase.rpc("claim_processing_job", {
    worker_batch: BATCH,
  });

  if (error) {
    log.error("job claim failed", { error });
    return [];
  }
  return (data ?? []) as ClaimedJob[];
}

async function runJob(job: ClaimedJob): Promise<void> {
  const started = Date.now();
  inFlight += 1;

  try {
    const { processDocument } = await import("../lib/services/documents/processing-service.ts");
    const result = await processDocument(supabase as never, job.document_id);

    if (!result.ok) throw new Error(result.error ?? "Processing failed.");

    await supabase
      .from("processing_jobs")
      .update({ status: "SUCCEEDED", completed_at: new Date().toISOString(), last_error: null })
      .eq("id", job.job_id);

    await notify(job, {
      kind: "DOCUMENT_PROCESSED",
      title: "Your document is ready to review",
      body: "AVERIS finished reading your document. Confirm what it found to add it to your record.",
      href: `/records/${job.document_id}/review`,
    });

    log.info("job succeeded", {
      jobId: job.job_id,
      documentId: job.document_id,
      attempts: job.attempts,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // A permanent failure is retired immediately: a corrupt PDF will not parse
    // on the third attempt, and retrying only delays telling the patient.
    const retryable = isRetryable(error);
    const outcome = retryable
      ? onFailure(job.attempts, 3)
      : { status: "DEAD" as const, runAfterMs: 0, exhausted: true };

    await supabase
      .from("processing_jobs")
      .update({
        status: outcome.status,
        run_after: nextRunAt(new Date(), outcome.runAfterMs),
        last_error: message.slice(0, 500),
        completed_at: outcome.exhausted ? new Date().toISOString() : null,
      })
      .eq("id", job.job_id);

    if (outcome.exhausted) {
      await notify(job, {
        kind: "DOCUMENT_FAILED",
        title: "AVERIS could not read this document",
        body: "Try uploading a clearer scan, or add the details to your profile manually.",
        href: `/records/${job.document_id}`,
      });
    }

    log.error("job failed", {
      jobId: job.job_id,
      documentId: job.document_id,
      attempts: job.attempts,
      retryable,
      exhausted: outcome.exhausted,
      durationMs: Date.now() - started,
      error,
    });
  } finally {
    inFlight -= 1;
  }
}

/** Notifications are system-written; no client role may insert them. */
async function notify(
  job: ClaimedJob,
  notification: { kind: string; title: string; body: string; href: string },
): Promise<void> {
  const { error } = await supabase.from("notifications").insert({
    patient_id: job.patient_id,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    href: notification.href,
  });

  // A missing notification is a worse experience, not a failed job.
  if (error) log.warn("notification insert failed", { jobId: job.job_id, error });
}

/**
 * How often personal baselines are recomputed.
 *
 * Hourly, not per reading. A baseline learned from 30 days does not move in
 * two seconds, and recomputing it on the ingest path would put a 20,000-row
 * scan behind every uplink — the one code path that must stay fast, because a
 * slow ingest is a reading that arrives late.
 *
 * The work itself is idempotent and writes nothing when nothing has changed,
 * so a missed cycle costs an hour of freshness rather than correctness.
 */
const BASELINE_INTERVAL_MS = 60 * 60 * 1000;
let lastBaselineSweepMs = 0;

/**
 * Recomputes baselines and trends for patients who have been monitored
 * recently.
 *
 * Scoped to *active* patients on purpose: a patient with no readings this week
 * has nothing new to learn from, and sweeping the whole table would make the
 * job's cost a function of how many people ever used AVERIS rather than how
 * many are being monitored now.
 */
async function refreshBaselines(): Promise<void> {
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();

  const { data: active } = await supabase
    .from("sensor_readings")
    .select("patient_id")
    .gte("recorded_at", since)
    .limit(5000);

  const patients = [...new Set((active ?? []).map((row) => row.patient_id))];

  if (patients.length === 0) return;

  let baselines = 0;
  let events = 0;

  for (const patientId of patients) {
    try {
      const result = await refreshTwin(supabase as never, patientId);
      if (result.baselineWritten) baselines += 1;
      events += result.eventsWritten;
    } catch (error) {
      // One patient's baseline failing must not stop the sweep. Logged at
      // error because a baseline that silently stops updating is a
      // personalisation feature that quietly becomes a fixed threshold.
      log.error("baseline refresh failed", { patientId, error });
    }
  }

  log.info("baseline sweep", { patients: patients.length, baselines, events });
}

async function main(): Promise<void> {
  log.info("worker started", { pollMs: POLL_MS, batch: BATCH });

  while (running) {
    if (Date.now() - lastBaselineSweepMs >= BASELINE_INTERVAL_MS) {
      lastBaselineSweepMs = Date.now();
      await refreshBaselines();
    }

    const jobs = await claim();

    if (jobs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }

    // Sequential rather than parallel: OCR is CPU-bound and running several at
    // once on one container makes all of them slower without finishing more.
    for (const job of jobs) {
      if (!running) break;
      await runJob(job);
    }
  }

  log.info("worker stopped", { inFlight });
  process.exit(0);
}

main().catch((error) => {
  log.error("worker crashed", { error });
  process.exit(1);
});

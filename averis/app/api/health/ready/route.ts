import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAiConfigured } from "@/lib/ai/provider";
import { log } from "@/lib/observability/logger";

/**
 * Readiness.
 *
 * Answers "should traffic be routed here?" — so unlike liveness it does check
 * dependencies. Two rules shape what it reports.
 *
 * **Only hard dependencies can make it unready.** The database is one: without
 * it every authenticated page fails. The model provider is not — an AI outage
 * degrades AVERIS to deterministic summaries and quoted retrieval, which is a
 * worse product but a working one. Reporting unready for a soft dependency
 * takes the whole service offline to protect a feature that has a fallback.
 *
 * **It reveals nothing useful to an unauthenticated caller.** The endpoint is
 * necessarily open — probes cannot authenticate — so it reports component
 * status and no versions, hostnames, or error text. A readiness endpoint that
 * echoes a connection string is a reconnaissance endpoint.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Check = { name: string; ok: boolean; required: boolean; latencyMs: number };

export async function GET() {
  const checks: Check[] = [];

  // A trivial query rather than a connection test: a pool can hold an open
  // socket to a database that is no longer answering.
  const dbStarted = Date.now();
  let dbOk = false;
  try {
    const supabase = await createClient();
    const { error } = await supabase.from("knowledge_documents").select("id").limit(1);
    dbOk = !error;
  } catch {
    dbOk = false;
  }
  checks.push({
    name: "database",
    ok: dbOk,
    required: true,
    latencyMs: Date.now() - dbStarted,
  });

  // Configuration only — calling the provider on every probe would spend money
  // on health checks and rate-limit the thing it is meant to be watching.
  checks.push({
    name: "ai_provider",
    ok: isAiConfigured(),
    required: false,
    latencyMs: 0,
  });

  const ready = checks.every((check) => check.ok || !check.required);

  if (!ready) {
    log.error("readiness check failed", {
      failed: checks.filter((c) => c.required && !c.ok).map((c) => c.name),
    });
  }

  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      checks: checks.map(({ name, ok, required, latencyMs }) => ({
        name,
        ok,
        required,
        latencyMs,
      })),
    },
    {
      status: ready ? 200 : 503,
      // A cached readiness response is worse than none: the orchestrator would
      // route traffic based on how the service was a minute ago.
      headers: { "Cache-Control": "no-store" },
    },
  );
}

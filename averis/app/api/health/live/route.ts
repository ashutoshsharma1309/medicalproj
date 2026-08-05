import { NextResponse } from "next/server";

/**
 * Liveness.
 *
 * Answers only "is this process running and able to serve a response?" — it
 * touches no dependency on purpose.
 *
 * The distinction from readiness matters operationally. A liveness probe that
 * checks the database will fail during a database outage, the orchestrator
 * will conclude the container is broken and restart it, and restarting a
 * healthy process does nothing except lose its warm model cache and add load
 * to the database that is already struggling. Liveness answers "restart me";
 * readiness answers "route traffic to me". Only readiness should depend on
 * anything external.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: process.env.SERVICE_NAME ?? "averis-web",
    uptimeSeconds: Math.floor(process.uptime()),
  });
}

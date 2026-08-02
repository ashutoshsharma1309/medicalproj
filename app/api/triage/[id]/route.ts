import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { z } from "zod";

const Body = z.object({ status: z.enum(["WAITING", "IN_TREATMENT", "DISCHARGED"]) });

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("DOCTOR", "ADMIN");
  if ("error" in guard) return guard.error;

  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid status." }, { status: 400 });

  const updated = await db.triageCase
    .update({
      where: { id },
      data: {
        status: parsed.data.status,
        assignedTo: parsed.data.status === "IN_TREATMENT" ? guard.user.name : undefined,
      },
    })
    .catch(() => null);
  if (!updated) return NextResponse.json({ error: "Case not found." }, { status: 404 });

  audit({
    userId: guard.user.id,
    action: "triage.update",
    resource: `triage:${id}`,
    detail: parsed.data.status,
  });
  return NextResponse.json({ case: updated });
}

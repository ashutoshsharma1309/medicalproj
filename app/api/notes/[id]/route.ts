import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { z } from "zod";

const Body = z.object({
  status: z.enum(["DRAFT", "FINALIZED"]).optional(),
  subjective: z.string().optional(),
  objective: z.string().optional(),
  assessment: z.string().optional(),
  plan: z.string().optional(),
  summary: z.string().optional(),
  followUp: z.string().optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRole("DOCTOR");
  if ("error" in guard) return guard.error;

  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid update." }, { status: 400 });

  const updated = await db.clinicalNote
    .update({ where: { id }, data: parsed.data })
    .catch(() => null);
  if (!updated) return NextResponse.json({ error: "Note not found." }, { status: 404 });

  audit({
    userId: guard.user.id,
    action: parsed.data.status === "FINALIZED" ? "note.finalize" : "note.update",
    resource: `note:${id}`,
  });
  return NextResponse.json({ note: updated });
}

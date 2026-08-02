import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { answerClinicalQuestion } from "@/lib/rag";
import { z } from "zod";

const Body = z.object({ query: z.string().min(5, "Ask a fuller question.") });

export async function POST(req: NextRequest) {
  const guard = await requireRole("DOCTOR", "ADMIN");
  if ("error" in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid question." },
      { status: 400 },
    );
  }

  try {
    const result = await answerClinicalQuestion(parsed.data.query);
    audit({
      userId: guard.user.id,
      action: "ai.knowledge_query",
      detail: parsed.data.query.slice(0, 120),
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Query failed." },
      { status: 500 },
    );
  }
}

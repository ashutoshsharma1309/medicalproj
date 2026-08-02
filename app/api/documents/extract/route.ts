import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { extractDocument } from "@/lib/ai/extraction";
import { z } from "zod";

const Body = z.object({
  patientId: z.string().optional(),
  filename: z.string().default("pasted-document.txt"),
  text: z.string().min(20, "Document text is too short to analyze."),
});

export async function POST(req: NextRequest) {
  const guard = await requireRole("DOCTOR", "ADMIN");
  if ("error" in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }
  const { patientId, filename, text } = parsed.data;

  try {
    const { extraction, engine } = await extractDocument(text);

    let documentId: string | null = null;
    if (patientId) {
      const doc = await db.document.create({
        data: {
          patientId,
          filename,
          kind: extraction.documentType,
          rawText: text,
          extraction: extraction as object,
          extractedWith: engine,
        },
      });
      documentId = doc.id;
    }

    audit({
      userId: guard.user.id,
      action: "ai.extract",
      resource: patientId ? `patient:${patientId}` : undefined,
      detail: `${filename} via ${engine}`,
    });

    return NextResponse.json({ extraction, engine, documentId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Extraction failed." },
      { status: 500 },
    );
  }
}

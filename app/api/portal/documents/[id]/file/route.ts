import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { requirePatient } from "@/lib/patient";
import { audit } from "@/lib/audit";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

/** Authenticated, ownership-checked download of an uploaded document. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePatient();
  if ("error" in guard) return guard.error;

  const { id } = await ctx.params;
  const doc = await db.document.findUnique({ where: { id } });
  if (!doc || !guard.patient || doc.patientId !== guard.patient.id || !doc.storagePath) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  // storagePath is a server-generated basename; re-basing prevents traversal.
  const resolved = path.join(UPLOAD_DIR, path.basename(doc.storagePath));
  try {
    const bytes = await readFile(resolved);
    audit({ userId: guard.user.id, action: "portal.document_view", resource: `document:${doc.id}` });
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": doc.fileType ?? "application/octet-stream",
        "Content-Disposition": `inline; filename="${doc.filename.replace(/[^\w.\- ]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "The stored file is unavailable." }, { status: 404 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requirePatient } from "@/lib/patient";
import { extractFromFile, extractFromText } from "@/lib/ai/patientExtraction";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "text/plain": ".txt",
};
const UPLOAD_DIR = path.join(process.cwd(), "uploads");

export async function POST(req: NextRequest) {
  const guard = await requirePatient();
  if ("error" in guard) return guard.error;
  if (!guard.patient) {
    return NextResponse.json(
      { error: "Complete your medical profile before uploading documents." },
      { status: 409 },
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Attach a file to upload." }, { status: 400 });
  }
  const mime = file.type || "application/octet-stream";
  if (!ALLOWED[mime]) {
    return NextResponse.json(
      { error: "Unsupported file type. Upload a PDF, JPG, PNG or TXT document." },
      { status: 415 },
    );
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "Files must be between 1 byte and 8 MB." },
      { status: 413 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // Content sniff: verify magic bytes match the declared type (defense in depth)
  if (!magicMatches(mime, bytes)) {
    return NextResponse.json(
      { error: "The file contents do not match its type. Upload the original document file." },
      { status: 415 },
    );
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  const storedName = `${crypto.randomBytes(16).toString("hex")}${ALLOWED[mime]}`;
  const storagePath = path.join(UPLOAD_DIR, storedName);
  await writeFile(storagePath, bytes, { mode: 0o600 });

  const safeName = path.basename(file.name).slice(0, 140) || `document${ALLOWED[mime]}`;

  // Run extraction synchronously (documents are small); status records outcome.
  const isText = mime === "text/plain";
  const rawText = isText ? bytes.toString("utf8") : "";
  const result = isText
    ? await extractFromText(rawText)
    : await extractFromFile({ base64: bytes.toString("base64"), mediaType: mime });

  const doc = await db.document.create({
    data: {
      patientId: guard.patient.id,
      filename: safeName,
      kind: result.extraction?.documentType ?? "other",
      rawText,
      extraction: result.extraction ? (result.extraction as object) : undefined,
      extractedWith: result.status === "EXTRACTED" ? result.engine : null,
      fileType: mime,
      fileSize: file.size,
      storagePath: storedName, // relative name only; resolved server-side
      confidence: result.confidence,
      extractionStatus: result.status,
    },
  });

  audit({
    userId: guard.user.id,
    action: "portal.document_upload",
    resource: `document:${doc.id}`,
    detail: `${safeName} (${mime}, ${(file.size / 1024).toFixed(0)} KB) → ${result.status}`,
  });

  return NextResponse.json({
    documentId: doc.id,
    status: result.status,
    message: result.message,
  });
}

function magicMatches(mime: string, b: Buffer): boolean {
  if (mime === "application/pdf") return b.subarray(0, 5).toString("latin1") === "%PDF-";
  if (mime === "image/png")
    return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (mime === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8;
  if (mime === "text/plain") return !b.subarray(0, 1024).includes(0); // no NUL bytes
  return false;
}

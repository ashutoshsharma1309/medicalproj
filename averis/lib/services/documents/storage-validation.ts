/**
 * Upload validation and path construction.
 *
 * Deliberately free of `server-only` and of any Supabase import: these are the
 * rules that decide what is allowed into storage, so they are kept pure and
 * directly unit-testable. The I/O that uses them lives in storage-service.ts.
 */

export const DOCUMENTS_BUCKET = "medical-documents";
export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB

export const ALLOWED_MIME_TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;

export type AllowedMimeType = keyof typeof ALLOWED_MIME_TYPES;

export function isAllowedMimeType(value: string): value is AllowedMimeType {
  return value in ALLOWED_MIME_TYPES;
}

/** patients/{patientProfileId}/medical_documents/{uuid}.{ext} */
export function buildStoragePath(
  patientProfileId: string,
  mimeType: AllowedMimeType,
): string {
  const extension = ALLOWED_MIME_TYPES[mimeType];
  return `patients/${patientProfileId}/medical_documents/${crypto.randomUUID()}.${extension}`;
}

/**
 * Magic-byte check. The browser-supplied MIME type is a claim, not evidence —
 * this confirms the bytes actually are what they say they are.
 */
export function contentMatchesMimeType(
  bytes: Uint8Array,
  mimeType: AllowedMimeType,
): boolean {
  if (mimeType === "application/pdf") {
    // %PDF
    return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  }
  if (mimeType === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8;
  }
  return false;
}

export type FileValidationResult =
  | { ok: true; mimeType: AllowedMimeType }
  | { ok: false; error: string };

export function validateUpload(file: {
  size: number;
  type: string;
  bytes: Uint8Array;
}): FileValidationResult {
  if (!isAllowedMimeType(file.type)) {
    return { ok: false, error: "Upload a PDF, JPG or PNG document." };
  }
  if (file.size <= 0) {
    return { ok: false, error: "That file appears to be empty." };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: "Files must be 15 MB or smaller." };
  }
  if (!contentMatchesMimeType(file.bytes, file.type)) {
    return {
      ok: false,
      error: "The file contents do not match its type. Upload the original document.",
    };
  }
  return { ok: true, mimeType: file.type };
}

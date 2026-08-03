import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { DocumentProcessingError } from "./types";
import { DOCUMENTS_BUCKET } from "./storage-validation";

/**
 * Supabase Storage I/O for medical documents.
 *
 * The bucket is private. Nothing here ever returns a public URL — reads go
 * through short-lived signed URLs, and every path is derived from the caller's
 * own patient profile id. Storage RLS enforces the same rule server-side.
 *
 * The rules about *what may be uploaded* live in storage-validation.ts, which
 * stays free of server-only imports so they can be unit-tested.
 */

export * from "./storage-validation";

export async function uploadDocument(
  supabase: SupabaseClient<Database>,
  path: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<void> {
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(path, bytes, { contentType: mimeType, upsert: false });

  if (error) {
    throw new DocumentProcessingError(
      "We could not store your document. Please try again.",
      "storage",
      error,
    );
  }
}

export async function downloadDocument(
  supabase: SupabaseClient<Database>,
  path: string,
): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).download(path);
  if (error || !data) {
    throw new DocumentProcessingError(
      "We could not retrieve this document from storage.",
      "storage",
      error,
    );
  }
  return new Uint8Array(await data.arrayBuffer());
}

/** Short-lived read URL for the document viewer. */
export async function createSignedUrl(
  supabase: SupabaseClient<Database>,
  path: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  return error ? null : (data?.signedUrl ?? null);
}

export async function removeDocument(
  supabase: SupabaseClient<Database>,
  path: string,
): Promise<void> {
  await supabase.storage.from(DOCUMENTS_BUCKET).remove([path]);
}

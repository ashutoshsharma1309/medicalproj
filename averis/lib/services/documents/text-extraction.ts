import "server-only";
import { DocumentProcessingError, type ExtractedText } from "./types";

/**
 * Step 1 of the pipeline: get text out of the file.
 *
 * PDFs go through a text-layer parser. Images go through OCR, which is
 * pluggable — Tesseract runs anywhere with no external dependency, Google
 * Cloud Vision is available where GCP credentials are configured and gives
 * materially better results on photographed documents.
 *
 * Selected with OCR_PROVIDER=tesseract|google-vision (default: tesseract).
 */

export interface OcrProvider {
  readonly id: "ocr-tesseract" | "ocr-vision";
  recognize(bytes: Uint8Array, mimeType: string): Promise<{ text: string; confidence: number | null }>;
}

/* --------------------------------------------------------------- Tesseract */

const tesseractProvider: OcrProvider = {
  id: "ocr-tesseract",
  async recognize(bytes) {
    // Imported lazily: the WASM bundle and language data are large, and PDF
    // uploads must not pay for them.
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    try {
      const { data } = await worker.recognize(Buffer.from(bytes));
      return {
        text: data.text ?? "",
        // Tesseract reports 0–100; normalize to the 0–1 scale used throughout.
        confidence: typeof data.confidence === "number" ? data.confidence / 100 : null,
      };
    } finally {
      await worker.terminate();
    }
  },
};

/* ---------------------------------------------------------- Cloud Vision */

const visionProvider: OcrProvider = {
  id: "ocr-vision",
  async recognize(bytes) {
    const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
    if (!apiKey) {
      throw new DocumentProcessingError(
        "OCR_PROVIDER is google-vision but GOOGLE_CLOUD_VISION_API_KEY is not set.",
        "text-extraction",
      );
    }

    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              image: { content: Buffer.from(bytes).toString("base64") },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      throw new DocumentProcessingError(
        `Cloud Vision request failed (${response.status}).`,
        "text-extraction",
      );
    }

    const payload = (await response.json()) as {
      responses?: {
        fullTextAnnotation?: { text?: string };
        textAnnotations?: { description?: string }[];
      }[];
    };

    const first = payload.responses?.[0];
    const text =
      first?.fullTextAnnotation?.text ?? first?.textAnnotations?.[0]?.description ?? "";

    // Vision does not return a single document-level confidence.
    return { text, confidence: null };
  },
};

export function resolveOcrProvider(): OcrProvider {
  return process.env.OCR_PROVIDER === "google-vision" ? visionProvider : tesseractProvider;
}

/* --------------------------------------------------------------------- PDF */

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  // mergePages returns the whole document as a single string.
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/* ---------------------------------------------------------------- Dispatch */

/** Below this, a PDF is treated as a scan and pushed through OCR instead. */
const MIN_PDF_TEXT_LENGTH = 40;

export async function extractDocumentText(
  bytes: Uint8Array,
  mimeType: string,
): Promise<ExtractedText> {
  try {
    if (mimeType === "application/pdf") {
      const text = (await extractPdfText(bytes)).trim();

      // A scanned PDF has pages but no text layer. Rather than hand the model
      // an empty string, fall through to OCR.
      if (text.length >= MIN_PDF_TEXT_LENGTH) {
        return { text, source: "pdf-text", ocrConfidence: null };
      }

      const provider = resolveOcrProvider();
      const ocr = await provider.recognize(bytes, mimeType);
      return {
        text: ocr.text.trim(),
        source: provider.id,
        ocrConfidence: ocr.confidence,
      };
    }

    if (mimeType === "image/jpeg" || mimeType === "image/png") {
      const provider = resolveOcrProvider();
      const ocr = await provider.recognize(bytes, mimeType);
      return {
        text: ocr.text.trim(),
        source: provider.id,
        ocrConfidence: ocr.confidence,
      };
    }

    throw new DocumentProcessingError(
      `Unsupported document type: ${mimeType}`,
      "text-extraction",
    );
  } catch (error) {
    if (error instanceof DocumentProcessingError) throw error;
    throw new DocumentProcessingError(
      "We could not read text from this document.",
      "text-extraction",
      error,
    );
  }
}

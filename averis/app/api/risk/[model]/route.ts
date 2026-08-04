import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { assessRisk, persistPrediction } from "@/lib/ml/risk-service";
import { isRiskModel, riskInputSchema } from "@/lib/ml/validation";
import { topContributions } from "@/lib/ml/predict";

/**
 * POST /api/risk/diabetes
 * POST /api/risk/cardiovascular
 *
 * Scores the signed-in patient against one model and stores the result.
 *
 * The route takes **no patient identifier**. It derives one from the session,
 * which is the only design that makes cross-patient access impossible rather
 * than merely forbidden: there is no parameter an attacker could tamper with,
 * so there is nothing for an authorization check to get wrong.
 *
 * The optional body supplies values the patient's records do not contain —
 * a blood pressure they know but have not uploaded, say. Every field is
 * validated against the plausible range the model was trained under.
 */

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ model: string }> },
) {
  const { model } = await context.params;

  if (!isRiskModel(model)) {
    return NextResponse.json(
      { error: "Unknown risk model.", supported: ["diabetes", "cardiovascular"] },
      { status: 404 },
    );
  }

  const account = await requireUser();
  if (!account.patientProfileId) {
    return NextResponse.json(
      { error: "Complete your health profile before requesting a risk assessment." },
      { status: 409 },
    );
  }

  let overrides: Record<string, number> = {};
  const raw = await request.text();

  if (raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }

    const result = riskInputSchema(model).safeParse(parsed);
    if (!result.success) {
      return NextResponse.json(
        {
          error: "Some values are outside the range this model accepts.",
          // Field-level messages so a patient can fix the one that is wrong,
          // rather than being told the whole submission failed.
          issues: result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 422 },
      );
    }

    overrides = Object.fromEntries(
      Object.entries(result.data as Record<string, number | undefined>).filter(
        ([, value]) => value !== undefined,
      ),
    ) as Record<string, number>;
  }

  const supabase = await createClient();

  try {
    const assessment = await assessRisk(supabase, account.patientProfileId, model, overrides);

    // Storing must not lose the patient their result. If the write fails they
    // still get the assessment; only the history entry is missing.
    let stored = true;
    try {
      await persistPrediction(supabase, account.patientProfileId, assessment);
    } catch {
      stored = false;
    }

    const { prediction, explanation } = assessment;

    return NextResponse.json({
      model: prediction.model,
      modelVersion: prediction.modelVersion,
      riskScore: Number(prediction.riskScore.toFixed(4)),
      category: prediction.category,
      confidence: Number(prediction.confidence.toFixed(3)),
      confidenceReason: prediction.confidenceReason,
      explanation: {
        narrative: explanation.narrative,
        awareness: explanation.awareness,
        generatedBy: explanation.model,
      },
      contributions: topContributions(prediction, 6).map((c) => ({
        feature: c.name,
        label: c.label,
        value: c.value,
        unit: c.unit,
        imputed: c.imputed,
        share: Number(c.share.toFixed(4)),
        direction: c.direction,
      })),
      modelPerformance: assessment.metrics,
      dataset: assessment.dataset,
      // Never optional in the response. A client cannot render the score
      // without also receiving the sentence that qualifies it.
      disclaimer: prediction.disclaimer,
      stored,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Risk assessment failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

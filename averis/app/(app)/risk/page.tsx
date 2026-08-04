import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { assessAllRisks } from "@/lib/ml/risk-service";
import { loadArtifact } from "@/lib/ml/artifact";
import { topContributions } from "@/lib/ml/predict";
import { CATEGORY_LABEL } from "@/lib/ml/categories";
import { Card, CardHeader, Callout, ButtonLink } from "@/components/ui";
import type { RiskModel } from "@/lib/ml/types";
import { RiskGauge } from "./RiskGauge";
import { ContributionChart } from "./ContributionChart";

export const metadata = { title: "Risk Intelligence" };
export const dynamic = "force-dynamic";

const TITLES: Record<RiskModel, string> = {
  diabetes: "Diabetes risk",
  cardiovascular: "Cardiovascular risk",
};

export default async function RiskIntelligencePage() {
  const account = await requireUser();
  if (!account.patientProfileId) redirect("/onboarding");

  const supabase = await createClient();
  const assessments = await assessAllRisks(supabase, account.patientProfileId);
  const models = Object.keys(assessments) as RiskModel[];

  const anyMeasured = models.some((m) =>
    assessments[m].prediction.inputs.some((i) => !i.imputed),
  );

  return (
    <div className="space-y-7">
      <header>
        <p className="eyebrow">AVERIS Risk Intelligence</p>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight">
          What the models see in your record
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          Two statistical models, trained on public research datasets, scored against the
          information you have confirmed. These are awareness signals — not a diagnosis, and not
          a prediction of what will happen to you.
        </p>
      </header>

      {!anyMeasured && (
        <Callout tone="notice" title="These estimates are not yet about you">
          None of the model inputs could be read from your records, so both figures below are
          population averages. Add a recent lab report and they will start reflecting your own
          measurements.{" "}
          <Link href="/records" className="font-semibold underline underline-offset-2">
            Add a document
          </Link>
        </Callout>
      )}

      {/* ------------------------------------------------- 1. Risk overview */}
      <div className="grid gap-5 md:grid-cols-2">
        {models.map((model) => {
          const { prediction } = assessments[model];
          return (
            <Card key={model}>
              <CardHeader eyebrow="Risk overview" title={TITLES[model]} />
              <div className="px-6 py-5">
                <RiskGauge
                  percent={Math.round(prediction.riskScore * 100)}
                  category={prediction.category}
                  categoryLabel={CATEGORY_LABEL[prediction.category]}
                  confidence={prediction.confidence}
                />
              </div>
            </Card>
          );
        })}
      </div>

      {/* ------------------- 2. Explanation, per model, and 3. awareness */}
      {models.map((model) => {
        const assessment = assessments[model];
        const { prediction, explanation, metrics, dataset } = assessment;
        const artifact = loadArtifact(model);

        return (
          <Card key={`${model}-detail`}>
            <CardHeader
              eyebrow="Explanation"
              title={`Why AVERIS estimated ${TITLES[model].toLowerCase()} at ${Math.round(
                prediction.riskScore * 100,
              )}%`}
            />

            <div className="border-b border-rule px-6 py-5">
              <p className="max-w-3xl text-[15px] leading-relaxed">{explanation.narrative}</p>
              <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted">
                {explanation.fallback
                  ? "Assembled directly from the model output — AI narration unavailable"
                  : `Phrased by ${explanation.model} from figures the model computed`}
                {explanation.guardrailTriggered && " · adjusted to remove clinical interpretation"}
              </p>
            </div>

            <div className="border-b border-rule">
              <p className="px-6 pt-5 eyebrow">Feature contributions (SHAP)</p>
              <ContributionChart contributions={topContributions(prediction, 6)} />
              <p className="px-6 pb-5 text-[12.5px] leading-relaxed text-muted">
                These are exact Shapley values, not estimates. They sum to the distance between
                the model&rsquo;s baseline and your score, so the bars above account for the
                figure completely.
              </p>
            </div>

            <div className="border-b border-rule px-6 py-5">
              <p className="eyebrow mb-2.5">Worth knowing</p>
              <ul className="space-y-2">
                {explanation.awareness.map((point, i) => (
                  <li key={i} className="flex gap-2.5 text-[14px] leading-relaxed text-ink-soft">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-faint" aria-hidden="true" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* ------------------------------------- model card / provenance */}
            <div className="px-6 py-5">
              <p className="eyebrow mb-3">About this model</p>

              <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
                <Stat label="Algorithm" value="Logistic regression" />
                <Stat label="Version" value={prediction.modelVersion} mono />
                <Stat label="ROC-AUC" value={metrics.roc_auc.toFixed(3)} mono />
                <Stat label="Recall" value={metrics.recall.toFixed(3)} mono />
              </dl>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[440px] text-[13px]">
                  <thead>
                    <tr className="border-b border-rule text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                      <th className="pb-2 font-normal">Family compared</th>
                      <th className="pb-2 text-right font-normal">ROC-AUC</th>
                      <th className="pb-2 text-right font-normal">Recall</th>
                      <th className="pb-2 text-right font-normal">F1</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(artifact.metrics).map(([family, m]) => (
                      <tr key={family} className="border-b border-rule last:border-0">
                        <td className="py-1.5">
                          {family.replace(/_/g, " ")}
                          {family === artifact.served_algorithm && (
                            <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-brand">
                              serving
                            </span>
                          )}
                        </td>
                        <td className="mono py-1.5 text-right">{m.roc_auc.toFixed(3)}</td>
                        <td className="mono py-1.5 text-right">{m.recall.toFixed(3)}</td>
                        <td className="mono py-1.5 text-right">{m.f1_score.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="mt-4 text-[13px] leading-relaxed text-muted">
                Trained on <strong>{dataset.name}</strong> ({dataset.rows} rows) — {dataset.cohort}.{" "}
                {dataset.caveat}
              </p>
            </div>
          </Card>
        );
      })}

      {/* ---------------------------------------------------- 4. next steps */}
      <Card>
        <CardHeader eyebrow="Improve these estimates" title="What would make these yours" />
        <div className="px-6 py-5">
          <p className="max-w-3xl text-[14.5px] leading-relaxed text-ink-soft">
            Every input AVERIS cannot read from your records is replaced with a population
            average, and each substitution moves the figure toward the cohort and away from you.
            Adding a recent lab report is the single fastest way to change that.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <ButtonLink href="/records">Add a document</ButtonLink>
            <Link
              href="/twin"
              className="btn btn-ghost"
            >
              View your Health Twin
            </Link>
          </div>
        </div>
      </Card>

      <p className="pb-2 text-[13px] leading-relaxed text-muted">
        {assessments[models[0]].prediction.disclaimer}
      </p>
    </div>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted">{label}</dt>
      <dd className={`mt-1 text-[14px] font-medium${mono ? " mono" : ""}`}>{value}</dd>
    </div>
  );
}

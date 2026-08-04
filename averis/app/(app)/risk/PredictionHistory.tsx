import { formatDate } from "@/lib/utils/format";
import type { StoredPrediction } from "@/lib/ml/risk-service";

/**
 * Past assessments.
 *
 * The point of keeping history is that a patient can see whether a figure is
 * moving, which is far more meaningful than any single score. A model version
 * is shown against every row, because a change in the number can mean the
 * patient changed *or* the model did, and those are not the same news.
 */
export function PredictionHistory({ predictions }: { predictions: StoredPrediction[] }) {
  if (predictions.length === 0) {
    return (
      <p className="px-6 py-8 text-center text-[14px] text-muted">
        Assessments are saved automatically. Once you have more than one, the change over time
        will show here.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto px-6 py-5">
      <table className="w-full min-w-[420px] text-[13.5px]">
        <thead>
          <tr className="border-b border-rule text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            <th className="pb-2 font-normal">Assessed</th>
            <th className="pb-2 font-normal">Model</th>
            <th className="pb-2 text-right font-normal">Estimate</th>
            <th className="pb-2 text-right font-normal">Confidence</th>
            <th className="pb-2 text-right font-normal">Version</th>
          </tr>
        </thead>
        <tbody>
          {predictions.map((prediction) => (
            <tr key={prediction.id} className="border-b border-rule last:border-0">
              <td className="mono py-2 text-[12.5px]">{formatDate(prediction.createdAt)}</td>
              <td className="py-2">{prediction.predictionType.toLowerCase()}</td>
              <td className="mono py-2 text-right">
                {Math.round(prediction.riskScore * 100)}%
              </td>
              <td className="mono py-2 text-right text-muted">
                {prediction.confidenceScore === null
                  ? "—"
                  : `${Math.round(prediction.confidenceScore * 100)}%`}
              </td>
              <td className="mono py-2 text-right text-muted">{prediction.modelVersion}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

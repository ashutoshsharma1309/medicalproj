import type { ReactNode } from "react";
import { CareBridgeAssessmentProvider } from "@/lib/carebridge/assessment-context";
import { CareBridgeShell } from "@/components/carebridge/CareBridgeShell";

export default function AssessmentLayout({ children }: { children: ReactNode }) {
  return (
    <CareBridgeAssessmentProvider>
      <CareBridgeShell wide>{children}</CareBridgeShell>
    </CareBridgeAssessmentProvider>
  );
}

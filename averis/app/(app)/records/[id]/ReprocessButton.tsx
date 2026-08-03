"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Callout } from "@/components/ui";
import { reprocessDocumentAction } from "../actions";

export function ReprocessButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await reprocessDocumentAction(documentId);
            if (result.error) {
              setError(result.error);
              return;
            }
            router.push(`/records/${documentId}/review`);
            router.refresh();
          })
        }
      >
        {pending ? "Reading again…" : "Try reading it again"}
      </Button>
      {error && <Callout tone="critical">{error}</Callout>}
    </div>
  );
}

"use client";

import { useEffect } from "react";
import { useCareBridgeAssessment } from "@/lib/carebridge/assessment-context";
import { ChatWindow } from "@/components/carebridge/ChatWindow";
import { ChatInput } from "@/components/carebridge/ChatInput";
import { QuickReply } from "@/components/carebridge/QuickReply";
import { AssessmentProgress } from "@/components/carebridge/AssessmentProgress";
import { PrimaryButton } from "@/components/carebridge/PrimaryButton";
import { LoadingState } from "@/components/carebridge/LoadingState";
import { IconChevronRight } from "@/components/carebridge/icons";

export default function AssessmentInterviewPage() {
  const {
    messages,
    isTyping,
    isComplete,
    sendReply,
    startInterview,
    currentQuickReplies,
    currentPlaceholder,
    progress,
    progressPercent,
    isHydrated,
  } = useCareBridgeAssessment();

  useEffect(() => {
    startInterview();
  }, [startInterview]);

  if (!isHydrated) return <LoadingState message="Loading your assessment…" />;

  return (
    <div>
      <div className="mb-4 md:hidden">
        <AssessmentProgress compact progress={progress} percent={progressPercent} />
      </div>

      <div className="grid gap-6 md:grid-cols-[1fr_300px]">
        <section className="cb-card flex h-[68vh] min-h-[420px] flex-col p-4 sm:p-5">
          <div className="min-h-0 flex-1">
            <ChatWindow messages={messages} isTyping={isTyping} />
          </div>

          <div className="mt-3 space-y-3 border-t border-cb-border pt-3">
            {isComplete ? (
              <PrimaryButton href="/assessment/result" icon={<IconChevronRight />} className="cb-btn-block">
                View my result
              </PrimaryButton>
            ) : (
              <>
                {currentQuickReplies && (
                  <QuickReply options={currentQuickReplies} onSelect={sendReply} disabled={isTyping} />
                )}
                <ChatInput
                  onSend={sendReply}
                  disabled={isTyping}
                  placeholder={currentPlaceholder ?? "Type your message…"}
                />
              </>
            )}
          </div>
        </section>

        <aside className="hidden md:block">
          <AssessmentProgress progress={progress} percent={progressPercent} />
        </aside>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage as ChatMessageT } from "@/lib/carebridge/types";
import { ChatMessage } from "./ChatMessage";
import { TypingIndicator } from "./TypingIndicator";

export function ChatWindow({
  messages,
  isTyping,
}: {
  messages: ChatMessageT[];
  isTyping: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, isTyping]);

  return (
    <div
      role="log"
      aria-label="Health interview conversation"
      aria-live="polite"
      className="flex h-full flex-col gap-4 overflow-y-auto px-1 py-2"
    >
      {messages.length === 0 ? (
        <p className="px-1 text-sm text-cb-muted">Starting your health assessment…</p>
      ) : (
        messages.map((m) => <ChatMessage key={m.id} message={m} />)
      )}
      {isTyping && <TypingIndicator />}
      <div ref={endRef} />
    </div>
  );
}

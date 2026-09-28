"use client";

import { useState, type FormEvent } from "react";
import { IconSend } from "./icons";

export function ChatInput({
  onSend,
  disabled,
  placeholder = "Type your message…",
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2">
      <label htmlFor="cb-chat-input" className="sr-only">
        Message CareBridge
      </label>
      <input
        id="cb-chat-input"
        className="cb-field"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
      />
      <button
        type="submit"
        className="cb-btn cb-btn-primary shrink-0"
        disabled={disabled || value.trim().length === 0}
        aria-label="Send message"
      >
        <IconSend />
        <span className="hidden sm:inline">Send</span>
      </button>
    </form>
  );
}

export function TypingIndicator() {
  return (
    <div className="flex items-start" aria-live="polite">
      <div className="cb-bubble cb-bubble-assistant flex items-center gap-1.5 py-3.5">
        <span className="sr-only">CareBridge is typing a reply</span>
        <span className="cb-typing-dot" aria-hidden />
        <span className="cb-typing-dot" aria-hidden />
        <span className="cb-typing-dot" aria-hidden />
      </div>
    </div>
  );
}

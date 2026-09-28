import type { ChatMessage as ChatMessageT } from "@/lib/carebridge/types";

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function ChatMessage({ message }: { message: ChatMessageT }) {
  const isPatient = message.role === "patient";
  return (
    <div className={`flex flex-col ${isPatient ? "items-end" : "items-start"}`}>
      <div className={`cb-bubble ${isPatient ? "cb-bubble-user" : "cb-bubble-assistant"}`}>
        {message.text}
      </div>
      <time
        dateTime={message.at}
        className="mt-1 px-1 text-[11px] text-cb-faint"
      >
        {isPatient ? "You" : "CareBridge"} · {formatTime(message.at)}
      </time>
    </div>
  );
}

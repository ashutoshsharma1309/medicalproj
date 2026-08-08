"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { routeVoiceCommand, VOICE_EXAMPLES } from "@/lib/care/voice";

/**
 * Speaking to AVERIS.
 *
 * **No audio leaves the device.** Recognition runs in the browser through the
 * Web Speech API; AVERIS receives the transcript, not the sound. A health
 * platform that streams a microphone to a server has acquired a recording of a
 * patient's home, and that is not a trade worth making for better accuracy.
 *
 * The transcript is filled into the question box rather than sent silently.
 * Speech recognition mishears — a system that acts on a misheard sentence
 * without showing it is one that will eventually answer a question nobody
 * asked, and in this product the answer is about someone's health.
 *
 * Commands ("show critical patients") navigate instead of asking, because the
 * answer to those is a screen.
 *
 * Unsupported browsers render nothing at all rather than a button that does
 * nothing. Firefox has no Web Speech API, and a dead microphone icon is worse
 * than an absent one.
 */

type Recognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function VoiceButton({
  audience,
  onTranscript,
}: {
  audience: "CLINICIAN" | "PATIENT";
  onTranscript: (question: string) => void;
}) {
  const router = useRouter();
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const recognitionRef = useRef<Recognition | null>(null);

  // Checked in an effect, not during render: `window` does not exist on the
  // server, and a component that renders differently on each would hydrate
  // with a mismatch.
  useEffect(() => {
    setSupported(recognitionConstructor() !== null);
    return () => recognitionRef.current?.stop();
  }, []);

  if (!supported) return null;

  const listen = () => {
    const Constructor = recognitionConstructor();
    if (!Constructor) return;

    const recognition = new Constructor();
    recognitionRef.current = recognition;

    recognition.lang = navigator.language || "en-GB";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript ?? "";
      const route = routeVoiceCommand(transcript);

      if (route.kind === "NAVIGATE") {
        setStatus(route.spoken);
        router.push(route.href);
        return;
      }

      if (route.kind === "UNCLEAR") {
        // Shown, not guessed at. The transcript is included so the speaker can
        // see what was heard rather than wondering why nothing happened.
        setStatus(
          transcript
            ? `Heard “${transcript}”, which AVERIS could not turn into a question.`
            : "Nothing was picked up.",
        );
        return;
      }

      setStatus(null);
      onTranscript(route.question);
    };

    recognition.onerror = (event) => {
      setStatus(
        event.error === "not-allowed"
          ? "Microphone access was refused. You can type the question instead."
          : "Could not hear that. Try again, or type the question.",
      );
      setListening(false);
    };

    recognition.onend = () => setListening(false);

    setStatus(null);
    setListening(true);
    recognition.start();
  };

  return (
    <div className="sm:w-auto">
      <button
        type="button"
        onClick={listening ? () => recognitionRef.current?.stop() : listen}
        aria-pressed={listening}
        className="btn btn-ghost w-full sm:w-auto"
        title={`For example: ${VOICE_EXAMPLES[audience][0]}`}
      >
        {listening ? "Listening… tap to stop" : "🎙 Speak"}
      </button>

      {status && (
        <p className="mt-1 text-[12px] leading-relaxed text-muted" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

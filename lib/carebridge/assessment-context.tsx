"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AssessmentSetup, ChatMessage, ResultStatus } from "./types";
import { EMPTY_SETUP, computeMockStatus, computeProgress, progressPercent, computeMockFindings } from "./mock/assessment";
import { INTERVIEW_CLOSING_MESSAGE, INTERVIEW_STEPS, INTERVIEW_TYPING_DELAY_MS } from "./mock/conversation";

const STORAGE_KEY = "carebridge:assessment:v1";

type PersistedState = {
  setup: AssessmentSetup;
  messages: ChatMessage[];
  answers: Record<number, string>;
  currentStep: number;
  isComplete: boolean;
};

const INITIAL_STATE: PersistedState = {
  setup: EMPTY_SETUP,
  messages: [],
  answers: {},
  currentStep: 0,
  isComplete: false,
};

type AssessmentContextValue = {
  setup: AssessmentSetup;
  updateSetup: (patch: Partial<AssessmentSetup>) => void;
  messages: ChatMessage[];
  isTyping: boolean;
  isComplete: boolean;
  currentStep: number;
  totalSteps: number;
  currentQuickReplies: string[] | undefined;
  currentPlaceholder: string | undefined;
  startInterview: () => void;
  sendReply: (text: string) => void;
  progressPercent: number;
  progress: ReturnType<typeof computeProgress>;
  resultStatus: ResultStatus;
  resultStatusOverride: ResultStatus | null;
  setResultStatusOverride: (status: ResultStatus | null) => void;
  findings: ReturnType<typeof computeMockFindings>;
  hasAssessment: boolean;
  resetAssessment: () => void;
  isHydrated: boolean;
};

const AssessmentContext = createContext<AssessmentContextValue | null>(null);

function makeMessage(role: ChatMessage["role"], text: string): ChatMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    at: new Date().toISOString(),
  };
}

export function CareBridgeAssessmentProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PersistedState>(INITIAL_STATE);
  const [isTyping, setIsTyping] = useState(false);
  const [resultStatusOverride, setResultStatusOverride] = useState<ResultStatus | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);

  // Load any in-progress assessment from this browser (client-only — safe for SSR).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setState(JSON.parse(raw) as PersistedState);
    } catch {
      /* corrupted or inaccessible storage — start fresh */
    } finally {
      setIsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* private browsing / storage full — assessment still works for this tab */
    }
  }, [state, isHydrated]);

  const updateSetup = useCallback((patch: Partial<AssessmentSetup>) => {
    setState((s) => ({ ...s, setup: { ...s.setup, ...patch } }));
  }, []);

  const startInterview = useCallback(() => {
    setState((s) => {
      if (s.messages.length > 0) return s; // already started
      return { ...s, messages: [makeMessage("assistant", INTERVIEW_STEPS[0].assistant)] };
    });
  }, []);

  const sendReply = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setState((s) => {
      if (s.isComplete) return s;
      const stepIndex = s.currentStep;
      const withReply = {
        ...s,
        messages: [...s.messages, makeMessage("patient", trimmed)],
        answers: { ...s.answers, [stepIndex]: trimmed },
      };
      return withReply;
    });

    setIsTyping(true);
    window.setTimeout(() => {
      setState((s) => {
        const nextStep = s.currentStep + 1;
        const nextAssistantText =
          nextStep < INTERVIEW_STEPS.length ? INTERVIEW_STEPS[nextStep].assistant : INTERVIEW_CLOSING_MESSAGE;
        const done = nextStep >= INTERVIEW_STEPS.length;
        return {
          ...s,
          currentStep: nextStep,
          isComplete: done,
          messages: [...s.messages, makeMessage("assistant", nextAssistantText)],
        };
      });
      setIsTyping(false);
    }, INTERVIEW_TYPING_DELAY_MS);
  }, []);

  const resetAssessment = useCallback(() => {
    setState(INITIAL_STATE);
    setResultStatusOverride(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const progress = useMemo(() => computeProgress(state.answers), [state.answers]);
  const findings = useMemo(() => computeMockFindings(state.answers), [state.answers]);
  const computedStatus = useMemo(() => computeMockStatus(state.answers), [state.answers]);

  const value: AssessmentContextValue = {
    setup: state.setup,
    updateSetup,
    messages: state.messages,
    isTyping,
    isComplete: state.isComplete,
    currentStep: state.currentStep,
    totalSteps: INTERVIEW_STEPS.length,
    currentQuickReplies: INTERVIEW_STEPS[state.currentStep]?.quickReplies,
    currentPlaceholder: INTERVIEW_STEPS[state.currentStep]?.placeholder,
    startInterview,
    sendReply,
    progressPercent: progressPercent(progress),
    progress,
    resultStatus: resultStatusOverride ?? computedStatus,
    resultStatusOverride,
    setResultStatusOverride,
    findings,
    hasAssessment: state.isComplete,
    resetAssessment,
    isHydrated,
  };

  return <AssessmentContext.Provider value={value}>{children}</AssessmentContext.Provider>;
}

export function useCareBridgeAssessment() {
  const ctx = useContext(AssessmentContext);
  if (!ctx) {
    throw new Error("useCareBridgeAssessment must be used within a CareBridgeAssessmentProvider");
  }
  return ctx;
}

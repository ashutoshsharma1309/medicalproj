/**
 * Structured logging.
 *
 * One line of JSON per event, because a healthcare platform's logs are read by
 * a log aggregator during an incident, not by a person scrolling a terminal.
 *
 * The redaction below is the part that matters. A log line is the easiest way
 * for patient health information to escape a system that is otherwise careful
 * with it: it gets shipped to a third-party aggregator, retained for months,
 * indexed, and read by engineers who have no clinical relationship with anyone
 * in it. So this module refuses to serialise the fields most likely to carry
 * it, and truncates free text rather than trusting callers to have thought
 * about the question.
 *
 * The rule for call sites is simpler than the rule for this file: log
 * identifiers and outcomes, never content.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? "").toLowerCase() as LogLevel;
  if (configured in LEVEL_ORDER) return LEVEL_ORDER[configured];
  return process.env.NODE_ENV === "production" ? LEVEL_ORDER.info : LEVEL_ORDER.debug;
}

/**
 * Keys whose values are never logged, whatever they contain.
 *
 * Matched case-insensitively against the whole key, so `patientEmail` and
 * `patient_email` are both caught.
 */
const FORBIDDEN_KEY = new RegExp(
  [
    "password",
    "secret",
    "token",
    "apikey",
    "api_key",
    "authorization",
    "cookie",
    "email",
    "phone",
    "address",
    "dob",
    "dateofbirth",
    "date_of_birth",
    "fullname",
    "full_name",
    // Clinical content. An identifier for a document is fine; its text is not.
    "extractedtext",
    "extracted_text",
    "content",
    "body",
    "question",
    "answer",
    "response",
    "narrative",
    "summary",
    "diagnosis",
    "condition",
    "medication",
    "allergy",
    "embedding",
  ].join("|"),
  "i",
);

/** Free text is truncated even when its key is allowed. */
const MAX_STRING = 200;

export type LogFields = Record<string, unknown>;

export function redact(fields: LogFields): LogFields {
  const safe: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEY.test(key)) {
      safe[key] = "[redacted]";
      continue;
    }
    safe[key] = redactValue(value, 0);
  }

  return safe;
}

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;

  // Deep objects in logs are almost always an accident — someone passed a
  // whole row. Collapse rather than serialise it.
  if (depth > 3) return "[deep]";

  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (value instanceof Error) {
    return { name: value.name, message: value.message.slice(0, MAX_STRING) };
  }

  if (Array.isArray(value)) {
    // Length is the useful part; the elements rarely are.
    return value.length > 10
      ? { length: value.length, sample: value.slice(0, 3).map((v) => redactValue(v, depth + 1)) }
      : value.map((v) => redactValue(v, depth + 1));
  }

  if (typeof value === "object") {
    const out: LogFields = {};
    for (const [key, nested] of Object.entries(value as LogFields)) {
      out[key] = FORBIDDEN_KEY.test(key) ? "[redacted]" : redactValue(nested, depth + 1);
    }
    return out;
  }

  return "[unserialisable]";
}

export type LogEvent = {
  level: LogLevel;
  msg: string;
  time: string;
  service: string;
} & LogFields;

/** Injectable so tests can capture output instead of writing to stdout. */
export type Sink = (event: LogEvent) => void;

let sink: Sink = (event) => {
  const line = JSON.stringify(event);
  if (event.level === "error" || event.level === "warn") console.error(line);
  else console.log(line);
};

export function setSink(next: Sink): void {
  sink = next;
}

export function buildEvent(
  level: LogLevel,
  msg: string,
  fields: LogFields,
  now: string,
): LogEvent {
  return {
    level,
    msg,
    time: now,
    service: process.env.SERVICE_NAME ?? "averis-web",
    ...redact(fields),
  };
}

function emit(level: LogLevel, msg: string, fields: LogFields = {}): void {
  if (LEVEL_ORDER[level] < threshold()) return;
  sink(buildEvent(level, msg, fields, new Date().toISOString()));
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};

/**
 * Times an operation and logs the outcome.
 *
 * Latency and failure rate for every external call — the model provider, OCR,
 * the database — come from this one helper, so adding a new integration
 * cannot quietly ship without instrumentation.
 */
export async function timed<T>(
  operation: string,
  fields: LogFields,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();

  try {
    const result = await run();
    log.info(`${operation} ok`, { ...fields, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    log.error(`${operation} failed`, {
      ...fields,
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}

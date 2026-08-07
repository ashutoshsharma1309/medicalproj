import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Device credentials.
 *
 * Pure and dependency-free, so the token format and hashing are testable
 * without a database — and so the FastAPI service and the Next.js app can be
 * checked against the same expectations.
 *
 * **Why a token and not a password.** An ESP32 has no user, no browser and no
 * way to complete an OAuth flow. It authenticates as itself with a credential
 * provisioned once, at registration. That credential is the only thing
 * standing between the fleet and someone writing fabricated vital signs into a
 * patient's chart, so it is generated from a CSPRNG and never chosen by a
 * human.
 *
 * **Why SHA-256 and not bcrypt.** Password hashes are deliberately slow
 * because passwords are low-entropy and guessable. A 256-bit random token is
 * not guessable — there is no dictionary to run — so the slow KDF buys
 * nothing while costing real latency on a path that runs once every two
 * seconds per device. What matters here is that the stored form is
 * irreversible, which a single SHA-256 over a high-entropy secret already is.
 */

/** 32 bytes of entropy, base64url-encoded. */
const TOKEN_BYTES = 32;

/** Prefix, so a leaked string is recognisable in a log or a paste. */
const TOKEN_PREFIX = "avd_";

export type IssuedToken = {
  /** Shown to the patient exactly once. Never stored. */
  token: string;
  /** What goes in the database. */
  tokenHash: string;
};

export function issueDeviceToken(): IssuedToken {
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  return { token, tokenHash: hashDeviceToken(token) };
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Shape check before hashing.
 *
 * Rejects obvious rubbish without touching the database, so a flood of
 * malformed requests cannot turn into a flood of queries.
 */
export function isWellFormedToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    token.startsWith(TOKEN_PREFIX) &&
    token.length >= TOKEN_PREFIX.length + 40 &&
    token.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(token.slice(TOKEN_PREFIX.length))
  );
}

/**
 * Constant-time comparison of two hashes.
 *
 * The lookup itself is by indexed equality, so this is for the cases where two
 * hashes are compared in application code. `===` on a secret leaks its prefix
 * through timing; the cost of avoiding that is one function call.
 */
export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * The device key a patient sees and the firmware announces.
 *
 * Distinct from the token: the key is an identifier and appears in logs and
 * payloads, while the token is a secret. Conflating them is how device
 * identifiers end up being treated as credentials.
 */
export function normalizeDeviceKey(raw: string): string {
  return raw.trim().toUpperCase();
}

const DEVICE_KEY_PATTERN = /^[A-Z0-9_-]{3,64}$/;

export function isValidDeviceKey(raw: string): boolean {
  return DEVICE_KEY_PATTERN.test(normalizeDeviceKey(raw));
}

/** Suggests the next key in the AVR001 series for a patient's fleet. */
export function suggestDeviceKey(existingKeys: string[]): string {
  const used = new Set(existingKeys.map(normalizeDeviceKey));

  for (let n = 1; n <= 999; n += 1) {
    const candidate = `AVR${String(n).padStart(3, "0")}`;
    if (!used.has(candidate)) return candidate;
  }

  // Past the series, fall back to something that cannot collide.
  return `AVR-${randomBytes(4).toString("hex").toUpperCase()}`;
}

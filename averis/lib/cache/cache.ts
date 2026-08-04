/**
 * Caching.
 *
 * A driver interface with an in-process default and a Redis driver used when
 * `REDIS_URL` is set. Same code path either way, so the single-instance
 * behaviour is not a separate branch that only gets exercised in development.
 *
 * **What may be cached, and what may not.**
 *
 * Caching in a healthcare product is where correctness and privacy fail
 * together, and the failure is always the same shape: a key that is not
 * specific enough to one patient. A cache key of `summary` serves Ananya's
 * health summary to Rahul, and nothing errors — he simply reads a plausible
 * summary of someone else's health.
 *
 * So this module refuses to store anything under a key that does not carry a
 * subject, and `patientKey` is the only supported way to build one. That turns
 * "remember to include the patient id" from a convention into a check.
 *
 * Derived, regenerable things are cached: embeddings of the knowledge base,
 * model artifacts, the deterministic parts of a summary. Authorization
 * decisions are not — a cached "yes" outlives the revocation that should have
 * changed it.
 */

export type CacheEntry<T> = { value: T; expiresAt: number };

export type CacheDriver = {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Removes every key under a prefix. Used when a patient's data changes. */
  deletePrefix(prefix: string): Promise<void>;
};

/** Namespaces. A key must start with one of these. */
export const CACHE_NAMESPACES = [
  "embedding", // query embeddings — content-addressed, no subject needed
  "knowledge", // shared reference corpus — identical for every patient
  "summary", // per-patient derived text
  "twin", // per-patient assembled twin
  "risk", // per-patient risk assessment
] as const;

export type CacheNamespace = (typeof CACHE_NAMESPACES)[number];

/** Namespaces holding nothing patient-specific, so a bare key is legitimate. */
const SHARED_NAMESPACES = new Set<CacheNamespace>(["embedding", "knowledge"]);

/**
 * Builds a per-patient key.
 *
 * The only way to key patient-scoped data. Callers cannot forget the subject
 * because there is no other function that produces a valid one.
 */
export function patientKey(
  namespace: Exclude<CacheNamespace, "embedding" | "knowledge">,
  patientId: string,
  suffix?: string,
): string {
  if (!patientId) throw new Error("A patient-scoped cache key requires a patient id.");
  return suffix
    ? `${namespace}:${patientId}:${suffix}`
    : `${namespace}:${patientId}`;
}

export function sharedKey(namespace: "embedding" | "knowledge", digest: string): string {
  return `${namespace}:${digest}`;
}

/**
 * Rejects a key that would serve one patient's data to another.
 *
 * A patient-scoped namespace with no second segment is the exact mistake this
 * exists to catch, and it is one that would otherwise look fine in review and
 * in testing with a single account.
 */
export function assertSafeKey(key: string): void {
  const [namespace, subject] = key.split(":");

  if (!CACHE_NAMESPACES.includes(namespace as CacheNamespace)) {
    throw new Error(`Cache key "${key}" does not start with a known namespace.`);
  }

  if (SHARED_NAMESPACES.has(namespace as CacheNamespace)) return;

  if (!subject) {
    throw new Error(
      `Cache key "${key}" is patient-scoped but carries no subject — it would ` +
        `serve one patient's data to another.`,
    );
  }
}

/* --------------------------------------------------------------- memory */

export function memoryDriver(maxEntries = 5000): CacheDriver {
  const store = new Map<string, CacheEntry<unknown>>();

  const prune = () => {
    const now = Date.now();
    for (const [key, entry] of store) if (entry.expiresAt <= now) store.delete(key);

    // Still over budget after expiry: drop oldest-inserted first. Map
    // preserves insertion order, which is a good enough approximation of LRU
    // for a cache whose entries are all cheap to recompute.
    if (store.size > maxEntries) {
      const excess = store.size - maxEntries;
      let dropped = 0;
      for (const key of store.keys()) {
        store.delete(key);
        if (++dropped >= excess) break;
      }
    }
  };

  return {
    async get<T>(key: string): Promise<T | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value as T;
    },

    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      assertSafeKey(key);
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      if (store.size > maxEntries) prune();
    },

    async delete(key: string): Promise<void> {
      store.delete(key);
    },

    async deletePrefix(prefix: string): Promise<void> {
      for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
    },
  };
}

/* ---------------------------------------------------------------- facade */

let driver: CacheDriver | null = null;

export function setCacheDriver(next: CacheDriver): void {
  driver = next;
}

export function getCacheDriver(): CacheDriver {
  driver ??= memoryDriver();
  return driver;
}

/**
 * Read-through helper.
 *
 * A miss recomputes and stores; a cache failure falls through to the
 * computation rather than propagating. A cache that can take the site down
 * when it misbehaves is a liability, not an optimisation.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  assertSafeKey(key);
  const cache = getCacheDriver();

  try {
    const hit = await cache.get<T>(key);
    if (hit !== null) return hit;
  } catch {
    /* a broken cache must not break the request */
  }

  const value = await compute();

  try {
    await cache.set(key, value, ttlSeconds);
  } catch {
    /* likewise on write */
  }

  return value;
}

/** Invalidates everything derived for one patient. */
export async function invalidatePatient(patientId: string): Promise<void> {
  const cache = getCacheDriver();
  await Promise.all(
    (["summary", "twin", "risk"] as const).map((ns) =>
      cache.deletePrefix(`${ns}:${patientId}`),
    ),
  );
}

/** Stable digest for content-addressed keys, so identical text shares an entry. */
export function digest(text: string): string {
  // FNV-1a. Not cryptographic — this only needs to spread keys evenly, and a
  // collision costs a wrong cache hit on shared, non-patient content.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}-${text.length}`;
}

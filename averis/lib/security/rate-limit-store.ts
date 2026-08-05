import "server-only";

import { memoryCounterStore, type CounterStore, type WindowCounts } from "./rate-limit";
import { getCacheDriver } from "@/lib/cache/cache";

/**
 * Counter storage for the rate limiter.
 *
 * Backed by the cache driver, so it is Redis when `REDIS_URL` is set and
 * in-process otherwise. That distinction matters more here than for caching: a
 * per-instance rate limiter multiplies every published limit by the number of
 * running instances, so "20 questions an hour" quietly becomes 60 across three
 * containers — and it loosens exactly as traffic grows.
 *
 * The counters live under the `summary` namespace with a synthetic subject,
 * because the cache refuses patient-scoped keys without one. Rate limit
 * counters carry no health data — only a subject identifier and two integers.
 */

const NAMESPACE = "summary";
const TTL_PADDING = 1.2;

/** Bare Redis keys are rejected by assertSafeKey, so they are namespaced. */
function storageKey(key: string): string {
  return `${NAMESPACE}:ratelimit:${key}`;
}

export function rateLimitStore(): CounterStore {
  const cache = getCacheDriver();

  return {
    async read(key) {
      try {
        return await cache.get<WindowCounts>(storageKey(key));
      } catch {
        // A limiter that throws when its store is unavailable would take down
        // the endpoints it protects. Failing open is the lesser harm: the
        // limiter guards cost, and RLS still guards data.
        return null;
      }
    },

    async write(key, counts, ttlMs) {
      try {
        await cache.set(storageKey(key), counts, Math.ceil((ttlMs / 1000) * TTL_PADDING));
      } catch {
        /* see read() */
      }
    },
  };
}

/** In-process store, for tests that must not touch the shared driver. */
export const testCounterStore = memoryCounterStore;

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { memoryDriver, setCacheDriver } from "../cache";
import {
  TTL_SECONDS,
  cachedForSubject,
  invalidateForPatient,
  isCacheable,
} from "../patient-cache";

const ANANYA = "patient-ananya";
const RAHUL = "patient-rahul";
const DOCTOR = null; // a clinician has no patient profile id

beforeEach(() => {
  setCacheDriver(memoryDriver());
});

/** A compute function that records how often it actually ran. */
function counted<T>(value: T) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fn: async () => {
      calls += 1;
      return value;
    },
  };
}

describe("the viewer must be the subject", () => {
  it("serves a patient their own twin from cache on the second read", async () => {
    const compute = counted({ conditions: ["asthma"] });

    await cachedForSubject("twin", ANANYA, ANANYA, compute.fn);
    await cachedForSubject("twin", ANANYA, ANANYA, compute.fn);

    assert.equal(compute.calls, 1);
  });

  it("never caches for a clinician", async () => {
    const compute = counted({ conditions: ["asthma"] });

    await cachedForSubject("twin", ANANYA, DOCTOR, compute.fn);
    await cachedForSubject("twin", ANANYA, DOCTOR, compute.fn);
    await cachedForSubject("twin", ANANYA, DOCTOR, compute.fn);

    // Every read hits the database, and therefore Row Level Security. A
    // clinician's caseload is a handful of reads per shift; being current
    // matters more there than being fast.
    assert.equal(compute.calls, 3);
  });

  it("does not let one patient's cached view serve another's read", async () => {
    // The bug this module exists to prevent, stated as a test.
    //
    // Ananya reads her own twin and it is cached. Rahul — a caregiver on her
    // care team, whose RLS grant is narrower — then reads it. If the cache
    // answered, he would receive the assembly built under *her* permissions.
    const ananyasView = counted({ owner: "ananya", documents: 12 });
    await cachedForSubject("twin", ANANYA, ANANYA, ananyasView.fn);

    const rahulsView = counted({ owner: "ananya", documents: 3 });
    const seen = await cachedForSubject("twin", ANANYA, RAHUL, rahulsView.fn);

    assert.equal(rahulsView.calls, 1, "Rahul's read was served from Ananya's cache");
    assert.deepEqual(seen, { owner: "ananya", documents: 3 });
  });

  it("keeps two patients' own caches separate", async () => {
    await cachedForSubject("summary", ANANYA, ANANYA, async () => "ananya's summary");
    const rahuls = await cachedForSubject("summary", RAHUL, RAHUL, async () => "rahul's summary");

    assert.equal(rahuls, "rahul's summary");
  });

  it("exposes the rule for diagnostics", () => {
    assert.equal(isCacheable(ANANYA, ANANYA), true);
    assert.equal(isCacheable(ANANYA, RAHUL), false);
    assert.equal(isCacheable(ANANYA, null), false);
  });
});

describe("invalidation", () => {
  it("clears every derived namespace, not just the one that changed", async () => {
    const twin = counted("twin v1");
    const summary = counted("summary v1");
    const risk = counted("risk v1");

    await cachedForSubject("twin", ANANYA, ANANYA, twin.fn);
    await cachedForSubject("summary", ANANYA, ANANYA, summary.fn);
    await cachedForSubject("risk", ANANYA, ANANYA, risk.fn);

    // A document upload changes the twin, and the summary is written from the
    // twin, and the risk assessment reads conditions the document confirmed.
    // Reasoning about which of those to clear is how one of them gets missed.
    await invalidateForPatient(ANANYA);

    await cachedForSubject("twin", ANANYA, ANANYA, twin.fn);
    await cachedForSubject("summary", ANANYA, ANANYA, summary.fn);
    await cachedForSubject("risk", ANANYA, ANANYA, risk.fn);

    assert.equal(twin.calls, 2);
    assert.equal(summary.calls, 2);
    assert.equal(risk.calls, 2);
  });

  it("does not clear another patient", async () => {
    const rahul = counted("rahul's twin");
    await cachedForSubject("twin", RAHUL, RAHUL, rahul.fn);

    await invalidateForPatient(ANANYA);

    await cachedForSubject("twin", RAHUL, RAHUL, rahul.fn);
    assert.equal(rahul.calls, 1);
  });
});

describe("time to live", () => {
  it("keeps every window short enough to be a backstop, not a source of truth", () => {
    // These cache a patient's picture of their own health. An hour-long TTL
    // would mean a reading taken this morning is invisible this afternoon.
    for (const [namespace, ttl] of Object.entries(TTL_SECONDS)) {
      assert.ok(ttl <= 300, `${namespace} is cached for ${ttl}s, which is too long`);
      assert.ok(ttl >= 30, `${namespace} is cached for ${ttl}s, which will never hit`);
    }
  });

  it("expires the risk assessment soonest", () => {
    // It moves with incoming vitals; the twin moves when somebody uploads a
    // document, and that upload invalidates explicitly.
    assert.ok(TTL_SECONDS.risk < TTL_SECONDS.summary);
    assert.ok(TTL_SECONDS.summary < TTL_SECONDS.twin);
  });
});

describe("a broken cache must not break the page", () => {
  it("falls through to the computation when the driver throws", async () => {
    setCacheDriver({
      async get() {
        throw new Error("redis is down");
      },
      async set() {
        throw new Error("redis is down");
      },
      async delete() {},
      async deletePrefix() {},
    });

    const compute = counted("computed anyway");
    const value = await cachedForSubject("twin", ANANYA, ANANYA, compute.fn);

    // A cache that can take the health twin down when Redis restarts is a
    // liability, not an optimisation.
    assert.equal(value, "computed anyway");
    assert.equal(compute.calls, 1);
  });
});

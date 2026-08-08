#!/usr/bin/env node
/**
 * Dependency audit gate.
 *
 *   node scripts/audit-gate.mjs
 *
 * ── Why this exists instead of `npm audit --audit-level=high` ──────────────
 *
 * Because that command fails forever.
 *
 * AVERIS depends on `sharp` (through Next's image optimiser and through
 * `@huggingface/transformers`) and on `adm-zip` (through `onnxruntime-node`).
 * Both carry high advisories with **no fix available at any version**. A gate
 * that fails on every high advisory therefore fails every build from now until
 * upstream ships a release — and a gate that always fails is one people delete,
 * or route around with `|| true`, which is worse than not having it. The
 * failure stops meaning anything, and the *next* advisory — the one that does
 * matter — arrives into a pipeline nobody reads.
 *
 * So the gate is:
 *
 *   · **any critical advisory fails the build.** No allowlist, no exceptions.
 *   · **a high advisory fails the build unless it is named below**, with a
 *     reason and an assessment of the actual exposure.
 *   · **a moderate or low advisory is printed and does not block.**
 *
 * The consequence that makes this honest: a *new* high advisory in a package
 * not on the list fails the build. The list is short, specific, and every entry
 * had to be argued for. It is not `--audit-level=critical` wearing a costume.
 *
 * ── Reviewing the list ─────────────────────────────────────────────────────
 *
 * Each entry states why the advisory is not reachable in this deployment. Those
 * arguments expire: a future feature that starts resizing user-uploaded images
 * makes the `sharp` entry wrong. Re-read them when the code around them
 * changes, and delete an entry the moment a fix ships.
 */

import { execSync } from "node:child_process";

/**
 * High advisories that do not block.
 *
 * `until` is a review date, not an expiry — the gate does not enforce it,
 * because a build that starts failing on a date nobody remembers setting is the
 * same broken gate in a different costume. It fails *loudly in the output*
 * instead, which is what gets it looked at.
 */
const ALLOWED_HIGH = [
  {
    package: "sharp",
    advisory: "GHSA-f88m-g3jw-g9cj",
    until: "2026-11-01",
    reason:
      "Inherited libvips CVEs. No fixed release exists. Reached only through Next's image " +
      "optimiser, and AVERIS serves no user-supplied images — every image in the app is a " +
      "static asset committed to the repository. A patient cannot put bytes through libvips. " +
      "This argument stops holding the day the app accepts an image upload.",
  },
  {
    package: "adm-zip",
    advisory: "GHSA-crafted-zip-4gb",
    until: "2026-11-01",
    reason:
      "Zip decompression bomb. No fixed release. Reached only through onnxruntime-node, which " +
      "unpacks model archives that ship inside our own container image and are never fetched " +
      "at runtime. The untrusted input this advisory concerns does not exist on this path.",
  },
  {
    package: "onnxruntime-node",
    advisory: "transitive:adm-zip",
    until: "2026-11-01",
    reason: "Reported only because it depends on adm-zip. Same assessment as above.",
  },
  {
    package: "@huggingface/transformers",
    advisory: "transitive:sharp+onnxruntime-node",
    until: "2026-11-01",
    reason: "Reported only for its transitive dependencies. Same assessment as above.",
  },
];

function audit() {
  try {
    // npm audit exits non-zero when it finds anything, so the failure is
    // expected and the JSON on stdout is what we want either way.
    return JSON.parse(execSync("npm audit --json", { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  } catch (error) {
    if (error.stdout) return JSON.parse(error.stdout);
    console.error("Could not run `npm audit`:", error.message);
    process.exit(1);
  }
}

const report = audit();
const vulnerabilities = report.vulnerabilities ?? {};
const counts = report.metadata?.vulnerabilities ?? {};

const allowed = new Map(ALLOWED_HIGH.map((entry) => [entry.package, entry]));

const blocking = [];
const excused = [];

for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
  const severity = vulnerability.severity;

  if (severity === "critical") {
    // Never excusable. If a critical advisory is genuinely unreachable, the
    // argument belongs in a code change that removes the dependency, not in a
    // list that makes the build green.
    blocking.push({ name, severity, note: "critical advisories are never allowlisted" });
    continue;
  }

  if (severity !== "high") continue;

  const excuse = allowed.get(name);
  if (excuse) {
    excused.push({ name, ...excuse, fixAvailable: vulnerability.fixAvailable });
  } else {
    blocking.push({
      name,
      severity,
      note: vulnerability.fixAvailable
        ? "a fix is available — run `npm audit fix`"
        : "no fix available — assess the exposure and add it to ALLOWED_HIGH with a reason, or remove the dependency",
    });
  }
}

console.log(
  `\nnpm audit: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ` +
    `${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low\n`,
);

if (excused.length > 0) {
  console.log("Known and accepted (each blocks the build once a fix exists elsewhere):\n");
  for (const entry of excused) {
    console.log(`  ${entry.package}  [review by ${entry.until}]`);
    console.log(`    ${entry.reason}\n`);

    // The one case where an allowlist entry is actively wrong: upstream shipped
    // a fix and the entry is now excusing a problem that could simply be fixed.
    if (entry.fixAvailable) {
      blocking.push({
        name: entry.package,
        severity: "high",
        note: "a fix is now available — remove it from ALLOWED_HIGH and upgrade",
      });
    }
  }

  const stale = excused.filter((e) => e.until < new Date().toISOString().slice(0, 10));
  if (stale.length > 0) {
    console.log(
      `::warning::${stale.length} allowlist entr${stale.length === 1 ? "y is" : "ies are"} past ` +
        `review: ${stale.map((e) => e.package).join(", ")}. Re-read the reasoning; upstream may have shipped a fix.\n`,
    );
  }
}

if (blocking.length === 0) {
  console.log("No blocking advisories.\n");
  process.exit(0);
}

console.error("Blocking advisories:\n");
for (const entry of blocking) {
  console.error(`  ${entry.name} (${entry.severity}) — ${entry.note}`);
}
console.error(
  "\nThis gate blocks on every critical advisory and on any high advisory not argued for in\n" +
    "scripts/audit-gate.mjs. Fix it, or add an entry stating why it is not reachable here.\n",
);
process.exit(1);

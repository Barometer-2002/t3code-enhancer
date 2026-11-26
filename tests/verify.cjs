"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readAsar, validateEsmSyntax } = require("../lib/asar.cjs");
const { ALL_PATCHES, getPatchTargets, resolvePatchTarget, resolvePristineBaseline, buildPatchedArchive } = require("../cli.cjs");
const timelineCollapse = require("../lib/patches/timeline-collapse.cjs");
const usageRings = require("../lib/patches/usage-rings.cjs");
const { SOURCE_THEME_PATH } = require("../lib/theme-manager.cjs");

console.log("1. Validating bundled theme JSON...");
const themeRaw = fs.readFileSync(SOURCE_THEME_PATH, "utf8");
const theme = JSON.parse(themeRaw);
assert.equal(theme.name, "ChatGPT App");
assert(theme.css.length > 1000 && theme.css.length < 100000, `Unexpected CSS length: ${theme.css.length}`);
assert(theme.css.includes("non-scaling-stroke"), "Missing unified icon non-scaling-stroke rule");
assert(!theme.css.includes("-webkit-mask-image"), "Should not contain heavy icon mask overrides");
console.log("   OK (css chars:", theme.css.length + ")");

console.log("2. Unit testing timeline-collapse cascade logic...");
const before = [
  { kind: "turn-fold", id: "turn-fold:r1", runId: "r1", expanded: true },
  { kind: "attempt-fold", id: "attempt-fold:a1", attemptId: "a1", expanded: true },
  { kind: "work-toggle", id: "wt1", groupId: "wg1", expanded: true },
  { kind: "work", id: "wg1:details", isExpandedToolGroup: true, groupedEntries: [{ id: "e1" }, { id: "e2" }] },
  { kind: "event", id: "ev1" },
  { kind: "turn-fold", id: "turn-fold:r2", runId: "r2", expanded: true },
  { kind: "work-toggle", id: "wt2", groupId: "wg2", expanded: true },
  { kind: "work", id: "wg2:details", isExpandedToolGroup: true, groupedEntries: [{ id: "e3" }] },
];
const after = [
  { kind: "turn-fold", id: "turn-fold:r1", runId: "r1", expanded: false },
  { kind: "turn-fold", id: "turn-fold:r2", runId: "r2", expanded: true },
  { kind: "work-toggle", id: "wt2", groupId: "wg2", expanded: true },
  { kind: "work", id: "wg2:details", isExpandedToolGroup: true, groupedEntries: [{ id: "e3" }] },
];
const state = {
  scrollPositions: new Map([["wg1:details", 40], ["wg2:details", 90]]),
  expandedEntries: new Set(["e1", "e2", "subagent-group:ev1", "e3"]),
};
const diff = timelineCollapse.resetHiddenDisclosures(before, after, state);
assert.deepEqual([...diff.hiddenAttempts], ["a1"]);
assert.deepEqual([...diff.hiddenGroups], ["wg1"]);
assert.equal(state.scrollPositions.has("wg1:details"), false);
assert.equal(state.scrollPositions.has("wg2:details"), true);
assert.equal(state.expandedEntries.has("e1"), false);
assert.equal(state.expandedEntries.has("subagent-group:ev1"), false);
assert.equal(state.expandedEntries.has("e3"), true);
console.log("   OK");

console.log("3. Unit testing usage-rings 5h/7d pairing logic...");
const paired1 = usageRings.t3PairUsageWindows([
  { id: "cg-5h", label: "Claude & GPT (shared)", resetsAt: "2026-11-23T05:00:00Z" },
  { id: "gem-5h", label: "Gemini · 5-hour", resetsAt: "2026-11-23T05:00:00Z" },
  { id: "cg-7d", label: "Claude & GPT (shared)", resetsAt: "2026-11-29T00:00:00Z" },
  { id: "argon", label: "Gemini 4 Argon · 5-hour", resetsAt: "2026-11-23T05:00:00Z" },
  { id: "gem-7d", label: "Gemini · Weekly", resetsAt: "2026-11-29T00:00:00Z" },
]);
assert.equal(paired1.length, 3);
assert.equal(paired1[0].kind, "dual");
assert.equal(paired1[0].shortWindow.id, "cg-5h");
assert.equal(paired1[0].longWindow.id, "cg-7d");
assert.equal(paired1[1].kind, "dual");
assert.equal(paired1[1].title, "Gemini");
assert.equal(paired1[1].shortWindow.id, "gem-5h");
assert.equal(paired1[1].longWindow.id, "gem-7d");
assert.equal(paired1[2].kind, "single");
assert.equal(paired1[2].window.id, "argon");

const paired2 = usageRings.t3PairUsageWindows([
  { id: "s", label: "Session" },
  { id: "w", label: "Weekly" },
]);
assert.equal(paired2.length, 1);
assert.equal(paired2[0].kind, "dual");
assert.equal(paired2[0].shortWindow.id, "s");
assert.equal(paired2[0].longWindow.id, "w");

// Active-model quota matching across multi-model independent pools
assert.equal(usageRings.t3SelectPrimaryQuotaForModel(paired1, "gemini-4-neon").title, "Gemini");
assert.equal(usageRings.t3SelectPrimaryQuotaForModel(paired1, "gemini-4-argon").window.id, "argon");
assert.equal(usageRings.t3SelectPrimaryQuotaForModel(paired1, "claude-opus-5-5").title, "Claude & GPT (shared)");
assert.equal(usageRings.t3SelectPrimaryQuotaForModel(paired1, "gpt-oss-120b").title, "Claude & GPT (shared)");
assert.equal(usageRings.t3SelectPrimaryQuotaForModel(paired2, "gpt-6.2-sol").key, "s:w");
console.log("   OK");

console.log("3b. Validating multi-version targets & runtime module syntax (0.1.11 + 0.1.12)...");
for (const patch of ALL_PATCHES) {
  const versions = getPatchTargets(patch).map((t) => t.version);
  assert(versions.includes("0.1.11") && versions.includes("0.1.12"), `${patch.id} missing 0.1.11 or 0.1.12 target`);
}
for (const [ver, syms] of [["0.1.11", usageRings.SYMBOLS_0111], ["0.1.12", usageRings.SYMBOLS_0112]]) {
  const mod = usageRings.buildRuntimeModule(syms);
  assert(mod.includes(usageRings.marker), `Missing marker in runtime module for ${ver}`);
  assert(!/\.\.\.undefined|\bundefined\s*\(/.test(mod), `Unexpected undefined interpolation in ${ver} runtime module`);
  validateEsmSyntax(Buffer.from(mod, "utf8"), `usage-rings runtime (${ver})`);
}
console.log("   OK");

console.log("4. Full dry-run ASAR build (timeline-collapse + usage-rings) + syntax & integrity check...");
const source = process.argv[2] || (
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "t3code", "resources", "server.asar")
);
assert(source, "请提供原版 ASAR：node tests/verify.cjs <app.asar>");
const baseline = resolvePristineBaseline({
  source,
  backup: source + ".before-t3code-enhancer",
  legacyBackup: source + ".before-timeline-collapse",
});
const tmpOut = path.join(os.tmpdir(), `t3code-enhancer-test-${Date.now()}.asar`);
try {
  const report = buildPatchedArchive(baseline.asar, ALL_PATCHES, tmpOut);
  const verified = readAsar(tmpOut);
  for (const p of ALL_PATCHES) {
    const resolved = resolvePatchTarget(verified, p);
    assert(resolved.installed, `Marker missing for ${p.id}`);
    assert(resolved.entry.content.toString("utf8").includes(p.marker), `Marker missing for ${p.id}`);
  }
  console.log(`   OK [v${baseline.detectedVersion || "unknown"}] -> built & verified:`, report.map((r) => `${r.id}(${r.patched.slice(0, 10)})`).join(", "));
} finally {
  if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
}

console.log("\nALL TESTS PASSED.");

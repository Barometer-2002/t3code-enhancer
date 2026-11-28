"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { runInNewContext, createContext, runInContext } = require("node:vm");

const { readAsar, readEntryBuffer, findUniqueEntry, getAsarAppVersion, writePatchedAsar, validateScriptSyntax, digest } = require("../lib/asar.cjs");
const { verifyInjectedScope, findPatchTarget, createPatchContext, resolveRelativeKey } = require("../lib/resolver.cjs");
const { collectTopLevelBindings, findUndeclaredIdentifiers, tokenize, parseImports } = require("../lib/js-ast.cjs");
const { ALL_PATCHES, selectPatches, applicablePatchesForArchive, inspectArchive, summarizeModuleStates, resolvePristineBaseline, buildPatchedArchive, getLinuxAsarCandidates, getAsarPaths, getArchiveTargetPaths, isLinuxAppRunning, parseCliArgs, buildDelegatedArgs, isThemeOnlySelection, shouldDelegateToLinux, shouldDelegateToMacos, isMacosBundleAsarPath, resolveCanonicalPath, assertSafeAsarTargets, runAsarTransaction, matchesSelectedPatches, getArchiveCompatibilityTier, cmdInstall, cmdRepair, cmdUninstall } = require("../cli.cjs");
const { PACKS, PRESETS, resolveInstallPlan, parsePlatformArgs } = require("../lib/packs.cjs");
const { withInstallDirectoryLock } = require("../lib/install-state.cjs");
const { inspectCompatibleSource, inferRepairPlanOptions, getSavedPlanPath, readSavedInstallPlan } = require("../lib/engine.cjs");
const { packRelease } = require("../scripts/pack-release.cjs");
const { validateReleaseReadiness } = require("../scripts/publish-release.cjs");
const noTelemetry = require("../lib/patches/no-telemetry.cjs");
const desktopTray = require("../lib/patches/desktop-tray.cjs");
const newChatLayout = require("../lib/patches/new-chat-layout.cjs");
const sidebarNewChat = require("../lib/patches/sidebar-new-chat.cjs");
const linuxCli = require("../linux.cjs");
const macosCli = require("../macos.cjs");
const timelineCollapse = require("../lib/patches/timeline-collapse.cjs");
const usageRings = require("../lib/patches/usage-rings.cjs");
const inlineFileDiff = require("../lib/patches/inline-file-diff.cjs");
const filesChangesExplorer = require("../lib/patches/files-changes-explorer.cjs");
const workspaceFloatingPanels = require("../lib/patches/workspace-floating-panels.cjs");
const { workspaceFloatFrame, workspaceSnapFrame, defaultChatFloatFrame, defaultPreviewFloatFrame, serializePreviewFloatFrame, restorePreviewFloatFrame, chatPillFrame, placeSurfaceFloat } = workspaceFloatingPanels;
const { SOURCE_THEME_PATH, extractOfficialTheme, installThemeAt, prepareThemeTransaction, uninstallTheme, getThemeStatus } = require("../lib/theme-manager.cjs");

// Runtime modules under lib/runtime are plain ESM without imports. Load them the way the
// ASAR does (as a standalone script) so tests exercise the real shipped source, and hand
// back the exports plus the sandbox so tests can stub or spy on module-level helpers.
function loadRuntimeModule(name, globals = {}) {
  const file = path.join(__dirname, "..", "lib", "runtime", name + ".mjs");
  const src = fs.readFileSync(file, "utf8");
  assert(!/^\s*import\s/m.test(src), `${name}.mjs must stay import-free`);
  const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+([\w$]+)/gm)].map((m) => m[1]);
  const sandbox = { ...globals };
  runInNewContext(src.replace(/^export\s+/gm, "") + "\nthis.__t3exports = { " + names.join(", ") + " };", sandbox, { filename: file });
  return { exports: sandbox.__t3exports, sandbox };
}

function entryText(asar, rec) {
  const offset = Number(rec.entry.offset);
  return asar.body.toString("utf8", offset, offset + rec.entry.size);
}

// Resolve a patched host chunk together with every external t3e-*.js runtime asset it imports.
function hostWithRuntime(asar, patch, label) {
  const entry = findUniqueEntry(asar, patch.targetRegex, label || patch.id);
  const text = entry.content.toString("utf8");
  const assets = [];
  for (const [, name] of text.matchAll(/from\s*"\.\/(t3e-[\w.-]+\.js)"/g)) {
    const key = path.posix.join(path.posix.dirname(entry.key), name);
    if (assets.some((asset) => asset.key === key)) continue;
    const rec = asar.byKey.get(key);
    assert(rec, `Host ${entry.key} imports missing runtime asset ${key}`);
    assets.push({ key, text: entryText(asar, rec) });
  }
  return { key: entry.key, text, assets, combined: [text, ...assets.map((asset) => asset.text)].join("\n") };
}

const BROWSER_GLOBALS = [
  "window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "IntersectionObserver",
  "MutationObserver", "CustomEvent", "Event", "EventTarget", "HTMLElement", "Element", "Node", "getComputedStyle", "localStorage",
  "sessionStorage", "crypto", "performance", "queueMicrotask", "matchMedia", "DOMRect", "KeyboardEvent", "PointerEvent", "MouseEvent",
  "AbortController", "fetch", "URL", "URLSearchParams", "structuredClone", "Intl", "console", "Symbol", "WeakMap", "WeakSet", "setTimeout",
  "clearTimeout", "setInterval", "clearInterval",
];

// Every external runtime asset must be a content-hashed, byte-exact copy of lib/runtime/*.mjs, valid ESM, self-contained
// (zero minified host identifiers) and resolvable from every host chunk that imports it.
function verifyRuntimeAssets(asar, expectedNames = []) {
  const found = new Set();
  const assetDir = "apps/server/dist/client/assets/";
  for (const rec of asar.entries) {
    if (!rec.key.startsWith(assetDir) || rec.key.includes("/", assetDir.length) || !rec.key.endsWith(".js")) continue;
    const base = rec.key.slice(assetDir.length);
    if (base.startsWith("t3e-")) {
      const match = /^t3e-([\w-]+)-([0-9a-f]{8})\.js$/.exec(base);
      assert(match, `Unexpected runtime asset name: ${rec.key}`);
      const text = entryText(asar, rec);
      assert.equal(match[2], digest(Buffer.from(text, "utf8")).slice(0, 8), `${rec.key} must carry its content hash`);
      assert.equal(text, fs.readFileSync(path.join(__dirname, "..", "lib", "runtime", match[1] + ".mjs"), "utf8"), `${rec.key} must ship lib/runtime/${match[1]}.mjs byte-for-byte`);
      assert(!/^\s*import\s/m.test(text) && !/\bfrom\s*"\.\//.test(text), `${rec.key} must be self-contained`);
      assert(/^export\s/m.test(text), `${rec.key} must be an ES module with exports`);
      validateScriptSyntax(Buffer.from(text, "utf8"), rec.key, rec.key);
      const leaks = findUndeclaredIdentifiers(text, collectTopLevelBindings(text), BROWSER_GLOBALS);
      assert.equal(leaks.length, 0, `${rec.key} leaks undeclared host identifiers: ${[...leaks].join(", ")}`);
      found.add(match[1]);
      continue;
    }
    const offset = Number(rec.entry.offset);
    if (!asar.body.subarray(offset, offset + rec.entry.size).includes("./t3e-")) continue;
    for (const [, name] of entryText(asar, rec).matchAll(/from\s*"\.\/(t3e-[\w.-]+\.js)"/g)) {
      assert(asar.byKey.has(assetDir + name), `${rec.key} imports missing runtime asset ${name}`);
    }
  }
  for (const name of expectedNames) assert(found.has(name), `Missing external runtime asset for ${name}`);
  return found;
}

console.log("1. Validating bundled theme JSON & 3-layer separation...");
const themeRaw = fs.readFileSync(SOURCE_THEME_PATH, "utf8");
const theme = JSON.parse(themeRaw);
assert.equal(theme.name, "ChatGPT App");
assert(theme.css.length > 1000 && theme.css.length < 100000, `Unexpected CSS length: ${theme.css.length}`);
assert(theme.css.includes("non-scaling-stroke"), "Missing unified icon non-scaling-stroke rule");
assert(!theme.css.includes("-webkit-mask-image"), "Should not contain heavy icon mask overrides");
const l1 = theme.css.indexOf("/* === LAYER 1:");
const l2 = theme.css.indexOf("/* === LAYER 2:");
const l3 = theme.css.indexOf("/* === LAYER 3:");
assert(l1 >= 0 && l2 > l1 && l3 > l2, "Theme CSS must maintain strict LAYER 1 -> LAYER 2 -> LAYER 3 separation");
const officialTheme = extractOfficialTheme(theme);
for (const forbidden of ["[data-work-entry-id]", "[data-tool-group-scroll]", "[data-right-panel-", "[data-changed-files-", "[data-testid=", ".t3e-"]) {
  assert(!officialTheme.css.includes(forbidden), `Layer 1 official theme must not contain non-official selector: ${forbidden}`);
}
assert(
  theme.css.includes(':root:not(.wco) [data-t3e-workspace]:has(> [data-chat-column] > [data-chat-header].drag-region, > [data-preview-panel-mode="inline"] [data-right-panel-tabbar].drag-region) > [data-chat-column]:not([data-t3e-chat-floating="true"], [data-t3e-chat-expanded]) > [data-chat-header].drag-region,'),
  "macOS drag-region override must exclude floating and expanded chat headers"
);
assert(
  theme.css.includes(':root:not(.wco) [data-t3e-workspace] [data-preview-panel-mode="inline"] [data-right-panel-tabbar].drag-region [data-active-tab] {\n    -webkit-app-region: no-drag;\n  }'),
  "macOS tabbar drag-region must keep workspace tabs no-drag for click and tear-off"
);
assert.deepEqual(
  findUndeclaredIdentifiers("function first(){let alias=1} function second(){return alias}", new Set()),
  ["alias"],
  "findUndeclaredIdentifiers must isolate declarations per function scope"
);
assert.deepEqual(
  findUndeclaredIdentifiers("function outer(){{const secret=1}return secret}", new Set()),
  ["secret"],
  "findUndeclaredIdentifiers must isolate let/const declarations per block scope"
);
assert.deepEqual(
  findUndeclaredIdentifiers("const f=a=>a;const g=()=>a;", new Set()),
  ["a"],
  "findUndeclaredIdentifiers must isolate arrow parameters"
);
assert.deepEqual(
  findUndeclaredIdentifiers("function ok(){let x=1;return ()=>x}", new Set()),
  []
);
console.log("   OK (total css:", theme.css.length, "chars | official layer:", officialTheme.css.length, "chars)");

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
  expandedEntries: new Set(["e1", "e1:file-fold", "e2", "subagent-group:ev1", "e3"]),
};
const diff = timelineCollapse.resetHiddenDisclosures(before, after, state);
assert.deepEqual([...diff.hiddenAttempts], ["a1"]);
assert.deepEqual([...diff.hiddenGroups], ["wg1"]);
assert.equal(state.scrollPositions.has("wg1:details"), false);
assert.equal(state.scrollPositions.has("wg2:details"), true);
assert.equal(state.expandedEntries.has("e1"), false);
assert.equal(state.expandedEntries.has("e1:file-fold"), false);
assert.equal(state.expandedEntries.has("subagent-group:ev1"), false);
assert.equal(state.expandedEntries.has("e3"), true);

const sampleEntries = [
  { id: "t0", itemType: "reasoning", detail: "think" },
  { id: "r1", itemType: "dynamic_tool", action: "read", structuredPayload: { type: "dynamic_tool", input: { Path: "C:\\proj\\src\\a.ts", StartLine: 1, EndLine: 100 } } },
  { id: "r2", itemType: "dynamic_tool", action: "read", structuredPayload: { type: "dynamic_tool", input: { path: "src/b.ts", StartLine: 1, EndLine: 50 } } },
  { id: "r3", itemType: "dynamic_tool", action: "read", structuredPayload: { type: "dynamic_tool", input: { Path: "src/a.ts", StartLine: 101, EndLine: 200 } } },
  { id: "r4", itemType: "dynamic_tool", action: "read", structuredPayload: { type: "dynamic_tool", input: { file_path: "./src/a.ts", StartLine: 201, EndLine: 300 } } },
  { id: "e1", itemType: "file_change", action: "edit", changedFiles: ["src\\a.ts"] },
  { id: "e2", itemType: "file_change", action: "edit", changedFiles: ["src/a.ts"] },
  { id: "e3", itemType: "file_change", action: "edit", changedFiles: ["src/a.ts", "src/b.ts"] },
];
const grouped = timelineCollapse.groupSameFileEntries(sampleEntries, "C:\\proj", {
  resolveRelPath: (p, root) => p.replaceAll("\\", "/").replace(/^c:\/proj\//i, ""),
});
assert.equal(grouped.length, 6, "Only adjacent same-file operations fold; interleaved events stay in chronological order");
assert.equal(grouped[0].type, "single");
assert.equal(grouped[0].entry.id, "t0");
assert.equal(grouped[1].type, "single");
assert.equal(grouped[1].entry.id, "r1");
assert.equal(grouped[2].type, "single");
assert.equal(grouped[2].entry.id, "r2");
assert.equal(grouped[3].type, "file-group");
assert.equal(grouped[3].kind, "read");
assert.equal(grouped[3].filePath, "src/a.ts");
assert.deepEqual(grouped[3].entries.map((x) => x.id), ["r3", "r4"]);
assert.equal(grouped[4].type, "file-group");
assert.equal(grouped[4].kind, "edit");
assert.deepEqual(grouped[4].entries.map((x) => x.id), ["e1", "e2"]);
assert.equal(grouped[5].type, "single");
assert.equal(grouped[5].entry.id, "e3");
assert.equal(timelineCollapse.t3FormatReadRanges(grouped[3].entries), "L101-200, L201-300");
const interleavedWithFailure = timelineCollapse.groupSameFileEntries([
  { id: "a1", itemType: "file_change", action: "edit", changedFiles: ["a.ts"] },
  { id: "f1", itemType: "file_change", action: "edit", changedFiles: ["a.ts"], status: "failed" },
  { id: "a2", itemType: "file_change", action: "edit", changedFiles: ["a.ts"] },
], "", { isEntryFailed: (x) => x.status === "failed" });
assert.deepEqual(interleavedWithFailure.map((g) => g.entry.id), ["a1", "f1", "a2"], "Failed entries must break same-file folding and keep order");
assert.deepEqual(timelineCollapse.t3AggregateEditStats([
  { additions: 3, diffStr: "--- a/f\n+++ b/f\n@@ -1 +1 @@\n---removed text\n+++added text" },
]), { additions: 3, deletions: 1 });
assert.equal(timelineCollapse.t3AggregateEditStats([{ oldStr: "full file", newStr: "updated file" }]), null);
console.log("   OK");

console.log("3. Unit testing usage-rings 5h/7d pairing logic...");
const windows1 = [
  { id: "cg-5h", label: "Claude & GPT (shared)", resetsAt: "2026-11-23T05:00:00Z" },
  { id: "gem-5h", label: "Gemini · 5-hour", resetsAt: "2026-11-23T05:00:00Z" },
  { id: "cg-7d", label: "Claude & GPT (shared)", resetsAt: "2026-11-29T00:00:00Z" },
  { id: "argon", label: "Gemini 4 Argon · 5-hour", resetsAt: "2026-11-23T05:00:00Z" },
  { id: "gem-7d", label: "Gemini · Weekly", resetsAt: "2026-11-29T00:00:00Z" },
];
const paired1 = usageRings.t3PairUsageWindows(windows1);
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

const windows2 = [
  { id: "s", label: "Session" },
  { id: "w", label: "Weekly" },
];
const paired2 = usageRings.t3PairUsageWindows(windows2);
assert.equal(paired2.length, 1);
assert.equal(paired2[0].kind, "dual");
assert.equal(paired2[0].shortWindow.id, "s");
assert.equal(paired2[0].longWindow.id, "w");

// Active-model quota matching across multi-model independent pools
assert.equal(usageRings.t3SelectPrimaryQuotaForModel(windows1, "gemini-4-neon").title, "Gemini");
assert.equal(usageRings.t3SelectPrimaryQuotaForModel(windows1, "gemini-4-argon").window.id, "argon");
assert.equal(usageRings.t3SelectPrimaryQuotaForModel(windows1, "claude-opus-5-5").title, "Claude & GPT (shared)");
assert.equal(usageRings.t3SelectPrimaryQuotaForModel(windows1, "gpt-oss-120b").title, "Claude & GPT (shared)");
assert.equal(usageRings.t3SelectPrimaryQuotaForModel(windows2, "gpt-6.2-sol").key, "s:w");
const explicitModel = "claude-opus-ultra";
assert.equal(usageRings.t3SelectPrimaryQuotaForModel([
  { id: "heuristic", label: "Claude Opus Ultra" },
  { id: "authoritative", label: "Other", modelIds: [explicitModel] },
], explicitModel).key, "authoritative");
const dailyQuarterly = usageRings.t3PairUsageWindows([
  { id: "daily", label: "Claude Daily" },
  { id: "quarterly", label: "Claude Quarterly" },
]);
assert.equal(dailyQuarterly.length, 2, "Non-5h/7d windows must not be forcibly synthesized as a dual 5h/7d pair");
assert.equal(dailyQuarterly.every((item) => item.kind === "single"), true);
assert.equal(usageRings.t3EstimateOutputTokens(""), 0);
assert.equal(usageRings.t3EstimateOutputTokens("Hello, world!"), 3.25);
assert.equal(usageRings.t3EstimateOutputTokens("你好，世界"), 3.75);
assert.equal(usageRings.t3EstimateOutputTokens("你🙂好"), 3);
assert(
  usageRings.t3EstimateOutputTokens("a你🙂b") > usageRings.t3EstimateOutputTokens("a你🙂"),
  "Output token estimate must remain monotonic as streamed text grows"
);
console.log("   OK");

console.log("3.5. Unit testing inline-file-diff unified diff parser...");
const rawDiff = "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -2,3 +2,4 @@\n ctx\n-old1\n+new1\n+new2\n end\n";
const parsedDiff = inlineFileDiff.t3ParseUnifiedDiff(rawDiff);
assert.equal(parsedDiff.additions, 2);
assert.equal(parsedDiff.deletions, 1);
assert.equal(parsedDiff.rows.length, 5);
assert.equal(parsedDiff.rows[1].kind, "del");
assert.equal(parsedDiff.rows[1].lineNo, "3");
assert.equal(parsedDiff.rows[2].kind, "add");
assert.equal(parsedDiff.rows[2].lineNo, "3");
assert.equal(parsedDiff.rows[3].lineNo, "4");
const limitedDiff = inlineFileDiff.t3ParseUnifiedDiff(rawDiff.replaceAll("\n", "\r\n"), null, null, 2);
assert.deepEqual(limitedDiff.rows, parsedDiff.rows.slice(0, 2));
assert.equal(limitedDiff.rowCount, parsedDiff.rows.length);
assert.equal(limitedDiff.additions, parsedDiff.additions);
assert.equal(limitedDiff.deletions, parsedDiff.deletions);
const countsOnlyDiff = inlineFileDiff.t3ParseUnifiedDiff(rawDiff, null, null, 0);
assert.deepEqual(countsOnlyDiff, { ...parsedDiff, rows: [] });
const fallbackDiff = inlineFileDiff.t3ParseUnifiedDiff("", "a\nb", "a\nc\nd");
assert.equal(fallbackDiff.deletions, 2);
assert.equal(fallbackDiff.additions, 3);
const trailingNewlineDiff = inlineFileDiff.t3ParseUnifiedDiff("", "a\nb\n", "a\nc\nd\n");
assert.equal(trailingNewlineDiff.deletions, 2);
assert.equal(trailingNewlineDiff.additions, 3);
assert.equal(filesChangesExplorer.t3NormalizeRelPath(".\\src\\index.ts"), "src/index.ts");
assert.equal(filesChangesExplorer.t3NormalizeRelPath("/foo/bar.js"), "foo/bar.js");
const feTree = filesChangesExplorer.t3BuildChangedFileTree([
  { path: "./a/b/c.txt", status: "modified", insertions: 3, deletions: 0 },
  { path: "a/b/c.txt", status: "modified", insertions: 3, deletions: 0 },
  { path: "ignored-dir/", insertions: 0, deletions: 0 },
  { path: "a/d.txt", status: "added", insertions: 1, deletions: 0 },
  { path: "root.md", status: "modified", insertions: 2, deletions: 0 },
  { path: "brand-new.md", status: "??", insertions: 0, deletions: 0 },
], "");
assert.equal(feTree.length, 3);
assert.equal(feTree[0].kind, "dir");
assert.equal(feTree[0].name, "a");
assert.equal(feTree[0].children[0].kind, "dir");
assert.equal(feTree[0].children[0].name, "b");
assert.equal(feTree[0].children[0].children[0].path, "a/b/c.txt");
assert.equal(feTree[0].children[0].children[0].isNew, false, "Tracked modified file with 0 deletions must not be marked new");
assert.equal(feTree[0].children[1].isNew, true, "Explicitly added file must be marked new");
assert.equal(feTree[1].kind, "file");
assert.equal(feTree[1].name, "brand-new.md");
assert.equal(feTree[1].isNew, true);
assert.equal(feTree[2].kind, "file");
assert.equal(feTree[2].name, "root.md");
assert.equal(feTree[2].isNew, false);
console.log("   OK");

console.log("3.6. Unit testing floating window geometry...");
const floatBounds = { width: 800, height: 600 };
const floatFrame = { x: 120, y: 80, width: 360, height: 240 };
const tabBarRect = { top: 32, bottom: 64 };
assert.equal(workspaceFloatingPanels.tabDroppedOutside(tabBarRect, 48, 48), false);
assert.equal(workspaceFloatingPanels.tabDroppedOutside(tabBarRect, 48, 74), false);
assert.equal(workspaceFloatingPanels.tabDroppedOutside(tabBarRect, 48, 96), true);
assert.equal(workspaceFloatingPanels.tabDroppedOutside(tabBarRect, 48, 8), true);
assert.deepEqual(workspaceFloatFrame(floatFrame, floatBounds, "move", 1000, -1000),
  { x: 432, y: 8, width: 360, height: 240 });
assert.deepEqual(workspaceFloatFrame(floatFrame, floatBounds, "nw", 1000, 1000),
  { x: 250, y: 170, width: 230, height: 150 });
assert.deepEqual(workspaceFloatFrame(floatFrame, floatBounds, "se", 1000, 1000),
  { x: 120, y: 80, width: 672, height: 512 });
assert.deepEqual(workspaceFloatFrame(floatFrame, { width: 180, height: 116 }),
  { x: 8, y: 8, width: 164, height: 100 });
assert.deepEqual(workspaceSnapFrame({ x: 20, y: 200, width: 300, height: 200 }, floatBounds),
  { x: 8, y: 200, width: 300, height: 200 });
assert.deepEqual(workspaceSnapFrame({ x: 480, y: 380, width: 300, height: 200 }, floatBounds),
  { x: 492, y: 392, width: 300, height: 200 });
assert.deepEqual(workspaceSnapFrame({ x: 200, y: 150, width: 300, height: 200 }, floatBounds),
  { x: 200, y: 150, width: 300, height: 200 });
const pillFrame = { x: 100, y: 100, width: 232, height: 38 };
assert.deepEqual(workspaceFloatFrame(pillFrame, floatBounds, "move", 0, 1000),
  { x: 100, y: 554, width: 232, height: 38 });
assert.deepEqual(workspaceSnapFrame({ x: 100, y: 540, width: 232, height: 38 }, floatBounds),
  { x: 100, y: 554, width: 232, height: 38 });
const defaultChat = defaultChatFloatFrame({ width: 1100, height: 700 });
assert.deepEqual(defaultChat, { x: 688, y: 208, width: 396, height: 476 });
assert.deepEqual(chatPillFrame(defaultChat, { width: 1100, height: 700 }),
  { x: 852, y: 646, width: 232, height: 38 });
assert.deepEqual(chatPillFrame(defaultChat, { width: 180, height: 48 }),
  { x: 8, y: 8, width: 164, height: 32 });
const roomy = { width: 1500, height: 850 };
const openFrame = placeSurfaceFloat(roomy, [], true);
assert.deepEqual(openFrame, defaultPreviewFloatFrame(roomy));
assert(openFrame.x + openFrame.width === roomy.width - 12 && openFrame.y + openFrame.height === roomy.height - 12,
  "Default floating preview should dock cleanly in the bottom-right corner");
const desktopPreview = defaultPreviewFloatFrame({ width: 1611, height: 944 });
assert.deepEqual(desktopPreview, { x: 1183, y: 422, width: 416, height: 510 });
const savedPreviewRight = serializePreviewFloatFrame({ x: 1160, y: 390, width: 420, height: 500 }, { width: 1600, height: 920 });
assert.equal(savedPreviewRight.anchorRight, true);
assert.equal(savedPreviewRight.anchorBottom, true);
assert.deepEqual(restorePreviewFloatFrame(savedPreviewRight, { width: 1600, height: 920 }), { x: 1160, y: 390, width: 420, height: 500 });
assert.deepEqual(restorePreviewFloatFrame(savedPreviewRight, { width: 1400, height: 800 }), { x: 960, y: 270, width: 420, height: 500 });
const savedPreviewLeft = serializePreviewFloatFrame({ x: 40, y: 50, width: 380, height: 420 }, { width: 1600, height: 920 });
assert.equal(savedPreviewLeft.anchorRight, false);
assert.equal(savedPreviewLeft.anchorBottom, false);
assert.deepEqual(placeSurfaceFloat({ width: 1400, height: 800 }, [], true, null, savedPreviewLeft), { x: 40, y: 50, width: 380, height: 420 });
const secondPreview = placeSurfaceFloat({ width: 1400, height: 800 }, [{ x: 960, y: 270, width: 420, height: 500 }], true, null, savedPreviewRight);
assert(secondPreview.x + secondPreview.width <= 960, "A second floating browser should avoid stacking directly on top of the saved spot");
const nextFrame = placeSurfaceFloat(roomy, [openFrame], false);
assert(nextFrame.x + nextFrame.width <= openFrame.x, "The next window should use the empty left side");
assert.equal(placeSurfaceFloat(floatBounds, [], true, { x: 10, y: 10 }).x, 8);
assert(workspaceFloatingPanels.legacyMarkers.includes("T3_WORKSPACE_FLOATING_PANELS_V22"));
assert(workspaceFloatingPanels.legacyMarkers.includes("T3_WORKSPACE_FLOATING_PANELS_V29"));
console.log("   OK");

console.log("3.7. Unit testing cross-platform (Windows / Linux / macOS) CLI routing, helpers & EOL hygiene...");
verifyCrossPlatformCliUnit();
console.log("   OK");

function verifyCrossPlatformCliUnit() {
  const repoRoot = path.join(__dirname, "..");

  // 1) Cross-platform packaging / EOL hygiene (LF for Unix scripts, ESM, JSON, docs; CRLF for Windows .cmd)
  const lfFiles = [
    "install.sh",
    "package.json",
    "themes/chatgpt-app.json",
    ...fs.readdirSync(path.join(repoRoot, "lib", "runtime")).filter((f) => f.endsWith(".mjs")).map((f) => path.join("lib", "runtime", f)),
  ];
  for (const rel of lfFiles) {
    const raw = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    assert(!raw.includes("\r\n"), `${rel} must use LF line endings for reproducible cross-platform ASAR/Unix execution`);
  }
  const installSh = fs.readFileSync(path.join(repoRoot, "install.sh"), "utf8");
  assert(installSh.startsWith("#!/usr/bin/env sh\n"), "install.sh must keep POSIX sh shebang on line 1");
  for (const cmdFile of ["install.cmd", "repair.cmd", "status.cmd", "uninstall.cmd"]) {
    const raw = fs.readFileSync(path.join(repoRoot, cmdFile), "utf8");
    assert(raw.includes("\r\n"), `${cmdFile} must use CRLF line endings for Windows cmd.exe`);
    assert(raw.includes("chcp 65001"), `${cmdFile} must switch console to UTF-8`);
  }

  // 2) Unified CLI & platform arg parsing (including flags before positional paths and implicit bundle paths)
  const implicitLinux = parseCliArgs(["--preset", "clean", "/tmp/T3-Code-0.1.12-x86_64.AppImage"]);
  assert.equal(implicitLinux.cmd, "install");
  assert.equal(implicitLinux.preset, "clean");
  assert.deepEqual(implicitLinux.rest, ["/tmp/T3-Code-0.1.12-x86_64.AppImage"]);

  const implicitAppImageFlag = parseCliArgs(["--appimage", "/tmp/T3-Code.AppImage"]);
  assert.equal(implicitAppImageFlag.cmd, "install");
  assert.equal(implicitAppImageFlag.appImagePath, "/tmp/T3-Code.AppImage");

  const repairMac = parseCliArgs(["--repair", "/Applications/T3 Code (Beta).app/"]);
  assert.equal(repairMac.cmd, "repair");
  assert.deepEqual(repairMac.rest, ["/Applications/T3 Code (Beta).app/"]);

  const buildWithFlag = parseCliArgs(["--build", "/tmp/test.asar", "--preset", "chat-lite"]);
  assert.equal(buildWithFlag.cmd, "build");
  assert.deepEqual(buildWithFlag.rest, ["/tmp/test.asar"]);
  assert.equal(buildWithFlag.preset, "chat-lite");

  assert.equal(parseCliArgs(["--app=/Applications/T3.app"]).cmd, "install");
  assert.equal(parsePlatformArgs(["/tmp/T3.AppImage", "--shared-data"]).command, "install");
  assert.equal(parsePlatformArgs(["/tmp/T3.AppImage", "--shared-data"]).input, "/tmp/T3.AppImage");
  assert.equal(parsePlatformArgs(["--repair", "/Applications/T3.app/"]).command, "repair");
  assert.equal(parsePlatformArgs(["--repair", "/Applications/T3.app/"]).input, "/Applications/T3.app/");
  assert.equal(parsePlatformArgs(["restore", "--keep-theme"]).command, "uninstall");

  // 3) 3-platform delegation matrix with mocked process.platform
  const origDesc = Object.getOwnPropertyDescriptor(process, "platform");
  const withPlatform = (plat, fn) => {
    Object.defineProperty(process, "platform", { value: plat, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", origDesc);
    }
  };
  withPlatform("win32", () => {
    assert.equal(shouldDelegateToLinux(parseCliArgs(["status"])), false);
    assert.equal(shouldDelegateToMacos(parseCliArgs(["status"])), false);
  });
  withPlatform("linux", () => {
    assert.equal(shouldDelegateToLinux(parseCliArgs(["--preset", "clean", "/tmp/T3.AppImage"])), true);
    assert.equal(shouldDelegateToLinux(parseCliArgs(["install", "--asar", "/opt/T3 Code/resources/app.asar"])), false);
    assert.equal(shouldDelegateToLinux(parseCliArgs(["build", "/tmp/out.asar"])), false);
    assert.equal(shouldDelegateToLinux(parseCliArgs(["--help"])), false);
    assert.deepEqual(
      buildDelegatedArgs(implicitLinux, ["--preset", "clean", "/tmp/T3.AppImage"], implicitLinux.appImagePath),
      ["install", "--preset", "clean", "/tmp/T3.AppImage"]
    );
    assert.deepEqual(
      buildDelegatedArgs(parseCliArgs(["--repair", "--appimage", "/tmp/T3.AppImage"]), ["--repair", "--appimage", "/tmp/T3.AppImage"], "/tmp/T3.AppImage"),
      ["repair", "/tmp/T3.AppImage"]
    );
  });
  withPlatform("darwin", () => {
    assert.equal(shouldDelegateToMacos(parseCliArgs(["install", "/Applications/Custom.app/"])), true);
    assert.equal(shouldDelegateToMacos(parseCliArgs(["install", "--asar", "/tmp/app.asar"])), false);
    assert.equal(shouldDelegateToMacos(parseCliArgs(["build", "/tmp/out.asar"])), false);
    assert.equal(isThemeOnlySelection(parseCliArgs(["--preset", "theme-only"])), true);
    assert.equal(isThemeOnlySelection(parseCliArgs(["--packs", "theme"])), true);
    assert.deepEqual(
      buildDelegatedArgs(parseCliArgs(["install", "--app", "/Applications/Custom.app"]), ["install", "--app", "/Applications/Custom.app"], "/Applications/Custom.app"),
      ["install", "/Applications/Custom.app"]
    );
  });
  assert.equal(isMacosBundleAsarPath("/Applications/T3 Code (Beta).app/Contents/Resources/app.asar"), true);
  assert.equal(isMacosBundleAsarPath("/opt/T3 Code/resources/app.asar"), false);
  assert.throws(
    () => assertSafeAsarTargets([{ source: "/Applications/T3 Code (Beta).app/Contents/Resources/app.asar" }]),
    /禁止通过通用 --asar/,
    "Mutating a macOS .app bundle ASAR via generic --asar must be rejected"
  );
  // Symlink / directory-alias resolution pointing into .app/Contents/Resources (including missing target ASAR repair)
  const symTmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-mac-symlink-"));
  try {
    const bundleRes = path.join(symTmp, "T3 Code (Beta).app", "Contents", "Resources");
    fs.mkdirSync(bundleRes, { recursive: true });
    const realAsar = path.join(bundleRes, "app.asar");
    fs.writeFileSync(realAsar, "stub-asar");
    const aliasDir = path.join(symTmp, "alias-resources");
    const aliasAsar = path.join(aliasDir, "app.asar");
    let symlinkCreated = false;
    try {
      fs.symlinkSync(bundleRes, aliasDir, process.platform === "win32" ? "junction" : "dir");
      symlinkCreated = true;
    } catch (err) {
      if (!["EPERM", "EACCES"].includes(err?.code)) throw err;
    }
    if (symlinkCreated) {
      assert.equal(isMacosBundleAsarPath(aliasAsar), true, "Real symlinked Resources alias must resolve canonical macOS bundle path");
      assert.throws(() => assertSafeAsarTargets([{ source: aliasAsar }]), /禁止通过通用 --asar/);
      fs.unlinkSync(realAsar);
      assert.equal(isMacosBundleAsarPath(aliasAsar), true, "Real symlinked Resources alias must still be blocked when target app.asar is missing");
      assert.throws(() => assertSafeAsarTargets([{ source: aliasAsar }]), /禁止通过通用 --asar/);
    }
    // Always verify ancestor-walking canonicalization when symlink creation is sandbox-restricted
    const normAliasDir = path.resolve(aliasDir).toLowerCase();
    const mockRealpath = (p) => {
      const low = path.resolve(p).toLowerCase();
      if (low === path.resolve(aliasAsar).toLowerCase()) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = "ENOENT";
        throw err;
      }
      if (low === normAliasDir) return bundleRes;
      return p;
    };
    assert.equal(resolveCanonicalPath(aliasAsar, mockRealpath), path.join(bundleRes, "app.asar"));
    assert.equal(isMacosBundleAsarPath(aliasAsar, mockRealpath), true);
  } finally {
    fs.rmSync(symTmp, { recursive: true, force: true });
  }

  // 3.8) AST parseExports coverage (async, generator, multi-declarator destructuring, wildcard/ns re-exports, anonymous default)
  const { parseExports: astParseExports } = require("../lib/js-ast.cjs");
  const parsedEx = astParseExports(`
    export async function asyncOp() {}
    export async function* asyncGenOp() {}
    export function* genOp() {}
    export const first = 1, { nested: second, shortB } = obj, [arrA, ...arrRest] = arr;
    export * from "./sub.js";
    export * as nsAlias from "./ns.js";
    export default () => 42;
  `);
  const exNames = new Set(parsedEx.filter((e) => !e.from).map((e) => e.exported));
  for (const expected of ["asyncOp", "asyncGenOp", "genOp", "first", "second", "shortB", "arrA", "arrRest", "default"]) {
    assert(exNames.has(expected), `parseExports must recognize "${expected}"`);
  }
  assert(parsedEx.some((e) => e.exported === "*" && e.from === "./sub.js"), "parseExports must capture export * from");
  assert(parsedEx.some((e) => e.exported === "nsAlias" && e.from === "./ns.js"), "parseExports must capture export * as ns from");

  // 3.9) Standardized SemVer versioning & project release policy separation
  const {
    ENHANCER_VERSION,
    ENHANCER_TAG,
    T3_BASELINE_VERSION,
    SEMVER_REGEX,
    PROJECT_RELEASE_REGEX,
    parseSemver,
    compareSemver,
    parseProjectReleaseVersion,
    parseStandardVersion,
    compareStandardVersions,
    readPackageVersion,
    formatVersionBanner,
  } = require("../lib/version.cjs");
  assert(SEMVER_REGEX.test(ENHANCER_VERSION) && PROJECT_RELEASE_REGEX.test(ENHANCER_VERSION), `package version must satisfy SemVer & project release format: ${ENHANCER_VERSION}`);
  assert.equal(ENHANCER_TAG, `v${ENHANCER_VERSION}`);
  assert.equal(readPackageVersion().version, ENHANCER_VERSION);
  const parsedSemAlpha = parseSemver("1.0.0-alpha");
  assert.equal(parsedSemAlpha.prerelease, "alpha");
  const parsedSemBuild = parseSemver("1.0.0+build.001");
  assert.equal(parsedSemBuild.build, "build.001");
  assert.equal(compareSemver("1.0.0+build.001", "1.0.0+build.002"), 0, "SemVer build metadata must not affect precedence");
  assert(compareSemver("1.0.0-alpha", "1.0.0-alpha.1") < 0);
  assert(compareSemver("0.2.0-preview.9007199254740992", "0.2.0-preview.9007199254740993") < 0, "Numeric identifiers above MAX_SAFE_INTEGER must compare accurately via BigInt");
  const parsedPreview = parseProjectReleaseVersion("0.2.0-preview.1");
  assert.equal(parsedPreview.channel, "preview");
  assert.equal(parsedPreview.prereleaseTag, "preview");
  assert.equal(parsedPreview.prereleaseNumber, 1);
  assert.equal(parsedPreview.isPrerelease, true);
  assert.equal(parseProjectReleaseVersion("0.2.0").channel, "stable");
  for (const invalidVer of ["v0.2.0", "0.2", "01.0.0", "0.2.0-01"]) {
    assert.throws(() => parseStandardVersion(invalidVer), /SemVer 2\.0\.0/, `Invalid SemVer rejected: ${invalidVer}`);
  }
  for (const nonReleaseVer of ["1.0.0-alpha", "1.0.0+build.001", "0.2.0-preview.0", "0.2.0-foo.1"]) {
    assert.throws(() => parseProjectReleaseVersion(nonReleaseVer), /项目发行版本号不符合规范/, `Non-project release rejected: ${nonReleaseVer}`);
  }
  const orderedVersions = [
    "0.1.0",
    "0.1.1",
    "0.2.0-alpha.1",
    "0.2.0-beta.1",
    "0.2.0-preview.1",
    "0.2.0-preview.2",
    "0.2.0-rc.1",
    "0.2.0",
  ];
  for (let i = 0; i < orderedVersions.length - 1; i++) {
    assert(compareStandardVersions(orderedVersions[i], orderedVersions[i + 1]) < 0, `${orderedVersions[i]} < ${orderedVersions[i + 1]}`);
    assert(compareStandardVersions(orderedVersions[i + 1], orderedVersions[i]) > 0, `${orderedVersions[i + 1]} > ${orderedVersions[i]}`);
    assert.equal(compareStandardVersions(orderedVersions[i], orderedVersions[i]), 0);
  }
  assert.equal(parseCliArgs(["--version"]).cmd, "version");
  assert.equal(parseCliArgs(["-v"]).cmd, "version");
  assert.equal(parseCliArgs(["version"]).cmd, "version");
  assert.equal(linuxCli.parseLinuxArgs(["--version"]).command, "version");
  assert.equal(linuxCli.parseLinuxArgs(["-v"]).command, "version");
  assert.equal(macosCli.parseMacosArgs(["--version"]).command, "version");
  assert.equal(macosCli.parseMacosArgs(["-v"]).command, "version");
  withPlatform("linux", () => {
    assert.equal(shouldDelegateToLinux(parseCliArgs(["--version"])), false);
    assert.equal(shouldDelegateToLinux(parseCliArgs(["version"])), false);
  });
  withPlatform("darwin", () => {
    assert.equal(shouldDelegateToMacos(parseCliArgs(["--version"])), false);
    assert.equal(shouldDelegateToMacos(parseCliArgs(["version"])), false);
  });
  const rootDir = path.resolve(__dirname, "..");
  const expectedBanner = formatVersionBanner();
  assert(expectedBanner.includes(ENHANCER_TAG) && expectedBanner.includes(T3_BASELINE_VERSION));
  for (const [entry, flag] of [
    ["cli.cjs", "--version"],
    ["cli.cjs", "-v"],
    ["cli.cjs", "version"],
    ["linux.cjs", "--version"],
    ["macos.cjs", "--version"],
  ]) {
    const out = execFileSync(process.execPath, [path.join(rootDir, entry), flag], { encoding: "utf8" }).trim();
    assert.equal(out, expectedBanner, `${entry} ${flag} output must match formatVersionBanner()`);
  }
  const readmeText = fs.readFileSync(path.join(rootDir, "README.md"), "utf8");
  const tutorialText = fs.readFileSync(path.join(rootDir, "使用教程.md"), "utf8");
  assert(readmeText.includes("## 版本号规范") && readmeText.includes(ENHANCER_TAG), "README.md must stay synced with ENHANCER_TAG");
  assert(tutorialText.includes("版本号规范") && tutorialText.includes(ENHANCER_TAG), "使用教程.md must stay synced with ENHANCER_TAG");
  if (!readPackageVersion().isPrerelease) {
    assert(readmeText.includes("/releases/latest") && tutorialText.includes("/releases/latest"), "Stable release docs must link entry downloads to /releases/latest");
    assert(!/releases\/tag\/v\d+\.\d+\.\d+-(?:alpha|beta|preview|rc)\.\d+/.test(readmeText) && !/releases\/tag\/v\d+\.\d+\.\d+-(?:alpha|beta|preview|rc)\.\d+/.test(tutorialText), "Stable release entry docs must not link primary downloads to prerelease tags");
  }
  const themeObj = JSON.parse(fs.readFileSync(SOURCE_THEME_PATH, "utf8"));
  assert.equal(themeObj.version, 1, "Theme JSON schema version must remain upstream integer 1");
  const crumbsRule = themeObj.css.match(/\[data-file-breadcrumbs\]\s*\{[^}]*\}/)?.[0] || "";
  assert(
    crumbsRule.includes("margin-inline: 0 auto !important;"),
    "File preview breadcrumb pill must stay left-aligned (margin-inline: 0 auto !important)"
  );

  // 3.10) Maintainer preflight & zero-dependency release packaging scripts
  const preflight = require("../scripts/preflight.cjs");
  const packReleaseMod = require("../scripts/pack-release.cjs");
  const publishReleaseMod = require("../scripts/publish-release.cjs");

  assert.equal(preflight.parseArgs(["--ci", "--strict-clean", "--base=origin/main"]).baseRef, "origin/main");
  assert.equal(preflight.checkZeroDeps(rootDir).ok, true, "checkZeroDeps must pass on repo");
  const regCheck = preflight.checkPatchAndRuntimeRegistry(rootDir);
  assert.equal(regCheck.ok, true, `checkPatchAndRuntimeRegistry failed: ${regCheck.errors.join("; ")}`);
  assert.equal(regCheck.patchCount, ALL_PATCHES.length);
  const hygieneCheck = preflight.checkEolAndHygiene(rootDir);
  assert.equal(hygieneCheck.ok, true, `checkEolAndHygiene failed: ${hygieneCheck.errors.join("; ")}`);
  const docsCheck = preflight.checkDocsAlignment(rootDir);
  assert.equal(docsCheck.ok, true, `checkDocsAlignment failed: ${docsCheck.errors.join("; ")}`);
  assert.deepEqual(
    preflight.extractMarkersFromPatchSource('const MARKER = "T3_ALPHA_V2"; const sub = { marker: "T3_BETA_V1" };'),
    ["T3_ALPHA_V2", "T3_BETA_V1"]
  );

  // Pure JS CRC-32 standard test vector & UTF-8 / Unix 0755 ZIP round-trip
  assert.equal(packReleaseMod.crc32(Buffer.from("123456789", "utf8")), 0xcbf43926);
  const sampleZip = packReleaseMod.createZipBuffer([
    { name: "pkg/", data: null, mode: 0o040755 },
    { name: "pkg/install.sh", data: Buffer.from("#!/usr/bin/env sh\necho ok\n", "utf8"), mode: 0o100755 },
    { name: "pkg/使用教程.md", data: Buffer.from("# 中文标题\n".repeat(40), "utf8"), mode: 0o100644 },
    { name: "pkg/empty.txt", data: Buffer.alloc(0), mode: 0o100644 },
  ]);
  const parsedEntries = packReleaseMod.readZipEntries(sampleZip);
  assert.equal(parsedEntries.length, 4);
  const zInstall = parsedEntries.find((e) => e.name === "pkg/install.sh");
  assert.equal(zInstall.madeByHost, 3);
  assert.equal(zInstall.unixMode, 0o755);
  assert.equal(zInstall.data.toString("utf8"), "#!/usr/bin/env sh\necho ok\n");
  const zZh = parsedEntries.find((e) => e.name === "pkg/使用教程.md");
  assert(Boolean(zZh && (zZh.flags & 0x0800) && zZh.method === 8));
  assert.equal(zZh.data.toString("utf8"), "# 中文标题\n".repeat(40));

  const releaseManifest = packReleaseMod.collectReleaseFiles(rootDir, { includeUntracked: true });
  assert(releaseManifest.some((f) => f.rel === "install.sh" && f.mode === 0o100755), "Release manifest must mark install.sh executable");
  assert(releaseManifest.some((f) => f.rel === "scripts/preflight.cjs"), "Release manifest must include maintainer scripts");
  assert(!releaseManifest.some((f) => f.rel.startsWith(".github/") || f.rel.startsWith("dist/")), "Release manifest must exclude .github/ and dist/");

  const tmpNotes = path.join(os.tmpdir(), `t3e-notes-test-${process.pid}.md`);
  try {
    fs.writeFileSync(tmpNotes, packReleaseMod.buildReleaseNotesTemplate({
      versionTag: "v0.2.1",
      isPrerelease: false,
      zipName: "t3code-enhancer-v0.2.1.zip",
      fileCount: 10,
      byteSize: 12345,
      sha256: "a".repeat(64),
    }), "utf8");
    const updated = packReleaseMod.updateNotesChecksum(tmpNotes, {
      zipName: "t3code-enhancer-v0.2.1.zip",
      fileCount: 12,
      byteSize: 23456,
      sha256: "b".repeat(64),
    });
    assert.equal(updated, true);
    const notesText = fs.readFileSync(tmpNotes, "utf8");
    assert(notesText.includes("12 个文件") && notesText.includes("b".repeat(64)));
  } finally {
    fs.rmSync(tmpNotes, { force: true });
  }

  const pubDefaults = publishReleaseMod.parseArgs([]);
  assert.equal(pubDefaults.execute, false, "publish-release must default to dry-run");
  assert.equal(pubDefaults.publish, false, "publish-release must default to draft release");
  const pubExec = publishReleaseMod.parseArgs(["--execute", "--publish", "--allow-branch"]);
  assert.equal(pubExec.execute, true);
  assert.equal(pubExec.publish, true);
  assert.equal(pubExec.allowBranch, true);

  // 4) Isolated dual-ASAR vs single-ASAR discovery (Windows layout)
  const tmpWin = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-unit-win-"));
  const origLocalAppData = process.env.LOCALAPPDATA;
  try {
    const resDir = path.join(tmpWin, "Programs", "t3code", "resources");
    fs.mkdirSync(resDir, { recursive: true });
    const fakeServer = path.join(resDir, "server.asar");
    const fakeApp = path.join(resDir, "app.asar");
    fs.writeFileSync(fakeServer, "stub-server");
    withPlatform("win32", () => {
      process.env.LOCALAPPDATA = tmpWin;
      assert.deepEqual(getArchiveTargetPaths().map((p) => p.source), [fakeServer], "Single server.asar when sibling app.asar does not exist");
      fs.writeFileSync(fakeApp, "stub-app");
      assert.deepEqual(getArchiveTargetPaths().map((p) => p.source), [fakeServer, fakeApp], "Dual server.asar + app.asar when both exist");
      assert.deepEqual(getArchiveTargetPaths(fakeApp).map((p) => p.source), [fakeApp], "Explicit --asar override targets only the specified ASAR");
      assert.equal(getAsarPaths(fakeServer).backup, fakeServer + ".before-t3code-enhancer");
    });
  } finally {
    if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = origLocalAppData;
    fs.rmSync(tmpWin, { recursive: true, force: true });
  }

  // 5) Pure macOS & Linux helpers + repair plan inference (runnable without T3 Code installed)
  assert.equal(getArchiveCompatibilityTier({ modules: [{ installed: true }] }).tier, "verified");
  assert.equal(getArchiveCompatibilityTier({ modules: [{ pristine: true, compat: "auto-adapted" }] }).tier, "auto-adapted");
  assert.equal(getArchiveCompatibilityTier({ modules: [{ pristine: false }] }).tier, "incompatible");

  const inferredClean = inferRepairPlanOptions(
    ALL_PATCHES.map((p) => ({
      id: p.id,
      key: p.id,
      installed: PACKS.find((pk) => pk.id === "privacy").patchIds.includes(p.id),
      pristine: true,
    })),
    { installed: true, managed: true, officialOnly: false }
  );
  assert.equal(inferredClean.preset, "clean");
  const inferredPatchOnly = inferRepairPlanOptions(
    ALL_PATCHES.map((p) => ({
      id: p.id,
      key: p.id,
      installed: p.id === "desktop-tray" || p.id === "new-chat-layout",
      pristine: true,
    })),
    { installed: false, managed: false, officialOnly: false }
  );
  assert.equal(inferredPatchOnly.patchOnly, true);
  assert.deepEqual(inferredPatchOnly.packs, ["workspace"]);

  const macPaths = macosCli.getMacosPaths("/Users/tester");
  assert.equal(macPaths.installDirectory, path.join("/Users/tester", "Applications", "T3 Code Enhancer.app"));
  const macIsoEnv = macosCli.buildInfoPlistEnv({ EXISTING: "1", INVALID_OBJ: { nested: true } }, false, macPaths, { disableTelemetry: true });
  assert.equal(macIsoEnv.T3CODE_TELEMETRY_ENABLED, "false");
  assert.equal(macIsoEnv.T3CODE_OTEL_SDK_DISABLED, "true");
  assert.equal(macIsoEnv.T3CODE_HOME, path.join(macPaths.profileDirectory, "t3-home"));
  assert.equal("INVALID_OBJ" in macIsoEnv, false);
  const macSharedEnv = macosCli.buildInfoPlistEnv(macIsoEnv, true, macPaths, { disableTelemetry: false });
  assert.equal("T3CODE_HOME" in macSharedEnv, false);
  assert.equal("T3CODE_TELEMETRY_ENABLED" in macSharedEnv, false);
  assert(macosCli.userDataPatch.apply('const cfg = { current: "t3code-v2", legacy: "T3 Code (Alpha)" };').includes(macosCli.userDataPatch.marker));
  assert(linuxCli.buildLauncher(false).includes("T3CODE_TELEMETRY_ENABLED=false"));
  assert(!linuxCli.buildLauncher(true).includes("T3CODE_HOME="));
  assert.equal(macosCli.parseMacosArgs(["/Applications/Custom.app/"]).command, "install");

  // 6) Upgrade compatibility: v0.1.x theme migration & custom third-party theme preservation
  const upgradeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-theme-upg-"));
  try {
    const v010ThemeRaw = require("node:zlib").inflateRawSync(Buffer.from(
      "3Vzhb+O4sf++fwVfFtfEV8uRZdlxtMjixY7dK9BFD7ct0IfLfqAl2mYjkzqKTpwu8r8XJCWZoihZdrLX7YuDIBaH5Mxw+JvhkNTXdwCcPSKWYkrOAtDviu8EbtBZAM6ma8j/9PPfwG2SnMkCmCQIMkhCWRzj1ZqrghCSR5iKh+/n8iejD0NEuHzs3olPRk1jygT113cA1JIVBXPK0IrRLYnMDgqSz1u2hIqr93Nv7s0H1nKjpXJnC8oixGTBbDwbz6Z5gV04UbBmdJN1ei0+RQGN0ASGDzrXV/Or+VgnMJjpz/tzz88JEGNU8XJ3PXC9Yem5UXNy3Z/2pyWKkj7m8/7czYuXNNwqWYaz4Ww0yp/jkJJPW44iWxlJtmp4Zt7MmxXPNyhN4QrdhlxZj6nRUnnjKJYof6KP2Th4t96tNzOIGgcxoynJ78/9eaHATSGj5bnR9FD8FE0nMQzRmsa5kVzfXt/eenlpiiAL158gD9dCisfK+M+nA9etpW4USqOutDofTH0L3YH2QkoiyJ4teijK2rXwF7hAsSQYiZ9irFIcoQVklrmRlUy02TafzeeeUT6lhDMaG4asmUxG18ymovlkGVsru7/QJzUciq/JbDK7q5Ls7XPuzt0K57/Qp88oRmFuZ0Yz9QKpkr8+IhbD53qCXyBOkW0SccQ2mMDYtJHxfDy/NYmmW5ZmCFPWWU7QCE85kRI0n/13/myks7Pj1vZ3XAOa0hTjlMaF1ZRlUyWa1VjLM6s5SGAI59/6t0PPTqqNtnAsvkHVaH/bJIJcjbU7GV3f+eUCs66FRLf/2XyuqfcJMoLJKvMRV1fuyCgxWr/2fNedGTTG9JrMJmfvAHiRXvoRMgwJ1/x0BNlD8a3st2dT8clar/PcJeVYfbd03V4NhdGa2aXmvwfiZ7Qv0jy41xcfrWjvw/tX4qMVVb24jcRky5/5M41k78nnY1HbKDHd4vR2eDs0aHQNDcb9SX+yJ9j782v/2r+e7UvKHr1SWvj0we3gdqCVVL16aSYd8OvmGNd49rvp3XTmVsgODLHFu5sWs/fvMni4M0rM0Gk8GU81NkwfP7od3V75+/KjvPyxfr7R0/t3g0lNy02RVcXbm1qp8/em6i0e3zQp3eebE6Xq9T3f870qhcXvm1PW7vkrDNf7/hrGy97fNCyb/6+RwYwAKk01CVeNAryJN/FmFRItDjAHtSYSMAfFEguYxlMTDZjKtscD3sgfXQ10qh2vqa7HBOak1KMCU13VuKCGQo8MmkkMUaf+1J9O64g1WzAG2R4fmJJrEcLV7cTXVW+NEexE+mzpT7xbX+NDjxPmk8k+iKuNFOZ3s9H4tkJV8kIj77rvnUmKlyJiCFPpiQJGKQdf7wkAjrOkhDspJGkAtlj+46SI4WUXODBJYuSkzylHmy6YxJg8fILhZ/l9Tgnvgvuzz2hFEfj7n+/PxLdPOGQ0pUsO/g/+hHDx/GchBCQr8HkqHux7+aAxsaGESibEP2kCQyQ7mH+ihDq/oNU2hkw193kOxEP1ZQrTEEYYFo+mlKQ0hmk9Q0UHWfcMRnibBsDtjbwhQ5vsMV8zBCMnQhziOHUSSFDsPOGIrwPQH/c0ynDnYPLg9APw3o3Ep/zcC8B7f+SPfFR+PgiAWucYz/0AvL+G1xB6++cZqATg/VL+aCU4ko+vxWf/OIQsEo+vllfLsfZ4jZMAvEchCpHWyGK7WMSyGX/pL4f7grWYQAFgqwW8cLsg++25/rCjsZChqWh4gRZIkz/GBFmqjztlEkcMkoVuqHfDII6rNH3XIKnj2fPLnT6I4VqMriNfl4REzmJlGUhZslxZBiCkm4SmiDnpGkb0KQAu8JId6LvJzqK3jqWiDBJFPV/UG9vqXemKSGiidSboPfHHGVlq9v1OF7jy07c2rDO0Ro+MkgBsWXxxfxZBDgO8gSt0mT6u/rjbxN0fBtP0cQV2m5ikN+drzpPg8vLp6an3NOhRtrr0XNcVxOfgEaOnCd3dnIuePR94/jlY4ji+OSeUoHOQckYf0M35IobhQ/5VTa+bc6/nFY+EeYQwuTmXCFh6/E+KSf78h8Hsh8E0gXwNopvzzTXoj8HIkZ/zS1UoGPthMLs/EyK/3BMJhAGh/OJXIaoTriHPOLg/e8IRuj/70qkrX27jWJTnQCoLQ0o4ElgGdzlS+GOFEy/35H83SADVhSwBH29UWdaChsqiuSfKHiRGOast58Kc+3vEeZHN9cR6r+h+D0FybodVCFqMF+PQrUKQDLcsEDSCI3jl2yBIOegKBKn4pQJBlccKgryltxx4FggyC/Tp7A2HXbD/4/bckR2HzEY0HKq2cT1sgKPmLjVMqhD2B03IVCH3xlV8uoILvwT2BT5V3ECBTyZy1eGTZ4EDb3gaPg3GtfAkcbAen4bDKj5VNelmU3bNN3EXLGj0rAxfRg5LuMHxcwAeIbvQIhrFUYzE9HHEXMJkFQBXNXRPLn8E/R74O8FLjCIgVuMAkZU0k35vMEx2IFk/pziEMSCUOGkIY0xWjoIfAEVgkQL0iNgzSPG/EPjx8p6kj6tevA1xhBR7OqoVzf4P3iSUcUj4B40mg7kASDhrIBKgV0O1jNHOSddM2k4mqMZSgNMLAZBdEGIWxqgLGAp5F4hWuyCh8fP+vxUlXYDiGCcpyhDqEYWcMgctlyjkgU0pJXZe7okGm2sEI8S+gD073bxcBVYxfKZbhaCMxqmVMo0pv7nPl3H3Z1YiI2wTIGSlywC7MHG2aeozoYmYu8K2t0lNzxnpBpGtjU5pMbcFiyWskdixs5UJtOcD5CTxNnUWnNS2etXQ6lWt7RX2ObJ0nGkVpRxHe+U7jD5J3QoZP4IIP6q/AeFrgfBxdOF1atkcNLA5qOUhSy85jMboC1hsOafEagF4gySKCx4fMBFswzTFqWjQ2SAOBdNH1K8fRb9BEL9emRYG+ZYRZ0njqMa4REDgIMLZs4NLDOVRm8NEv22nQVErok+k1QR7RQ3J2essQOK11wOfVUcAxnhFNojwAGwzCJeOJkZLfqn6WzEcSVS2cepgQpDkV7KlktMOJnJYEIkC6Y1SGuMo8yt6aNAxeV/QXeHyRHxbN/BqUDBHm3LH+RJUymC0ncAoEiC7iGn4oPgyKDaQrTCpJSi61+bul67tIfhRc6tP2Xj4rnsCKHQbidIYb0zlN+lAkYhw4kTFH4avr7oNwi2nNeMQAIGSyiZKrWWxPyYp4l0pRecEbn4V2zpOuGUMEd5Oi+UqmU6L1GKwt988Pj6Fr0DFrnI1VOqv04rH+uoN/Mo6HTsWDHrgJxlTaFO8FGnoprWgnNPN0eZTp0a1EKqAgDw3o9HJBVmnTVRUQijlmOpmx7gOHP0e+KQcZNoFnyB7EDgN/gBowkUQ6yzjbboGS0p5SWe6U725P9umGioqXAlUyO9aJmYhjahWNKVWck2GqChOUuDJWFDFmXEt1gbgWqx0RlUCtbrA/0J25y89RA4ins2R9eTAb/Lx+fr6Rqtw3aBMKxMfQbDELOUqcANfc4fCaWKoGVgrxzCv2wVGaaIV7hu2zkdL20lRJVArRK8svKWKCGnJqsLHAnwtq2lU9mp16rL0sO5XWl971UeD6iPf4l1HrttuGthXs4fsa93PBVf25Rlz2DAuY0oUyvc8iQDjg+pfe+X+zFWH0d+wpr8McVr0NzD6Gzb2N6jrz5f9jQ735xv9+af1p/TpH+xvG1fMiMbarFB8V+ZFHjOKcDgbveZ+Ylxp9GCFj5X56bfp5+MrQUEGEQlDHfARiAMezZkgsdnTaUJxrzc8ALn9nn8IcWv9iAjGR3XxbOGKRm8W8dY4XJFzPTVeMZFUrDJ+21KOSvFJZmnVRZNIfHaamOQMkjSBIhqsVWOWIPTr1j7FjGohondQxDXTRbOOgZRZ+sej1okGvh3gg8NFXNZySOMYJikKQP7fcfrQDX9wKNJwD4cvfN1OU/ncrlFWp3GtZVsQHvKh4siCI5MEgcwJHBsS8ehNBLNbwQHpbGrWA7SKR+CREb+V4f8QoHKZT+dMR2Uhf+PqqdqOI8BYooN9We/Vg1xbs7BjG2RR57hpINaVy1gg6BpHESI2pe/FyZZp1hVl47g3NwsShsyh1ErFf9Vwmn17d+e5RyUuq5lVLZ+SG6JKrNni1WMa7nG4EMdAHLLdpN2aFWxRTdYQWyI9kW9LHXFUFbHeCiaO15P4sEtLLSqWV2ITxqtNsqkp5YxeqSO1yP8GMmRpbT3Z6o3qk622Ms3rNoctlh2FCKdJDJ8DkKVSBe8mjYRlmQRNA6AkMkn+uU05Xj7nSbU6MhugDyrmLwMMLI69BRqCOLIy6PvuJgUIpqgLzCenDqtKdn2zwVXNH5k3OzI91U7c5FvPyMQyQUsTcXQIzEZ1+bJhD8jjpJg/g78xhALA5bZBtrbuyn0Fyjbgz8KouiBkOE3AlEZoB9QAYME9lOcpUy2jdnB3p5RbU/7JPXWnSMPaQ7nOHItl1Oo17DNkDbxi/0rZqUr0ol0CSYSiL9Vc1/ER6OGVVztIOHb9YY0ipKeweNNQntcNQEKlhVQwKIOZYVuYaaFacShLqpcK6+XP4jCjP6z0nJVqfXdVuTR0z61A4RvyaIDiiY3IoyjOI05xsTRqmTVuM+JvIqIYjLcV89UNChq2Rdn2rGEp/Td3FHKvmtPVKkalncA60hg/HiTka0weMFm1abACsu7JzCuAbdWjJeytweJj+rfaR2uVnlBdU/T/Gxw34lb3OJw/Dc8vfwQ/M5rAFeQoCxgUYYTFsav4WcQPFPy2PE8B2iUxDjFXaYviLo8Ti8s84A/ydJojL0gBuTxniMiAQ5zoaj0NQctZCFrZRqfGONQpID0dUfOk+12yX8Dj8UsLuxl8fzIWjvg7ZK3k97rfr/b+y83ciC/+y4XRo67vXteNANOvOezyF5EQ/G2pTimLYyKAU7UbIk91yLUwuPjHjdsBf5SbpiuYAOcjUP4DcvCPG7kHuF+kGscJK+PdfW2IYjEhFZJhso8L6peYh/j7fTiukaFFAkuuDcdvKB74KDIT5PeXuNpv6yOwtrjv90wQvq26s0f/Ma2rR684fyyO8DN1GCzbGdvgKIrRGy9O2s8jMfbyiojlvKWKoKfqBHG2TXP52xYjDraE4zgLqSkDNEGkCxjlkKMUpBtK+Tp+BuI+h2TpQGrurUQKArjkeVq2MMv7s/szq93LTZ4PuhZcuZD6YJySrhyNrm5GeNlDM7ddiV7VFZ0ntHjAYk8pfSidEJCa7uQT6VLKADEBhDoMJQjm2yAnVdvnpV6RlKom71vnp9qMcvvQLhvrV0PB8XFYycr2KZw245/vdL+KZS2TdDK3bu9KS02KUQ6y6Xtx7UZo9bZ8Hj2qr9GtulYmzodnSAvE8RcVgYndsgu0gyHPJwtdKpTOkhYiuut0wUJeX0AkBel2wRWSKRk0IKM0dgQ/iZOGjMaxdVdBxB9Xjft7dadqSod6+m0P9RzIsohbsTmSbTC5GLhMvFlg5EWP6+ZNuz03+cQfWSd+RSulrTKzlaAsT91xc2sI8fUt9tW/1W5F35bFOjQ6bXcoyor4NdvjMw6tV1Nmr4vF9BzsqQ3kl1synWOyRgzztz4rcTizeZqiLVK9Ya6q29oLH8thw12wvUNoNecqplaH7N229Q9437p2WjvE7isFKW38vFKYprbae/hjsxevFr/5kuMb6OSoDo5SVBvL7x+xYO0lC8eTh597m9S56pQ9/v4Ae8NhZIFWVnff+lzd0Sf22hwCbD7QfPpRt0Pnuq/bOWSvc8woibGpGxrPO+a01RvxcujG0cHdu/43U5P17s7x6dFRD0yzi/xdoKZZdu8ZCCMWbzSQt/fTLlBx4QKytHo1uHgZwJqmvO7+ned/o2OsdbcK9emxn5vld3ociJ7zBrSwuaudKK+Np2v0ksHqExbJ71xJTUxK+jpoyAba8t6i6qlo+cab43mr9FN994pruxSQt81xwmFywl09r93Mab4karyjIlvt8udE+Lp0u9hgzVjt137lS2MOHgjMXiHT9sLlS+OrBn7XI+Bt5k6ta6mDwZem93p0QfPrQazi+8dc83k1Ruxfw9NpFqzCfHaKk0YodhIcPogyRh+xvKtsnFyubSMLxsT1YxmMta4h1EWPuf5cajbCMKarAwMxPvG+1fG6FSkJjpNmfsbN94w9i8xBkOdxC48GvuZ543Gy+1DkjOUXew2Hr7ebRRU5JEb2vasu2P9xe57X+WBnvqTA/RUwLVVRyaHF4h1g+SsTFnRXK5Xise7Is51T3/3PcMqguPtSl66Ro1B+F4ms6kCGoBJTGkiboSg7R6A2S656YLqGZIUiZ4ljlAJxLhCk280GsmcZCYELdX455c/i+n3pzQn7ek4qcrHfCYSbV3VOfAFIWcDyOyKOXPy88s5X/SLMoul+8/Fwu1SveZvEwQTYS6PJ1HRtf/1WtfpbvWbp7N3Lu38D",
      "base64"
    )).toString("utf8");
    const legacyDir = path.join(upgradeTmp, "legacy");
    const legacyThemePath = path.join(legacyDir, "themes", "chatgpt-app.json");
    fs.mkdirSync(path.dirname(legacyThemePath), { recursive: true });
    fs.writeFileSync(legacyThemePath, v010ThemeRaw);
    const upgRes = installThemeAt(legacyDir, { officialOnly: false, createSettingsIfMissing: true });
    assert.equal(upgRes.backupPath, null, "Upgrading known unmodified historical v0.1.x theme must not create a false user-custom backup");
    assert.equal(uninstallTheme(legacyDir).action, "removed", "Uninstalling after v0.1.x -> v0.2.0 upgrade must cleanly remove enhancer theme");

    // User-edited pre-layer v0.1.x theme (containing --cx-surface & --cx-ink-1) must NOT be misidentified as unmodified or deleted
    const legacyEditedDir = path.join(upgradeTmp, "legacy-edited");
    const legacyEditedPath = path.join(legacyEditedDir, "themes", "chatgpt-app.json");
    fs.mkdirSync(path.dirname(legacyEditedPath), { recursive: true });
    const legacyEditedObj = JSON.parse(v010ThemeRaw);
    legacyEditedObj.css += "\n/* user custom v0.1.0 css edit */\n";
    fs.writeFileSync(legacyEditedPath, JSON.stringify(legacyEditedObj, null, 2) + "\n");
    assert.equal(uninstallTheme(legacyEditedDir).action, "kept-custom-theme", "Uninstalling over edited legacy v0.1.x theme must never delete user edits");
    assert(fs.readFileSync(legacyEditedPath, "utf8").includes("user custom v0.1.0 css edit"));
    const legacyEditedInstall = installThemeAt(legacyEditedDir, { officialOnly: false, createSettingsIfMissing: true });
    assert(legacyEditedInstall.backupPath && fs.existsSync(legacyEditedInstall.backupPath), "Installing over edited legacy v0.1.x theme must back up user CSS");
    assert.equal(uninstallTheme(legacyEditedDir).action, "restored-backup");
    assert(fs.readFileSync(legacyEditedPath, "utf8").includes("user custom v0.1.0 css edit"));

    const customDir = path.join(upgradeTmp, "custom");
    const customThemePath = path.join(customDir, "themes", "chatgpt-app.json");
    fs.mkdirSync(path.dirname(customThemePath), { recursive: true });
    fs.writeFileSync(customThemePath, JSON.stringify({ name: "My Custom Theme", css: ":root { color: red; }" }));
    const custRes = installThemeAt(customDir, { officialOnly: false, createSettingsIfMissing: true });
    assert(custRes.backupPath && fs.existsSync(custRes.backupPath), "Genuine third-party theme at same ID must be backed up");
    assert.equal(uninstallTheme(customDir).action, "restored-backup", "Uninstalling must restore backed up third-party theme");
    assert.equal(JSON.parse(fs.readFileSync(customThemePath, "utf8")).name, "My Custom Theme");
    assert.equal(getThemeStatus(customDir).hasBackup, false);

    // Shared settings written by the running official app between prepare and rollback must survive the rollback
    const sharedTxDir = path.join(upgradeTmp, "shared-tx");
    const sharedTxSettings = path.join(sharedTxDir, "settings.json");
    fs.mkdirSync(sharedTxDir, { recursive: true });
    fs.writeFileSync(sharedTxSettings, JSON.stringify({ zoom: 1 }));
    const sharedTx = prepareThemeTransaction(sharedTxDir, { createSettingsIfMissing: true });
    fs.writeFileSync(sharedTxSettings, JSON.stringify({ zoom: 2 }));
    sharedTx.rollback();
    assert.deepEqual(JSON.parse(fs.readFileSync(sharedTxSettings, "utf8")), { zoom: 2 }, "Rollback before commit must not touch settings");
    const sharedTx2 = prepareThemeTransaction(sharedTxDir, { createSettingsIfMissing: true });
    fs.writeFileSync(sharedTxSettings, JSON.stringify({ zoom: 3 }));
    assert.equal(sharedTx2.commit().activated, true);
    sharedTx2.rollback();
    assert.deepEqual(JSON.parse(fs.readFileSync(sharedTxSettings, "utf8")), { zoom: 3 }, "Rollback must restore settings as of commit, not as of prepare");

    // User-edited CSS inside chatgpt-app.json + prior defaultTheme must both survive direct uninstall, reinstall & uninstall
    const editedDir = path.join(upgradeTmp, "edited-theme");
    fs.mkdirSync(path.join(editedDir, "themes"), { recursive: true });
    fs.writeFileSync(
      path.join(editedDir, "settings.json"),
      JSON.stringify({ defaultTheme: "tokyo-night", defaultThemeSetAt: "2026-01-01T00:00:00.000Z" }, null, 2)
    );
    installThemeAt(editedDir, { officialOnly: false });
    assert.equal(JSON.parse(fs.readFileSync(path.join(editedDir, "settings.json"), "utf8")).defaultTheme, "chatgpt-app");
    const themeStateObj = JSON.parse(fs.readFileSync(path.join(editedDir, ".t3code-enhancer-theme-state"), "utf8"));
    assert.equal(themeStateObj.enhancerVersion, require("../lib/version.cjs").ENHANCER_VERSION, "Theme state must record standardized enhancerVersion");
    assert.equal(uninstallTheme(editedDir).action, "removed");
    assert.equal(JSON.parse(fs.readFileSync(path.join(editedDir, "settings.json"), "utf8")).defaultTheme, "tokyo-night", "Uninstall must restore pre-install defaultTheme");
    assert.equal(JSON.parse(fs.readFileSync(path.join(editedDir, "settings.json"), "utf8")).defaultThemeSetAt, "2026-01-01T00:00:00.000Z");

    installThemeAt(editedDir, { officialOnly: false });
    const editedThemeFile = path.join(editedDir, "themes", "chatgpt-app.json");
    const editedObj = JSON.parse(fs.readFileSync(editedThemeFile, "utf8"));
    editedObj.css += "\n/* user custom edit */\n";
    fs.writeFileSync(editedThemeFile, JSON.stringify(editedObj, null, 2) + "\n");
    const directUninst = uninstallTheme(editedDir);
    assert.equal(directUninst.action, "kept-custom-theme", "Direct uninstall must preserve user-customized theme edits");
    assert(fs.existsSync(editedThemeFile) && fs.readFileSync(editedThemeFile, "utf8").includes("user custom edit"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(editedDir, "settings.json"), "utf8")).defaultTheme, "tokyo-night", "Direct uninstall keeping custom theme must still restore pre-install defaultTheme");
    const reInst = installThemeAt(editedDir, { officialOnly: false });
    assert(reInst.backupPath && fs.existsSync(reInst.backupPath), "Reinstalling over edited theme must back up customized CSS");
    const reUninst = uninstallTheme(editedDir);
    assert.equal(reUninst.action, "restored-backup");
    assert(fs.readFileSync(editedThemeFile, "utf8").includes("user custom edit"), "Uninstall after reinstall must restore backed-up custom CSS");
    assert.equal(JSON.parse(fs.readFileSync(path.join(editedDir, "settings.json"), "utf8")).defaultTheme, "tokyo-night", "Restoring backed-up enhancer edit must still restore pre-install defaultTheme");

    // Existing third-party backup + live edits -> direct uninstall saves live edits AND restores third-party;
    // existing third-party backup + live edits + reinstall -> uninstall restores latest user edit FIRST (keeping third-party backup) & restores defaultTheme
    const stackDir = path.join(upgradeTmp, "stack-theme");
    const stackThemeFile = path.join(stackDir, "themes", "chatgpt-app.json");
    fs.mkdirSync(path.dirname(stackThemeFile), { recursive: true });
    fs.writeFileSync(path.join(stackDir, "settings.json"), JSON.stringify({ defaultTheme: "solarized", defaultThemeSetAt: "2026-02-02T00:00:00.000Z" }));
    fs.writeFileSync(stackThemeFile, JSON.stringify({ name: "My Third-Party Theme", css: ":root { color: blue; }" }));
    installThemeAt(stackDir, { officialOnly: false });
    const stackLive1 = JSON.parse(fs.readFileSync(stackThemeFile, "utf8"));
    stackLive1.css += "\n/* unsaved live css edit 1 */\n";
    fs.writeFileSync(stackThemeFile, JSON.stringify(stackLive1, null, 2) + "\n");
    const uninstPreserving = uninstallTheme(stackDir);
    assert.equal(uninstPreserving.action, "restored-backup");
    assert(uninstPreserving.preservedPath && fs.existsSync(uninstPreserving.preservedPath), "Direct uninstall with existing backup must save live edits before restoring backup");
    assert(fs.readFileSync(uninstPreserving.preservedPath, "utf8").includes("unsaved live css edit 1"));
    assert.equal(JSON.parse(fs.readFileSync(stackThemeFile, "utf8")).name, "My Third-Party Theme");
    assert.equal(JSON.parse(fs.readFileSync(path.join(stackDir, "settings.json"), "utf8")).defaultTheme, "solarized");

    installThemeAt(stackDir, { officialOnly: false });
    const stackLive2 = JSON.parse(fs.readFileSync(stackThemeFile, "utf8"));
    stackLive2.css += "\n/* edited before reinstall 2 */\n";
    fs.writeFileSync(stackThemeFile, JSON.stringify(stackLive2, null, 2) + "\n");
    installThemeAt(stackDir, { officialOnly: false });
    const lifoUninst = uninstallTheme(stackDir);
    assert.equal(lifoUninst.action, "restored-backup");
    assert(fs.readFileSync(stackThemeFile, "utf8").includes("edited before reinstall 2"), "Uninstall after reinstall must restore latest user edit backup first");
    assert.equal(lifoUninst.remainingBackups.length >= 1, true, "Older third-party backup must remain preserved on disk");
    assert.equal(JSON.parse(fs.readFileSync(path.join(stackDir, "settings.json"), "utf8")).defaultTheme, "solarized");
    assert.equal(JSON.parse(fs.readFileSync(path.join(stackDir, "settings.json"), "utf8")).defaultThemeSetAt, "2026-02-02T00:00:00.000Z");

    // Pre-existing active chatgpt-app must not refresh defaultThemeSetAt on install or lose it on uninstall
    const preActiveDir = path.join(upgradeTmp, "pre-active");
    const preActiveSettings = path.join(preActiveDir, "settings.json");
    fs.mkdirSync(preActiveDir, { recursive: true });
    fs.writeFileSync(preActiveSettings, JSON.stringify({ defaultTheme: "chatgpt-app", defaultThemeSetAt: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n");
    const preActiveBefore = fs.readFileSync(preActiveSettings, "utf8");
    installThemeAt(preActiveDir, { officialOnly: false });
    assert.equal(fs.readFileSync(preActiveSettings, "utf8"), preActiveBefore, "Install must not refresh defaultThemeSetAt when chatgpt-app is already active");
    assert.equal(uninstallTheme(preActiveDir).action, "removed");
    assert.deepEqual(JSON.parse(fs.readFileSync(preActiveSettings, "utf8")), { defaultTheme: "chatgpt-app", defaultThemeSetAt: "2026-01-01T00:00:00.000Z" }, "Uninstall must preserve pre-existing chatgpt-app defaultThemeSetAt");

    // Re-installing over enhancer-activated chatgpt-app must not refresh defaultThemeSetAt and must keep prior defaultThemeSetAt for uninstall
    const reActiveDir = path.join(upgradeTmp, "re-active");
    const reActiveSettings = path.join(reActiveDir, "settings.json");
    fs.mkdirSync(reActiveDir, { recursive: true });
    fs.writeFileSync(reActiveSettings, JSON.stringify({ defaultTheme: "tokyo-night", defaultThemeSetAt: "2026-01-01T00:00:00.000Z" }));
    installThemeAt(reActiveDir, { officialOnly: false });
    const afterFirstActive = fs.readFileSync(reActiveSettings, "utf8");
    installThemeAt(reActiveDir, { officialOnly: false });
    assert.equal(fs.readFileSync(reActiveSettings, "utf8"), afterFirstActive, "Re-install must not rewrite settings when chatgpt-app is already active");
    assert.equal(uninstallTheme(reActiveDir).action, "removed");
    assert.deepEqual(JSON.parse(fs.readFileSync(reActiveSettings, "utf8")), { defaultTheme: "tokyo-night", defaultThemeSetAt: "2026-01-01T00:00:00.000Z" });

    // Manually installed theme matching bundled full or official content (without enhancer state) must never be deleted on uninstall
    const bundledThemeRaw = fs.readFileSync(SOURCE_THEME_PATH, "utf8");
    const bundledOfficialRaw = JSON.stringify(extractOfficialTheme(JSON.parse(bundledThemeRaw)), null, 2) + "\n";
    for (const [label, sampleRaw] of [["full", bundledThemeRaw], ["official", bundledOfficialRaw]]) {
      const manualDir = path.join(upgradeTmp, `manual-${label}`);
      const manualThemePath = path.join(manualDir, "themes", "chatgpt-app.json");
      fs.mkdirSync(path.dirname(manualThemePath), { recursive: true });
      fs.writeFileSync(manualThemePath, sampleRaw);
      assert.equal(uninstallTheme(manualDir).action, "kept-custom-theme", `Direct uninstall must not delete manually installed ${label} theme`);
      assert.equal(fs.readFileSync(manualThemePath, "utf8"), sampleRaw);
      const manualInstall = installThemeAt(manualDir, { officialOnly: false, createSettingsIfMissing: true });
      assert(manualInstall.backupPath && fs.existsSync(manualInstall.backupPath), `Install over manual ${label} theme must back it up`);
      assert.equal(uninstallTheme(manualDir).action, "restored-backup", `Uninstall after install must restore manual ${label} theme`);
      assert.equal(fs.readFileSync(manualThemePath, "utf8"), sampleRaw);
    }

    // Symlinked settings.json must stay a symlink across install, rollback, and uninstall (valid & dangling targets)
    const symSettingsRoot = path.join(upgradeTmp, "sym-settings");
    const symDataDir = path.join(symSettingsRoot, "userdata");
    const symDotfilesDir = path.join(symSettingsRoot, "dotfiles");
    fs.mkdirSync(symDataDir, { recursive: true });
    fs.mkdirSync(symDotfilesDir, { recursive: true });
    const realSettingsPath = path.join(symDotfilesDir, "settings.json");
    const linkSettingsPath = path.join(symDataDir, "settings.json");
    fs.writeFileSync(realSettingsPath, JSON.stringify({ defaultTheme: "nord", defaultThemeSetAt: "2026-03-03T00:00:00.000Z" }));
    let settingsSymlinkCreated = false;
    try {
      fs.symlinkSync(realSettingsPath, linkSettingsPath, "file");
      settingsSymlinkCreated = true;
    } catch (err) {
      if (!["EPERM", "EACCES"].includes(err?.code)) throw err;
    }
    if (settingsSymlinkCreated) {
      const symTx = prepareThemeTransaction(symDataDir, { createSettingsIfMissing: true });
      symTx.commit();
      assert(fs.lstatSync(linkSettingsPath).isSymbolicLink(), "Commit must keep settings.json as a symlink");
      assert.equal(JSON.parse(fs.readFileSync(realSettingsPath, "utf8")).defaultTheme, "chatgpt-app");
      symTx.rollback();
      assert(fs.lstatSync(linkSettingsPath).isSymbolicLink(), "Rollback must keep settings.json as a symlink");
      assert.equal(JSON.parse(fs.readFileSync(realSettingsPath, "utf8")).defaultTheme, "nord");

      installThemeAt(symDataDir, { createSettingsIfMissing: true });
      assert(fs.lstatSync(linkSettingsPath).isSymbolicLink(), "Install must keep settings.json as a symlink");
      assert.equal(JSON.parse(fs.readFileSync(realSettingsPath, "utf8")).defaultTheme, "chatgpt-app");
      uninstallTheme(symDataDir);
      assert(fs.lstatSync(linkSettingsPath).isSymbolicLink(), "Uninstall must keep settings.json as a symlink");
      assert.equal(JSON.parse(fs.readFileSync(realSettingsPath, "utf8")).defaultTheme, "nord");
      assert.equal(JSON.parse(fs.readFileSync(realSettingsPath, "utf8")).defaultThemeSetAt, "2026-03-03T00:00:00.000Z");

      // Dangling symlink target created at commit must be cleaned up on rollback without deleting the symlink
      const danglingDir = path.join(symSettingsRoot, "dangling-userdata");
      const danglingTarget = path.join(symDotfilesDir, "dangling-settings.json");
      const danglingLink = path.join(danglingDir, "settings.json");
      fs.mkdirSync(danglingDir, { recursive: true });
      fs.symlinkSync(danglingTarget, danglingLink, "file");
      const danglingTx = prepareThemeTransaction(danglingDir, { createSettingsIfMissing: true });
      assert.equal(danglingTx.commit().activated, true);
      assert(fs.lstatSync(danglingLink).isSymbolicLink(), "Dangling symlink commit must preserve symlink");
      assert(fs.existsSync(danglingTarget), "Dangling symlink commit must materialize target file");
      danglingTx.rollback();
      assert(fs.lstatSync(danglingLink).isSymbolicLink(), "Dangling symlink rollback must preserve symlink");
      assert(!fs.existsSync(danglingTarget), "Dangling symlink rollback must remove newly created target");
    }

    // Linux shared-data paths must honor custom T3CODE_HOME consistently with launch.sh
    const customLinuxHome = path.join(upgradeTmp, "custom-t3-home");
    const customLinuxPaths = linuxCli.getLinuxPaths({ XDG_DATA_HOME: path.join(upgradeTmp, "xdg"), T3CODE_HOME: customLinuxHome }, upgradeTmp);
    assert.equal(customLinuxPaths.sharedUserdata, path.join(path.resolve(customLinuxHome), "userdata"));
    assert.equal(linuxCli.getUserdataDir(true, customLinuxPaths), path.join(path.resolve(customLinuxHome), "userdata"));
    const customSharedRes = linuxCli.prepareProfile(true, { officialOnly: false }, customLinuxPaths);
    assert.equal(customSharedRes.targetPath, path.join(path.resolve(customLinuxHome), "userdata", "themes", "chatgpt-app.json"));
    const customOrigLog = console.log;
    console.log = () => {};
    try {
      linuxCli.uninstall(new Set(["--theme-only", "--shared-data"]), customLinuxPaths);
    } finally {
      console.log = customOrigLog;
    }
    assert(!fs.existsSync(customSharedRes.targetPath), "Linux theme-only shared uninstall must remove theme from custom T3CODE_HOME");
    const blankHomePaths = linuxCli.getLinuxPaths({ XDG_DATA_HOME: path.join(upgradeTmp, "xdg"), T3CODE_HOME: "   " }, upgradeTmp);
    assert.equal(blankHomePaths.sharedUserdata, path.join(upgradeTmp, ".t3", "userdata"));

    // Legacy 0.1.11 managed Linux install status must guide upgrade cleanly instead of crashing inspectInstall
    const legacyLinuxPaths = linuxCli.getLinuxPaths({ XDG_DATA_HOME: path.join(upgradeTmp, "xdg") }, upgradeTmp);
    fs.mkdirSync(path.join(legacyLinuxPaths.installDirectory, "squashfs-root", "resources"), { recursive: true });
    fs.writeFileSync(path.join(legacyLinuxPaths.installDirectory, linuxCli.MANAGED_FILE), "0.1.11\n");
    fs.writeFileSync(path.join(legacyLinuxPaths.installDirectory, linuxCli.APP_ASAR), "not-an-asar");
    const origLog = console.log;
    let statusOutput = "";
    console.log = (...args) => { statusOutput += args.join(" ") + "\n"; };
    try {
      linuxCli.status(legacyLinuxPaths);
    } finally {
      console.log = origLog;
    }
    assert(statusOutput.includes("v0.1.0 / v0.1.1"), "Linux status() should explain upgrade path for legacy managed installs");

    // Legacy incompatible macOS managed install status should also degrade gracefully
    const legacyMacPaths = macosCli.getMacosPaths(upgradeTmp);
    fs.mkdirSync(path.join(legacyMacPaths.installDirectory, "Contents", "Resources"), { recursive: true });
    fs.writeFileSync(path.join(legacyMacPaths.installDirectory, macosCli.INFO_PLIST), '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>');
    fs.writeFileSync(path.join(legacyMacPaths.installDirectory, macosCli.APP_ASAR), "not-an-asar");
    // Ensure inspectInstall throws without crashing macosCli.status when bundle is unmanaged vs managed:
    assert.throws(() => macosCli.status(undefined, legacyMacPaths), /安装位置已被其他应用占用|plutil/);
  } finally {
    fs.rmSync(upgradeTmp, { recursive: true, force: true });
  }
}

function floatingRuntimeIsExternal(asar) {
  return hostWithRuntime(asar, workspaceFloatingPanels).assets.some((a) => /\/t3e-floating-panels-ui-[0-9a-f]{8}\.js$/.test(a.key));
}

// Once workspace-floating-panels ships its UI as external t3e-*.js assets (floating-panels-ui + tab-bar-ui), the host chunks
// only hold the generated bridges, so the legacy inline-source extraction in Suites 5-8 and 10 no longer applies.
function verifyExternalFloatingRuntime(asar) {
  const host = hostWithRuntime(asar, workspaceFloatingPanels);
  const tabHost = hostWithRuntime(asar, workspaceFloatingPanels.tabBarPatch);
  assert(host.assets.some((a) => /\/t3e-floating-panels-ui-[0-9a-f]{8}\.js$/.test(a.key)), "Host must import the floating-panels runtime asset");
  assert(tabHost.assets.some((a) => /\/t3e-tab-bar-ui-[0-9a-f]{8}\.js$/.test(a.key)), "Tab bar chunk must import the tab-bar runtime asset");
  assert(host.text.includes(workspaceFloatingPanels.marker) && /\bcreateFloatingPanelsRuntime\b/.test(host.text), "Host must emit the createFloatingPanelsRuntime bridge");
  assert(tabHost.text.includes(workspaceFloatingPanels.tabBarPatch.marker) && /\bcreateTabBarRuntime\b/.test(tabHost.text), "Tab bar chunk must emit the createTabBarRuntime bridge");
  verifyRuntimeAssets(asar, ["floating-panels-ui", "tab-bar-ui"]);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const ui = loadRuntimeModule("floating-panels-ui").exports;
  const tabs = loadRuntimeModule("tab-bar-ui").exports;
  assert.deepEqual(plain(ui.workspaceFloatFrame({ x: 120, y: 80, width: 360, height: 240 }, { width: 800, height: 600 }, "move", 1000, -1000)), { x: 432, y: 8, width: 360, height: 240 });
  assert.deepEqual(plain(ui.workspaceSnapFrame({ x: 20, y: 200, width: 300, height: 200 }, { width: 800, height: 600 })), { x: 8, y: 200, width: 300, height: 200 });
  assert.deepEqual(plain(ui.defaultChatFloatFrame({ width: 1100, height: 700 })), { x: 688, y: 208, width: 396, height: 476 });
  assert.equal(tabs.tabDroppedOutside({ top: 32, bottom: 64 }, 48, 96), true);
  assert.equal(tabs.tabDroppedOutside({ top: 32, bottom: 64 }, 48, 74), false);
  // Floating panels must read live store surfaces (ja.surfaces), not exit-presence surfaces that empty on rightPanelStore.close()
  assert.match(host.text, /T3WorkspacePanels,\{threadKey:[\w$]+,panelProps:T3panelProps,surfaces:[\w$]+\.surfaces,/, "T3WorkspacePanels must receive live store surfaces so floating the last tab stays open");
  const floatAssetText = host.assets.find((a) => /\/t3e-floating-panels-ui-/.test(a.key)).text;
  assert(floatAssetText.includes("T3FloatContext.Provider, { value: null"), "T3SurfaceMount must isolate embedded subagent threads from parent T3FloatContext");
  assert(floatAssetText.includes("activeSurfaceId: surface.id"), "Floating surfaces must keep activeSurfaceId bound so linked-thread stays visible");
  assert(floatAssetText.includes("inset-inline: -1px auto; width: 6px;"), "Split divider separator must not overlap the adjacent scrollbar");
  assert(floatAssetText.includes("t3e-floating-preview-frame") && !floatAssetText.includes("t3e-floating-preview-actions"),
    "Floating browser must persist its frame and use the full header drag bar instead of cramped subheader overlay buttons");
  assert(floatAssetText.includes("t3e-layout-swap-btn") && !floatAssetText.includes("t3e-divider-swap-btn"),
    "Layout swap control must live in the panel top toolbar instead of a floating pill on the vertical divider");
  assert.match(host.text, /T3PanelToolbar,\{fullscreen:[\w$]+,sheet:[\w$]+,maximize:/,
    "T3PanelToolbar must receive sheet prop to hide layout swap in compact sheet mode");
  assert.match(host.text, /cornerRadius=floating\?\([\w$.]+\.cornerRadius\|\|13\):[\w$.]+\.cornerRadius/,
    "Floating browser presentation must pass rounded inner cornerRadius (13px) to native webview host");
  assert(
    floatAssetText.includes('background: var(--cx-selected, rgba(0, 0, 0, 0.08)) !important;') &&
      !floatAssetText.includes('background: var(--cx-accent-soft, color-mix(in srgb, var(--cx-accent, var(--primary)) 12%, transparent)) !important;'),
    "Active topbar chat toolbar toggle buttons must use neutral gray instead of blue accent"
  );
  // Verify T3ChatColumnShell does not crash when rendered inside an embedded side-chat (T3FloatContext = null)
  const floatRuntime = ui.createFloatingPanelsRuntime({
    React: {
      Fragment: Symbol("Fragment"),
      memo: (fn) => fn,
      createContext: (def) => ({ _def: def, Provider: "Provider" }),
      useContext: () => null,
      useRef: (init) => ({ current: init }),
      useState: (init) => [typeof init === "function" ? init() : init, () => {}],
      useEffect() {},
      useLayoutEffect() {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
    },
    jsx: (type, props) => ({ type, props: props || {} }),
    jsxs: (type, props) => ({ type, props: props || {} }),
    useI18n: () => (s) => s,
    rightPanelStore: { getState: () => ({}), subscribe: () => () => {} },
    getPanelState: () => ({ open: false, surfaces: [], activeSurfaceId: null }),
  });
  const nullCtxShell = floatRuntime.T3ChatColumnShell({ className: "chat", maximizedAway: false, workState: "idle", children: null });
  assert.equal(nullCtxShell.props["data-chat-column"], true, "T3ChatColumnShell must render cleanly when T3FloatContext is null (side chat)");
  let swapCalls = 0;
  const mockCtx = {
    swapped: false,
    chatFloat: null,
    chatSelected: false,
    showMainChat: () => {},
    toggleSwap: () => { swapCalls += 1; },
    labels: { swapLayout: "Swap layout", pillIdle: "Main chat" },
  };
  const toolbarRuntime = ui.createFloatingPanelsRuntime({
    React: {
      Fragment: Symbol("Fragment"),
      memo: (fn) => fn,
      createContext: (def) => ({ _def: def, Provider: "Provider" }),
      useContext: () => mockCtx,
      useRef: (init) => ({ current: init }),
      useState: (init) => [typeof init === "function" ? init() : init, () => {}],
      useEffect() {},
      useLayoutEffect() {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
    },
    jsx: (type, props) => ({ type, props: props || {} }),
    jsxs: (type, props) => ({ type, props: props || {} }),
    Tooltip: "Tooltip",
    TooltipTrigger: "TooltipTrigger",
    TooltipPopup: "TooltipPopup",
    useI18n: () => (s) => s,
    rightPanelStore: { getState: () => ({}), subscribe: () => () => {} },
    getPanelState: () => ({ open: false, surfaces: [], activeSurfaceId: null }),
  });
  const splitToolbar = toolbarRuntime.T3PanelToolbar({ fullscreen: false, sheet: false, maximize: "MAX", toggle: "TOG" });
  const splitActions = splitToolbar.props.children[1].props.children;
  assert.equal(splitActions[0].type, toolbarRuntime.T3LayoutSwapButton, "Split panel toolbar must render T3LayoutSwapButton");
  assert.equal(splitActions[1], "MAX");
  assert.equal(splitActions[2], "TOG");
  const swapTooltip = toolbarRuntime.T3LayoutSwapButton();
  assert.equal(swapTooltip.props.children[1].props.side, "bottom");
  const swapBtnEl = swapTooltip.props.children[0].props.render;
  assert.equal(swapBtnEl.props.className, "t3e-layout-swap-btn");
  swapBtnEl.props.onClick({ stopPropagation() {} });
  assert.equal(swapCalls, 1);
  assert.equal(toolbarRuntime.T3PanelToolbar({ fullscreen: true, sheet: false, maximize: "MAX", toggle: "TOG" }).props.children[1].props.children[0], null);
  assert.equal(toolbarRuntime.T3PanelToolbar({ fullscreen: false, sheet: true, maximize: "MAX", toggle: "TOG" }).props.children[1].props.children[0], null);
}

function verifyFloatingPanelPortal(asar) {
  if (floatingRuntimeIsExternal(asar)) return verifyExternalFloatingRuntime(asar);
  const chunk = findUniqueEntry(asar, workspaceFloatingPanels.targetRegex, workspaceFloatingPanels.id);
  const source = chunk.content.toString("utf8");
  const rolldownImport = source.match(/import\{i as e\}from"(\.\/rolldown-runtime-[\w-]+\.js)"/);
  const reactDomImport = source.match(/import\{[^}]*\br\b[^}]*\}from"(\.\/with-selector-[\w-]+\.js)"/);
  const surfaceEqHelpers = source.match(/^function t3ShallowObjEqual\([\s\S]+?^function t3SurfaceMountPropsEqual\([\s\S]+?^\}/m);
  const surfaceMount = source.match(/^const T3SurfaceMount = Z\.memo\([\s\S]+?^\}, t3SurfaceMountPropsEqual\);/m);
  assert(rolldownImport && reactDomImport && surfaceEqHelpers && surfaceMount, "Missing native React DOM binding or injected surface mount");

  // Verify T3SurfaceMount prop comparator bails out when ChatView rebuilds shallow-equal panelProps
  const { t3SurfaceMountPropsEqual } = runInNewContext(
    surfaceEqHelpers[0] + "\n({ t3SurfaceMountPropsEqual })",
    {}
  );
  const sharedSurf = { id: "s1", kind: "diff" };
  const sharedRef = { environmentId: "e1", threadId: "t1" };
  const sharedOpenDiff = () => {};
  const mkPanelProps = (extra = {}) => ({
    surface: sharedSurf,
    activeSurfaceId: "s1",
    threadRef: sharedRef,
    environmentId: "e1",
    visible: true,
    sideChatParentPanel: { openToolDiff: sharedOpenDiff },
    terminal: { launchContext: null, keybindings: "kb", onNewTerminal: extra.onNewTerminal },
    pullRequest: { capabilityKnown: true, projectId: "p1" },
    files: { projectId: "p1", workspaceRoot: "C:/repo" },
    ...extra,
  });
  const onNewTerm = () => {};
  const pp1 = mkPanelProps({ terminal: { launchContext: null, keybindings: "kb", onNewTerminal: onNewTerm } });
  const pp2 = mkPanelProps({ terminal: { launchContext: null, keybindings: "kb", onNewTerminal: onNewTerm } });
  assert.equal(t3SurfaceMountPropsEqual(
    { surface: sharedSurf, slot: null, parkingSlot: null, visible: true, floating: false, onFloatNew: onNewTerm, panelProps: pp1 },
    { surface: sharedSurf, slot: null, parkingSlot: null, visible: true, floating: false, onFloatNew: onNewTerm, panelProps: pp2 }
  ), true, "T3SurfaceMount comparator must treat fresh shallow-equal panelProps as unchanged");
  const ppChanged = mkPanelProps({ visible: false, terminal: { launchContext: null, keybindings: "kb", onNewTerminal: onNewTerm } });
  assert.equal(t3SurfaceMountPropsEqual(
    { surface: sharedSurf, slot: null, parkingSlot: null, visible: true, floating: false, onFloatNew: onNewTerm, panelProps: pp1 },
    { surface: sharedSurf, slot: null, parkingSlot: null, visible: true, floating: false, onFloatNew: onNewTerm, panelProps: ppChanged }
  ), false, "T3SurfaceMount comparator must re-render when a field changes");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-react-dom-"));
  const files = new Set();
  function writeFile(name, text) {
    fs.writeFileSync(path.join(dir, name), text);
    files.add(name);
  }
  function copyModule(name) {
    if (files.has(name)) return;
    const record = asar.byKey.get(path.posix.join(path.posix.dirname(chunk.key), name));
    assert(record, "Missing archived module: " + name);
    const offset = Number(record.entry.offset);
    const text = asar.body.toString("utf8", offset, offset + record.entry.size);
    writeFile(name, text);
    for (const [, dependency] of text.matchAll(/from"\.\/([\w.-]+\.js)"/g)) copyModule(dependency);
  }
  try {
    copyModule(path.posix.basename(rolldownImport[1]));
    copyModule(path.posix.basename(reactDomImport[1]));
    writeFile("package.json", '{"type":"module"}');
    writeFile("portal.mjs", [
      'import assert from "node:assert/strict";',
      rolldownImport[0] + ";",
      reactDomImport[0] + ";",
      'const aF = e(r(), 1);',
      'const Z = { memo: (render) => render, useState: (init) => [init()], useLayoutEffect: () => {}, useMemo: (fn) => fn() };',
      'const host = { nodeType: 1 };',
      'const document = { createElement: () => host };',
      'const aN = () => null;',
      'const $ = { jsx: (type, props) => ({ type, props }) };',
      surfaceEqHelpers[0],
      surfaceMount[0],
      'const surface = { id: "files" };',
      'const portal = T3SurfaceMount({ surface, panelProps: {}, slot: null, visible: true });',
      'assert.equal(portal.$$typeof, Symbol.for("react.portal"));',
      'assert.equal(portal.containerInfo, host);',
      'assert.equal(portal.children.props.surface, surface);',
    ].join("\n"));
    execFileSync(process.execPath, [path.join(dir, "portal.mjs")]);
  } finally {
    for (const name of files) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
}

function verifyWorkspaceToolbar(asar) {
  if (floatingRuntimeIsExternal(asar)) return verifyExternalFloatingRuntime(asar);
  const patch = workspaceFloatingPanels;
  const source = findUniqueEntry(asar, patch.targetRegex, patch.id).content.toString("utf8");
  const toolbar = source.match(/^function T3DividerSwapButton\([\s\S]+?(?=^function T3ChatColumnShell\()/m);
  const shell = source.match(/^function T3WorkspacePanelShell\(props\) \{[\s\S]+?^\}/m);
  assert(toolbar && shell, "Missing main chat toolbar or workspace shell");
  let swappedCalls = 0;
  const context = { labels: { pillIdle: "Main chat", swapLayout: "Swap layout", minimizeChat: "Minimize" }, chatFloat: false, swapped: true, toggleSwap: () => swappedCalls++ };
  const jsx = (type, props) => ({ type, props });
  const { T3DividerSwapButton, T3ChatToolbar, T3PanelToolbar } = runInNewContext(
    toolbar[0] + "\n({ T3DividerSwapButton, T3ChatToolbar, T3PanelToolbar })",
    {
      Z: { useContext: () => context },
      T3FloatContext: {},
      fr: "Tooltip",
      bt: "TooltipTrigger",
      se: "TooltipPopup",
      $: { jsx, jsxs: jsx },
    }
  );
  const controls = { kind: "conversation" };
  const toggle = { kind: "workspace" };
  const maximize = { kind: "maximize" };
  assert.equal(T3ChatToolbar({ controls }).props.children.filter(Boolean).length, 1);
  assert(source.includes("showRightPanelControl:!Ga"), "Right panel toggle must join chat header toolbar when panel is closed");
  assert(!source.includes("data-t3e-fixed-actions"), "Top-right fixed actions overlay should be removed");
  const dividerSwap = T3DividerSwapButton();
  assert.equal(dividerSwap.type, "Tooltip");
  assert.equal(dividerSwap.props.children[1].props.side, "right");
  const swapBtn = dividerSwap.props.children[0].props.render;
  assert.equal(swapBtn.props.className, "t3e-divider-swap-btn");
  assert.equal(swapBtn.props["aria-pressed"], true);
  let pointerStopped = false;
  let clickStopped = false;
  swapBtn.props.onPointerDown({ stopPropagation: () => { pointerStopped = true; } });
  swapBtn.props.onClick({ stopPropagation: () => { clickStopped = true; } });
  assert.equal(pointerStopped && clickStopped, true);
  assert.equal(swappedCalls, 1);
  assert(shell[0].includes("props.open && !props.sheet && !props.maximized && !ctx.chatFloat"));
  const split = T3PanelToolbar({ fullscreen: false, maximize, toggle }).props.children;
  assert.equal(split[0], null);
  assert.equal(split[1].props.children[0], maximize);
  context.chatFloat = true;
  const floating = T3ChatToolbar({ controls }).props;
  assert.equal(floating["data-t3e-conversation-actions"], "");
  assert.equal(floating.children.filter(Boolean).length, 2);
  let selected = 0;
  context.chatSelected = false;
  context.showMainChat = () => selected++;
  const fullscreen = T3PanelToolbar({ fullscreen: true, maximize, toggle }).props.children;
  assert.equal(fullscreen[0].props.children, "Main chat");
  assert.equal(fullscreen[1].props.children[0], maximize);
  assert.equal(fullscreen[1].props.children[1], toggle);
  fullscreen[0].props.onClick();
  assert.equal(selected, 1);
  context.chatSelected = true;
  assert.equal(T3PanelToolbar({ fullscreen: true, maximize, toggle }).props.children[0].props["aria-pressed"], true);
  assert.match(source, /\[data-t3e-workspace\] \[data-chat-header\] \.t3e-chat-toolbar button svg[\s\S]*width: 15px !important; height: 15px !important;/);
  assert.match(source, /\[data-t3e-workspace\] > \[data-preview-panel-mode=\\?"inline\\?"\][\s\S]*z-index: 2; isolation: isolate;/);
  assert.match(source, /\.t3e-divider-swap-btn \{[\s\S]*--t3e-swap-tx: -100%;[\s\S]*left: -1px;[\s\S]*opacity: 0; pointer-events: none;/, "Divider swap button must sit on the chat side of the divider so Browser WebContentsView cannot slice it");
  assert.match(source, /\[data-t3e-swap=\\?"true\\?"\] > \[data-preview-panel-mode=\\?"inline\\?"\] > \.t3e-divider-swap-btn \{[\s\S]*--t3e-swap-tx: 100%;[\s\S]*right: -1px;/, "Swapped divider swap button must sit on the right chat side away from left Browser WebContentsView");
  assert.match(source, /\[data-preview-panel-mode=\\?"inline\\?"\] > \[role=\\?"separator\\?"\]:hover:not\(:active\) ~ \.t3e-divider-swap-btn[\s\S]*opacity: 1; pointer-events: auto;/, "Hovering vertical separator must reveal swap button");
  const plc = findUniqueEntry(asar, patch.tabBarPatch.targetRegex, patch.tabBarPatch.id).content.toString("utf8");
  assert(plc.includes("children:[U,e.enhancerDividerSlot,re]"), "Panel divider must host enhancerDividerSlot");
  const pwMatch = source.match(/function oG\(e\)\{[\s\S]+?\}(?=function sG\()/);
  const ecMatch = plc.match(/function Wo\(e\)\{[\s\S]+?\}(?=function Go\()/);
  const kcMatch = plc.match(/function qo\(e\)\{[\s\S]+?\}(?=function Jo\()/);
  const hhMatch = plc.match(/function kp\(e\)\{[\s\S]+?\}(?=function Ap\(\))/);
  assert(pwMatch && ecMatch && kcMatch && hhMatch, "Missing oG/kp/Wo/qo in patched bundle");
  const sentinel = Symbol.for("react.memo_cache_sentinel");
  const slotSentinel = { $$typeof: "swap-btn-slot" };
  let capturedResizeEdge = null;
  const memoByComponent = new Map();
  let currentComponent = "root";
  const getMemo = (size) => {
    let arr = memoByComponent.get(currentComponent);
    if (!arr) {
      arr = Array(size).fill(sentinel);
      memoByComponent.set(currentComponent, arr);
    }
    return arr;
  };
  const HhTree = runInNewContext(
    `${ecMatch[0]}\n${kcMatch[0]}\n${hhMatch[0]}\n${pwMatch[0]}\n({ oG, kp, Wo, qo })`,
    {
      Q: {
        c: getMemo,
        useRef: (init) => ({ current: init }),
        useEffect: () => {},
        useLayoutEffect: () => {},
        useState: (init) => [typeof init === "function" ? init() : init, () => {}],
        useEffectEvent: (fn) => fn,
      },
      $: {
        c: getMemo,
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      },
      Z: {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      },
      B: () => (s) => s,
      R: () => (s) => s,
      a: (s) => s,
      Y: (...args) => args.filter(Boolean).join(" "),
      ua: () => ({ profiles: [] }),
      pn: () => ({ resolvedTheme: "light" }),
      Yi: () => ({}),
      gn: (fn) => fn,
      io: () => {},
      ao: () => {},
      _o: () => {},
      fp: () => "Changes",
      tp: () => null,
      hp: () => ({ url: "", capturedUrl: "" }),
      rp: () => null,
      Ep: "SurfaceTab",
      ta: "ta",
      na: "--panel-width",
      Ay: (u) => {
        capturedResizeEdge = u.edge;
        return { width: 420, handlers: {}, observeRow: () => () => {} };
      },
      My: (props) => {
        currentComponent = "kp";
        return HhTree.kp(props);
      },
      Wo: (props) => {
        currentComponent = "Wo";
        return HhTree.Wo(props);
      },
      Gi: "ScrollArea",
      Cp: "TabStrip",
      re: "Tooltip",
      P: "TooltipTrigger",
      A: "Button",
      He: "ChevronLeft",
      b: "TooltipPopup",
      W: "Kbd",
      ge: "ChevronRight",
      T3NewTabStripControl: "NewTabStrip",
      T3ChatGptSurfaceLauncher: "Launcher",
      we: "B", ft: "T", ke: "F", $e: "D", Li: { pullRequest: "P", link: "L" }, dt: "M", ho: "S",
      Yf: {}, Xf: "", Qf: 2, H: true,
    }
  );
  // Intercept kp's local `let ve = Wo` call cleanly via renderComponentTree
  const renderComponentTree = (node) => {
    let cur = node;
    while (cur && typeof cur.type === "function") {
      currentComponent = cur.type.name || "anon";
      cur = cur.type(cur.props);
    }
    return cur;
  };
  const renderInlinePanel = (enhancerDividerSlot, enhancerResizeEdge = "right") => renderComponentTree((() => {
    currentComponent = "oG";
    return HhTree.oG({
      sheet: false,
      workspaceLayoutElement: null,
      widthStorageKey: "k",
      open: true,
      maximized: false,
      layoutControls: { id: "lc" },
      surfaces: [{ id: "diff", kind: "diff" }],
      environmentId: "env-1",
      activeSurfaceId: "diff",
      pendingSurfaceIds: new Set(),
      terminalLabelsById: new Map(),
      onActivate: () => {},
      onCloseSurface: () => {},
      enhancerResizeEdge,
      enhancerDividerSlot,
      children: { id: "dock-body" },
    });
  })());
  const firstRender = renderInlinePanel(slotSentinel, "right");
  assert.equal(capturedResizeEdge, "right");
  assert.equal(firstRender.props["data-preview-panel-mode"], "inline");
  assert.equal(firstRender.props.children[1], slotSentinel, "oG -> kp -> Wo -> qo must preserve enhancerDividerSlot on inline divider");
  const secondRender = renderInlinePanel(null, "left");
  assert.equal(capturedResizeEdge, "left");
  assert.equal(secondRender.props.children[1], null, "Memo cache invalidation in kp/qo must hide divider slot when enhancerDividerSlot becomes null");
  const thirdRender = renderInlinePanel(slotSentinel, "left");
  assert.equal(thirdRender.props.children[1], slotSentinel, "Memo cache invalidation in kp/qo must restore divider slot when reopened");

  // Fullscreen Main Chat <-> floating tab scroll pinning (suppress smooth scroll & hide intermediate reflow until ResizeObserver settles)
  const shellMatch = source.match(/^function T3ChatColumnShell\([\s\S]+?(?=^function T3FloatButton\()/m);
  assert(shellMatch && source.includes('setAttribute("data-t3e-chat-settling", "true")'), "Missing T3ChatColumnShell fullscreen scroll settling logic");
  const protoScrollCalls = [];
  class MockScrollElement {
    constructor() {
      this.clientWidth = 1200;
      this.clientHeight = 800;
      this.scrollHeight = 4000;
      this.scrollTop = 3200;
      this.firstElementChild = { id: "content" };
      this.listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    }
    dispatch(type) {
      for (const fn of [...(this.listeners.get(type) || [])]) fn({ type });
    }
    scrollTo(opts) {
      protoScrollCalls.push(opts);
    }
  }
  const scroller = new MockScrollElement();
  const colAttrs = new Map();
  const colListeners = new Map();
  const mockCol = {
    style: {},
    querySelector: (sel) => (sel === ".messages-timeline-scroll" ? scroller : null),
    hasAttribute: (k) => colAttrs.has(k),
    setAttribute: (k, v) => colAttrs.set(k, v),
    removeAttribute: (k) => colAttrs.delete(k),
    addEventListener: (type, fn) => {
      if (!colListeners.has(type)) colListeners.set(type, new Set());
      colListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      colListeners.get(type)?.delete(fn);
    },
  };
  const baseDispatch = scroller.dispatch.bind(scroller);
  scroller.dispatch = (type) => {
    baseDispatch(type);
    for (const fn of [...(colListeners.get(type) || [])]) fn({ type, target: scroller });
  };
  let roCallback = null;
  const rafQueue = [];
  const effects = [];
  const layoutEffects = [];
  const refs = [];
  let refCursor = 0;
  let stateVal = 0;
  const shellCtx = { fullscreen: true, chatSelected: true, bounds: { width: 1200, height: 800 }, deckTop: 0, chatMinimized: false, labels: {} };
  const T3ChatColumnShellFn = runInNewContext(
    shellMatch[0] + "\nT3ChatColumnShell",
    {
      T3FloatContext: {},
      T3_CHAT_FLOAT_ID: "__t3e_main_chat__",
      T3FloatEdges: [],
      workspaceFloatFrame: (f) => f,
      workspaceSnapFrame: (f) => f,
      chatPillFrame: (f) => f,
      $: { jsx, jsxs: jsx },
      Z: {
        useContext: () => shellCtx,
        useRef: (init) => {
          const idx = refCursor++;
          if (!refs[idx]) refs[idx] = { current: idx === 1 ? mockCol : init };
          return refs[idx];
        },
        useState: (init) => [typeof init === "function" ? init() : stateVal, (v) => { stateVal = typeof v === "function" ? v(stateVal) : v; }],
        useEffect: (fn) => effects.push(fn),
        useLayoutEffect: (fn) => layoutEffects.push(fn),
      },
      ResizeObserver: class {
        constructor(cb) { roCallback = cb; }
        observe() {}
        disconnect() { roCallback = null; }
      },
      requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
      cancelAnimationFrame: () => {},
      clearTimeout,
      setTimeout,
    }
  );
  const effectCleanups = [];
  const renderShell = () => {
    while (effectCleanups.length) {
      const cleanup = effectCleanups.pop();
      if (typeof cleanup === "function") cleanup();
    }
    refCursor = 0;
    effects.length = 0;
    layoutEffects.length = 0;
    T3ChatColumnShellFn({ className: "chat", maximizedAway: false, workState: "idle", children: null });
    for (const fn of layoutEffects) effectCleanups.push(fn());
    for (const fn of effects) effectCleanups.push(fn());
  };
  renderShell(); // mount in expanded fullscreen
  shellCtx.chatSelected = false;
  shellCtx.chatFloat = { entry: { id: "__t3e_main_chat__", frame: { x: 700, y: 200, width: 432, height: 580 } }, level: 1 };
  scroller.clientWidth = 432;
  scroller.clientHeight = 580;
  renderShell(); // switch to floating mini-chat while at bottom
  assert.equal(colAttrs.get("data-t3e-chat-settling"), "true");
  scroller.scrollTo({ top: 7000, behavior: "smooth" });
  assert.equal(protoScrollCalls.at(-1).behavior, "instant", "Transition scrollTo must suppress CSS smooth animation");
  scroller.scrollHeight = 8000;
  roCallback?.();
  assert.equal(scroller.scrollTop, 7420, "ResizeObserver reflow must pin mini-chat immediately to bottom");
  while (rafQueue.length) rafQueue.shift()();
  assert.equal(colAttrs.has("data-t3e-chat-settling"), false, "Settling attribute must clear after consecutive stable frames");

  // Scrolled up user must NOT be pulled to bottom on switch
  scroller.scrollTop = 1200;
  scroller.dispatch("scroll");
  shellCtx.chatSelected = true;
  shellCtx.chatFloat = null;
  renderShell();
  assert.equal(colAttrs.has("data-t3e-chat-settling"), false);
  assert.equal(scroller.scrollTop, 1200, "Non-bottom user scroll offset must be preserved");
}

function verifyTabDrag(asar) {
  if (floatingRuntimeIsExternal(asar)) return verifyExternalFloatingRuntime(asar);
  const patch = workspaceFloatingPanels.tabBarPatch;
  const code = findUniqueEntry(asar, patch.targetRegex, patch.id).content.toString("utf8");
  const anchor = "\nfunction tabDroppedOutside(";
  const index = code.indexOf(anchor);
  assert(index >= 0);
  const window = new EventTarget();
  const createDrag = runInNewContext(code.slice(index) + "\nT3TrackTabDrag", {
    Q: { useRef: () => ({ current: null }), useMemo: (create) => create(), useEffect() {} },
    window,
  });
  const bar = {
    getBoundingClientRect: () => ({ top: 32, bottom: 64 }),
    toggleAttribute() {},
    removeAttribute() {},
  };
  const surface = { id: "files" };
  const detachments = [];
  const drag = createDrag({ surfaces: [surface], enhancerFloatTab: (tab) => detachments.push(tab) });
  const start = { activatorEvent: { pointerId: 1, clientX: 40, clientY: 48, target: { closest: () => bar } } };
  const end = { active: { id: surface.id } };
  const move = (type, clientY, pointerId = 1) => window.dispatchEvent(Object.assign(new Event(type), { pointerId, clientX: 40, clientY }));
  drag.start(start);
  move("pointerup", 49);
  assert.equal(drag.finish(end), false, "Horizontal dragging must fall through to native reordering");
  drag.start(start);
  move("pointermove", 100);
  drag.cancel();
  assert.equal(drag.finish(end), false);
  drag.start(start);
  move("pointermove", 100);
  window.dispatchEvent(new Event("pointercancel"));
  assert.equal(drag.finish(end), false, "pointercancel must abort tab tear-off");
  drag.start(start);
  move("pointermove", 100);
  window.dispatchEvent(new Event("blur"));
  assert.equal(drag.finish(end), false, "window blur must abort tab tear-off");
  drag.start(start);
  move("pointermove", 100, 2);
  assert.equal(drag.finish(end), false, "A second pointer must not tear off the tab");
  drag.start(start);
  move("pointerup", 100);
  assert.equal(drag.finish(end), true);
  assert.deepEqual(detachments, [surface]);
}

function verifyNativePreviewPosition(asar) {
  if (floatingRuntimeIsExternal(asar)) return verifyExternalFloatingRuntime(asar);
  const patch = workspaceFloatingPanels;
  const source = findUniqueEntry(asar, patch.targetRegex, patch.id).content.toString("utf8");
  const nativeSurface = source.match(/function eO\(e\)\{[\s\S]+?(?=function tO\()/);
  const syncPreview = source.match(/^function t3SyncNativePreview\(container\) \{[\s\S]+?^\}/m);
  const movePreview = source.match(/^const t3PanelMovesPending = new WeakSet\(\);[\s\S]+?(?=^function t3SyncNativePreview)/m);
  assert(nativeSurface && syncPreview && movePreview, "Missing preview position sync in patched archive");
  const reports = [];
  const fits = [];
  const window = new EventTarget();
  const pendingFrames = [];
  const [render, sync, movePanelHost] = runInNewContext(
    nativeSurface[0] + "\n" + syncPreview[0] + "\n" + movePreview[0] + "\n[eO, t3SyncNativePreview, t3MovePanelHost]", {
    Q: { c: (size) => Array(size).fill(Symbol.for("react.memo_cache_sentinel")) },
    Z: { useRef: (value) => ({ current: value }), useLayoutEffect() {} },
    $: { jsx: (_type, props) => props },
    Gd: (_tabId, fit) => {
      fits.push(fit);
      return { present: (rect, visible, cornerRadius, zIndex) => (reports.push({ rect, visible, cornerRadius, zIndex }), true), release() {} };
    },
    sx: () => () => {},
    t3BrowserLayoutMode: workspaceFloatingPanels.t3BrowserLayoutMode,
    document: { querySelectorAll: () => [] },
    requestAnimationFrame: (callback) => pendingFrames.push(callback),
    Event,
    window
  });
  let bounds = { x: 10, y: 25, width: 440, height: 320 };
  let floatHost = null;
  const viewport = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => bounds,
    closest: (sel) => (sel === ".t3e-floating-window" ? floatHost : null)
  });
  const frame = { querySelectorAll: () => [viewport] };
  const cleanup = render({ tabId: "browser-1", visible: true }).ref(viewport);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].zIndex, 30);
  bounds = { ...bounds, x: 150, y: 80 };
  floatHost = { style: { zIndex: "33" }, getAttribute: () => "preview" };
  sync(frame);
  assert.equal(reports.length, 2);
  assert.equal(reports[1].rect.x, 150);
  assert.equal(reports[1].rect.y, 80);
  assert.equal(reports[1].rect.width, 440);
  assert.equal(reports[1].rect.height, 320);
  assert.equal(reports[1].zIndex, 34);
  assert.deepEqual(fits, [false, "responsive"]);
  bounds = { ...bounds, width: 312, height: 216 };
  sync(frame);
  assert.equal(reports.at(-1).rect.width, 312);
  assert.deepEqual(fits, [false, "responsive"]);
  floatHost = null;
  bounds = { ...bounds, width: 0, height: 0 };
  sync(frame);
  assert.equal(reports.at(-1).visible, false);
  assert.deepEqual(fits, [false, "responsive"]);
  bounds = { x: 10, y: 25, width: 440, height: 320 };
  sync(frame);
  assert.deepEqual(fits, [false, "responsive", false]);
  assert.equal(reports.at(-1).zIndex, 30);
  const host = { isConnected: true, parentElement: null, querySelectorAll: () => [viewport] };
  const makeSlot = (x) => ({ appendChild(panel) {
    panel.parentElement = this;
    bounds = { ...bounds, x };
  } });
  movePanelHost(host, makeSlot(70));
  movePanelHost(host, makeSlot(120));
  assert.equal(pendingFrames.length, 1, "Multiple panel moves in one frame share one layout notification");
  assert.equal(reports.length, 5, "The native preview waits for the final layout");
  pendingFrames.shift()();
  assert.equal(reports.length, 6);
  assert.equal(reports.at(-1).rect.x, 120);
  cleanup();
  sync(frame);
  assert.equal(reports.length, 6);
  assert.equal(workspaceFloatingPanels.t3BrowserLayoutMode(viewport, true), true);
}

function verifyResponsiveBrowserLayout(asar) {
  const patch = workspaceFloatingPanels.responsivePreviewPatch;
  const main = findUniqueEntry(asar, patch.targetRegex, patch.id).content.toString("utf8");
  const storeMatch = main.match(/([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\)\(e=>\(\{activityByTabId:[\s\S]+?function\s+([A-Za-z_$][\w$]*)\(e,t=!1\)\{let n=Symbol\(`browser-surface:\$\{e\}`\)[\s\S]+?\}\}\}(?=var\s+[A-Za-z_$][\w$]*=)/);
  const layoutMode = main.match(/const T3ResponsiveViewport=[^;]+;/);
  const layoutSelectorMatch = main.match(/([A-Za-z_$][\w$]*)=e=>\{let t=e\.byTabId\[([A-Za-z_$][\w$]*)\];return\{content:[^}]+\}\}/);
  const layoutOverrideMatch = main.match(/if\(([A-Za-z_$][\w$]*)\.responsive\)([A-Za-z_$][\w$]*)=T3ResponsiveViewport;/);
  const overlayAnchor = main.indexOf("responsive:t3Responsive=!1,");
  const overlayStyleFn = overlayAnchor >= 0 ? createPatchContext(null, null, main).findEnclosingFunction(overlayAnchor) : null;
  assert(storeMatch && layoutMode && layoutSelectorMatch && layoutOverrideMatch && overlayStyleFn, "Missing responsive browser viewport or corner clipping wiring");
  const [, storeVar, createStoreFn, claimFn] = storeMatch;
  const [, selFn, tabVar] = layoutSelectorMatch;
  const [, selVar, vpVar] = layoutOverrideMatch;
  assert(main.includes(`cornerRadius:${selVar}.cornerRadius,responsive:${selVar}.responsive,zIndex:${selVar}.zIndex`), "Webview host must pass responsive flag to overlay style helper");
  const hiddenConst = overlayStyleFn.source.match(/\{left:([A-Za-z_$][\w$]*),top:\1,/)?.[1];
  const rectEqFn = storeMatch[0].match(/&&([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.rect,[A-Za-z_$][\w$]*\)/)?.[1];
  assert(hiddenConst && rectEqFn, "Missing hiddenConst or rectEqFn in responsive browser layout test");
  const computeOverlayStyle = runInNewContext(`(${overlayStyleFn.source})`, { [hiddenConst]: -1e5 });
  const floatingStyle = computeOverlayStyle({ active: true, cornerRadius: 13, responsive: true, rect: { x: 10, y: 20, width: 400, height: 420 }, hiddenSize: { width: 400, height: 420 }, renderingActive: true, zIndex: 34 });
  assert.equal(floatingStyle.borderRadius, undefined, "Responsive floating browser should only round bottom corners, not top corners below the toolbar");
  assert.equal(floatingStyle.borderBottomLeftRadius, 13);
  assert.equal(floatingStyle.borderBottomRightRadius, 13);
  assert.equal(floatingStyle.clipPath, "inset(0 round 0 0 13px 13px)");
  const pipStyle = computeOverlayStyle({ active: true, cornerRadius: 12, responsive: false, rect: { x: 10, y: 20, width: 320, height: 200 }, hiddenSize: { width: 320, height: 200 }, renderingActive: true, zIndex: 48 });
  assert.equal(pipStyle.borderRadius, 12);
  const defaults = findUniqueEntry(asar, /\/browserDefaults-[\w-]+\.js$/, "browser layout").content.toString("utf8");
  const layout = defaults.match(/function\s+([A-Za-z_$][\w$]*)\(e,t,n=1\)\{let r=Math\.max\(1,Math\.round\(e\.width\)\)[\s\S]+?fillsPanel:!1\}\}/);
  assert(layout, "Missing native browser viewport calculation");
  const layoutFnName = layout[1];
  const zoomFnName = layout[0].match(/let\s+[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\(n\),/)?.[1];
  assert(zoomFnName, "Missing zoom helper in browserDefaults layout calculation");
  const rectGetterFn = layoutSelectorMatch[0].match(/rect:([A-Za-z_$][\w$]*)\(/)?.[1];
  const { claim, state, viewportFor, size } = runInNewContext(
    "let " + storeMatch[0] + "\n" + layoutMode[0] + "\n" + layout[0] + `
    ({
      claim: ${claimFn},
      state: ${storeVar}.getState,
      viewportFor(${tabVar}, ${vpVar}) {
        let ${selFn};
        ${layoutSelectorMatch[0]};
        const ${selVar} = ${selFn}(${storeVar}.getState());
        ${layoutOverrideMatch[0]}
        return ${vpVar};
      },
      size: ${layoutFnName}
    })`, {
      [createStoreFn]: () => (init) => {
        let state = init((update) => { state = { ...state, ...update(state) }; });
        return { getState: () => state };
      },
      [rectEqFn]: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      [zoomFnName]: (zoom) => zoom,
      ...(rectGetterFn ? { [rectGetterFn]: (byTabId, id) => byTabId?.[id]?.rect ?? null } : {}),
    }
  );
  const tab = "browser";
  const dockedViewport = { _tag: "fixed", width: 1200, height: 1000 };
  const content = { width: 1200, height: 1000 };
  state().presentContent(tab, content);
  const floating = claim(tab, "responsive");
  assert.equal(state().byTabId[tab].fittedSourceContent, null);
  assert.equal(zoomedCanvas(338, 205).viewportWidth, 338);
  assert.equal(zoomedCanvas(500, 205).viewportWidth, 500);
  assert.equal(zoomedCanvas(338, 205).viewportHeight, 205);
  assert.equal(zoomedCanvas(338, 205).viewportScale, 1);
  floating.release();
  assert.equal(viewportFor(tab, dockedViewport), dockedViewport);
  const miniPlayer = claim(tab, true);
  assert.equal(state().byTabId[tab].fittedSourceContent, content);
  assert.equal(viewportFor(tab, dockedViewport), dockedViewport);
  miniPlayer.release();

  function zoomedCanvas(width, height) {
    return size({ width, height }, viewportFor(tab, dockedViewport), 1);
  }
}

function verifyInlineEditDetail(asar) {
  const code = findUniqueEntry(asar, inlineFileDiff.targetRegex, inlineFileDiff.id).content.toString("utf8");
  const inspMatch = code.match(/([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.projectedItem,\s*\3\.environmentId/);
  assert(inspMatch, "Missing timeline detail hook call");
  const detailHookName = inspMatch[2];
  const detailHookIdx = code.indexOf(`function ${detailHookName}(`);
  assert(detailHookIdx >= 0, `Missing declaration of timeline detail hook ${detailHookName}`);
  const detailHookFn = createPatchContext(null, null, code).findEnclosingFunction(detailHookIdx + 10);
  assert(detailHookFn, "Missing timeline detail hook body");
  assert.match(code, /createInlineDiffRuntime\(\{\s*React:\s*[\w$]+,\s*jsx:\s*[\w$]+\.jsx,\s*jsxs:\s*[\w$]+\.jsxs,\s*resolveRelPath:\s*[\w$]+,\s*useCheckpointSummaries:/, "Missing inline diff runtime bridge");
  assert.match(code, /T3FileChangeRowLabelMemo,\{projectedItem:[\w$]+\.projectedItem,workspaceRoot:[\w$]+,cwd:[\w$]+\.markdownCwd,environmentId:[\w$]+\.activeThreadEnvironmentId,source:[\w$]+\.turnItemSource,expanded:[\w$]+\}/);
  assert.match(code, /onInitialOutputReady\);if\([\w$]+\.type===`file_change`\)return\(0,[\w$]+\.jsx\)\(T3InlineFileDiffCardMemo/);

  const summary = { type: "file_change", fileName: "README.md", updatedAt: "r1" };
  const projected = { sourceThreadId: "source-thread", sourceItemId: "edit-1", item: summary };
  const customDetailSource = () => {};
  const memoSize = Number(detailHookFn.source.match(/\(0,[A-Za-z_$][\w$]*\.c\)\((\d+)\)/)?.[1] || 32);
  const memo = Array(memoSize).fill(Symbol.for("react.memo_cache_sentinel"));
  let reply = { isPending: true };
  let request;
  let checkpointRequest;
  let checkpointReply = {};
  const parseLimits = [];
  let source;
  let uuidSeq = 0;
  const jsx = (type, props) => ({ type, props });
  let renderRow = false;
  let rowVisible = false;
  let observeRow;
  const rowElement = {};
  const React = {
    useState: (init) => renderRow ? [rowVisible, (visible) => { rowVisible = visible; }] : [init, () => {}],
    useRef: (init) => ({ current: renderRow ? rowElement : init }),
    useEffect: (effect) => { if (renderRow) effect(); },
    useMemo: (create) => create(),
  };
  const useTurnItemDetail = (key, customSource) => { request = key; source = customSource; return reply; };
  const getItemRevision = (item) => item.updatedAt;
  const compilerVar = detailHookFn.source.match(/\(0,([A-Za-z_$][\w$]*)\.c\)\(\d+\)/)?.[1];
  const i18nVar = detailHookFn.source.match(/=([A-Za-z_$][\w$]*)\(\),/)?.[1];
  const boVar = detailHookFn.source.match(/![A-Za-z_$][\w$]*&&\(([A-Za-z_$][\w$]*)\(/)?.[1];
  const goVar = detailHookFn.source.match(/revision:([A-Za-z_$][\w$]*)\(/)?.[1];
  const piVar = detailHookFn.source.match(/=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\?\.detail\)/)?.[1];
  const reactRefs = createPatchContext(null, null, code).resolveReactBindings();
  const detailSandbox = {
    [compilerVar]: { c: () => memo },
    [i18nVar]: () => (text) => text,
    [boVar]: () => false,
    [goVar]: getItemRevision,
    [piVar]: useTurnItemDetail,
    [reactRefs.react]: React,
    [reactRefs.jsx]: { jsx, jsxs: jsx },
  };
  for (const id of findUndeclaredIdentifiers(detailHookFn.source, new Set([detailHookName]), Object.keys(detailSandbox))) {
    detailSandbox[id] = () => [];
  }
  const { [detailHookName]: bm } = runInNewContext(detailHookFn.source + `\n({ ${detailHookName} })`, detailSandbox);
  // The inline diff UI is the shipped runtime module, wired up exactly like the generated bridge.
  const runtime = loadRuntimeModule("inline-diff-ui", { crypto: { randomUUID: () => `rev-${++uuidSeq}` } });
  const parseUnifiedDiff = runtime.sandbox.t3ParseUnifiedDiff;
  runtime.sandbox.t3ParseUnifiedDiff = (...args) => {
    parseLimits.push(args[3]);
    return parseUnifiedDiff(...args);
  };
  const { T3InlineFileDiffCard, T3FileChangeRowLabel } = runtime.exports.createInlineDiffRuntime({
    React,
    jsx,
    jsxs: jsx,
    resolveRelPath: (path) => path,
    useCheckpointSummaries: (ref) => ref ? [{ runId: "turn-9", checkpointTurnCount: 9 }] : [],
    useCheckpointDiff: (input, options) => {
      checkpointRequest = options.enabled ? input : null;
      return options.enabled ? checkpointReply : {};
    },
    parseCheckpointDiff: (patch) => ({
      kind: "files", files: [{ name: /^\+\+\+ b\/(.*)$/m.exec(patch)?.[1] }]
    }),
    observeIntersection: (node, callback) => {
      assert.equal(node, rowElement);
      observeRow = callback;
      return () => {};
    },
    useTurnItemDetail,
    getItemRevision,
    formatCompact: String,
  });
  let sideRequest;
  const cardTree = () => {
    const result = bm(projected, "env", { detail: customDetailSource }, false);
    return T3InlineFileDiffCard({
      item: result.item, projectedItem: projected, detail: result.output, workspaceRoot: "C:\\Work\\project",
      onOpenToolDiff: (request) => { sideRequest = request; },
    });
  };
  const render = () => JSON.stringify(cardTree());
  const rowTree = (expanded = false) => {
    renderRow = true;
    try {
      return T3FileChangeRowLabel({
        projectedItem: projected, workspaceRoot: "C:\\Work\\project", environmentId: "env",
        source: { detail: customDetailSource }, expanded,
      });
    } finally {
      renderRow = false;
    }
  };
  const rowStats = (expanded) => rowTree(expanded).props.children.props.children[2];
  assert.equal(rowStats(), null);
  assert.equal(request, null, "Offscreen file changes must not fetch file details");
  observeRow({ isIntersecting: true });
  assert.equal(rowStats(), null);
  assert.deepEqual({ ...request }, { environmentId: "env", threadId: "source-thread", itemId: "edit-1", revision: "r1" });
  assert.equal(source, customDetailSource);
  assert.match(render(), /Loading the diff for this edit/);
  assert.deepEqual({ ...request }, { environmentId: "env", threadId: "source-thread", itemId: "edit-1", revision: "r1" });
  assert.equal(source, customDetailSource);
  const addedLines = Array.from({ length: 321 }, (_, index) => "+line " + index).join("\n");
  reply = { isPending: false, data: { item: { ...summary, diffStr: "@@ -1 +1 @@\n-old text\n+new text\n" + addedLines } } };
  const loaded = render();
  assert.match(loaded, /is-add.*new text/);
  assert.match(loaded, /is-del.*old text/);
  assert.equal(checkpointRequest, null);
  assert.equal(cardTree().props["data-v2-item-inspector"], "file_change");
  const [header, preview] = cardTree().props.children;
  const [lead, actions] = header.props.children;
  const [title] = lead.props.children;
  assert.equal(parseLimits.at(-1), 320, "The card should materialize only the preview rows");
  assert.deepEqual(rowStats(), lead.props.children[1], "A collapsed row should show the expanded card's exact line totals");
  assert.equal(parseLimits.at(-1), 0, "The collapsed row should compute counts without constructing rows");
  const parseCount = parseLimits.length;
  assert.equal(rowStats(true), null, "The expanded header must show the counts only once");
  assert.equal(parseLimits.length, parseCount, "The expanded row label must not parse the card's diff again");
  assert.equal(request, null, "An expanded row must leave detail loading to the card");
  projected.item = { ...summary, diffStr: addedLines, additions: 4, deletions: 0 };
  assert.match(JSON.stringify(rowStats()), /"\+","4"/);
  assert.equal(request, null, "Known line totals must not fetch file details");
  assert.equal(parseLimits.length, parseCount, "Known line totals must not parse embedded diff content");
  projected.item = summary;
  assert.equal(title.props["aria-expanded"], undefined);
  assert.equal(preview.props.children[0].length, 320);
  assert.equal(sideRequest, undefined);
  title.props.onClick({ stopPropagation() {} });
  assert.deepEqual({ ...sideRequest }, { threadId: "source-thread", itemId: "edit-1", revision: "r1", filePath: "README.md", revealRequestId: "rev-1" });
  preview.props.children[1].props.onClick({ stopPropagation() {} });
  assert.deepEqual({ ...sideRequest }, { threadId: "source-thread", itemId: "edit-1", revision: "r1", filePath: "README.md", revealRequestId: "rev-2" });
  actions.props.children[1].props.onClick({ stopPropagation() {} });
  assert.deepEqual({ ...sideRequest }, { threadId: "source-thread", itemId: "edit-1", revision: "r1", filePath: "README.md", revealRequestId: "rev-3" });
  projected.sourceItemId = "edit-2";
  projected.item = { ...summary, runId: "turn-9", updatedAt: "r2" };
  reply = { isPending: false, data: { item: projected.item } };
  assert.match(render(), /No line-level diff was recorded/);
  assert.equal(request.itemId, "edit-2");
  assert.equal(request.revision, "r2");
  sideRequest = undefined;
  cardTree().props.children[0].props.children[0].props.children[0].props.onClick({ stopPropagation() {} });
  assert.deepEqual(
    { ...sideRequest },
    { threadId: "source-thread", itemId: "edit-2", revision: "r2", filePath: "README.md", turnId: "turn-9", preferGitFallback: true, revealRequestId: "rev-4" }
  );
  reply = { isPending: false, error: "unavailable" };
  assert.match(render(), /Could not load the diff for this edit/);
  projected.item = { ...projected.item, fileName: "/C:/work/project/README.md" };
  reply = { isPending: false, data: { item: projected.item } };
  checkpointReply = { isPending: true };
  assert.match(render(), /Loading the diff for this edit/);
  assert.deepEqual({ ...checkpointRequest }, {
    environmentId: "env", threadId: "source-thread", fromTurnCount: 8, toTurnCount: 9, ignoreWhitespace: false
  });
  checkpointReply = { data: { diff:
    "diff --git a/sub/README.md b/sub/README.md\n--- a/sub/README.md\n+++ b/sub/README.md\n@@ -1 +1 @@\n-x\n+UNRELATED\n" +
    "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+RECOVERED\n"
  } };
  const recovered = render();
  assert.match(recovered, /Turn (?:net )?Git diff/);
  assert.match(recovered, /is-add.*RECOVERED/);
  assert.doesNotMatch(recovered, /UNRELATED/);
  assert.deepEqual(rowStats(), cardTree().props.children[0].props.children[0].props.children[1],
    "A collapsed row should reuse the card's file-specific checkpoint totals");
  assert.equal(cardTree().props.children[0].props.children[0].props.children[0].props.onClick({}), undefined);
  assert.equal(sideRequest.filePath, "README.md");
  projected.item = { ...projected.item, runId: "turn-with-no-checkpoint" };
  reply = { isPending: false, data: { item: projected.item } };
  assert.doesNotMatch(render(), /RECOVERED/);
  assert.equal(checkpointRequest, null);

  // Verify working-tree fallback for in-progress or uncheckpointed file_change edits
  const wtCardRuntime = loadRuntimeModule("inline-diff-ui").exports.createInlineDiffRuntime({
    React: {
      memo: (fn) => fn,
      useEffect() {},
      useMemo: (fn) => fn(),
      useRef: (init) => ({ current: init }),
      useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    },
    jsx: (type, props) => ({ type, props: props || {} }),
    jsxs: (type, props) => ({ type, props: props || {} }),
    resolveRelPath: (p) => String(p || "").replace(/^\/?C:\/work\/project\//i, ""),
    useCheckpointSummaries: () => [],
    useCheckpointDiff: () => ({ data: null, isPending: false }),
    parseCheckpointDiff: (patch) => {
      const files = [...String(patch || "").matchAll(/diff --git a\/([^\s]+) b\/([^\s]+)/g)].map((m) => ({ name: m[2] }));
      return files.length ? { kind: "files", files } : null;
    },
    reviewQueries: {
      diffPreview: (args) => args,
    },
    useQuery: (q) => ({
      isPending: false,
      data: q?.input?.sourceKind === "working-tree"
        ? { sources: [{ kind: "working-tree", diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+LIVE_WT_LINE\n" }] }
        : null,
    }),
  });
  const wtRendered = JSON.stringify(wtCardRuntime.T3InlineFileDiffCard({
    item: { type: "file_change", fileName: "C:/work/project/README.md", runId: "live-turn" },
    projectedItem: { sourceThreadId: "t1", sourceItemId: "i1", item: { type: "file_change", runId: "live-turn" } },
    detail: { environmentId: "env", pending: false },
    workspaceRoot: "C:/work/project",
    cwd: "C:/work/project",
  }));
  assert.match(wtRendered, /Working tree/);
  assert.match(wtRendered, /LIVE_WT_LINE/);
  assert(
    code.includes("reviewQueries:") && code.includes("useQuery:"),
    "inline-file-diff bridge must pass reviewQueries and useQuery for working-tree fallback"
  );

  // Verify DiffPanel sideRevealPatch for single-file, multi-file, and blank tool-call -> turn/unstaged fallback
  const diffPanel = findUniqueEntry(asar, inlineFileDiff.sideRevealPatch.targetRegex, inlineFileDiff.id + "-side").content.toString("utf8");
  assert.match(diffPanel, /createSideRevealHelpers\(\{\s*extractToolPatch:\s*[\w$]+,\s*parsePatch:\s*[\w$]+,\s*getFileName:\s*[\w$]+,?\s*\}\)/, "Missing side-reveal runtime bridge");
  const revealMatch = diffPanel.match(
    /\/\* T3_INLINE_FILE_DIFF_SIDE_REVEAL_V\d+ \*\/let t3RawZ=[A-Za-z_$][\w$]*,t3Fb=[\s\S]*?(let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\.kind===`turn`\?\2\.turnId:t3Fb\?\.turnId\?\?null,[^;]+),[A-Za-z_$][\w$]*;[\s\S]*?(if\(([A-Za-z_$][\w$]*)\|\|t3RawZ\?\.revealRequestId\)\4=t3ResolveRevealPath\(\4,([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),!t3GitMode&&Boolean\(t3RawZ\?\.revealRequestId\)\);)[\s\S]*?(([A-Za-z_$][\w$]*)=e=>\{let t=([A-Za-z_$][\w$]*)\(e\);return!([A-Za-z_$][\w$]*)\|\|t===\4\|\|!([A-Za-z_$][\w$]*)\(t\)\})[\s\S]*?(([A-Za-z_$][\w$]*)\.current!==e&&([A-Za-z_$][\w$]*)\(\4\)&&\(\14\.current=e\))/
  );
  assert(revealMatch, "Missing updated DiffPanel sideRevealPatch injection");
  const [, selDecl, bVar, revealStmt, vrVar, filesVar, rowsVar, rootVar, filterAssign, filterVar, getFileNameVar, hideFlagVar, isTestVar, scrollStmt, lastRevealRefVar, revealFnVar] = revealMatch;
  const yrVar = selDecl.match(/,([A-Za-z_$][\w$]*)=t3RawZ\?\.revealRequestId\?\?/)?.[1];
  assert(yrVar, "Missing revealRequestId variable in DiffPanel selection");
  const fallbackFns = loadRuntimeModule("inline-diff-ui").exports.createSideRevealHelpers({
    extractToolPatch: (cn) => ({ patch: cn.diffStr, truncated: Boolean(cn.truncated) }),
    parsePatch: (patch) => {
      if (!patch || !patch.includes("diff --git")) return null;
      const files = [...patch.matchAll(/diff --git a\/([^\s]+) b\/([^\s]+)/g)].map((m) => ({ name: m[2] }));
      return files.length ? { kind: "files", files } : { kind: "raw" };
    },
    getFileName: (fd) => fd.name,
  });
  assert.equal(fallbackFns.t3DiffMatchesTarget("nested/src/app.ts", "src/app.ts", "/repo"), false);
  assert.equal(fallbackFns.t3DiffMatchesTarget("src/App.ts", "src/app.ts", "/repo"), false);
  assert.equal(fallbackFns.t3DiffMatchesTarget("src/App.ts", "src/app.ts", "C:\\repo"), true);
  assert.equal(fallbackFns.t3DiffMatchesTarget("/repo/src/app.ts", "src/app.ts", "/repo"), true);
  const emptyTool = { type: "file_change", runId: "run-5", changes: [{ path: "src/app.ts", operation: "modify" }], oldStr: "a", newStr: "b" };
  const project = { cwd: "/repo", workspaceRoot: "/repo", isRepo: true, canReadFiles: true, projectMeta: { environmentId: "env-1" } };
  const turns = [{ runId: "run-5", checkpointTurnCount: 2 }];
  const turnFb = fallbackFns.t3PickToolDiffFallback({
    ...project, turns,
    rawTarget: { kind: "tool-call", filePath: "src\\app.ts", revealRequestId: "r1" },
    toolQuery: { isPending: false },
    toolItem: emptyTool,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(turnFb)), { mode: "turn", turn: { runId: "run-5", checkpointTurnCount: 2 }, turnId: "run-5", canUnstaged: true });
  const unstagedFb = fallbackFns.t3PickToolDiffFallback({
    ...project, turns,
    rawTarget: { kind: "tool-call", filePath: "src/app.ts", turnId: "run-live", preferGitFallback: true, revealRequestId: "r2" },
    toolQuery: { isPending: true },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(unstagedFb)), { mode: "unstaged", turn: null, turnId: null, canUnstaged: true });
  const validToolFb = fallbackFns.t3PickToolDiffFallback({
    ...project, turns,
    rawTarget: { kind: "tool-call", filePath: "src/app.ts", revealRequestId: "r3" },
    toolQuery: { isPending: false },
    toolItem: { type: "file_change", runId: "run-5", diffStr: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n" },
  });
  assert.equal(validToolFb, null, "Tool calls with an intact diffStr must remain in isolated tool-call mode");
  assert.equal(
    fallbackFns.t3CheckpointHasFile({ diff: "diff --git a/other.ts b/other.ts\n" }, "src/app.ts", false, "/repo"),
    false,
    "Turn checkpoint diff lacking the clicked file should allow working-tree unstaged fallback"
  );
  const uncollapsed = [];
  const scrolled = [];
  const revealRunner = runInNewContext(
    `(function(t3RawZ, ${bVar}, ${hideFlagVar}, ${rowsVar}, __scopeK, ${lastRevealRefVar}, ${revealFnVar}, ${isTestVar}, ${getFileNameVar}, t3GitMode) {
      const ${rootVar} = "C:/repo";
      const ${filesVar} = ${rowsVar}.map(({ fileDiff }) => fileDiff);
      const t3Fb = null;
      ${selDecl};
      ${revealStmt}
      let ${filterAssign};
      const e = JSON.stringify([__scopeK, ${vrVar}, ${yrVar}]);
      ${scrollStmt};
      return { vr: ${vrVar}, yr: ${yrVar}, Qi: ${filterVar} };
    })`,
    { ...fallbackFns }
  );
  const Ji = [
    { fileKey: "k1", fileDiff: { name: "src/a.ts" } },
    { fileKey: "k2", fileDiff: { name: "tests/b.test.ts" } },
  ];
  const xa = { current: null };
  const ba = (e) => {
    const idx = Ji.findIndex((item) => item.fileDiff.name === e);
    if (idx < 0) return false;
    uncollapsed.push(Ji[idx].fileKey);
    scrolled.push(Ji[idx].fileKey);
    return true;
  };
  const dpOut = revealRunner(
    { kind: "tool-call", filePath: "tests\\b.test.ts", revealRequestId: "r-win" },
    { kind: "tool-call" },
    true,
    Ji,
    "scope:1",
    xa,
    ba,
    (p) => p.endsWith(".test.ts"),
    (fd) => fd.name,
    "turn"
  );
  assert.equal(dpOut.vr, "tests/b.test.ts");
  assert.equal(dpOut.Qi(Ji[1].fileDiff), true, "Revealed test file must not be hidden when diffHideTestFiles is enabled");
  assert.deepEqual(uncollapsed, ["k2"]);
  assert.deepEqual(scrolled, ["k2"]);
  // Single-file fallback even if filePath differs from git diff header name (non-fallback mode)
  const singleOut = revealRunner(
    { kind: "tool-call", filePath: "other-name.ts", revealRequestId: "r-one" },
    { kind: "tool-call" },
    false,
    [Ji[0]],
    "scope:2",
    { current: null },
    ba,
    () => false,
    (fd) => fd.name,
    null
  );
  assert.equal(singleOut.vr, "src/a.ts");
  assert.deepEqual(uncollapsed, ["k2", "k1"]);

  // Verify background review.* RPCs (review.getDiffPreview etc.) do not trigger the 15s slow-request warning toast
  const rtCode = findPatchTarget(asar, inlineFileDiff.quietReviewToastPatch, ALL_PATCHES).content.toString("utf8");
  const filterMatch = rtCode.match(/function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{\/\* T3_QUIET_REVIEW_SLOW_TOAST_V1 \*\/[^}]+&&!([A-Za-z_$][\w$]*)\.has\(\2\)\}/);
  assert(filterMatch, "Missing quietReviewToastPatch filter in runtime bundle");
  const [, quietFnName, , quietSetName] = filterMatch;
  const shouldWarnSlow = runInNewContext(
    `${filterMatch[0]}\n${quietFnName}`,
    { [quietSetName]: new Set(["server.getUsageSummary"]) }
  );
  assert.equal(shouldWarnSlow("review.getDiffPreview"), false);
  assert.equal(shouldWarnSlow("review.getBranchCommits"), false);
  assert.equal(shouldWarnSlow("pullRequests.list"), false);
  assert.equal(shouldWarnSlow("terminal.open"), true);
}

function verifyLauncherAddress(asar) {
  if (floatingRuntimeIsExternal(asar)) return verifyExternalFloatingRuntime(asar);
  const patch = workspaceFloatingPanels;
  const chat = findUniqueEntry(asar, patch.targetRegex, patch.id).content.toString("utf8");
  const openAddress = chat.match(/^function T3NavigateBrowser\([\s\S]+?^\}/m);
  const previewImport = chat.match(/o as T3ResolveBrowserAddress,s as T3BrowserSearchTemplate\}from"\.\/([^"]+)"/);
  assert(openAddress && previewImport, "The launcher must reuse the browser address bar resolver");
  const preview = findUniqueEntry(asar, new RegExp("/" + previewImport[1].replace(".", "\\.") + "$"), "browser address resolver");
  const resolver = preview.content.toString("utf8").replace(/^import[^;]+;import[^;]+;/, "")
    .replace(/export\{[^}]+\}[\s\S]*$/, "");
  const fakeSchema = () => {};
  const { C: resolve, S: template } = runInNewContext(resolver + "\n({ C, S })", {
    URL, s: () => false,
    o: () => () => class extends Error {},
    i: null, a: null, e: fakeSchema, t: fakeSchema, r: fakeSchema, n: fakeSchema,
  });
  const navigate = runInNewContext(openAddress[0] + "\nT3NavigateBrowser", {
    T3ResolveBrowserAddress: resolve,
    T3BrowserSearchTemplate: template,
    T3GetBrowserSettings: () => ({ browserSearchEngine: "custom", browserCustomSearchUrl: "https://search.example/?q=%s" }),
  });
  const open = (profileId, url) => [profileId, url];
  assert.deepEqual(navigate("https://example.com/docs", open), [undefined, "https://example.com/docs"]);
  assert.deepEqual(navigate("localhost:5173", open), [undefined, "http://localhost:5173/"]);
  assert.deepEqual(navigate(" 搜索 文件 ", open), [undefined, "https://search.example/?q=%E6%90%9C%E7%B4%A2%20%E6%96%87%E4%BB%B6"]);
  assert.throws(() => navigate("javascript:alert(1)", open));
  assert.match(chat, /DA\(\{threadRef:r,openPreview:D,url,\.\.\./);
  assert.match(chat, /openPreview:e\.openPreview,threadRef:e\.threadRef,url:e\.url/);
}

function findNodes(node, pred, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  if (node.props && node.props.children !== undefined) findNodes(node.props.children, pred, out);
  return out;
}

function verifyUsageRingsUX(asar) {
  const chat = findUniqueEntry(asar, usageRings.targetRegex, usageRings.id).content.toString("utf8");
  assert.match(chat, /T3ComposerCtxProvider,\{canAttach:[\w$]+,/);
  assert.match(chat, /T3ComposerQuotaRingMemo,\{providerInstanceId:[\w$]+,activeModel:[\w$]+\}/);
  assert.match(chat, /T3RingsCtxProvider,\{threadRef:[\w$]+,providerInstanceId:[\w$]+,/);
  assert.match(chat, /providerTurns:([\w$]+)\?\.providerTurns,activeProviderThreadId:\1\?\.thread\?\.activeProviderThreadId/);
  const runtimeSource = fs.readFileSync(path.join(__dirname, "..", "lib", "runtime", "usage-rings-ui.mjs"), "utf8");
  assert.match(runtimeSource, /\.t3e-slider-fill \{[\s\S]*?z-index: 1;/);
  assert.match(runtimeSource, /\.t3e-effort-tick \{[\s\S]*?z-index: 2;/);
  assert.match(runtimeSource, /\.t3e-effort-tick\[data-filled="true"\]/);
  assert.match(runtimeSource, /\.t3e-slider-thumb \{[\s\S]*?z-index: 3;/);

  // The generated bridge must hand every host binding to the runtime. A missing or stale alias
  // silently turns into `undefined` (or a wrong host export) only inside the user's app.
  const bridgeMatch = chat.match(/\} = createUsageRingsRuntime\(\{([\s\S]*?)\n\}\);/);
  assert(bridgeMatch, "Missing usage-rings runtime bridge in patched ThreadRouteView bundle");
  const bridgeBindings = Object.fromEntries([...bridgeMatch[1].matchAll(/^\s*([\w$]+):\s*([\w$.]+),?$/gm)].map((m) => [m[1], m[2]]));
  const hostDestructure = runtimeSource.match(/export function createUsageRingsRuntime\(host\) \{\s*const \{([\s\S]*?)\} = host;/);
  assert(hostDestructure, "Could not read the usage-rings host contract");
  const hostKeys = hostDestructure[1].split(",").map((s) => s.trim()).filter((s) => s && !s.includes("="));
  assert(hostKeys.length > 40, "Host contract unexpectedly small");
  for (const key of hostKeys) assert(bridgeBindings[key], `Usage-rings bridge does not bind host key ${key}`);
  const paceTable = chat.match(/\b(?:var|let|const)\s+([\w$]+)=\{ahead:[^{}]*?`Ahead of pace`/);
  assert(paceTable, "Missing the host pace label table");
  assert.equal(bridgeBindings.paceLabels, paceTable[1], "paceLabels must be the host pace label table");
  assert.notEqual(bridgeBindings.paceLabels, bridgeBindings.getLimitsUnavailable, "paceLabels and getLimitsUnavailable are different host bindings");
  const { tokenize, parseImports, parseExports, getTopLevelDeclSource } = require("../lib/js-ast.cjs");
  const chatImports = parseImports(tokenize(chat));
  const runtimeChunkLocals = new Set(
    chatImports
      .filter((imp) => /(?:^|\/)runtime-[\w-]+\.js$/.test(imp.specifier))
      .flatMap((imp) => imp.specifiers.map((s) => s.local))
  );
  for (const key of ["resolveAccountLimits", "getWindowLeftPct", "getWindowPace", "getWindowTimeLeft"]) {
    assert(runtimeChunkLocals.has(bridgeBindings[key]), `${key} must be imported from the host runtime chunk, not a stale fallback name`);
  }
  // Verify useModelTraits binds to the controller hook (returning selectValue/changeSelect/changeBoolean), not the pure resolver
  const traitsImp = chatImports.find((imp) => imp.specifiers.some((s) => s.local === bridgeBindings.useModelTraits));
  assert(traitsImp, `useModelTraits (${bridgeBindings.useModelTraits}) must be imported from host utils`);
  const traitsSpec = traitsImp.specifiers.find((s) => s.local === bridgeBindings.useModelTraits);
  const traitsChunkKey = path.posix.join("apps/server/dist/client/assets", path.posix.basename(traitsImp.specifier));
  const traitsChunkText = entryText(asar, asar.byKey.get(traitsChunkKey));
  const traitsExp = parseExports(traitsChunkText).find((ex) => ex.exported === traitsSpec.imported);
  const traitsDecl = traitsExp ? getTopLevelDeclSource(traitsChunkText, traitsExp.local) : "";
  assert(
    traitsDecl.includes("selectValue:") && traitsDecl.includes("changeSelect:") && traitsDecl.includes("changeBoolean:"),
    `useModelTraits (${bridgeBindings.useModelTraits} -> ${traitsSpec.imported}) must resolve to the traits hook with selectValue/changeSelect/changeBoolean`
  );
  // Verify useI18n resolves to the M(...) payload decoder ($_source) and useFormatMessage to plain ICU formatter
  const resolveUtilsDecl = (localName, label) => {
    const imp = chatImports.find((entry) => entry.specifiers.some((s) => s.local === localName));
    assert(imp, `${label} (${localName}) must be imported from host utils`);
    const spec = imp.specifiers.find((s) => s.local === localName);
    const chunkKey = path.posix.join("apps/server/dist/client/assets", path.posix.basename(imp.specifier));
    const chunkText = entryText(asar, asar.byKey.get(chunkKey));
    const exp = parseExports(chunkText).find((e) => e.exported === spec.imported);
    return exp ? getTopLevelDeclSource(chunkText, exp.local) : "";
  };
  const i18nDecl = resolveUtilsDecl(bridgeBindings.useI18n, "useI18n");
  assert(i18nDecl.includes("$_source"), "useI18n must resolve to the M(...) message decoder containing $_source");
  const fmtMsgDecl = resolveUtilsDecl(bridgeBindings.useFormatMessage, "useFormatMessage");
  assert(fmtMsgDecl.includes("ICU") && !fmtMsgDecl.includes("$_source"), "useFormatMessage must resolve to the plain ICU formatter");
  // Regression #9: useStore must match the exact host hook reading canAttachEnvSelector (e.g. Effect-Atom useAtomValue),
  // never Zustand's 2-argument useStore(storeApi, selector) which crashes with "e.getState is not a function" on '+' click.
  const hostCanAttachCall = chat.match(
    new RegExp(`([A-Za-z_$][\\w$]*)=${bridgeBindings.canAttachEnvSelector}\\([^)]*\\)[^;]{0,80};\\s*(?:let|const|var)\\s+[A-Za-z_$][\\w$]*=([A-Za-z_$][\\w$]*)\\(\\1\\)`)
  );
  assert(hostCanAttachCall, "Could not locate host canAttachEnvSelector reader hook in ThreadRouteView");
  assert.equal(
    bridgeBindings.useStore,
    hostCanAttachCall[2],
    `useStore (${bridgeBindings.useStore}) must match the host hook (${hostCanAttachCall[2]}) reading canAttachEnvSelector`
  );
  const useStoreDecl = resolveUtilsDecl(bridgeBindings.useStore, "useStore");
  assert(
    !useStoreDecl.includes("getInitialState") && !useStoreDecl.includes(".getState("),
    `useStore must not bind to Zustand's 2-arg useStore(storeApi, selector): ${useStoreDecl}`
  );
  // Verify threadAtoms resolves to the entities thread-atom registry (threadAtom + quietThreadAtom)
  // and atomRegistry resolves to the Effect-Atom Registry (.subscribe + Provider value)
  const resolveChunkExport = (localName, label) => {
    const imp = chatImports.find((entry) => entry.specifiers.some((s) => s.local === localName));
    assert(imp, `${label} (${localName}) must be imported in ThreadRouteView`);
    const spec = imp.specifiers.find((s) => s.local === localName);
    const chunkKey = path.posix.join("apps/server/dist/client/assets", path.posix.basename(imp.specifier));
    const chunkText = entryText(asar, asar.byKey.get(chunkKey));
    const exp = parseExports(chunkText).find((e) => e.exported === spec.imported);
    assert(exp, `${label} (${spec.imported}) must be exported by ${chunkKey}`);
    return { exp, chunkText, chunkKey };
  };
  const taResolved = resolveChunkExport(bridgeBindings.threadAtoms, "threadAtoms");
  assert(
    taResolved.chunkText.includes(`${taResolved.exp.local}.threadAtom(`) &&
      taResolved.chunkText.includes(`${taResolved.exp.local}.quietThreadAtom(`),
    "threadAtoms must resolve to the entities export providing threadAtom() and quietThreadAtom()"
  );
  const regResolved = resolveChunkExport(bridgeBindings.atomRegistry, "atomRegistry");
  assert(
    regResolved.chunkText.includes(`${regResolved.exp.local}.subscribe(`) &&
      regResolved.chunkText.includes(`{value:${regResolved.exp.local}}`),
    "atomRegistry must resolve to the global Effect-Atom Registry (.subscribe + Context value)"
  );

  const jsx = (type, props) => ({ type, props: props || {} });
  let activeRingsCtx = null;
  let quotaSelection;
  let activeContextWindow = null;
  let activeThreadStats = null;
  let activeLiveSpeed = null;
  const states = [];
  let stateCursor = 0;
  let openArg = true;
  const memoSlots = [];
  let memoCursor = 0;
  const effectSlots = [];
  let effectCursor = 0;
  let pendingEffects = [];
  const flushEffects = () => {
    const queue = pendingEffects.splice(0);
    for (const item of queue) {
      effectSlots[item.idx].cleanup?.();
      effectSlots[item.idx].cleanup = item.fn() || null;
    }
  };
  let paceMock = null;
  let timeLeftMock = null;

  // Globals the runtime module reads directly (the shipped asset runs in the page).
  const sandbox = {
    document: { getElementById: () => null, head: { appendChild() {} }, querySelector: () => ({}), createElement: () => ({ style: {}, set textContent(v) {} }) },
    window: { requestAnimationFrame: () => {} },
    navigator: {},
    setTimeout,
    clearTimeout,
  };
  const React = {
    createContext: (def) => ({ _def: def, Provider: Symbol("ContextProvider") }),
    useContext: (ctx) => {
      if (ctx === sandbox.T3ContextWindowCtx) return activeContextWindow;
      if (ctx === sandbox.T3ThreadStatsCtx) return activeThreadStats;
      if (ctx === sandbox.T3LiveSpeedCtx) return activeLiveSpeed;
      return activeRingsCtx;
    },
    useState: (init) => {
      const idx = stateCursor++;
      if (!(idx in states)) states[idx] = typeof init === "function" ? init() : init;
      return [states[idx], (v) => { states[idx] = typeof v === "function" ? v(states[idx]) : v; }];
    },
    useRef: (init) => ({ current: init }),
    useEffect: (fn, deps) => {
      const idx = effectCursor++;
      const prev = effectSlots[idx];
      const same = prev && Array.isArray(deps) && Array.isArray(prev.deps) && deps.length === prev.deps.length && deps.every((d, i) => Object.is(d, prev.deps[i]));
      effectSlots[idx] = { deps, cleanup: prev?.cleanup ?? null };
      if (!same) pendingEffects.push({ idx, fn });
    },
    useMemo: (fn, deps) => {
      const idx = memoCursor++;
      const prev = memoSlots[idx];
      const same = prev && Array.isArray(deps) && prev.deps && deps.length === prev.deps.length && deps.every((d, i) => Object.is(d, prev.deps[i]));
      if (same) return prev.val;
      const val = fn();
      memoSlots[idx] = { deps, val };
      return val;
    },
    useCallback: (fn, deps) => React.useMemo(() => fn, deps),
  };
  let useModelTraitsImpl = () => ({ selectDescriptors: [], booleanDescriptors: [], selectValue: () => "high" });
  let findEffortTraitImpl = () => ({ effort: { kind: "select", descriptor: { id: "reasoning", defaultValue: "medium" } } });
  let findSpeedTraitImpl = () => ({ speedSelect: null, fastToggle: null });
  let getSelectChoicesImpl = () => [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "max", label: "Max" }];
  const host = {
    React,
    jsx,
    jsxs: jsx,
    Fragment: Symbol("Fragment"),
    useI18n: () => (v) => (typeof v === "string" ? v.replace(/:eyJ[A-Za-z0-9+/=]+$/, "") : v),
    useFormatMessage: () => (v, params) => {
      let s = String(v);
      if (params) {
        for (const [k, val] of Object.entries(params)) s = s.replace(`{${k}}`, String(val));
      }
      return s;
    },
    useLocale: () => "en-US",
    useMinuteNow: () => "2026-11-25T00:00",
    useSettingsSelector: () => () => "",
    timestampFormatSelector: null,
    formatCompactTokens: String,
    formatDuration: (_ms, fmt) => (typeof fmt === "function" ? fmt("2h:eyJkYXlzIjowLCJob3VycyI6Mn0=") : "2h"),
    formatTimestamp: () => "12/1 23:44",
    paceLabels: { ahead: "Ahead of pace", on: "On pace", under: "Under pace" },
    resolveAccountLimits: () => null,
    getLimitsUnavailable: () => null,
    getWindowLeftPct: (w) => Math.max(0, 100 - (w.usedPercent ?? 0)),
    getWindowPace: () => paceMock,
    getWindowTimeLeft: () => timeLeftMock,
    DetailsSection: "Section",
    DetailsRow: "Row",
    Link: "Link",
    Tooltip: "TipRoot",
    TooltipTrigger: "TipTrig",
    TooltipPopup: "TipContent",
    Popover: "PopoverRoot",
    PopoverTrigger: "PopoverTrigger",
    PopoverPopup: "PopoverContent",
    PlusIcon: "PlusIcon",
    ProviderIcon: "Yd",
    composerDraftStore: () => null,
    useModelTraits: (...args) => useModelTraitsImpl(...args),
    findEffortTrait: (...args) => findEffortTraitImpl(...args),
    findSpeedTrait: (...args) => findSpeedTraitImpl(...args),
    getSelectChoices: (...args) => getSelectChoicesImpl(...args),
    isProviderReady: () => true,
    preventDefault: () => {},
  };
  Object.assign(sandbox, loadRuntimeModule("usage-rings-ui", sandbox).exports.createUsageRingsRuntime(host));

  // 0) Context providers keep stable === value references across unrelated renders, and closed popovers omit heavy body JSX
  memoCursor = 0;
  const compRefObj = { current: { focusAtEnd() {} } };
  const cNode1 = sandbox.T3ComposerCtxProvider({ composerRef: compRefObj, activeModel: "gpt-6", children: "c" });
  memoCursor = 0;
  const cNode2 = sandbox.T3ComposerCtxProvider({ composerRef: compRefObj, activeModel: "gpt-6", children: "c" });
  assert.equal(cNode1.props.value, cNode2.props.value, "T3ComposerCtx value must stay referentially identical across keystrokes");
  memoSlots.length = 0;
  memoCursor = 0;
  const emptyArr = [];
  const providerProps = { providerInstanceId: "p1", providers: emptyArr, sources: emptyArr, contextWindow: null, activeModel: "m1", runs: emptyArr, messages: emptyArr, turnItems: emptyArr, children: "c" };
  stateCursor = 0;
  const rNode1 = sandbox.T3RingsCtxProvider(providerProps);
  stateCursor = 0;
  memoCursor = 0;
  const rNode2 = sandbox.T3RingsCtxProvider(providerProps);
  assert.equal(rNode1.props.value, rNode2.props.value, "T3RingsCtx value must stay referentially identical across unrelated ChatView renders");
  stateCursor = 0;
  memoCursor = 0;
  const newWindow = { usedTokens: 40 };
  const newTurnItems = [{ type: "file_change" }];
  const rNode3 = sandbox.T3RingsCtxProvider({ ...providerProps, contextWindow: newWindow, turnItems: newTurnItems });
  assert.equal(rNode3.props.value, rNode2.props.value, "Context or history updates must not notify quota consumers");
  assert.equal(rNode3.props.children.props.value, newWindow);
  assert.equal(rNode3.props.children.props.children.props.value.turnItems, newTurnItems);
  states.length = 0;
  memoSlots.length = 0;
  effectSlots.length = 0;
  pendingEffects.length = 0;
  stateCursor = 0;
  memoCursor = 0;
  effectCursor = 0;
  const closedPlusTree = sandbox.T3ComposerPlusMenu();
  const plusPopup = findNodes(closedPlusTree, (n) => n.type === "PopoverContent")[0];
  assert.equal(plusPopup.props.children, null, "Closed T3ComposerPlusMenu must not mount or compute T3ComposerPlusMenuBody");
  states.length = 0;
  memoSlots.length = 0;
  memoCursor = 0;

  // 1) T3EffortSlider ticks remain visible inside & outside fill bar
  const sliderTree = sandbox.T3EffortSlider({
    steps: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "max", label: "Max" }],
    activeIndex: 2,
    disabled: false,
    onSelectIndex: () => {},
  });
  const ticks = findNodes(sliderTree, (n) => n.props && n.props.className === "t3e-effort-tick");
  assert.equal(ticks.length, 4);
  assert.deepEqual(ticks.map((t) => t.props["data-filled"] === "true"), [true, true, true, false]);

  // 2) T3ComposerQuotaRing tracks composer harness & model dynamically even when outer vs differs
  const providers = [
    {
      instanceId: "codex-1",
      displayName: "Codex",
      usageLimits: {
        windows: [
          { id: "primary", label: "5-hour limit", usedPercent: 10 },
          { id: "secondary", label: "Weekly limit", usedPercent: 20 },
        ],
      },
    },
    {
      instanceId: "ag-2",
      displayName: "Antigravity2",
      usageLimits: {
        windows: [
          { id: "gem-5h", label: "Gemini · 5-hour", usedPercent: 5, resetsAt: "2026-11-25T05:00:00Z" },
          { id: "gem-7d", label: "Gemini · Weekly", usedPercent: 12, resetsAt: "2026-12-01T00:00:00Z" },
          { id: "cg-5h", label: "Claude & GPT (shared)", usedPercent: 60, resetsAt: "2026-11-25T05:00:00Z" },
          { id: "cg-7d", label: "Claude & GPT (shared)", usedPercent: 55, resetsAt: "2026-12-01T00:00:00Z" },
        ],
      },
    },
    { instanceId: "claude-vps", displayName: "Claude VPS" },
  ];
  activeRingsCtx = { providerInstanceId: "codex-1", activeModel: "gpt-6", providers, sources: [] };
  quotaSelection = { providerInstanceId: "ag-2", activeModel: "claude-opus-4-6-thinking" };
  stateCursor = 0;
  let ringTree = sandbox.T3ComposerQuotaRing(quotaSelection);
  assert.match(JSON.stringify(ringTree), /Antigravity2.*40%/);
  const paired = usageRings.t3PairUsageWindows(providers[1].usageLimits.windows);
  const popoverProps = { paired, now: Date.parse("2026-11-25T00:00:00Z"), tFn: (v) => v, fmtFn: (v) => String(v), activeQuota: paired.find(({ key }) => key === "cg-5h:cg-7d"), providerName: "Antigravity2", onClose: () => {} };
  const popCard = sandbox.T3QuotaPopoverCard(popoverProps);
  assert.match(JSON.stringify(popCard), /Antigravity2 · Live quota/);
  sandbox.document.documentElement = { lang: "zh-CN" };
  const popCardZh = sandbox.T3QuotaPopoverCard(popoverProps);
  assert.match(JSON.stringify(popCardZh), /Antigravity2 · 实时配额/);
  const turn = {
    providerThreadId: "active", status: "completed",
    startedAt: "2026-11-25T00:00:00Z", completedAt: "2026-11-25T00:00:10Z",
    turnTokenUsage: { usageStatus: "complete", outputTokens: 940 },
  };
  const usage = {
    usedTokens: 252000, maxTokens: 451000, usedPercentage: 56, autoCompactThreshold: 390000,
    inputTokens: 41860, outputTokens: 940, cachedInputTokens: 36000,
  };
  const stats = {
    runs: [{}, {}, {}], messages: [{}], activeProviderThreadId: "active",
    turnItems: [...Array(12).fill({ type: "file_change" }), { type: "assistant_message" }],
    providerTurns: [
      { ...turn, providerThreadId: "other", completedAt: "2026-11-25T00:00:11Z" },
      turn,
      { ...turn, status: "running", completedAt: null },
    ],
  };
  const renderContextCard = (statsInput) => {
    activeThreadStats = statsInput;
    memoCursor = 0;
    return sandbox.T3ContextPopoverCard({ usage, loc: "zh-CN" });
  };
  const contextCard = renderContextCard(stats);
  const metricValue = (tree, key) => findNodes(tree, (node) => node.props?.["data-metric"] === key)[0].props.children[1].props.children;
  assert.equal(metricValue(contextCard, "activity")[0], "3 轮 · 12 步");
  assert.equal(metricValue(contextCard, "speed")[0], "94");
  assert.equal(metricValue(contextCard, "speed")[1].props.children, "tok/s");
  assert.equal(metricValue(contextCard, "tokens")[0], "42.8k");
  assert.equal(metricValue(contextCard, "cache")[0], "86.0%");
  for (const incomplete of [
    { ...turn, turnTokenUsage: { usageStatus: "partial", outputTokens: 940 } },
    { ...turn, startedAt: turn.completedAt },
  ]) {
    const incompleteCard = renderContextCard({ ...stats, providerTurns: [incomplete] });
    assert.equal(metricValue(incompleteCard, "speed")[0], "—");
    assert.equal(metricValue(incompleteCard, "speed")[1], null);
  }
  // Provider without detailed token breakdown (e.g. Antigravity ACP) & in-progress Turn 1:
  // context occupancy renders while rate/total tokens/cache hit show "—" with provider hint.
  activeThreadStats = {
    runs: [{}],
    messages: [{}],
    activeProviderThreadId: "ag-thread",
    turnItems: Array(12).fill({ type: "command_execution" }),
    providerTurns: [{ providerThreadId: "ag-thread", status: "running", turnTokenUsage: { usageStatus: "unavailable" } }],
  };
  memoCursor = 0;
  const acpRunningCard = sandbox.T3ContextPopoverCard({
    usage: { usedTokens: 354760, maxTokens: 1048576, usedPercentage: 34, autoCompactThreshold: null },
    loc: "zh-CN",
  });
  assert.equal(metricValue(acpRunningCard, "activity")[0], "1 轮 · 12 步");
  for (const key of ["speed", "tokens", "cache"]) {
    const metricEl = findNodes(acpRunningCard, (node) => node.props?.["data-metric"] === key)[0];
    assert.equal(metricValue(acpRunningCard, key)[0], "—");
    assert.equal(metricEl.props.title, "当前提供方未上报此项明细指标");
  }
  // Per-turn pairs must NEVER fabricate totals by mixing Turn A inputTokens with Turn B outputTokens,
  // while still summing turns that each reported a complete pair on their own.
  activeThreadStats = {
    runs: [{}, {}],
    messages: [{}],
    activeProviderThreadId: "disjoint-only-thread",
    turnItems: [],
    providerTurns: [
      { providerThreadId: "disjoint-only-thread", status: "completed", turnTokenUsage: { usageStatus: "complete", inputTokens: 1000 } },
      { providerThreadId: "disjoint-only-thread", status: "completed", turnTokenUsage: { usageStatus: "complete", outputTokens: 100 } },
    ],
  };
  memoCursor = 0;
  const disjointOnlyCard = sandbox.T3ContextPopoverCard({
    usage: { usedTokens: 1000, maxTokens: 200000, usedPercentage: 1, autoCompactThreshold: null },
    loc: "zh-CN",
  });
  assert.equal(metricValue(disjointOnlyCard, "tokens")[0], "—", "Disjoint turn input/output fields without a complete pair must not fabricate total tokens");
  assert.equal(metricValue(disjointOnlyCard, "cache")[0], "—", "Turns lacking cachedInputTokens must not fabricate cache hit rate");

  // Mixed turns where Turn 1 only has cache pair, Turn 2 only output, Turn 3 complete IO:
  // each metric sums only valid per-turn pairs (never cross-turn mixing) and annotates partial turn coverage.
  activeThreadStats = {
    runs: [{}, {}, {}],
    messages: [{}],
    activeProviderThreadId: "mixed-thread",
    turnItems: [{ type: "command_execution" }],
    providerTurns: [
      { providerThreadId: "mixed-thread", status: "completed", turnTokenUsage: { usageStatus: "complete", inputTokens: 1000, cachedInputTokens: 100 } },
      { providerThreadId: "mixed-thread", status: "completed", turnTokenUsage: { usageStatus: "complete", outputTokens: 100 } },
      { providerThreadId: "mixed-thread", status: "completed", turnTokenUsage: { usageStatus: "complete", inputTokens: 500, outputTokens: 50 } },
    ],
  };
  memoCursor = 0;
  const disjointCard = sandbox.T3ContextPopoverCard({
    usage: { usedTokens: 1000, maxTokens: 200000, usedPercentage: 1, autoCompactThreshold: null },
    loc: "zh-CN",
  });
  assert.equal(metricValue(disjointCard, "tokens")[0], "550", "Must sum only complete per-turn IO pairs without mixing disjoint turns");
  assert.equal(metricValue(disjointCard, "cache")[0], "10.0%", "Must average only complete per-turn cache pairs without diluting denominator");
  assert.match(String(findNodes(disjointCard, (n) => n.props?.["data-metric"] === "tokens")[0].props.title || ""), /1\/3/);

  // Completed turn omitting tokenUsage/unavailable, plus interrupted/failed/cancelled/promptDropped turns:
  // must skip failed/unavailable turns cleanly and accumulate remaining valid completed turns.
  activeThreadStats = {
    runs: [{}, {}, {}, {}, {}, {}],
    messages: [{}],
    activeProviderThreadId: "partial-thread",
    turnItems: [],
    providerTurns: [
      { providerThreadId: "partial-thread", status: "completed", turnTokenUsage: { usageStatus: "complete", inputTokens: 100, outputTokens: 20, cachedInputTokens: 50 } },
      { providerThreadId: "partial-thread", status: "completed", turnTokenUsage: { usageStatus: "complete", inputTokens: 200, outputTokens: 80, cachedInputTokens: 100 } },
      { providerThreadId: "partial-thread", status: "completed", turnTokenUsage: null },
      { providerThreadId: "partial-thread", status: "interrupted", turnTokenUsage: { usageStatus: "partial", inputTokens: 999, outputTokens: 1 } },
      { providerThreadId: "partial-thread", status: "failed", turnTokenUsage: { usageStatus: "unavailable" } },
      { providerThreadId: "partial-thread", status: "completed", promptDropped: true, turnTokenUsage: { usageStatus: "complete", inputTokens: 5000, outputTokens: 500 } },
    ],
  };
  memoCursor = 0;
  const missingTurnCard = sandbox.T3ContextPopoverCard({
    usage: { usedTokens: 300, maxTokens: 200000, usedPercentage: 1, autoCompactThreshold: null, inputTokens: 200, outputTokens: 80, cachedInputTokens: 100, totalProcessedTokens: null },
    loc: "zh-CN",
  });
  assert.equal(metricValue(missingTurnCard, "tokens")[0], "400", "Must accumulate valid completed turns (120 + 280) and beat single-turn usage fallback (280)");
  assert.equal(metricValue(missingTurnCard, "cache")[0], "50.0%", "Must compute cumulative avg cache hit (150 / 300) across valid completed turns");
  const missingTokNode = findNodes(missingTurnCard, (n) => n.props?.["data-metric"] === "tokens")[0];
  assert.match(String(missingTokNode.props.title || ""), /2\/3/);

  // Hourly + Weekly pairing must label dynamically as 1h / 7d (never hardcoded 5h / 7d)
  const hourlyWeeklyPaired = usageRings.t3PairUsageWindows([
    { id: "claude-hourly", label: "Claude Hourly", usedPercent: 15, resetsAt: "2026-11-25T01:00:00Z" },
    { id: "claude-weekly", label: "Claude Weekly", usedPercent: 30, resetsAt: "2026-12-01T00:00:00Z" },
  ]);
  assert.equal(hourlyWeeklyPaired.length, 1);
  assert.equal(hourlyWeeklyPaired[0].kind, "dual");
  const hwPopJson = JSON.stringify(sandbox.T3QuotaPopoverCard({
    paired: hourlyWeeklyPaired,
    now: Date.parse("2026-11-25T00:00:00Z"),
    tFn: (v) => v,
    fmtFn: (v) => String(v),
    activeQuota: hourlyWeeklyPaired[0],
    providerName: "",
    onClose: () => {},
  }));
  assert(hwPopJson.includes("1h ") && hwPopJson.includes("7d "), "Quota popover must label hourly window dynamically as 1h");
  assert(!hwPopJson.includes("5h"), "Hourly+Weekly pair must NEVER be mislabeled 5h");
  activeContextWindow = usage;
  activeThreadStats = stats;
  states.length = 0;
  stateCursor = 0;
  sandbox.T3ComposerContextRing().props.onOpenChange(true);
  stateCursor = 0;
  const openContextRing = sandbox.T3ComposerContextRing();
  const openContextPopup = findNodes(openContextRing, (node) => node.type === "PopoverContent")[0];
  assert.equal(openContextPopup.props.children.type, sandbox.T3ContextPopoverCard);
  assert.equal(openContextPopup.props.children.props.usage, usage);

  // Live unified tok/s streaming across reasoning -> tool pause -> assistant_message + Turn-1 null contextWindow
  states.length = 0;
  memoSlots.length = 0;
  effectSlots.length = 0;
  const runProviderTree = (statsInput, ctxWin = null) => {
    stateCursor = 0;
    memoCursor = 0;
    effectCursor = 0;
    pendingEffects.length = 0;
    const providerTree = sandbox.T3RingsCtxProvider({
      providerInstanceId: "ag-live",
      providers: [],
      sources: [],
      contextWindow: ctxWin,
      activeModel: "gemini-4-hydrogen",
      ...statsInput,
      children: { type: "Child", props: {} },
    });
    const speedProvider = findNodes(providerTree, (node) => node.type === sandbox.T3LiveSpeedCtx.Provider)[0];
    return speedProvider.props.value;
  };
  const liveTurn = {
    id: "turn-stream-1",
    providerThreadId: "ag-thread",
    status: "running",
    startedAt: "2026-11-25T00:00:00.000Z",
  };
  const r0 = {
    id: "r-0",
    type: "reasoning",
    providerTurnId: liveTurn.id,
    streaming: true,
    startedAt: "2026-11-25T00:00:00.200Z",
    updatedAt: "2026-11-25T00:00:00.200Z",
    text: "Thinking step one: check code",
  };
  // 1) First chunk with startedAt === updatedAt in reasoning-only turn immediately emits live tok/s
  const speedFrame1 = runProviderTree({
    runs: [{}],
    messages: [],
    activeProviderThreadId: "ag-thread",
    providerTurns: [liveTurn],
    turnItems: [r0],
  });
  assert(speedFrame1 && speedFrame1.value > 0 && speedFrame1.idle === false, "First reasoning chunk must produce immediate live tok/s");
  // Composer pill renders live tok/s even while Turn-1 contextWindow is still null, and popover handles usage === null
  const composerStatesStart = states.length;
  activeContextWindow = null;
  activeThreadStats = { runs: [{}], messages: [], activeProviderThreadId: "ag-thread", providerTurns: [liveTurn], turnItems: [r0] };
  activeLiveSpeed = speedFrame1;
  stateCursor = composerStatesStart;
  memoCursor = 0;
  const livePillNoCtx = sandbox.T3ComposerContextRing();
  assert(livePillNoCtx, "Composer pill must render live speed even when contextWindow is null");
  const livePillJson = JSON.stringify(livePillNoCtx);
  assert(livePillJson.includes("tok/s") && !livePillJson.includes("≈") && !livePillJson.includes("字符/秒"));
  livePillNoCtx.props.onOpenChange(true);
  stateCursor = composerStatesStart;
  memoCursor = 0;
  const openNoCtxCard = findNodes(sandbox.T3ComposerContextRing(), (node) => node.type === "PopoverContent")[0].props.children;
  assert.equal(openNoCtxCard.type, sandbox.T3ContextPopoverCard);
  const renderedNoCtxCard = sandbox.T3ContextPopoverCard({ usage: null, loc: "zh-CN" });
  const noCtxSpeedNode = findNodes(renderedNoCtxCard, (node) => node.props?.["data-metric"] === "speed")[0];
  assert.match(JSON.stringify(noCtxSpeedNode), /实时输出速度/);
  assert.equal(metricValue(renderedNoCtxCard, "speed")[1].props.children, "tok/s");

  // 2) Streaming growth -> 3s tool call pause preserves statistical mean (never drops to 0 or drags rate down) -> resumed assistant_message accumulates cleanly
  // Preserve provider hook slots only while stepping through frames
  states.length = composerStatesStart;
  memoSlots.length = 0;
  const r1 = {
    ...r0,
    updatedAt: "2026-11-25T00:00:01.200Z",
    text: "Thinking step one: check code".repeat(8),
  };
  const speedFrame2 = runProviderTree({
    runs: [{}],
    messages: [],
    activeProviderThreadId: "ag-thread",
    providerTurns: [liveTurn],
    turnItems: [r1],
  });
  assert(speedFrame2.value > 20 && speedFrame2.active === true, `Expected active streaming speed > 20, got ${speedFrame2.value}`);
  const toolWait = {
    id: "cmd-1",
    type: "command_execution",
    providerTurnId: liveTurn.id,
    status: "running",
    startedAt: "2026-11-25T00:00:01.300Z",
    updatedAt: "2026-11-25T00:00:04.500Z",
  };
  const speedToolIdle = runProviderTree({
    runs: [{}],
    messages: [],
    activeProviderThreadId: "ag-thread",
    providerTurns: [liveTurn],
    turnItems: [{ ...r1, streaming: false }, toolWait],
  });
  assert(
    Math.abs(speedToolIdle.value - speedFrame2.value) < 0.01 && speedToolIdle.value > 20,
    `Tool wait must preserve active output statistical mean without dropping to 0 or dragging down (got ${speedToolIdle.value} vs ${speedFrame2.value})`
  );
  assert.equal(speedToolIdle.idle, true);
  const resumedReply = {
    id: "msg-item-1",
    type: "assistant_message",
    providerTurnId: liveTurn.id,
    messageId: "msg-1",
    streaming: true,
    textOmitted: true,
    text: "",
    startedAt: "2026-11-25T00:00:04.600Z",
    updatedAt: "2026-11-25T00:00:04.600Z",
  };
  const speedResumed = runProviderTree({
    runs: [{}],
    messages: [{ id: "msg-1", text: "你好世界，这是工具执行完毕后立刻继续流式输出的正文。", updatedAt: "2026-11-25T00:00:04.800Z" }],
    activeProviderThreadId: "ag-thread",
    providerTurns: [liveTurn],
    turnItems: [{ ...r1, streaming: false }, { ...toolWait, status: "completed", completedAt: "2026-11-25T00:00:04.600Z" }, resumedReply],
  });
  assert(speedResumed.value >= 25 && speedResumed.idle === false, `Resumed output must stay at real model output speed without tool pause drag, got ${speedResumed.value}`);

  // 3) Composer pill displays context percentage alongside tok/s (replacing raw used-token count like 252k/37k)
  activeContextWindow = usage;
  activeLiveSpeed = speedResumed;
  states.length = composerStatesStart;
  stateCursor = composerStatesStart;
  memoCursor = 0;
  const combinedLivePill = sandbox.T3ComposerContextRing();
  const combinedText = JSON.stringify(combinedLivePill);
  assert(
    combinedText.includes("56%") && combinedText.includes("tok/s") && !combinedText.includes(String(usage.usedTokens)),
    `Composer pill must show context % + tok/s and replace raw token count (got ${combinedText})`
  );

  // 4) Finished turn without complete turnTokenUsage falls back to streamed output tok/s when text items exist,
  //    and composer pill continues showing context % + completed-turn tok/s outside
  activeLiveSpeed = null;
  const acpFinishedStats = {
    runs: [{}],
    messages: [{ id: "msg-1", text: "你好世界，测试一段完整的回答内容输出速率。", updatedAt: "2026-11-25T00:00:06.000Z" }],
    activeProviderThreadId: "ag-thread",
    providerTurns: [{
      id: "turn-done-no-usage",
      providerThreadId: "ag-thread",
      status: "completed",
      startedAt: "2026-11-25T00:00:00.000Z",
      completedAt: "2026-11-25T00:00:06.000Z",
      turnTokenUsage: { usageStatus: "unavailable" },
    }],
    turnItems: [
      { id: "msg-done", type: "assistant_message", providerTurnId: "turn-done-no-usage", messageId: "msg-1", textOmitted: true, text: "", startedAt: "2026-11-25T00:00:04.000Z", completedAt: "2026-11-25T00:00:06.000Z" },
    ],
  };
  memoSlots.length = 0;
  const acpFinishedCard = renderContextCard(acpFinishedStats);
  assert.notEqual(metricValue(acpFinishedCard, "speed")[0], "—", "Finished turn with real streamed output must compute fallback tok/s");
  assert.equal(metricValue(acpFinishedCard, "speed")[1].props.children, "tok/s");
  states.length = composerStatesStart;
  stateCursor = composerStatesStart;
  memoCursor = 0;
  const finishedOuterPill = JSON.stringify(sandbox.T3ComposerContextRing());
  assert(
    finishedOuterPill.includes("56%") && finishedOuterPill.includes("tok/s") && !finishedOuterPill.includes(String(usage.usedTokens)),
    "Completed-turn composer pill must replace concrete token count with tok/s alongside context %"
  );

  // 5) Real T3 Code 0.1.12 Effect DateTime.Utc + quietThreadAtom regression:
  //    - Effect Schema DateTimeUtc decodes timestamps into `{ _tag: "Utc", epochMilliseconds, toString() => "DateTime.Utc(...)" }`
  //      where `Date.parse(obj)` returns NaN!
  //    - ThreadRouteView's `q` comes from quietThreadAtom (which strips `text` & `updatedAt` from reasoning/assistant_message).
  {
    const mkUtc = (iso) => ({
      _tag: "Utc",
      epochMilliseconds: Date.parse(iso),
      toString() { return `DateTime.Utc(${iso})`; },
      toJSON() { return iso; },
    });
    assert(Number.isNaN(Date.parse(mkUtc("2026-11-26T10:05:07.422Z"))), "Sanity check: Date.parse on Effect DateTime.Utc must be NaN");

    const atomValues = new Map();
    const atomListeners = new Map();
    let activeSubCount = 0;
    const mockThreadAtoms = {
      threadAtom: ({ environmentId, threadId }) => `${environmentId}:${threadId}`,
    };
    const mockAtomRegistry = {
      get: (key) => atomValues.get(key) ?? null,
      subscribe: (key, fn, opts) => {
        if (!atomListeners.has(key)) atomListeners.set(key, new Set());
        atomListeners.get(key).add(fn);
        activeSubCount++;
        if (opts?.immediate) fn(atomValues.get(key) ?? null);
        return () => {
          const set = atomListeners.get(key);
          if (set && set.delete(fn)) activeSubCount--;
        };
      },
      push: (key, val) => {
        atomValues.set(key, val);
        for (const fn of [...(atomListeners.get(key) || [])]) fn(val);
      },
    };
    const liveSandbox = {
      ...sandbox,
      setTimeout: undefined,
      clearTimeout: undefined,
    };
    const liveRuntime = loadRuntimeModule("usage-rings-ui", liveSandbox).exports.createUsageRingsRuntime({
      ...host,
      threadAtoms: mockThreadAtoms,
      atomRegistry: mockAtomRegistry,
    });
    const origCtx = {
      T3ContextWindowCtx: sandbox.T3ContextWindowCtx,
      T3ThreadStatsCtx: sandbox.T3ThreadStatsCtx,
      T3LiveSpeedCtx: sandbox.T3LiveSpeedCtx,
    };
    sandbox.T3ContextWindowCtx = liveRuntime.T3ContextWindowCtx;
    sandbox.T3ThreadStatsCtx = liveRuntime.T3ThreadStatsCtx;
    sandbox.T3LiveSpeedCtx = liveRuntime.T3LiveSpeedCtx;

    states.length = 0;
    memoSlots.length = 0;
    effectSlots.length = 0;
    pendingEffects.length = 0;

    const stripQuiet = (items) =>
      items.map((item) => {
        if (item.type !== "reasoning" && item.type !== "assistant_message") return item;
        const { text: _t, updatedAt: _u, ...rest } = item;
        return rest;
      });

    const refA = { environmentId: "env-local", threadId: "thread-A" };
    const refB = { environmentId: "env-local", threadId: "thread-B" };
    const keyA = mockThreadAtoms.threadAtom(refA);
    const keyB = mockThreadAtoms.threadAtom(refB);

    const turnA = {
      id: "turn-a-1",
      providerThreadId: "pt-new",
      status: "running",
      startedAt: mkUtc("2026-11-26T10:05:00.691Z"),
    };
    const quietPropsA = {
      threadRef: refA,
      providerInstanceId: "ag-live",
      providers: [],
      sources: [],
      contextWindow: null,
      activeModel: "gemini-4-neon",
      runs: [{ startedAt: mkUtc("2026-11-26T10:05:00.585Z"), completedAt: null }],
      messages: [],
      activeProviderThreadId: "pt-old",
      providerTurns: [turnA],
      turnItems: stripQuiet([
        { id: "r-a0", type: "reasoning", providerTurnId: turnA.id, streaming: true, startedAt: mkUtc("2026-11-26T10:05:01.000Z"), updatedAt: mkUtc("2026-11-26T10:05:01.000Z"), text: "stripped" },
      ]),
      children: { type: "Child", props: {} },
    };
    const renderLiveProvider = (props) => {
      stateCursor = 0;
      memoCursor = 0;
      effectCursor = 0;
      liveRuntime.T3RingsCtxProvider(props);
      flushEffects();
      stateCursor = 0;
      memoCursor = 0;
      effectCursor = 0;
      const postTree = liveRuntime.T3RingsCtxProvider(props);
      const statsNode = findNodes(postTree, (n) => n.type === liveRuntime.T3ThreadStatsCtx.Provider)[0];
      const speedNode = findNodes(postTree, (n) => n.type === liveRuntime.T3LiveSpeedCtx.Provider)[0];
      return { statsVal: statsNode.props.value, speedVal: speedNode.props.value };
    };

    // Push live Effect DateTime.Utc reasoning frame while quietPropsA stays stripped
    const rA0 = {
      id: "r-a0",
      type: "reasoning",
      providerTurnId: turnA.id,
      streaming: true,
      startedAt: mkUtc("2026-11-26T10:05:01.000Z"),
      updatedAt: mkUtc("2026-11-26T10:05:01.000Z"),
      text: "Inspecting Effect DateTime.Utc and quietThreadAtom stripping in ThreadRouteView",
    };
    mockAtomRegistry.push(keyA, {
      environmentId: refA.environmentId,
      projection: {
        thread: { activeProviderThreadId: "pt-old" },
        providerTurns: [turnA],
        turnItems: [rA0],
        messages: [],
      },
    });
    const res1 = renderLiveProvider(quietPropsA);
    assert.equal(activeSubCount, 1, "T3RingsCtxProvider must subscribe to threadAtom");
    assert(
      res1.speedVal && res1.speedVal.value > 0 && res1.speedVal.idle === false,
      `Live atom subscription with DateTime.Utc must emit tok/s (got ${JSON.stringify(res1.speedVal)})`
    );

    // Proposed plan markdown streaming also drives statistical mean tok/s
    const planItem = {
      id: "plan-a1",
      type: "proposed_plan",
      providerTurnId: turnA.id,
      streaming: true,
      startedAt: mkUtc("2026-11-26T10:05:01.300Z"),
      updatedAt: mkUtc("2026-11-26T10:05:02.200Z"),
      markdown: "## Plan\n".repeat(30),
    };
    mockAtomRegistry.push(keyA, {
      environmentId: refA.environmentId,
      projection: {
        thread: { activeProviderThreadId: "pt-new" },
        providerTurns: [turnA],
        turnItems: [{ ...rA0, streaming: false }, planItem],
        messages: [],
      },
    });
    const resPlan = renderLiveProvider(quietPropsA);
    assert(resPlan.speedVal && resPlan.speedVal.value > 20 && resPlan.speedVal.idle === false, "proposed_plan markdown streaming must drive live tok/s");

    // 20s tool wait must preserve the statistical mean (idle=true, value unchanged & never dragged down by tool duration)
    const cmdA = {
      id: "cmd-a1",
      type: "command_execution",
      providerTurnId: turnA.id,
      status: "running",
      startedAt: mkUtc("2026-11-26T10:05:02.300Z"),
      updatedAt: mkUtc("2026-11-26T10:05:22.300Z"),
    };
    mockAtomRegistry.push(keyA, {
      environmentId: refA.environmentId,
      projection: {
        thread: { activeProviderThreadId: "pt-new" },
        providerTurns: [turnA],
        turnItems: [{ ...rA0, streaming: false }, { ...planItem, streaming: false }, cmdA],
        messages: [],
      },
    });
    const resIdle = renderLiveProvider(quietPropsA);
    assert(
      Math.abs(resIdle.speedVal.value - resPlan.speedVal.value) < 0.01 && resIdle.speedVal.value > 20,
      `20s tool wait must keep active-output mean intact, got ${resIdle.speedVal?.value} vs ${resPlan.speedVal?.value}`
    );
    assert.equal(resIdle.speedVal?.idle, true);

    // Exact reproduction of real Gemini 4 Neon Turn 2 with Effect DateTime.Utc:
    // 5s TTFT (10:05:00.691 -> 10:05:05.703), 1.719s visible output (10:05:05.703 -> 10:05:07.422),
    // outputTokens=169, reasoningTokens=63 (no reasoning turnItem) -> visible rate = (169-63)/1.719 = 61.7 tok/s, run duration = 6.9 秒!
    const doneTurnNeon = {
      id: "turn-neon-2",
      providerThreadId: "pt-new",
      status: "completed",
      startedAt: mkUtc("2026-11-26T10:05:00.691Z"),
      completedAt: mkUtc("2026-11-26T10:05:07.422Z"),
      turnTokenUsage: { usageStatus: "complete", inputTokens: 36770, outputTokens: 169, reasoningTokens: 63, cachedInputTokens: 0 },
    };
    const neonMsgItem = {
      id: "am-neon-2",
      type: "assistant_message",
      providerTurnId: doneTurnNeon.id,
      messageId: "m-neon-2",
      streaming: false,
      startedAt: mkUtc("2026-11-26T10:05:05.703Z"),
      completedAt: mkUtc("2026-11-26T10:05:07.422Z"),
      updatedAt: mkUtc("2026-11-26T10:05:07.422Z"),
      text: "你好！这是一个用于测试真实输出速率的示例回复内容。".repeat(6),
    };
    mockAtomRegistry.push(keyA, {
      environmentId: refA.environmentId,
      projection: {
        thread: { activeProviderThreadId: "pt-new" },
        providerTurns: [doneTurnNeon],
        turnItems: [neonMsgItem],
        messages: [{ id: "m-neon-2", text: neonMsgItem.text, updatedAt: mkUtc("2026-11-26T10:05:07.422Z") }],
      },
    });
    const resDone = renderLiveProvider({
      ...quietPropsA,
      runs: [{ startedAt: mkUtc("2026-11-26T10:05:00.585Z"), completedAt: mkUtc("2026-11-26T10:05:07.496Z") }],
      providerTurns: [doneTurnNeon],
      activeProviderThreadId: "pt-new",
      turnItems: stripQuiet([neonMsgItem]),
      messages: [],
    });
    assert.equal(resDone.speedVal, null, "Completed turn must clear live speed");
    activeThreadStats = resDone.statsVal;
    activeLiveSpeed = null;
    activeContextWindow = { usedTokens: 36939, maxTokens: 1048576, usedPercentage: 3.52 };
    memoSlots.length = 0;
    memoCursor = 0;
    const donePopover = liveRuntime.T3ContextPopoverCard({ usage: activeContextWindow, loc: "zh-CN" });
    const doneSpeedNum = Number(String(metricValue(donePopover, "speed")[0]).replace(/,/g, ""));
    assert(
      doneSpeedNum >= 55 && doneSpeedNum <= 68,
      `Completed turn with DateTime.Utc must compute real model output rate (~61.7 tok/s excluding 5s TTFT), got ${metricValue(donePopover, "speed")[0]}`
    );
    assert.equal(metricValue(donePopover, "speed")[1].props.children, "tok/s");
    assert(JSON.stringify(donePopover).includes("6.9 秒"), "Completed run duration with DateTime.Utc must render 6.9 秒 instead of vanishing");

    // Outer composer pill shows "3.5% · 61.7 tok/s" (replacing raw "36939"/"37k")
    const pillStatesStart = states.length;
    stateCursor = pillStatesStart;
    memoCursor = 0;
    const neonPillJson = JSON.stringify(liveRuntime.T3ComposerContextRing());
    assert(
      neonPillJson.includes("3.5%") && neonPillJson.includes("61.7 tok/s") && !neonPillJson.includes("36939"),
      `Outer composer pill must show 3.5% + 61.7 tok/s without concrete token count, got ${neonPillJson}`
    );

    // Mid-turn thread switch into a long-running turn (2000 tokens over 40s = ~50 tok/s) must NOT spike
    states.length = pillStatesStart;
    const longTurnB = {
      id: "turn-b-long",
      providerThreadId: "pt-b",
      status: "running",
      startedAt: mkUtc("2026-11-26T10:00:00.000Z"),
    };
    const longTextB = "word ".repeat(1600);
    mockAtomRegistry.push(keyB, {
      environmentId: refB.environmentId,
      projection: {
        thread: { activeProviderThreadId: "pt-b" },
        providerTurns: [longTurnB],
        turnItems: [{
          id: "am-b1",
          type: "assistant_message",
          providerTurnId: longTurnB.id,
          streaming: true,
          startedAt: mkUtc("2026-11-26T10:00:00.000Z"),
          updatedAt: mkUtc("2026-11-26T10:00:40.000Z"),
          text: longTextB,
        }],
        messages: [],
      },
    });
    const resB = renderLiveProvider({ ...quietPropsA, threadRef: refB, providerTurns: [longTurnB], turnItems: [] });
    assert.equal(activeSubCount, 1, "Switching threadRef must unsubscribe previous threadAtom before subscribing new one");
    assert(
      resB.speedVal && resB.speedVal.value >= 45 && resB.speedVal.value <= 55,
      `Switching into 40s running turn (~50 tok/s) must yield exact ~50 tok/s without spike, got ${resB.speedVal?.value}`
    );

    // Switching back from streaming Thread B to idle Thread A must immediately yield null without leaking Thread B speed
    stateCursor = 0;
    memoCursor = 0;
    effectCursor = 0;
    const preEffectBackToA = liveRuntime.T3RingsCtxProvider({ ...quietPropsA, threadRef: refA, providerTurns: [doneTurnNeon] });
    const preEffectSpeedA = findNodes(preEffectBackToA, (n) => n.type === liveRuntime.T3LiveSpeedCtx.Provider)[0].props.value;
    assert.equal(preEffectSpeedA, null, "Switching threads must not flash previous thread live speed even before effects flush");
    flushEffects();
    assert.equal(activeSubCount, 1);

    for (const slot of effectSlots) slot?.cleanup?.();
    assert.equal(activeSubCount, 0, "Unmounting T3RingsCtxProvider must unsubscribe threadAtom");
    sandbox.T3ContextWindowCtx = origCtx.T3ContextWindowCtx;
    sandbox.T3ThreadStatsCtx = origCtx.T3ThreadStatsCtx;
    sandbox.T3LiveSpeedCtx = origCtx.T3LiveSpeedCtx;
    effectSlots.length = 0;
    pendingEffects.length = 0;
  }

  activeContextWindow = null;
  activeLiveSpeed = null;
  memoSlots.length = 0;
  states.length = 0;
  stateCursor = 0;
  delete sandbox.document.documentElement;
  quotaSelection = { providerInstanceId: "ag-2", activeModel: "gemini-4-hydrogen" };
  stateCursor = 0;
  ringTree = sandbox.T3ComposerQuotaRing(quotaSelection);
  assert.match(JSON.stringify(ringTree), /Antigravity2.*95%/);
  quotaSelection = { providerInstanceId: "codex-1", activeModel: "gpt-6" };
  stateCursor = 0;
  ringTree = sandbox.T3ComposerQuotaRing(quotaSelection);
  assert.match(JSON.stringify(ringTree), /Codex.*90%/);
  quotaSelection = { providerInstanceId: "claude-vps", activeModel: "claude-sonnet-4-6" };
  stateCursor = 0;
  assert.equal(sandbox.T3ComposerQuotaRing(quotaSelection), null);

  // 3) T3UnifiedModelControls: switch Harness updates quota bar & model rows, model pick returns to effort without closing
  states.length = 0;
  const openEvents = [];
  const selectedCalls = [];
  const modelOptionsByInstance = new Map([
    ["codex-1", [{ slug: "gpt-6", name: "GPT-6" }]],
    ["ag-2", [
      { slug: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
      { slug: "claude-opus-4-6-thinking", name: "Claude Opus 4.6" },
      ...Array.from({ length: 5 }, (_, index) => ({ slug: "model-" + index, name: "Model " + index })),
    ]],
    ["claude-vps", [{ slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }]],
  ]);
  let modelListScans = 0;
  for (const options of modelOptionsByInstance.values()) {
    options.filter = function (predicate) {
      modelListScans++;
      return Array.prototype.filter.call(this, predicate);
    };
  }
  const instanceEntries = providers.map((p) => ({ instanceId: p.instanceId, displayName: p.displayName, driverKind: "codex", enabled: true }));
  const renderControls = () => {
    stateCursor = 0;
    return sandbox.T3UnifiedModelControls({
      traits: { model: "gpt-6" },
      instanceEntries,
      modelOptionsByInstance,
      activeInstanceId: "codex-1",
      activeModel: "gpt-6",
      lockedProvider: null,
      disabled: false,
      open: openArg,
      onOpenChange: (next) => { openArg = next; openEvents.push(next); },
      onSelectProviderModel: (inst, slug, opts) => { selectedCalls.push({ inst, slug, opts: opts ? { ...opts } : opts }); },
    });
  };
  let tree = renderControls();
  assert.equal(modelListScans, 0, "Effort view must not scan the model catalog");
  const switchBtn = findNodes(tree, (n) => n.props && n.props.className === "t3e-effort-switch-btn")[0];
  assert(switchBtn, "Initial view must show effort card with model switch button");
  switchBtn.props.onClick();
  tree = renderControls();
  assert.equal(modelListScans, 1, "Opening the model view scans the active catalog once");
  const agChip = findNodes(tree, (n) => n.props && n.props.className?.includes("t3e-harness-chip") && JSON.stringify(n).includes("Antigravity2"))[0];
  assert(agChip, "Must render Antigravity2 harness chip");
  agChip.props.onClick();
  tree = renderControls();
  const quotaBar = findNodes(tree, (n) => n.props && n.props.className === "t3e-harness-quota")[0];
  assert.equal(quotaBar.props["data-harness-id"], "ag-2");
  assert.match(JSON.stringify(quotaBar), /95%.*40%|40%.*95%/);
  const searchInput = (node) => findNodes(node, (item) => item.props?.className === "t3e-model-search")[0];
  searchInput(tree).props.onChange({ currentTarget: { value: "unmatched" } });
  tree = renderControls();
  assert.equal(searchInput(tree).props.value, "unmatched", "Keep the search input mounted after filtering out every model");
  assert.match(JSON.stringify(tree), /No matching models/);
  searchInput(tree).props.onChange({ currentTarget: { value: "" } });
  tree = renderControls();
  const claudeRow = findNodes(tree, (n) => n.props && String(n.props.className || "").includes("t3e-model-row") && JSON.stringify(n).includes("Claude Opus 4.6"))[0];
  assert.match(JSON.stringify(claudeRow), /40%/);
  claudeRow.props.onClick();
  assert.deepEqual(selectedCalls, [{ inst: "ag-2", slug: "claude-opus-4-6-thinking", opts: { focusComposer: false } }]);
  assert.deepEqual(openEvents, [], "Choosing a model must NOT close the popover");
  tree = renderControls();
  assert(findNodes(tree, (n) => n.props && n.props.className === "t3e-effort-card").length === 1, "Must return to effort view after picking model");

  // 4) Reset default effort across Codex (select+serviceTier), Claude (high default + fastMode), Antigravity/ACP (caps.currentValue), OpenCode (t3:default), and boolean thinking
  const createStatefulTraitsDriver = (spec) => {
    let options = Array.isArray(spec.initialOptions) ? spec.initialOptions.slice() : [];
    const dispatches = [];
    const buildCtrl = () => {
      const rawDescriptors = spec.optionDescriptors.map((d) => {
        const sel = options.find((o) => o.id === d.id);
        return sel ? { ...d, currentValue: sel.value } : { ...d };
      });
      return {
        caps: { optionDescriptors: spec.optionDescriptors },
        descriptors: rawDescriptors,
        selectDescriptors: rawDescriptors.filter((d) => d.type === "select"),
        booleanDescriptors: rawDescriptors.filter((d) => d.type === "boolean"),
        primarySelectDescriptor: rawDescriptors.find((d) => d.type === "select") ?? null,
        ultrathinkPromptControlled: Boolean(spec.ultrathinkPromptControlled),
        ultrathinkInBodyText: Boolean(spec.ultrathinkInBodyText),
        modelIsUnavailable: false,
        selectValue(desc) {
          if (!desc) return "";
          if (this.ultrathinkPromptControlled && desc.id === this.primarySelectDescriptor?.id) return "ultrathink";
          const sel = options.find((o) => o.id === desc.id);
          if (sel && typeof sel.value === "string") return sel.value;
          if (desc.id === "variant" && desc.options?.some((o) => o.id === "t3:default")) return "t3:default";
          if (typeof desc.currentValue === "string" && desc.currentValue) return desc.currentValue;
          return desc.options?.find((o) => o.isDefault)?.id ?? "";
        },
        changeSelect(desc, optionId) {
          dispatches.push({ kind: "select", id: desc.id, value: optionId });
          if (desc.promptInjectedValues?.includes(optionId) || (this.ultrathinkInBodyText && desc.id === this.primarySelectDescriptor?.id)) {
            return;
          }
          // Intentionally mirror real Q3 (useModelTraits): compute from snapshot rawDescriptors (stale on double sync calls!)
          options = rawDescriptors
            .map((d) => (d.id === desc.id ? { ...d, currentValue: optionId } : d))
            .filter((d) => d.currentValue !== undefined)
            .map((d) => ({ id: d.id, value: d.currentValue }));
        },
        changeBoolean(id, val) {
          dispatches.push({ kind: "boolean", id, value: Boolean(val) });
          options = rawDescriptors
            .map((d) => (d.id === id ? { ...d, currentValue: Boolean(val) } : d))
            .filter((d) => d.currentValue !== undefined)
            .map((d) => ({ id: d.id, value: d.currentValue }));
        },
      };
    };
    const resetRender = (modelId, instId = "inst-1") => {
      states.length = 0;
      memoSlots.length = 0;
      effectSlots.length = 0;
      pendingEffects.length = 0;
      return () => {
        stateCursor = 0;
        memoCursor = 0;
        effectCursor = 0;
        const t = sandbox.T3UnifiedModelControls({
          traits: { provider: spec.provider || "codex", instanceId: instId, model: modelId },
          instanceEntries: [{ instanceId: instId, driverKind: spec.provider || "codex", displayName: spec.provider || "Codex", enabled: true }],
          modelOptionsByInstance: new Map([[instId, [{ slug: modelId, name: modelId }]]]),
          activeInstanceId: instId,
          activeModel: modelId,
          disabled: false,
          open: true,
          onOpenChange: () => {},
        });
        flushEffects();
        return t;
      };
    };
    return { buildCtrl, resetRender, dispatches, getOptions: () => options };
  };

  let activeDriver = null;
  useModelTraitsImpl = () => activeDriver.buildCtrl();
  findEffortTraitImpl = (selects, bools) => {
    const filteredSelects = selects.filter((d) => d.id !== "serviceTier");
    const filteredBools = bools.filter((d) => d.id !== "fastMode" && d.id !== "ultracode");
    const effort =
      filteredSelects.map((d) => ({ kind: "select", descriptor: d })).find((e) => e.descriptor.role === "reasoning" || ["reasoning", "reasoningEffort", "effort", "variant"].includes(e.descriptor.id)) ||
      filteredBools.map((d) => ({ kind: "boolean", descriptor: d })).find((e) => e.descriptor.id === "thinking") ||
      null;
    return { effort };
  };
  findSpeedTraitImpl = (selects, bools) => ({
    speedSelect: selects.find((d) => d.id === "serviceTier") ?? null,
    fastToggle: bools.find((d) => d.id === "fastMode") ?? null,
  });
  getSelectChoicesImpl = (desc) => desc?.options ?? [];

  const clickResetBtn = (node) => {
    const btn = findNodes(node, (n) => n.type === "button" && n.props && /Reset default effort|恢复默认思考深度/.test(String(n.props["aria-label"] || "")))[0];
    assert(btn, "Reset default effort button must render in effort card");
    btn.props.onClick();
  };

  // 4a) Codex with serviceTier already default + reasoningEffort changed to xhigh -> must NOT be overwritten by serviceTier
  activeDriver = createStatefulTraitsDriver({
    provider: "codex",
    optionDescriptors: [
      {
        id: "reasoningEffort",
        type: "select",
        role: "reasoning",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
        ],
      },
      {
        id: "serviceTier",
        type: "select",
        options: [
          { id: "default", label: "Standard", isDefault: true },
          { id: "fast", label: "Fast" },
        ],
      },
    ],
    initialOptions: [{ id: "reasoningEffort", value: "xhigh" }, { id: "serviceTier", value: "default" }],
  });
  let renderFn = activeDriver.resetRender("gpt-6.2-sol", "codex");
  let resetTree = renderFn();
  clickResetBtn(resetTree);
  resetTree = renderFn();
  assert.deepEqual(
    activeDriver.dispatches,
    [{ kind: "select", id: "reasoningEffort", value: "medium" }],
    "Codex reset must dispatch only reasoningEffort=medium when serviceTier is already default"
  );
  assert.equal(activeDriver.getOptions().find((o) => o.id === "reasoningEffort")?.value, "medium");

  // 4b) Codex with BOTH xhigh AND fast serviceTier -> sequences effort then serviceTier across commits
  activeDriver = createStatefulTraitsDriver({
    provider: "codex",
    optionDescriptors: [
      {
        id: "reasoningEffort",
        type: "select",
        role: "reasoning",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
        ],
      },
      {
        id: "serviceTier",
        type: "select",
        options: [
          { id: "default", label: "Standard", isDefault: true },
          { id: "fast", label: "Fast" },
        ],
      },
    ],
    initialOptions: [{ id: "reasoningEffort", value: "xhigh" }, { id: "serviceTier", value: "fast" }],
  });
  renderFn = activeDriver.resetRender("gpt-6.2-sol", "codex");
  resetTree = renderFn();
  clickResetBtn(resetTree);
  resetTree = renderFn();
  resetTree = renderFn();
  assert.deepEqual(
    activeDriver.dispatches,
    [
      { kind: "select", id: "reasoningEffort", value: "medium" },
      { kind: "select", id: "serviceTier", value: "default" },
    ],
    "Codex reset with Fast active must reset both reasoningEffort and serviceTier across renders without overwriting"
  );
  assert.equal(activeDriver.getOptions().find((o) => o.id === "reasoningEffort")?.value, "medium");
  assert.equal(activeDriver.getOptions().find((o) => o.id === "serviceTier")?.value, "default");

  // 4c) Claude Opus with high isDefault at index 2 (not index 1) + fastMode true
  activeDriver = createStatefulTraitsDriver({
    provider: "claudeAgent",
    optionDescriptors: [
      {
        id: "effort",
        type: "select",
        role: "reasoning",
        promptInjectedValues: ["ultrathink"],
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "max", label: "Max" },
          { id: "ultrathink", label: "Ultrathink" },
        ],
      },
      { id: "fastMode", type: "boolean", currentValue: false },
    ],
    initialOptions: [{ id: "effort", value: "max" }, { id: "fastMode", value: true }],
  });
  renderFn = activeDriver.resetRender("claude-opus-4-6", "claude-1");
  resetTree = renderFn();
  clickResetBtn(resetTree);
  resetTree = renderFn();
  resetTree = renderFn();
  assert.deepEqual(
    activeDriver.dispatches,
    [
      { kind: "select", id: "effort", value: "high" },
      { kind: "boolean", id: "fastMode", value: false },
    ],
    "Claude Opus reset must pick isDefault=high (index 2) and turn off fastMode"
  );

  // 4d) Antigravity / ACP descriptor lacking isDefault flags -> uses ctrl.caps.optionDescriptors currentValue
  activeDriver = createStatefulTraitsDriver({
    provider: "antigravity",
    optionDescriptors: [
      {
        id: "reasoningEffort",
        type: "select",
        role: "reasoning",
        currentValue: "high",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ],
    initialOptions: [{ id: "reasoningEffort", value: "low" }],
  });
  renderFn = activeDriver.resetRender("gemini-4-hydrogen", "ag-1");
  resetTree = renderFn();
  clickResetBtn(resetTree);
  assert.deepEqual(
    activeDriver.dispatches,
    [{ kind: "select", id: "reasoningEffort", value: "high" }],
    "ACP model without isDefault must restore catalog currentValue from caps.optionDescriptors"
  );

  // 4e) OpenCode variant ("t3:default") and Claude boolean thinking toggle (caps currentValue=true)
  activeDriver = createStatefulTraitsDriver({
    provider: "opencode",
    optionDescriptors: [
      {
        id: "variant",
        type: "select",
        role: "reasoning",
        options: [
          { id: "t3:default", label: "Default" },
          { id: "minimal", label: "Minimal" },
          { id: "high", label: "High" },
        ],
      },
    ],
    initialOptions: [{ id: "variant", value: "high" }],
  });
  renderFn = activeDriver.resetRender("opencode-model", "oc-1");
  resetTree = renderFn();
  clickResetBtn(resetTree);
  assert.deepEqual(activeDriver.dispatches, [{ kind: "select", id: "variant", value: "t3:default" }]);

  activeDriver = createStatefulTraitsDriver({
    provider: "claudeAgent",
    optionDescriptors: [{ id: "thinking", type: "boolean", currentValue: true }],
    initialOptions: [{ id: "thinking", value: false }],
  });
  renderFn = activeDriver.resetRender("claude-haiku-4-5", "claude-1");
  resetTree = renderFn();
  clickResetBtn(resetTree);
  assert.deepEqual(activeDriver.dispatches, [{ kind: "boolean", id: "thinking", value: true }]);

  // 4f) Delayed effort commit (1 extra render before updated effort lands) must wait rather than firing speed prematurely
  let deferApply = true;
  const innerDriver = createStatefulTraitsDriver({
    provider: "codex",
    optionDescriptors: [
      {
        id: "reasoningEffort",
        type: "select",
        role: "reasoning",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
      },
      {
        id: "serviceTier",
        type: "select",
        options: [
          { id: "default", label: "Standard", isDefault: true },
          { id: "fast", label: "Fast" },
        ],
      },
    ],
    initialOptions: [{ id: "reasoningEffort", value: "high" }, { id: "serviceTier", value: "fast" }],
  });
  let deferredPendingCommit = null;
  const origUseTraits = useModelTraitsImpl;
  useModelTraitsImpl = () => {
    const ctrl = innerDriver.buildCtrl();
    const origChangeSelect = ctrl.changeSelect.bind(ctrl);
    return {
      ...ctrl,
      changeSelect(desc, id) {
        if (deferApply && desc.id === "reasoningEffort") {
          innerDriver.dispatches.push({ kind: "select", id: desc.id, value: id });
          deferredPendingCommit = () => origChangeSelect(desc, id);
          return;
        }
        origChangeSelect(desc, id);
      },
    };
  };
  renderFn = innerDriver.resetRender("gpt-6.2-sol", "codex");
  resetTree = renderFn();
  clickResetBtn(resetTree);
  assert.equal(innerDriver.dispatches.length, 1, "Initial click only dispatches effort reset");
  // Frame 1..6: effort still un-committed across many unrelated re-renders -> must NEVER burn retries or fire prematurely
  for (let frame = 0; frame < 6; frame++) {
    resetTree = renderFn();
    assert.equal(innerDriver.dispatches.length, 1, `Speed reset must wait at intermediate frame ${frame + 1} while effortNeedsReset is still true`);
  }
  // Commit delayed effort update -> speed reset fires cleanly without stalling at medium + fast
  deferApply = false;
  deferredPendingCommit();
  innerDriver.dispatches.pop();
  resetTree = renderFn();
  resetTree = renderFn();
  assert.deepEqual(innerDriver.dispatches, [
    { kind: "select", id: "reasoningEffort", value: "medium" },
    { kind: "select", id: "serviceTier", value: "default" },
  ]);
  assert.equal(innerDriver.getOptions().find((o) => o.id === "serviceTier")?.value, "default");
  useModelTraitsImpl = origUseTraits;

  // 4g) Prompt-injected-only descriptor with no regular options must disable effort reset instead of picking index 0
  activeDriver = createStatefulTraitsDriver({
    provider: "claudeAgent",
    optionDescriptors: [
      {
        id: "effort",
        type: "select",
        role: "reasoning",
        promptInjectedValues: ["ultrathink"],
        options: [{ id: "ultrathink", label: "Ultrathink" }],
      },
    ],
    ultrathinkPromptControlled: true,
    initialOptions: [],
  });
  renderFn = activeDriver.resetRender("claude-sonnet-4-6", "claude-1");
  resetTree = renderFn();
  const disabledReset = findNodes(resetTree, (n) => n.type === "button" && n.props && /Reset default effort|恢复默认思考深度/.test(String(n.props["aria-label"] || "")))[0];
  assert.equal(disabledReset.props["aria-disabled"], "true", "Prompt-injected-only effort must keep reset button disabled");
  disabledReset.props.onClick();
  assert.deepEqual(activeDriver.dispatches, [], "Prompt-injected-only effort must not dispatch index 0");
}

function verifyLinuxSupport(patchedAsarPath) {
  // 1) CLI arg parsing & Linux ASAR discovery candidates
  const parsedArgs = parseCliArgs(["install", "--asar", "/opt/T3 Code/resources/app.asar", "--official"]);
  assert.equal(parsedArgs.cmd, "install");
  assert.equal(parsedArgs.asarPath, "/opt/T3 Code/resources/app.asar");
  assert.equal(parsedArgs.flags.has("--official"), true);
  assert.deepEqual(parsedArgs.rest, []);
  assert.equal(parseCliArgs(["--repair"]).cmd, "repair");
  assert.equal(parseCliArgs(["--install", "--interactive"]).cmd, "install");
  assert.equal(parseCliArgs(["--uninstall"]).cmd, "uninstall");
  assert.throws(() => parseCliArgs(["install", "--asar", ""]), /请为 --asar 提供路径参数/);

  const candidates = getLinuxAsarCandidates({ XDG_DATA_HOME: "/home/demo/.xdg-data" }, "/home/demo");
  assert.equal(candidates[0], path.join("/home/demo/.xdg-data", "t3code-enhancer", "squashfs-root", "resources", "app.asar"));
  assert(candidates.includes("/opt/T3 Code/resources/app.asar"));

  // 2) summarizeModuleStates across fresh, full, old-version upgradeable, and unknown builds
  const fullSummary = summarizeModuleStates([
    { id: "a", key: "chat.js", installed: true, outdated: false, pristine: false },
    { id: "b", key: "diff.js", installed: true, outdated: false, pristine: false },
  ]);
  assert.equal(fullSummary.allInstalled, true);
  assert.equal(fullSummary.outdated, false);
  assert.equal(summarizeModuleStates([
    { id: "a", key: "chat.js", installed: true },
    { id: "b", key: "diff.js", pristine: true },
  ]).outdated, false);

  const upgradeSummary = summarizeModuleStates([
    { id: "usage-rings", key: "_chat.js", installed: false, outdated: true, pristine: false },
    { id: "new-chat-layout", key: "_chat.js", installed: false, outdated: false, pristine: false },
    { id: "files-changes-explorer", key: "diff.js", installed: false, outdated: false, pristine: true },
  ]);
  assert.equal(upgradeSummary.allRecognized, true);
  assert.equal(upgradeSummary.outdated, true);

  const unknownSummary = summarizeModuleStates([
    { id: "usage-rings", key: "_chat.js", installed: false, outdated: false, pristine: false },
  ]);
  assert.equal(unknownSummary.allRecognized, false);

  // 3) Mock /proc detection + linux.cjs isolated & shared-data layout (move tmpOut to avoid duplicating >300MB on tmpfs)
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-linux-test-"));
  try {
    const fakeProc = path.join(tmpRoot, "proc");
    const mockAppAsar = path.join(tmpRoot, "opt-t3code", "resources", "app.asar");
    const otherAppAsar = path.join(tmpRoot, "opt-other", "resources", "app.asar");
    fs.mkdirSync(path.dirname(mockAppAsar), { recursive: true });
    fs.writeFileSync(mockAppAsar, "");
    fs.mkdirSync(path.join(fakeProc, "999999"), { recursive: true });
    fs.writeFileSync(path.join(fakeProc, "999999", "cmdline"), `/usr/bin/electron\0${fs.realpathSync(mockAppAsar)}\0`);
    assert.equal(isLinuxAppRunning(mockAppAsar, fakeProc), true);
    assert.equal(isLinuxAppRunning(otherAppAsar, fakeProc), false);

    const linuxPaths = linuxCli.getLinuxPaths({ XDG_DATA_HOME: path.join(tmpRoot, "xdg") }, path.join(tmpRoot, "home"));
    const appDir = path.join(linuxPaths.installDirectory, "squashfs-root", "resources");
    fs.mkdirSync(appDir, { recursive: true });
    const installedAsar = path.join(linuxPaths.installDirectory, linuxCli.APP_ASAR);
    fs.renameSync(patchedAsarPath, installedAsar);
    fs.writeFileSync(installedAsar + linuxCli.BACKUP_SUFFIX, "backup-marker");

    // Isolated profile mode
    linuxCli.writeLauncherFiles(linuxPaths.installDirectory, false);
    const isoTheme = linuxCli.prepareProfile(false, { officialOnly: false }, linuxPaths);
    assert.equal(isoTheme.activated, true);
    assert.equal(linuxCli.usesSharedData(linuxPaths.installDirectory), false);
    assert(linuxCli.buildLauncher(false).includes('export T3CODE_HOME="$profile/t3-home"'));
    assert(linuxCli.buildLauncher(false).includes("export T3CODE_TELEMETRY_ENABLED=false T3CODE_OTEL_SDK_DISABLED=true"));
    assert(!linuxCli.buildLauncher(false, { disableTelemetry: false }).includes("T3CODE_TELEMETRY_ENABLED=false"));
    const isoInspect = linuxCli.inspectInstall(linuxPaths);
    assert.equal(isoInspect.summary.allInstalled, true);
    assert.equal(isoInspect.hasBackup, true);
    assert.equal(isoInspect.sharedData, false);
    assert.equal(isoInspect.themeStatus.installed, true);
    assert.equal(isoInspect.themeStatus.active, true);
    assert.equal(linuxCli.matchesSelectedPatches(isoInspect.modules, applicablePatchesForArchive(isoInspect.asar, selectPatches(new Set()))), true);

    // Shared-data + official theme mode
    linuxCli.writeLauncherFiles(linuxPaths.installDirectory, true);
    const sharedTheme = linuxCli.prepareProfile(true, { officialOnly: true }, linuxPaths);
    assert.equal(sharedTheme.officialOnly, true);
    assert.equal(sharedTheme.activated, true);
    assert.equal(linuxCli.usesSharedData(linuxPaths.installDirectory), true);
    assert(!linuxCli.buildLauncher(true).includes("T3CODE_HOME="));
    assert(linuxCli.buildLauncher(true).includes("export T3CODE_TELEMETRY_ENABLED=false T3CODE_OTEL_SDK_DISABLED=true"));
    const parsedLinux = linuxCli.parseLinuxArgs(["install", "--shared-data", "--official", "/tmp/T3.AppImage"]);
    assert.equal(parsedLinux.command, "install");
    assert.equal(parsedLinux.input, "/tmp/T3.AppImage");
    assert.equal(parsedLinux.flags.has("--shared-data"), true);
    assert.equal(parsedLinux.flags.has("--official"), true);
    withInstallDirectoryLock(linuxPaths.installLock, () => {
      assert.throws(() => withInstallDirectoryLock(linuxPaths.installLock, () => {
        assert.fail("Concurrent maintenance must not run");
      }), /持有安装锁/);
      assert(fs.statSync(linuxPaths.installLock).isDirectory());
    });
    assert(!fs.existsSync(linuxPaths.installLock));

    const unknownAsar = path.join(tmpRoot, "unknown.asar");
    const header = Buffer.from('{"files":{}}');
    const padded = Math.ceil(header.length / 4) * 4;
    const archive = Buffer.alloc(16 + padded);
    [4, 8 + padded, 4 + padded, header.length].forEach((size, i) => archive.writeUInt32LE(size, i * 4));
    header.copy(archive, 16);
    fs.writeFileSync(unknownAsar, archive);
    assert.throws(() => inspectCompatibleSource(unknownAsar), /未识别的版本内容/);
    fs.truncateSync(unknownAsar, 8);
    assert.equal(inspectCompatibleSource(unknownAsar), null, "Truncated ASAR must remain eligible for backup recovery");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function verifyNoTelemetryAndAdapters(verifiedAsar, baselineAsar) {
  // 1) Verify no-telemetry across all 4 targets
  const rl = findUniqueEntry(verifiedAsar, noTelemetry.targetRegex, noTelemetry.id).content.toString("utf8");
  assert(rl.includes(noTelemetry.marker), "Missing T3_NO_TELEMETRY_V1 marker in runtimeLayer");
  assert(!rl.includes('enabled: Boolean$1("T3CODE_TELEMETRY_ENABLED").pipe(option)'));
  assert(rl.includes('enabled: Boolean$1("T3CODE_TELEMETRY_ENABLED").pipe(withDefault(false))'));
  assert(!rl.includes("writeFileStringAtomically({\n\t\tfilePath: anonymousIdPath"), "getTelemetryIdentity must not persist anonymousId");
  assert(!rl.includes("Failed to read the linked T3 Connect account for telemetry"), "getServerOwners must not read linked connect account");

  // Run patched Identify + AnalyticsService generator stubs in VM to verify zero side effects
  const idStart = rl.indexOf("const getTelemetryIdentity = gen$1(function* () {");
  const ownersStart = rl.indexOf("const getServerOwners = gen$1(function* () {");
  const ownersEnd = rl.indexOf("});", ownersStart) + 3;
  const asMatch = rl.match(/const (make\$\d+) = gen\$1\(function\* \(\) \{\n\t\/\* T3_NO_TELEMETRY_V1 \*\//);
  const asStart = asMatch ? asMatch.index : -1;
  const makeVar = asMatch ? asMatch[1] : null;
  const asLayerMatch = makeVar ? rl.slice(asStart).match(new RegExp(`\\nconst layer\\$\\d+ = effect\\(AnalyticsService, ${makeVar.replace("$", "\\$")}\\);`)) : null;
  const asEnd = asLayerMatch ? asStart + asLayerMatch.index : -1;
  assert(idStart >= 0 && ownersStart > idStart && asStart >= 0 && asEnd > asStart && makeVar, "Missing patched telemetry blocks");
  assert(!rl.slice(asStart, asEnd).includes("httpClient.execute"), `AnalyticsService ${makeVar} must not retain sendBatch httpClient execution`);
  assert(!rl.slice(asStart, asEnd).includes("posthogHost"), `AnalyticsService ${makeVar} must not reference posthogHost`);
  let secretReads = 0;
  const runGen = (g) => {
    const it = g();
    let step = it.next();
    while (!step.done) step = it.next();
    return step.value;
  };
  const voidIdent = rl.slice(asStart, asEnd).match(/flush:\s*(void_[\w$]*)/)?.[1];
  assert(voidIdent, "Patched AnalyticsService must expose a void flush effect");
  const telemetrySandbox = {
    gen$1: (genFn) => () => runGen(genFn),
    [voidIdent]: { _tag: "Void" },
    AnalyticsService: { of: (impl) => impl },
    ServerSecretStore: { get: () => { secretReads++; return []; } },
  };
  runInNewContext(
    rl.slice(idStart, rl.indexOf("});", idStart) + 3) + "\n" +
    rl.slice(ownersStart, ownersEnd) + "\n" +
    rl.slice(asStart, asEnd) + `\nObject.assign(globalThis, { getTelemetryIdentity, getServerOwners, makeAnalytics: ${makeVar} });`,
    telemetrySandbox
  );
  assert.equal(JSON.stringify(telemetrySandbox.getTelemetryIdentity()), JSON.stringify({ distinctId: null, installId: null }));
  assert.equal(JSON.stringify(telemetrySandbox.getServerOwners()), "[]");
  assert.equal(secretReads, 0);
  const svc = telemetrySandbox.makeAnalytics();
  assert.equal(svc.record("any.event", {})._tag, "Void");
  assert.equal(svc.flush._tag, "Void");
  assert.equal(svc.recordOwners([], "server")._tag, "Void");

  // Relay tracing disabled
  const mer = findUniqueEntry(verifiedAsar, noTelemetry.relayPatch.targetRegex, noTelemetry.relayPatch.id).content.toString("utf8");
  assert(mer.includes("/* T3_NO_TELEMETRY_RELAY_V1 */\nconst isRelayTracingEnabled = () => false;"));

  // Client Axiom exporter disabled
  const utils = findPatchTarget(verifiedAsar, noTelemetry.clientPatch, ALL_PATCHES).content.toString("utf8");
  assert.match(utils, /function\s+[\w$]+\(\)\{\/\* T3_NO_TELEMETRY_CLIENT_V1 \*\/return\s+[\w$]+\([\w$]+,[\w$]+\(\)\)\}/);
  assert(!utils.includes("headers:{Authorization:`Bearer ${e.tracesToken}`"), "Axiom OTLP exporter body must be stripped");

  // Settings UI privacy description updated
  const sp = findUniqueEntry(verifiedAsar, noTelemetry.uiPatch.targetRegex, noTelemetry.uiPatch.id).content.toString("utf8");
  assert(sp.includes(noTelemetry.uiPatch.marker));
  assert(!sp.includes("including the anonymous usage data T3 Code collects"));

  // 2) Verify packs & presets resolution
  assert.equal(PACKS.length, 5);
  assert.equal(PRESETS.length, 5);
  const fullPlan = resolveInstallPlan(ALL_PATCHES, { preset: "full" });
  assert.equal(fullPlan.selectedPatches.length, ALL_PATCHES.length);
  assert.equal(fullPlan.includeTheme, true);
  assert.equal(fullPlan.telemetryDisabled, true);

  const cleanPlan = resolveInstallPlan(ALL_PATCHES, { preset: "clean" });
  assert.deepEqual(cleanPlan.packIds, ["theme", "privacy"]);
  const privacyPatchIds = PACKS.find((p) => p.id === "privacy").patchIds;
  assert(privacyPatchIds.includes("no-telemetry-desktop"), "Privacy pack must cover the desktop main-process telemetry patch");
  for (const id of privacyPatchIds) assert(ALL_PATCHES.some((p) => p.id === id), `Privacy pack references unknown patch ${id}`);
  assert.equal(cleanPlan.selectedPatches.length, privacyPatchIds.length);
  assert.equal(cleanPlan.includeTheme, true);

  const privOnlyPlan = resolveInstallPlan(ALL_PATCHES, { preset: "privacy-only" });
  assert.equal(privOnlyPlan.includeTheme, false);
  assert.equal(privOnlyPlan.selectedPatches.length, privacyPatchIds.length);

  const themeOnlyPlan = resolveInstallPlan(ALL_PATCHES, { preset: "theme-only" });
  assert.equal(themeOnlyPlan.includeTheme, true);
  assert.equal(themeOnlyPlan.themeOnly, true);
  assert.equal(themeOnlyPlan.selectedPatches.length, 0);

  const customPlan = resolveInstallPlan(ALL_PATCHES, { packs: ["theme", "workspace"], flags: new Set(["--official"]) });
  assert.equal(customPlan.needsLayer3Warning, true);
  assert(!customPlan.selectedPatches.some((p) => p.id === "usage-rings"));
  assert(customPlan.selectedPatches.some((p) => p.id === "new-chat-layout"));
  const casePlan = resolveInstallPlan(ALL_PATCHES, { preset: "Clean" });
  assert.equal(casePlan.presetId, "clean");
  const strippedComposer = resolveInstallPlan(ALL_PATCHES, {
    packs: ["theme", "composer"],
    flags: new Set(["--official", "--no-usage-rings"]),
  });
  assert.equal(strippedComposer.needsLayer3Warning, false);
  assert.throws(() => resolveInstallPlan(ALL_PATCHES, { preset: "clean", flags: new Set(["--theme-only"]) }), /--theme-only/);
  assert.throws(() => resolveInstallPlan(ALL_PATCHES, { packs: ["theme"], flags: new Set(["--theme-only"]) }), /--theme-only/);

  // Verify new-chat-layout preserves trailing permissions when usage-rings is NOT applied
  const baselineChat = findUniqueEntry(baselineAsar, newChatLayout.targetRegex, "chat-base").content.toString("utf8");
  const layoutWithoutComposer = newChatLayout.apply(baselineChat);
  assert.match(layoutWithoutComposer, /trailing:\(0,[\w$]+\.jsx\)\([\w$]+,\{environmentId:/, "new-chat-layout must preserve trailing permissions when usage-rings is omitted");

  // Verify new-chat-layout binds the Combobox trigger (not an outer TooltipTrigger wrapper) to data-draft-project-trigger
  const trayStart = layoutWithoutComposer.indexOf("function T3NewChatTray(");
  assert(trayStart >= 0, "new-chat-layout must emit T3NewChatTray");
  const traySrc = layoutWithoutComposer.slice(trayStart);
  const trayTriggers = [...traySrc.matchAll(/\(0,\s*[A-Za-z_$][\w$]*\.jsxs?\)\(([A-Za-z_$][\w$]*),\s*\{\s*render:\s*\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\("button",\s*\{[^}]+\}\),\s*"data-draft-project-trigger":\s*""/g)].map((m) => m[1]);
  assert.equal(trayTriggers.length, 2, "T3NewChatTray must render both selected and empty project triggers");
  const comboboxImportLine = baselineChat.match(/import\{([^}]+)\}from"\.\/combobox-[^"]+"/)?.[1] || "";
  for (const trig of trayTriggers) {
    assert(
      new RegExp(`\\bas\\s+${trig.replaceAll("$", "\\$")}\\b`).test(comboboxImportLine),
      `T3NewChatTray project trigger (${trig}) must come from the combobox chunk, not a TooltipTrigger wrapper`
    );
  }

  // Verify sidebar-new-chat guards null/negative activeSearchResultIndex
  const mainJs = findUniqueEntry(verifiedAsar, sidebarNewChat.targetRegex, sidebarNewChat.id).content.toString("utf8");
  assert(mainJs.includes('typeof g === "number" && g >= 0 && g < h'));

  // Verify workspace-floating-panels Alt+S uses ev.code === "KeyS" (macOS Option+S compatibility)
  const patchedChat = hostWithRuntime(verifiedAsar, newChatLayout, "chat-patched").combined;
  assert(patchedChat.includes('ev.code === "KeyS"'));
  const patchedTabBar = hostWithRuntime(verifiedAsar, workspaceFloatingPanels.tabBarPatch, "tab-bar-patched").combined;
  assert(patchedTabBar.includes("rootRef.current.getClientRects().length === 0"));

  // 3) Verify macOS helper functions cross-platform (no Mac hardware required)
  const macPaths = macosCli.getMacosPaths("/Users/tester");
  assert.equal(macPaths.installDirectory, path.join("/Users/tester", "Applications", "T3 Code Enhancer.app"));
  const macIsoEnv = macosCli.buildInfoPlistEnv({ EXISTING: "1", INVALID_OBJ: { nested: true } }, false, macPaths, { disableTelemetry: true });
  assert.equal(macIsoEnv.T3CODE_TELEMETRY_ENABLED, "false");
  assert.equal(macIsoEnv.T3CODE_OTEL_SDK_DISABLED, "true");
  assert.equal(macIsoEnv.T3CODE_DISABLE_AUTO_UPDATE, "1");
  assert.equal(macIsoEnv.T3CODE_PORT, "3774");
  assert.equal(macIsoEnv.T3CODE_HOME, path.join(macPaths.profileDirectory, "t3-home"));
  assert.equal("INVALID_OBJ" in macIsoEnv, false);
  assert.equal(macosCli.envNeedsUpdate({ A: "1", B: "2" }, { B: "2", A: "1" }), false);
  assert.equal(macosCli.envNeedsUpdate({ A: "1" }, { A: "2" }), true);
  const macSharedEnv = macosCli.buildInfoPlistEnv(macIsoEnv, true, macPaths, { disableTelemetry: false });
  assert.equal("T3CODE_HOME" in macSharedEnv, false);
  assert.equal("T3CODE_TELEMETRY_ENABLED" in macSharedEnv, false);

  const syntheticMain = 'const cfg = { current: "t3code-v2", legacy: "T3 Code (Alpha)" };';
  const patchedMain = macosCli.userDataPatch.apply(syntheticMain);
  assert(patchedMain.includes(macosCli.userDataPatch.marker));
  const macParsed = macosCli.parseMacosArgs(["install", "--preset", "clean", "--shared-data", "/Applications/Custom.app"]);
  assert.equal(macParsed.command, "install");
  assert.equal(macParsed.preset, "clean");
  assert.equal(macParsed.input, "/Applications/Custom.app");
  assert.equal(macParsed.flags.has("--shared-data"), true);
  const macosCleanPlan = resolveInstallPlan(ALL_PATCHES, { preset: "clean" });
  assert.equal(macosCli.selectMacosPatches(macosCleanPlan, false).some((p) => p.id === "macos-user-data"), true);
  assert.equal(macosCli.selectMacosPatches(macosCleanPlan, true).some((p) => p.id === "macos-user-data"), false);

  const macTmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-mac-test-"));
  try {
    const tmpMacPaths = macosCli.getMacosPaths(macTmp);
    const macTheme = macosCli.prepareProfile(false, { officialOnly: false }, tmpMacPaths);
    assert.equal(macTheme.activated, true);
    const macSharedTheme = macosCli.prepareProfile(true, { officialOnly: true }, tmpMacPaths);
    assert.equal(macSharedTheme.officialOnly, true);
    assert.equal(macSharedTheme.activated, true);
  } finally {
    fs.rmSync(macTmp, { recursive: true, force: true });
  }
}

function verifySameFileFolding(asar) {
  // 1) Patched session-logic path extractor & deduplicating counter (cross-version variable resolution)
  const slCode = findPatchTarget(asar, timelineCollapse.summaryPatch, ALL_PATCHES).content.toString("utf8");
  const keysM = slCode.match(/var\s+([A-Za-z_$][\w$]*)=\[`path`,`Path`,[^\]]+\];/);
  assert(keysM, "Missing patched session-logic path keys array");
  const extractM = slCode.match(/function\s+([A-Za-z_$][\w$]*)\(e,t,n,r\)\{if\(r>4\|\|[^)]+\)return;[\s\S]+?\}\s*function\s+([A-Za-z_$][\w$]*)\(e\)\{let\s+t=\[\];return\s+\1\(e,t,new Set,0\),t\}/);
  assert(extractM, "Missing patched session-logic path extractor");
  const [, walkFn, extractFn] = extractM;
  const helperRefs = [...extractM[0].matchAll(/\b([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]);
  const counterM = slCode.match(/function\s+([A-Za-z_$][\w$]*)\(e,t\)\{\/\* T3_TIMELINE_SUMMARY_V\d+ \*\/[\s\S]+?return paths\.size \+ unknown;\s*\}/);
  assert(counterM, "Missing patched session-logic deduplicating counter");
  const counterFn = counterM[1];
  const toolInputFn = counterM[0].match(new RegExp(`${extractFn}\\(([A-Za-z_$][\\w$]*)\\(entry\\)\\)`))?.[1];
  const readDetailFn = counterM[0].match(/const path = ([A-Za-z_$][\w$]*)\(entry\);/)?.[1];
  assert(toolInputFn && readDetailFn, "Missing helper references inside patched summary counter");
  const objCheckFn = extractM[0].match(/let\s+[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\(e\);/)?.[1];
  const strCheckFn = extractM[0].match(/let\s+[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\[[A-Za-z_$][\w$]*\]\)/)?.[1];
  assert(objCheckFn && strCheckFn, "Missing type-check helpers in session-logic path walker");
  const slCtx = runInNewContext(
    keysM[0] + "\n" + extractM[0] + "\n" + counterM[0] + `\n({ extract: ${extractFn}, count: ${counterFn} })`,
    {
      [objCheckFn]: (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null),
      [strCheckFn]: (v) => (typeof v === "string" && v.trim() ? v.trim() : null),
      [toolInputFn]: (x) => x.toolData?.input ?? x.structuredPayload?.input,
      [readDetailFn]: (x) => x.detail ?? null,
    }
  );
  assert.deepEqual([...slCtx.extract({ input: { Path: "C:\\proj\\foo.js" } })], ["C:\\proj\\foo.js"]);
  const readCount = slCtx.count("read", [
    { toolData: { input: { Path: "C:\\proj\\foo.js", StartLine: 1, EndLine: 50 } } },
    { toolData: { input: { file_path: "c:/proj/foo.js", StartLine: 51, EndLine: 100 } } },
    { detail: "C:\\proj\\bar.js" },
  ]);
  assert.equal(readCount, 2, "Repeated reads of the same file must count as 1 unique file");
  const editCount = slCtx.count("edit", [
    { changedFiles: ["src\\a.ts"] },
    { changedFiles: ["./src/a.ts"] },
  ]);
  assert.equal(editCount, 1);

  // 2) Patched ReadOnlyThreadTimeline T3SameFileGroup renders collapsed row and expands child Ch entries on click
  const utHost = hostWithRuntime(asar, timelineCollapse, timelineCollapse.id);
  const utCode = utHost.text;
  const timelineAsset = utHost.assets.find((a) => /\/t3e-timeline-ui-[0-9a-f]{8}\.js$/.test(a.key));
  assert(timelineAsset, "Patched timeline host must import the external timeline runtime asset");
  assert(/import\s*\{[^}]*\bcreateTimelineRuntime\b[^}]*\}\s*from\s*"\.\/t3e-timeline-ui-[0-9a-f]{8}\.js"/.test(utCode), "Host must import createTimelineRuntime from the t3e asset");
  assert(/createTimelineRuntime\(\{\s*React:/.test(utCode), "Host must emit the createTimelineRuntime bridge");
  assert(!utCode.includes("function disclosureIds("), "Timeline runtime helpers must live in the external asset, not the host chunk");
  assert(timelineAsset.text.includes("function disclosureIds("), "Timeline asset must define the disclosure helpers");
  assert(
    /\(0,[A-Za-z_$][\w$]*\.memo\)\(/.test(utCode) &&
      /\(0,[A-Za-z_$][\w$]*\.useMemo\)\(\(\)=>t3RenderSameFileChildren\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\),\[\1,\2\]\)/.test(utCode),
    "Patched work-group list must memoize t3RenderSameFileChildren"
  );
  const expandedSet = new Set();
  const toggledCalls = [];
  let expandedState = false;
  const jsx = (type, props) => ({ type, props: props || {} });
  const tlGlobals = {
    document: { documentElement: { lang: "zh-CN" } },
    navigator: { language: "zh-CN" },
    su: { _id: "su" },
    au: { _id: "au" },
    $: {
      Fragment: Symbol("Fragment"),
      use: (ctx) => (ctx._id === "su"
        ? { state: { expandedEntries: expandedSet }, onToggleEntry: (wasOpen, id) => toggledCalls.push({ wasOpen, id }) }
        : { timestampFormat: "short" }),
      useState: (init) => {
        if (typeof init === "function") expandedState = init();
        return [expandedState, (v) => { expandedState = typeof v === "function" ? v(expandedState) : v; }];
      },
    },
    Q: { Fragment: Symbol("Fragment"), jsx, jsxs: jsx },
    we: () => (s) => s,
    Ln: () => false,
    Dn: (e) => e.action,
    Wn: () => [],
    Mn: () => null,
    Ur: (p) => String(p).replaceAll("\\", "/"),
    Xl: "WorkRow",
    fu: "WorkIcon",
    oa: "ChevronRight",
    xi: "Timestamp",
    Ch: "WorkEntryRow",
  };
  // The runtime is the shipped asset source, wired exactly like the generated createTimelineRuntime bridge.
  assert.equal(timelineAsset.text, fs.readFileSync(path.join(__dirname, "..", "lib", "runtime", "timeline-ui.mjs"), "utf8"));
  const tlSandbox = loadRuntimeModule("timeline-ui", { document: tlGlobals.document, navigator: tlGlobals.navigator }).exports.createTimelineRuntime({
    React: tlGlobals.$,
    jsx: tlGlobals.Q.jsx,
    jsxs: tlGlobals.Q.jsxs,
    Fragment: tlGlobals.Q.Fragment,
    workGroupCtx: tlGlobals.su,
    timelineCtx: tlGlobals.au,
    useI18n: tlGlobals.we,
    isEntryFailed: tlGlobals.Ln,
    getAction: tlGlobals.Dn,
    extractPaths: tlGlobals.Wn,
    extractReadDetailPath: tlGlobals.Mn,
    resolveRelPath: tlGlobals.Ur,
    WorkRow: tlGlobals.Xl,
    WorkIcon: tlGlobals.fu,
    ChevronRight: tlGlobals.oa,
    Timestamp: tlGlobals.xi,
    WorkEntryRow: tlGlobals.Ch,
  });

  const rawReads = [
    { id: "r1", action: "read", createdAt: "2026-11-25T05:00:00Z", toolLifecycleStatus: "completed", structuredPayload: { type: "dynamic_tool", input: { Path: "src\\a.ts", StartLine: 1, EndLine: 80 } } },
    { id: "r2", action: "read", createdAt: "2026-11-25T05:00:01Z", toolLifecycleStatus: "completed", structuredPayload: { type: "dynamic_tool", input: { Path: "src/a.ts", StartLine: 81, EndLine: 160 } } },
    { id: "other", action: "command", createdAt: "2026-11-25T05:00:02Z", toolLifecycleStatus: "completed" },
  ];
  const nodes = tlSandbox.t3RenderSameFileChildren(rawReads, "");
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].type, tlSandbox.T3SameFileGroup);
  assert.equal(nodes[1].type, "WorkEntryRow");

  let groupTree = tlSandbox.T3SameFileGroup(nodes[0].props);
  assert.equal(groupTree.props.toggle["aria-expanded"], false);
  assert.equal(groupTree.props.children, null);
  assert.match(JSON.stringify(groupTree.props.label), /已读取 src\/a\.ts.*2 次读取.*L1-80, L81-160/);

  groupTree.props.onClick();
  assert.equal(expandedSet.has("r1:file-fold"), true);
  assert.deepEqual(toggledCalls, [{ wasOpen: false, id: "r1:file-fold" }]);
  groupTree = tlSandbox.T3SameFileGroup(nodes[0].props);
  assert.equal(groupTree.props.toggle["aria-expanded"], true);
  assert.equal(groupTree.props.children.props.children.length, 2);

  // Clicking or pointer-pressing inside a child row must never bubble up and collapse T3SameFileGroup
  let stoppedClick = false;
  let stoppedPointer = false;
  groupTree.props.children.props.onClick({ stopPropagation() { stoppedClick = true; } });
  groupTree.props.children.props.onPointerDown({ stopPropagation() { stoppedPointer = true; } });
  assert.equal(stoppedClick, true, "Child container must stop click propagation");
  assert.equal(stoppedPointer, true, "Child container must stop pointerdown propagation");
  groupTree.props.onClick({ target: { closest: (sel) => (sel === ".t3e-same-file-children" ? {} : null) } });
  assert.equal(expandedSet.has("r1:file-fold"), true, "Clicks originating inside child rows must keep parent group expanded");
  assert.equal(toggledCalls.length, 1);

  groupTree.props.onClick();
  assert.equal(expandedSet.has("r1:file-fold"), false);
  assert.deepEqual(toggledCalls, [
    { wasOpen: false, id: "r1:file-fold" },
    { wasOpen: true, id: "r1:file-fold" },
  ]);

  // Verify T3SameFileGroup falls back to checkpoint net diff stats when individual edits omit diffStr (e.g. Antigravity)
  const cpGroupRuntime = loadRuntimeModule("timeline-ui").exports.createTimelineRuntime({
    React: {
      Fragment: Symbol("Fragment"),
      use: (ctx) => ctx,
      useState: (init) => [typeof init === "function" ? init() : init, () => {}],
      useEffect() {},
      useMemo: (fn) => fn(),
    },
    jsx: (type, props) => ({ type, props: props || {} }),
    jsxs: (type, props) => ({ type, props: props || {} }),
    Fragment: Symbol("Fragment"),
    workGroupCtx: { state: { expandedEntries: new Set() } },
    timelineCtx: { activeThreadEnvironmentId: "env-1", markdownCwd: "/repo" },
    useI18n: () => (s) => s,
    WorkRow: "WorkRow",
    WorkIcon: "WorkIcon",
    ChevronRight: "ChevronRight",
    Timestamp: "Timestamp",
    WorkEntryRow: "WorkEntryRow",
    useCheckpointSummaries: () => [{ runId: "turn-4", checkpointTurnCount: 4 }],
    useCheckpointDiff: () => ({
      data: { diff: "diff --git a/themes/chatgpt-app.json b/themes/chatgpt-app.json\n--- a/themes/chatgpt-app.json\n+++ b/themes/chatgpt-app.json\n@@ -135 +135 @@\n-old\n+new1\n+new2\n" },
      isPending: false,
    }),
    parseCheckpointDiff: (patch) => {
      const files = [...String(patch || "").matchAll(/diff --git a\/([^\s]+) b\/([^\s]+)/g)].map((m) => ({ name: m[2] }));
      return files.length ? { kind: "files", files } : null;
    },
  });
  const cpGroupTree = JSON.stringify(cpGroupRuntime.T3SameFileGroup({
    group: {
      id: "e1:file-fold",
      kind: "edit",
      filePath: "themes/chatgpt-app.json",
      entries: [
        { id: "e1", projectedItem: { sourceThreadId: "t1", item: { type: "file_change", runId: "turn-4" } } },
        { id: "e2", projectedItem: { sourceThreadId: "t1", item: { type: "file_change", runId: "turn-4" } } },
      ],
    },
    workspaceRoot: "/repo",
  }));
  assert.match(cpGroupTree, /"\+2"/);
  assert.match(cpGroupTree, /"-1"/);
}

function verifyDesktopTray(desktopAsar) {
  const mainCode = findUniqueEntry(desktopAsar, desktopTray.targetRegex, desktopTray.id).content.toString("utf8");
  assert(mainCode.includes(desktopTray.marker), "Missing desktop-tray marker in main.cjs");
  assert(mainCode.includes("if (t3ShouldHideToTrayOnClose(window))"), "DesktopWindow close handler must support hide-to-tray");
  assert(mainCode.includes("t3EnsureTray();"), "DesktopApplicationMenu must initialize system tray after ready");
  assert(mainCode.includes("t3BeginTrayQuit();\n\t\t\tt3DisposeTray();"), "DesktopLifecycle must dispose tray on quit");

  const idx = mainCode.indexOf(`/* ${desktopTray.marker} */`);
  assert(idx >= 0, "Missing injected tray runtime helpers");
  const runtimeCode = mainCode.slice(idx);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-tray-test-"));
  try {
    const events = [];
    const createdTrays = [];
    let visible = true;
    let minimized = false;
    let shownCount = 0;
    let hideCount = 0;
    let quitCount = 0;
    let settingsCount = 0;
    let destroyed = false;

    class MockTray {
      constructor(image) {
        this.image = image;
        this.listeners = new Map();
        this.destroyed = false;
        this.tooltip = "";
        this.menu = null;
        createdTrays.push(this);
      }
      setToolTip(tip) { this.tooltip = tip; }
      setContextMenu(menu) { this.menu = menu; }
      on(ev, fn) { this.listeners.set(ev, fn); }
      isDestroyed() { return this.destroyed; }
      destroy() { this.destroyed = true; }
    }

    const sandbox = {
      activeLocale: "zh",
      __dirname: tmpDir,
      process: { platform: "win32" },
      node_fs: fs,
      node_path: path,
      electron: {
        Tray: MockTray,
        Menu: { buildFromTemplate: (tpl) => tpl },
        nativeImage: {
          createFromPath: (p) => ({
            path: p,
            isEmpty: () => !p || !p.endsWith(".ico"),
            resize: () => ({ isEmpty: () => false }),
            getSize: () => ({ width: 32, height: 32 }),
          }),
        },
        app: {
          getPreferredSystemLanguages: () => ["zh-CN"],
        },
      },
    };
    runInNewContext(runtimeCode + "\nObject.assign(globalThis, { T3TrayState, t3ReadCloseToTray, t3RegisterTrayHooks, t3EnsureTray, t3RefreshTrayMenu, t3ShouldHideToTrayOnClose, t3HideWindowToTray, t3BeginTrayQuit, t3DisposeTray });", sandbox);

    const mockWin = {
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      isMinimized: () => minimized,
      hide: () => { visible = false; hideCount++; },
    };

    sandbox.t3RegisterTrayHooks({
      environment: { platform: "win32", stateDir: tmpDir, displayName: "T3 Code (Beta)" },
      iconPaths: { ico: { _tag: "Some", value: "C:\\app\\icon.ico" }, png: { _tag: "None" } },
      getMainWindow: () => mockWin,
      flushBounds: () => events.push("flush"),
      showMainWindow: () => { visible = true; shownCount++; },
      openSettings: () => settingsCount++,
      quitApp: () => { sandbox.t3BeginTrayQuit(); sandbox.t3DisposeTray(); quitCount++; },
    });

    // Window close before Tray exists must NOT preventDefault
    assert.equal(sandbox.t3ShouldHideToTrayOnClose(mockWin), false);

    // Ensure tray creates icon + localized menu
    const tray = sandbox.t3EnsureTray();
    assert(tray && createdTrays.length === 1);
    assert.equal(tray.tooltip, "T3 Code (Beta)");
    assert.equal(tray.menu[0].label, "打开主窗口");
    assert.equal(tray.menu[1].label, "隐藏到托盘");
    assert.equal(tray.menu[1].enabled, true);
    assert.equal(tray.menu[3].label, "关闭窗口时最小化到托盘");
    assert.equal(tray.menu[3].checked, true);

    // Clicking X with closeToTray=true prevents close & hides window
    assert.equal(sandbox.t3ShouldHideToTrayOnClose(mockWin), true);
    sandbox.t3HideWindowToTray(mockWin);
    assert.equal(hideCount, 1);
    assert.equal(visible, false);
    assert.equal(tray.menu[1].enabled, false);

    // Clicking tray icon restores window
    tray.listeners.get("click")();
    assert.equal(shownCount, 1);
    assert.equal(visible, true);

    // Switching locale to English updates tray menu
    sandbox.activeLocale = "en";
    sandbox.t3RefreshTrayMenu();
    assert.equal(tray.menu[0].label, "Open Window");
    assert.equal(tray.menu[6].label, "Quit T3 Code (Beta)");

    // Opening settings & toggling close-to-tray checkbox persists setting
    tray.menu[4].click();
    assert.equal(settingsCount, 1);
    tray.menu[3].click({ checked: false });
    assert.equal(sandbox.t3ReadCloseToTray(tmpDir), false);
    assert.equal(sandbox.t3ShouldHideToTrayOnClose(mockWin), false);

    // Re-enable close-to-tray, then trigger quit -> closes & destroys tray
    tray.menu[3].click({ checked: true });
    assert.equal(sandbox.t3ShouldHideToTrayOnClose(mockWin), true);
    tray.menu[6].click();
    assert.equal(quitCount, 1);
    assert.equal(tray.isDestroyed(), true);
    assert.equal(sandbox.t3ShouldHideToTrayOnClose(mockWin), false);

    // Verify Linux (.png icon priority + 22x22 resize for >32px + click listener) and macOS (18x18 resize + no click listener + leave-full-screen before hide)
    for (const plat of ["linux", "darwin"]) {
      const resizeCalls = [];
      const created = [];
      const platSandbox = {
        activeLocale: "zh",
        __dirname: tmpDir,
        process: { platform: plat },
        node_fs: fs,
        node_path: path,
        electron: {
          Tray: class {
            constructor(image) { this.image = image; this.listeners = new Map(); this.destroyed = false; created.push(this); }
            setToolTip() {}
            setContextMenu(m) { this.menu = m; }
            on(ev, fn) { this.listeners.set(ev, fn); }
            isDestroyed() { return this.destroyed; }
            destroy() { this.destroyed = true; }
          },
          Menu: { buildFromTemplate: (tpl) => tpl },
          nativeImage: {
            createFromPath: (p) => ({
              path: p,
              isEmpty: () => !p || !p.endsWith(".png"),
              getSize: () => ({ width: 64, height: 64 }),
              resize: (opts) => { resizeCalls.push(opts); return { path: p, resized: opts, isEmpty: () => false }; },
            }),
          },
          app: { getPreferredSystemLanguages: () => ["en-US"] },
        },
      };
      runInNewContext(runtimeCode + "\nObject.assign(globalThis, { t3RegisterTrayHooks, t3EnsureTray, t3HideWindowToTray });", platSandbox);
      const winListeners = new Map();
      let platVisible = true;
      let fullScreen = plat === "darwin";
      const platWin = {
        isDestroyed: () => false,
        isVisible: () => platVisible,
        isMinimized: () => false,
        isFullScreen: () => fullScreen,
        once: (ev, fn) => winListeners.set(ev, fn),
        setFullScreen: (v) => { fullScreen = v; },
        hide: () => { platVisible = false; },
      };
      platSandbox.t3RegisterTrayHooks({
        environment: { platform: plat, stateDir: tmpDir, displayName: "T3 Code" },
        iconPaths: { ico: { _tag: "Some", value: "/app/icon.ico" }, png: { _tag: "Some", value: "/app/icon.png" } },
        getMainWindow: () => platWin,
        showMainWindow: () => { platVisible = true; },
      });
      const platTray = platSandbox.t3EnsureTray();
      assert(platTray && created.length === 1, `${plat}: tray must initialize`);
      assert.equal(platTray.image.path, "/app/icon.png", `${plat}: must prefer .png icon`);
      assert.deepEqual({ ...resizeCalls[0] }, plat === "darwin" ? { width: 18, height: 18 } : { width: 22, height: 22 }, `${plat}: icon resize mismatch`);
      assert.equal(platTray.listeners.has("click"), plat !== "darwin", `${plat}: click handler expectation mismatch`);
      platSandbox.t3HideWindowToTray(platWin);
      if (plat === "darwin") {
        assert.equal(fullScreen, false, "macOS must exit fullscreen before hiding to tray");
        assert.equal(platVisible, true, "macOS must wait for leave-full-screen before hide()");
        winListeners.get("leave-full-screen")();
        assert.equal(platVisible, false, "macOS window must hide once leave-full-screen emits");
      } else {
        assert.equal(platVisible, false, "Linux window must hide immediately");
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function verifyFilesChangesExplorer(asar) {
  const feHost = hostWithRuntime(asar, filesChangesExplorer, filesChangesExplorer.id);
  const feAsset = feHost.assets.find((a) => /\/t3e-files-explorer-ui-[0-9a-f]{8}\.js$/.test(a.key));
  assert(feAsset, "files-changes-explorer host must import the external files-explorer runtime asset");
  assert(/import\s*\{\s*createFilesExplorerRuntime\s*\}\s*from\s*"\.\/t3e-files-explorer-ui-[0-9a-f]{8}\.js"/.test(feHost.text), "Host must import createFilesExplorerRuntime");
  assert(!feHost.text.includes("function T3FilesChangesLayout("), "Layout component must live in the external asset");
  const feCode = feHost.combined;
  assert(feHost.text.includes(filesChangesExplorer.marker), "Missing files-changes-explorer marker");
  assert(feCode.includes('style: showChangesSplit && !allFilesOpen ? { display: "none" } : undefined'), "All files tree must stay mounted when collapsed");
  assert(feCode.includes('className: "t3e-fe-file-main"'), "Changed file row must expose native button separate from diff badge");
  assert(feHost.text.includes("expandAllSyncRef:t3FeExpandRef") && feHost.text.includes("t3FeExpandRef.current?.("), "Header expand/collapse-all button must sync changed files tree");
  let gitCalls = 0;
  let treeScans = 0;
  let changesOpen = true;
  let allFilesOpenState = true;
  let collapsedDirsState = {};
  let stateCursor = 0;
  const files = [{ path: "src/sub/file.ts", insertions: 2, deletions: 1 }];
  files[Symbol.iterator] = function () {
    treeScans++;
    return Array.prototype[Symbol.iterator].call(this);
  };
  assert.equal(feAsset.text, fs.readFileSync(path.join(__dirname, "..", "lib", "runtime", "files-explorer-ui.mjs"), "utf8"));
  const feJsx = (type, props) => ({ type, props });
  const { t3BuildChangedFileTree, T3FeChangedTreeNodes, T3FilesChangesLayout } = loadRuntimeModule("files-explorer-ui").exports.createFilesExplorerRuntime({
    React: {
      Fragment: Symbol("Fragment"),
      useState: (i) => {
        const idx = stateCursor++;
        if (idx === 0) return [changesOpen, (v) => { changesOpen = typeof v === "function" ? v(changesOpen) : v; }];
        if (idx === 1) return [allFilesOpenState, (v) => { allFilesOpenState = typeof v === "function" ? v(allFilesOpenState) : v; }];
        if (idx === 2) return [collapsedDirsState, (v) => { collapsedDirsState = typeof v === "function" ? v(collapsedDirsState) : v; }];
        return [i, () => {}];
      },
      useEffect() {},
      useMemo: (f) => f(),
    },
    jsx: feJsx,
    jsxs: feJsx,
    gitQueries: { status: () => { gitCalls++; return true; } },
    useQuery: (atom) => ({ data: atom ? { workingTree: { files } } : null }),
    diffPanelStore: { getState: () => ({ selectGitScope() {} }) },
    rightPanelStore: { getState: () => ({ open() {} }) },
  });
  const tree = t3BuildChangedFileTree([
    { path: "./src\\a.ts", insertions: 2, deletions: 0 },
    { path: "src/a.ts", insertions: 2, deletions: 0 },
    { path: "src/", insertions: 0, deletions: 0 },
  ], "");
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children.length, 1, "Duplicate normalized path must be deduplicated");
  const collapsedTree = T3FeChangedTreeNodes({
    nodes: tree,
    depth: 1,
    isSearching: true,
    collapsedDirs: { src: true },
    onToggleDir: () => {},
    normSelected: "src/a.ts",
    onOpenFile: () => {},
    openInDiffTitle: "Diff",
    openAllChanges: () => {},
  });
  assert.equal(collapsedTree[0].props.children[0].props["aria-expanded"], true, "Active search must auto-expand collapsed directories");
  const props = { environmentId: "env", cwd: "/repo", allFilesNode: {} };
  stateCursor = 0;
  T3FilesChangesLayout(props);
  assert.equal(gitCalls, 0, "No Git status lookup without a thread that can open the Changes panel");
  stateCursor = 0;
  const threadRef = { environmentId: "env", threadId: "thread" };
  const expandAllSyncRef = { current: null };
  T3FilesChangesLayout({ ...props, threadRef, expandAllSyncRef });
  assert.equal(gitCalls, 1);
  assert.equal(treeScans, 1);
  assert.equal(typeof expandAllSyncRef.current, "function", "T3FilesChangesLayout must register expandAllSyncRef callback");
  expandAllSyncRef.current(false);
  assert.deepEqual({ ...collapsedDirsState }, { src: true, "src/sub": true }, "Collapse all must collapse all changed-file folders");
  changesOpen = false;
  expandAllSyncRef.current(true);
  assert.equal(changesOpen, true, "Expand all must reopen changed-files section");
  assert.deepEqual({ ...collapsedDirsState }, {}, "Expand all must clear collapsed changed-file folders");
  changesOpen = false;
  stateCursor = 0;
  T3FilesChangesLayout({ ...props, threadRef });
  assert.equal(treeScans, 1, "A collapsed changes pane skips rebuilding its file tree");
  assert(
    feHost.text.includes("data-item-flattened-subitems"),
    "FilePreviewPanel must inject flattened-directory alignment CSS into @pierre/trees unsafeCSS"
  );
  // Verify all UI runtime & patch fallback style injectors prepend instead of clobbering active theme Layer 3 CSS,
  // every injected <svg> carries explicit intrinsic width/height so missing theme CSS can never blow up icons,
  // and floating-panels preserves Windows WCO top-right control clearance on official non-ChatGPT themes.
  for (const modName of ["inline-diff-ui", "files-explorer-ui", "timeline-ui", "floating-panels-ui", "tab-bar-ui", "usage-rings-ui"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "runtime", modName + ".mjs"), "utf8");
    assert(src.includes("document.head.prepend"), `${modName}.mjs must prepend fallback styles so theme Layer 3 takes precedence`);
    for (const m of src.matchAll(/(?:jsxs?)\("svg"\s*,\s*\{/g)) {
      const beforeChildren = src.slice(m.index, m.index + 500).split(/\bchildren\s*:/)[0];
      assert(/\bwidth\b/.test(beforeChildren) && /\bheight\b/.test(beforeChildren), `${modName}.mjs contains an <svg> without explicit intrinsic width/height`);
    }
  }
  const fpRtSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "runtime", "floating-panels-ui.mjs"), "utf8");
  assert(
    fpRtSrc.includes(".wco [data-t3e-workspace]") &&
      fpRtSrc.includes("var(--workspace-native-controls-inset, 144px)") &&
      fpRtSrc.includes('[data-t3e-chat-floating="true"]'),
    "floating-panels-ui.mjs must reserve Windows WCO native window-control inset across docked/swapped/maximized/floating layouts"
  );
  const tbRtSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "runtime", "tab-bar-ui.mjs"), "utf8");
  assert(
    tbRtSrc.includes('.t3e-new-tab-pill[data-active-tab="true"]'),
    "tab-bar-ui.mjs must style active new-tab pill without depending on ChatGPT Layer 2/3 CSS"
  );
  const feRtSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "runtime", "files-explorer-ui.mjs"), "utf8");
  assert(
    feRtSrc.includes(".t3e-fe-section{"),
    "files-explorer-ui.mjs must include .t3e-fe-section fallback layout rule"
  );
  for (const patchFile of ["new-chat-layout.cjs", "sidebar-new-chat.cjs"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "patches", patchFile), "utf8");
    assert(src.includes("document.head.prepend"), `${patchFile} must prepend fallback styles so switching themes or --official never breaks layout`);
  }
  const ncPatchSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "patches", "new-chat-layout.cjs"), "utf8");
  const ncSvgBlock = ncPatchSrc.match(/const T3_NC_SVGS = \{([\s\S]*?)\n\};/)?.[1] || "";
  const ncSvgEntries = [...ncSvgBlock.matchAll(/^\s*(\w+):\s*\{([^\n]+)/gm)];
  assert(ncSvgEntries.length >= 9, "Expected all new-chat SVG icon definitions");
  for (const [, iconName, defLine] of ncSvgEntries) {
    assert(/\bwidth:\s*\d+/.test(defLine) && /\bheight:\s*\d+/.test(defLine), `T3_NC_SVGS.${iconName} must declare explicit width and height`);
  }
  const themeJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "themes", "chatgpt-app.json"), "utf8"));
  assert(
    themeJson.css.includes('[data-work-entry-id] > div:first-child[role="button"]') &&
      themeJson.css.includes('[data-work-entry-id] > div > div.pb-2:not(.ms-7):not(:has(> .t3e-diff-card))'),
    "themes/chatgpt-app.json Layer 2.2 must support 0.1.12 WorkRow nested toggle and detail wrappers"
  );
  assert(
    !themeJson.css.includes("--chat-content-max-width: 48rem") &&
      themeJson.css.includes('[data-testid="timeline-minimap"]'),
    "themes/chatgpt-app.json must preserve native chat lane gutter and keep timeline-minimap visible"
  );
  assert(
    themeJson.css.includes('[data-panel-layout-controls] :is(button, [data-slot="toggle"]):is([data-pressed], [aria-pressed="true"])') &&
      !themeJson.css.includes('[data-surface-subheader]:has([data-file-breadcrumbs]) button[aria-pressed="true"] {\n  background: var(--cx-accent-soft)'),
    "themes/chatgpt-app.json must style active topbar layout toggles in neutral gray"
  );
  assert(
    themeJson.css.includes('[data-file-breadcrumbs] [data-slot="scroll-area-viewport"]') &&
      themeJson.css.includes("direction: rtl !important;") &&
      themeJson.css.includes("margin-inline: 0 auto !important;") &&
      themeJson.css.includes('[data-current-file-crumb="true"] span') &&
      themeJson.css.includes("max-width: none !important;") &&
      themeJson.css.includes("min-width: max-content !important;"),
    "themes/chatgpt-app.json must left-align bounded file breadcrumbs, keep full current filename, and never clip the editor split button"
  );
  assert(
    themeJson.css.includes('[data-slot="sidebar-rail"]') &&
      themeJson.css.includes("top: calc(var(--workspace-topbar-height, 38px) + 14px) !important;"),
    "themes/chatgpt-app.json must keep sidebar-rail below the top window bar and curved sheet corner"
  );
  assert(
    themeJson.css.includes("1.6 Unified ChatGPT inputs") &&
      themeJson.css.includes('[data-slot="input-control"][class*="border-input"]') &&
      themeJson.css.includes('[data-slot="input-group"][class*="border-input"]') &&
      themeJson.css.includes('[data-slot="textarea-control"][class*="border-input"]') &&
      themeJson.css.includes('[data-slot="select-trigger"][class*="border-input"]') &&
      themeJson.css.includes('[data-slot="number-field-group"][class*="border-input"]') &&
      themeJson.css.includes(':where(') &&
      themeJson.css.includes('.t3e-sb-search-box [data-slot="input-control"]'),
    "themes/chatgpt-app.json must unify default inputs/textareas/selects/number fields with low-specificity :where() and reset sidebar nested input control"
  );
  for (const m of themeJson.css.matchAll(/:has\(/g)) {
    let depth = 0;
    let end = m.index + 5;
    for (; end < themeJson.css.length; end++) {
      if (themeJson.css[end] === "(") depth++;
      else if (themeJson.css[end] === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    assert(
      !themeJson.css.slice(m.index + 5, end).includes(":has("),
      `Nested :has() is invalid CSS and dropped by Chromium: ${themeJson.css.slice(Math.max(0, m.index - 40), end + 20)}`
    );
  }
}

function verifyNoTelemetryDesktop(desktopAsar) {
  const patch = noTelemetry.desktopPatch;
  const main = findUniqueEntry(desktopAsar, patch.targetRegex, patch.id).content.toString("utf8");
  const start = main.indexOf(`/* ${patch.marker} */`);
  assert(start >= 0, "Missing no-telemetry-desktop marker in main.cjs");
  assert(main.indexOf(`/* ${desktopTray.marker} */`) > start, "no-telemetry-desktop must coexist with desktop-tray in the same main.cjs");
  const end = main.indexOf("})();", start) + "})();".length;
  assert(end > start + 10, "Could not isolate the injected no-telemetry-desktop IIFE");
  const snippet = main.slice(start, end);
  const env = {};
  const registrations = [];
  let requires = 0;
  const electron = {
    app: { whenReady: () => ({ then(fn) { fn(); return { catch() {} }; } }) },
    session: { defaultSession: { webRequest: { onBeforeRequest: (filter, handler) => registrations.push({ filter, handler }) } } },
  };
  const context = createContext({
    process: { env },
    require: (id) => {
      assert.equal(id, "electron");
      requires++;
      return electron;
    },
  });
  runInContext(snippet, context);
  assert.equal(env.T3CODE_TELEMETRY_ENABLED, "false");
  assert.equal(env.T3CODE_OTEL_SDK_DISABLED, "true");
  assert.equal(registrations.length, 1, "onBeforeRequest must be registered exactly once");
  const urls = [...registrations[0].filter.urls];
  assert(urls.some((u) => u.includes("posthog.com")), "PostHog URL filter missing");
  assert(urls.some((u) => u.includes("ingest.t3.codes")), "T3 Code PostHog ingest URL filter missing");
  assert(urls.some((u) => u.includes("axiom.co")), "Axiom URL filter missing");
  assert(urls.some((u) => u.includes("clerk-telemetry.com")), "Clerk telemetry URL filter missing");
  assert(patch.legacyMarkers.includes("T3_NO_TELEMETRY_DESKTOP_V1"), "Legacy V1 desktop telemetry marker must stay recognized");
  let verdict = null;
  registrations[0].handler({ url: "https://us.i.posthog.com/e/" }, (result) => { verdict = result; });
  assert.deepEqual({ ...verdict }, { cancel: true }, "Telemetry requests must be cancelled");
  runInContext(snippet, context);
  assert.equal(registrations.length, 1, "The IIFE must be idempotent");
  assert.equal(requires, 1);
  const standalone = patch.apply(`"use strict";\nconst x = 1;\n`);
  assert(standalone.startsWith(`"use strict";`) && standalone.includes(patch.marker) && standalone.endsWith("const x = 1;\n"), "Standalone apply must keep the use-strict directive first");
}

// ---------------------------------------------------------------------------
// Suite 17: synthetic v0.1.99 mutants of the pristine v0.1.12 archives.
// ---------------------------------------------------------------------------
const MUTANT_VERSION = "0.1.99";
const DESKTOP_MAIN_KEY = "apps/desktop/dist-electron/main.cjs";
// Patches without a semantic targetSpec pin one exact build hash and can never auto-adapt to a new T3 Code version.
// They are excluded from the per-module checks below and reported as one explicit failure at the end of Suite 17.
const hashOnlyPatchIds = new Set(ALL_PATCHES.filter((p) => !p.targetSpec || p.crossVersion === false).map((p) => p.id));
const adaptablePatches = (patches) => patches.filter((p) => !hashOnlyPatchIds.has(p.id));

function packAsarHeader(header) {
  const json = Buffer.from(JSON.stringify(header));
  const padded = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16 + padded);
  [4, 8 + padded, 4 + padded, json.length].forEach((size, i) => prefix.writeUInt32LE(size, i * 4));
  json.copy(prefix, 16);
  return prefix;
}

const SLIM_EXTRA_CHUNKS_RE = /^apps\/server\/dist\/client\/assets\/(?:vcs|query|diffPanelStore|rightPanelStore|entities|queries|diffRendering|observeIntersection|useOpenLink)-[\w-]+\.js$/;

// Build a slim real-content ASAR containing only package metadata, patch target chunks, their
// 1-hop relative imports (+ export * re-exports), and ensureChunkImport sibling chunks.
// Preserves 100% real T3 Code JS content & SHA-256 entry integrity while avoiding ~245 MB of
// unrelated node_modules/media I/O during Suite 17/18 stress builds.
function createSlimAsar(baseAsar, patches, outputPath) {
  const keys = new Set();
  for (const meta of ["package.json", "apps/server/package.json", "apps/desktop/package.json"]) {
    if (baseAsar.byKey.has(meta)) keys.add(meta);
  }
  const targetKeys = [];
  for (const p of patches) {
    try {
      const target = findPatchTarget(baseAsar, p);
      if (target && !keys.has(target.key)) {
        keys.add(target.key);
        targetKeys.push(target.key);
      }
    } catch {}
  }
  for (const rec of baseAsar.entries) {
    if (SLIM_EXTRA_CHUNKS_RE.test(rec.key)) keys.add(rec.key);
  }
  for (const k of targetKeys) {
    const rec = baseAsar.byKey.get(k);
    if (!rec) continue;
    const text = entryText(baseAsar, rec);
    for (const imp of parseImports(tokenize(text))) {
      if (!imp.specifier.startsWith(".")) continue;
      const depKey = resolveRelativeKey(k, imp.specifier);
      if (baseAsar.byKey.has(depKey) && !keys.has(depKey)) {
        keys.add(depKey);
        const depText = entryText(baseAsar, baseAsar.byKey.get(depKey));
        for (const m of depText.matchAll(/export\s*\*\s*from\s*["'](\.[^"']+)["']/g)) {
          const reKey = resolveRelativeKey(depKey, m[1]);
          if (baseAsar.byKey.has(reKey)) keys.add(reKey);
        }
      }
    }
  }
  const header = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const key of keys) {
    const rec = baseAsar.byKey.get(key);
    const buf = readEntryBuffer(baseAsar, rec);
    const parts = key.split("/");
    let node = header;
    for (let i = 0; i < parts.length - 1; i++) {
      node = node.files[parts[i]] ||= { files: {} };
    }
    node.files[parts[parts.length - 1]] = {
      size: buf.length,
      offset: String(offset),
      integrity: rec.entry.integrity,
    };
    chunks.push(buf);
    offset += buf.length;
  }
  fs.writeFileSync(outputPath, Buffer.concat([packAsarHeader(header), ...chunks]));
  return { path: outputPath, asar: readAsar(outputPath) };
}

function moveHeaderEntry(header, fromKey, toKey) {
  const dirOf = (key) => key.split("/").slice(0, -1).reduce((node, seg) => node.files[seg], header);
  const fromDir = dirOf(fromKey);
  const toDir = dirOf(toKey);
  const fromName = fromKey.split("/").pop();
  const toName = toKey.split("/").pop();
  assert(fromDir.files[fromName] && !toDir.files[toName], `Cannot rename ASAR entry ${fromKey}`);
  toDir.files[toName] = fromDir.files[fromName];
  delete fromDir.files[fromName];
}

function scanIdentifier(text, name, replacement) {
  const isIdent = (ch) => ch !== undefined && /[\w$]/.test(ch);
  let out = "";
  let pos = 0;
  let count = 0;
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + name.length)) {
    if (isIdent(text[i - 1]) || isIdent(text[i + name.length])) continue;
    out += text.slice(pos, i) + (replacement ?? name);
    pos = i + name.length;
    count++;
  }
  return { text: out + text.slice(pos), count };
}

function renameIdentifier(text, from, to) {
  assert.equal(scanIdentifier(text, to).count, 0, `Mutation target ${to} must not already exist`);
  const result = scanIdentifier(text, from, to);
  assert(result.count > 0, `Identifier ${from} not found for mutation`);
  return result.text;
}

function replaceAllLiteral(text, from, to) {
  assert(text.includes(from), `Missing literal ${from} for mutation`);
  return text.split(from).join(to);
}

const bumpVersion = (text) => text.replace(/("(?:version|buildVersion)"\s*:\s*")\d+\.\d+\.\d+(")/g, (m, head, tail) => head + MUTANT_VERSION + tail);
// Keep a leading shebang first so the mutated chunk stays valid.
const addBanner = (text) => {
  const banner = `/* t3code v${MUTANT_VERSION} build banner */\n`;
  if (!text.startsWith("#!")) return banner + text;
  const lineEnd = text.indexOf("\n") + 1;
  return text.slice(0, lineEnd) + banner + text.slice(lineEnd);
};

// Rebuild an archive with edited entries (all other bytes verified identical) and renamed chunk files.
// Renamed chunks also get every importer rewritten so the mutant stays internally consistent.
function writeMutatedAsar(baseAsar, outputPath, { edits, renames = [] }) {
  const texts = new Map();
  const current = (key) => {
    if (!texts.has(key)) {
      const rec = baseAsar.byKey.get(key);
      assert(rec, `Missing ASAR entry to mutate: ${key}`);
      texts.set(key, entryText(baseAsar, rec));
    }
    return texts.get(key);
  };
  for (const [key, transforms] of edits) {
    for (const transform of transforms) texts.set(key, transform(current(key)));
    assert.notEqual(texts.get(key), entryText(baseAsar, baseAsar.byKey.get(key)), `Mutation must change ${key}`);
  }
  for (const [fromKey, toKey] of renames) {
    const oldName = path.posix.basename(fromKey);
    const newName = path.posix.basename(toKey);
    const needle = Buffer.from(oldName);
    for (const rec of baseAsar.entries) {
      if (!/\.(?:m?js|cjs)$/.test(rec.key) || rec.key === fromKey) continue;
      const offset = Number(rec.entry.offset);
      if (!texts.has(rec.key) && !baseAsar.body.subarray(offset, offset + rec.entry.size).includes(needle)) continue;
      texts.set(rec.key, current(rec.key).split(oldName).join(newName));
    }
  }
  const replacements = [...texts].map(([key, text]) => ({ key, replacement: Buffer.from(text, "utf8") }));
  const staging = `${outputPath}.stage`;
  const staged = writePatchedAsar(baseAsar, replacements, staging);
  try {
    const header = JSON.parse(JSON.stringify(staged.header));
    for (const [fromKey, toKey] of renames) moveHeaderEntry(header, fromKey, toKey);
    fs.writeFileSync(outputPath, Buffer.concat([packAsarHeader(header), staged.body]), { flag: "wx" });
  } finally {
    fs.rmSync(staging, { force: true });
  }
  return readAsar(outputPath);
}

function createServerMutant(baseAsar, outputPath) {
  const patches = applicablePatchesForArchive(baseAsar, ALL_PATCHES);
  const target = (patch) => findPatchTarget(baseAsar, patch).key;
  const edits = new Map();
  const add = (key, transform) => edits.set(key, [...(edits.get(key) || []), transform]);
  add("package.json", bumpVersion);
  // Every patch target drifts to a new content hash, so no module can be recognised through originalHash.
  for (const key of new Set(patches.map(target))) add(key, addBanner);
  const runtimeLayer = target(noTelemetry);
  const workflow = target(noTelemetry.relayPatch);
  const settings = target(noTelemetry.uiPatch);
  const threadRoute = target(usageRings);
  add(runtimeLayer, (t) => {
    const analyticsMake = t.match(/effect\(\s*AnalyticsService\s*,\s*(make\$\d+)\s*\)/)?.[1];
    assert(analyticsMake, "Missing AnalyticsService make$NN binding for mutation");
    return renameIdentifier(renameIdentifier(t, analyticsMake, "make$999"), "Boolean$1", "BoolCfg$99");
  });
  add(workflow, (t) => `${t}\n// t3code v${MUTANT_VERSION} content-hash drift\n`);
  add(threadRoute, (t) => {
    const fnNames = [...t.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]).filter((n) => n.length <= 3);
    const renameCandidates = [...new Set(fnNames)].slice(0, 2);
    let out = t;
    for (const fn of renameCandidates) out = renameIdentifier(out, fn, `${fn}_v99`);
    // Shift the largest React Compiler memo cache allocation in ThreadRouteView so slot-index assumptions cannot slip through
    const cacheMatches = [...out.matchAll(/let\s+([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\((\d+)\)/g)];
    cacheMatches.sort((a, b) => Number(b[3]) - Number(a[3]));
    const largestCache = cacheMatches[0];
    assert(largestCache, "Missing React Compiler memo cache in ThreadRouteView for mutation");
    const [, cacheVar, compilerVar, sizeStr] = largestCache;
    const origSize = Number(sizeStr);
    const bumpedSize = origSize + 79;
    out = replaceAllLiteral(out, `(0,${compilerVar}.c)(${origSize})`, `(0,${compilerVar}.c)(${bumpedSize})`);
    const lastSlot = `${cacheVar}[${origSize - 1}]`;
    if (out.includes(lastSlot)) out = replaceAllLiteral(out, lastSlot, `${cacheVar}[${bumpedSize - 1}]`);
    return out;
  });
  const sibling = (key, name) => `${path.posix.dirname(key)}/${name}`;
  // Rename actual exported + imported alias (useModelTraits in utils-*.js) to ensure cross-chunk semantic export/import resolution survives minifier alias shifts
  const threadText = readEntryBuffer(baseAsar, baseAsar.byKey.get(threadRoute)).toString("utf8");
  const utilsImp = [...threadText.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/(utils-[\w.-]+\.js)"/g)][0];
  let mutatedUtilsKey = null;
  if (utilsImp) {
    mutatedUtilsKey = sibling(threadRoute, utilsImp[2]);
    const utilsRec = baseAsar.byKey.get(mutatedUtilsKey);
    const utilsText = utilsRec ? readEntryBuffer(baseAsar, utilsRec).toString("utf8") : "";
    const ctx = createPatchContext(baseAsar, baseAsar.byKey.get(threadRoute), threadText);
    const traitsRes = ctx.resolveImportedAlias(
      /utils-.*\.js$/,
      (_l, _t, _e, decl) => {
        const d = decl(_l);
        return Boolean(d && d.includes("selectValue:") && d.includes("changeSelect:") && d.includes("changeBoolean:"));
      },
      "mutant-useModelTraits"
    );
    const expMatchRe = traitsRes?.imported ? new RegExp(`\\bas\\s+${traitsRes.imported}(?=[,}])`) : null;
    const expIdx = utilsText.lastIndexOf("export{");
    if (expMatchRe && expIdx >= 0 && expMatchRe.test(utilsText.slice(expIdx)) && traitsRes.imported !== traitsRes.local) {
      const renamedExport = `${traitsRes.imported}_M99`;
      const renamedLocal = `${traitsRes.local}_M99`;
      add(mutatedUtilsKey, (u) => {
        const ei = u.lastIndexOf("export{");
        return u.slice(0, ei) + u.slice(ei).replace(expMatchRe, `as ${renamedExport}`);
      });
      add(threadRoute, (t) => {
        const savedImports = [];
        const masked = t.replace(/import\s*\{[^}]*\}\s*from\s*"\.\/[^"]+"/g, (m) => {
          const token = `__T3_MUT_IMP_${savedImports.length}__`;
          savedImports.push(m);
          return token;
        });
        let renamed = renameIdentifier(masked, traitsRes.local, renamedLocal);
        for (let idx = 0; idx < savedImports.length; idx++) {
          let impLine = savedImports[idx];
          if (impLine.includes(utilsImp[2])) {
            impLine = impLine.replace(
              new RegExp(`\\b${traitsRes.imported}\\s+as\\s+${traitsRes.local}(?=[,}])`),
              `${renamedExport} as ${renamedLocal}`
            );
          } else {
            // If another import binds local === traitsRes.local, keep its imported export name intact
            impLine = impLine.replace(
              new RegExp(`\\bas\\s+${traitsRes.local}(?=[,}])`),
              `as ${renamedLocal}`
            );
          }
          renamed = renamed.replace(`__T3_MUT_IMP_${idx}__`, () => impLine);
        }
        return renamed;
      });
    }
  }
  const renames = [
    [runtimeLayer, sibling(runtimeLayer, "runtimeLayer-MUT99999.mjs")],
    [workflow, sibling(workflow, "WorkflowStore-MUT99999.mjs")],
    [settings, sibling(settings, "SettingsPanels-MUT99999.js")],
  ];
  return { asar: writeMutatedAsar(baseAsar, outputPath, { edits, renames }), path: outputPath, patches, renames };
}

function createDesktopMutant(baseAsar, outputPath) {
  const patches = applicablePatchesForArchive(baseAsar, [noTelemetry.desktopPatch, desktopTray]);
  const edits = new Map([
    ["package.json", [bumpVersion]],
    [DESKTOP_MAIN_KEY, [
      addBanner,
      (t) => {
        const makeVar = t.match(/\b(?:const|var|let)\s+(make\$\d+)\s*=/)?.[1];
        assert(makeVar, "Missing desktop make$NN binding for mutation");
        return renameIdentifier(t, makeVar, `${makeVar}_v99`);
      },
    ]],
  ]);
  return { asar: writeMutatedAsar(baseAsar, outputPath, { edits }), path: outputPath, patches };
}

// Break one anchor in an already-mutated desktop archive.
function createDesktopVariant(baseAsar, outputPath, transform) {
  const patches = applicablePatchesForArchive(baseAsar, ALL_PATCHES);
  return { asar: writeMutatedAsar(baseAsar, outputPath, { edits: new Map([[DESKTOP_MAIN_KEY, [transform]]]) }), path: outputPath, patches };
}

function assertAutoAdapted(inspected, expectedCount, label) {
  assert.equal(inspected.appVersion, MUTANT_VERSION, `${label}: appVersion`);
  assert.equal(inspected.modules.length, expectedCount, `${label}: module count`);
  const adaptableModules = inspected.modules.filter((m) => !hashOnlyPatchIds.has(m.id));
  const explain = (id) => {
    const patch = ALL_PATCHES.find((p) => p.id === id);
    try {
      const entry = findPatchTarget(inspected.asar, patch);
      const text = entry.content.toString("utf8");
      const ctx = createPatchContext(inspected.asar, entry, text);
      const next = ctx.getInjectedImports().join("") + patch.apply(text, ctx);
      validateScriptSyntax(Buffer.from(next, "utf8"), entry.key, id);
      verifyInjectedScope(next, ctx.getInjectedCodeSnippets(), id, patch.allowedGlobals || []);
      return `${id}: apply(), syntax and scope gate all succeeded`;
    } catch (error) {
      return `${id}: ${error.message.split("\n")[0]}`;
    }
  };
  assert.deepEqual(adaptableModules.filter((m) => !m.pristine).map((m) => explain(m.id)), [], `${label}: modules that failed auto-adaptation`);
  const summary = summarizeModuleStates(adaptableModules);
  assert.equal(summary.allRecognized, true, `${label}: allRecognized`);
  assert.equal(summary.autoAdapted, true, `${label}: autoAdapted`);
  for (const m of adaptableModules) {
    assert.equal(m.pristine, true, `${label}: ${m.id} must be recognised as pristine`);
    assert.equal(m.compat, "auto-adapted", `${label}: ${m.id} must be auto-adapted, not verified`);
    assert.equal(m.installed, false, `${label}: ${m.id} must not report installed`);
    assert.equal(m.appVersion, MUTANT_VERSION, `${label}: ${m.id} appVersion`);
  }
}

function verifyCrossVersionMutation(serverBaseline, desktopBaseline) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-suite17-"));
  const absent = path.join(tmpRoot, "absent.backup");
  try {
    // 17.1 Mutated v0.1.99 server archive: renamed chunks, renamed minified identifiers, shifted memo slots.
    const serverMutant = createServerMutant(serverBaseline.asar, path.join(tmpRoot, "server-0.1.99.asar"));
    const mutantInspected = inspectArchive(serverMutant.path);
    assertAutoAdapted(mutantInspected, serverMutant.patches.length, "server mutant");
    const byId = new Map(mutantInspected.modules.map((m) => [m.id, m]));
    assert(byId.get("no-telemetry").key.endsWith("/runtimeLayer-MUT99999.mjs"), "runtimeLayer must be found through its semantic fingerprint after a hash rename");
    assert(byId.get("no-telemetry-relay").key.endsWith("/WorkflowStore-MUT99999.mjs"));
    assert(byId.get("no-telemetry-ui").key.endsWith("/SettingsPanels-MUT99999.js"));
    assert(/\/ThreadRouteView-[\w-]+\.js$/.test(byId.get("usage-rings").key));

    // Sibling helper inserted between AnalyticsService make$... declaration and effect(AnalyticsService, ...) must survive no-telemetry patching
    const rtEntry = findUniqueEntry(serverBaseline.asar, noTelemetry.targetRegex, "no-telemetry-sibling-test");
    const rtOrig = rtEntry.content.toString("utf8");
    const rtEffectMatch = rtOrig.match(/const\s+[A-Za-z_$][\w$]*\s*=\s*effect\(\s*AnalyticsService\s*,\s*[A-Za-z_$][\w$]*\s*\);/);
    assert(rtEffectMatch);
    const rtWithSibling = rtOrig.slice(0, rtEffectMatch.index) +
      "const t3SiblingKeepHelper = () => 42;\nfunction t3UseSiblingHelper() { return t3SiblingKeepHelper(); }\n" +
      rtOrig.slice(rtEffectMatch.index);
    const rtPatchedWithSibling = noTelemetry.apply(rtWithSibling, createPatchContext(serverBaseline.asar, rtEntry, rtWithSibling));
    assert(
      rtPatchedWithSibling.includes("t3SiblingKeepHelper") && rtPatchedWithSibling.includes("t3UseSiblingHelper"),
      "no-telemetry patch must only replace the make declaration and preserve sibling code before effect(AnalyticsService, ...)"
    );

    const patchedServerPath = path.join(tmpRoot, "server-0.1.99.patched.asar");
    const serverReport = buildPatchedArchive(serverMutant.asar, adaptablePatches(serverMutant.patches), patchedServerPath);
    assert.equal(serverReport.length, adaptablePatches(serverMutant.patches).length);
    assert(serverReport.every((r) => r.compat === "auto-adapted" && r.appVersion === MUTANT_VERSION), "Every mutated module must be built through auto-adaptation");
    const patchedServer = inspectArchive(patchedServerPath);
    assert.equal(patchedServer.appVersion, MUTANT_VERSION);
    assert.equal(patchedServer.enhancerVersion, require("../lib/version.cjs").ENHANCER_VERSION, "Patched ASAR must persist standardized enhancerVersion");
    assert.equal(getArchiveCompatibilityTier(patchedServer).tier, "auto-adapted", "Patched auto-adapted ASAR must persist auto-adapted tier in t3e-build-meta.json");
    assert.equal(summarizeModuleStates(patchedServer.modules.filter((m) => !hashOnlyPatchIds.has(m.id))).allInstalled, true, "Patched v0.1.99 server must report allInstalled");
    verifyRuntimeAssets(patchedServer.asar, ["timeline-ui", "inline-diff-ui", "usage-rings-ui", "files-explorer-ui"]);

    // Verify ESM import linking checks final patched replacements (not stale baseline) & enforces default imports + wildcard re-exports
    const modKeyA = "apps/server/dist/esm-mod-a.js";
    const modKeyB = "apps/server/dist/esm-mod-b.js";
    const modKeyC = "apps/server/dist/esm-mod-c.js";
    const fixtureWithModsPath = path.join(tmpRoot, "esm-fixture-mods.asar");
    writePatchedAsar(desktopBaseline.asar, [], fixtureWithModsPath, [
      { key: modKeyA, content: Buffer.from('import defVal, { keepMe } from "./esm-mod-b.js";\nexport function runA() { return defVal() + keepMe(); }\n') },
      { key: modKeyB, content: Buffer.from('export default function bDef() { return 1; }\nexport function keepMe() { return 2; }\nexport * from "./esm-mod-c.js";\n') },
      { key: modKeyC, content: Buffer.from('export async function extraAsync() { return 3; }\nexport const firstV = 1, secondV = 2;\nexport * as nsC from "./esm-mod-b.js";\n') },
    ]);
    const modFixture = readAsar(fixtureWithModsPath);
    // Patch B removes default export -> buildPatchedArchive must catch missing default import in patched A
    const esmBadOut = path.join(tmpRoot, "esm-bad-default.asar");
    assert.throws(
      () => buildPatchedArchive(modFixture, [
        {
          id: "esm-a",
          name: "esm-a",
          marker: "T3_ESM_A",
          legacyMarkers: [],
          targetRegex: /^apps\/server\/dist\/esm-mod-a\.js$/,
          targetSpec: { pathRegex: /^apps\/server\/dist\/esm-mod-a\.js$/, includes: ["keepMe"] },
          originalHash: "0".repeat(64),
          apply: (s) => `/* T3_ESM_A */\n${s}`,
        },
        {
          id: "esm-b",
          name: "esm-b",
          marker: "T3_ESM_B",
          legacyMarkers: [],
          targetRegex: /^apps\/server\/dist\/esm-mod-b\.js$/,
          targetSpec: { pathRegex: /^apps\/server\/dist\/esm-mod-b\.js$/, includes: ["bDef"] },
          originalHash: "0".repeat(64),
          apply: (s) => `/* T3_ESM_B */\n` + s.replace("export default function bDef() { return 1; }\n", ""),
        },
      ], esmBadOut),
      /import "default" from \.\/esm-mod-b\.js/,
      "buildPatchedArchive must verify default imports against final patched replacement modules"
    );
    assert(!fs.existsSync(esmBadOut));
    // Positive check: patched A imports newly added export async fn + multi-var export through wildcard re-export & updated replacement B
    const esmGoodOut = path.join(tmpRoot, "esm-good-link.asar");
    buildPatchedArchive(modFixture, [
      {
        id: "esm-a",
        name: "esm-a",
        marker: "T3_ESM_A",
        legacyMarkers: [],
        targetRegex: /^apps\/server\/dist\/esm-mod-a\.js$/,
        targetSpec: { pathRegex: /^apps\/server\/dist\/esm-mod-a\.js$/, includes: ["keepMe"] },
        originalHash: "0".repeat(64),
        apply: () => '/* T3_ESM_A */\nimport defVal, { extraAsync, secondV, newlyAdded } from "./esm-mod-b.js";\nexport function runA() { return [defVal, extraAsync, secondV, newlyAdded]; }\n',
      },
      {
        id: "esm-b",
        name: "esm-b",
        marker: "T3_ESM_B",
        legacyMarkers: [],
        targetRegex: /^apps\/server\/dist\/esm-mod-b\.js$/,
        targetSpec: { pathRegex: /^apps\/server\/dist\/esm-mod-b\.js$/, includes: ["bDef"] },
        originalHash: "0".repeat(64),
        apply: (s) => `/* T3_ESM_B */\nexport const newlyAdded = 9;\n${s}`,
      },
    ], esmGoodOut);
    assert(fs.existsSync(esmGoodOut), "buildPatchedArchive must resolve newly added replacement exports, export async fn, comma declarators, and export *");
    fs.unlinkSync(esmGoodOut);

    // Missing/corrupt external runtime asset must mark host patch as outdated/invalid rather than installed
    const corruptRtPath = path.join(tmpRoot, "server-corrupt-rt.asar");
    const brokenRuntimeMod = patchedServer.asar.entries.find((e) => /\/t3e-usage-rings-ui-[0-9a-f]{8}\.js$/.test(e.key));
    assert(brokenRuntimeMod, "Must emit t3e-usage-rings-ui runtime asset");
    writePatchedAsar(patchedServer.asar, [{ key: brokenRuntimeMod.key, replacement: Buffer.from("export function corrupted() {}\n") }], corruptRtPath);
    const brokenInspect = inspectArchive(corruptRtPath);
    const brokenUsageMod = brokenInspect.modules.find((m) => m.id === "usage-rings");
    assert.equal(brokenUsageMod.installed, false, "Tampered runtime asset must invalidate usage-rings installed status");
    assert.equal(brokenUsageMod.outdated, true, "Tampered runtime asset must flag usage-rings as needing upgrade/repair");

    // Unresolvable dependency in ThreadRouteView must fail explicitly instead of silently emitting broken bridge bindings
    const trEntry = findUniqueEntry(serverBaseline.asar, usageRings.targetRegex, "usage-rings-neg");
    const trText = trEntry.content.toString("utf8");
    const brokenImportSrc = trText.replace(/import\{([^}]+)\}from"\.\/(popover-[\w.-]+\.js)"/, 'import{}from"./$2"');
    assert.notEqual(brokenImportSrc, trText, "Expected popover import in ThreadRouteView for negative test");
    assert.throws(
      () => usageRings.apply(brokenImportSrc, createPatchContext(serverBaseline.asar, trEntry, brokenImportSrc)),
      /Could not resolve Popover \(t\) from popover/,
      "Broken fixed export alias must throw explicit diagnostic error"
    );
    const telemetryChunk = findUniqueEntry(patchedServer.asar, /\/runtimeLayer-MUT99999\.mjs$/, "mutated runtimeLayer").content.toString("utf8");
    assert(telemetryChunk.includes("const make$999 = gen$1(function* () {\n\t/* T3_NO_TELEMETRY_V1 */"), "Renamed AnalyticsService make$999 must be stubbed");
    assert(telemetryChunk.includes("BoolCfg$99(\"T3CODE_TELEMETRY_ENABLED\").pipe(withDefault(false))"), "Renamed Boolean$1 config helper must keep the default-off telemetry flag");

    // 17.1 Mutated v0.1.99 desktop archive (make$93 -> make$91).
    const desktopMutant = createDesktopMutant(desktopBaseline.asar, path.join(tmpRoot, "app-0.1.99.asar"));
    assertAutoAdapted(inspectArchive(desktopMutant.path, desktopMutant.patches), desktopMutant.patches.length, "desktop mutant");
    const patchedDesktopPath = path.join(tmpRoot, "app-0.1.99.patched.asar");
    const desktopAdaptPatches = adaptablePatches(desktopMutant.patches);
    const desktopReport = buildPatchedArchive(desktopMutant.asar, desktopAdaptPatches, patchedDesktopPath);
    assert.deepEqual(desktopReport.map((r) => r.id), desktopAdaptPatches.map((p) => p.id));
    assert(desktopReport.some((r) => r.id === "no-telemetry-desktop") && desktopReport.some((r) => r.id === "desktop-tray"));
    assert(desktopReport.every((r) => r.compat === "auto-adapted"));
    const patchedDesktop = inspectArchive(patchedDesktopPath, desktopMutant.patches);
    assert.equal(summarizeModuleStates(patchedDesktop.modules).allInstalled, true, "Patched v0.1.99 desktop must report allInstalled");
    verifyNoTelemetryDesktop(patchedDesktop.asar);
    verifyDesktopTray(patchedDesktop.asar);

    // 17.2 A different-version backup must never be restored over a newer app version.
    const mismatchPaths = (source, backup) => ({ source, backup, legacyBackup: absent });
    // (Hash-pinned patches would make a whole mutant archive unrecognisable, so only adaptable patches are inspected here.)
    const serverPatchSet = adaptablePatches(ALL_PATCHES);
    const pristineServer = resolvePristineBaseline(mismatchPaths(serverMutant.path, serverBaseline.path), serverPatchSet);
    assert.equal(pristineServer.path, serverMutant.path, "A pristine v0.1.99 source is its own baseline");
    assert.equal(pristineServer.appVersion, MUTANT_VERSION);
    assert.throws(() => resolvePristineBaseline(mismatchPaths(patchedServerPath, serverBaseline.path), serverPatchSet), /找不到未修改的原版 T3 Code 0\.1\.99/, "A patched v0.1.99 source must not fall back to the v0.1.12 backup");
    const pristineDesktop = resolvePristineBaseline(mismatchPaths(desktopMutant.path, desktopBaseline.path), desktopMutant.patches);
    assert.equal(pristineDesktop.path, desktopMutant.path);
    assert.throws(() => resolvePristineBaseline(mismatchPaths(patchedDesktopPath, desktopBaseline.path), desktopMutant.patches), /找不到未修改的原版 T3 Code 0\.1\.99/);
    const matchingBackup = resolvePristineBaseline(mismatchPaths(patchedDesktopPath, desktopMutant.path), desktopMutant.patches);
    assert.equal(matchingBackup.path, desktopMutant.path, "A same-version v0.1.99 backup is the correct baseline");
    assert.equal(matchingBackup.appVersion, MUTANT_VERSION);

    // 17.3 AST static scope gate.
    assert.throws(
      () => verifyInjectedScope("const a = 1;\n", ["const x = FAKE_UNDECLARED_VAR_999();"], "suite17 undeclared"),
      /Static scope check failed for suite17 undeclared: undeclared reference\(s\): FAKE_UNDECLARED_VAR_999/
    );
    assert.throws(
      () => verifyInjectedScope("const a = 1;\n", ["const el = (0,undefined.jsx)('div', {});"], "suite17 undefined-jsx"),
      /accidental "undefined\." property access/
    );
    verifyInjectedScope("import{q as r}from\"./x.js\";const a = 1;function b(){return a}\n", ["const y = r(a) + b() + Math.max(1, 2);"], "suite17 declared");
    verifyInjectedScope("const a = 1;\n", ["const z = t3Extra(a);"], "suite17 allowed", ["t3Extra"]);
    const rogueOut = path.join(tmpRoot, "rogue.asar");
    const rogue = {
      id: "rogue-undeclared",
      name: "rogue",
      marker: "T3_ROGUE_V1",
      legacyMarkers: [],
      targetRegex: noTelemetry.desktopPatch.targetRegex,
      targetSpec: noTelemetry.desktopPatch.targetSpec,
      originalHash: "0".repeat(64),
      apply(source, ctx) {
        const snippet = "/* T3_ROGUE_V1 */\nconst t3Rogue = FAKE_UNDECLARED_VAR_999();\n";
        ctx.recordInjectedCode(snippet);
        return snippet + source;
      },
    };
    assert.throws(() => buildPatchedArchive(desktopMutant.asar, [rogue], rogueOut), /Static scope check failed.*FAKE_UNDECLARED_VAR_999/);
    assert(!fs.existsSync(rogueOut), "A failed scope gate must not leave a patched archive behind");

    // 17.3 Fail closed when a semantic anchor disappears (spec no longer matches any chunk).
    const noAnchor = createDesktopVariant(desktopMutant.asar, path.join(tmpRoot, "app-no-anchor.asar"), (t) => replaceAllLiteral(t, "whenReady", "whenRdy"));
    assert.throws(() => inspectArchive(noAnchor.path), /Could not uniquely identify no-telemetry-desktop/);
    const noAnchorOut = path.join(tmpRoot, "app-no-anchor.out.asar");
    assert.throws(() => buildPatchedArchive(noAnchor.asar, noAnchor.patches, noAnchorOut), /Could not uniquely identify no-telemetry-desktop/);
    assert(!fs.existsSync(noAnchorOut));
    assert.throws(() => resolvePristineBaseline(mismatchPaths(noAnchor.path, absent)), /语义锚点不兼容/);

    // 17.3 Fail closed when the chunk is found but an apply() anchor is gone (module stays unrecognised, build aborts).
    const brokenApply = createDesktopVariant(desktopMutant.asar, path.join(tmpRoot, "app-broken-apply.asar"), (t) => replaceAllLiteral(t, "mainClosedDuringStartup = true;", "mainClosedDuringStartupX = true;"));
    const brokenInspected = inspectArchive(brokenApply.path);
    const trayModule = brokenInspected.modules.find((m) => m.id === "desktop-tray");
    assert.equal(trayModule.pristine, false, "A patch whose apply() fails must not be auto-adapted");
    assert.equal(summarizeModuleStates(brokenInspected.modules).allRecognized, false);
    const brokenOut = path.join(tmpRoot, "app-broken-apply.out.asar");
    assert.throws(() => buildPatchedArchive(brokenApply.asar, brokenApply.patches, brokenOut), /Could not find target snippet/);
    assert(!fs.existsSync(brokenOut));
    assert.throws(() => resolvePristineBaseline(mismatchPaths(brokenApply.path, absent)), /未识别的版本内容/);

    // Every shipped patch must be able to follow a new T3 Code build (semantic targetSpec instead of a pinned hash).
    assert.deepEqual([...hashOnlyPatchIds], [], "These patches still pin one build hash (no targetSpec) and cannot auto-adapt to a new T3 Code version");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

const cliArgs = process.argv.slice(2);
const flagUnit = cliArgs.includes("--unit");
const flagFull = cliArgs.includes("--full");
const explicitSource = cliArgs.find((arg) => !arg.startsWith("-")) || null;

if (flagUnit) {
  console.log("\nUNIT TESTS PASSED.");
  return;
}

console.log("4. Full dry-run ASAR build (all patches) + syntax & integrity check...");
function findDefaultVerifyAsar() {
  const candidates = [];
  if (process.env.T3CODE_ASAR) candidates.push(process.env.T3CODE_ASAR);
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "t3code", "resources", "server.asar"));
  }
  if (process.platform === "linux") candidates.push(...getLinuxAsarCandidates());
  // macOS 增强版副本总是已打补丁且没有原版备份，不能作为基线，只用官方 .app。
  if (process.platform === "darwin") candidates.push("/Applications/T3 Code (Beta).app/Contents/Resources/app.asar");
  return candidates.find((p) => p && fs.existsSync(p));
}
const source = explicitSource || findDefaultVerifyAsar();
assert(source, "请提供原版 ASAR：node tests/verify.cjs <app.asar|server.asar>");
const baseline = resolvePristineBaseline({
  source,
  backup: source + ".before-t3code-enhancer",
  legacyBackup: source + ".before-timeline-collapse",
});
const siblingAppAsar = path.basename(source) === "server.asar"
  ? path.join(path.dirname(source), "app.asar")
  : null;
const isCombinedInput =
  baseline.asar.entries.some((e) => e.key.startsWith("apps/server/")) &&
  baseline.asar.entries.some((e) => e.key === "apps/desktop/dist-electron/main.cjs");
// Cross-version architecture: 19 patches = 17 server + 2 desktop (no-telemetry-desktop in privacy, desktop-tray in workspace).
const desktopPatches = [noTelemetry.desktopPatch, desktopTray];
assert(noTelemetry.desktopPatch, "no-telemetry must export the desktopPatch");
assert.equal(ALL_PATCHES.length, 19, "ALL_PATCHES must contain 17 server + 2 desktop patches");
assert.deepEqual(ALL_PATCHES.filter((p) => p.targetRegex.test("apps/desktop/dist-electron/main.cjs")).map((p) => p.id), ["no-telemetry-desktop", "desktop-tray"]);
assert.equal(ALL_PATCHES.filter((p) => !p.targetRegex.test("apps/desktop/dist-electron/main.cjs")).length, 17);
assert.deepEqual(PACKS.find((p) => p.id === "privacy").patchIds, ["no-telemetry", "no-telemetry-relay", "no-telemetry-client", "no-telemetry-ui", "no-telemetry-desktop"]);
assert.equal(
  applicablePatchesForArchive(baseline.asar, ALL_PATCHES).length,
  isCombinedInput ? 19 : 17,
  isCombinedInput ? "Combined app.asar must receive all 19 patches" : "server.asar must receive exactly the 17 server patches"
);
const desktopBaseline = isCombinedInput
  ? baseline
  : (siblingAppAsar && fs.existsSync(siblingAppAsar)
      ? resolvePristineBaseline({
          source: siblingAppAsar,
          backup: siblingAppAsar + ".before-t3code-enhancer",
          legacyBackup: siblingAppAsar + ".before-timeline-collapse",
        }, desktopPatches)
      : null);
const tmpOut = path.join(os.tmpdir(), `t3code-enhancer-test-${Date.now()}.asar`);
const tmpDesktopOut = !isCombinedInput && desktopBaseline ? path.join(os.tmpdir(), `t3code-enhancer-desktop-test-${Date.now()}.asar`) : null;
try {
  const baselineApplicable = applicablePatchesForArchive(baseline.asar, ALL_PATCHES);
  const report = buildPatchedArchive(baseline.asar, baselineApplicable, tmpOut);
  const verified = readAsar(tmpOut);
  for (const p of baselineApplicable) {
    const entry = findUniqueEntry(verified, p.targetRegex, p.id);
    const entryStr = entry.content.toString("utf8");
    assert(entryStr.includes(p.marker), `Marker missing for ${p.id}`);
    assert(!/\(0,\s*undefined\.|\bundefined\.(?:jsx|jsxs|Fragment)\b/.test(entryStr), `Accidental undefined JSX interpolation detected in ${p.id}`);
  }
  let verifiedDesktop = verified.entries.some((e) => desktopTray.targetRegex.test(e.key)) ? verified : null;
  if (desktopBaseline && tmpDesktopOut) {
    const desktopReport = buildPatchedArchive(desktopBaseline.asar, desktopPatches, tmpDesktopOut);
    assert.deepEqual(desktopReport.map((r) => r.id), ["no-telemetry-desktop", "desktop-tray"]);
    report.push(...desktopReport);
    verifiedDesktop = readAsar(tmpDesktopOut);
    for (const p of desktopPatches) {
      assert(findUniqueEntry(verifiedDesktop, p.targetRegex, p.id).content.toString("utf8").includes(p.marker), `Marker missing for ${p.id}`);
    }
  }
  // External ESM runtime assets: content-hashed t3e-*.js files shipped inside the patched ASAR and imported by host chunks.
  const runtimeAssets = verifyRuntimeAssets(verified, ["timeline-ui", "inline-diff-ui", "usage-rings-ui", "files-explorer-ui"]);
  console.log("   runtime assets:", [...runtimeAssets].sort().join(", "));
  console.log("   OK -> built & verified:", report.map((r) => `${r.id}(${r.patched.slice(0, 10)})`).join(", "));
  console.log("5. Creating a workspace panel portal through the archive's native React DOM loader...");
  verifyFloatingPanelPortal(verified);
  console.log("   OK");
  console.log("6. Verifying patched tab drag events and native reorder fallback...");
  verifyTabDrag(verified);
  console.log("   OK");
  console.log("7. Verifying native browser bounds and responsive layout on float and dock...");
  verifyNativePreviewPosition(verified);
  verifyResponsiveBrowserLayout(verified);
  console.log("   OK");
  console.log("8. Verifying main chat toolbar and workspace controls in docked and floating modes...");
  verifyWorkspaceToolbar(verified);
  console.log("   OK");
  console.log("9. Verifying inline diffs and shared line totals in expanded and collapsed edits...");
  verifyInlineEditDetail(verified);
  console.log("   OK");
  console.log("10. Verifying new tab address handoff and configured browser search...");
  verifyLauncherAddress(verified);
  console.log("   OK");
  console.log("11. Verifying usage-rings effort ticks, model-to-effort flow, and live harness quota...");
  verifyUsageRingsUX(verified);
  console.log("   OK");
  console.log("12. Verifying no-telemetry, modular packs, macOS adapter, and bug fixes...");
  verifyNoTelemetryAndAdapters(verified, baseline.asar);
  console.log("   OK");
  console.log("13. Verifying Linux CLI discovery, upgrade classification, and linux.cjs profile helpers...");
  verifyLinuxSupport(tmpOut);
  console.log("   OK");
  console.log("14. Verifying timeline-collapse same-file folding & summary deduplication...");
  verifySameFileFolding(verified);
  console.log("   OK");
  console.log("15. Verifying desktop system tray hide-to-tray, restore, toggle, and quit...");
  assert(verifiedDesktop, "Missing desktop main.cjs target to verify desktop-tray");
  verifyDesktopTray(verifiedDesktop);
  console.log("   OK");
  console.log("15.5. Verifying no-telemetry-desktop env hardening and PostHog/Axiom request cancellation in a sandboxed Electron mock...");
  verifyNoTelemetryDesktop(verifiedDesktop);
  console.log("   OK");
  console.log("16. Verifying files-changes-explorer tree normalization, search expand, and DOM structure...");
  verifyFilesChangesExplorer(verified);
  console.log("   OK");
  if (flagFull) {
    assert(desktopBaseline, "Suite 17/18 needs the sibling app.asar next to server.asar");
    const slimDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-slim-"));
    try {
      const slimServer = createSlimAsar(baseline.asar, ALL_PATCHES, path.join(slimDir, "server-slim.asar"));
      const slimDesktop = isCombinedInput
        ? slimServer
        : createSlimAsar(desktopBaseline.asar, macosCli.PATCHES, path.join(slimDir, "app-slim.asar"));
      console.log("17. Cross-Version Mutation & Auto-Adaptation Stress Test (synthetic v0.1.99 server + desktop archives)...");
      verifyCrossVersionMutation(slimServer, slimDesktop);
      console.log("   OK");
      console.log("18. Cross-platform (Windows dual-ASAR CLI transaction + Linux/macOS combined single-ASAR builds)...");
      verifyCrossPlatformArchivesAndTransactions(slimServer, slimDesktop);
      verifyReleaseZipCommit();
      console.log("   OK");
    } finally {
      fs.rmSync(slimDir, { recursive: true, force: true });
    }
  } else {
    console.log("   (Skipping heavy cross-version & transaction stress suites 17-18; run `npm run test:full` when needed)");
  }
} finally {
  if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  if (tmpDesktopOut && fs.existsSync(tmpDesktopOut)) fs.unlinkSync(tmpDesktopOut);
}

function verifyReleaseZipCommit() {
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-release-commit-"));
  const git = (...args) => execFileSync("git", [
    "-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid",
    "-c", "core.autocrlf=false", ...args,
  ], { cwd: tempRepo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const edit = (file, content) => fs.writeFileSync(path.join(tempRepo, file), content);
  const options = { skipPreflight: true, skipRemoteCheck: true };
  try {
    git("init", "-q", "-b", "main");
    edit(".gitignore", "dist/\n");
    for (const file of [".gitattributes", "install.sh", "install.cmd", "repair.cmd", "status.cmd", "uninstall.cmd", "使用教程.md"]) {
      fs.copyFileSync(path.join(__dirname, "..", file), path.join(tempRepo, file));
    }
    edit("cli.cjs", 'console.log("old");\n');
    git("add", "--all");
    git("update-index", "--chmod=+x", "install.sh");
    git("commit", "-qm", "Original package");

    const packaged = packRelease(tempRepo, { skipVerify: true });
    const notes = path.join("dist", `release-${packaged.tag}.md`);
    edit(notes, `Release SHA-256: ${packaged.sha256}\n`);
    const initial = validateReleaseReadiness(tempRepo, options);
    assert(initial.ok, initial.errors.join("\n"));
    assert.equal(initial.commit, git("rev-parse", "HEAD"));
    assert(initial.plannedCommands.some((command) => command.startsWith(`git tag -a ${packaged.tag} ${initial.commit} `)));

    edit("cli.cjs", 'console.log("new");\n');
    git("add", "cli.cjs");
    git("commit", "-qm", "Change CLI before release");
    const stale = validateReleaseReadiness(tempRepo, options);
    assert.equal(stale.ok, false, "A stale ZIP with matching release notes must be rejected");
    assert(stale.errors.some((error) => /cli\.cjs.*不一致/.test(error)), stale.errors.join("\n"));

    const rebuilt = packRelease(tempRepo, { skipVerify: true });
    edit(notes, `Release SHA-256: ${rebuilt.sha256}\n`);
    const rebuiltPlan = validateReleaseReadiness(tempRepo, options);
    assert(rebuiltPlan.ok, rebuiltPlan.errors.join("\n"));
    assert.equal(rebuiltPlan.commit, git("rev-parse", "HEAD"));
  } finally {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  }
}

function verifyCrossPlatformArchivesAndTransactions(serverBaseline, desktopBaseline) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-xplat-"));
  try {
    // A. Compose macos-user-data + desktop-tray + no-telemetry-desktop on real 0.1.12 desktop main.cjs
    const desktopHasServer = desktopBaseline.asar.entries.some((e) => e.key.startsWith("apps/server/"));
    const macDeskOut = path.join(tmpRoot, "mac-desktop-only.asar");
    const macDeskReport = buildPatchedArchive(
      desktopBaseline.asar,
      [noTelemetry.desktopPatch, desktopTray, macosCli.userDataPatch],
      macDeskOut
    );
    assert.deepEqual(macDeskReport.map((r) => r.id), ["no-telemetry-desktop", "desktop-tray", "macos-user-data"]);
    const macDeskOnlyCheck = inspectArchive(macDeskOut, [noTelemetry.desktopPatch, desktopTray, macosCli.userDataPatch]);
    assert.equal(summarizeModuleStates(macDeskOnlyCheck.modules).allInstalled, true);
    if (!desktopHasServer) {
      const macDeskInspected = macosCli.inspectMacosModules(macDeskOut, false);
      assert.equal(macDeskInspected.summary.allInstalled, true);
      assert.equal(macDeskInspected.summary.autoAdapted, false);
    }
    const macDeskAsar = readAsar(macDeskOut);
    verifyNoTelemetryDesktop(macDeskAsar);
    verifyDesktopTray(macDeskAsar);

    // B. Build synthetic combined Linux & macOS single-ASAR bundle (apps/server/* + apps/desktop/* inside app.asar)
    const combinedRawPath = path.join(tmpRoot, "combined-raw.asar");
    if (desktopHasServer) {
      fs.copyFileSync(desktopBaseline.path, combinedRawPath);
    } else {
      const serverAdditions = serverBaseline.asar.entries
        .filter((e) => e.key.startsWith("apps/server/"))
        .map((e) => ({ key: e.key, content: readEntryBuffer(serverBaseline.asar, e) }));
      writePatchedAsar(desktopBaseline.asar, [], combinedRawPath, serverAdditions);
    }
    const combinedRaw = readAsar(combinedRawPath);

    // B1. Linux combined ASAR receives all 19 ALL_PATCHES (17 server + 2 desktop) + all 6 external runtime assets
    const linuxCombinedOut = path.join(tmpRoot, "linux-combined.asar");
    const linuxPatches = applicablePatchesForArchive(combinedRaw, ALL_PATCHES);
    assert.equal(linuxPatches.length, 19, "Combined Linux app.asar must apply all 19 patches");
    buildPatchedArchive(combinedRaw, linuxPatches, linuxCombinedOut);
    const linuxVerified = readAsar(linuxCombinedOut);
    verifyRuntimeAssets(linuxVerified, ["timeline-ui", "inline-diff-ui", "usage-rings-ui", "files-explorer-ui", "floating-panels-ui", "tab-bar-ui"]);

    // B2. macOS combined ASAR receives all 20 macosCli.PATCHES (ALL_PATCHES + macos-user-data)
    const macCombinedOut = path.join(tmpRoot, "macos-combined.asar");
    const macPatches = applicablePatchesForArchive(combinedRaw, macosCli.PATCHES);
    assert.equal(macPatches.length, 20, "Combined macOS app.asar must apply all 20 patches including macos-user-data");
    buildPatchedArchive(combinedRaw, macPatches, macCombinedOut);
    const macCombinedState = macosCli.inspectMacosModules(macCombinedOut, false);
    assert.equal(macCombinedState.summary.allInstalled, true);
    assert.equal(macCombinedState.summary.autoAdapted, false);
    assert.equal(
      inferRepairPlanOptions(macCombinedState.modules.filter((m) => m.id !== "macos-user-data"), { installed: true, managed: true, officialOnly: false }).preset,
      "full"
    );

    // B3. Plan-shrink regression: installing workspace+composer then shrinking to workspace must NOT skip rebuild via matchesSelectedPatches
    const shrinkWork = resolveInstallPlan(ALL_PATCHES, { packs: ["workspace"] }).selectedPatches;
    const shrinkBoth = resolveInstallPlan(ALL_PATCHES, { packs: ["workspace", "composer"] }).selectedPatches;
    const combinedBothOut = path.join(tmpRoot, "combined-both.asar");
    buildPatchedArchive(combinedRaw, applicablePatchesForArchive(combinedRaw, shrinkBoth), combinedBothOut);
    const bothInspected = inspectArchive(combinedBothOut);
    assert.equal(
      matchesSelectedPatches(bothInspected.modules, applicablePatchesForArchive(bothInspected.asar, shrinkBoth)),
      true
    );
    assert.equal(
      matchesSelectedPatches(bothInspected.modules, applicablePatchesForArchive(bothInspected.asar, shrinkWork)),
      false,
      "Shrinking selected packs must NOT falsely match when co-resident unselected module (usage-rings) is still installed"
    );

    // Real Linux plan-shrink rebuild via linuxCli.install without providing input
    const shrinkXdg = path.join(tmpRoot, "shrink-xdg");
    const shrinkLinuxPaths = linuxCli.getLinuxPaths({ XDG_DATA_HOME: shrinkXdg }, tmpRoot);
    fs.mkdirSync(path.join(shrinkLinuxPaths.installDirectory, "squashfs-root", "resources"), { recursive: true });
    const shrinkAppAsar = path.join(shrinkLinuxPaths.installDirectory, linuxCli.APP_ASAR);
    fs.copyFileSync(combinedBothOut, shrinkAppAsar);
    fs.copyFileSync(combinedRawPath, shrinkAppAsar + linuxCli.BACKUP_SUFFIX);
    linuxCli.writeLauncherFiles(shrinkLinuxPaths.installDirectory, false, { disableTelemetry: false });
    const origLogShrink = console.log;
    console.log = () => {};
    try {
      linuxCli.install(null, { packs: ["workspace"] }, shrinkLinuxPaths);
    } finally {
      console.log = origLogShrink;
    }
    const shrunkInspect = linuxCli.inspectInstall(shrinkLinuxPaths);
    assert.equal(shrunkInspect.modules.find((m) => m.id === "usage-rings").installed, false, "Plan shrink must remove usage-rings cleanly");
    assert.equal(shrunkInspect.modules.find((m) => m.id === "new-chat-layout").installed, true, "Plan shrink must keep selected workspace patch");

    // Linux repair preserves sub-pack exclusions (--packs workspace --no-desktop-tray) and rolls back app.asar on ENOTDIR theme failure
    const linuxOrigLog2 = console.log;
    console.log = () => {};
    try {
      linuxCli.install(null, { packs: ["workspace"], flags: new Set(["--no-desktop-tray"]) }, shrinkLinuxPaths);
      linuxCli.repair(null, { flags: new Set(["--patch-only"]) }, shrinkLinuxPaths);
      assert.deepEqual(readSavedInstallPlan(shrinkLinuxPaths.profileDirectory).packIds, ["workspace"]);
      fs.truncateSync(shrinkAppAsar, 12);
      linuxCli.repair(null, {}, shrinkLinuxPaths);
    } finally {
      console.log = linuxOrigLog2;
    }
    const linuxAfterRepair = linuxCli.inspectInstall(shrinkLinuxPaths);
    assert.deepEqual(
      linuxAfterRepair.modules.filter((m) => m.installed).map((m) => m.id),
      shrinkWork.filter((p) => p.id !== "desktop-tray").map((p) => p.id),
      "Linux repair must preserve the selected pack and exclusions when app.asar is unreadable"
    );
    const linuxPreFailSha = digest(fs.readFileSync(shrinkAppAsar));
    const linuxBadXdg = path.join(tmpRoot, "shrink-xdg-bad");
    const linuxBadPaths = linuxCli.getLinuxPaths({ XDG_DATA_HOME: linuxBadXdg }, tmpRoot);
    fs.mkdirSync(path.join(linuxBadPaths.installDirectory, "squashfs-root", "resources"), { recursive: true });
    fs.copyFileSync(shrinkAppAsar, path.join(linuxBadPaths.installDirectory, linuxCli.APP_ASAR));
    fs.copyFileSync(combinedRawPath, path.join(linuxBadPaths.installDirectory, linuxCli.APP_ASAR) + linuxCli.BACKUP_SUFFIX);
    linuxCli.writeLauncherFiles(linuxBadPaths.installDirectory, false, { disableTelemetry: false });
    const badSettingsPath = path.join(linuxBadPaths.profileDirectory, "t3-home", "userdata", "settings.json");
    fs.mkdirSync(badSettingsPath, { recursive: true }); // ENOTDIR trigger
    console.log = () => {};
    try {
      assert.throws(() => linuxCli.install(null, { preset: "clean" }, linuxBadPaths), /ENOTDIR|EISDIR|illegal operation/);
    } finally {
      console.log = linuxOrigLog2;
    }
    assert.equal(
      digest(fs.readFileSync(path.join(linuxBadPaths.installDirectory, linuxCli.APP_ASAR))),
      linuxPreFailSha,
      "Linux inplace install must keep original app.asar untouched/rolled back if theme commit fails"
    );

    // C. Isolated Windows Dual-ASAR CLI transaction (install -> corrupt+repair -> byte-identical uninstall)
    if (process.platform === "win32") {
      const cliPath = path.join(__dirname, "..", "cli.cjs");
      const fakeLocalAppData = path.join(tmpRoot, "localappdata");
      const fakeT3Home = path.join(tmpRoot, "t3home");
      const resDir = path.join(fakeLocalAppData, "Programs", "t3code", "resources");
      fs.mkdirSync(resDir, { recursive: true });
      const winServer = path.join(resDir, "server.asar");
      const winApp = path.join(resDir, "app.asar");
      fs.copyFileSync(serverBaseline.path, winServer);
      fs.copyFileSync(desktopBaseline.path, winApp);
      const origServerSha = digest(fs.readFileSync(winServer));
      const origAppSha = digest(fs.readFileSync(winApp));
      const isoEnv = { ...process.env, LOCALAPPDATA: fakeLocalAppData, T3CODE_HOME: fakeT3Home };

      // build subcommand dry-run check
      const { ENHANCER_VERSION, ENHANCER_TAG } = require("../lib/version.cjs");
      const buildTarget = path.join(tmpRoot, "cli-built.asar");
      const buildJson = JSON.parse(execFileSync(process.execPath, [cliPath, "build", buildTarget, "--preset", "clean"], { env: isoEnv, encoding: "utf8" }));
      assert.equal(buildJson.enhancerVersion, ENHANCER_VERSION);
      assert.equal(buildJson.enhancerTag, ENHANCER_TAG);
      assert.equal(buildJson.preset, "clean");
      assert.equal(buildJson.compatibility, "verified");
      assert.equal(buildJson.modules.length, desktopHasServer ? 5 : 4);
      assert(fs.existsSync(buildTarget));

      // install --preset clean (dual-ASAR + theme + backups) -> repair corrupt app.asar -> uninstall --purge-backup
      const origLocal = process.env.LOCALAPPDATA;
      const origT3Home = process.env.T3CODE_HOME;
      const desktopPatches = [noTelemetry.desktopPatch, desktopTray];
      const origLog = console.log;
      try {
        process.env.LOCALAPPDATA = fakeLocalAppData;
        process.env.T3CODE_HOME = fakeT3Home;
        console.log = () => {};

        cmdInstall(new Set(), null, { preset: "clean", assertClosed: () => {} });
        assert.equal(digest(fs.readFileSync(winServer + ".before-t3code-enhancer")), origServerSha);
        assert.equal(digest(fs.readFileSync(winApp + ".before-t3code-enhancer")), origAppSha);
        assert(fs.existsSync(path.join(fakeT3Home, "userdata", "themes", "chatgpt-app.json")));
        assert.equal(inspectArchive(winServer).enhancerVersion, ENHANCER_VERSION);
        const appCleanInspected = inspectArchive(winApp, desktopPatches);
        assert.equal(appCleanInspected.enhancerVersion, ENHANCER_VERSION);
        const appCleanModules = appCleanInspected.modules;
        assert.equal(appCleanModules.find((m) => m.id === "no-telemetry-desktop").installed, true);
        assert.equal(appCleanModules.find((m) => m.id === "desktop-tray").installed, false);
        assert.equal(summarizeModuleStates(appCleanModules).allRecognized, true);

        // simulate corrupt app.asar + stale .tmp file -> repair recovers cleanly from backup while preserving clean preset
        const staleTmp = winApp + ".00000000-0000-0000-0000-000000000000.tmp";
        fs.writeFileSync(staleTmp, "stale");
        const serverBackup = winServer + ".before-t3code-enhancer";
        const staleServerBackup = path.join(tmpRoot, "wrong-version-server.asar");
        const baselineManifest = serverBaseline.asar.byKey.get("package.json");
        const wrongVersion = { ...JSON.parse(readEntryBuffer(serverBaseline.asar, baselineManifest)), version: "0.0.0" };
        writePatchedAsar(serverBaseline.asar, [{ key: "package.json", replacement: Buffer.from(JSON.stringify(wrongVersion)) }], staleServerBackup);
        const healthyServer = fs.readFileSync(winServer);
        const healthyApp = fs.readFileSync(winApp);
        fs.truncateSync(winServer, 12);
        const truncatedServer = fs.readFileSync(winServer);
        fs.copyFileSync(staleServerBackup, serverBackup);
        assert.throws(() => cmdRepair(new Set(), null, { assertClosed: () => {} }), /找不到未修改的原版/);
        assert.throws(() => cmdUninstall(new Set(), null, { assertClosed: () => {} }), /找不到未修改的原版/);
        assert(fs.readFileSync(winServer).equals(truncatedServer), "Rejected old backups must leave the failed archive untouched");
        assert(fs.readFileSync(winApp).equals(healthyApp), "Rejected old backups must leave the healthy sibling untouched");
        fs.copyFileSync(serverBaseline.path, serverBackup);
        fs.writeFileSync(winServer, healthyServer);
        fs.truncateSync(winApp, 12);
        cmdRepair(new Set(), null, { assertClosed: () => {} });
        assert(!fs.existsSync(staleTmp), "repair must clean up stale UUID .tmp staging files");
        const repairedAppModules = inspectArchive(winApp, desktopPatches).modules;
        assert.equal(repairedAppModules.find((m) => m.id === "no-telemetry-desktop").installed, true);
        assert.equal(repairedAppModules.find((m) => m.id === "desktop-tray").installed, false);

        // Corrupt 1 byte inside an ASAR payload entry (header still valid, ERR_ASAR_INTEGRITY) -> repair still recovers from same-version backup
        const corruptEntryRec = findPatchTarget(readAsar(winServer), noTelemetry);
        const hdrLen = readAsar(winServer).archive.readUInt32LE(4) + 8;
        const absByteOffset = hdrLen + Number(corruptEntryRec.entry.offset) + 8;
        const winServerBytes = fs.readFileSync(winServer);
        winServerBytes[absByteOffset] = winServerBytes[absByteOffset] ^ 0xff;
        fs.writeFileSync(winServer, winServerBytes);
        cmdRepair(new Set(), null, { assertClosed: () => {} });
        assert.equal(
          inspectArchive(winServer).modules.find((m) => m.id === "no-telemetry").installed,
          true,
          "repair must recover from same-version backup when target script fails integrity check"
        );

        // uninstall --purge-backup restores byte-for-byte original SHA-256 on both ASARs
        cmdUninstall(new Set(["--purge-backup"]), null, { assertClosed: () => {} });
        assert.equal(digest(fs.readFileSync(winServer)), origServerSha);
        assert.equal(digest(fs.readFileSync(winApp)), origAppSha);
        assert(!fs.existsSync(winServer + ".before-t3code-enhancer"));
        assert(!fs.existsSync(winApp + ".before-t3code-enhancer"));

        // Sub-pack exclusion preservation: install --packs workspace --no-desktop-tray -> bare repair keeps desktop-tray off;
        // and when shrinking from workspace (with backup) to --no-desktop-tray then corrupting app.asar, surviving server buildMeta.plan preserves exclusion
        cmdInstall(new Set(["--no-desktop-tray"]), null, { packs: ["workspace"], assertClosed: () => {} });
        assert.equal(inspectArchive(winApp, desktopPatches).modules.find((m) => m.id === "desktop-tray").installed, false);
        assert.equal(inspectArchive(winServer).modules.find((m) => m.id === "new-chat-layout").installed, true);
        cmdRepair(new Set(), null, { assertClosed: () => {} });
        assert.equal(inspectArchive(winApp, desktopPatches).modules.find((m) => m.id === "desktop-tray").installed, false, "Bare repair must preserve --no-desktop-tray exclusion");

        cmdInstall(new Set(), null, { packs: ["workspace"], assertClosed: () => {} });
        assert.equal(inspectArchive(winApp, desktopPatches).modules.find((m) => m.id === "desktop-tray").installed, true);
        cmdInstall(new Set(["--no-desktop-tray"]), null, { packs: ["workspace"], assertClosed: () => {} });
        assert.equal(inspectArchive(winApp, desktopPatches).modules.find((m) => m.id === "desktop-tray").installed, false);
        fs.truncateSync(winApp, 12);
        cmdRepair(new Set(), null, { assertClosed: () => {} });
        assert.equal(inspectArchive(winApp, desktopPatches).modules.find((m) => m.id === "desktop-tray").installed, false, "Bare repair with corrupt winApp must still read surviving winServer buildMeta.plan and exclude desktop-tray");
        cmdUninstall(new Set(["--purge-backup"]), null, { assertClosed: () => {} });
        assert.equal(readSavedInstallPlan(path.join(fakeT3Home, "userdata")), null, "uninstall must clear persisted install plan");

        // Overwrite-upgrade regression:
        // 1) Install custom plan (--packs theme,privacy,composer) -> persists .t3code-enhancer-plan.json
        // 2) Simulate official T3 Code overwrite-upgrade (pristine server.asar & app.asar replace patched ones)
        // 3) Bare `repair` must restore the full saved plan (not degrade to theme-only)
        // 4) Simulate legacy patched archive (LEGACY_MARKERS) -> direct `install` upgrades cleanly from backup
        const userdataPath = path.join(fakeT3Home, "userdata");
        cmdInstall(new Set(), null, { packs: ["theme", "privacy", "composer"], assertClosed: () => {} });
        const savedPlan = readSavedInstallPlan(userdataPath);
        assert(savedPlan && Array.isArray(savedPlan.packIds), "install must persist .t3code-enhancer-plan.json");
        assert.deepEqual([...savedPlan.packIds].sort(), ["composer", "privacy", "theme"]);
        assert(fs.existsSync(getSavedPlanPath(userdataPath)));
        const savedPlanBytes = fs.readFileSync(getSavedPlanPath(userdataPath));
        cmdInstall(new Set(["--theme-only"]), null);
        cmdRepair(new Set(["--theme-only", "--official"]), null);
        assert(fs.readFileSync(getSavedPlanPath(userdataPath)).equals(savedPlanBytes), "Theme-only commands must preserve the module recovery plan");

        // Simulate official overwrite-upgrade: both ASARs revert to pristine upstream binaries
        fs.copyFileSync(serverBaseline.path, winServer);
        fs.copyFileSync(desktopBaseline.path, winApp);
        cmdRepair(new Set(), null, { assertClosed: () => {} });
        const afterOverwriteServer = inspectArchive(winServer).modules;
        const afterOverwriteApp = inspectArchive(winApp, desktopPatches).modules;
        assert.equal(afterOverwriteServer.find((m) => m.id === "no-telemetry").installed, true, "Bare repair after native overwrite-upgrade must restore privacy");
        assert.equal(afterOverwriteServer.find((m) => m.id === "usage-rings").installed, true, "Bare repair after native overwrite-upgrade must restore composer");
        assert.equal(afterOverwriteServer.find((m) => m.id === "new-chat-layout").installed, false, "Bare repair must NOT add unselected workspace pack");
        assert.equal(afterOverwriteApp.find((m) => m.id === "no-telemetry-desktop").installed, true, "Bare repair must restore desktop privacy patch");
        assert.equal(afterOverwriteApp.find((m) => m.id === "desktop-tray").installed, false, "Bare repair must keep unselected desktop-tray off");
        const settingsPath = path.join(userdataPath, "settings.json");
        const settingsBeforePatchRepair = fs.readFileSync(settingsPath);
        cmdRepair(new Set(["--patch-only"]), null, { assertClosed: () => {} });
        for (const [archive, before] of [[winServer, afterOverwriteServer], [winApp, afterOverwriteApp]]) {
          const installedIds = (modules) => modules.filter((m) => m.installed).map((m) => m.id);
          assert.deepEqual(installedIds(inspectArchive(archive).modules), installedIds(before), "--patch-only must preserve the selected modules");
        }
        assert(fs.readFileSync(settingsPath).equals(settingsBeforePatchRepair), "--patch-only must preserve theme settings");

        // Simulate legacy enhancer version already installed (marker downgraded to LEGACY_MARKERS) -> direct install overwrites cleanly
        const legacyServerPath = path.join(tmpRoot, "legacy-server.asar");
        const curServerAsar = readAsar(winServer);
        const urEntry = findPatchTarget(curServerAsar, usageRings);
        const urText = urEntry.content.toString("utf8");
        const legacyMarker = usageRings.legacyMarkers[usageRings.legacyMarkers.length - 1];
        assert(legacyMarker && urText.includes(usageRings.marker), "Expected active usage-rings marker for legacy upgrade test");
        writePatchedAsar(
          curServerAsar,
          [{ key: urEntry.key, replacement: Buffer.from(urText.replaceAll(usageRings.marker, legacyMarker), "utf8") }],
          legacyServerPath
        );
        fs.copyFileSync(legacyServerPath, winServer);
        assert.equal(inspectArchive(winServer).modules.find((m) => m.id === "usage-rings").outdated, true, "Legacy marker must be classified as outdated");
        cmdInstall(new Set(), null, { packs: ["theme", "privacy", "composer"], assertClosed: () => {} });
        assert.equal(inspectArchive(winServer).modules.find((m) => m.id === "usage-rings").installed, true, "Direct install over legacy patch must upgrade to latest marker cleanly");
        cmdUninstall(new Set(["--purge-backup"]), null, { assertClosed: () => {} });
        assert(!fs.existsSync(getSavedPlanPath(userdataPath)), "uninstall must delete .t3code-enhancer-plan.json");

        // Theme ENOTDIR/EISDIR pre-commit failure AND post-rename mid-commit failure must BOTH leave winServer & winApp at orig SHA-256
        const userdataDir = path.join(fakeT3Home, "userdata");
        const blockingSettings = path.join(userdataDir, "settings.json");
        fs.rmSync(blockingSettings, { recursive: true, force: true });
        fs.mkdirSync(blockingSettings, { recursive: true });
        assert.throws(() => cmdInstall(new Set(), null, { preset: "clean", assertClosed: () => {} }), /EISDIR|ENOTDIR|illegal operation/);
        assert.equal(digest(fs.readFileSync(winServer)), origServerSha, "Theme EISDIR pre-commit failure must keep server.asar unchanged");
        assert.equal(digest(fs.readFileSync(winApp)), origAppSha, "Theme EISDIR pre-commit failure must keep app.asar unchanged");
        fs.rmSync(userdataDir, { recursive: true, force: true });
        fs.writeFileSync(userdataDir, "not-a-directory");
        assert.throws(() => cmdInstall(new Set(), null, { preset: "clean", assertClosed: () => {} }), /ENOTDIR|EEXIST/);
        assert.equal(digest(fs.readFileSync(winServer)), origServerSha, "Theme ENOTDIR pre-commit failure must keep server.asar unchanged");
        assert.equal(digest(fs.readFileSync(winApp)), origAppSha, "Theme ENOTDIR pre-commit failure must keep app.asar unchanged");
        fs.rmSync(userdataDir, { recursive: true, force: true });

        assert.throws(
          () => runAsarTransaction(
            [{ source: winServer, backup: winServer + ".bak" }, { source: winApp, backup: winApp + ".bak" }],
            (_paths, staging) => fs.writeFileSync(staging, Buffer.from("mutated-staging")),
            {
              assertClosed: () => {},
              afterCommit: () => {
                const err = new Error("ENOTDIR simulated mid-commit failure");
                err.code = "ENOTDIR";
                throw err;
              },
            }
          ),
          /ENOTDIR simulated mid-commit failure/
        );
        assert.equal(digest(fs.readFileSync(winServer)), origServerSha, "Post-rename afterCommit failure must roll back server.asar byte-for-byte");
        assert.equal(digest(fs.readFileSync(winApp)), origAppSha, "Post-rename afterCommit failure must roll back app.asar byte-for-byte");

        if (!desktopHasServer) {
          // Explicit single-file --asar on server-only ASAR prints skipped desktop patches notice
          let singleAsarLog = "";
          console.log = (...args) => { singleAsarLog += args.join(" ") + "\n"; };
          cmdInstall(new Set(), winServer, { preset: "privacy-only", assertClosed: () => {} });
          console.log = () => {};
          assert(singleAsarLog.includes("no-telemetry-desktop"), "Single-file --asar install must warn about skipped desktop patch");
          cmdUninstall(new Set(["--purge-backup"]), winServer, { assertClosed: () => {} });
          assert.equal(digest(fs.readFileSync(winServer)), origServerSha);
        }
      } finally {
        console.log = origLog;
        if (origLocal === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = origLocal;
        if (origT3Home === undefined) delete process.env.T3CODE_HOME;
        else process.env.T3CODE_HOME = origT3Home;
      }
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

console.log("\nALL TESTS PASSED.");

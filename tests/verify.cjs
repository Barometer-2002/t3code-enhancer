"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { runInNewContext } = require("node:vm");

const { readAsar, findUniqueEntry } = require("../lib/asar.cjs");
const { ALL_PATCHES, selectPatches, applicablePatchesForArchive, inspectArchive, summarizeModuleStates, resolvePristineBaseline, buildPatchedArchive, getLinuxAsarCandidates, isLinuxAppRunning, parseCliArgs } = require("../cli.cjs");
const { PACKS, PRESETS, resolveInstallPlan } = require("../lib/packs.cjs");
const { withInstallDirectoryLock } = require("../lib/install-state.cjs");
const { inspectCompatibleSource } = require("../lib/engine.cjs");
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
const { workspaceFloatFrame, workspaceSnapFrame, defaultChatFloatFrame, chatPillFrame, placeSurfaceFloat } = workspaceFloatingPanels;
const { SOURCE_THEME_PATH, extractOfficialTheme } = require("../lib/theme-manager.cjs");

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
assert.equal(grouped.length, 5);
assert.equal(grouped[0].type, "single");
assert.equal(grouped[0].entry.id, "t0");
assert.equal(grouped[1].type, "file-group");
assert.equal(grouped[1].kind, "read");
assert.equal(grouped[1].filePath, "src/a.ts");
assert.deepEqual(grouped[1].entries.map((x) => x.id), ["r1", "r3", "r4"]);
assert.equal(grouped[2].type, "single");
assert.equal(grouped[2].entry.id, "r2");
assert.equal(grouped[3].type, "file-group");
assert.equal(grouped[3].kind, "edit");
assert.deepEqual(grouped[3].entries.map((x) => x.id), ["e1", "e2"]);
assert.equal(grouped[4].type, "single");
assert.equal(grouped[4].entry.id, "e3");
assert.equal(timelineCollapse.t3FormatReadRanges(grouped[1].entries), "L1-100, L101-200 +1");
assert.deepEqual(timelineCollapse.t3AggregateEditStats([
  { additions: 3, diffStr: "--- a/f\n+++ b/f\n@@ -1 +1 @@\n---removed text\n+++added text" },
]), { additions: 3, deletions: 1 });
assert.equal(timelineCollapse.t3AggregateEditStats([{ oldStr: "full file", newStr: "updated file" }]), null);
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
const explicitModel = "claude-opus-ultra";
assert.equal(usageRings.t3SelectPrimaryQuotaForModel([
  { kind: "single", key: "heuristic", title: "Claude Opus Ultra", window: {} },
  { kind: "single", key: "authoritative", title: "Other", window: { modelIds: [explicitModel] } },
], explicitModel).key, "authoritative");
console.log("   OK");

console.log("3.5. Unit testing inline-file-diff unified diff parser...");
const parsedDiff = inlineFileDiff.t3ParseUnifiedDiff(
  "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -2,3 +2,4 @@\n ctx\n-old1\n+new1\n+new2\n end\n"
);
assert.equal(parsedDiff.additions, 2);
assert.equal(parsedDiff.deletions, 1);
assert.equal(parsedDiff.rows.length, 5);
assert.equal(parsedDiff.rows[1].kind, "del");
assert.equal(parsedDiff.rows[1].lineNo, "3");
assert.equal(parsedDiff.rows[2].kind, "add");
assert.equal(parsedDiff.rows[2].lineNo, "3");
assert.equal(parsedDiff.rows[3].lineNo, "4");
const fallbackDiff = inlineFileDiff.t3ParseUnifiedDiff("", "a\nb", "a\nc\nd");
assert.equal(fallbackDiff.deletions, 2);
assert.equal(fallbackDiff.additions, 3);
const trailingNewlineDiff = inlineFileDiff.t3ParseUnifiedDiff("", "a\nb\n", "a\nc\nd\n");
assert.equal(trailingNewlineDiff.deletions, 2);
assert.equal(trailingNewlineDiff.additions, 3);
assert.equal(filesChangesExplorer.t3NormalizeRelPath(".\\src\\index.ts"), "src/index.ts");
assert.equal(filesChangesExplorer.t3NormalizeRelPath("/foo/bar.js"), "foo/bar.js");
const feTree = filesChangesExplorer.t3BuildChangedFileTree([
  { path: "./a/b/c.txt", insertions: 3, deletions: 0 },
  { path: "a/b/c.txt", insertions: 3, deletions: 0 },
  { path: "ignored-dir/", insertions: 0, deletions: 0 },
  { path: "a/d.txt", insertions: 1, deletions: 1 },
  { path: "root.md", insertions: 2, deletions: 0 },
], "");
assert.equal(feTree.length, 2);
assert.equal(feTree[0].kind, "dir");
assert.equal(feTree[0].name, "a");
assert.equal(feTree[0].children[0].kind, "dir");
assert.equal(feTree[0].children[0].name, "b");
assert.equal(feTree[0].children[0].children[0].path, "a/b/c.txt");
assert.equal(feTree[1].kind, "file");
assert.equal(feTree[1].name, "root.md");
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
const nextFrame = placeSurfaceFloat(roomy, [openFrame], false);
assert(nextFrame.x + nextFrame.width <= openFrame.x, "The next window should use the empty left side");
assert.equal(placeSurfaceFloat(floatBounds, [], true, { x: 10, y: 10 }).x, 8);
assert.equal(workspaceFloatingPanels.marker, "T3_WORKSPACE_FLOATING_PANELS_V22");
console.log("   OK");

function verifyFloatingPanelPortal(asar) {
  const chunk = findUniqueEntry(asar, workspaceFloatingPanels.targetRegex, workspaceFloatingPanels.id);
  const source = chunk.content.toString("utf8");
  const reactDomImport = source.match(/import\{[^}]*\bas Mc\b[^}]*\}from"(\.\/react-dom-[\w-]+\.js)"/);
  const surfaceEqHelpers = source.match(/^function t3ShallowObjEqual\([\s\S]+?^function t3SurfaceMountPropsEqual\([\s\S]+?^\}/m);
  const surfaceMount = source.match(/^const T3SurfaceMount = Z\.memo\([\s\S]+?^\}, t3SurfaceMountPropsEqual\);/m);
  assert(reactDomImport && surfaceEqHelpers && surfaceMount, "Missing native React DOM binding or injected surface mount");

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
    copyModule(path.posix.basename(reactDomImport[1]));
    writeFile("package.json", '{"type":"module"}');
    writeFile("portal.mjs", [
      'import assert from "node:assert/strict";',
      reactDomImport[0] + ";",
      'const Z = { memo: (render) => render, useState: (init) => [init()], useLayoutEffect: () => {}, useMemo: (fn) => fn() };',
      'const host = { nodeType: 1 };',
      'const document = { createElement: () => host };',
      'const gM = () => null;',
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
      jn: "Tooltip",
      an: "TooltipTrigger",
      Zt: "TooltipPopup",
      $: { jsx, jsxs: jsx },
    }
  );
  const controls = { kind: "conversation" };
  const toggle = { kind: "workspace" };
  const maximize = { kind: "maximize" };
  assert.equal(T3ChatToolbar({ controls }).props.children.filter(Boolean).length, 1);
  assert(source.includes("showRightPanelControl:!ka"), "Right panel toggle must join chat header toolbar when panel is closed");
  assert(!source.includes("data-t3e-fixed-actions"), "Top-right fixed actions overlay should be removed");
  const dividerSwap = T3DividerSwapButton();
  assert.equal(dividerSwap.type, "Tooltip");
  assert.equal(dividerSwap.props.children[1].props.side, "left");
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
  assert.match(source, /\.t3e-divider-swap-btn \{[\s\S]*opacity: 0; pointer-events: none;/, "Divider swap button must stay hidden until divider hover");
  assert.match(source, /\[data-preview-panel-mode=\\?"inline\\?"\] > \[role=\\?"separator\\?"\]:hover:not\(:active\) ~ \.t3e-divider-swap-btn[\s\S]*opacity: 1; pointer-events: auto;/, "Hovering vertical separator must reveal swap button");
  const plc = findUniqueEntry(asar, patch.tabBarPatch.targetRegex, patch.tabBarPatch.id).content.toString("utf8");
  assert(plc.includes("children:[W,e.enhancerDividerSlot,ie]"), "Panel divider must host enhancerDividerSlot");
  const pwMatch = source.match(/function pW\(e\)\{[\s\S]+?\}(?=function mW\()/);
  const ecMatch = plc.match(/function Ec\(e\)\{[\s\S]+?\}(?=function Dc\()/);
  const kcMatch = plc.match(/function kc\(e\)\{[\s\S]+?\}(?=function Ac\()/);
  const hhMatch = plc.match(/function Hh\(e\)\{[\s\S]+?\}(?=function Uh\()/);
  assert(pwMatch && ecMatch && kcMatch && hhMatch, "Missing pW/Hh/Ec/kc in patched bundle");
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
    `${ecMatch[0]}\n${kcMatch[0]}\n${hhMatch[0]}\n${pwMatch[0]}\n({ pW, Hh, Ec, kc })`,
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
      V: () => (s) => s,
      z: () => (s) => s,
      a: (s) => s,
      J: (...args) => args.filter(Boolean).join(" "),
      Ia: () => ({ profiles: [] }),
      Cr: () => ({ resolvedTheme: "light" }),
      Ta: () => {},
      Sn: (fn) => fn,
      xa: () => ({}),
      Bo: () => {},
      Do: () => {},
      jo: () => {},
      Th: () => "Changes",
      mh: () => null,
      Oh: () => ({ url: "", capturedUrl: "" }),
      gh: () => null,
      zh: "SurfaceTab",
      Da: "Da",
      Oa: "--panel-width",
      ai: (u) => {
        capturedResizeEdge = u.edge;
        return { width: 420, handlers: {}, observeRow: () => () => {} };
      },
      si: (props) => {
        currentComponent = "Hh";
        return HhTree.Hh(props);
      },
      Ec: (props) => {
        currentComponent = "Ec";
        return HhTree.Ec(props);
      },
      _a: "ScrollArea",
      Ih: "TabStrip",
      K: "Tooltip",
      G: "TooltipTrigger",
      M: "Button",
      ze: "ChevronLeft",
      U: "TooltipPopup",
      x: "Kbd",
      me: "ChevronRight",
      T3NewTabStripControl: "NewTabStrip",
      T3ChatGptSurfaceLauncher: "Launcher",
      Se: "B", ct: "T", De: "F", Xe: "D", la: { pullRequest: "P", link: "L" }, st: "M", Oo: "S",
      ch: {}, lh: "", dh: 2, te: true,
    }
  );
  // Intercept Hh's local `let pe = Ec` call cleanly via renderComponentTree
  const renderComponentTree = (node) => {
    let cur = node;
    while (cur && typeof cur.type === "function") {
      currentComponent = cur.type.name || "anon";
      cur = cur.type(cur.props);
    }
    return cur;
  };
  const renderInlinePanel = (enhancerDividerSlot, enhancerResizeEdge = "right") => renderComponentTree((() => {
    currentComponent = "pW";
    return HhTree.pW({
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
  assert.equal(firstRender.props.children[1], slotSentinel, "pW -> Hh -> Ec -> kc must preserve enhancerDividerSlot on inline divider");
  const secondRender = renderInlinePanel(null, "left");
  assert.equal(capturedResizeEdge, "left");
  assert.equal(secondRender.props.children[1], null, "Memo cache invalidation in Hh/kc must hide divider slot when enhancerDividerSlot becomes null");
  const thirdRender = renderInlinePanel(slotSentinel, "left");
  assert.equal(thirdRender.props.children[1], slotSentinel, "Memo cache invalidation in Hh/kc must restore divider slot when reopened");

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
  const shellCtx = { fullscreen: true, chatSelected: true, windows: [], bounds: { width: 1200, height: 800 }, deckTop: 0, chatMinimized: false, labels: {} };
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
  shellCtx.chatFloat = { id: "__t3e_main_chat__", frame: { x: 700, y: 200, width: 432, height: 580 } };
  shellCtx.windows = [shellCtx.chatFloat];
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
  const patch = workspaceFloatingPanels;
  const source = findUniqueEntry(asar, patch.targetRegex, patch.id).content.toString("utf8");
  const nativeSurface = source.match(/function _D\(e\)\{[\s\S]+?(?=function vD\()/);
  const syncPreview = source.match(/^function t3SyncNativePreview\(container\) \{[\s\S]+?^\}/m);
  assert(nativeSurface && syncPreview, "Missing preview position sync in patched archive");
  const reports = [];
  const fits = [];
  const window = new EventTarget();
  const [render, sync] = runInNewContext(nativeSurface[0] + "\n" + syncPreview[0] + "\n[_D, t3SyncNativePreview]", {
    Q: { c: (size) => Array(size).fill(Symbol.for("react.memo_cache_sentinel")) },
    Z: { useRef: (value) => ({ current: value }), useLayoutEffect() {} },
    $: { jsx: (_type, props) => props },
    Wv: (_tabId, fit) => {
      fits.push(fit);
      return { present: (rect, visible, cornerRadius, zIndex) => (reports.push({ rect, visible, cornerRadius, zIndex }), true), release() {} };
    },
    Am: () => () => {},
    t3BrowserLayoutMode: workspaceFloatingPanels.t3BrowserLayoutMode,
    document: { querySelectorAll: () => [] },
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
  cleanup();
  sync(frame);
  assert.equal(reports.length, 5);
  assert.equal(workspaceFloatingPanels.t3BrowserLayoutMode(viewport, true), true);
}

function verifyResponsiveBrowserLayout(asar) {
  const patch = workspaceFloatingPanels.responsivePreviewPatch;
  const main = findUniqueEntry(asar, patch.targetRegex, patch.id).content.toString("utf8");
  const store = main.match(/sD=Zn\(\)\(e=>\(\{activityByTabId:[\s\S]+?(?=var uD=)/);
  const layoutMode = main.match(/const T3ResponsiveViewport=[^;]+;/);
  const layoutSelector = main.match(/C=e=>\{let t=e\.byTabId\[i\];return\{[^}]+\}\}/);
  const layoutOverride = main.match(/if\(w\.responsive\)o=T3ResponsiveViewport;/);
  assert(store && layoutMode && layoutSelector && layoutOverride, "Missing responsive browser viewport wiring");
  const defaults = findUniqueEntry(asar, /\/browserDefaults-[\w-]+\.js$/, "browser layout").content.toString("utf8");
  const layout = defaults.match(/function Z\(e,t,n=1\)\{[\s\S]+?(?=function Je\()/);
  assert(layout, "Missing native browser viewport calculation");
  const { claim, state, viewportFor, size } = runInNewContext(
    "let " + store[0] + "\n" + layoutMode[0] + "\n" + layout[0] + `
    ({
      claim: lD,
      state: sD.getState,
      viewportFor(i, o) {
        let C;
        ${layoutSelector[0]};
        const w = C(sD.getState());
        ${layoutOverride[0]}
        return o;
      },
      size: Z
    })`, {
      Zn: () => (init) => {
        let state = init((update) => { state = { ...state, ...update(state) }; });
        return { getState: () => state };
      },
      aD: (tabs, tab) => tabs[tab]?.rect ?? null,
      Y: (zoom) => zoom,
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
  const detailHook = code.match(/function t_\(e,t,n,r\)\{[\s\S]+?(?=function n_\()/);
  const card = code.match(/^function T3InlineFileDiffCard\([\s\S]+?^\}/m);
  const checkpointHelpers = code.match(/^function t3CheckpointPath\([\s\S]+?(?=^function t3EnsureDiffStyles)/m);
  assert(detailHook && card && checkpointHelpers, "Missing timeline detail hook or inline file diff card");
  assert.match(code, /&&j&&\(F\|\|R\|\|n\.projectedItem&&L===void 0\)\?[^;]*?\(o_,\{/);
  assert.match(code, /wd\(i\|\|s\.pending,e\.onInitialOutputReady\);if\(o\.type===`file_change`\)return\(0,\$\.jsx\)\(T3InlineFileDiffCardMemo/);

  const summary = { type: "file_change", fileName: "README.md", updatedAt: "r1" };
  const projected = { sourceThreadId: "source-thread", sourceItemId: "edit-1", item: summary };
  const customDetailSource = () => {};
  const memo = Array(29).fill(Symbol.for("react.memo_cache_sentinel"));
  let reply = { isPending: true };
  let request;
  let checkpointRequest;
  let checkpointReply = {};
  let source;
  let uuidSeq = 0;
  const jsx = (type, props) => ({ type, props });
  const { t_, T3InlineFileDiffCard } = runInNewContext(
    detailHook[0] + "\n" + checkpointHelpers[0] + "\n" + card[0] + "\n({ t_, T3InlineFileDiffCard })", {
      Q: { c: () => memo },
      J: () => (text) => text,
      Fa: () => false,
      Ua: (item) => item.updatedAt,
      wa: (key, customSource) => { request = key; source = customSource; return reply; },
      Wa: () => null,
      Ha: () => [],
      Z: {
        useState: (init) => [init, () => {}],
        useRef: (init) => ({ current: init }),
        useEffect: () => {},
        useMemo: (create) => create(),
      },
      $: { jsx, jsxs: jsx },
      crypto: { randomUUID: () => `rev-${++uuidSeq}` },
      Xr: (path) => path,
      t3IsZhLocale: () => false,
      t3ShortFileName: (path) => path,
      t3ParseUnifiedDiff: inlineFileDiff.t3ParseUnifiedDiff,
      T3UseCheckpointSummaries: (ref) => ref ? [{ runId: "turn-9", checkpointTurnCount: 9 }] : [],
      T3UseCheckpointDiff: (input, options) => {
        checkpointRequest = options.enabled ? input : null;
        return options.enabled ? checkpointReply : {};
      },
      T3ParseCheckpointDiff: (patch) => ({
        kind: "files", files: [{ name: /^\+\+\+ b\/(.*)$/m.exec(patch)?.[1] }]
      }),
      T3DiffCopyIcon: () => null,
      T3DiffSideIcon: () => null,
      io: String,
    }
  );
  let sideRequest;
  const cardTree = () => {
    const result = t_(projected, "env", { detail: customDetailSource }, false);
    return T3InlineFileDiffCard({
      item: result.item, projectedItem: projected, detail: result.output, workspaceRoot: "C:\\Work\\project",
      onOpenToolDiff: (request) => { sideRequest = request; },
    });
  };
  const render = () => JSON.stringify(cardTree());
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
  assert.match(recovered, /Turn Git diff/);
  assert.match(recovered, /is-add.*RECOVERED/);
  assert.doesNotMatch(recovered, /UNRELATED/);
  assert.equal(cardTree().props.children[0].props.children[0].props.children[0].props.onClick({}), undefined);
  assert.equal(sideRequest.filePath, "README.md");
  projected.item = { ...projected.item, runId: "turn-with-no-checkpoint" };
  reply = { isPending: false, data: { item: projected.item } };
  assert.doesNotMatch(render(), /RECOVERED/);
  assert.equal(checkpointRequest, null);

  // Verify DiffPanel sideRevealPatch for single-file, multi-file, and blank tool-call -> turn/unstaged fallback
  const diffPanel = findUniqueEntry(asar, inlineFileDiff.sideRevealPatch.targetRegex, inlineFileDiff.id + "-side").content.toString("utf8");
  const helpersMatch = diffPanel.match(/function t3NormDiffPath[\s\S]+?function t3PickToolDiffFallback\([\s\S]+?\n(?=\s*export\{)/);
  const revealMatch = diffPanel.match(
    /\/\* T3_INLINE_FILE_DIFF_SIDE_REVEAL_V\d+ \*\/let t3RawZ=z,t3Fb=[\s\S]+?;[\s\S]*?(Fn=t3RawZ\?\.revealRequestId[\s\S]+?,In=t3RawZ\?\.revealRequestId\?\?\([^)]+\)),[\s\S]*?(li=e=>\{[^}]+\}),t\[76\][\s\S]*?(let path=\(\(\)=>\{[\s\S]+?\}\)\(\);if\(!path\)\{Mi\.current=null;return\}let e=JSON\.stringify\(\[K,path,In\]\);Mi\.current!==e&&ji\(path\)&&\(Mi\.current=e\))/
  );
  assert(helpersMatch && revealMatch, "Missing updated DiffPanel sideRevealPatch injection");
  const fallbackFns = runInNewContext(
    `(function(Ut, it, M) {
      ${helpersMatch[0]}
      return { t3NormDiffPath, t3DiffMatchesTarget, t3PatchHasFile, t3PickToolDiffFallback };
    })`,
    {}
  )(
    (cn) => ({ patch: cn.diffStr, truncated: Boolean(cn.truncated) }),
    (patch) => {
      if (!patch || !patch.includes("diff --git")) return null;
      const files = [...patch.matchAll(/diff --git a\/([^\s]+) b\/([^\s]+)/g)].map((m) => ({ name: m[2] }));
      return files.length ? { kind: "files", files } : { kind: "raw" };
    },
    (fd) => fd.name
  );
  assert.equal(fallbackFns.t3DiffMatchesTarget("nested/src/app.ts", "src/app.ts", "/repo"), false);
  assert.equal(fallbackFns.t3DiffMatchesTarget("src/App.ts", "src/app.ts", "/repo"), false);
  assert.equal(fallbackFns.t3DiffMatchesTarget("src/App.ts", "src/app.ts", "C:\\repo"), true);
  assert.equal(fallbackFns.t3DiffMatchesTarget("/repo/src/app.ts", "src/app.ts", "/repo"), true);
  const emptyTool = { type: "file_change", runId: "run-5", changes: [{ path: "src/app.ts", operation: "modify" }], oldStr: "a", newStr: "b" };
  const turnFb = fallbackFns.t3PickToolDiffFallback({
    rawZ: { kind: "tool-call", filePath: "src\\app.ts", revealRequestId: "r1" },
    sn: { isPending: false },
    cn: emptyTool,
    I: "/repo",
    ln: true,
    P: true,
    N: { environmentId: "env-1" },
    V: [{ runId: "run-5", checkpointTurnCount: 2 }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(turnFb)), { mode: "turn", turn: { runId: "run-5", checkpointTurnCount: 2 }, turnId: "run-5", canUnstaged: true });
  const unstagedFb = fallbackFns.t3PickToolDiffFallback({
    rawZ: { kind: "tool-call", filePath: "src/app.ts", turnId: "run-live", preferGitFallback: true, revealRequestId: "r2" },
    sn: { isPending: true },
    cn: undefined,
    I: "/repo",
    ln: true,
    P: true,
    N: { environmentId: "env-1" },
    V: [{ runId: "run-4", checkpointTurnCount: 1 }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(unstagedFb)), { mode: "unstaged", turn: null, turnId: null, canUnstaged: true });
  const validToolFb = fallbackFns.t3PickToolDiffFallback({
    rawZ: { kind: "tool-call", filePath: "src/app.ts", revealRequestId: "r3" },
    sn: { isPending: false },
    cn: { type: "file_change", runId: "run-5", diffStr: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n" },
    I: "/repo",
    ln: true,
    P: true,
    N: { environmentId: "env-1" },
    V: [{ runId: "run-5", checkpointTurnCount: 2 }],
  });
  assert.equal(validToolFb, null, "Tool calls with an intact diffStr must remain in isolated tool-call mode");
  assert.equal(
    fallbackFns.t3PatchHasFile("diff --git a/other.ts b/other.ts\n", "src/app.ts", false, (s) => s),
    false,
    "Turn checkpoint diff lacking the clicked file should allow working-tree unstaged fallback"
  );
  const uncollapsed = [];
  const scrolled = [];
  const revealRunner = runInNewContext(
    `(function(t3RawZ, z, R, k, ai, K, Mi, ji, yt, M, t3GitMode) {
      ${helpersMatch[0]}
      const f = "/repo";
      let ${revealMatch[1]};
      let ${revealMatch[2]};
      ${revealMatch[3]};
      return { Fn, In, path, li };
    })`,
    {}
  );
  const ai = [
    { fileKey: "k1", fileDiff: { name: "src/a.ts" } },
    { fileKey: "k2", fileDiff: { name: "tests/b.test.ts" } },
  ];
  const Mi = { current: null };
  const ji = (e) => {
    const idx = ai.findIndex((item) => item.fileDiff.name === e);
    if (idx < 0) return false;
    uncollapsed.push(ai[idx].fileKey);
    scrolled.push(ai[idx].fileKey);
    return true;
  };
  const dpOut = revealRunner(
    { kind: "tool-call", filePath: "tests\\b.test.ts", revealRequestId: "r-win" },
    null,
    { kind: "tool-call" },
    true,
    ai,
    "scope:1",
    Mi,
    ji,
    (p) => p.endsWith(".test.ts"),
    (fd) => fd.name,
    "turn"
  );
  assert.equal(dpOut.Fn, "tests/b.test.ts");
  assert.equal(dpOut.path, "tests/b.test.ts");
  assert.equal(dpOut.li(ai[1].fileDiff), true, "Revealed test file must not be hidden when diffHideTestFiles is enabled");
  assert.deepEqual(uncollapsed, ["k2"]);
  assert.deepEqual(scrolled, ["k2"]);
  // Single-file fallback even if filePath differs from git diff header name (non-fallback mode)
  const singleOut = revealRunner(
    { kind: "tool-call", filePath: "other-name.ts", revealRequestId: "r-one" },
    { kind: "tool-call" },
    { kind: "tool-call" },
    false,
    [ai[0]],
    "scope:2",
    { current: null },
    ji,
    () => false,
    (fd) => fd.name,
    null
  );
  assert.equal(singleOut.path, "src/a.ts");
  assert.deepEqual(uncollapsed, ["k2", "k1"]);

  // Verify background review.* RPCs (review.getDiffPreview etc.) do not trigger the 15s slow-request warning toast
  const rtCode = findUniqueEntry(asar, inlineFileDiff.quietReviewToastPatch.targetRegex, inlineFileDiff.quietReviewToastPatch.id).content.toString("utf8");
  const filterMatch = rtCode.match(/function b_\(e\)\{\/\* T3_QUIET_REVIEW_SLOW_TOAST_V1 \*\/[^}]+\}/);
  assert(filterMatch, "Missing quietReviewToastPatch filter in runtime bundle");
  const shouldWarnSlow = runInNewContext(
    `${filterMatch[0]}\nb_`,
    { h_: new Set(["server.getUsageSummary"]) }
  );
  assert.equal(shouldWarnSlow("review.getDiffPreview"), false);
  assert.equal(shouldWarnSlow("review.getBranchCommits"), false);
  assert.equal(shouldWarnSlow("pullRequests.list"), false);
  assert.equal(shouldWarnSlow("terminal.open"), true);
}

function verifyLauncherAddress(asar) {
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
    URL, e: () => false,
    a: () => () => class extends Error {},
    i: null, t: fakeSchema, r: fakeSchema, n: fakeSchema, s: null, o: fakeSchema,
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
  assert.match(chat, /Kk\(\{threadRef:r,openPreview:k,url,\.\.\./);
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
  assert.match(chat, /T3ComposerCtxProvider,\{canAttach:go,[^}]*providerInstanceId:Br,/);
  assert.match(chat, /T3RingsCtxProvider,\{providerInstanceId:vs,/);
  assert.match(chat, /\.t3e-slider-fill \{[\s\S]*?z-index: 1;/);
  assert.match(chat, /\.t3e-effort-tick \{[\s\S]*?z-index: 2;/);
  assert.match(chat, /\.t3e-effort-tick\[data-filled="true"\]/);
  assert.match(chat, /\.t3e-slider-thumb \{[\s\S]*?z-index: 3;/);

  const runtimeIdx = chat.indexOf(`/* ${usageRings.marker} */`);
  const controlsStart = chat.indexOf("function T3UnifiedModelControls(", runtimeIdx);
  const controlsEnd = chat.indexOf("\n}\n", controlsStart);
  assert(runtimeIdx >= 0 && controlsStart > runtimeIdx && controlsEnd > controlsStart, "Missing usage-rings runtime module in patched _chat bundle");
  const runtimeCode = chat.slice(runtimeIdx, controlsEnd + 2);
  const jsx = (type, props) => ({ type, props: props || {} });
  let activeRingsCtx = null;
  let activeComposerCtx = null;
  const states = [];
  let stateCursor = 0;
  let openArg = true;
  const memoSlots = [];
  let memoCursor = 0;

  const sandbox = {
    document: { getElementById: () => null, head: { appendChild() {} }, querySelector: () => ({}), createElement: () => ({ style: {}, set textContent(v) {} }) },
    window: { requestAnimationFrame: () => {} },
    navigator: {},
    Z: {
      Fragment: Symbol("Fragment"),
      createContext: (def) => ({ _def: def }),
      useContext: (ctx) => (ctx === sandbox.T3ComposerCtx ? activeComposerCtx : activeRingsCtx),
      useState: (init) => {
        const idx = stateCursor++;
        if (!(idx in states)) states[idx] = typeof init === "function" ? init() : init;
        return [states[idx], (v) => { states[idx] = typeof v === "function" ? v(states[idx]) : v; }];
      },
      useRef: (init) => ({ current: init }),
      useEffect: () => {},
      useMemo: (fn, deps) => {
        const idx = memoCursor++;
        const prev = memoSlots[idx];
        const same = prev && Array.isArray(deps) && prev.deps && deps.length === prev.deps.length && deps.every((d, i) => Object.is(d, prev.deps[i]));
        if (same) return prev.val;
        const val = fn();
        memoSlots[idx] = { deps, val };
        return val;
      },
      useCallback: (fn, deps) => sandbox.Z.useMemo(() => fn, deps),
    },
    $: { jsx, jsxs: jsx },
    U: () => null,
    AU: null, Ip: () => () => "", kt: () => (v) => String(v), zt: () => (v) => v, Ny: () => "2026-11-25T00:00", Ye: () => "en-US",
    TC: () => null,
    U_: (w) => Math.max(0, 100 - (w.usedPercent ?? 0)),
    Y_: () => null, K_: () => null, wC: () => "2h", zp: () => "",
    J_: () => null,
    fr: () => ({ selectDescriptors: [], booleanDescriptors: [], selectValue: () => "high" }),
    rz: () => ({ effort: { kind: "select", descriptor: { id: "reasoning", defaultValue: "medium" } } }),
    nz: () => ({ speedSelect: null, fastToggle: null }),
    Jr: () => [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "max", label: "Max" }],
    Xn: () => true, px: "px", el: "PopoverRoot", Qc: "PopoverTrigger", Zc: "PopoverContent", tp: "Link",
    SH: "Section", jU: "Row", jn: "TipRoot", an: "TipTrig", Zt: "TipContent", za: "PlusIcon",
    qI: () => {},
  };

  runInNewContext(
    runtimeCode + "\nObject.assign(globalThis, { T3RingsCtx, T3ComposerCtx, T3RingsCtxProvider, T3ComposerCtxProvider, T3ComposerPlusMenu, T3EffortSlider, T3ComposerQuotaRing, T3QuotaPopoverCard, T3UnifiedModelControls });",
    sandbox
  );

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
  const rNode1 = sandbox.T3RingsCtxProvider({ providerInstanceId: "p1", providers: emptyArr, sources: emptyArr, contextWindow: null, activeModel: "m1", runs: emptyArr, messages: emptyArr, turnItems: emptyArr, children: "c" });
  memoCursor = 0;
  const rNode2 = sandbox.T3RingsCtxProvider({ providerInstanceId: "p1", providers: emptyArr, sources: emptyArr, contextWindow: null, activeModel: "m1", runs: emptyArr, messages: emptyArr, turnItems: emptyArr, children: "c" });
  assert.equal(rNode1.props.value, rNode2.props.value, "T3RingsCtx value must stay referentially identical across unrelated ChatView renders");
  memoSlots.length = 0;
  stateCursor = 0;
  memoCursor = 0;
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
  activeComposerCtx = { providerInstanceId: "ag-2", activeModel: "claude-opus-4-6-thinking" };
  stateCursor = 0;
  let ringTree = sandbox.T3ComposerQuotaRing();
  assert.match(JSON.stringify(ringTree), /Antigravity2.*40%/);
  const popCard = sandbox.T3QuotaPopoverCard({ limits: providers[1].usageLimits, now: Date.parse("2026-11-25T00:00:00Z"), tFn: (v) => v, fmtFn: (v) => String(v), activeKey: "cg-5h:cg-7d", providerName: "Antigravity2", onClose: () => {} });
  assert.match(JSON.stringify(popCard), /Antigravity2 · Live quota/);
  sandbox.document.documentElement = { lang: "zh-CN" };
  const popCardZh = sandbox.T3QuotaPopoverCard({ limits: providers[1].usageLimits, now: Date.parse("2026-11-25T00:00:00Z"), tFn: (v) => v, fmtFn: (v) => String(v), activeKey: "cg-5h:cg-7d", providerName: "Antigravity2", onClose: () => {} });
  assert.match(JSON.stringify(popCardZh), /Antigravity2 · 实时配额/);
  delete sandbox.document.documentElement;
  activeComposerCtx = { providerInstanceId: "ag-2", activeModel: "gemini-4-hydrogen" };
  stateCursor = 0;
  ringTree = sandbox.T3ComposerQuotaRing();
  assert.match(JSON.stringify(ringTree), /Antigravity2.*95%/);
  activeComposerCtx = { providerInstanceId: "codex-1", activeModel: "gpt-6" };
  stateCursor = 0;
  ringTree = sandbox.T3ComposerQuotaRing();
  assert.match(JSON.stringify(ringTree), /Codex.*90%/);
  activeComposerCtx = { providerInstanceId: "claude-vps", activeModel: "claude-sonnet-4-6" };
  stateCursor = 0;
  assert.equal(sandbox.T3ComposerQuotaRing(), null);

  // 3) T3UnifiedModelControls: switch Harness updates quota bar & model rows, model pick returns to effort without closing
  states.length = 0;
  const openEvents = [];
  const selectedCalls = [];
  const modelOptionsByInstance = new Map([
    ["codex-1", [{ slug: "gpt-6", name: "GPT-6" }]],
    ["ag-2", [{ slug: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }, { slug: "claude-opus-4-6-thinking", name: "Claude Opus 4.6" }]],
    ["claude-vps", [{ slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }]],
  ]);
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
  const switchBtn = findNodes(tree, (n) => n.props && n.props.className === "t3e-effort-switch-btn")[0];
  assert(switchBtn, "Initial view must show effort card with model switch button");
  switchBtn.props.onClick();
  tree = renderControls();
  const agChip = findNodes(tree, (n) => n.props && n.props.className?.includes("t3e-harness-chip") && JSON.stringify(n).includes("Antigravity2"))[0];
  assert(agChip, "Must render Antigravity2 harness chip");
  agChip.props.onClick();
  tree = renderControls();
  const quotaBar = findNodes(tree, (n) => n.props && n.props.className === "t3e-harness-quota")[0];
  assert.equal(quotaBar.props["data-harness-id"], "ag-2");
  assert.match(JSON.stringify(quotaBar), /95%.*40%|40%.*95%/);
  const claudeRow = findNodes(tree, (n) => n.props && String(n.props.className || "").includes("t3e-model-row") && JSON.stringify(n).includes("Claude Opus 4.6"))[0];
  assert.match(JSON.stringify(claudeRow), /40%/);
  claudeRow.props.onClick();
  assert.deepEqual(selectedCalls, [{ inst: "ag-2", slug: "claude-opus-4-6-thinking", opts: { focusComposer: false } }]);
  assert.deepEqual(openEvents, [], "Choosing a model must NOT close the popover");
  tree = renderControls();
  assert(findNodes(tree, (n) => n.props && n.props.className === "t3e-effort-card").length === 1, "Must return to effort view after picking model");
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
    assert.equal(sharedTheme.activated, false);
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
  assert(!rl.includes('enabled: Boolean$2("T3CODE_TELEMETRY_ENABLED").pipe(withDefault(true))'));
  assert(rl.includes('enabled: Boolean$2("T3CODE_TELEMETRY_ENABLED").pipe(withDefault(false))'));
  assert(!rl.includes("upsertAnonymousId.pipe("), "getTelemetryIdentityForHome must not invoke upsertAnonymousId");
  assert(!rl.includes('path.join(homeDirectory, ".claude.json")'), "readProviderLogins must not read .claude.json");
  assert(!rl.includes('path.join(homeDirectory, ".codex", "auth.json")'), "readProviderLogins must not read .codex/auth.json");

  // Run patched Identify + AnalyticsService generator stubs in VM to verify zero side effects
  const idStart = rl.indexOf('const readProviderLogins = fn("TelemetryIdentity.readProviderLogins")');
  const idEnd = rl.indexOf("\nconst getServerOwners = ", idStart);
  const asStart = rl.indexOf("const make$32 = gen$1(function* () {\n\t/* T3_NO_TELEMETRY_V1 */");
  const asEnd = rl.indexOf("\nconst layer$49 = ", asStart);
  assert(idStart >= 0 && idEnd > idStart && asStart >= 0 && asEnd > asStart, "Missing patched telemetry blocks");
  assert(!rl.slice(asStart, asEnd).includes("httpClient.execute"), "AnalyticsService make$32 must not retain sendBatch httpClient execution");
  assert(!rl.slice(asStart, asEnd).includes("posthogHost"), "AnalyticsService make$32 must not reference posthogHost");
  let secretReads = 0;
  const runGen = (g) => {
    const it = g();
    let step = it.next();
    while (!step.done) step = it.next();
    return step.value;
  };
  const telemetrySandbox = {
    fn: () => (genFn) => () => runGen(genFn),
    gen$1: (genFn) => () => runGen(genFn),
    none$1: () => ({ _tag: "None" }),
    flatMap: () => () => [],
    HomeDirectory: "HOME",
    void_: { _tag: "Void" },
    AnalyticsService: { of: (impl) => impl },
    ServerSecretStore: { get: () => { secretReads++; return []; } },
  };
  runInNewContext(
    rl.slice(idStart, idEnd) + "\n" + rl.slice(asStart, asEnd) + "\nObject.assign(globalThis, { readProviderLogins, getTelemetryIdentityForHome, getServerOwnersForHome, make$32 });",
    telemetrySandbox
  );
  assert.equal(JSON.stringify(telemetrySandbox.readProviderLogins()), JSON.stringify({ codexTokens: { _tag: "None" }, claudeJson: { _tag: "None" } }));
  assert.equal(JSON.stringify(telemetrySandbox.getTelemetryIdentityForHome()), JSON.stringify({ distinctId: null, installId: null }));
  assert.equal(JSON.stringify(telemetrySandbox.getServerOwnersForHome()), "[]");
  assert.equal(secretReads, 0);
  const svc = telemetrySandbox.make$32();
  assert.equal(svc.record("any.event", {})._tag, "Void");
  assert.equal(svc.flush._tag, "Void");
  assert.equal(svc.recordOwners([], "server")._tag, "Void");

  // Relay tracing disabled
  const mer = findUniqueEntry(verifiedAsar, noTelemetry.relayPatch.targetRegex, noTelemetry.relayPatch.id).content.toString("utf8");
  assert(mer.includes("/* T3_NO_TELEMETRY_RELAY_V1 */\nconst isRelayTracingEnabled = () => false;"));

  // Client Axiom exporter disabled
  const utils = findUniqueEntry(verifiedAsar, noTelemetry.clientPatch.targetRegex, noTelemetry.clientPatch.id).content.toString("utf8");
  assert(utils.includes("function CE(){/* T3_NO_TELEMETRY_CLIENT_V1 */return Co(hE,lr())}"));
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
  assert.equal(cleanPlan.selectedPatches.length, 4);
  assert.equal(cleanPlan.includeTheme, true);

  const privOnlyPlan = resolveInstallPlan(ALL_PATCHES, { preset: "privacy-only" });
  assert.equal(privOnlyPlan.includeTheme, false);
  assert.equal(privOnlyPlan.selectedPatches.length, 4);

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
  assert(layoutWithoutComposer.includes("trailing:(0,$.jsx)(sF,"), "new-chat-layout must preserve trailing permissions when usage-rings is omitted");

  // Verify sidebar-new-chat guards null/negative activeSearchResultIndex
  const mainJs = findUniqueEntry(verifiedAsar, sidebarNewChat.targetRegex, sidebarNewChat.id).content.toString("utf8");
  assert(mainJs.includes('typeof g === "number" && g >= 0 && g < h'));

  // Verify workspace-floating-panels Alt+S uses ev.code === "KeyS" (macOS Option+S compatibility)
  const patchedChat = findUniqueEntry(verifiedAsar, newChatLayout.targetRegex, "chat-patched").content.toString("utf8");
  assert(patchedChat.includes('ev.code === "KeyS"'));
  const patchedTabBar = findUniqueEntry(verifiedAsar, workspaceFloatingPanels.tabBarPatch.targetRegex, "tab-bar-patched").content.toString("utf8");
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
  assert.equal(macosCli.selectMacosPatches(false, { preset: "clean" }).selectedPatches.some((p) => p.id === "macos-user-data"), true);
  assert.equal(macosCli.selectMacosPatches(true, { preset: "clean" }).selectedPatches.some((p) => p.id === "macos-user-data"), false);

  const macTmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-mac-test-"));
  try {
    const tmpMacPaths = macosCli.getMacosPaths(macTmp);
    const macTheme = macosCli.prepareProfile(false, { officialOnly: false }, tmpMacPaths);
    assert.equal(macTheme.activated, true);
    const macSharedTheme = macosCli.prepareProfile(true, { officialOnly: true }, tmpMacPaths);
    assert.equal(macSharedTheme.officialOnly, true);
    assert.equal(macSharedTheme.activated, false);
  } finally {
    fs.rmSync(macTmp, { recursive: true, force: true });
  }
}

function verifySameFileFolding(asar) {
  // 1) Patched session-logic Be/ce deduplicates repeated reads (including Windows backslash/Path keys) & edits
  const slCode = findUniqueEntry(asar, timelineCollapse.summaryPatch.targetRegex, timelineCollapse.summaryPatch.id).content.toString("utf8");
  const ceMatch = slCode.match(/function y\(e\)\{[\s\S]+?function w\(e\)\{[\s\S]+?\}/);
  const beMatch = slCode.match(/function Be\(e,t\)\{\/\* T3_TIMELINE_SUMMARY_V\d+ \*\/[\s\S]+?\n?\}(?=function Ve\()/);
  assert(ceMatch && beMatch, "Missing patched session-logic path extractor or Be counter");
  const slCtx = runInNewContext(
    ceMatch[0] + "\n" + beMatch[0] + "\n({ w, Be })",
    {
      se: (x) => Boolean(x && Object.keys(x).length > 0),
      V: (x) => x.toolData?.input ?? x.structuredPayload?.input,
      Le: (x) => x.detail ?? null,
    }
  );
  assert.deepEqual([...slCtx.w({ input: { Path: "C:\\proj\\foo.js" } })], ["C:\\proj\\foo.js"]);
  const readCount = slCtx.Be("read", [
    { toolData: { input: { Path: "C:\\proj\\foo.js", StartLine: 1, EndLine: 50 } } },
    { toolData: { input: { file_path: "c:/proj/foo.js", StartLine: 51, EndLine: 100 } } },
    { detail: "C:\\proj\\bar.js" },
  ]);
  assert.equal(readCount, 2, "Repeated reads of the same file must count as 1 unique file");
  const editCount = slCtx.Be("edit", [
    { changedFiles: ["src\\a.ts"] },
    { changedFiles: ["./src/a.ts"] },
  ]);
  assert.equal(editCount, 1);

  // 2) Patched useTimelineFollow T3SameFileGroup renders collapsed row and expands child D_ entries on click
  const utCode = findUniqueEntry(asar, timelineCollapse.targetRegex, timelineCollapse.id).content.toString("utf8");
  assert(
    utCode.includes("t3RenderSameFileChildren(i,o)") && utCode.includes("var R_=(0,Z.memo)(") && utCode.includes("(0,Z.useMemo)(()=>t3RenderSameFileChildren(i,o),[i,o])"),
    "Patched R_ must memoize t3RenderSameFileChildren"
  );
  const helperStart = utCode.indexOf("function disclosureIds(");
  assert(helperStart >= 0, "Missing timeline-collapse helper functions");
  const helperCode = utCode.slice(helperStart);
  const expandedSet = new Set();
  const toggledCalls = [];
  let expandedState = false;
  const jsx = (type, props) => ({ type, props: props || {} });
  const tlSandbox = {
    document: { documentElement: { lang: "zh-CN" } },
    navigator: { language: "zh-CN" },
    Cd: { _id: "cd" },
    xd: { _id: "xd" },
    Z: {
      Fragment: Symbol("Fragment"),
      use: (ctx) => (ctx._id === "cd"
        ? { state: { expandedEntries: expandedSet }, onToggleEntry: (wasOpen, id) => toggledCalls.push({ wasOpen, id }) }
        : { timestampFormat: "short" }),
      useState: (init) => {
        if (typeof init === "function") expandedState = init();
        return [expandedState, (v) => { expandedState = typeof v === "function" ? v(expandedState) : v; }];
      },
    },
    $: { jsx, jsxs: jsx },
    J: () => (s) => s,
    ws: () => false,
    fs: (e) => e.action,
    ym: () => [],
    ds: () => null,
    Xr: (p) => String(p).replaceAll("\\", "/"),
    Zf: "WorkRow",
    Vp: "WorkIcon",
    Nt: "ChevronRight",
    uc: "Timestamp",
    D_: "WorkEntryRow",
  };
  runInNewContext(helperCode + "\nObject.assign(globalThis, { t3RenderSameFileChildren, T3SameFileGroup });", tlSandbox);

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
  assert.equal(groupTree.props["aria-expanded"], false);
  assert.equal(groupTree.props.children, null);
  assert.match(JSON.stringify(groupTree.props.label), /已读取 src\/a\.ts.*2 次读取.*L1-80, L81-160/);

  groupTree.props.onClick();
  assert.equal(expandedSet.has("r1:file-fold"), true);
  assert.deepEqual(toggledCalls, [{ wasOpen: false, id: "r1:file-fold" }]);
  groupTree = tlSandbox.T3SameFileGroup(nodes[0].props);
  assert.equal(groupTree.props["aria-expanded"], true);
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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function verifyFilesChangesExplorer(asar) {
  const feCode = findUniqueEntry(asar, filesChangesExplorer.targetRegex, filesChangesExplorer.id).content.toString("utf8");
  assert(feCode.includes(filesChangesExplorer.marker), "Missing files-changes-explorer marker");
  assert(feCode.includes('style: showChangesSplit && !allFilesOpen ? { display: "none" } : undefined'), "All files tree must stay mounted when collapsed");
  assert(feCode.includes('className: "t3e-fe-file-main"'), "Changed file row must expose native button separate from diff badge");
  const idx = feCode.indexOf(`/* ${filesChangesExplorer.marker} */`);
  assert(idx >= 0);
  const { t3BuildChangedFileTree, T3FeChangedTreeNodes } = runInNewContext(
    feCode.slice(idx) + "\n({ t3BuildChangedFileTree, T3FeChangedTreeNodes })",
    {
      $: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
      Z: { Fragment: Symbol("Fragment"), useState: (i) => [i, () => {}], useEffect() {}, useMemo: (f) => f() },
      t3GitQueries: { status: () => null },
      t3UseQuery: () => ({ data: null }),
      t3DiffPanelStore: { getState: () => ({ selectGitScope() {} }) },
      t3RightPanelStore: { getState: () => ({ open() {} }) },
    }
  );
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
}

if (process.argv[2] === "--unit") {
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
  if (process.platform === "darwin") {
    candidates.push(
      path.join(os.homedir(), "Applications", "T3 Code Enhancer.app", "Contents", "Resources", "app.asar"),
      "/Applications/T3 Code (Beta).app/Contents/Resources/app.asar"
    );
  }
  return candidates.find((p) => p && fs.existsSync(p));
}
const source = process.argv[2] || findDefaultVerifyAsar();
assert(source, "请提供原版 ASAR：node tests/verify.cjs <app.asar|server.asar>");
const baseline = resolvePristineBaseline({
  source,
  backup: source + ".before-t3code-enhancer",
  legacyBackup: source + ".before-timeline-collapse",
});
const siblingAppAsar = path.basename(source) === "server.asar"
  ? path.join(path.dirname(source), "app.asar")
  : null;
const desktopBaseline = siblingAppAsar && fs.existsSync(siblingAppAsar)
  ? resolvePristineBaseline({
      source: siblingAppAsar,
      backup: siblingAppAsar + ".before-t3code-enhancer",
      legacyBackup: siblingAppAsar + ".before-timeline-collapse",
    }, [desktopTray])
  : null;
const tmpOut = path.join(os.tmpdir(), `t3code-enhancer-test-${Date.now()}.asar`);
const tmpDesktopOut = desktopBaseline ? path.join(os.tmpdir(), `t3code-enhancer-desktop-test-${Date.now()}.asar`) : null;
try {
  const baselineApplicable = applicablePatchesForArchive(baseline.asar, ALL_PATCHES);
  const report = buildPatchedArchive(baseline.asar, baselineApplicable, tmpOut);
  const verified = readAsar(tmpOut);
  for (const p of baselineApplicable) {
    const entry = findUniqueEntry(verified, p.targetRegex, p.id);
    assert(entry.content.toString("utf8").includes(p.marker), `Marker missing for ${p.id}`);
  }
  let verifiedDesktop = verified.entries.some((e) => desktopTray.targetRegex.test(e.key)) ? verified : null;
  if (desktopBaseline && tmpDesktopOut) {
    const desktopReport = buildPatchedArchive(desktopBaseline.asar, [desktopTray], tmpDesktopOut);
    report.push(...desktopReport);
    verifiedDesktop = readAsar(tmpDesktopOut);
  }
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
  console.log("9. Verifying on-demand inline diff per expanded edit...");
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
  console.log("16. Verifying files-changes-explorer tree normalization, search expand, and DOM structure...");
  verifyFilesChangesExplorer(verified);
  console.log("   OK");
} finally {
  if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  if (tmpDesktopOut && fs.existsSync(tmpDesktopOut)) fs.unlinkSync(tmpDesktopOut);
}

console.log("\nALL TESTS PASSED.");

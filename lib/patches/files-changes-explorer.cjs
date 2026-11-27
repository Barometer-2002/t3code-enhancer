"use strict";

const assert = require("node:assert/strict");
const { loadRuntimeExports, mountRuntime } = require("../runtime-loader.cjs");

const ID = "files-changes-explorer";
const MARKER = "T3_FILES_CHANGES_EXPLORER_V9";
const LEGACY_MARKERS = [
  "T3_FILES_CHANGES_EXPLORER_V1",
  "T3_FILES_CHANGES_EXPLORER_V2",
  "T3_FILES_CHANGES_EXPLORER_V3",
  "T3_FILES_CHANGES_EXPLORER_V4",
  "T3_FILES_CHANGES_EXPLORER_V5",
  "T3_FILES_CHANGES_EXPLORER_V6",
  "T3_FILES_CHANGES_EXPLORER_V7",
  "T3_FILES_CHANGES_EXPLORER_V8",
];
const TARGET_REGEX = /^apps\/server\/dist\/client\/assets\/FilePreviewPanel-[\w-]+\.js$/;
const ORIGINAL_HASH = "e32072b1c54c65161284e24643061751fe5da64b4ee7c703d1ebccffb6bf6596";
const KNOWN_HASHES = ["11720c1228f71ef7baffe79c536f0494278c8b24fb95df34bbb43e67fc004d85"];

const TARGET_SPEC = {
  pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
  preferredRegex: /^apps\/server\/dist\/client\/assets\/FilePreviewPanel-[\w-]+\.js$/,
  includes: ["hostFolder", "onOpenFile"],
  anyIncludes: [
    ["selectedPath", "selectedFilePath"],
    ["data-file-browser-panel", "searchQuery"],
  ],
};

const { t3NormalizeRelPath, t3BuildChangedFileTree } = loadRuntimeExports("files-explorer-ui");

function apply(source, ctx) {
  assert(
    ctx && typeof ctx.ensureChunkImport === "function" && typeof ctx.addRuntimeAsset === "function",
    "files-changes-explorer requires a PatchContext with ensureChunkImport and addRuntimeAsset"
  );

  // 1. Resolve external chunk imports dynamically
  const gitQueries = ctx.ensureChunkImport(
    {
      pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
      preferredRegex: /^apps\/server\/dist\/client\/assets\/vcs-[\w-]+\.js$/,
      includes: ["refreshStatus"],
    },
    (local, text, ex, decl) => decl(local).includes("(") && text.includes(local + ".refreshStatus"),
    "t3GitQueries",
    "gitQueries in vcs chunk"
  );

  const useQuery = ctx.ensureChunkImport(
    {
      pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
      preferredRegex: /^apps\/server\/dist\/client\/assets\/query-[\w-]+\.js$/,
      includes: ["dataUpdatedAt", "isPending"],
    },
    (local, text, ex, decl) => decl(local).includes("dataUpdatedAt") && decl(local).includes("isPending"),
    "t3UseQuery",
    "useQuery in query chunk"
  );

  const diffPanelStore = ctx.ensureChunkImport(
    {
      pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
      preferredRegex: /^apps\/server\/dist\/client\/assets\/diffPanelStore-[\w-]+\.js$/,
      includes: ["selectGitScope"],
    },
    (local, text, ex, decl) => decl(local).includes("selectGitScope"),
    "t3DiffPanelStore",
    "diffPanelStore in diffPanelStore chunk"
  );

  const rightPanelStore = ctx.ensureChunkImport(
    {
      pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
      preferredRegex: /^apps\/server\/dist\/client\/assets\/rightPanelStore-[\w-]+\.js$/,
      includes: ["pendingMaximizeThreadKey"],
    },
    (local, text, ex, decl) => decl(local).includes("pendingMaximizeThreadKey"),
    "t3RightPanelStore",
    "rightPanelStore in rightPanelStore chunk"
  );

  // 2. Resolve React and JSX bindings dynamically
  const { react: reactVar, jsx: jsxVar } = ctx.resolveReactBindings?.() || {};
  assert(reactVar && jsxVar, "Could not resolve React/JSX bindings for files-changes-explorer");

  // 3. Match memo anchor structurally
  const memoRe = /([A-Za-z_$][\w$]*)\[\d+\]!==([A-Za-z_$][\w$]*)\|\|\1\[\d+\]!==([A-Za-z_$][\w$]*)\?\(([A-Za-z_$][\w$]*)=\2\?\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{resizable:!!([A-Za-z_$][\w$]*),children:\(0,\5\.jsx\)\(`div`,\{className:`contents`,onClick:([A-Za-z_$][\w$]*),onKeyDown:[A-Za-z_$][\w$]*=>\{[A-Za-z_$][\w$]*\.key===`Enter`&&\8\([A-Za-z_$][\w$]*\)\},children:\(0,\5\.jsx\)\(([A-Za-z_$][\w$]*),\{environmentId:([A-Za-z_$][\w$]*),cwd:([A-Za-z_$][\w$]*)\?\?([A-Za-z_$][\w$]*),/;
  const memoMatch = source.match(memoRe);
  assert(memoMatch, "Could not locate memo anchor in FilePreviewPanel bundle");

  const [
    memoFull,
    slotArray,
    ktVar,
    MVar,
    srVar,
    memoJsxVar,
    rnVar,
    YVar,
    PnVar,
    childFn,
    envVar,
    ftVar,
    rVar,
  ] = memoMatch;

  // Resolve slot index for sr from following cache write
  const srSlotMatch = source.slice(memoMatch.index).match(new RegExp(`${srVar}=${slotArray}\\[(\\d+)\\]`));
  assert(srSlotMatch, "Could not resolve memo slot index for FilePreviewPanel");
  const srSlotIdx = srSlotMatch[1];

  // Resolve threadRef in parent component
  const parentFn = ctx.findEnclosingFunction?.(memoMatch.index);
  const parentBody = parentFn
    ? source.slice(parentFn.start, memoMatch.index)
    : source.slice(Math.max(0, memoMatch.index - 8000), memoMatch.index);
  const threadRefMatch = parentBody.match(/\bthreadRef:([A-Za-z_$][\w$]*)/);
  assert(threadRefMatch, "Could not resolve threadRef local in FilePreviewPanel parent");
  const threadRefVar = threadRefMatch[1];

  const memoCondPrefix = memoFull.split("?(")[0];
  const memoReplacement = `${memoCondPrefix}||(${ktVar}&&${slotArray}[${srSlotIdx}]?.props?.children?.props?.children?.props?.threadRef!==${threadRefVar})?(${srVar}=${ktVar}?(0,${memoJsxVar}.jsx)(${rnVar},{resizable:!!${YVar},children:(0,${memoJsxVar}.jsx)(\`div\`,{className:\`contents\`,onClick:${PnVar},onKeyDown:e=>{e.key===\`Enter\`&&${PnVar}(e)},children:(0,${memoJsxVar}.jsx)(${childFn},{threadRef:${threadRefVar},environmentId:${envVar},cwd:${ftVar}??${rVar},`;

  // 4. Match return anchor structurally
  const retRe = /let\s+([A-Za-z_$][\w$]*);return\s+([A-Za-z_$][\w$]*\[\d+\]!==[A-Za-z_$][\w$]*\|\|[^{]+)\?\(\1=\(0,([A-Za-z_$][\w$]*)\.jsxs?\)\(`div`,\{className:`flex min-h-0 flex-1 flex-col bg-background`,"data-file-browser-panel":([A-Za-z_$][\w$]*),([^}]*),children:\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)]\}\)[^:]*:\1=[A-Za-z_$][\w$]*\[\d+\],\1\}/;
  const retMatch = source.match(retRe);
  assert(retMatch, "Could not locate return anchor in FilePreviewPanel bundle");

  const [
    retFull,
    itVar,
    memoCond,
    retJsxVar,
    panelAttr,
    listeners,
    Ot,
    jt,
    Nt,
    Pt,
    Ft,
  ] = retMatch;

  // Resolve child function parameters and variables
  const childFnDecl = ctx?.findEnclosingFunction ? ctx.findEnclosingFunction(retMatch.index) : null;
  const childBody = childFnDecl
    ? source.slice(childFnDecl.start, retMatch.index)
    : source.slice(Math.max(0, retMatch.index - 8000), retMatch.index);

  const paramMatch = childBody.match(/^function\s+[A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)\)\{/);
  const paramVar = paramMatch?.[1];
  const childEnvVar = childBody.match(/\benvironmentId:([A-Za-z_$][\w$]*)/)?.[1];
  const childCwdVar = childBody.match(/\bcwd:([A-Za-z_$][\w$]*)/)?.[1];
  const selPathVar = childBody.match(/\bselectedPath:([A-Za-z_$][\w$]*)/)?.[1];
  const onOpenVar = childBody.match(/\bonOpenFile:([A-Za-z_$][\w$]*)/)?.[1];
  const hostFolderProp = childBody.match(/\bhostFolder:([A-Za-z_$][\w$]*)/)?.[1];
  const hostFolderVar = hostFolderProp
    ? childBody.match(new RegExp(`([A-Za-z_$][\\w$]*)=${hostFolderProp}!==void 0&&${hostFolderProp}`))?.[1]
    : null;
  const searchVar = childBody.match(/\[([A-Za-z_$][\w$]*),\s*[A-Za-z_$][\w$]*\]\s*=\s*(?:\(0,\s*)?[A-Za-z_$][\w$]*\.useState\)?\(\s*[`\x27"]{2}\s*\)/)?.[1];
  const expandAllMatch = childBody.match(/\(\)=>\{let ([A-Za-z_$][\w$]*)=!\(([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)\);([A-Za-z_$][\w$]*)\(\1\),([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\1\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*),\1\)\}/);
  assert(
    paramVar && childEnvVar && childCwdVar && selPathVar && onOpenVar && hostFolderProp && hostFolderVar && searchVar,
    "Could not resolve FilePreviewPanel child component locals"
  );

  const expandSyncProp = expandAllMatch ? ",expandAllSyncRef:t3FeExpandRef" : "";
  const retReplacement = `return(0,${retJsxVar}.jsx)(\`div\`,{className:\`flex min-h-0 flex-1 flex-col bg-background\`,"data-file-browser-panel":${panelAttr},${listeners},children:(0,${retJsxVar}.jsx)(T3FilesChangesLayout,{header:${Ot},errorNode:${jt},moreNode:${Nt},loadingNode:${Pt},allFilesNode:${Ft},environmentId:${childEnvVar},cwd:${childCwdVar},threadRef:${paramVar}.threadRef,searchQuery:${searchVar},selectedPath:${selPathVar},onOpenFile:${onOpenVar},hostFolder:${hostFolderVar}${expandSyncProp}})})}`;

  // 5. Replace anchors
  let patched = source
    .replace(memoFull, () => memoReplacement)
    .replace(retFull, () => retReplacement);
  if (expandAllMatch) {
    const [expandFull, evVar, mVar, feVar, neVar, jtVar, gVar, hVar, vVar] = expandAllMatch;
    patched = patched
      .replace(paramMatch[0], () => `${paramMatch[0]}let t3FeExpandRef=(0,${reactVar}.useRef)(null);`)
      .replace(expandFull, () => `()=>{let ${evVar}=!(${mVar}||${feVar});${neVar}(${evVar}),${jtVar}(${gVar},${evVar}?${hVar}:${vVar},${evVar}),t3FeExpandRef.current?.(${evVar})}`);
  }
  const treeCssMatch = patched.match(/renderRowDecoration:([A-Za-z_$][\w$]*),search:!1,onSearchChange:([A-Za-z_$][\w$]*),unsafeCSS:([A-Za-z_$][\w$]*)/);
  if (treeCssMatch) {
    const [treeCssFull, decVar, searchChVar, cssVar] = treeCssMatch;
    const flatFix = `\\n[data-item-section="content"]{display:flex;align-items:center}[data-item-flattened-subitems]{display:inline-flex;align-items:center;min-width:0;max-width:100%}[data-item-flattened-subitem]{display:inline-flex;align-items:center;min-width:0}\\n`;
    patched = patched.replace(
      treeCssFull,
      () => `renderRowDecoration:${decVar},search:!1,onSearchChange:${searchChVar},unsafeCSS:${cssVar}+\`${flatFix}\``
    );
  }

  const bridge = `/* ${MARKER} */
const { t3NormalizeRelPath, t3BuildChangedFileTree, T3FeChangedTreeNodes, T3FilesChangesLayout } = createFilesExplorerRuntime({
  React: ${reactVar},
  jsx: ${jsxVar}.jsx,
  jsxs: ${jsxVar}.jsxs,
  gitQueries: ${gitQueries.local},
  useQuery: ${useQuery.local},
  diffPanelStore: ${diffPanelStore.local},
  rightPanelStore: ${rightPanelStore.local},
});
`;

  return mountRuntime(patched, ctx, "files-explorer-ui", ["createFilesExplorerRuntime"], bridge);
}

module.exports = {
  id: ID,
  name: "文件侧边栏「所有更改 / 已更改的文件 / 所有文件」上下分层联动",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetSpec: TARGET_SPEC,
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  knownHashes: KNOWN_HASHES,
  apply,
  t3NormalizeRelPath,
  t3BuildChangedFileTree,
};

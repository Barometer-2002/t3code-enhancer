"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ID = "files-changes-explorer";
const MARKER = "T3_FILES_CHANGES_EXPLORER_V7";
const LEGACY_MARKERS = [
  "T3_FILES_CHANGES_EXPLORER_V1",
  "T3_FILES_CHANGES_EXPLORER_V2",
  "T3_FILES_CHANGES_EXPLORER_V3",
  "T3_FILES_CHANGES_EXPLORER_V4",
  "T3_FILES_CHANGES_EXPLORER_V5",
  "T3_FILES_CHANGES_EXPLORER_V6",
];
const TARGET_REGEX = /^apps\/server\/dist\/client\/assets\/FilePreviewPanel-[\w-]+\.js$/;
const ORIGINAL_HASH = "11720c1228f71ef7baffe79c536f0494278c8b24fb95df34bbb43e67fc004d85";

const TARGET_SPEC = {
  pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
  preferredRegex: /^apps\/server\/dist\/client\/assets\/FilePreviewPanel-[\w-]+\.js$/,
  includes: ["hostFolder", "onOpenFile"],
  anyIncludes: [
    ["selectedPath", "selectedFilePath"],
    ["data-file-browser-panel", "searchQuery"],
  ],
};

const RUNTIME_PATH = path.join(__dirname, "../runtime/files-explorer-ui.mjs");
function getRuntimeSource() {
  return fs.readFileSync(RUNTIME_PATH, "utf8");
}

function t3NormalizeRelPath(raw) {
  return String(raw || "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
}

function t3BuildChangedFileTree(files, query) {
  const q = String(query || "").trim().toLowerCase();
  const list = Array.isArray(files) ? files : [];
  const filtered = q
    ? list.filter((f) => String(f?.path || "").toLowerCase().includes(q))
    : list;

  const root = { kind: "dir", name: "", path: "", dirs: new Map(), files: [] };
  const seenPaths = new Set();
  for (const f of filtered) {
    const raw = String(f?.path || "");
    if (!raw || /[\\/]$/.test(raw)) continue;
    const norm = t3NormalizeRelPath(raw);
    if (!norm || seenPaths.has(norm)) continue;
    seenPaths.add(norm);
    const parts = norm.split("/").filter(Boolean);
    if (!parts.length) continue;
    let cur = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      prefix = prefix ? prefix + "/" + seg : seg;
      if (!cur.dirs.has(seg)) {
        cur.dirs.set(seg, { kind: "dir", name: seg, path: prefix, dirs: new Map(), files: [] });
      }
      cur = cur.dirs.get(seg);
    }
    const insertions = Number(f.insertions) || 0;
    const deletions = Number(f.deletions) || 0;
    const isNew = f?.status === "added" || f?.status === "untracked" || f?.operation === "add" || (insertions > 0 && deletions === 0);
    cur.files.push({
      kind: "file",
      name: parts[parts.length - 1],
      path: norm,
      insertions,
      deletions,
      isNew,
    });
  }

  function finalize(node) {
    const dirs = Array.from(node.dirs.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(finalize);
    const sortedFiles = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
    return {
      kind: "dir",
      name: node.name,
      path: node.path,
      children: dirs.concat(sortedFiles),
    };
  }
  return finalize(root).children;
}

function apply(source, ctx) {
  // 1. Resolve external chunk imports dynamically
  const gitQueries = ctx?.ensureChunkImport
    ? ctx.ensureChunkImport(
        {
          pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
          preferredRegex: /^apps\/server\/dist\/client\/assets\/vcs-[\w-]+\.js$/,
          includes: ["refreshStatus"],
        },
        (local, text, ex, decl) => decl(local).includes("(") && text.includes(local + ".refreshStatus"),
        "t3GitQueries",
        "gitQueries in vcs chunk"
      )
    : { local: "t3GitQueries", added: false };

  const useQuery = ctx?.ensureChunkImport
    ? ctx.ensureChunkImport(
        {
          pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
          preferredRegex: /^apps\/server\/dist\/client\/assets\/query-[\w-]+\.js$/,
          includes: ["dataUpdatedAt", "isPending"],
        },
        (local, text, ex, decl) => decl(local).includes("dataUpdatedAt") && decl(local).includes("isPending"),
        "t3UseQuery",
        "useQuery in query chunk"
      )
    : { local: "t3UseQuery", added: false };

  const diffPanelStore = ctx?.ensureChunkImport
    ? ctx.ensureChunkImport(
        {
          pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
          preferredRegex: /^apps\/server\/dist\/client\/assets\/diffPanelStore-[\w-]+\.js$/,
          includes: ["selectGitScope"],
        },
        (local, text, ex, decl) => decl(local).includes("selectGitScope"),
        "t3DiffPanelStore",
        "diffPanelStore in diffPanelStore chunk"
      )
    : { local: "t3DiffPanelStore", added: false };

  const rightPanelStore = ctx?.ensureChunkImport
    ? ctx.ensureChunkImport(
        {
          pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
          preferredRegex: /^apps\/server\/dist\/client\/assets\/rightPanelStore-[\w-]+\.js$/,
          includes: ["pendingMaximizeThreadKey"],
        },
        (local, text, ex, decl) => decl(local).includes("pendingMaximizeThreadKey"),
        "t3RightPanelStore",
        "rightPanelStore in rightPanelStore chunk"
      )
    : { local: "t3RightPanelStore", added: false };

  let fallbackImports = "";
  if (!ctx?.ensureChunkImport) {
    fallbackImports =
      'import{a as t3GitQueries}from"./vcs-18KjoXJS.js";' +
      'import{n as t3UseQuery}from"./query-DMZrozbe.js";' +
      'import{a as t3DiffPanelStore}from"./diffPanelStore-BPi2P3rj.js";' +
      'import{f as t3RightPanelStore}from"./rightPanelStore-BjBip_TP.js";\n';
  }

  // 2. Resolve React and JSX bindings dynamically
  const { react: reactVar, jsx: jsxVar } = ctx?.resolveReactBindings
    ? ctx.resolveReactBindings()
    : {
        react: source.match(/\b([A-Za-z_$][\w$]*)\.(?:useState|Fragment|useRef|useEffect)\b/)?.[1] || "X",
        jsx: source.match(/\(0,([A-Za-z_$][\w$]*)\.jsxs?\)\(/)?.[1] || "$",
      };

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
  const srSlotIdx = srSlotMatch?.[1] || "220";

  // Resolve threadRef in parent component
  const parentFn = ctx?.findEnclosingFunction ? ctx.findEnclosingFunction(memoMatch.index) : null;
  const parentBody = parentFn
    ? source.slice(parentFn.start, memoMatch.index)
    : source.slice(Math.max(0, memoMatch.index - 8000), memoMatch.index);
  const threadRefMatch = parentBody.match(/\bthreadRef:([A-Za-z_$][\w$]*)/);
  const threadRefVar = threadRefMatch?.[1] || "_";

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

  const paramVar = childBody.match(/^function\s+[A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)\)/)?.[1] || "e";
  const childEnvVar = childBody.match(/\benvironmentId:([A-Za-z_$][\w$]*)/)?.[1] || "n";
  const childCwdVar = childBody.match(/\bcwd:([A-Za-z_$][\w$]*)/)?.[1] || "r";
  const selPathVar = childBody.match(/\bselectedPath:([A-Za-z_$][\w$]*)/)?.[1] || "a";
  const onOpenVar = childBody.match(/\bonOpenFile:([A-Za-z_$][\w$]*)/)?.[1] || "s";
  const hostFolderProp = childBody.match(/\bhostFolder:([A-Za-z_$][\w$]*)/)?.[1] || "u";
  const hostFolderVar = childBody.match(new RegExp(`([A-Za-z_$][\\w$]*)=${hostFolderProp}!==void 0&&${hostFolderProp}`))?.[1] || hostFolderProp;
  const searchVar = childBody.match(/\[([A-Za-z_$][\w$]*),\s*[A-Za-z_$][\w$]*\]\s*=\s*(?:\(0,)?(?:[A-Za-z_$][\w$]*\.)?useState\([`\x27"]{2}\)/)?.[1] || "j";

  const retReplacement = `return(0,${retJsxVar}.jsx)(\`div\`,{className:\`flex min-h-0 flex-1 flex-col bg-background\`,"data-file-browser-panel":${panelAttr},${listeners},children:(0,${retJsxVar}.jsx)(T3FilesChangesLayout,{header:${Ot},errorNode:${jt},moreNode:${Nt},loadingNode:${Pt},allFilesNode:${Ft},environmentId:${childEnvVar},cwd:${childCwdVar},threadRef:${paramVar}.threadRef,searchQuery:${searchVar},selectedPath:${selPathVar},onOpenFile:${onOpenVar},hostFolder:${hostFolderVar}})})}`;

  // 5. Replace anchors
  let patched = source
    .replace(memoFull, () => memoReplacement)
    .replace(retFull, () => retReplacement);

  // 6. Bundle runtime asset and emit compact bridge
  const runtimeAsset = ctx?.addRuntimeAsset
    ? ctx.addRuntimeAsset("files-explorer-ui", getRuntimeSource())
    : { specifier: "./files-explorer-ui.mjs" };
  const runtimeImport = `import{createFilesExplorerRuntime}from"${runtimeAsset.specifier}";\n`;

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

  ctx?.recordInjectedCode?.(bridge);

  return (
    fallbackImports +
    runtimeImport +
    patched.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "") +
    "\n" +
    bridge +
    "\n"
  );
}

module.exports = {
  id: ID,
  name: "文件侧边栏「所有更改 / 已更改的文件 / 所有文件」上下分层联动",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetSpec: TARGET_SPEC,
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  apply,
  t3NormalizeRelPath,
  t3BuildChangedFileTree,
};

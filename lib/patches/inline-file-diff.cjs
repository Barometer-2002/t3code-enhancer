"use strict";

const assert = require("node:assert/strict");
const { loadRuntimeExports, mountRuntime } = require("../runtime-loader.cjs");
const { THREAD_TIMELINE } = require("../resolver.cjs");

const ID = "inline-file-diff";
const MARKER = "T3_INLINE_FILE_DIFF_V13";
const LEGACY_MARKERS = [
  "T3_INLINE_FILE_DIFF_V1",
  "T3_INLINE_FILE_DIFF_V2",
  "T3_INLINE_FILE_DIFF_V3",
  "T3_INLINE_FILE_DIFF_V4",
  "T3_INLINE_FILE_DIFF_V5",
  "T3_INLINE_FILE_DIFF_V6",
  "T3_INLINE_FILE_DIFF_V7",
  "T3_INLINE_FILE_DIFF_V8",
  "T3_INLINE_FILE_DIFF_V9",
  "T3_INLINE_FILE_DIFF_V10",
  "T3_INLINE_FILE_DIFF_V11",
  "T3_INLINE_FILE_DIFF_V12",
];
const ORIGINAL_HASH = "4f05fa222be71b9cb2fc21f98580cc78c11453e98e06285456718594b0082231";

const { t3ParseUnifiedDiff } = loadRuntimeExports("inline-diff-ui");

function apply(source, ctx) {
  assert(
    ctx && typeof ctx.ensureChunkImport === "function" && typeof ctx.addRuntimeAsset === "function",
    "inline-file-diff requires a PatchContext with ensureChunkImport and addRuntimeAsset"
  );

  // 1. Dynamically resolve external chunk imports via semantic AST queries
  const checkpointSummaries = ctx.ensureChunkImport(
    {
      pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
      preferredRegex: /^apps\/server\/dist\/client\/assets\/entities-[\w-]+\.js$/,
      includes: ["checkpointSummariesAtom"],
    },
    (local, text, ex, decl) => decl(local)?.includes("checkpointSummariesAtom"),
    "T3UseCheckpointSummaries",
    "checkpoint summaries"
  );

  const checkpointDiff = ctx.ensureChunkImport(
    {
      pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
      preferredRegex: /^apps\/server\/dist\/client\/assets\/queries-[\w-]+\.js$/,
      includes: ["toTurnCount", "ignoreWhitespace"],
    },
    (local, text, ex, decl) => decl(local)?.includes("fromTurnCount") && decl(local)?.includes("toTurnCount"),
    "T3UseCheckpointDiff",
    "checkpoint diff query"
  );

  const parseCheckpointDiff = ctx.ensureChunkImport(
    {
      pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
      preferredRegex: /^apps\/server\/dist\/client\/assets\/diffRendering-[\w-]+\.js$/,
      includes: ["diff-panel", "cacheKeyPrefix"],
    },
    (local, text, ex, decl) => decl(local)?.includes("diff-panel") && decl(local)?.includes("cacheKeyPrefix"),
    "T3ParseCheckpointDiff",
    "diff parser"
  );

  const observeIntersection = ctx.ensureChunkImport(
    {
      pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
      preferredRegex: /^apps\/server\/dist\/client\/assets\/observeIntersection-[\w-]+\.js$/,
      includes: ["IntersectionObserver"],
    },
    (local, text, ex, decl) => decl(local)?.includes("IntersectionObserver"),
    "T3ObserveIntersection",
    "intersection observer"
  );

  let reviewQueries = null;
  let useQuery = null;
  try {
    reviewQueries = ctx.ensureChunkImport(
      {
        pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
        preferredRegex: /^apps\/server\/dist\/client\/assets\/useOpenLink-[\w-]+\.js$/,
        includes: ["environment-data:review:diff-preview"],
      },
      (local, text, ex, decl) => {
        const d = decl(local);
        if (!d) return false;
        if (d.includes("diffPreview:") || d.includes("environment-data:review:diff-preview")) return true;
        const factory = d.match(/=\s*([A-Za-z_$][\w$]*)\(/)?.[1];
        const fd = factory ? decl(factory) : "";
        return Boolean(fd && fd.includes("diffPreview:") && fd.includes("environment-data:review:diff-preview"));
      },
      "T3ReviewQueries",
      "review diff queries"
    );
    useQuery = ctx.ensureChunkImport(
      {
        pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
        preferredRegex: /^apps\/server\/dist\/client\/assets\/query-[\w-]+\.js$/,
        includes: ["dataUpdatedAt", "isPending"],
      },
      (local, text, ex, decl) => {
        const d = decl(local);
        return Boolean(d && d.includes("dataUpdatedAt") && d.includes("isPending"));
      },
      "T3UseDiffQuery",
      "useQuery in query chunk"
    );
  } catch {
    reviewQueries = null;
    useQuery = null;
  }

  // 2. Dynamically resolve React, JSX, and compiler bindings
  const reactBindings = ctx.resolveReactBindings?.() || {};
  const reactVar = reactBindings.react;
  const jsxVar = reactBindings.jsx;
  assert(reactVar && jsxVar, "Could not resolve React/JSX bindings for inline-file-diff");

  // 3. Dynamically resolve inspector component and detail hook
  const inspRegex = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.item,\s*([A-Za-z_$][\w$]*)=\2\.output;\s*([A-Za-z_$][\w$]*)\(\s*([A-Za-z_$][\w$]*)\|\|\3\.pending\s*,\s*([A-Za-z_$][\w$]*)\.onInitialOutputReady\s*\);/;
  const inspMatch = source.match(inspRegex);
  assert(inspMatch, "Could not locate inspector component in timeline bundle");
  const [inspFull, itemVar, hookResultVar, outputVar, outputReadyHook, commandOutputFlag, propsVar] = inspMatch;

  const beforeInsp = source.slice(Math.max(0, inspMatch.index - 800), inspMatch.index);
  const bmMatch = beforeInsp.match(new RegExp(`\\b${hookResultVar}=([A-Za-z_$][\\w$]*)\\(${propsVar}\\.projectedItem,\\s*${propsVar}\\.environmentId`));
  assert(bmMatch, "Could not locate timeline detail hook call");
  const bmName = bmMatch[1];

  const bmIdx = source.indexOf(`function ${bmName}(`);
  assert(bmIdx >= 0, `Could not find declaration of detail hook ${bmName}`);
  const bmBody = source.slice(bmIdx, bmIdx + 2000);

  const boMatch = bmBody.match(/\b([A-Za-z_$][\w$]*)=!([A-Za-z_$][\w$]*)\s*&&\s*([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)/);
  assert(boMatch, "Could not resolve bo (output availability check) in detail hook");
  const boFn = boMatch[3];

  const goMatch = bmBody.match(/revision:\s*([A-Za-z_$][\w$]*)\(/);
  assert(goMatch, "Could not resolve go (item revision helper) in detail hook");
  const goFn = goMatch[1];

  const piMatch = bmBody.match(/=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,\s*[A-Za-z_$][\w$]*\?\.detail\)/);
  assert(piMatch, "Could not resolve pi (useTurnItemDetail hook) in detail hook");
  const piFn = piMatch[1];

  const gateRegex = new RegExp(`([A-Za-z_$][\\w$]*)=!([A-Za-z_$][\\w$]*)&&${boFn}\\(([A-Za-z_$][\\w$]*)\\),([A-Za-z_$][\\w$]*\\[\\d+\\]=\\2,[A-Za-z_$][\\w$]*\\[\\d+\\]=\\3,[A-Za-z_$][\\w$]*\\[\\d+\\]=\\1)`);
  const gateMatch = source.match(gateRegex);
  assert(gateMatch, "Could not locate detailGate in timeline bundle");
  const [gateFull, gateC, gateA, gateS, gateMemo] = gateMatch;

  // 4. Dynamically resolve row label anchor
  const seRegex = /let\s+([A-Za-z_$][\w$]*);(?:(?!\blet\b)[\s\S])*?\(\1=\(0,[A-Za-z_$][\w$]*\.jsx\)\(`div`,{className:`min-w-0 flex-1 overflow-hidden`,children:\(0,[A-Za-z_$][\w$]*\.jsxs\)\(`p`,{className:`flex min-w-0 w-full items-baseline gap-1\.5 text-sm leading-relaxed`,children:\[[^\]]+\]}\)}\)(?:(?!\blet\b)[\s\S])*?:\1=[A-Za-z_$][\w$]*\[\d+\];/;
  const seMatch = source.match(seRegex);
  assert(seMatch, "Could not locate row label seAnchor in timeline bundle");
  const [seFull, jeVar] = seMatch;

  const encFn = ctx.findEnclosingFunction?.(seMatch.index);
  const thBody = encFn ? source.slice(encFn.start, seMatch.index) : source.slice(Math.max(0, seMatch.index - 12000), seMatch.index);

  const workEntryVar = thBody.match(/workEntry:([A-Za-z_$][\w$]*)/)?.[1];
  const workspaceRootVar = thBody.match(/workspaceRoot:([A-Za-z_$][\w$]*)/)?.[1];
  const expandedVar = thBody.match(/"aria-expanded":([A-Za-z_$][\w$]*)/)?.[1];
  const tlCtxVar = thBody.match(/\b([A-Za-z_$][\w$]*)\.markdownCwd\b/)?.[1];
  assert(workEntryVar && workspaceRootVar && expandedVar && tlCtxVar, "Could not resolve WorkEntryRow locals for inline-file-diff");

  // 5. Dynamically resolve relPath and formatCompact helpers
  const fsFn = source.match(/children:\[`\+`,([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.additions/)?.[1];
  const urFn = source.match(/\b([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.fileName,\s*[A-Za-z_$][\w$]*\.workspaceRoot\)/)?.[1];
  assert(fsFn && urFn, "Could not resolve formatCompact or relPath helpers for inline-file-diff");

  // 6. Perform AST replacements
  const gateReplacement = `${gateC}=!${gateA}&&(${boFn}(${gateS})||${gateS}.type===\`file_change\`),${gateMemo}`;
  const panelReplacement = `${inspFull}if(${itemVar}.type===\`file_change\`)return(0,${jsxVar}.jsx)(T3InlineFileDiffCardMemo,{item:${itemVar},projectedItem:${propsVar}.projectedItem,detail:${outputVar},workspaceRoot:${propsVar}.workspaceRoot,cwd:${propsVar}.cwd,onOpenToolDiff:${propsVar}.onOpenToolDiff});`;
  const seReplacement = `${seFull}if(${workEntryVar}.projectedItem?.item?.type===\`file_change\`){${jeVar}=(0,${jsxVar}.jsx)(T3FileChangeRowLabelMemo,{projectedItem:${workEntryVar}.projectedItem,workspaceRoot:${workspaceRootVar},cwd:${tlCtxVar}.markdownCwd,environmentId:${tlCtxVar}.activeThreadEnvironmentId,source:${tlCtxVar}.turnItemSource,expanded:${expandedVar}});}`;

  let patched = source
    .replace(gateFull, () => gateReplacement)
    .replace(inspFull, () => panelReplacement)
    .replace(seFull, () => seReplacement);

  const bridge = `/* ${MARKER} */
const { T3FileChangeRowLabel, T3FileChangeRowLabelMemo, T3InlineFileDiffCard, T3InlineFileDiffCardMemo, t3RenderFileChangeStats } = createInlineDiffRuntime({
  React: ${reactVar},
  jsx: ${jsxVar}.jsx,
  jsxs: ${jsxVar}.jsxs,
  resolveRelPath: ${urFn},
  useCheckpointSummaries: ${checkpointSummaries.local},
  useCheckpointDiff: ${checkpointDiff.local},
  parseCheckpointDiff: ${parseCheckpointDiff.local},
  observeIntersection: ${observeIntersection.local},
  useTurnItemDetail: ${piFn},
  getItemRevision: ${goFn},
  formatCompact: ${fsFn},${reviewQueries && useQuery ? `\n  reviewQueries: ${reviewQueries.local},\n  useQuery: ${useQuery.local},` : ""}
});
`;

  return mountRuntime(patched, ctx, "inline-diff-ui", ["createInlineDiffRuntime"], bridge);
}

const SIDE_REVEAL_MARKER = "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V6";
const escapeIdentifier = (name) => name.replaceAll("$", "\\$");

const sideRevealPatch = {
  id: "inline-file-diff-side-reveal",
  name: "侧栏展开此次编辑的 Diff",
  marker: SIDE_REVEAL_MARKER,
  legacyMarkers: [
    "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V1",
    "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V2",
    "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V3",
    "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V4",
    "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V5",
  ],
  targetSpec: {
    pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
    preferredRegex: /^apps\/server\/dist\/client\/assets\/DiffPanel-[\w-]+\.js$/,
    includes: ["tool-call:", "revealRequestId", "checkpointTurnCount"],
  },
  targetRegex: /^apps\/server\/dist\/client\/assets\/DiffPanel-[\w-]+\.js$/,
  originalHash: "446110756c9ecb1bdc58e1036854122ae0f0d9902613fc84adae681ecb4c3109",

  apply(source, ctx) {
    // 1. Anchor 1: selection
    const selRegex = /let\s+([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.kind===`turn`\?\2\.turnId:null,([A-Za-z_$][\w$]*)=\2\.kind===`unstaged`\|\|\2\.kind===`commit`\?\2\.kind:`branch`,([A-Za-z_$][\w$]*)=\2\.kind===`commit`\?\2\.sha:null,([A-Za-z_$][\w$]*)=\2\.kind===`branch`\|\|\2\.kind===`commit`\?\2\.baseRef:null,([A-Za-z_$][\w$]*)=\2\.kind===`turn`\?\2\.filePath\?\?null:null,([A-Za-z_$][\w$]*)=\2\.kind===`turn`\?\2\.revealRequestId:0/;
    const selMatch = source.match(selRegex);
    assert(selMatch, "Could not locate DiffPanel selection anchor");
    const [selFull, gr, B, _r, U, W, vr, yr] = selMatch;

    // 2. Resolve variables before selection structurally
    const selection = escapeIdentifier(B);
    const vMatch = source.match(new RegExp(`([A-Za-z_$][\\w$]*)=${selection}\\.kind===\`tool-call\`\\?${selection}:null,([A-Za-z_$][\\w$]*)=\\1\\?void 0:([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*)=${selection}\\.kind===\`branch\``));
    assert(vMatch, "Could not resolve tool-call variables before selection in DiffPanel");
    const [_, V, lr, an, H] = vMatch;

    const frMatch = source.match(/let\s+([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\),([A-Za-z_$][\w$]*)=\1\.data\?\.item/);
    assert(frMatch, "Could not resolve fr/pr query hook variables in DiffPanel");
    const [__, fr, pr] = frMatch;

    const nMatch = source.match(/\{canReadFiles:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)/);
    assert(nMatch, "Could not resolve canReadFiles in DiffPanel");
    const N = nMatch[1];

    const mMatch = source.match(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)\?\.environmentId\?\?null,\s*([A-Za-z_$][\w$]*)\)/);
    assert(mMatch, "Could not resolve project/workspace variables in DiffPanel");
    const M = mMatch[2];
    const formatMessage = mMatch[3];

    const kMatch = source.match(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\?\?[A-Za-z_$][\w$]*\.diffIgnoreWhitespace/);
    assert(kMatch, "Could not resolve diffIgnoreWhitespace in DiffPanel");
    const k = kMatch[1];

    const wnMatch = source.match(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\?\.cwd\?\?([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=/);
    assert(wnMatch, "Could not resolve cwd and isRepo in DiffPanel");
    const [___, wn, workspaceRoot, Tn] = wnMatch;

    const rMatch = source.match(/let\s+([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*=\1\[0\]/);
    assert(rMatch, "Could not resolve sorted turns array in DiffPanel");
    const R = rMatch[1];

    // 3. Anchor 2: turnFetchTail & related vars
    const gMatch = source.match(/let\s+([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*=\1\?\.checkpointTurnCount,([A-Za-z_$][\w$]*)=/);
    assert(gMatch, "Could not resolve turn diff and scope key variables in DiffPanel");
    const [____, G, Sr] = gMatch;

    const scope = escapeIdentifier(Sr);
    const kCrMatch = source.match(new RegExp(`([A-Za-z_$][\\w$]*)=[A-Za-z_$][\\w$]*\\?\`[^\`]*\\$\\{${scope}\\}\`:null,([A-Za-z_$][\\w$]*)=\\1\\?\\?${scope}`));
    assert(kCrMatch, "Could not resolve composite thread scope key variables in DiffPanel");
    const [_____, K, Cr] = kCrMatch;

    const jMatch = source.match(new RegExp(`([A-Za-z_$][\\w$]*)\\?\`\\$\\{\\1\\.environmentId\\}:\\$\\{\\1\\.threadId\\}:\\$\\{${scope}\\}\``));
    assert(jMatch, "Could not resolve thread context in DiffPanel");
    const jVar = jMatch[1];

    const turnTailRegex = new RegExp(`let\\s+([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\(([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*)\\),([A-Za-z_$][\\w$]*)=`);
    const turnTailMatch = source.match(turnTailRegex);
    assert(turnTailMatch, "Could not locate turnFetchTail anchor in DiffPanel");
    const [turnTailFull, Nr, He, Ar, Mr, Pr] = turnTailMatch;

    // Resolve the path before the native filter and reveal effect share it.
    const hideRegex = new RegExp(`([A-Za-z_$][\\w$]*)=e=>\\{let\\s+t=([A-Za-z_$][\\w$]*)\\(e\\);return!([A-Za-z_$][\\w$]*)\\|\\|t===${escapeIdentifier(vr)}\\|\\|!([A-Za-z_$][\\w$]*)\\(t\\)\\}`);
    const hideMatch = source.match(hideRegex);
    assert(hideMatch, "Could not locate hideFilter anchor in DiffPanel");
    const [, filter, fileName] = hideMatch;
    const revealAnchor = source.match(new RegExp(`let\\s+[A-Za-z_$][\\w$]*=[A-Za-z_$][\\w$]*\\.length,${escapeIdentifier(filter)};`));
    assert(revealAnchor, "Could not locate file filter setup in DiffPanel");

    const rowMatch = source.match(new RegExp(`let\\s+t=([A-Za-z_$][\\w$]*)\\.findIndex\\(t=>${escapeIdentifier(fileName)}\\(t\\.fileDiff\\)===e\\)`));
    const fileMatch = rowMatch && source.match(new RegExp(`(?<![\\w$])${escapeIdentifier(rowMatch[1])}=[A-Za-z_$][\\w$]*\\(([A-Za-z_$][\\w$]*)\\)\\.map\\(`));
    assert(rowMatch && fileMatch, "Could not resolve renderable files and rows in DiffPanel");

    const qtMatch = source.match(/[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\?\.type===`file_change`\?([A-Za-z_$][\w$]*)\(/);
    assert(qtMatch, "Could not resolve extractToolPatch function in DiffPanel");
    const Qt = qtMatch[1];

    const leMatch = source.match(/:([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\?void 0:[A-Za-z_$][\w$]*,`diff-panel:\${[A-Za-z_$][\w$]*}`/);
    assert(leMatch, "Could not resolve parsePatch function in DiffPanel");
    const Le = leMatch[1];

    // 6. Replacements
    const selReplacement = `/* ${SIDE_REVEAL_MARKER} */let t3RawZ=${V},t3Fb=t3PickToolDiffFallback({rawTarget:t3RawZ,toolQuery:${fr},toolItem:${pr},cwd:${wn},workspaceRoot:${workspaceRoot},formatMessage:${formatMessage},ignoreWhitespace:${k},isRepo:${Tn},canReadFiles:${N},projectMeta:${M},turns:${R}}),t3GitMode=t3Fb?.mode??null;if(t3GitMode){${H}=t3GitMode===\`unstaged\`;${V}=null;${lr}=${an}}let ${gr}=${B}.kind===\`turn\`?${B}.turnId:t3Fb?.turnId??null,${_r}=t3GitMode===\`unstaged\`?\`unstaged\`:${B}.kind===\`unstaged\`||${B}.kind===\`commit\`?${B}.kind:\`branch\`,${U}=${B}.kind===\`commit\`?${B}.sha:null,${W}=${B}.kind===\`branch\`||${B}.kind===\`commit\`?${B}.baseRef:null,${vr}=t3RawZ?.revealRequestId?t3RawZ.filePath??null:${B}.kind===\`turn\`?${B}.filePath??null:null,${yr}=t3RawZ?.revealRequestId??(${B}.kind===\`turn\`?${B}.revealRequestId:0)`;

    const turnFetchTailReplacement = `let ${Nr}=${He}(${Ar},${Mr});if(t3GitMode===\`turn\`&&!${Nr}.isPending&&(${Nr}.error||!t3CheckpointHasFile(${Nr}.data,${vr},${k},${workspaceRoot}))&&t3Fb.canUnstaged){t3GitMode=\`unstaged\`;${H}=!0;${_r}=\`unstaged\`;${G}=void 0;${gr}=null;${Sr}=\`unstaged\`;${K}=${jVar}?\`\${${jVar}.environmentId}:\${${jVar}.threadId}:\${${Sr}}\`:null;${Cr}=${K}??${Sr}}let ${Pr}=`;

    let patched = source
      .replace(selFull, () => selReplacement)
      .replace(turnTailFull, () => turnFetchTailReplacement)
      .replace(revealAnchor[0], () => `if(${vr}||t3RawZ?.revealRequestId)${vr}=t3ResolveRevealPath(${vr},${fileMatch[1]},${rowMatch[1]},${workspaceRoot},!t3GitMode&&Boolean(t3RawZ?.revealRequestId));${revealAnchor[0]}`);

    assert(ctx && typeof ctx.addRuntimeAsset === "function", "inline-file-diff-side-reveal requires addRuntimeAsset");
    const sideRevealBridge = `/* ${SIDE_REVEAL_MARKER} */
const { t3CheckpointHasFile, t3PickToolDiffFallback, t3ResolveRevealPath } = createSideRevealHelpers({
  extractToolPatch: ${Qt},
  parsePatch: ${Le},
  getFileName: ${fileName},
});
`;

    return mountRuntime(patched, ctx, "inline-diff-ui", ["createSideRevealHelpers"], sideRevealBridge);
  },
};

const quietReviewToastPatch = {
  id: "inline-file-diff-quiet-review-toast",
  name: "屏蔽后台 Diff 预览慢请求弹窗",
  marker: "T3_QUIET_REVIEW_SLOW_TOAST_V1",
  legacyMarkers: [],
  targetSpec: {
    pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
    preferredRegex: /^apps\/server\/dist\/client\/assets\/runtime-[\w-]+\.js$/,
    includes: ["pullRequests.", "subscribe", "slow-rpc-ack-requests"],
  },
  targetRegex: /^apps\/server\/dist\/client\/assets\/runtime-CerGdK8c\.js$/,
  originalHash: "e36294a0e3d088b4ae42e03fc2eb60203a894b3ce67c87683091c404c4c79622",

  apply(source) {
    const quietRegex = /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return!\2\.includes\(`subscribe`\)&&!\2\.startsWith\(`pullRequests\.`\)&&!([A-Za-z_$][\w$]*)\.has\(\2\)\}/;
    const m = source.match(quietRegex);
    assert(m && source.indexOf(m[0]) === source.lastIndexOf(m[0]), "Could not locate slow RPC request filter in runtime bundle");
    const [full, fnName, paramName, setName] = m;
    const replacement = `function ${fnName}(${paramName}){/* T3_QUIET_REVIEW_SLOW_TOAST_V1 */return!${paramName}.includes(\`subscribe\`)&&!${paramName}.startsWith(\`pullRequests.\`)&&!${paramName}.startsWith(\`review.\`)&&!${setName}.has(${paramName})}`;
    return source.replace(full, replacement);
  },
};

module.exports = {
  id: ID,
  name: "文件编辑内联 Diff 预览与侧栏定位",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetSpec: THREAD_TIMELINE,
  targetRegex: THREAD_TIMELINE.preferredRegex,
  originalHash: ORIGINAL_HASH,
  apply,
  t3ParseUnifiedDiff,
  sideRevealPatch,
  quietReviewToastPatch,
};

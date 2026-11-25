"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ID = "inline-file-diff";
const MARKER = "T3_INLINE_FILE_DIFF_V10";
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
];
const TARGET_REGEX = /^apps\/server\/dist\/client\/assets\/ReadOnlyThreadTimeline-[\w-]+\.js$/;
const ORIGINAL_HASH = "4f05fa222be71b9cb2fc21f98580cc78c11453e98e06285456718594b0082231";

const TARGET_SPEC = {
  pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
  preferredRegex: /^apps\/server\/dist\/client\/assets\/ReadOnlyThreadTimeline-[\w-]+\.js$/,
  includes: ["onInitialOutputReady", "turnItemSource", "markdownCwd"],
};

const RUNTIME_PATH = path.join(__dirname, "../runtime/inline-diff-ui.mjs");
function getRuntimeSource() {
  return fs.readFileSync(RUNTIME_PATH, "utf8");
}

function t3ParseUnifiedDiff(diffStr, oldStr, newStr, maxRows = Infinity) {
  const rows = [];
  let rowCount = 0;
  let additions = 0;
  let deletions = 0;
  let isBinary = false;
  const appendRow = (kind, lineNo, sign, text, skip = 0) => {
    rowCount++;
    if (rows.length < maxRows) {
      rows.push({ kind, lineNo: String(lineNo), sign, text: skip ? text.slice(skip) : text });
    }
  };
  const splitNormalizedLines = (value) => {
    const lines = value.replace(/\r\n/g, "\n").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const raw = typeof diffStr === "string" ? diffStr : "";

  if (raw.trim()) {
    const lines = splitNormalizedLines(raw);

    let oldLine = 1;
    let newLine = 1;
    let sawHunk = false;
    let inBinaryPatch = false;
    let hunkIndex = 0;

    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        sawHunk = false;
        inBinaryPatch = false;
        if (rowCount > 0) {
          appendRow("hunk", "···", "", line.slice(11).trim());
        }
        continue;
      }
      if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) {
        isBinary = true;
        inBinaryPatch = line.startsWith("GIT binary patch");
        continue;
      }
      if (inBinaryPatch) {
        continue;
      }
      if (
        !sawHunk &&
        (line.startsWith("index ") ||
          line.startsWith("new file mode") ||
          line.startsWith("deleted file mode") ||
          line.startsWith("old mode") ||
          line.startsWith("new mode") ||
          line.startsWith("rename from ") ||
          line.startsWith("rename to ") ||
          line.startsWith("copy from ") ||
          line.startsWith("copy to ") ||
          line.startsWith("similarity index ") ||
          line.startsWith("dissimilarity index ") ||
          line.startsWith("--- ") ||
          line.startsWith("+++ "))
      ) {
        continue;
      }
      const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/.exec(line);
      if (hunk) {
        sawHunk = true;
        if (hunkIndex > 0) {
          appendRow("hunk", "···", "", hunk[3].trim());
        }
        const parsedOld = Number.parseInt(hunk[1], 10);
        const parsedNew = Number.parseInt(hunk[2], 10);
        oldLine = Number.isNaN(parsedOld) ? 1 : parsedOld;
        newLine = Number.isNaN(parsedNew) ? 1 : parsedNew;
        hunkIndex++;
        continue;
      }
      if (line.startsWith("\\ No newline at end of file")) {
        continue;
      }
      if (line.startsWith("+") && (sawHunk || !line.startsWith("+++"))) {
        additions++;
        appendRow("add", newLine++, "+", line, 1);
      } else if (line.startsWith("-") && (sawHunk || !line.startsWith("---"))) {
        deletions++;
        appendRow("del", oldLine++, "-", line, 1);
      } else if (sawHunk || line.startsWith(" ")) {
        appendRow("ctx", newLine, " ", line, line.startsWith(" ") ? 1 : 0);
        oldLine++;
        newLine++;
      } else {
        appendRow("ctx", newLine++, " ", line);
      }
    }
  } else if (typeof oldStr === "string" || typeof newStr === "string") {
    if (typeof oldStr === "string" && oldStr.length > 0) {
      const oldLines = splitNormalizedLines(oldStr);
      oldLines.forEach((text, idx) => {
        deletions++;
        appendRow("del", idx + 1, "-", text);
      });
    }
    if (typeof newStr === "string" && newStr.length > 0) {
      const newLines = splitNormalizedLines(newStr);
      newLines.forEach((text, idx) => {
        additions++;
        appendRow("add", idx + 1, "+", text);
      });
    }
  }

  return { rows, rowCount, additions, deletions, isBinary };
}

function apply(source, ctx) {
  // 1. Dynamically resolve external chunk imports via semantic AST queries
  let checkpointSummaries = { local: "T3UseCheckpointSummaries" };
  let checkpointDiff = { local: "T3UseCheckpointDiff" };
  let parseCheckpointDiff = { local: "T3ParseCheckpointDiff" };
  let observeIntersection = { local: "T3ObserveIntersection" };

  if (ctx && typeof ctx.ensureChunkImport === "function") {
    checkpointSummaries = ctx.ensureChunkImport(
      {
        pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
        preferredRegex: /^apps\/server\/dist\/client\/assets\/entities-[\w-]+\.js$/,
        includes: ["checkpointSummariesAtom"],
      },
      (local, text, ex, decl) => decl(local)?.includes("checkpointSummariesAtom"),
      "T3UseCheckpointSummaries",
      "checkpoint summaries"
    );

    checkpointDiff = ctx.ensureChunkImport(
      {
        pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
        preferredRegex: /^apps\/server\/dist\/client\/assets\/queries-[\w-]+\.js$/,
        includes: ["toTurnCount", "ignoreWhitespace"],
      },
      (local, text, ex, decl) => decl(local)?.includes("fromTurnCount") && decl(local)?.includes("toTurnCount"),
      "T3UseCheckpointDiff",
      "checkpoint diff query"
    );

    parseCheckpointDiff = ctx.ensureChunkImport(
      {
        pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
        preferredRegex: /^apps\/server\/dist\/client\/assets\/diffRendering-[\w-]+\.js$/,
        includes: ["diff-panel", "cacheKeyPrefix"],
      },
      (local, text, ex, decl) => decl(local)?.includes("diff-panel") && decl(local)?.includes("cacheKeyPrefix"),
      "T3ParseCheckpointDiff",
      "diff parser"
    );

    observeIntersection = ctx.ensureChunkImport(
      {
        pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
        preferredRegex: /^apps\/server\/dist\/client\/assets\/observeIntersection-[\w-]+\.js$/,
        includes: ["IntersectionObserver"],
      },
      (local, text, ex, decl) => decl(local)?.includes("IntersectionObserver"),
      "T3ObserveIntersection",
      "intersection observer"
    );
  }

  // 2. Dynamically resolve React, JSX, and compiler bindings
  const reactBindings = ctx?.resolveReactBindings ? ctx.resolveReactBindings() : {};
  const reactVar = reactBindings.react || source.match(/(?:\(0,([A-Za-z_$][\w$]*)\.(?:useState|useRef|useEffect|useMemo|memo)\))/)?.[1] || "$";
  const jsxVar = reactBindings.jsx || source.match(/\(0,([A-Za-z_$][\w$]*)\.jsxs?\)\(/)?.[1] || "Q";

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

  const piMatch = bmBody.match(/=([A-Za-z_$][\w$]*)\(\w+,\s*\w+\?\.detail\)/);
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

  const encFn = ctx?.findEnclosingFunction ? ctx.findEnclosingFunction(seMatch.index) : null;
  const thBody = encFn ? source.slice(encFn.start, seMatch.index) : source.slice(Math.max(0, seMatch.index - 12000), seMatch.index);

  const workEntryVar = thBody.match(/workEntry:([A-Za-z_$][\w$]*)/)?.[1] || "n";
  const workspaceRootVar = thBody.match(/workspaceRoot:([A-Za-z_$][\w$]*)/)?.[1] || "r";
  const expandedVar = thBody.match(/"aria-expanded":([A-Za-z_$][\w$]*)/)?.[1] || "x";
  const tlCtxVar = thBody.match(/\b([A-Za-z_$][\w$]*)\.markdownCwd\b/)?.[1] || "a";

  // 5. Dynamically resolve Ur (relPath) and fs (formatCompact)
  const fsMatch = source.match(/children:\[`\+`,([A-Za-z_$][\w$]*)\(\w+\.additions/);
  const fsFn = fsMatch?.[1] || "fs";

  const urMatch = source.match(/\b([A-Za-z_$][\w$]*)\(\w+\.fileName,\s*\w+\.workspaceRoot\)/);
  const urFn = urMatch?.[1] || "Ur";

  // 6. Perform AST replacements
  const gateReplacement = `${gateC}=!${gateA}&&(${boFn}(${gateS})||${gateS}.type===\`file_change\`),${gateMemo}`;
  const panelReplacement = `${inspFull}if(${itemVar}.type===\`file_change\`)return(0,${jsxVar}.jsx)(T3InlineFileDiffCardMemo,{item:${itemVar},projectedItem:${propsVar}.projectedItem,detail:${outputVar},workspaceRoot:${propsVar}.workspaceRoot,cwd:${propsVar}.cwd,onOpenToolDiff:${propsVar}.onOpenToolDiff});`;
  const seReplacement = `${seFull}if(${workEntryVar}.projectedItem?.item?.type===\`file_change\`){${jeVar}=(0,${jsxVar}.jsx)(T3FileChangeRowLabelMemo,{projectedItem:${workEntryVar}.projectedItem,workspaceRoot:${workspaceRootVar},cwd:${tlCtxVar}.markdownCwd,environmentId:${tlCtxVar}.activeThreadEnvironmentId,source:${tlCtxVar}.turnItemSource,expanded:${expandedVar}});}`;

  let patched = source
    .replace(gateFull, () => gateReplacement)
    .replace(inspFull, () => panelReplacement)
    .replace(seFull, () => seReplacement);

  // 7. Bundle runtime asset and emit compact bridge
  const runtimeAsset = ctx?.addRuntimeAsset ? ctx.addRuntimeAsset("inline-diff-ui", getRuntimeSource()) : { specifier: "./inline-diff-ui.mjs" };
  const runtimeImport = `import{createInlineDiffRuntime}from"${runtimeAsset.specifier}";\n`;

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
  formatCompact: ${fsFn},
});
`;

  ctx?.recordInjectedCode?.(bridge);

  return (
    runtimeImport +
    patched.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "") +
    "\n" +
    bridge +
    "\n"
  );
}

const SIDE_REVEAL_MARKER = "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V4";

const sideRevealPatch = {
  id: "inline-file-diff-side-reveal",
  name: "侧栏展开此次编辑的 Diff",
  marker: SIDE_REVEAL_MARKER,
  legacyMarkers: [
    "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V1",
    "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V2",
    "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V3",
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
    const vMatch = source.match(new RegExp(`([A-Za-z_$][\\w$]*)=${B}\\.kind===\`tool-call\`\\?${B}:null,([A-Za-z_$][\\w$]*)=\\1\\?void 0:([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*)=${B}\\.kind===\`branch\``));
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
    const g = mMatch[3];

    const kMatch = source.match(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\?\?[A-Za-z_$][\w$]*\.diffIgnoreWhitespace/);
    assert(kMatch, "Could not resolve diffIgnoreWhitespace in DiffPanel");
    const k = kMatch[1];

    const wnMatch = source.match(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\?\.cwd\?\?[A-Za-z_$][\w$]*,([A-Za-z_$][\w$]*)=/);
    assert(wnMatch, "Could not resolve cwd and isRepo in DiffPanel");
    const [___, wn, Tn] = wnMatch;

    const rMatch = source.match(/let\s+([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*=\1\[0\]/);
    assert(rMatch, "Could not resolve sorted turns array in DiffPanel");
    const R = rMatch[1];

    // 3. Anchor 2: turnFetchTail & related vars
    const gMatch = source.match(/let\s+([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*=\1\?\.checkpointTurnCount,([A-Za-z_$][\w$]*)=/);
    assert(gMatch, "Could not resolve turn diff and scope key variables in DiffPanel");
    const [____, G, Sr] = gMatch;

    const kCrMatch = source.match(new RegExp(`([A-Za-z_$][\\w$]*)=[A-Za-z_$][\\w$]*\\?\`[^\`]*\\$\\{${Sr}\\}\`:null,([A-Za-z_$][\\w$]*)=\\1\\?\\?${Sr}`));
    assert(kCrMatch, "Could not resolve composite thread scope key variables in DiffPanel");
    const [_____, K, Cr] = kCrMatch;

    const jMatch = source.match(new RegExp(`([A-Za-z_$][\\w$]*)\\?\`\\$\\{\\1\\.environmentId\\}:\\$\\{\\1\\.threadId\\}:\\$\\{${Sr}\\}\``));
    assert(jMatch, "Could not resolve thread context in DiffPanel");
    const jVar = jMatch[1];

    const turnTailRegex = new RegExp(`let\\s+([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\(([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*)\\),([A-Za-z_$][\\w$]*)=`);
    const turnTailMatch = source.match(turnTailRegex);
    assert(turnTailMatch, "Could not locate turnFetchTail anchor in DiffPanel");
    const [turnTailFull, Nr, He, Ar, Mr, Pr] = turnTailMatch;

    // 4. Anchor 3: hideFilter
    const hideRegex = new RegExp(`([A-Za-z_$][\\w$]*)=e=>\\{let\\s+t=([A-Za-z_$][\\w$]*)\\(e\\);return!([A-Za-z_$][\\w$]*)\\|\\|t===${vr}\\|\\|!([A-Za-z_$][\\w$]*)\\(t\\)\\}`);
    const hideMatch = source.match(hideRegex);
    assert(hideMatch, "Could not locate hideFilter anchor in DiffPanel");
    const [hideFull, Qi, A, ze, Ye] = hideMatch;

    // 5. Anchor 4: reveal
    const revRegex = new RegExp(`if\\(!${vr}\\)\\{([A-Za-z_$][\\w$]*)\\.current=null;return\\}let\\s+e=JSON\\.stringify\\(\\[${K},${vr},${yr}\\]\\);\\1\\.current!==e&&([A-Za-z_$][\\w$]*)\\(${vr}\\)&&\\(\\1\\.current=e\\)`);
    const revMatch = source.match(revRegex);
    assert(revMatch, "Could not locate reveal anchor in DiffPanel");
    const [revFull, xa, ba] = revMatch;

    const jiMatch = source.match(new RegExp(`let\\s+t=([A-Za-z_$][\\w$]*)\\.findIndex\\(t=>${A}\\(t\\.fileDiff\\)===e\\)`));
    assert(jiMatch, "Could not resolve file diff list array in DiffPanel");
    const Ji = jiMatch[1];

    const qtMatch = source.match(/[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\?\.type===`file_change`\?([A-Za-z_$][\w$]*)\(/);
    assert(qtMatch, "Could not resolve extractToolPatch function in DiffPanel");
    const Qt = qtMatch[1];

    const leMatch = source.match(/:([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\?void 0:[A-Za-z_$][\w$]*,`diff-panel:\${[A-Za-z_$][\w$]*}`/);
    assert(leMatch, "Could not resolve parsePatch function in DiffPanel");
    const Le = leMatch[1];

    // 6. Replacements
    const selReplacement = `/* ${SIDE_REVEAL_MARKER} */let t3RawZ=${V},t3Fb=t3PickToolDiffFallback({rawZ:t3RawZ,sn:${fr},cn:${pr},I:${wn},f:${g},O:${k},ln:${Tn},P:${N},N:${M},V:${R}}),t3GitMode=t3Fb?.mode??null;if(t3GitMode===\`unstaged\`){${H}=!0;${V}=null;${lr}=${an}}else if(t3GitMode===\`turn\`){${H}=!1;${V}=null;${lr}=${an}}let ${gr}=${B}.kind===\`turn\`?${B}.turnId:t3Fb?.turnId??null,${_r}=t3GitMode===\`unstaged\`?\`unstaged\`:${B}.kind===\`unstaged\`||${B}.kind===\`commit\`?${B}.kind:\`branch\`,${U}=${B}.kind===\`commit\`?${B}.sha:null,${W}=${B}.kind===\`branch\`||${B}.kind===\`commit\`?${B}.baseRef:null,${vr}=t3RawZ?.revealRequestId?(t3RawZ.filePath?t3NormDiffPath(t3RawZ.filePath):null):${B}.kind===\`turn\`?${B}.filePath??null:null,${yr}=t3RawZ?.revealRequestId??(${B}.kind===\`turn\`?${B}.revealRequestId:0)`;

    const turnFetchTailReplacement = `let ${Nr}=${He}(${Ar},${Mr});if(t3GitMode===\`turn\`&&!${Nr}.isPending&&(${Nr}.error||!t3PatchHasFile(${Nr}.data?.diff,${vr},${k},${g}))&&t3Fb.canUnstaged){t3GitMode=\`unstaged\`;${H}=!0;${_r}=\`unstaged\`;${G}=void 0;${gr}=null;${Sr}=\`unstaged\`;${K}=${jVar}?\`\${${jVar}.environmentId}:\${${jVar}.threadId}:\${${Sr}}\`:null;${Cr}=${K}??${Sr}}let ${Pr}=`;

    const hideReplacement = `${Qi}=e=>{let t=${A}(e);return!${ze}||(Boolean(${vr})&&t3DiffMatchesTarget(t,${vr},${g}))||!${Ye}(t)}`;

    const revReplacement = `let path=(()=>{if(!t3RawZ?.revealRequestId)return ${vr};let hit=${vr}?${Ji}.find(x=>${A}(x.fileDiff)===${vr})||${Ji}.find(x=>t3DiffMatchesTarget(${A}(x.fileDiff),${vr},${g})):${Ji}[0];return hit?${A}(hit.fileDiff):!t3GitMode&&${Ji}.length===1?${A}(${Ji}[0].fileDiff):${vr}})();if(!path){${xa}.current=null;return}let e=JSON.stringify([${K},path,${yr}]);${xa}.current!==e&&${ba}(path)&&(${xa}.current=e)`;

    let patched = source
      .replace(selFull, () => selReplacement)
      .replace(turnTailFull, () => turnFetchTailReplacement)
      .replace(hideFull, () => hideReplacement)
      .replace(revFull, () => revReplacement);

    const runtimeAsset = ctx?.addRuntimeAsset ? ctx.addRuntimeAsset("inline-diff-ui", getRuntimeSource()) : { specifier: "./inline-diff-ui.mjs" };
    const runtimeImport = `import{createSideRevealHelpers}from"${runtimeAsset.specifier}";\n`;

    const sideRevealBridge = `/* ${SIDE_REVEAL_MARKER} */
const { t3NormDiffPath, t3DiffMatchesTarget, t3PatchHasFile, t3PickToolDiffFallback } = createSideRevealHelpers({
  extractToolPatch: ${Qt},
  parsePatch: ${Le},
  getFileName: ${A},
});
`;

    ctx?.recordInjectedCode?.(sideRevealBridge);

    return (
      runtimeImport +
      patched.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "") +
      "\n" +
      sideRevealBridge +
      "\n"
    );
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
    return source.replace(full, replacement).replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "");
  },
};

module.exports = {
  id: ID,
  name: "文件编辑内联 Diff 预览与侧栏定位",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetSpec: TARGET_SPEC,
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  apply,
  t3ParseUnifiedDiff,
  sideRevealPatch,
  quietReviewToastPatch,
};

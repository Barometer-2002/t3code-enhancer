"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { tokenize, findEnclosingFunction } = require("../js-ast.cjs");

const ID = "timeline-collapse";
const NAME = "收起上级联动收起下级 + 一级工具列表平铺展开 + 同文件折叠";
const MARKER = "T3_TIMELINE_CASCADE_V6";
const LEGACY_MARKERS = ["T3_TIMELINE_CASCADE_V1", "T3_TIMELINE_CASCADE_V2", "T3_TIMELINE_CASCADE_V3", "T3_TIMELINE_CASCADE_V4", "T3_TIMELINE_CASCADE_V5"];
const TARGET_REGEX = /^apps\/server\/dist\/client\/assets\/ReadOnlyThreadTimeline-[\w-]+\.js$/;
const TARGET_SPEC = {
  pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
  preferredRegex: /^apps\/server\/dist\/client\/assets\/ReadOnlyThreadTimeline-[\w-]+\.js$/,
  includes: ["Tool calls", "turn-fold:", "attempt-fold:"],
};
const ORIGINAL_HASH = "4f05fa222be71b9cb2fc21f98580cc78c11453e98e06285456718594b0082231";

const runtimeSource = fs.readFileSync(path.join(__dirname, "../runtime/timeline-ui.mjs"), "utf8");

// Synchronously evaluate pure helpers in this realm for Node 20+ CJS exports
const runtimeStripped = runtimeSource.replace(/^export\s+(function|const|let|var)\s+/gm, "$1 ");
const runtimeExports = vm.runInThisContext(
  "(function() {\n" +
  runtimeStripped +
  "\nreturn { disclosureIds, resetHiddenDisclosures, updateDisclosure, t3NormFilePath, t3ExtractWorkEntryPaths, t3GetFoldableFileInfo, t3FormatReadRanges, t3AggregateEditStats, groupSameFileEntries, createTimelineRuntime };\n})()"
);
const {
  disclosureIds,
  resetHiddenDisclosures,
  updateDisclosure,
  t3NormFilePath,
  t3ExtractWorkEntryPaths,
  t3GetFoldableFileInfo,
  t3FormatReadRanges,
  t3AggregateEditStats,
  groupSameFileEntries,
  createTimelineRuntime,
} = runtimeExports;

function apply(source, ctx) {
  const tokens = ctx?.getTokens ? ctx.getTokens() : tokenize(source);
  const reactBindings = ctx?.resolveReactBindings ? ctx.resolveReactBindings() : null;
  const jsxVar = reactBindings?.jsx || source.match(/\(0,([A-Za-z_$][\w$]*)\.jsxs?\)\(/)?.[1] || "Q";
  const reactVar = reactBindings?.react || source.match(/(?:\(0,([A-Za-z_$][\w$]*)\.(?:useState|useRef|useEffect|useMemo|useLayoutEffect|memo|createContext)\)|([A-Za-z_$][\w$]*)\.(?:Suspense|Fragment|memo|useState|useRef))/)?.[1] || "$";

  // 1. Tool group component
  const tcPos = source.indexOf("Tool calls");
  assert(tcPos >= 0, "Could not locate Tool calls anchor");
  const tgFn = findEnclosingFunction(source, tcPos, tokens);
  assert(tgFn && tgFn.name, "Could not locate tool group component function");
  const toolGroupVar = tgFn.name;
  const tgSrc = tgFn.source;

  const timelineCtx = tgSrc.match(/\(0,[A-Za-z_$][\w$]*\.use\)\(([A-Za-z_$][\w$]*)\)/)?.[1];
  assert(timelineCtx, "Could not resolve timelineCtx from tool group");
  const useI18n = tgSrc.match(/=([A-Za-z_$][\w$]*)\(\)/)?.[1];
  assert(useI18n, "Could not resolve useI18n from tool group");
  const viewedImagesHook = tgSrc.match(/=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\),/)?.[1];
  assert(viewedImagesHook, "Could not resolve viewedImagesHook from tool group");
  const workGroupCtx = tgSrc.match(/\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{value:/)?.[1];
  assert(workGroupCtx, "Could not resolve workGroupCtx from tool group");
  const toolGroupContainer = tgSrc.match(/\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{children:\(0,/)?.[1];
  assert(toolGroupContainer, "Could not resolve toolGroupContainer from tool group");
  const workEntryRow = tgSrc.match(/\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{workEntry:/)?.[1];
  assert(workEntryRow, "Could not resolve workEntryRow from tool group");

  // 2. WorkEntryRow inner elements
  let thSrc = "";
  const thMatch = source.match(/function\s+([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\)\{[^}]*workEntry:[A-Za-z_$][\w$]*,workspaceRoot:[A-Za-z_$][\w$]*/);
  if (thMatch) {
    const thFn = findEnclosingFunction(source, thMatch.index + 10, tokens);
    if (thFn) thSrc = thFn.source;
  }

  const WorkRow = thSrc.match(/\(0,[A-Za-z_$][\w$]*\.jsxs?\)\(([A-Za-z_$][\w$]*),\{[^}]*"data-v2-item-type":/)?.[1]
    || source.match(/\(0,[A-Za-z_$][\w$]*\.jsxs?\)\(([A-Za-z_$][\w$]*),\{[^}]*"data-v2-item-type":/)?.[1];
  assert(WorkRow, "Could not resolve WorkRow");

  const WorkIcon = thSrc.match(/\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{[^}]*fallbackName:/)?.[1]
    || source.match(/\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{[^}]*fallbackName:/)?.[1];
  assert(WorkIcon, "Could not resolve WorkIcon");

  const ChevronRight = thSrc.match(/\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{[^}]*rotate-90/)?.[1]
    || source.match(/\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{[^}]*rotate-90/)?.[1];
  assert(ChevronRight, "Could not resolve ChevronRight");

  const Timestamp = thSrc.match(/\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{[^}]*timestampFormat:/)?.[1]
    || source.match(/\(0,[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{[^}]*timestampFormat:/)?.[1];
  assert(Timestamp, "Could not resolve Timestamp");

  // 3. Cross-chunk semantic resolution / structural fallbacks
  let resolveRelPath = null;
  if (ctx?.asar && ctx?.resolveImportedAlias) {
    try {
      resolveRelPath = ctx.resolveImportedAlias(/\.\/ChatMarkdown/, (l, t, e, decl) => decl(l)?.includes("toLowerCase():"), "resolveRelPath").local;
    } catch {}
  }
  if (!resolveRelPath) {
    resolveRelPath = source.match(/([A-Za-z_$][\w$]*)\([^,)]*\.(?:filePath|path)\s*,\s*[^,)]*\.workspaceRoot\)/)?.[1];
  }
  assert(resolveRelPath, "Could not resolve resolveRelPath (Ur)");

  let getAction = null;
  if (ctx?.asar && ctx?.resolveImportedAlias) {
    try {
      getAction = ctx.resolveImportedAlias(/\.\/session-logic/, (l, t, e, decl) => decl(l)?.includes(".action??="), "getAction").local;
    } catch {}
  }
  if (!getAction) {
    getAction = source.match(/let\s+([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\);if\(\1===["\x27\x60]code-search["\x27\x60]/)?.[2];
  }
  assert(getAction, "Could not resolve getAction (Dn)");

  let isEntryFailed = null;
  if (ctx?.asar && ctx?.resolveImportedAlias) {
    try {
      isEntryFailed = ctx.resolveImportedAlias(/\.\/session-logic/, (l, t, e, decl) => decl(l)?.includes(".displayFailure??="), "isEntryFailed").local;
    } catch {}
  }
  if (!isEntryFailed) {
    isEntryFailed = source.match(/hasFailure:[^&]*&&\s*([A-Za-z_$][\w$]*)\(/)?.[1];
  }
  assert(isEntryFailed, "Could not resolve isEntryFailed (Ln)");

  let extractPaths = null;
  if (ctx?.asar && ctx?.resolveImportedAlias) {
    try {
      extractPaths = ctx.resolveImportedAlias(/\.\/session-logic/, (l, t, e, decl) => decl(l)?.includes("new Set,0)"), "extractPaths").local;
    } catch {}
  }
  if (!extractPaths) {
    extractPaths = source.match(/([A-Za-z_$][\w$]*)\(\{\s*input\s*:/)?.[1];
  }
  assert(extractPaths, "Could not resolve extractPaths (Wn)");

  let extractReadDetailPath = null;
  if (ctx?.asar && ctx?.resolveImportedAlias) {
    try {
      extractReadDetailPath = ctx.resolveImportedAlias(/\.\/session-logic/, (l, t, e, decl) => decl(l)?.includes("viewedImagePath"), "extractReadDetailPath").local;
    } catch {}
  }
  if (!extractReadDetailPath) {
    extractReadDetailPath = source.match(/let\s+[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\),\s*[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.structuredPayload/)?.[1];
  }
  assert(extractReadDetailPath, "Could not resolve extractReadDetailPath (Mn)");

  // 4. Disclosure callback block
  const handlersPattern = /let\s+([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*);.*?turn-fold:\$\{.*?([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*=>\{let\s+[A-Za-z_$][\w$]*=new Set.*?;let\s+([A-Za-z_$][\w$]*)=\3,([A-Za-z_$][\w$]*);.*?\1\([A-Za-z_$][\w$]*,([A-Za-z_$][\w$]*)\.has\(.*?([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*=>\{let\s+[A-Za-z_$][\w$]*=new Set.*?;let\s+([A-Za-z_$][\w$]*)=\6,([A-Za-z_$][\w$]*);.*?attempt-fold:\$\{.*?([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*=>\{let\s+[A-Za-z_$][\w$]*=new Set.*?;let\s+([A-Za-z_$][\w$]*)=\10,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\?\.runId/;
  const hMatch = source.match(handlersPattern);
  assert(hMatch, "Could not locate disclosure handlers block");
  const [hFull, mn, pn, hn, Ot, gn, _n, At, jt, vn, yn, Pt, bn, xn, F] = hMatch;
  const hStart = hMatch.index;
  const hEnd = hStart + hFull.length;

  // 5. rowsAnchor & Kn
  const rowsPattern = /let\s+([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\(`\$\{[A-Za-z_$][\w$]*\}\\0\$\{[A-Za-z_$][\w$]*\?\?``\}`,([A-Za-z_$][\w$]*)\),[A-Za-z_$][\w$]*\),([A-Za-z_$][\w$]*);/;
  const rMatch = source.match(rowsPattern);
  assert(rMatch, "Could not locate rows projection anchor");
  const [rowsAnchor, qn, Kn] = rMatch;
  assert(source.indexOf(rowsAnchor) === source.lastIndexOf(rowsAnchor), "Rows projection anchor must be unique");

  const knPattern = new RegExp(`${Kn}=\\{[^}]*expandedRunIds:([A-Za-z_$][\\w$]*)[^}]*expandedAttemptIds:([A-Za-z_$][\\w$]*)`);
  const knMatch = source.match(knPattern);
  assert(knMatch, "Could not locate Kn declaration");
  const [, expandedRunIdsVar, expandedAttemptIdsVar] = knMatch;

  const xfMatch = source.match(/function\s+([A-Za-z_$][\w$]*)\([^)]*\)\{[^}]*&&[A-Za-z_$][\w$]*\.runId!==null&&[A-Za-z_$][\w$]*\.add\([A-Za-z_$][\w$]*\.runId\)/);
  assert(xfMatch, "Could not locate projection function xf");
  const xf = xfMatch[1];

  const qtMatch = source.match(/let\s*\{[^}]*workGroupViewState:([A-Za-z_$][\w$]*)\}\s*=/);
  assert(qtMatch, "Could not locate workGroupViewState (Qt)");
  const Qt = qtMatch[1];

  const jaMatch = source.match(/import\s*\{[^}]*\bas\s+([A-Za-z_$][\w$]*)\}\s*from\s*["\x27\x60]\.\/useStableCallback[^"\x27\x60]*["\x27\x60]/);
  assert(jaMatch, "Could not locate useStableCallback import (Ja)");
  const Ja = jaMatch[1];

  const callbacks = `
/* ${MARKER} */
const clearHiddenTimelineRows = (nextProjection) => {
  const changed = resetHiddenDisclosures(${qn}, ${xf}(nextProjection), ${Qt});
  if (changed.hiddenAttempts.size) ${Pt}(ids => new Set([...ids].filter(id => !changed.hiddenAttempts.has(id))));
  if (changed.hiddenGroups.size) ${jt}(ids => new Set([...ids].filter(id => !changed.hiddenGroups.has(id))));
};
const ${gn} = ${Ja}(id => {
  ${mn}(\`turn-fold:\${id}\`);
  if (${expandedRunIdsVar}.has(id)) clearHiddenTimelineRows({ ...${Kn}, expandedRunIds: updateDisclosure(${expandedRunIdsVar}, id) });
  ${Ot}(ids => updateDisclosure(ids, id));
});
const ${vn} = ${Ja}((id, rowId) => {
  ${mn}(rowId, ${At}.has(id) ? undefined : { contentKey: \`\${id}:details\` });
  if (${At}.has(id)) clearHiddenTimelineRows({ ...${Kn}, expandedWorkGroupIds: updateDisclosure(${At}, id) });
  ${jt}(ids => updateDisclosure(ids, id));
});
const ${bn} = ${Ja}(id => {
  ${mn}(\`attempt-fold:\${id}\`);
  if (${expandedAttemptIdsVar}.has(id)) clearHiddenTimelineRows({ ...${Kn}, expandedAttemptIds: updateDisclosure(${expandedAttemptIdsVar}, id) });
  ${Pt}(ids => updateDisclosure(ids, id));
});
`;

  const flatToolGroupFn =
    `var ${toolGroupVar}=(0,${reactVar}.memo)(function(e){` +
    `let{disclosureAnchorKey:r,entries:i,groupedEntries:a,workspaceRoot:o}=e,` +
    `{workGroupViewState:s,onToggleWorkEntry:c,onWorkEntryContentReady:l}=(0,${reactVar}.use)(${timelineCtx}),` +
    `u=${useI18n}(),w=${viewedImagesHook}(a),` +
    `O=(0,${reactVar}.useMemo)(()=>({state:s,viewedImages:w,onToggleEntry:(t,n)=>c(r,t,n),onContentReady:t=>l?.(r,t)}),[s,w,r,c,l]),` +
    `k=(0,${reactVar}.useMemo)(()=>t3RenderSameFileChildren(i,o),[i,o]);` +
    `return(0,${jsxVar}.jsx)(${workGroupCtx},{value:O,children:(0,${jsxVar}.jsx)(${toolGroupContainer},{children:(0,${jsxVar}.jsx)(\`div\`,{role:\`region\`,"aria-label":u(\`Tool calls\`),"data-tool-group-scroll":!0,className:\`t3e-tool-group-flat\`,children:k})})})});`;

  const bridge = `
const { T3SameFileGroup, t3RenderSameFileChildren } = createTimelineRuntime({
  React: ${reactVar},
  jsx: ${jsxVar}.jsx,
  jsxs: ${jsxVar}.jsxs,
  Fragment: ${jsxVar}.Fragment,
  workGroupCtx: ${workGroupCtx},
  timelineCtx: ${timelineCtx},
  useI18n: ${useI18n},
  isEntryFailed: ${isEntryFailed},
  getAction: ${getAction},
  extractPaths: ${extractPaths},
  extractReadDetailPath: ${extractReadDetailPath},
  resolveRelPath: ${resolveRelPath},
  WorkRow: ${WorkRow},
  WorkIcon: ${WorkIcon},
  ChevronRight: ${ChevronRight},
  Timestamp: ${Timestamp},
  WorkEntryRow: ${workEntryRow},
});
`;

  // Splicing: apply non-overlapping replacements in descending offset order
  const splices = [
    { start: hStart, end: hEnd, text: `let ${mn}=${pn},${xn}=${F}?.runId` },
    { start: tgFn.start, end: tgFn.end, text: flatToolGroupFn },
  ].sort((a, b) => b.start - a.start);
  assert(splices[0].start >= splices[1].end, "Overlapping splices in timeline-collapse");
  let patched = source;
  for (const sp of splices) {
    patched = patched.slice(0, sp.start) + sp.text + patched.slice(sp.end);
  }
  patched = patched.replace(rowsAnchor, () => rowsAnchor + callbacks);

  if (ctx?.entry && typeof ctx.addRuntimeAsset === "function") {
    const asset = ctx.addRuntimeAsset("timeline-ui", runtimeSource);
    const importStmt = `import { createTimelineRuntime, disclosureIds, resetHiddenDisclosures, updateDisclosure } from "${asset.specifier}";\n`;
    patched = importStmt + patched.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "") + "\n" + bridge + "\n";
  } else {
    const inlinedModule = runtimeSource.replace(/^export\s+(function|const|let|var)\s+/gm, "$1 ");
    patched = patched.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "") + "\n" + inlinedModule + "\n" + bridge + "\n";
  }

  if (ctx?.recordInjectedCode) {
    ctx.recordInjectedCode(callbacks);
    ctx.recordInjectedCode(bridge);
  }

  return patched;
}

const summaryPatch = {
  id: "timeline-collapse-summary",
  name: "同文件操作摘要去重计数",
  marker: "T3_TIMELINE_SUMMARY_V2",
  legacyMarkers: ["T3_TIMELINE_SUMMARY_V1"],
  targetRegex: /^apps\/server\/dist\/client\/assets\/session-logic-[\w-]+\.js$/,
  targetSpec: {
    pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
    preferredRegex: /^apps\/server\/dist\/client\/assets\/session-logic-[\w-]+\.js$/,
    includes: ["changedFiles", "relativePath", "file_path"],
  },
  originalHash: "ca0ac189d429d0495b25a14e2d65cf894bb634561dc4504582649cbd1e89c6bb",
  apply(source, ctx) {
    const keysMatch = source.match(/var\s+([A-Za-z_$][\w$]*)=\[`path`,`filePath`,`file_path`,`relativePath`,`filename`,`fileName`,`newPath`,`oldPath`\];/);
    assert(keysMatch, "Could not locate session-logic path keys anchor");
    const keysAnchor = keysMatch[0];
    const keysVar = keysMatch[1];

    const extractMatch = source.match(/function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let\s+[A-Za-z_$][\w$]*=\[\];return\s+[A-Za-z_$][\w$]*\(\2,[A-Za-z_$][\w$]*,new Set,0\),[A-Za-z_$][\w$]*\}/);
    assert(extractMatch, "Could not locate session-logic extractFn");
    const extractFn = extractMatch[1];

    const countMatch = source.match(/function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(\2!==`edit`\)return\s+\3\.length;let\s+[A-Za-z_$][\w$]*=new Set,[A-Za-z_$][\w$]*=0;for\(let\s+[A-Za-z_$][\w$]*\s+of\s+\3\)if\(![A-Za-z_$][\w$]*\.changedFiles\|\|[A-Za-z_$][\w$]*\.changedFiles\.length===0\)[A-Za-z_$][\w$]*\+=1;else for\(let\s+[A-Za-z_$][\w$]*\s+of\s+[A-Za-z_$][\w$]*\.changedFiles\)[A-Za-z_$][\w$]*\.add\([A-Za-z_$][\w$]*\);return\s+[A-Za-z_$][\w$]*\.size\+[A-Za-z_$][\w$]*\}/);
    assert(countMatch, "Could not locate session-logic We count anchor");
    const countAnchor = countMatch[0];
    const countFn = countMatch[1];

    const vMatch = source.match(/function\s+([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\)\{[^}]*?dynamic_tool`\?[A-Za-z_$][\w$]*\.input:[A-Za-z_$][\w$]*\?\.arguments\?\?[A-Za-z_$][\w$]*\?\.input\?\?[A-Za-z_$][\w$]*\?\.rawInput\}/);
    assert(vMatch, "Could not locate session-logic V (tool input extractor)");
    const V = vMatch[1];

    const beMatch = source.match(/function\s+([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\)\{if\([A-Za-z_$][\w$]*\.toolLifecycleStatus===`failed`\)return null;let\s+[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.viewedImagePath\?\.trim\(\);/);
    assert(beMatch, "Could not locate session-logic Be (read detail extractor)");
    const Be = beMatch[1];

    const normHelper = "let norm=p=>{let s=String(p??``).trim().replaceAll(`\\\\`, `/`).replace(/^\\.\\//,``);return/^[A-Za-z]:\\//.test(s)?s.toLowerCase():s};";
    const replacementBe =
      `function ${countFn}(e,t){/* ${summaryPatch.marker} */` +
      normHelper +
      `if(e===\`edit\`){let n=new Set,r=0;for(let e of t){let i=(e.changedFiles?.length??e.changedFiles?.size??0)>0?e.changedFiles:${extractFn}(${V}(e));if(!i||(i.length??i.size??0)===0)r+=1;else for(let t of i)n.add(norm(t))}return n.size+r}` +
      `if(e===\`read\`){let n=new Set,r=0;for(let e of t){let i=${Be}(e),a=i?[i]:${extractFn}({input:${V}(e),detail:e.detail});if(!a||(a.length??a.size??0)===0)r+=1;else for(let t of a)n.add(norm(t))}return n.size+r}` +
      "return t.length}";

    const replacementKeys = `var ${keysVar}=[\`path\`,\`Path\`,\`filePath\`,\`file_path\`,\`relativePath\`,\`filename\`,\`fileName\`,\`targetFile\`,\`target_file\`,\`targetPath\`,\`target_path\`,\`newPath\`,\`oldPath\`];`;

    const patched = source
      .replace(keysAnchor, replacementKeys)
      .replace(countAnchor, replacementBe)
      .replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "");

    if (ctx?.recordInjectedCode) {
      ctx.recordInjectedCode(replacementBe);
    }

    return patched;
  },
};

module.exports = {
  id: ID,
  name: NAME,
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: TARGET_REGEX,
  targetSpec: TARGET_SPEC,
  originalHash: ORIGINAL_HASH,
  apply,
  summaryPatch,
  disclosureIds,
  resetHiddenDisclosures,
  updateDisclosure,
  t3NormFilePath,
  t3ExtractWorkEntryPaths,
  t3GetFoldableFileInfo,
  t3FormatReadRanges,
  t3AggregateEditStats,
  groupSameFileEntries,
};

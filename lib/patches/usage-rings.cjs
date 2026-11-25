"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  tokenize,
  parseImports,
  findUniqueFunction,
  findEnclosingFunction,
} = require("../js-ast.cjs");

const ID = "usage-rings";
const NAME = "加号菜单 + 常驻权限 + 合一模型/思考深度面板 + 模型联动双环与统计";
const MARKER = "T3_USAGE_RINGS_V24";
const LEGACY_MARKERS = [
  "T3_USAGE_RINGS_V1",
  "T3_USAGE_RINGS_V2",
  "T3_USAGE_RINGS_V3",
  "T3_USAGE_RINGS_V4",
  "T3_USAGE_RINGS_V5",
  "T3_USAGE_RINGS_V6",
  "T3_USAGE_RINGS_V7",
  "T3_USAGE_RINGS_V8",
  "T3_USAGE_RINGS_V9",
  "T3_USAGE_RINGS_V10",
  "T3_USAGE_RINGS_V11",
  "T3_USAGE_RINGS_V12",
  "T3_USAGE_RINGS_V13",
  "T3_USAGE_RINGS_V14",
  "T3_USAGE_RINGS_V15",
  "T3_USAGE_RINGS_V16",
  "T3_USAGE_RINGS_V17",
  "T3_USAGE_RINGS_V18",
  "T3_USAGE_RINGS_V19",
  "T3_USAGE_RINGS_V20",
  "T3_USAGE_RINGS_V21",
  "T3_USAGE_RINGS_V22",
  "T3_USAGE_RINGS_V23",
];
const TARGET_REGEX = /^apps\/server\/dist\/client\/assets\/ThreadRouteView-[\w-]+\.js$/;
const TARGET_SPEC = {
  pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
  preferredRegex: /^apps\/server\/dist\/client\/assets\/ThreadRouteView-[\w-]+\.js$/,
  includes: ["data-chat-composer-form", "data-composer-permissions-trigger"],
};
const ORIGINAL_HASH = "d54743d08ba7971a22d5dc50a422f1974e3db92b1c277b3e72645fbe2e5b74ce";

const RUNTIME_PATH = path.join(__dirname, "../runtime/usage-rings-ui.mjs");
function getRuntimeSource() {
  return fs.readFileSync(RUNTIME_PATH, "utf8");
}

// --- Pure Helper Functions (also exported for external callers & testing) ---

function t3ClassifyWindow(w) {
  const text = `${w?.id || ""} ${w?.label || ""}`.toLowerCase();
  if (/(?:5[- ]?hour|\b5h\b|session|hourly|short)/.test(text)) return "short";
  if (/(?:weekly|7[- ]?day|\b7d\b|monthly|long)/.test(text)) return "long";
  return "unknown";
}

function t3BaseWindowName(label) {
  const cleaned = String(label || "")
    .replace(/\s*[·•\-–(]?\s*(?:5[- ]?hour|5h|session|weekly|7[- ]?day|7d|daily|monthly)\s*\)?/gi, "")
    .replace(/\s*[·•\-–]+\s*$/g, "")
    .replace(/^\s*[·•\-–]+\s*/g, "")
    .trim();
  const zh = typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
  return cleaned || (zh ? "配额" : "Quota");
}

function t3PairUsageWindows(windows) {
  const groups = new Map();
  const order = [];
  for (const w of windows || []) {
    const base = t3BaseWindowName(w?.label);
    if (!groups.has(base)) {
      groups.set(base, []);
      order.push(base);
    }
    groups.get(base).push(w);
  }
  const result = [];
  for (const base of order) {
    const list = groups.get(base);
    if (list.length === 2) {
      const a = list[0];
      const b = list[1];
      const ca = t3ClassifyWindow(a);
      const cb = t3ClassifyWindow(b);
      let shortW = a;
      let longW = b;
      if (ca === "long" && cb !== "long") {
        shortW = b;
        longW = a;
      } else if (cb === "short" && ca !== "short") {
        shortW = b;
        longW = a;
      } else if (ca === cb) {
        const ta = a?.resetsAt ? Date.parse(a.resetsAt) : Infinity;
        const tb = b?.resetsAt ? Date.parse(b.resetsAt) : Infinity;
        if (Number.isFinite(ta) && Number.isFinite(tb) && tb < ta) {
          shortW = b;
          longW = a;
        }
      }
      result.push({ kind: "dual", key: `${shortW.id}:${longW.id}`, title: base, shortWindow: shortW, longWindow: longW });
    } else {
      for (const w of list) {
        result.push({ kind: "single", key: w.id, title: w.label || base, window: w });
      }
    }
  }
  return result;
}

function t3SelectPrimaryQuotaForModel(paired, activeModel) {
  if (!Array.isArray(paired) || paired.length === 0) return null;
  if (paired.length === 1) return paired[0];

  const modelStr = String(activeModel || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const modelRaw = String(activeModel || "").toLowerCase();
  const modelTokens = modelStr ? modelStr.split(/\s+/).filter(Boolean) : [];
  const hasModelToken = (re) => re.test(modelStr);
  const windowsOf = (item) => item.kind === "dual" ? [item.shortWindow, item.longWindow] : [item.window];
  const exact = modelRaw ? paired.filter((item) => windowsOf(item).some(
    (window) => Array.isArray(window?.modelIds) && window.modelIds.some((id) => String(id).toLowerCase() === modelRaw)
  )) : [];
  if (exact.length) return exact.find((item) => item.kind === "dual") ?? exact[0];

  const isClaude = hasModelToken(/\b(claude|opus|sonnet|haiku)\b/);
  const isGpt = hasModelToken(/\b(gpt|codex|o1|o3|o4)\b/);
  const isGemini = hasModelToken(/\b(gemini|neon|argon|hydrogen|flash)\b/);
  const variants = ["argon", "neon", "hydrogen", "flash", "opus", "sonnet", "haiku", "spark", "mini", "nano", "pro", "ultra"]
    .filter(v => modelTokens.includes(v));

  let bestItem = null;
  let bestScore = -1;

  for (let i = 0; i < paired.length; i++) {
    const item = paired[i];
    const wins = windowsOf(item);
    const winIds = wins.map(w => String(w?.id || "")).join(" ").toLowerCase().replace(/[-_]+/g, " ");
    const text = (
      item.kind === "dual"
        ? `${item.title || ""} ${item.shortWindow?.label || ""} ${item.longWindow?.label || ""} ${winIds}`
        : `${item.title || ""} ${item.window?.label || ""} ${winIds}`
    ).toLowerCase();

    let score = 0;

    for (const v of variants) {
      if (new RegExp(`\\b${v}\\b`).test(text)) score += 120;
    }

    const itemHasOtherVariant = ["argon", "neon", "hydrogen", "flash", "opus", "sonnet", "haiku", "spark"]
      .some(v => new RegExp(`\\b${v}\\b`).test(text) && !variants.includes(v));
    if (itemHasOtherVariant && score < 120) score -= 60;

    if (isClaude && (/\bclaude\b/.test(text) || /\b3p\b/.test(winIds))) score += 60;
    if (isGpt && (/\b(gpt|codex|openai)\b/.test(text) || /\b3p\b/.test(winIds))) score += 60;
    if (isGemini && /\bgemini\b/.test(text)) score += 60;

    const isNamedFamilyPool = /\b(claude|gpt|codex|openai|gemini|argon|neon|hydrogen|opus|sonnet|haiku|flash)\b/.test(text);
    if (!isNamedFamilyPool) score += 20;

    if (item.kind === "dual") score += 8;

    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  return bestItem || paired.find(x => x.kind === "dual") || paired[0];
}

function t3PromptHasToken(prompt, prefix, value) {
  if (!prompt || !value) return false;
  const needle = prefix + value;
  let idx = prompt.indexOf(needle);
  while (idx !== -1) {
    const prev = idx > 0 ? prompt[idx - 1] : "";
    const next = idx + needle.length < prompt.length ? prompt[idx + needle.length] : "";
    const prevOk = !prev || /\s|[(\[{,"']/.test(prev);
    const nextOk = !next || /\s|[)\]},;:"']/.test(next);
    if (prevOk && nextOk) return true;
    idx = prompt.indexOf(needle, idx + 1);
  }
  return false;
}

function t3ThreadCtxKey(tc) {
  if (!tc) return "";
  const envId = tc.threadRef?.environmentId ?? tc.ref?.environmentId ?? tc.thread?.environmentId ?? tc.environmentId;
  const tid = tc.threadRef?.threadId ?? tc.ref?.threadId ?? tc.thread?.threadId ?? tc.threadId;
  if (envId && tid) return envId + ":" + tid;
  if (typeof tc.contextId === "string") {
    if (tc.contextId.startsWith("thread:")) return tc.contextId.slice(7);
    return tc.contextId;
  }
  return "";
}

function t3ReviewCommentPrNum(rc) {
  if (!rc) return null;
  if (typeof rc.number === "number") return rc.number;
  if (typeof rc.prNumber === "number") return rc.prNumber;
  if (typeof rc.pullRequestNumber === "number") return rc.pullRequestNumber;
  if (typeof rc.pullRequest?.number === "number") return rc.pullRequest.number;
  if (typeof rc.url === "string") {
    const m = rc.url.match(/\/(?:pull|pulls|merge_requests)\/(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

function t3EnvCtxId(ec) {
  if (!ec) return "";
  if (ec.environmentId) return ec.environmentId;
  if (ec.env?.environmentId) return ec.env.environmentId;
  if (typeof ec.contextId === "string") {
    const idx = ec.contextId.indexOf(":");
    return idx >= 0 ? ec.contextId.slice(idx + 1) : ec.contextId;
  }
  return "";
}

function t3EnsureEnhancerStyles() {
  if (typeof document === "undefined" || !document.head) return;
  const styleId = "t3-enhancer-rings-style-v4";
  if (document.getElementById(styleId)) return;
  const elStyle = document.createElement("style");
  elStyle.id = styleId;
  elStyle.textContent = `
    .t3e-plus-btn { width: 30px; height: 30px; border: 0; border-radius: 9999px; background-color: transparent; }
  `;
  document.head.appendChild(elStyle);
}

// --- Main Patch Application ---

function apply(source, ctx) {
  const tokens = ctx?.getTokens ? ctx.getTokens() : tokenize(source);
  const imports = ctx?.getImports ? ctx.getImports() : parseImports(tokens);

  // Several chunks can match one pattern (e.g. both runtime-*.js chunks), so search all of them.
  function findImportAlias(specPattern, importedName) {
    for (const imp of imports) {
      if (!specPattern.test(imp.specifier)) continue;
      const spec = imp.specifiers.find((s) => s.imported === importedName);
      if (spec?.local) return spec.local;
    }
    return null;
  }
  // Must not match rolldown-runtime-*.js, which is the bundler helper chunk.
  const RUNTIME_CHUNK = /(?:^|\/)runtime-[\w-]+\.js$/;

  // 1. Resolve React and JSX bindings dynamically
  const { react: reactVar, jsx: jsxVar } = ctx?.resolveReactBindings
    ? ctx.resolveReactBindings()
    : {
        react: source.match(/\b([A-Za-z_$][\w$]*)\.(?:useState|Fragment|useRef|useEffect)\b/)?.[1] || "Z",
        jsx: source.match(/\(0,\s*([A-Za-z_$][\w$]*)\.jsxs?\)\(/)?.[1] || "$",
      };

  // 2. Resolve Anchor 1: Details Panel Replacement (hW / _W)
  const hWFn = findUniqueFunction(
    source,
    (_fn, src) => src.includes("thread-details-usage-heading"),
    "usage-details-component",
    tokens
  );
  const _WFn = findUniqueFunction(
    source,
    (_fn, src) => src.includes("thread-details-context-heading"),
    "context-details-component",
    tokens
  );
  assert(hWFn && _WFn, "Could not locate hW/_W components in ThreadRouteView bundle");

  // Extract wF, KH, SW from _W component
  const mDetails = _WFn.source.match(/([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.usedTokens\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*),.*?let\s+([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*),/);
  assert(mDetails, "Could not extract wF/KH/SW from _W component");
  const wF = mDetails[2];
  const KH = mDetails[4];
  const SW = mDetails[6];

  const hWRep = `function ${hWFn.name}(e){return(0,${jsxVar}.jsx)(T3DetailsUsageRingsMemo,e)}`;
  const _WRep = `function ${_WFn.name}(e){return(0,${jsxVar}.jsx)(T3DetailsContextRingMemo,e)}`;

  let patched =
    source.slice(0, hWFn.start) +
    hWRep +
    source.slice(hWFn.end, _WFn.start) +
    _WRep +
    source.slice(_WFn.end);

  // 3. Resolve Anchor 2: Composer Resting Strip Controls (eB)
  const eBFn = findUniqueFunction(
    source,
    (_fn, src) => src.includes("onModelPickerOpenChange") && src.includes("providerInstanceEntries"),
    "composer-resting-strip",
    tokens
  );
  assert(eBFn, "Could not locate composer resting strip (eB) in ThreadRouteView bundle");

  const mTraits = eBFn.source.match(/([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{provider:([A-Za-z_$][\w$]*),instanceId:([A-Za-z_$][\w$]*)/);
  assert(mTraits, "Could not extract traits variable from eB");
  const pe = mTraits[1];

  const mModelVars = eBFn.source.match(/([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=\2\?[A-Za-z_$][\w$]*\?\.instanceId\?\?([A-Za-z_$][\w$]*):\5,([A-Za-z_$][\w$]*)=\2\?[A-Za-z_$][\w$]*\?\.model\?\?([A-Za-z_$][\w$]*):\7/);
  assert(mModelVars, "Could not extract ve/ye/be model variables from eB");
  const ve = mModelVars[1];
  const ye = mModelVars[4];
  const be = mModelVars[6];

  const mParams = eBFn.source.match(/providerInstanceEntries:([A-Za-z_$][\w$]*),[\s\S]*?modelOptionsByInstance:([A-Za-z_$][\w$]*),[\s\S]*?modelPickerOpen:([A-Za-z_$][\w$]*),onModelPickerOpenChange:([A-Za-z_$][\w$]*),[\s\S]*?getModelDisabledReason:([A-Za-z_$][\w$]*)/);
  assert(mParams, "Could not extract parameter variables from eB");
  const I = mParams[1];
  const R = mParams[2];
  const B = mParams[3];
  const V = mParams[4];
  const U = mParams[5];

  const mLocked = eBFn.source.match(/lockedProvider:([A-Za-z_$][\w$]*)/);
  assert(mLocked, "Could not extract lockedProvider from eB");
  const P = mLocked[1];

  const mSelect = eBFn.source.match(/onProviderModelSelect:([A-Za-z_$][\w$]*)/);
  assert(mSelect, "Could not extract onProviderModelSelect from eB");
  const j = mSelect[1];

  const stripRegex = /children:\[([A-Za-z_$][\w$]*),\(0,\s*([A-Za-z_$][\w$]*)\.jsxs?\)\(\2\.Fragment,\{children:\[([A-Za-z_$][\w$]*)\.map/;
  const mStrip = eBFn.source.match(stripRegex);
  assert(mStrip, "Could not locate strip controls anchor in eB");
  const stripFull = mStrip[0];
  const stripJsx = mStrip[2];
  const he = mStrip[3];

  const stripReplacement = `children:[(0,${stripJsx}.jsx)(T3UnifiedModelControlsMemo,{traits:${pe},instanceEntries:${I},modelOptionsByInstance:${R},activeInstanceId:${ye},activeModel:${be},lockedProvider:${P},disabled:${ve},open:${B},onOpenChange:${V},onSelectProviderModel:${j},getModelDisabledReason:${U}}),(0,${stripJsx}.jsxs)(${stripJsx}.Fragment,{children:[${he}.filter(b=>b.id!==\`mode\`&&b.id!==\`permissions\`).map`;
  patched = patched.replace(stripFull, () => stripReplacement);

  // 4. Resolve Anchor 3: Composer permissions label
  const permRegex = /children:\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\.label,([A-Za-z_$][\w$]*)\]\}\),([A-Za-z_$][\w$]*)\[(\d+)\]=([A-Za-z_$][\w$]*)/;
  const mPerm = patched.match(permRegex);
  assert(mPerm, "Could not locate composer permissions label anchor");
  const [permFull, g, c, _, permSlotArr, permSlotIdx, o] = mPerm;
  const permReplacement = `children:[${g},(0,${jsxVar}.jsx)(\`span\`,{className:\`t3e-permissions-label\`,children:${c}.label}),${_}]}),${permSlotArr}[${permSlotIdx}]=${o}`;
  patched = patched.replace(permFull, () => permReplacement);

  // 5. Resolve Anchor 4: Composer function mB
  const composerFormIdx = patched.indexOf('"data-chat-composer-form":`true`');
  assert(composerFormIdx >= 0, "Could not locate data-chat-composer-form anchor");
  const mBFn = findEnclosingFunction(patched, composerFormIdx, tokens);
  assert(mBFn, "Could not locate composer enclosing function (mB)");

  // Left footer anchor
  const mLeft = mBFn.source.match(/([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)\?\(0,\s*([A-Za-z_$][\w$]*)\.jsx\)\([`'"]div[`'"],\{className:[`'"]me-2[`'"],children:\1\}\):null,/);
  assert(mLeft, "Could not locate composer left footer anchor");
  const [leftFull, , Rc, leftJsx] = mLeft;
  const leftReplacement = `!${Rc}?(0,${leftJsx}.jsxs)(\`div\`,{className:\`t3e-footer-left me-2 flex shrink-0 items-center gap-1.5\`,children:[(0,${leftJsx}.jsx)(T3ComposerPlusMenu,{}),(0,${leftJsx}.jsx)(T3ComposerPermissionsBtnMemo,{}),(0,${leftJsx}.jsx)(T3ComposerQuotaRingMemo,{})]}):null,`;

  // Controls anchor
  const mControls = mBFn.source.match(/className:([A-Za-z_$][\w$]*)\([`'"]relative flex min-w-0 flex-1 items-center justify-end gap-0\.5[`'"],([A-Za-z_$][\w$]*)&&[`'"]hidden[`'"]\),children:([A-Za-z_$][\w$]*)\}\)/);
  assert(mControls, "Could not locate composer controls anchor");
  const [controlsFull, Dr, , gu] = mControls;
  const controlsReplacement = `className:${Dr}(\`relative flex min-w-0 flex-1 items-center justify-end gap-0.5\`,${Rc}&&\`hidden\`),children:[(0,${leftJsx}.jsx)(T3ComposerContextRingMemo,{}),${gu}]})`;

  // Head props
  const mHead = mBFn.source.match(/\{composerDraftTarget:([A-Za-z_$][\w$]*),environmentId:([A-Za-z_$][\w$]*),[\s\S]*?routeThreadRef:([A-Za-z_$][\w$]*),[\s\S]*?activeThreadId:([A-Za-z_$][\w$]*),[\s\S]*?activeProjectDefaultModelSelection:([A-Za-z_$][\w$]*),activeThreadModelSelection:([A-Za-z_$][\w$]*),reportedModelSelection:([A-Za-z_$][\w$]*),[\s\S]*?gitCwd:([A-Za-z_$][\w$]*),pullRequestProjectId:([A-Za-z_$][\w$]*),[\s\S]*?threadPullRequests:([A-Za-z_$][\w$]*),[\s\S]*?composerRef:([A-Za-z_$][\w$]*)/);
  assert(mHead, "Could not extract composer head properties");
  const [, i, a, composerRouteRef, w, fe, peModel, me, Ee, Oe, Ae, Pe] = mHead;

  // Body vars
  const mIo = mBFn.source.match(/=([A-Za-z_$][\w$]*)\?\(0,\s*([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{onOpenPicker:/);
  assert(mIo, "Could not extract Io and xL from mB");
  const Io = mIo[1];
  const xL = mIo[3];

  const mJu = mBFn.source.match(/([A-Za-z_$][\w$]*)=\(([A-Za-z_$][\w$]*),[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)=>\{if\(\2\.length===0\|\|/);
  assert(mJu, "Could not extract ju from mB");
  const ju = mJu[1];

  const mUo = mBFn.source.match(new RegExp(`let\\s+[A-Za-z_$][\\w$]*=[A-Za-z_$][\\w$]*,([A-Za-z_$][\\w$]*)=[A-Za-z_$][\\w$]*\\(${a}\\),[A-Za-z_$][\\w$]*=[A-Za-z_$][\\w$]*\\.sideChatAvailable`));
  assert(mUo, "Could not extract uo (linkedEnvironments) from mB");
  const uo = mUo[1];

  const mBi = mBFn.source.match(/([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(e,[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\),/);
  assert(mBi, "Could not extract bi (runtimeModeOptions) from mB");
  const bi = mBi[1];

  const mRu = mBFn.source.match(/addComposerAttachments:([A-Za-z_$][\w$]*)/);
  const mPt = mBFn.source.match(/focusComposer:([A-Za-z_$][\w$]*)/);
  const mFt = mBFn.source.match(/handleRuntimeModeChange:([A-Za-z_$][\w$]*)/);
  const mOi = mBFn.source.match(/selectedInstanceId:([A-Za-z_$][\w$]*)/);
  const mDi = mBFn.source.match(/selectedModel:([A-Za-z_$][\w$]*)/);
  assert(mRu && mPt && mFt && mOi && mDi, "Could not extract destructured composer variables");
  const Ru = mRu[1];
  const pt = mPt[1];
  const ft = mFt[1];
  const oi = mOi[1];
  const di = mDi[1];

  const mSkills = mBFn.source.match(/skills:([A-Za-z_$][\w$]*)/);
  assert(mSkills, "Could not extract skills variable from mB");
  const ji = mSkills[1];

  // Form return start
  const mFormStart = mBFn.source.match(/([A-Za-z_$][\w$]*StaticArray|[A-Za-z_$][\w$]*)\[(\d+)\]=([A-Za-z_$][\w$]*)\):\3=\1\[\2\],\(0,\s*([A-Za-z_$][\w$]*)\.jsxs?\)\([`'"]form[`'"],/);
  assert(mFormStart, "Could not locate composer form start anchor");
  const [formStartFull, formSlotArr, formSlotIdx, cp, formJsx] = mFormStart;

  const formStartReplacement = `${formSlotArr}[${formSlotIdx}]=${cp}):${cp}=${formSlotArr}[${formSlotIdx}],(0,${formJsx}.jsx)(T3ComposerCtxProvider,{canAttach:${Io},addComposerAttachments:${Ru},focusComposer:${pt},composerRef:${Pe},insertText:${ju},providerInstanceId:${oi},activeModel:${di}||${peModel}?.model||${fe}?.model||${me}?.model||\`\`,runtimeMode:e.runtimeMode,runtimeModeOptions:${bi},onRuntimeModeChange:${ft},composerDraftTarget:${i},environmentId:${a},routeThreadRef:${composerRouteRef},gitCwd:${Ee},pullRequestProjectId:${Oe},activeThreadId:${w},linkedEnvironments:${uo},skills:${ji},pullRequests:${Ae},children:(0,${formJsx}.jsxs)(\`form\`,`;

  // Form return end in patched
  const formEndRegex = new RegExp("([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*)," + cp + "\\]\\}\\)\\}\\)\\}\\)\\]\\}\\)\\}\\);");
  const mFormEnd = patched.match(formEndRegex);
  assert(mFormEnd, "Could not locate composer form end anchor");
  const [formEndFull, ap, op, sp] = mFormEnd;
  const formEndReplacement = `${ap},${op},${sp},${cp}]})})})]})})});`;

  patched = patched
    .replace(leftFull, () => leftReplacement)
    .replace(controlsFull, () => controlsReplacement)
    .replace(formStartFull, () => formStartReplacement)
    .replace(formEndFull, () => formEndReplacement);

  // 6. Resolve Anchor 5: Chat view return
  const mRet = patched.match(/return\(0,\s*([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{threadRef:([A-Za-z_$][\w$]*),cwd:([A-Za-z_$][\w$]*),checkpoints:([A-Za-z_$][\w$]*)\?\.checkpoints,checkpointScopes:\5\?\.checkpointScopes,children:([A-Za-z_$][\w$]*)\}\)/);
  assert(mRet, "Could not locate chat view return anchor");
  const [retFull, retJsx, ix, laRef, yd, q, hy] = mRet;

  const chatTokens = tokenize(patched);
  const chatFn = findEnclosingFunction(patched, mRet.index, chatTokens);
  assert(chatFn, "Could not locate chat view enclosing function");

  const mUsage = chatFn.source.match(/usage:\{providerInstanceId:([A-Za-z_$][\w$]*),model:[A-Za-z_$][\w$]*,providers:([A-Za-z_$][\w$]*),sources:([A-Za-z_$][\w$]*)\?\.usageLimitSources\?\?([A-Za-z_$][\w$]*),contextWindow:([A-Za-z_$][\w$]*)\}/);
  assert(mUsage, "Could not extract usage object from chat view");
  const [, tc, hs, fs, WG, xl] = mUsage;

  const mKr = chatFn.source.match(/environmentId:([A-Za-z_$][\w$]*)\.environmentId,\s*threadId:\1\.id/);
  assert(mKr, "Could not extract Kr from chat view");
  const Kr = mKr[1];

  const chatReplacement = `return(0,${retJsx}.jsx)(T3RingsCtxProvider,{providerInstanceId:${tc},providers:${hs},sources:${fs}?.usageLimitSources??${WG},contextWindow:${xl},activeModel:${Kr}?.modelSelection?.model||\`\`,runs:${q}?.runs,messages:${q}?.messages,turnItems:${q}?.turnItems,providerTurns:${q}?.providerTurns,activeProviderThreadId:${q}?.thread?.activeProviderThreadId,children:(0,${retJsx}.jsx)(${ix},{threadRef:${laRef},cwd:${yd},checkpoints:${q}?.checkpoints,checkpointScopes:${q}?.checkpointScopes,children:${hy}})})`;
  patched = patched.replace(retFull, () => chatReplacement);

  // 7. Resolve Host Imports & Local Functions for createUsageRingsRuntime
  const useI18n = findImportAlias(/utils-.*\.js$/, "f_") || "an";
  const useFormatMessage = findImportAlias(/utils-.*\.js$/, "d_") || "Yt";
  const useLocale = findImportAlias(/utils-.*\.js$/, "p_") || "nr";
  const useMinuteNow = findImportAlias(/useNowMinute-.*\.js$/, "t") || "LS";
  const useSettingsSelector = findImportAlias(/useSettings-.*\.js$/, "x") || "bv";
  const formatDuration = findImportAlias(/UsageLimits-.*\.js$/, "c") || "Rb";
  const formatTimestamp = findImportAlias(/timestampFormat-.*\.js$/, "f") || "yg";
  // `l` from UsageLimits is the "limits unavailable" helper (returns a reason string or null).
  const getLimitsUnavailable = findImportAlias(/UsageLimits-.*\.js$/, "l") || "zb";
  // The pace label table is a module-level constant of the thread bundle, not an import.
  const paceLabels = source.match(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)=\{ahead:[^{}]*?`Ahead of pace`[^{}]*?on:[^{}]*?`On pace`[^{}]*?under:[^{}]*?`Under pace`[^{}]*?\}/)?.[1] || "pW";
  const resolveAccountLimits = findImportAlias(RUNTIME_CHUNK, "_t") || "Pi";
  const getWindowLeftPct = findImportAlias(RUNTIME_CHUNK, "Dt") || "mi";
  const getWindowPace = findImportAlias(RUNTIME_CHUNK, "wt") || "la";
  const getWindowTimeLeft = findImportAlias(RUNTIME_CHUNK, "Tt") || "Di";
  const Link = findImportAlias(/link-.*\.js$/, "t") || "qo";
  const Tooltip = findImportAlias(/utils-.*\.js$/, "qr") || "fr";
  const TooltipTrigger = findImportAlias(/utils-.*\.js$/, "Zr") || "bt";
  const TooltipPopup = findImportAlias(/utils-.*\.js$/, "Jr") || "se";
  const Popover = findImportAlias(/popover-.*\.js$/, "t") || "$g";
  const PopoverTrigger = findImportAlias(/popover-.*\.js$/, "o") || "Zg";
  const PopoverPopup = findImportAlias(/popover-.*\.js$/, "i") || "Xg";
  const PlusIcon = findImportAlias(/plus-.*\.js$/, "t") || "$y";
  const SkillIcon = findImportAlias(RUNTIME_CHUNK, "Yr") || "ji";
  const ProviderIcon = findImportAlias(/main-.*\.js$/, "si") || "Yd";
  const composerDraftStore = findImportAlias(/utils-.*\.js$/, "F") || "L";
  const rightPanelStore = findImportAlias(/rightPanelStore-.*\.js$/, "f") || "tm";
  const getPanelState = findImportAlias(/rightPanelStore-.*\.js$/, "d") || "em";
  const usePreviewState = findImportAlias(/utils-.*\.js$/, "ku") || "Nn";
  const makeThreadContext = findImportAlias(/utils-.*\.js$/, "yn") || "ri";
  const makeEnvironmentContext = findImportAlias(/utils-.*\.js$/, "gt") || "hn";
  const makePrReviewComment = findImportAlias(/pullRequestDetail\.logic-.*\.js$/, "p") || "wy";
  const basename = findImportAlias(/pierre-icons-.*\.js$/, "n") || "XS";
  const useThreadShells = findImportAlias(/entities-.*\.js$/, "U") || "Es";
  const useSearchThreads = findImportAlias(/queries-.*\.js$/, "s") || "rS";
  const useFileSearch = findImportAlias(/queries-.*\.js$/, "n") || "tS";
  const usePullRequestsQuery = findImportAlias(/pullRequests-.*\.js$/, "f") || "kb";
  const useAllEnvironments = findImportAlias(/useSettings-.*\.js$/, "N") || "fv";
  const useEnvironmentMachines = findImportAlias(/useSettings-.*\.js$/, "P") || "pv";
  const canAttachEnvSelector = findImportAlias(/peerLinks-.*\.js$/, "t") || "Cv";
  const useStore = findImportAlias(/utils-.*\.js$/, "Bu") || "y";
  const useModelTraits = findImportAlias(/utils-.*\.js$/, "Pr") || "Ae";
  const getSelectChoices = findImportAlias(/utils-.*\.js$/, "lc") || "Fn";
  const isProviderReady = findImportAlias(/utils-.*\.js$/, "rr") || "vr";

  const timestampFormatSelector = source.match(/function\s+([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\)\{return\s+[A-Za-z_$][\w$]*\.timestampFormat\}/)?.[1] || "yW";
  const filterLinkedPrs = source.match(/function\s+([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{return\s+[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\.flatMap\(.+?\.snapshot===null\?\[\]:/)?.[1] || "cI";
  const findEffortTrait = source.match(/function\s+([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{let\{columnSelects:[A-Za-z_$][\w$]*,columnToggles:[A-Za-z_$][\w$]*\}=/)?.[1] || "Mz";
  const findSpeedTrait = source.match(/function\s+([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{let\s+[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.find\([A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*\.id===`serviceTier`\)/)?.[1] || "jz";
  const preventDefault = source.match(/function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{\2\.preventDefault\(\)\}/)?.[1] || "tL";

  const bridge = `/* ${MARKER} */
const {
  T3RingsCtx,
  T3ContextWindowCtx,
  T3ThreadStatsCtx,
  T3ComposerCtx,
  T3RingsCtxProvider,
  T3ComposerCtxProvider,
  T3DetailsUsageRings,
  T3DetailsContextRing,
  T3DetailsUsageRingsMemo,
  T3DetailsContextRingMemo,
  T3ComposerPlusMenu,
  T3ComposerPermissionsBtn,
  T3ComposerPermissionsBtnMemo,
  T3ComposerQuotaRing,
  T3ComposerQuotaRingMemo,
  T3QuotaPopoverCard,
  T3ComposerContextRing,
  T3ComposerContextRingMemo,
  T3ContextPopoverCard,
  T3EffortSlider,
  T3UnifiedModelControls,
  T3UnifiedModelControlsMemo,
} = createUsageRingsRuntime({
  React: ${reactVar},
  jsx: ${jsxVar}.jsx,
  jsxs: ${jsxVar}.jsxs,
  Fragment: ${jsxVar}.Fragment,
  useI18n: ${useI18n},
  useFormatMessage: ${useFormatMessage},
  useLocale: ${useLocale},
  useMinuteNow: ${useMinuteNow},
  useSettingsSelector: ${useSettingsSelector},
  timestampFormatSelector: ${timestampFormatSelector},
  formatCompactTokens: ${wF},
  formatDuration: ${formatDuration},
  formatTimestamp: ${formatTimestamp},
  paceLabels: ${paceLabels},
  resolveAccountLimits: ${resolveAccountLimits},
  getLimitsUnavailable: ${getLimitsUnavailable},
  getWindowLeftPct: ${getWindowLeftPct},
  getWindowPace: ${getWindowPace},
  getWindowTimeLeft: ${getWindowTimeLeft},
  DetailsSection: ${KH},
  DetailsRow: ${SW},
  Link: ${Link},
  Tooltip: ${Tooltip},
  TooltipTrigger: ${TooltipTrigger},
  TooltipPopup: ${TooltipPopup},
  Popover: ${Popover},
  PopoverTrigger: ${PopoverTrigger},
  PopoverPopup: ${PopoverPopup},
  PlusIcon: ${PlusIcon},
  PaperclipIcon: ${xL},
  SkillIcon: ${SkillIcon},
  ProviderIcon: ${ProviderIcon},
  composerDraftStore: ${composerDraftStore},
  rightPanelStore: ${rightPanelStore},
  getPanelState: ${getPanelState},
  usePreviewState: ${usePreviewState},
  makeThreadContext: ${makeThreadContext},
  makeEnvironmentContext: ${makeEnvironmentContext},
  makePrReviewComment: ${makePrReviewComment},
  filterLinkedPrs: ${filterLinkedPrs},
  basename: ${basename},
  useThreadShells: ${useThreadShells},
  useSearchThreads: ${useSearchThreads},
  useFileSearch: ${useFileSearch},
  usePullRequestsQuery: ${usePullRequestsQuery},
  useAllEnvironments: ${useAllEnvironments},
  useEnvironmentMachines: ${useEnvironmentMachines},
  canAttachEnvSelector: ${canAttachEnvSelector},
  useStore: ${useStore},
  useModelTraits: ${useModelTraits},
  findEffortTrait: ${findEffortTrait},
  findSpeedTrait: ${findSpeedTrait},
  getSelectChoices: ${getSelectChoices},
  isProviderReady: ${isProviderReady},
  preventDefault: ${preventDefault},
});
`;

  const runtimeSource = getRuntimeSource();
  if (ctx?.entry && typeof ctx.addRuntimeAsset === "function") {
    const asset = ctx.addRuntimeAsset("usage-rings-ui", runtimeSource);
    const importStmt = `import { createUsageRingsRuntime } from "${asset.specifier}";\n`;
    patched = importStmt + patched.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "") + "\n" + bridge + "\n";
  } else {
    const inlinedModule = runtimeSource.replace(/^export\s+(function|const|let|var)\s+/gm, "$1 ");
    patched = patched.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "") + "\n" + inlinedModule + "\n" + bridge + "\n";
  }

  if (ctx?.recordInjectedCode) {
    ctx.recordInjectedCode(bridge);
  }

  return patched;
}

module.exports = {
  id: ID,
  name: NAME,
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: TARGET_REGEX,
  targetSpec: TARGET_SPEC,
  originalHash: ORIGINAL_HASH,
  apply,
  t3ClassifyWindow,
  t3BaseWindowName,
  t3PairUsageWindows,
  t3SelectPrimaryQuotaForModel,
  t3PromptHasToken,
  t3ThreadCtxKey,
  t3ReviewCommentPrNum,
  t3EnvCtxId,
  t3EnsureEnhancerStyles,
};

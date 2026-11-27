"use strict";

const assert = require("node:assert/strict");
const { loadRuntimeExports, mountRuntime } = require("../runtime-loader.cjs");
const { THREAD_ROUTE } = require("../resolver.cjs");
const {
  tokenize,
  findUniqueFunction,
  findEnclosingFunction,
} = require("../js-ast.cjs");

const ID = "usage-rings";
const NAME = "加号菜单 + 常驻权限 + 合一模型/思考深度面板 + 模型联动双环与统计";
const MARKER = "T3_USAGE_RINGS_V36";
const LEGACY_MARKERS = Array.from({ length: 35 }, (_, index) => "T3_USAGE_RINGS_V" + (index + 1));
const ORIGINAL_HASH = "5464ddf4e47841a1799079fdc05145474013f8c268224390b2dccf3f76521c9f";
const KNOWN_HASHES = ["d54743d08ba7971a22d5dc50a422f1974e3db92b1c277b3e72645fbe2e5b74ce"];

const {
  t3PairUsageWindows,
  t3SelectPrimaryQuotaForModel,
  t3PromptHasToken,
  t3ThreadCtxKey,
  t3ReviewCommentPrNum,
  t3EnvCtxId,
  t3EstimateOutputTokens,
} = loadRuntimeExports("usage-rings-ui");

// --- Main Patch Application ---

function apply(source, ctx) {
  assert(
    ctx && typeof ctx.resolveReactBindings === "function" && typeof ctx.addRuntimeAsset === "function",
    "usage-rings requires a PatchContext with resolveReactBindings and addRuntimeAsset"
  );
  const tokens = ctx.getTokens();
  const imports = ctx.getImports();

  function importBindings(chunk, names) {
    const candidates = imports.filter(({ specifier }) => specifier.split("/").at(-1).startsWith(chunk + "-"))
      .flatMap(({ specifiers }) => specifiers);
    return Object.fromEntries(Object.entries(names).map(([name, exported]) => {
      const binding = candidates.find(({ imported }) => imported === exported);
      assert(binding, `Could not resolve ${name} (${exported}) from ${chunk}`);
      return [name, binding.local];
    }));
  }
  function reqMatch(re, label) {
    const m = source.match(re);
    assert(m && m[1], `Could not resolve ${label} in ThreadRouteView bundle`);
    return m[1];
  }
  // 1. Resolve React and JSX bindings dynamically
  const { react: reactVar, jsx: jsxVar } = ctx.resolveReactBindings();
  assert(reactVar && jsxVar, "Could not resolve React/JSX bindings for usage-rings");

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
  const composerFormIdx = source.indexOf('"data-chat-composer-form":`true`');
  assert(composerFormIdx >= 0, "Could not locate data-chat-composer-form anchor");
  const mBFn = findEnclosingFunction(source, composerFormIdx, tokens);
  assert(mBFn, "Could not locate composer enclosing function (mB)");

  // Left footer anchor
  const mLeft = mBFn.source.match(/([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)\?\(0,\s*([A-Za-z_$][\w$]*)\.jsx\)\([`'"]div[`'"],\{className:[`'"]me-2[`'"],children:\1\}\):null,/);
  assert(mLeft, "Could not locate composer left footer anchor");
  const [leftFull, , Rc, leftJsx] = mLeft;

  // Controls anchor
  const mControls = mBFn.source.match(/className:([A-Za-z_$][\w$]*)\([`'"]relative flex min-w-0 flex-1 items-center justify-end gap-0\.5[`'"],([A-Za-z_$][\w$]*)&&[`'"]hidden[`'"]\),children:([A-Za-z_$][\w$]*)\}\)/);
  assert(mControls, "Could not locate composer controls anchor");
  const [controlsFull, Dr, , gu] = mControls;
  const controlsReplacement = `className:${Dr}(\`relative flex min-w-0 flex-1 items-center justify-end gap-0.5\`,${Rc}&&\`hidden\`),children:[(0,${leftJsx}.jsx)(T3ComposerContextRingMemo,{}),${gu}]})`;

  // Head props
  const mHead = mBFn.source.match(/\{composerDraftTarget:([A-Za-z_$][\w$]*),environmentId:([A-Za-z_$][\w$]*),[\s\S]*?routeThreadRef:([A-Za-z_$][\w$]*),[\s\S]*?activeThreadId:([A-Za-z_$][\w$]*),[\s\S]*?gitCwd:([A-Za-z_$][\w$]*),pullRequestProjectId:([A-Za-z_$][\w$]*),[\s\S]*?threadPullRequests:([A-Za-z_$][\w$]*),[\s\S]*?composerRef:([A-Za-z_$][\w$]*)/);
  assert(mHead, "Could not extract composer head properties");
  const [, i, a, composerRouteRef, w, Ee, Oe, Ae, Pe] = mHead;

  // Body vars
  const mIo = mBFn.source.match(/=([A-Za-z_$][\w$]*)\?\(0,\s*([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{onOpenPicker:/);
  assert(mIo, "Could not extract Io from mB");
  const Io = mIo[1];

  const mJu = mBFn.source.match(/([A-Za-z_$][\w$]*)=\(([A-Za-z_$][\w$]*),[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)=>\{if\(\2\.length===0\|\|/);
  assert(mJu, "Could not extract ju from mB");
  const ju = mJu[1];

  const mUo = mBFn.source.match(new RegExp(`let\\s+[A-Za-z_$][\\w$]*=[A-Za-z_$][\\w$]*,([A-Za-z_$][\\w$]*)=[A-Za-z_$][\\w$]*\\(${a}\\),[A-Za-z_$][\\w$]*=[A-Za-z_$][\\w$]*\\.sideChatAvailable`));
  assert(mUo, "Could not extract uo (linkedEnvironments) from mB");
  const uo = mUo[1];

  const mBi =
    mBFn.source.match(/([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(e,[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\),/)
    || mBFn.source.match(/let\{modes:([A-Za-z_$][\w$]*),mode:([A-Za-z_$][\w$]*)\}=[A-Za-z_$][\w$]*\([^)]*supportedRuntimeModes[^;]*;\s*[A-Za-z_$][\w$]*=\2,([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\1,/);
  assert(mBi, "Could not extract bi (runtimeModeOptions) from mB");
  const bi = mBi[3] || mBi[1];

  const mRu = mBFn.source.match(/addComposerAttachments:([A-Za-z_$][\w$]*)/);
  const mPt = mBFn.source.match(/focusComposer:([A-Za-z_$][\w$]*)/);
  const mFt = mBFn.source.match(/handleRuntimeModeChange:([A-Za-z_$][\w$]*)/);
  const mOi = mBFn.source.match(/selectedInstanceId:([A-Za-z_$][\w$]*)/);
  const mDi = mBFn.source.match(/selectedModel:([A-Za-z_$][\w$]*)/);
  assert(mRu && mPt && mFt && mOi && mDi, "Could not extract destructured composer variables");
  const Ru = mRu[1];
  const pt = mPt[1];
  const ft = mFt[1];
  const selectedInstance = mOi[1];
  const selectedModel = mDi[1];
  const leftReplacement = `!${Rc}?(0,${leftJsx}.jsxs)(\`div\`,{className:\`t3e-footer-left me-2 flex shrink-0 items-center gap-1.5\`,children:[(0,${leftJsx}.jsx)(T3ComposerPlusMenu,{}),(0,${leftJsx}.jsx)(T3ComposerPermissionsBtnMemo,{}),(0,${leftJsx}.jsx)(T3ComposerQuotaRingMemo,{providerInstanceId:${selectedInstance},activeModel:${selectedModel}})]}):null,`;

  const mSkills = mBFn.source.match(/skills:([A-Za-z_$][\w$]*)/);
  assert(mSkills, "Could not extract skills variable from mB");
  const ji = mSkills[1];

  // Form return start
  const mFormStart = mBFn.source.match(/([A-Za-z_$][\w$]*StaticArray|[A-Za-z_$][\w$]*)\[(\d+)\]=([A-Za-z_$][\w$]*)\):\3=\1\[\2\],\(0,\s*([A-Za-z_$][\w$]*)\.jsxs?\)\([`'"]form[`'"],/);
  assert(mFormStart, "Could not locate composer form start anchor");
  const [formStartFull, formSlotArr, formSlotIdx, cp, formJsx] = mFormStart;

  const formStartReplacement = `${formSlotArr}[${formSlotIdx}]=${cp}):${cp}=${formSlotArr}[${formSlotIdx}],(0,${formJsx}.jsx)(T3ComposerCtxProvider,{canAttach:${Io},addComposerAttachments:${Ru},focusComposer:${pt},composerRef:${Pe},insertText:${ju},runtimeMode:e.runtimeMode,runtimeModeOptions:${bi},onRuntimeModeChange:${ft},composerDraftTarget:${i},environmentId:${a},routeThreadRef:${composerRouteRef},gitCwd:${Ee},pullRequestProjectId:${Oe},activeThreadId:${w},linkedEnvironments:${uo},skills:${ji},pullRequests:${Ae},children:(0,${formJsx}.jsxs)(\`form\`,`;

  // Form return end in patched (supports both trailing ";" in v0.1.12 and final "}" in v0.1.13)
  const formEndRegex = new RegExp("([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*)," + cp + "\\]\\}\\)\\}\\)\\}\\)\\]\\}\\)\\}\\)(;|\\})");
  const mFormEnd = patched.match(formEndRegex);
  assert(mFormEnd, "Could not locate composer form end anchor");
  const [formEndFull, ap, op, sp, formEndTail] = mFormEnd;
  const formEndReplacement = `${ap},${op},${sp},${cp}]})})})]})})})${formEndTail}`;

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

  const chatReplacement = `return(0,${retJsx}.jsx)(T3RingsCtxProvider,{threadRef:${laRef},providerInstanceId:${tc},providers:${hs},sources:${fs}?.usageLimitSources??${WG},contextWindow:${xl},activeModel:${Kr}?.modelSelection?.model||\`\`,runs:${q}?.runs,messages:${q}?.messages,turnItems:${q}?.turnItems,providerTurns:${q}?.providerTurns,activeProviderThreadId:${q}?.thread?.activeProviderThreadId,children:(0,${retJsx}.jsx)(${ix},{threadRef:${laRef},cwd:${yd},checkpoints:${q}?.checkpoints,checkpointScopes:${q}?.checkpointScopes,children:${hy}})})`;
  patched = patched.replace(retFull, () => chatReplacement);

  const followDecl = (decl, name) => {
    const d = decl(name) || "";
    const alias = d.match(/^[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)$/);
    return alias ? (decl(alias[1]) || d) : d;
  };
  const utilsChunkSpec = {
    pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
    preferredRegex: /^apps\/server\/dist\/client\/assets\/utils-[\w-]+\.js$/,
    includes: ["tooltip-popup", "getComposerDraft"],
  };
  const mainChunkSpec = {
    pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
    preferredRegex: /^apps\/server\/dist\/client\/assets\/main-[\w-]+\.js$/,
    includes: ["--provider-accent", "driverKind"],
  };
  function resolveSemanticOrFallback(chunkSpec, predicate, preferredAlias, fallbackChunk, fallbackExport, label) {
    if (ctx.asar && ctx.entry && typeof ctx.ensureChunkImport === "function") {
      try {
        return ctx.ensureChunkImport(chunkSpec, predicate, preferredAlias, label).local;
      } catch {}
    }
    return importBindings(fallbackChunk, { [label]: fallbackExport })[label];
  }

  let useModelTraits = null;
  let useI18n = null;
  let useFormatMessage = null;
  let threadAtoms = null;
  let atomRegistry = null;
  if (ctx.asar && typeof ctx.resolveImportedAlias === "function") {
    try {
      useModelTraits = ctx.resolveImportedAlias(
        /utils-.*\.js$/,
        (local, _text, _ex, decl) => {
          const d = decl(local);
          return Boolean(d && d.includes("selectValue:") && d.includes("changeSelect:") && d.includes("changeBoolean:"));
        },
        "useModelTraits"
      ).local;
    } catch {}
    try {
      // useI18n decodes encoded M(...) payloads via $_source (e.g. formatDuration / formatTimestamp / paceLabels)
      useI18n = ctx.resolveImportedAlias(
        /utils-.*\.js$/,
        (local, _text, _ex, decl) => {
          const d = decl(local);
          return Boolean(d && d.includes("$_source"));
        },
        "useI18n"
      ).local;
    } catch {}
    try {
      // useFormatMessage formats plain ICU templates (e.g. tFn("Resets in {duration} · {time}", params))
      useFormatMessage = ctx.resolveImportedAlias(
        /utils-.*\.js$/,
        (local, _text, _ex, decl) => {
          const d = decl(local);
          return Boolean(d && d.includes("ICU") && !d.includes("$_source"));
        },
        "useFormatMessage"
      ).local;
    } catch {}
    try {
      // threadAtoms exposes threadAtom(ref) (live unstripped projection) alongside quietThreadAtom(ref)
      threadAtoms = ctx.resolveImportedAlias(
        /entities-.*\.js$/,
        (local, text) => Boolean(text && text.includes(`${local}.threadAtom(`) && text.includes(`${local}.quietThreadAtom(`)),
        "threadAtoms"
      ).local;
    } catch {}
    try {
      // atomRegistry is the global Effect-Atom Registry (.get / .subscribe) provided to the app tree
      atomRegistry = ctx.resolveImportedAlias(
        /utils-.*\.js$/,
        (local, text) => Boolean(text && text.includes(`${local}.subscribe(`) && text.includes(`{value:${local}}`)),
        "atomRegistry"
      ).local;
    } catch {}
  }
  if (!useModelTraits) {
    const callerFn = findUniqueFunction(
      source,
      (_fn, src) => src.includes(".selectValue(") && src.includes(".changeSelect(") && src.includes(".changeBoolean("),
      "useModelTraits-caller",
      tokens
    );
    useModelTraits = callerFn.source.match(/=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.traits\)/)?.[1] || null;
  }
  assert(useModelTraits, "Could not resolve useModelTraits hook in ThreadRouteView bundle");

  if (!threadAtoms) {
    threadAtoms = source.match(/\b([A-Za-z_$][\w$]*)\.quietThreadAtom\(/)?.[1]
      || importBindings("entities", { threadAtoms: "Q" }).threadAtoms;
  }
  if (!atomRegistry) {
    atomRegistry = source.match(/\b([A-Za-z_$][\w$]*)\.get\([A-Za-z_$][\w$]*\.quietThreadAtom\(/)?.[1]
      || importBindings("utils", { atomRegistry: "Mu" }).atomRegistry;
  }

  const fallbackI18n = (!useI18n || !useFormatMessage)
    ? importBindings("utils", {
        ...(useI18n ? {} : { useI18n: "d_" }),
        ...(useFormatMessage ? {} : { useFormatMessage: "f_" }),
      })
    : {};

  const { canAttachEnvSelector } = importBindings("peerLinks", { canAttachEnvSelector: "t" });
  const mMemoCanAttach = source.match(
    new RegExp(`([A-Za-z_$][\\w$]*)=${canAttachEnvSelector}\\([^)]*\\)[^;]{0,80};\\s*(?:let|const|var)\\s+[A-Za-z_$][\\w$]*=([A-Za-z_$][\\w$]*)\\(\\1\\)`)
  );
  const mDirectCanAttach = !mMemoCanAttach && source.match(
    new RegExp(`\\b([A-Za-z_$][\\w$]*)\\(${canAttachEnvSelector}\\([^)]*\\)\\)`)
  );
  const useStore = mMemoCanAttach?.[2] || mDirectCanAttach?.[1] || resolveSemanticOrFallback(
    utilsChunkSpec,
    (l, _t, _e, decl) => {
      const d = decl(l) || "";
      return (
        d.includes("useContext(") &&
        !d.includes("getInitialState") &&
        !d.includes(".getState(") &&
        /\?\s*[A-Za-z_$][\w$]*\([^,]+,[^,]+,[^)]+\)\s*:\s*[A-Za-z_$][\w$]*\([^,]+,[^)]+\)/.test(d)
      );
    },
    "T3UseStore",
    "utils",
    "Gu",
    "useStore"
  );

  const bindings = {
    React: reactVar, jsx: `${jsxVar}.jsx`, jsxs: `${jsxVar}.jsxs`, Fragment: `${jsxVar}.Fragment`,
    formatCompactTokens: wF, DetailsSection: KH, DetailsRow: SW, useModelTraits,
    threadAtoms, atomRegistry,
    ...(useI18n ? { useI18n } : {}),
    ...(useFormatMessage ? { useFormatMessage } : {}),
    ...fallbackI18n,
    useLocale: resolveSemanticOrFallback(utilsChunkSpec, (l, _t, _e, decl) => Boolean(decl(l)?.includes("getLocale()")), "T3UseLocale", "utils", "p_", "useLocale"),
    Tooltip: resolveSemanticOrFallback(utilsChunkSpec, (l, _t, _e, decl) => {
      const d = decl(l) || "";
      return d.includes("actionsRef") && d.includes("release(");
    }, "T3UrTooltip", "utils", "qr", "Tooltip"),
    TooltipTrigger: resolveSemanticOrFallback(utilsChunkSpec, (l, _t, _e, decl) => Boolean(decl(l)?.includes("tooltip-trigger")), "T3UrTooltipTrigger", "utils", "Zr", "TooltipTrigger"),
    TooltipPopup: resolveSemanticOrFallback(utilsChunkSpec, (l, _t, _e, decl) => Boolean(decl(l)?.includes("tooltip-popup")), "T3UrTooltipPopup", "utils", "Jr", "TooltipPopup"),
    composerDraftStore: resolveSemanticOrFallback(utilsChunkSpec, (l, _t, _e, decl) => {
      const d = followDecl(decl, l);
      return d.includes("getComposerDraft") && d.includes("draftThreadsByThreadKey");
    }, "T3ComposerDraftStore", "utils", "F", "composerDraftStore"),
    usePreviewState: resolveSemanticOrFallback(utilsChunkSpec, (l, text, _e, decl) => {
      const uVar = text.match(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*\([^)]*\)\.pipe\([^)]*`preview:thread:/)?.[1];
      if (!uVar) return false;
      const d = decl(l) || "";
      return d.includes(`${uVar}(`) && d.includes(".c)(") && !d.includes(".get(");
    }, "T3UsePreviewState", "utils", "ku", "usePreviewState"),
    makeThreadContext: resolveSemanticOrFallback(utilsChunkSpec, (l, _t, _e, decl) => {
      const d = decl(l) || "";
      return d.includes("kind:`thread`") && d.includes("version:1");
    }, "T3MakeThreadContext", "utils", "yn", "makeThreadContext"),
    makeEnvironmentContext: resolveSemanticOrFallback(utilsChunkSpec, (l, _t, _e, decl) => {
      const d = decl(l) || "";
      return d.includes("kind:`environment`") && d.includes("version:1");
    }, "T3MakeEnvironmentContext", "utils", "gt", "makeEnvironmentContext"),
    useStore,
    getSelectChoices: resolveSemanticOrFallback(utilsChunkSpec, (l, _t, _e, decl) => {
      const d = decl(l) || "";
      return d.includes(".options.filter(") && d.includes("promptInjectedValues?.includes");
    }, "T3GetSelectChoices", "utils", "lc", "getSelectChoices"),
    isProviderReady: resolveSemanticOrFallback(utilsChunkSpec, (l, _t, _e, decl) => {
      const d = decl(l) || "";
      return d.includes("modelsRetained") && d.includes("authenticated");
    }, "T3IsProviderReady", "utils", "rr", "isProviderReady"),
    ProviderIcon: resolveSemanticOrFallback(mainChunkSpec, (l, _t, _e, decl) => {
      const d = decl(l) || "";
      return d.includes("--provider-accent") && d.includes("driverKind");
    }, "T3ProviderIcon", "main", "si", "ProviderIcon"),
    ...importBindings("runtime", {
      resolveAccountLimits: "_t", getWindowLeftPct: "Dt", getWindowPace: "wt", getWindowTimeLeft: "Tt",
    }),
    ...importBindings("useSettings", { useSettingsSelector: "x", useAllEnvironments: "N", useEnvironmentMachines: "P" }),
    ...importBindings("useNowMinute", { useMinuteNow: "t" }),
    ...importBindings("UsageLimits", { formatDuration: "c", getLimitsUnavailable: "l" }),
    ...importBindings("timestampFormat", { formatTimestamp: "f" }),
    ...importBindings("popover", { Popover: "t", PopoverTrigger: "o", PopoverPopup: "i" }),
    ...importBindings("link", { Link: "t" }),
    ...importBindings("plus", { PlusIcon: "t" }),
    ...importBindings("rightPanelStore", { rightPanelStore: "f", getPanelState: "d" }),
    ...importBindings("pullRequestDetail.logic", { makePrReviewComment: "p" }),
    ...importBindings("pierre-icons", { basename: "n" }),
    ...importBindings("entities", { useThreadShells: "U" }),
    ...importBindings("queries", { useSearchThreads: "s", useFileSearch: "n" }),
    ...importBindings("pullRequests", { usePullRequestsQuery: "f" }),
    canAttachEnvSelector,
    paceLabels: reqMatch(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)=\{ahead:[^{}]*?`Ahead of pace`[^{}]*?on:[^{}]*?`On pace`[^{}]*?under:[^{}]*?`Under pace`[^{}]*?\}/, "paceLabels"),
    timestampFormatSelector: reqMatch(/function\s+([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\)\{return\s+[A-Za-z_$][\w$]*\.timestampFormat\}/, "timestampFormatSelector"),
    filterLinkedPrs: reqMatch(/function\s+([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{return\s+[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\.flatMap\(.+?\.snapshot===null\?\[\]:/, "filterLinkedPrs"),
    findEffortTrait: reqMatch(/function\s+([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{let\{columnSelects:[A-Za-z_$][\w$]*,columnToggles:[A-Za-z_$][\w$]*\}=/, "findEffortTrait"),
    findSpeedTrait: reqMatch(/function\s+([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{let\s+[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.find\([A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*\.id===`serviceTier`\)/, "findSpeedTrait"),
  };
  const bridge = `/* ${MARKER} */
const {
  T3RingsCtxProvider, T3ComposerCtxProvider,
  T3DetailsUsageRingsMemo, T3DetailsContextRingMemo,
  T3ComposerPlusMenu, T3ComposerPermissionsBtnMemo, T3ComposerQuotaRingMemo,
  T3ComposerContextRingMemo, T3UnifiedModelControlsMemo,
} = createUsageRingsRuntime({
${Object.entries(bindings).map(([name, binding]) => `  ${name}: ${binding},`).join("\n")}
});
`;
  return mountRuntime(patched, ctx, "usage-rings-ui", ["createUsageRingsRuntime"], bridge);
}

module.exports = {
  id: ID,
  name: NAME,
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: THREAD_ROUTE.preferredRegex,
  targetSpec: THREAD_ROUTE,
  originalHash: ORIGINAL_HASH,
  knownHashes: KNOWN_HASHES,
  apply,
  t3PairUsageWindows,
  t3SelectPrimaryQuotaForModel,
  t3PromptHasToken,
  t3ThreadCtxKey,
  t3ReviewCommentPrNum,
  t3EnvCtxId,
  t3EstimateOutputTokens,
};

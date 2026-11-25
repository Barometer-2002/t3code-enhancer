"use strict";

const assert = require("node:assert/strict");

const ID = "usage-rings";
const MARKER = "T3_USAGE_RINGS_V21";
const TARGET_REGEX = /^apps\/server\/dist\/client\/assets\/_chat-[\w-]+\.js$/;
const ORIGINAL_HASH = "e5f61017c214605ad2251948b0e53af63901b7337dd0b22c36feebb404b85654";

const duStart = "function DU(e){";
const ouStart = "function OU(e){";
const kuStart = "function kU(e){";
const composerLeftAnchor = 'hd&&!_c?(0,$.jsx)(`div`,{className:`me-2`,children:hd}):null,';
const composerControlsAnchor = 'className:Cr(`relative flex min-w-0 flex-1 items-center justify-end gap-0.5`,_c&&`hidden`),children:Vl})';
const composerReturnStartAnchor = 't[1173]=af):af=t[1173],(0,$.jsxs)(`form`,';
const composerReturnEndAnchor = 'tf,nf,rf,af]})})})]})});function zz(e)';
const providerReturnAnchor = 'return(0,$.jsx)(Ug,{threadRef:Xi,cwd:xu,checkpoints:Y?.checkpoints,children:bv})';
const tzControlsAnchor = 'children:[De,(0,$.jsxs)($.Fragment,{children:[me.map';
const permissionsLabelAnchor = 'children:[g,c.label,_]}),t[24]=o';

function t3ClassifyWindow(w) {
  const text = `${w.id || ""} ${w.label || ""}`.toLowerCase();
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
    const base = t3BaseWindowName(w.label);
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
      let a = list[0];
      let b = list[1];
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
        const ta = a.resetsAt ? Date.parse(a.resetsAt) : Infinity;
        const tb = b.resetsAt ? Date.parse(b.resetsAt) : Infinity;
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

  // Detect active model family & specific variant keywords
  const isClaude = hasModelToken(/\b(claude|opus|sonnet|haiku)\b/);
  const isGpt = hasModelToken(/\b(gpt|codex|o1|o3|o4)\b/);
  const isGemini = hasModelToken(/\b(gemini|neon|argon|hydrogen|flash|pro)\b/);
  const variants = ["argon", "neon", "hydrogen", "flash", "opus", "sonnet", "haiku", "spark", "mini", "nano", "pro", "ultra"]
    .filter(v => modelTokens.includes(v));

  let bestItem = null;
  let bestScore = -1;

  for (let i = 0; i < paired.length; i++) {
    const item = paired[i];
    const wins = item.kind === "dual" ? [item.shortWindow, item.longWindow] : [item.window];
    const winIds = wins.map(w => String(w?.id || "")).join(" ").toLowerCase().replace(/[-_]+/g, " ");
    const text = (
      item.kind === "dual"
        ? `${item.title || ""} ${item.shortWindow?.label || ""} ${item.longWindow?.label || ""} ${winIds}`
        : `${item.title || ""} ${item.window?.label || ""} ${winIds}`
    ).toLowerCase();

    let score = 0;

    // 0. Exact modelIds list match declared by backend usage window
    if (modelRaw && wins.some(w => Array.isArray(w?.modelIds) && w.modelIds.some(id => String(id).toLowerCase() === modelRaw))) {
      score += 200;
    }

    // 1. Exact specific sub-model variant match (e.g. "argon" -> "Gemini 4 Argon · Weekly")
    for (const v of variants) {
      if (new RegExp(`\\b${v}\\b`).test(text)) {
        score += 120;
      }
    }

    // 2. Penalize a specific variant pool when active model is a DIFFERENT variant (e.g. Neon shouldn't match Argon pool)
    const itemHasOtherVariant = ["argon", "neon", "hydrogen", "flash", "opus", "sonnet", "haiku", "spark"]
      .some(v => new RegExp(`\\b${v}\\b`).test(text) && !variants.includes(v));
    if (itemHasOtherVariant && score < 120) {
      score -= 60;
    }

    // 3. Model family match (including Antigravity `3p-*` third-party pool for Claude / GPT)
    if (isClaude && (/\bclaude\b/.test(text) || /\b3p\b/.test(winIds))) score += 60;
    if (isGpt && (/\b(gpt|codex|openai)\b/.test(text) || /\b3p\b/.test(winIds))) score += 60;
    if (isGemini && /\bgemini\b/.test(text)) score += 60;

    // 4. Generic pool (no provider/family name mentioned, e.g. "Session" / "Weekly" / "配额")
    const isNamedFamilyPool = /\b(claude|gpt|codex|openai|gemini|argon|neon|hydrogen|opus|sonnet|haiku|flash)\b/.test(text);
    if (!isNamedFamilyPool) score += 20;

    // 5. Prefer dual 5h/7d ring on equal family specificity
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

const RUNTIME_MODULE = `
/* ${MARKER} */
const T3RingsCtx = (0, Z.createContext)(null);
const T3ComposerCtx = (0, Z.createContext)(null);
const t3Memo = (fn) => (typeof Z !== "undefined" && typeof Z.memo === "function" ? (0, Z.memo)(fn) : fn);
const T3RingsCtxProvider = t3Memo(function T3RingsCtxProvider({
  providerInstanceId,
  providers,
  sources,
  contextWindow,
  activeModel,
  runs,
  messages,
  turnItems,
  children
}) {
  const threadStats = (0, Z.useMemo)(
    () => ({ runs, messages, turnItems }),
    [runs, messages, turnItems]
  );
  const value = (0, Z.useMemo)(
    () => ({ providerInstanceId, providers, sources, contextWindow, activeModel, threadStats }),
    [providerInstanceId, providers, sources, contextWindow, activeModel, threadStats]
  );
  return (0, $.jsx)(T3RingsCtx.Provider, { value, children });
});
const T3ComposerCtxProvider = t3Memo(function T3ComposerCtxProvider({
  canAttach,
  addComposerAttachments,
  focusComposer,
  composerRef,
  insertText,
  providerInstanceId,
  activeModel,
  runtimeMode,
  runtimeModeOptions,
  onRuntimeModeChange,
  composerDraftTarget,
  environmentId,
  routeThreadRef,
  gitCwd,
  pullRequestProjectId,
  activeThreadId,
  linkedEnvironments,
  skills,
  pullRequests,
  children
}) {
  const focusAtEnd = (0, Z.useCallback)(() => composerRef?.current?.focusAtEnd(), [composerRef]);
  const value = (0, Z.useMemo)(
    () => ({
      canAttach,
      addComposerAttachments,
      focusComposer,
      focusAtEnd,
      insertText,
      providerInstanceId,
      activeModel,
      runtimeMode,
      runtimeModeOptions,
      onRuntimeModeChange,
      composerDraftTarget,
      environmentId,
      routeThreadRef,
      gitCwd,
      pullRequestProjectId,
      activeThreadId,
      linkedEnvironments,
      skills,
      pullRequests
    }),
    [
      canAttach,
      addComposerAttachments,
      focusComposer,
      focusAtEnd,
      insertText,
      providerInstanceId,
      activeModel,
      runtimeMode,
      runtimeModeOptions,
      onRuntimeModeChange,
      composerDraftTarget,
      environmentId,
      routeThreadRef,
      gitCwd,
      pullRequestProjectId,
      activeThreadId,
      linkedEnvironments,
      skills,
      pullRequests
    ]
  );
  return (0, $.jsx)(T3ComposerCtx.Provider, { value, children });
});
${t3ClassifyWindow.toString()}
${t3BaseWindowName.toString()}
${t3PairUsageWindows.toString()}
${t3SelectPrimaryQuotaForModel.toString()}
${t3PromptHasToken.toString()}
${t3ThreadCtxKey.toString()}
${t3ReviewCommentPrNum.toString()}
${t3EnvCtxId.toString()}

(function t3EnsureEnhancerStyles() {
  if (typeof document === "undefined" || !document.head) return;
  const styleId = "t3-enhancer-rings-style-v4";
  if (document.getElementById(styleId)) return;
  const elStyle = document.createElement("style");
  elStyle.id = styleId;
  elStyle.textContent = \`
    /* 统一尺寸约定：底栏主圆钮 30px (+17px)、底栏胶囊 28px (圆角 8px)、模型触发器 32px、菜单与弹出图标 15px (1.35px 线宽) */
    .t3e-plus-btn {
      width: 30px;
      height: 30px;
      border: 0;
      border-radius: 9999px;
      background-color: transparent;
      box-shadow: none !important;
      color: var(--muted-foreground);
      transition: background-color 140ms ease, color 140ms ease, transform 110ms ease;
    }
    .t3e-plus-btn:hover {
      background-color: rgba(0, 0, 0, 0.06);
      color: var(--foreground);
    }
    .t3e-plus-btn[data-popup-open],
    .t3e-plus-btn:active {
      background-color: rgba(0, 0, 0, 0.095);
      color: var(--foreground);
    }
    .t3e-plus-btn:active {
      transform: scale(0.95);
    }
    .dark .t3e-plus-btn {
      background-color: transparent;
      color: var(--muted-foreground);
    }
    .dark .t3e-plus-btn:hover {
      background-color: rgba(255, 255, 255, 0.09);
      color: var(--foreground);
    }
    .dark .t3e-plus-btn[data-popup-open],
    .dark .t3e-plus-btn:active {
      background-color: rgba(255, 255, 255, 0.14);
      color: var(--foreground);
    }
    [data-slot="popover-popup"]:has(.t3e-plus-panel) {
      border-radius: 16px !important;
      padding: 0 !important;
    }
    [data-slot="popover-popup"]:has(.t3e-plus-panel)::before {
      border-radius: 16px !important;
    }
    [data-slot="popover-popup"]:has(.t3e-plus-panel) > [data-slot="popover-viewport"] {
      padding: 0 !important;
      --viewport-inline-padding: 0px !important;
    }
    .t3e-plus-panel {
      display: flex;
      width: min(460px, calc(100vw - 32px));
      max-height: min(440px, 62dvh);
      flex-direction: column;
      color: var(--foreground);
    }
    .t3e-plus-search-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px 7px;
      border-bottom: 1px solid var(--border);
    }
    .t3e-plus-search-icon {
      width: 14px !important;
      height: 14px !important;
      flex-shrink: 0;
      color: var(--muted-foreground);
      opacity: 0.72;
    }
    .t3e-plus-search-wrap .t3e-model-search {
      height: 28px;
      padding: 0 4px;
      border: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
      font-size: 13px;
    }
    .t3e-plus-list {
      display: flex;
      flex: 1 1 auto;
      min-height: 0;
      flex-direction: column;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 6px 8px 10px;
      gap: 1px;
    }
    .t3e-plus-sec {
      padding: 10px 10px 4px;
      font-size: 11.5px;
      line-height: 16px;
      font-weight: 500;
      color: var(--muted-foreground);
    }
    .t3e-plus-sec:first-child {
      padding-top: 3px;
    }
    .t3e-plus-empty-hint {
      padding: 5px 10px 6px;
      font-size: 12.5px;
      line-height: 18px;
      color: var(--muted-foreground);
      opacity: 0.78;
    }
    .t3e-plus-footer {
      display: flex;
      align-items: center;
      padding: 6px 12px;
      border-top: 1px solid var(--border);
      font-size: 11px;
      line-height: 15px;
      color: var(--muted-foreground);
      opacity: 0.85;
      user-select: none;
      flex-shrink: 0;
    }
    .t3e-row[data-active="true"] {
      background-color: rgba(0, 0, 0, 0.06);
    }
    .dark .t3e-row[data-active="true"] {
      background-color: rgba(255, 255, 255, 0.095);
    }
    .t3e-menu-row[data-active="true"] .t3e-menu-icon-slot {
      color: var(--foreground);
    }
    .t3e-plus-tag {
      flex-shrink: 0;
      font-size: 11.5px;
      line-height: 16px;
      color: var(--muted-foreground);
      opacity: 0.78;
    }
    .t3e-plus-btn svg,
    .t3e-plus-btn svg.lucide {
      width: 17px !important;
      height: 17px !important;
      stroke-width: 1.65px !important;
      flex-shrink: 0;
    }
    .t3e-plus-btn svg :is(path, line, circle, rect, polyline, polygon) {
      vector-effect: non-scaling-stroke !important;
    }

    /* 底栏胶囊控件：与 4 Neon High 按钮完全同款的 8px 圆角柔和灰底纹 */
    .t3e-pill {
      height: 28px;
      padding: 0 8px;
      border-radius: 8px;
      font-size: 12.5px;
      line-height: 1;
      background-color: transparent;
      transition: background-color 140ms ease, color 140ms ease;
    }
    .t3e-pill:hover,
    .t3e-pill:focus-visible,
    .t3e-pill[data-popup-open] {
      background-color: rgba(0, 0, 0, 0.06);
      color: var(--foreground);
    }
    .t3e-pill:active {
      background-color: rgba(0, 0, 0, 0.095);
    }
    .dark .t3e-pill:hover,
    .dark .t3e-pill:focus-visible,
    .dark .t3e-pill[data-popup-open] {
      background-color: rgba(255, 255, 255, 0.095);
      color: var(--foreground);
    }
    .dark .t3e-pill:active {
      background-color: rgba(255, 255, 255, 0.14);
    }

    /* 菜单条目 & 右侧详情行：统一 8px 圆角柔和底纹 */
    .t3e-row {
      border-radius: 8px;
      background-color: transparent;
      text-decoration: none !important;
      transition: background-color 140ms ease, color 140ms ease;
    }
    .t3e-row * {
      text-decoration: none !important;
    }
    .t3e-active-badge {
      padding: 1px 5px;
      border-radius: 9999px;
      font-size: 10px;
      line-height: 14px;
      font-weight: 500;
      background-color: var(--cx-accent-soft, rgba(37, 99, 235, 0.10));
      color: var(--cx-accent, #2563eb);
    }
    .dark .t3e-active-badge {
      background-color: var(--cx-accent-soft, rgba(96, 165, 250, 0.16));
      color: var(--cx-accent, #60a5fa);
    }
    .t3e-row:hover,
    .t3e-row:focus-visible,
    .t3e-row[data-popup-open] {
      background-color: rgba(0, 0, 0, 0.06);
    }
    .t3e-row:active {
      background-color: rgba(0, 0, 0, 0.095);
    }
    .dark .t3e-row:hover,
    .dark .t3e-row:focus-visible,
    .dark .t3e-row[data-popup-open] {
      background-color: rgba(255, 255, 255, 0.095);
    }
    .dark .t3e-row:active {
      background-color: rgba(255, 255, 255, 0.14);
    }

    /* 菜单内图标统一锁定：15px 尺寸 + 1.35px 等物理线宽 */
    .t3e-menu-row {
      min-height: 32px;
      padding: 5px 10px;
      gap: 10px;
    }
    .t3e-menu-icon-slot {
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--muted-foreground);
      transition: color 140ms ease;
    }
    .t3e-menu-row:hover .t3e-menu-icon-slot {
      color: var(--foreground);
    }
    .t3e-menu-icon,
    .t3e-menu-icon-slot svg,
    .t3e-menu-icon-slot svg.lucide {
      width: 15px !important;
      height: 15px !important;
      stroke-width: 1.35px !important;
      stroke-linecap: round !important;
      stroke-linejoin: round !important;
      flex-shrink: 0;
    }
    .t3e-menu-icon-slot svg :is(path, circle, rect, line, polyline, polygon, ellipse) {
      vector-effect: non-scaling-stroke !important;
    }

    .t3e-text-125 {
      font-size: 12.5px;
      line-height: 16px;
    }
    .t3e-text-115 {
      font-size: 11.5px;
      line-height: 16px;
    }

    /* ChatGPT 风格推理强度滑块 & Harness 快切样式 */
    [data-slot="popover-popup"]:has(.t3e-effort-card) {
      border-radius: 20px !important;
      padding: 0 !important;
    }
    [data-slot="popover-popup"]:has(.t3e-effort-card)::before {
      border-radius: 20px !important;
    }
    [data-slot="popover-popup"]:has(.t3e-effort-card) > [data-slot="popover-viewport"] {
      padding: 0 !important;
      --viewport-inline-padding: 0px !important;
    }
    .t3e-effort-card {
      display: flex;
      width: 248px;
      flex-direction: column;
      gap: 11px;
      padding: 10px 11px 11px;
      color: var(--foreground);
    }
    .t3e-effort-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 4px;
    }
    .t3e-effort-title {
      color: var(--cx-accent, #2563eb);
    }
    .dark .t3e-effort-title {
      color: var(--cx-accent, #60a5fa);
    }
    .t3e-effort-heading {
      font-size: 15px;
      line-height: 20px;
    }
    .t3e-effort-switch-btn {
      display: flex;
      min-width: 116px;
      max-width: 168px;
      flex: 0 1 auto;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1px;
      padding: 2px 12px 4px;
      border: 0;
      border-radius: 10px;
      background: transparent;
      cursor: pointer;
      outline: none !important;
      box-shadow: none !important;
      transition: background-color 140ms ease, transform 100ms ease;
    }
    .t3e-effort-switch-btn:hover {
      background-color: rgba(0, 0, 0, 0.055);
    }
    .t3e-effort-switch-btn:active {
      background-color: rgba(0, 0, 0, 0.09);
      transform: scale(0.985);
    }
    .dark .t3e-effort-switch-btn:hover {
      background-color: rgba(255, 255, 255, 0.09);
    }
    .dark .t3e-effort-switch-btn:active {
      background-color: rgba(255, 255, 255, 0.14);
    }
    .t3e-effort-switch-btn:focus:not(:focus-visible),
    .t3e-icon-btn:focus:not(:focus-visible),
    .t3e-pill:focus:not(:focus-visible),
    .t3e-perm-btn:focus:not(:focus-visible),
    .t3e-perm-opt:focus:not(:focus-visible),
    .t3e-row:focus:not(:focus-visible),
    .t3e-harness-chip:focus:not(:focus-visible),
    .t3e-slider-track:focus:not(:focus-visible),
    .t3e-plus-btn:focus:not(:focus-visible) {
      outline: none !important;
      box-shadow: none !important;
    }
    .t3e-effort-switch-btn:focus-visible,
    .t3e-icon-btn:focus-visible,
    .t3e-pill:focus-visible,
    .t3e-perm-btn:focus-visible,
    .t3e-perm-opt:focus-visible,
    .t3e-row:focus-visible,
    .t3e-harness-chip:focus-visible,
    .t3e-slider-track:focus-visible,
    .t3e-plus-btn:focus-visible {
      outline: none !important;
      box-shadow: 0 0 0 2px var(--cx-accent-soft, rgba(37, 99, 235, 0.28)) !important;
    }
    .t3e-effort-model-sub {
      display: inline-flex;
      max-width: 100%;
      align-items: center;
      justify-content: center;
      gap: 2px;
      font-size: 12.5px;
      line-height: 17px;
      color: var(--muted-foreground);
    }
    .t3e-effort-switch-btn:hover .t3e-effort-model-sub {
      color: var(--foreground);
    }
    .t3e-slider-track {
      position: relative;
      height: 30px;
      width: 100%;
      border-radius: 9999px;
      background-color: rgba(0, 0, 0, 0.08);
      cursor: pointer;
      touch-action: none;
      user-select: none;
      overflow: visible;
    }
    .dark .t3e-slider-track {
      background-color: rgba(255, 255, 255, 0.12);
    }
    .t3e-slider-fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 1;
      border-radius: 9999px;
      background: linear-gradient(90deg, var(--cx-accent-bright, #3b82f6) 0%, var(--cx-accent, #2563eb) 100%);
      transition: width 150ms cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: none;
    }
    .dark .t3e-slider-fill {
      background: linear-gradient(90deg, var(--cx-accent, #60a5fa) 0%, var(--cx-accent-bright, #3b82f6) 100%);
    }
    .t3e-slider-thumb {
      position: absolute;
      top: 50%;
      width: 28px;
      height: 28px;
      border-radius: 9999px;
      background-color: #ffffff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14), 0 0 0 1px rgba(0, 0, 0, 0.07);
      transform: translate(-50%, -50%);
      transition: left 150ms cubic-bezier(0.22, 1, 0.36, 1), transform 110ms ease;
      pointer-events: none;
      z-index: 3;
    }
    .t3e-slider-track:active .t3e-slider-thumb {
      transform: translate(-50%, -50%) scale(1.04);
    }
    /* 最高档：蓝紫流动渐变 + 两层漂移闪烁的星点 */
    .t3e-slider-track[data-max="true"] .t3e-slider-fill {
      overflow: hidden;
      background-color: #5b5cf6;
      background-image: linear-gradient(90deg, #2f6bff 0%, #5b5cf6 40%, #9b5cf6 72%, #c45cf2 100%);
      background-size: 200% 100%;
      box-shadow: 0 0 14px rgba(139, 92, 246, 0.45);
      animation: t3e-max-flow 4s ease-in-out infinite alternate;
    }
    .t3e-slider-track[data-max="true"] .t3e-slider-fill::before,
    .t3e-slider-track[data-max="true"] .t3e-slider-fill::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    /* 每层平铺宽度互不相同，漂移距离等于各自宽度，循环无跳变且看不出网格 */
    .t3e-slider-track[data-max="true"] .t3e-slider-fill::before {
      background-image:
        radial-gradient(circle at 9px 8px, rgba(255, 255, 255, 0.95) 0 1px, transparent 1.7px),
        radial-gradient(circle at 31px 21px, rgba(255, 255, 255, 0.7) 0 0.8px, transparent 1.4px),
        radial-gradient(circle at 18px 14px, rgba(255, 255, 255, 0.8) 0 0.9px, transparent 1.5px),
        radial-gradient(circle at 44px 24px, rgba(255, 255, 255, 0.6) 0 0.7px, transparent 1.3px);
      background-size: 47px 30px, 53px 30px, 37px 30px, 61px 30px;
      animation: t3e-max-drift 7s linear infinite, t3e-max-twinkle 2.4s ease-in-out infinite;
    }
    .t3e-slider-track[data-max="true"] .t3e-slider-fill::after {
      background-image:
        radial-gradient(circle at 20px 11px, rgba(255, 255, 255, 0.95) 0 1.4px, transparent 2.2px),
        radial-gradient(circle at 60px 20px, rgba(255, 255, 255, 0.85) 0 1.1px, transparent 1.8px);
      background-size: 89px 30px, 79px 30px;
      animation: t3e-max-drift-slow 11s linear infinite, t3e-max-twinkle 3.1s ease-in-out -1.2s infinite;
    }
    @keyframes t3e-max-flow {
      from { background-position: 0% 50%; }
      to { background-position: 100% 50%; }
    }
    @keyframes t3e-max-drift {
      from { background-position: 0 0, 0 0, 0 0, 0 0; }
      to { background-position: 47px 0, 53px 0, 37px 0, 61px 0; }
    }
    @keyframes t3e-max-drift-slow {
      from { background-position: 0 0, 0 0; }
      to { background-position: 89px 0, 79px 0; }
    }
    @keyframes t3e-max-twinkle {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.45; }
    }
    @media (prefers-reduced-motion: reduce) {
      .t3e-slider-track[data-max="true"] .t3e-slider-fill,
      .t3e-slider-track[data-max="true"] .t3e-slider-fill::before,
      .t3e-slider-track[data-max="true"] .t3e-slider-fill::after {
        animation: none;
      }
    }
    .t3e-icon-btn {
      width: 30px;
      height: 30px;
      margin-top: 0;
      border-radius: 9px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background-color: transparent;
      color: var(--muted-foreground);
      transition: background-color 140ms ease, color 140ms ease;
    }
    .t3e-icon-btn:hover:not(:disabled):not([aria-disabled="true"]) {
      background-color: rgba(0, 0, 0, 0.055);
      color: var(--foreground);
    }
    .dark .t3e-icon-btn {
      background-color: transparent;
    }
    .dark .t3e-icon-btn:hover:not(:disabled):not([aria-disabled="true"]) {
      background-color: rgba(255, 255, 255, 0.10);
      color: var(--foreground);
    }
    .t3e-icon-btn[data-active="true"] {
      background-color: transparent;
      color: var(--cx-accent, #2563eb);
    }
    .t3e-icon-btn[data-active="true"]:hover:not(:disabled):not([aria-disabled="true"]) {
      background-color: var(--cx-accent-soft, rgba(37, 99, 235, 0.10));
      color: var(--cx-accent-hover, #1d4ed8);
    }
    .dark .t3e-icon-btn[data-active="true"] {
      background-color: transparent;
      color: var(--cx-accent, #60a5fa);
    }
    .dark .t3e-icon-btn[data-active="true"]:hover:not(:disabled):not([aria-disabled="true"]) {
      background-color: var(--cx-accent-soft, rgba(96, 165, 250, 0.16));
      color: var(--cx-accent-hover, #93c5fd);
    }
    .t3e-fast-inline {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-inline-end: -1px;
      color: var(--cx-accent, #2563eb);
      flex-shrink: 0;
    }
    .dark .t3e-fast-inline {
      color: var(--cx-accent, #60a5fa);
    }
    .t3e-icon-btn:disabled,
    .t3e-icon-btn[aria-disabled="true"] {
      opacity: 0.38;
      cursor: not-allowed;
    }
    .t3e-icon-btn svg {
      flex-shrink: 0;
    }
    .t3e-icon-btn svg :is(path, circle, rect, line, polyline, polygon) {
      vector-effect: non-scaling-stroke !important;
    }
    .t3e-harness-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 5px;
    }
    .t3e-harness-chip {
      height: 28px;
      width: 100%;
      padding: 0 8px;
      border-radius: 8px;
      border: 1px solid rgba(0, 0, 0, 0.06);
      background-color: rgba(0, 0, 0, 0.02);
      transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .t3e-harness-chip:hover:not(:disabled) {
      background-color: rgba(0, 0, 0, 0.06);
      border-color: rgba(0, 0, 0, 0.10);
      color: var(--foreground);
    }
    .dark .t3e-harness-chip {
      border-color: rgba(255, 255, 255, 0.07);
      background-color: rgba(255, 255, 255, 0.03);
    }
    .dark .t3e-harness-chip:hover:not(:disabled) {
      background-color: rgba(255, 255, 255, 0.09);
      border-color: rgba(255, 255, 255, 0.14);
      color: var(--foreground);
    }
    .t3e-harness-chip[data-selected="true"] {
      background-color: var(--cx-accent-soft, rgba(37, 99, 235, 0.10));
      border-color: var(--cx-accent-border, rgba(37, 99, 235, 0.34));
      color: var(--foreground);
    }
    .dark .t3e-harness-chip[data-selected="true"] {
      background-color: var(--cx-accent-soft, rgba(96, 165, 250, 0.16));
      border-color: var(--cx-accent-border, rgba(96, 165, 250, 0.40));
      color: var(--foreground);
    }
    .t3e-harness-chip:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }
    .t3e-model-trigger {
      height: 32px;
      padding: 0 11px;
      border-radius: 10px;
      max-width: 268px;
      gap: 6px;
      font-size: 13px;
      line-height: 18px;
    }
    .t3e-model-name {
      display: inline-flex;
      align-items: center;
      font-size: 13px;
      line-height: 18px;
    }
    .t3e-model-eff-sep {
      display: inline-flex;
      align-items: center;
      font-size: 12.5px;
      line-height: 18px;
      font-weight: 400;
      color: var(--muted-foreground);
      flex-shrink: 0;
    }
    .t3e-perm-btn {
      display: inline-flex;
      height: 30px;
      flex-shrink: 0;
      align-items: center;
      gap: 5px;
      border: 0;
      border-radius: 999px;
      padding: 0 10px;
      background: transparent;
      color: var(--muted-foreground);
      font-size: 13px;
      line-height: 18px;
      font-weight: 400;
      cursor: pointer;
      outline: none;
      transition: background-color 140ms ease, color 140ms ease;
    }
    .t3e-perm-btn:hover,
    .t3e-perm-btn[data-popup-open] {
      background-color: rgba(0, 0, 0, 0.055);
      color: var(--foreground);
    }
    .dark .t3e-perm-btn:hover,
    .dark .t3e-perm-btn[data-popup-open] {
      background-color: rgba(255, 255, 255, 0.09);
      color: var(--foreground);
    }
    .t3e-perm-btn[data-full-access="true"] {
      color: #9a4e1c;
    }
    .dark .t3e-perm-btn[data-full-access="true"] {
      color: #f59e0b;
    }
    .t3e-perm-btn[data-full-access="true"]:hover,
    .t3e-perm-btn[data-full-access="true"][data-popup-open] {
      background-color: rgba(154, 78, 28, 0.09);
    }
    .dark .t3e-perm-btn[data-full-access="true"]:hover,
    .dark .t3e-perm-btn[data-full-access="true"][data-popup-open] {
      background-color: rgba(245, 158, 11, 0.14);
    }
    .t3e-perm-card {
      display: flex;
      width: 288px;
      flex-direction: column;
      gap: 2px;
      padding: 4px;
      color: var(--foreground);
    }
    .t3e-perm-hdr {
      padding: 4px 10px 6px;
      font-size: 12px;
      line-height: 16px;
      color: var(--muted-foreground);
    }
    .t3e-perm-opt {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border: 0;
      border-radius: 10px;
      background: transparent;
      text-align: left;
      cursor: pointer;
      transition: background-color 130ms ease;
    }
    .t3e-perm-opt:hover:not(:disabled) {
      background-color: rgba(0, 0, 0, 0.05);
    }
    .dark .t3e-perm-opt:hover:not(:disabled) {
      background-color: rgba(255, 255, 255, 0.08);
    }
    .t3e-perm-opt:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }
    .t3e-perm-opt-icon {
      display: inline-flex;
      width: 18px;
      height: 18px;
      flex-shrink: 0;
      align-items: center;
      justify-content: center;
      color: var(--foreground);
      opacity: 0.85;
    }
    .t3e-perm-opt-body {
      display: flex;
      min-width: 0;
      flex: 1 1 auto;
      flex-direction: column;
      gap: 1px;
    }
    .t3e-perm-opt-title {
      font-size: 13px;
      line-height: 18px;
      font-weight: 500;
      color: var(--foreground);
    }
    .t3e-perm-opt-desc {
      font-size: 12px;
      line-height: 16px;
      color: var(--muted-foreground);
    }
    .t3e-perm-opt[data-danger="true"] .t3e-perm-opt-icon,
    .t3e-perm-opt[data-danger="true"] .t3e-perm-opt-title,
    .t3e-perm-opt[data-danger="true"] .t3e-perm-opt-desc,
    .t3e-perm-opt[data-danger="true"] .t3e-perm-check {
      color: #9a4e1c;
    }
    .dark .t3e-perm-opt[data-danger="true"] .t3e-perm-opt-icon,
    .dark .t3e-perm-opt[data-danger="true"] .t3e-perm-opt-title,
    .dark .t3e-perm-opt[data-danger="true"] .t3e-perm-opt-desc,
    .dark .t3e-perm-opt[data-danger="true"] .t3e-perm-check {
      color: #f59e0b;
    }
    .t3e-perm-check {
      width: 15px !important;
      height: 15px !important;
      flex-shrink: 0;
      color: var(--foreground);
    }
    [data-resting-block="mode"],
    [data-resting-block="permissions"],
    [data-composer-permissions-trigger]:not([data-t3e-own-perm="true"]) {
      display: none !important;
    }
    .t3e-model-search {
      height: 28px;
      width: 100%;
      padding: 0 9px;
      border-radius: 8px;
      border: 1px solid rgba(0, 0, 0, 0.08);
      background-color: rgba(0, 0, 0, 0.025);
      color: var(--foreground);
      font-size: 12px;
      outline: none;
      transition: border-color 140ms ease, background-color 140ms ease;
    }
    .t3e-model-search:focus {
      border-color: var(--cx-accent-border, rgba(37, 99, 235, 0.48));
      background-color: var(--background);
    }
    .dark .t3e-model-search {
      border-color: rgba(255, 255, 255, 0.10);
      background-color: rgba(255, 255, 255, 0.04);
    }
    .dark .t3e-model-search:focus {
      border-color: var(--cx-accent-border, rgba(96, 165, 250, 0.50));
      background-color: rgba(255, 255, 255, 0.06);
    }
    .t3e-model-list {
      max-height: 216px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .t3e-model-row {
      min-height: 29px;
      padding: 4px 8px;
      gap: 6px;
    }
    .t3e-model-row[data-selected="true"] {
      background-color: rgba(0, 0, 0, 0.055);
    }
    .dark .t3e-model-row[data-selected="true"] {
      background-color: rgba(255, 255, 255, 0.09);
    }
    .t3e-glyph { flex-shrink: 0; }
    html body svg.lucide.t3e-chev { width: 12px !important; height: 12px !important; opacity: 0.7; transition: opacity 140ms ease; }
    .t3e-row:hover svg.lucide.t3e-chev { opacity: 1; }
    html body svg.lucide.t3e-arrow { width: 13px !important; height: 13px !important; }
    html body svg.lucide.t3e-check { width: 15px !important; height: 15px !important; color: var(--cx-accent, #2563eb); }
    .dark svg.lucide.t3e-check { color: var(--cx-accent, #60a5fa); }
    /* 面板开合也会缩窄输入框，按输入框自身宽度决定底栏布局。 */
    [data-chat-composer-form] { container: t3e-composer / inline-size; }
    .t3e-model-trigger { min-inline-size: 32px; }
    .t3e-model-name { min-inline-size: 0; }
    .t3e-effort-tick {
      position: absolute;
      top: 50%;
      z-index: 2;
      width: 4px;
      height: 4px;
      border-radius: 9999px;
      transform: translate(-50%, -50%);
      pointer-events: none;
      background: rgba(127, 127, 127, 0.45);
      transition: background-color 140ms ease;
    }
    .t3e-effort-tick[data-filled="true"] {
      background: rgba(255, 255, 255, 0.48);
    }
    .t3e-harness-quota {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 8px;
      padding: 5px 8px;
      border-radius: 8px;
      font-size: 11px;
      line-height: 1.25;
      background: rgba(0, 0, 0, 0.035);
      border: 1px solid rgba(0, 0, 0, 0.06);
      font-variant-numeric: tabular-nums;
    }
    .dark .t3e-harness-quota {
      background: rgba(255, 255, 255, 0.045);
      border-color: rgba(255, 255, 255, 0.08);
    }
    .t3e-harness-quota-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    .t3e-model-quota {
      font-size: 11px;
      line-height: 1;
      color: var(--muted-foreground);
      font-variant-numeric: tabular-nums;
    }
    [data-chat-composer-footer-controls]:has(> .t3e-model-trigger) {
      justify-content: safe flex-end;
    }
    @container t3e-composer (width < 496px) {
      .t3e-footer-left { margin-inline-end: 4px; gap: 4px; }
      [data-chat-composer-actions="right"] { gap: 4px; }
      .t3e-ctx-text { display: none; }
    }
    @container t3e-composer (width < 426px) {
      .t3e-context-trigger,
      .t3e-q-text,
      .t3e-eff-text,
      .t3e-permissions-label { display: none; }
      .t3e-footer-left > .t3e-pill,
      :is([data-chat-composer-footer-controls], [data-chat-composer-resting-controls]) > .t3e-pill {
        padding-inline: 4px;
        gap: 3px;
      }
      .t3e-model-trigger { min-inline-size: 28px; }
      :is([data-chat-composer-footer-controls], [data-chat-composer-resting-controls]) [data-composer-permissions-trigger] {
        padding-inline: 4px;
        gap: 3px;
      }
    }
    @container t3e-composer (width < 240px) {
      [data-chat-composer-footer]:has(> .t3e-footer-left) {
        flex-wrap: wrap;
        row-gap: 4px;
      }
      .t3e-footer-left + [data-chat-composer-actions="right"] {
        min-inline-size: min(100%, 146px);
      }
    }

    .t3e-model-row:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  \`;
  document.head.appendChild(elStyle);
})();

function t3QuotaColor(pct, isOuter) {
  if (pct <= 10) return "#DC2626";
  if (pct <= 20) return "#D97706";
  return isOuter ? "#D4714E" : "#2F855A";
}

function t3ContextColor(pct) {
  if (pct >= 90) return "#DC2626";
  if (pct >= 80) return "#D97706";
  return "currentColor";
}

function t3FormatPct(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return null;
  const clamped = Math.max(0, Math.min(100, Number(pct)));
  return (clamped > 0 && clamped < 10 ? clamped.toFixed(1) : Math.round(clamped)) + "%";
}

const T3RingSvg = t3Memo(function T3RingSvg({ size = 36, outerPct = null, innerPct = null, outerColor = "#D4714E", innerColor = "#2F855A", stroke = 3.3, gap = null, trackOpacity = 0.16 }) {
  const c = size / 2;
  const dual = outerPct !== null && innerPct !== null;
  const pad = size <= 20 ? 0.3 : 0.5;
  const ringGap = gap !== null ? gap : (size <= 20 ? 1.4 : 2.2);
  const rOut = c - stroke / 2 - pad;
  const rIn = dual ? Math.max(2.6, rOut - stroke - ringGap) : rOut;
  const ring = (r, pct, color, key) => {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const circ = 2 * Math.PI * r;
    const dash = (p / 100) * circ;
    return (0, $.jsxs)(Z.Fragment, {
      children: [
        (0, $.jsx)("circle", {
          cx: c, cy: c, r, fill: "none",
          stroke: color === "currentColor" ? "currentColor" : color,
          strokeOpacity: trackOpacity, strokeWidth: stroke
        }),
        p > 0 ? (0, $.jsx)("circle", {
          cx: c, cy: c, r, fill: "none",
          stroke: color, strokeWidth: stroke, strokeLinecap: "round",
          strokeDasharray: \`\${dash.toFixed(2)} \${circ.toFixed(2)}\`,
          transform: \`rotate(-90 \${c} \${c})\`
        }) : null
      ]
    }, key);
  };
  return (0, $.jsxs)("svg", {
    "data-t3-ring": "true",
    width: size, height: size, viewBox: \`0 0 \${size} \${size}\`,
    className: "block shrink-0 overflow-visible",
    "aria-hidden": true,
    children: [
      outerPct !== null ? ring(rOut, outerPct, outerColor, "outer") : null,
      innerPct !== null ? ring(dual ? rIn : rOut, innerPct, innerColor, "inner") : null
    ]
  });
});

function t3WindowTooltipLines(w, now, tFn, fmtFn, tsFmt) {
  const left = U_(w);
  const pace = Y_(w, now);
  const timeLeft = K_(w, now);
  const resetMs = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  const resetStr = w.resetsAt && resetMs > now
    ? tFn("Resets in {duration} · {time}", { duration: wC(resetMs - now, fmtFn), time: zp(w.resetsAt, tsFmt, now, void 0, fmtFn) })
    : null;
  return (0, $.jsxs)("div", {
    className: "flex flex-col gap-0.5",
    children: [
      (0, $.jsx)("span", { className: "font-medium text-foreground", children: tFn("{label}: {left}% left", { label: w.label, left }) }),
      pace && timeLeft !== null
        ? (0, $.jsxs)("span", { className: "text-muted-foreground", children: [fmtFn(EU[pace]), " · ", tFn("{timeLeft}% of the window left", { timeLeft })] })
        : null,
      resetStr ? (0, $.jsx)("span", { className: "text-muted-foreground", children: resetStr }) : null
    ]
  }, w.id);
}

function t3ResolveLimits(ctx, now) {
  if (!ctx || ctx.providerInstanceId === null) return null;
  const { providerInstanceId: pid, providers, sources } = ctx;
  return (J_(pid, providers, sources, now)?.accounts.find(a => a.instanceId === pid)?.limits)
    ?? providers?.find(p => p.instanceId === pid)?.usageLimits
    ?? null;
}

function t3UrIsZh() {
  return typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
}

function t3FormatDurationMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return Math.round(ms) + " ms";
  const sec = ms / 1000;
  const isZh = t3UrIsZh();
  if (sec < 60) return (sec < 10 ? sec.toFixed(1) : Math.round(sec)) + (isZh ? " 秒" : "s");
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (isZh) return s > 0 ? \`\${m} 分 \${s} 秒\` : \`\${m} 分\`;
  return s > 0 ? \`\${m}m \${s}s\` : \`\${m}m\`;
}

function t3FormatCost(cost) {
  if (!cost || typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount <= 0) return null;
  const sym = !cost.currency || cost.currency === "USD" ? "$" : \`\${cost.currency} \`;
  const val = cost.amount < 1 ? cost.amount.toFixed(3) : cost.amount.toFixed(2);
  return \`\${sym}\${val}\`;
}

function t3HitRate(cached, total) {
  if (typeof cached !== "number" || typeof total !== "number" || total <= 0 || cached < 0) return null;
  const pct = Math.max(0, Math.min(100, (cached / total) * 100));
  return pct.toFixed(1) + "%";
}

function T3QuotaPopoverCard({ limits, now, tFn, fmtFn, activeKey, providerName, onClose }) {
  const isZh = t3UrIsZh();
  const windows = limits && !TC(limits, fmtFn) ? limits.windows : [];
  const paired = t3PairUsageWindows(windows);
  const shortReset = (w) => {
    const resetMs = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    return w.resetsAt && resetMs > now ? wC(resetMs - now, fmtFn) : null;
  };
  return (0, $.jsxs)("div", {
    className: "flex w-72 flex-col gap-2.5 p-1 text-xs text-foreground",
    children: [
      (0, $.jsxs)("div", {
        className: "flex items-center justify-between gap-2 px-1",
        children: [
          (0, $.jsx)("span", { className: "text-[13px] font-semibold leading-none tracking-tight text-foreground", children: isZh ? "用量" : "Usage" }),
          (0, $.jsx)("span", { className: "truncate text-[11px] text-muted-foreground", children: providerName ? (isZh ? \`\${providerName} · 实时配额\` : \`\${providerName} · Live quota\`) : (isZh ? "5h / 7d 实时配额" : "5h / 7d live quota") })
        ]
      }),
      paired.length > 0 ? (0, $.jsx)("div", {
        className: "flex flex-col gap-1",
        children: paired.map(item => {
          const isCurrent = Boolean(activeKey && item.key === activeKey);
          if (item.kind === "dual") {
            const sPct = U_(item.shortWindow);
            const lPct = U_(item.longWindow);
            const sCol = t3QuotaColor(sPct, false);
            const lCol = t3QuotaColor(lPct, true);
            const sDur = shortReset(item.shortWindow);
            const lDur = shortReset(item.longWindow);
            return (0, $.jsxs)(tp, {
              to: "/usage",
              onClick: onClose,
              className: "t3e-row flex cursor-pointer items-center gap-3 px-2 py-1.5 text-left",
              children: [
                (0, $.jsx)(T3RingSvg, { size: 36, outerPct: lPct, innerPct: sPct, outerColor: lCol, innerColor: sCol, stroke: 3.2, gap: 2.0 }),
                (0, $.jsxs)("div", {
                  className: "flex min-w-0 flex-1 flex-col gap-0.5",
                  children: [
                    (0, $.jsxs)("div", {
                      className: "flex items-center gap-1.5",
                      children: [
                        (0, $.jsx)("span", { className: "t3e-text-125 truncate font-medium text-foreground", children: item.title }),
                        isCurrent ? (0, $.jsx)("span", { className: "t3e-active-badge shrink-0", children: isZh ? "当前" : "Active" }) : null
                      ]
                    }),
                    (0, $.jsxs)("div", {
                      className: "t3e-text-115 flex items-center justify-between gap-2 tabular-nums",
                      children: [
                        (0, $.jsxs)("span", {
                          className: "inline-flex shrink-0 items-center gap-1 text-muted-foreground",
                          children: [
                            (0, $.jsx)("span", { className: "inline-block size-1.5 rounded-full", style: { backgroundColor: sCol } }),
                            "5h ", (0, $.jsx)("span", { className: "font-medium text-foreground", style: sPct <= 20 ? { color: sCol } : undefined, children: \`\${sPct}%\` })
                          ]
                        }),
                        sDur ? (0, $.jsx)("span", { className: "truncate text-[11px] text-muted-foreground", children: isZh ? \`\${sDur}后重置\` : \`Resets in \${sDur}\` }) : null
                      ]
                    }),
                    (0, $.jsxs)("div", {
                      className: "t3e-text-115 flex items-center justify-between gap-2 tabular-nums",
                      children: [
                        (0, $.jsxs)("span", {
                          className: "inline-flex shrink-0 items-center gap-1 text-muted-foreground",
                          children: [
                            (0, $.jsx)("span", { className: "inline-block size-1.5 rounded-full", style: { backgroundColor: lCol } }),
                            "7d ", (0, $.jsx)("span", { className: "font-medium text-foreground", style: lPct <= 20 ? { color: lCol } : undefined, children: \`\${lPct}%\` })
                          ]
                        }),
                        lDur ? (0, $.jsx)("span", { className: "truncate text-[11px] text-muted-foreground", children: isZh ? \`\${lDur}后重置\` : \`Resets in \${lDur}\` }) : null
                      ]
                    })
                  ]
                })
              ]
            }, item.key);
          }
          const pct = U_(item.window);
          const col = t3QuotaColor(pct, false);
          const dur = shortReset(item.window);
          return (0, $.jsxs)(tp, {
            to: "/usage",
            onClick: onClose,
            className: "t3e-row flex cursor-pointer items-center gap-3 px-2 py-1.5 text-left",
            children: [
              (0, $.jsx)("span", {
                className: "inline-flex w-9 shrink-0 items-center justify-center",
                children: (0, $.jsx)(T3RingSvg, { size: 32, outerPct: pct, innerPct: null, outerColor: col, stroke: 3.1 })
              }),
              (0, $.jsxs)("div", {
                className: "flex min-w-0 flex-1 flex-col gap-0.5",
                children: [
                  (0, $.jsxs)("div", {
                    className: "t3e-text-125 flex items-center justify-between gap-2",
                    children: [
                      (0, $.jsxs)("span", {
                        className: "inline-flex min-w-0 items-center gap-1.5",
                        children: [
                          (0, $.jsx)("span", { className: "truncate font-medium text-foreground", children: item.title }),
                          isCurrent ? (0, $.jsx)("span", { className: "t3e-active-badge shrink-0", children: isZh ? "当前" : "Active" }) : null
                        ]
                      }),
                      (0, $.jsx)("span", { className: "shrink-0 font-medium tabular-nums text-foreground", style: pct <= 20 ? { color: col } : undefined, children: \`\${pct}%\` })
                    ]
                  }),
                  dur ? (0, $.jsx)("span", { className: "truncate text-[11px] text-muted-foreground tabular-nums", children: isZh ? \`\${dur}后重置\` : \`Resets in \${dur}\` }) : null
                ]
              })
            ]
          }, item.key);
        })
      }) : (0, $.jsx)("div", { className: "px-1 text-muted-foreground", children: tFn("Unavailable") }),
      (0, $.jsx)("div", {
        className: "border-t border-border/60 pt-1.5",
        children: (0, $.jsxs)(tp, {
          to: "/usage",
          onClick: onClose,
          className: "t3e-row t3e-text-115 flex w-full cursor-pointer items-center justify-between px-2 py-1 font-medium text-muted-foreground hover:text-foreground",
          children: [
            (0, $.jsx)("span", { children: isZh ? "查看完整用量" : "View full usage" }),
            (0, $.jsx)(T3Glyph, { name: "arrow-right", className: "t3e-arrow" })
          ]
        })
      })
    ]
  });
}

function T3StatRow({ label, value, highlight }) {
  return (0, $.jsxs)("div", {
    className: "t3e-text-115 flex items-center justify-between gap-3",
    children: [
      (0, $.jsx)("span", { className: "text-muted-foreground", children: label }),
      (0, $.jsx)("span", { className: "shrink-0 font-medium tabular-nums text-foreground", style: highlight ? { color: highlight } : undefined, children: value })
    ]
  });
}

function T3ContextPopoverCard({ usage, stats, loc }) {
  const isZh = t3UrIsZh();
  const maxT = usage && usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const pct = maxT !== null && usage.usedPercentage !== null ? Math.max(0, Math.min(100, usage.usedPercentage)) : null;
  const pctLabel = t3FormatPct(pct);
  const threshold = usage?.autoCompactThreshold ?? null;
  const threshPct = maxT !== null && threshold !== null && threshold > 0 && threshold < maxT ? (threshold / maxT) * 100 : null;
  const remaining = maxT !== null ? Math.max(0, maxT - usage.usedTokens) : null;
  const toCompact = threshold !== null && threshold > 0 ? Math.max(0, threshold - usage.usedTokens) : null;
  const barCol = pct !== null ? t3ContextColor(pct) : "currentColor";

  const costStr = t3FormatCost(usage?.cost);
  const avgCache = t3HitRate(usage?.cachedInputTokens, usage?.inputTokens);
  const lastCache = t3HitRate(usage?.lastCachedInputTokens, usage?.lastInputTokens);
  const runs = Array.isArray(stats?.runs) ? stats.runs : [];
  const messages = Array.isArray(stats?.messages) ? stats.messages : [];
  const turnItems = Array.isArray(stats?.turnItems) ? stats.turnItems : [];
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
  const lastRunMs = lastRun?.startedAt && lastRun?.completedAt ? Date.parse(lastRun.completedAt) - Date.parse(lastRun.startedAt) : null;
  const durStr = t3FormatDurationMs(usage?.durationMs ?? lastRunMs);
  const toolCount = typeof usage?.toolUses === "number" && usage.toolUses > 0 ? usage.toolUses : turnItems.length > 0 ? turnItems.length : null;

  const hasIO = usage?.inputTokens != null || usage?.outputTokens != null;
  const hasLastIO = usage?.lastInputTokens != null || usage?.lastOutputTokens != null;
  const totalTok = usage?.totalProcessedTokens ?? (hasIO ? (usage.inputTokens || 0) + (usage.outputTokens || 0) : null);

  return (0, $.jsxs)("div", {
    className: "flex w-72 flex-col gap-2.5 p-1 text-xs text-foreground",
    children: [
      (0, $.jsx)("div", { className: "text-[13px] font-semibold leading-none tracking-tight text-foreground", children: isZh ? "上下文与统计" : "Context & stats" }),
      (0, $.jsxs)("div", {
        className: "flex flex-col gap-1.5",
        children: [
          (0, $.jsxs)("div", {
            className: "t3e-text-125 flex items-center justify-between gap-2",
            children: [
              (0, $.jsx)("span", { className: "text-muted-foreground", children: isZh ? "上下文" : "Context" }),
              (0, $.jsx)("span", {
                className: "font-semibold tabular-nums text-foreground",
                style: pct !== null && pct >= 80 ? { color: barCol } : undefined,
                children: pctLabel ? \`\${pctLabel} / \${GP(usage.usedTokens)}\` : GP(usage.usedTokens)
              })
            ]
          }),
          pct !== null ? (0, $.jsxs)("div", {
            className: "relative h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/20",
            children: [
              (0, $.jsx)("div", {
                className: "h-full rounded-full",
                style: { width: \`\${Math.max(2, pct)}%\`, backgroundColor: barCol }
              }),
              threshPct !== null ? (0, $.jsx)("span", {
                className: "absolute inset-y-0 w-px bg-foreground/60",
                style: { left: \`\${threshPct}%\` }
              }) : null
            ]
          }) : null
        ]
      }),
      (0, $.jsxs)("div", {
        className: "flex flex-col gap-1 border-t border-border/60 pt-2",
        children: [
          (0, $.jsx)("span", { className: "text-[11px] font-semibold text-muted-foreground", children: isZh ? "会话" : "Session" }),
          costStr ? (0, $.jsx)(T3StatRow, { label: isZh ? "费用估算" : "Estimated cost", value: costStr }) : null,
          avgCache ? (0, $.jsx)(T3StatRow, { label: isZh ? "平均缓存命中" : "Avg cache hit", value: avgCache }) : null,
          lastCache ? (0, $.jsx)(T3StatRow, { label: isZh ? "最近缓存命中 (CH)" : "Last cache hit (CH)", value: lastCache }) : null,
          runs.length > 0 || messages.length > 0 ? (0, $.jsx)(T3StatRow, {
            label: isZh ? "回合 / 消息" : "Turns / messages",
            value: isZh ? \`\${runs.length} 轮 · \${messages.length} 条\` : \`\${runs.length} runs · \${messages.length} msgs\`
          }) : null,
          toolCount !== null ? (0, $.jsx)(T3StatRow, { label: isZh ? "工具与步骤" : "Tools & steps", value: isZh ? \`\${toolCount} 项\` : String(toolCount) }) : null,
          threshold !== null && threshold > 0 ? (0, $.jsx)(T3StatRow, {
            label: isZh ? "自动压缩" : "Auto-compact",
            value: isZh
              ? (toCompact > 0 ? \`\${GP(threshold)}（余 \${GP(toCompact)}）\` : \`\${GP(threshold)}（已达）\`)
              : (toCompact > 0 ? \`\${GP(threshold)} (\${GP(toCompact)} left)\` : \`\${GP(threshold)} (reached)\`)
          }) : null
        ]
      }),
      durStr || hasLastIO ? (0, $.jsxs)("div", {
        className: "flex flex-col gap-1 border-t border-border/60 pt-2",
        children: [
          (0, $.jsx)("span", { className: "text-[11px] font-semibold text-muted-foreground", children: isZh ? "本轮" : "Last turn" }),
          durStr ? (0, $.jsx)(T3StatRow, { label: isZh ? "本轮耗时" : "Turn duration", value: durStr }) : null,
          hasLastIO ? (0, $.jsx)(T3StatRow, {
            label: isZh ? "输入 / 输出" : "Input / output",
            value: \`\${GP(usage.lastInputTokens ?? 0)} / \${GP(usage.lastOutputTokens ?? 0)}\`
          }) : null
        ]
      }) : null,
      (0, $.jsxs)("div", {
        className: "flex flex-col gap-1 border-t border-border/60 pt-2",
        children: [
          (0, $.jsx)("span", { className: "text-[11px] font-semibold text-muted-foreground", children: "Token" }),
          hasIO ? (0, $.jsx)(T3StatRow, {
            label: isZh ? "输入 / 输出" : "Input / output",
            value: \`\${GP(usage.inputTokens ?? 0)} / \${GP(usage.outputTokens ?? 0)}\`
          }) : (0, $.jsx)(T3StatRow, {
            label: isZh ? "当前已用" : "Used",
            value: usage.usedTokens.toLocaleString(loc)
          }),
          usage?.cachedInputTokens != null && usage.cachedInputTokens > 0 ? (0, $.jsx)(T3StatRow, {
            label: isZh ? "缓存读取" : "Cached input",
            value: GP(usage.cachedInputTokens)
          }) : null,
          usage?.reasoningOutputTokens != null && usage.reasoningOutputTokens > 0 ? (0, $.jsx)(T3StatRow, {
            label: isZh ? "推理输出" : "Reasoning output",
            value: GP(usage.reasoningOutputTokens)
          }) : null,
          maxT !== null ? (0, $.jsx)(T3StatRow, {
            label: isZh ? "窗口上限 / 剩余" : "Limit / remaining",
            value: \`\${GP(maxT)} / \${GP(remaining)}\`
          }) : null,
          totalTok !== null ? (0, $.jsx)(T3StatRow, {
            label: isZh ? "累计总数" : "Total tokens",
            value: GP(totalTok)
          }) : null
        ]
      })
    ]
  });
}

function T3DetailsUsageRings(e) {
  const { providerInstanceId: n, providers: r, sources: i } = e;
  const tFn = zt();
  const fmtFn = kt();
  const nowStr = Ny();
  const tsFmt = Ip(AU);
  const now = Date.parse(\`\${nowStr}:00Z\`);
  const limits = t3ResolveLimits({ providerInstanceId: n, providers: r, sources: i }, now);
  if (!limits) return null;
  const unavail = TC(limits, fmtFn);
  if (unavail) {
    return (0, $.jsx)(SH, {
      headingId: "thread-details-usage-heading",
      title: tFn("Usage limits"),
      showHeading: false,
      children: (0, $.jsx)("div", {
        className: "grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs",
        children: (0, $.jsx)(jU, {
          label: tFn("Limits", { $context: "usage limits row label" }),
          fill: null, tone: null, value: tFn("Unavailable"),
          tooltip: (0, $.jsx)("span", { className: "text-foreground", children: unavail }),
          opensUsage: true
        })
      })
    });
  }
  const paired = t3PairUsageWindows(limits.windows);
  return (0, $.jsx)(SH, {
    headingId: "thread-details-usage-heading",
    title: tFn("Usage limits"),
    showHeading: false,
    children: (0, $.jsx)("div", {
      className: "flex flex-col gap-1.5 py-0.5",
      children: paired.map(item => {
        if (item.kind === "dual") {
          const sPct = U_(item.shortWindow);
          const lPct = U_(item.longWindow);
          const sCol = t3QuotaColor(sPct, false);
          const lCol = t3QuotaColor(lPct, true);
          return (0, $.jsxs)(jn, {
            children: [
              (0, $.jsx)(an, {
                render: (0, $.jsx)(tp, {
                  to: "/usage",
                  className: "t3e-row group flex cursor-pointer items-center gap-3 px-2.5 py-1.5 text-left"
                }),
                children: [
                  (0, $.jsx)(T3RingSvg, { size: 36, outerPct: lPct, innerPct: sPct, outerColor: lCol, innerColor: sCol, stroke: 3.3 }),
                  (0, $.jsxs)("div", {
                    className: "flex min-w-0 flex-1 flex-col gap-0.5",
                    children: [
                      (0, $.jsx)("span", { className: "t3e-text-125 truncate font-medium text-foreground", children: item.title }),
                      (0, $.jsxs)("div", {
                        className: "t3e-text-115 flex items-center gap-2 tabular-nums text-muted-foreground",
                        children: [
                          (0, $.jsxs)("span", {
                            className: "inline-flex items-center gap-1",
                            children: [
                              (0, $.jsx)("span", { className: "inline-block size-1.5 rounded-full", style: { backgroundColor: sCol } }),
                              "5h ", (0, $.jsx)("span", { className: "font-medium text-foreground", children: \`\${sPct}%\` })
                            ]
                          }),
                          (0, $.jsxs)("span", {
                            className: "inline-flex items-center gap-1",
                            children: [
                              (0, $.jsx)("span", { className: "inline-block size-1.5 rounded-full", style: { backgroundColor: lCol } }),
                              "7d ", (0, $.jsx)("span", { className: "font-medium text-foreground", children: \`\${lPct}%\` })
                            ]
                          })
                        ]
                      })
                    ]
                  })
                ]
              }),
              (0, $.jsx)(Zt, {
                side: "left", sideOffset: 14,
                children: (0, $.jsxs)("div", {
                  className: "flex flex-col gap-2 py-0.5",
                  children: [
                    t3WindowTooltipLines(item.shortWindow, now, tFn, fmtFn, tsFmt),
                    t3WindowTooltipLines(item.longWindow, now, tFn, fmtFn, tsFmt),
                    (0, $.jsx)("span", { className: "text-[11px] text-muted-foreground", children: tFn("Open usage") })
                  ]
                })
              })
            ]
          }, item.key);
        }
        const pct = U_(item.window);
        const col = t3QuotaColor(pct, false);
        return (0, $.jsxs)(jn, {
          children: [
            (0, $.jsx)(an, {
              render: (0, $.jsx)(tp, {
                to: "/usage",
                className: "t3e-row group flex cursor-pointer items-center gap-3 px-2.5 py-1.5 text-left"
              }),
              children: [
                (0, $.jsx)("span", { className: "inline-flex w-9 shrink-0 items-center justify-center", children: (0, $.jsx)(T3RingSvg, { size: 32, outerPct: pct, innerPct: null, outerColor: col, stroke: 3.2 }) }),
                (0, $.jsxs)("div", {
                  className: "flex min-w-0 flex-1 items-center justify-between gap-2",
                  children: [
                    (0, $.jsx)("span", { className: "t3e-text-125 truncate font-medium text-foreground", children: item.title }),
                    (0, $.jsx)("span", { className: "shrink-0 text-xs font-medium tabular-nums", style: { color: pct <= 20 ? col : undefined }, children: \`\${pct}%\` })
                  ]
                })
              ]
            }),
            (0, $.jsx)(Zt, {
              side: "left", sideOffset: 14,
              children: (0, $.jsxs)("div", {
                className: "flex flex-col gap-1 py-0.5",
                children: [
                  t3WindowTooltipLines(item.window, now, tFn, fmtFn, tsFmt),
                  (0, $.jsx)("span", { className: "text-[11px] text-muted-foreground", children: tFn("Open usage") })
                ]
              })
            })
          ]
        }, item.key);
      })
    })
  });
}

function T3DetailsContextRing(e) {
  const { usage: n } = e;
  const ctx = (0, Z.useContext)(T3RingsCtx);
  const [open, setOpen] = (0, Z.useState)(false);
  const maxT = n.maxTokens != null && n.maxTokens > 0 ? n.maxTokens : null;
  const pct = maxT !== null && n.usedPercentage !== null ? Math.round(Math.max(0, Math.min(100, n.usedPercentage))) : null;
  const tFn = zt();
  const loc = Ye();
  const usedLabel = GP(n.usedTokens);
  const valStr = maxT === null ? usedLabel : \`\${usedLabel} / \${GP(maxT)}\`;
  const col = pct === null ? "currentColor" : t3ContextColor(pct);
  return (0, $.jsx)(SH, {
    headingId: "thread-details-context-heading",
    title: tFn("Context window"),
    showHeading: false,
    children: (0, $.jsxs)(el, {
      open,
      onOpenChange: setOpen,
      children: [
        (0, $.jsx)(Qc, {
          openOnHover: true,
          delay: 80,
          closeDelay: 160,
          render: (0, $.jsx)("button", {
            type: "button",
            className: "t3e-row flex w-full cursor-pointer items-center gap-3 px-2.5 py-1.5 text-left"
          }),
          children: [
            (0, $.jsx)("span", { className: "inline-flex w-9 shrink-0 items-center justify-center", children: (0, $.jsx)(T3RingSvg, { size: 32, outerPct: pct ?? 0, innerPct: null, outerColor: col, stroke: 3.2, trackOpacity: 0.18 }) }),
            (0, $.jsxs)("div", {
              className: "flex min-w-0 flex-1 flex-col gap-0.5",
              children: [
                (0, $.jsxs)("div", {
                  className: "t3e-text-125 flex items-center justify-between gap-2",
                  children: [
                    (0, $.jsx)("span", { className: "font-medium text-foreground", children: tFn("Context", { $context: "context window row label" }) }),
                    pct !== null ? (0, $.jsx)("span", { className: "font-medium tabular-nums text-foreground", style: { color: pct >= 80 ? col : undefined }, children: \`\${pct}%\` }) : null
                  ]
                }),
                (0, $.jsx)("span", { className: "t3e-text-115 tabular-nums text-muted-foreground", children: valStr })
              ]
            })
          ]
        }),
        (0, $.jsx)(Zc, {
          side: "left",
          align: "center",
          sideOffset: 12,
          padding: "compact",
          "aria-label": t3UrIsZh() ? "上下文与统计" : "Context & stats",
          children: open ? (0, $.jsx)(T3ContextPopoverCard, { usage: n, stats: ctx?.threadStats, loc }) : null
        })
      ]
    })
  });
}

const T3_GLYPHS = {
  check: ["M20 6 9 17l-5-5"],
  "chevron-right": ["m9 18 6-6-6-6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  "chevron-up": ["m18 15-6-6-6 6"],
  "arrow-right": ["M5 12h14", "m12 5 7 7-7 7"],
  search: ["M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z", "m21 21-4.35-4.35"],
  pr: ["M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z", "M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z", "M6 9v12", "M13 6h3a2 2 0 0 1 2 2v7"],
  globe: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z", "M2 12h20", "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  chat: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"],
  file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"],
  server: ["M4 4h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z", "M4 14h16a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2Z", "M6 8h.01", "M6 18h.01"]
};
function T3Glyph({ name, className }) {
  return (0, $.jsx)("svg", {
    xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
    className: "lucide lucide-" + name + " t3e-glyph" + (className ? " " + className : ""),
    children: (T3_GLYPHS[name] || []).map((d, i) => (0, $.jsx)("path", { d }, i))
  });
}

function T3FastBoltIcon({ active = false, size = 18 }) {
  const d = "M11.1 1.9a.72.72 0 0 1 1.32.49l-.7 5.51h3.68a.72.72 0 0 1 .56 1.18l-7.06 9.02a.72.72 0 0 1-1.32-.49l.7-5.51H4.6a.72.72 0 0 1-.56-1.18L11.1 1.9Z";
  return (0, $.jsx)("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 20 20",
    width: size,
    height: size,
    fill: active ? "currentColor" : "none",
    stroke: active ? "none" : "currentColor",
    strokeWidth: active ? 0 : 1.5,
    strokeLinejoin: "round",
    strokeLinecap: "round",
    "aria-hidden": true,
    className: "shrink-0",
    style: { width: size + "px", height: size + "px" },
    children: (0, $.jsx)("path", { d })
  });
}

function T3ResetArcIcon({ size = 18 }) {
  return (0, $.jsxs)("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 20 20",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.45,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    className: "shrink-0",
    style: { width: size + "px", height: size + "px" },
    children: [
      (0, $.jsx)("path", { d: "M3.4 10a6.6 6.6 0 1 0 1.5-4.3" }),
      (0, $.jsx)("path", { d: "M4.9 2.5v3.2h3.2" })
    ]
  });
}
const T3PlusMenuItem = t3Memo(function T3PlusMenuItem({ icon, label, hint, tag, attached = false, active = false, attachedLabel, idx, onHover, onSelect }) {
  return (0, $.jsxs)("button", {
    type: "button",
    role: "option",
    id: \`t3e-plus-opt-\${idx}\`,
    "aria-selected": active,
    tabIndex: -1,
    "data-t3e-plus-idx": idx,
    "data-active": active ? "true" : undefined,
    "data-attached": attached ? "true" : undefined,
    onMouseEnter: onHover,
    onClick: (ev) => onSelect?.({ keepOpen: ev.shiftKey }),
    className: "t3e-row t3e-menu-row flex w-full cursor-pointer items-center text-left focus-visible:outline-none",
    children: [
      (0, $.jsx)("span", { className: "t3e-menu-icon-slot", children: icon }),
      (0, $.jsxs)("span", {
        className: "flex min-w-0 flex-1 items-baseline gap-2",
        children: [
          (0, $.jsx)("span", {
            className: hint
              ? "max-w-[54%] shrink-0 truncate text-[13px] font-medium leading-5 text-foreground"
              : "min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground",
            children: label
          }),
          hint ? (0, $.jsx)("span", { className: "min-w-0 flex-1 truncate text-xs leading-5 text-muted-foreground", children: hint }) : null
        ]
      }),
      attached
        ? (0, $.jsxs)("span", {
            className: "flex shrink-0 items-center gap-1",
            children: [
              (0, $.jsx)("span", { className: "t3e-active-badge", children: attachedLabel }),
              (0, $.jsx)(T3Glyph, { name: "check", className: "t3e-menu-icon" })
            ]
          })
        : (tag ? (0, $.jsx)("span", { className: "t3e-plus-tag", children: tag }) : null)
    ]
  });
});

const T3_EMPTY_ARR = [];
const T3_TITLES_ONLY = { titlesOnly: true };
const T3_EMPTY_DRAFT = {
  prompt: "",
  threadContexts: T3_EMPTY_ARR,
  reviewComments: T3_EMPTY_ARR,
  environmentContexts: T3_EMPTY_ARR
};

const T3ComposerPlusMenu = t3Memo(function T3ComposerPlusMenu() {
  const isZh = t3UrIsZh();
  const act = (0, Z.useContext)(T3ComposerCtx);
  const [open, setOpen] = (0, Z.useState)(false);
  const fileRef = (0, Z.useRef)(null);
  const dirRef = (0, Z.useRef)(null);

  const handleFileChange = (ev) => {
    const files = Array.from(ev.currentTarget.files ?? []);
    ev.currentTarget.value = "";
    if (!files.length) return;
    Promise.resolve(act?.addComposerAttachments?.(files))
      .then((handled) => {
        if (!handled) act?.focusComposer?.();
      })
      .catch(() => {});
  };

  return (0, $.jsxs)(Z.Fragment, {
    children: [
      (0, $.jsx)("input", {
        ref: fileRef,
        type: "file",
        multiple: true,
        className: "hidden",
        onChange: handleFileChange
      }),
      (0, $.jsx)("input", {
        ref: dirRef,
        type: "file",
        multiple: true,
        webkitdirectory: "",
        directory: "",
        className: "hidden",
        onChange: handleFileChange
      }),
      (0, $.jsxs)(el, {
        open,
        onOpenChange: setOpen,
        children: [
          (0, $.jsx)(Qc, {
            render: (0, $.jsx)("button", {
              type: "button",
              onPointerDown: qI,
              "aria-label": isZh ? "附加文件、对话或上下文" : "Attach files, threads, or context",
              className: "t3e-plus-btn inline-flex shrink-0 cursor-pointer items-center justify-center"
            }),
            children: (0, $.jsx)(za, {})
          }),
          (0, $.jsx)(Zc, {
            side: "top",
            align: "start",
            sideOffset: 10,
            padding: "none",
            "aria-label": isZh ? "附加内容菜单" : "Attachments menu",
            children: open ? (0, $.jsx)(T3ComposerPlusMenuBody, { open, setOpen, fileRef, dirRef, act }) : null
          })
        ]
      })
    ]
  });
});

function T3ComposerPlusMenuBody({ open, setOpen, fileRef, dirRef, act }) {
  const isZh = t3UrIsZh();
  const fmtFn = kt();
  const [query, setQuery] = (0, Z.useState)("");
  const [activeIdx, setActiveIdx] = (0, Z.useState)(0);
  const searchRef = (0, Z.useRef)(null);
  const listRef = (0, Z.useRef)(null);

  const draftTarget = act?.composerDraftTarget;
  const draftSelector = (0, Z.useCallback)((state) => {
    if (!open || !draftTarget) return T3_EMPTY_DRAFT;
    return state.getComposerDraft(draftTarget) || T3_EMPTY_DRAFT;
  }, [open, draftTarget]);
  const draft = U(draftSelector);

  const draftPrompt = typeof draft?.prompt === "string" ? draft.prompt : "";
  const draftThreadContexts = Array.isArray(draft?.threadContexts) ? draft.threadContexts : T3_EMPTY_ARR;
  const draftReviewComments = Array.isArray(draft?.reviewComments) ? draft.reviewComments : T3_EMPTY_ARR;
  const draftEnvContexts = Array.isArray(draft?.environmentContexts) ? draft.environmentContexts : T3_EMPTY_ARR;

  const attachedThreadKeys = (0, Z.useMemo)(() => {
    const keys = new Set();
    for (const tc of draftThreadContexts) {
      const k = t3ThreadCtxKey(tc);
      if (k) keys.add(k);
      if (tc?.contextId) keys.add(tc.contextId);
    }
    return keys;
  }, [draftThreadContexts]);

  const attachedPrNums = (0, Z.useMemo)(() => {
    const nums = new Set();
    for (const rc of draftReviewComments) {
      const n = t3ReviewCommentPrNum(rc);
      if (n !== null) nums.add(n);
    }
    return nums;
  }, [draftReviewComments]);

  const attachedEnvIds = (0, Z.useMemo)(() => {
    const ids = new Set();
    for (const ec of draftEnvContexts) {
      const id = t3EnvCtxId(ec);
      if (id) ids.add(id);
      if (ec?.contextId) ids.add(ec.contextId);
    }
    return ids;
  }, [draftEnvContexts]);

  const defaultThreadTitle = isZh ? "历史对话" : "Thread";

  const isThreadAttached = (th) => {
    if (!th || draftThreadContexts.length === 0) return false;
    if (attachedThreadKeys.has(th.environmentId + ":" + th.id)) return true;
    try {
      const cid = $r({ environmentId: th.environmentId, threadId: th.id }, th.title || defaultThreadTitle)?.contextId;
      if (cid && attachedThreadKeys.has(cid)) return true;
    } catch {}
    return false;
  };

  const isEnvAttached = (env) => {
    if (!env || draftEnvContexts.length === 0) return false;
    if (attachedEnvIds.has(env.environmentId)) return true;
    try {
      const cid = wn(env.environmentId, env.label)?.contextId;
      if (cid && attachedEnvIds.has(cid)) return true;
    } catch {}
    return false;
  };

  const q = query.trim();
  const qLower = q.toLowerCase();
  const linkedMap = act?.linkedEnvironments;
  const threadEnvIds = (0, Z.useMemo)(() => {
    if (!open || !act?.environmentId) return T3_EMPTY_ARR;
    const ids = [act.environmentId];
    if (linkedMap && typeof linkedMap.keys === "function") {
      for (const id of linkedMap.keys()) if (id && id !== act.environmentId) ids.push(id);
    }
    return ids;
  }, [open, act?.environmentId, linkedMap]);
  const threadShells = Nl(open);
  mp(threadEnvIds, q, T3_TITLES_ONLY);

  const fileQueryArgs = (0, Z.useMemo)(() => ({
    environmentId: act?.environmentId || "",
    cwd: open && act?.environmentId ? (act?.gitCwd ?? null) : null,
    query: open && act?.environmentId ? q : null
  }), [open, q, act?.environmentId, act?.gitCwd]);
  const fileSearch = dp(fileQueryArgs, fmtFn);

  const prRequests = (0, Z.useMemo)(() => {
    if (!open || !act?.environmentId || !act?.pullRequestProjectId) return T3_EMPTY_ARR;
    return [{
      environmentId: act.environmentId,
      input: { state: "open", projectId: act.pullRequestProjectId, limit: 20, ...(q ? { query: q } : {}) }
    }];
  }, [open, act?.environmentId, act?.pullRequestProjectId, q]);
  const prQuery = em(prRequests);

  const allEnvs = Op();
  const envMachines = kp();
  const envSelector = (0, Z.useMemo)(() => (act?.environmentId ? wv(act.environmentId) : () => false), [act?.environmentId]);
  const canAttachEnv = mr(envSelector);

  const threadRef = act?.routeThreadRef ?? null;
  const openSurfaces = Gu((state) => {
    if (!open || !threadRef) return T3_EMPTY_ARR;
    return Wu(state.byThreadKey, threadRef)?.surfaces ?? T3_EMPTY_ARR;
  });
  const previewState = Te(open ? threadRef : null);

  (0, Z.useEffect)(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    const rafId = window.requestAnimationFrame?.(() => searchRef.current?.focus());
    return () => {
      if (rafId != null) window.cancelAnimationFrame?.(rafId);
    };
  }, [open]);

  (0, Z.useEffect)(() => {
    setActiveIdx(0);
  }, [query]);

  const finishSelect = (opts) => {
    if (opts?.keepOpen) {
      window.requestAnimationFrame?.(() => searchRef.current?.focus());
    } else {
      setOpen(false);
      window.requestAnimationFrame?.(() => act?.focusComposer?.());
    }
  };

  const runInsert = (token, opts) => {
    const keepOpen = Boolean(opts?.keepOpen);
    if (!keepOpen) setOpen(false);
    window.requestAnimationFrame?.(() => {
      act?.insertText?.(token, { ensureLeadingBoundary: true });
      if (keepOpen) {
        searchRef.current?.focus();
      } else {
        act?.focusAtEnd?.();
      }
    });
  };

  const noteAlreadyAttached = (opts) => {
    if (opts?.keepOpen) return;
    setOpen(false);
    window.requestAnimationFrame?.(() => act?.focusAtEnd?.());
  };

  const toggleThread = (th, opts) => {
    if (!th) return;
    if (act?.composerDraftTarget) {
      try {
        if (isThreadAttached(th)) {
          let targetCid = null;
          try { targetCid = $r({ environmentId: th.environmentId, threadId: th.id }, th.title || defaultThreadTitle)?.contextId; } catch {}
          const targetKey = th.environmentId + ":" + th.id;
          const next = draftThreadContexts.filter(tc => t3ThreadCtxKey(tc) !== targetKey && (!targetCid || tc?.contextId !== targetCid));
          U.getState().setThreadContexts(act.composerDraftTarget, next);
        } else {
          const ref = { environmentId: th.environmentId, threadId: th.id };
          U.getState().addThreadContexts(act.composerDraftTarget, [$r(ref, th.title || defaultThreadTitle)], { insertAtCaret: false });
        }
        finishSelect(opts);
        return;
      } catch {}
    }
    runInsert("@", opts);
  };

  const togglePr = (pr, opts) => {
    if (!pr) return;
    if (act?.composerDraftTarget && attachedPrNums.has(pr.number)) {
      try {
        const next = draftReviewComments.filter(rc => t3ReviewCommentPrNum(rc) !== pr.number);
        U.getState().setReviewComments(act.composerDraftTarget, next);
        finishSelect(opts);
        return;
      } catch {}
    }
    if (act?.composerDraftTarget && pr.url && pr.title) {
      try {
        const ctx = fm({
          number: pr.number,
          title: pr.title,
          url: pr.url,
          headBranch: pr.headBranch ?? "",
          baseBranch: pr.baseBranch ?? "",
          state: pr.state ?? "open",
          isDraft: pr.isDraft === true
        });
        U.getState().addReviewComment(act.composerDraftTarget, ctx, { insertAtCaret: false });
        finishSelect(opts);
        return;
      } catch {}
    }
    runInsert("#" + pr.number + " ", opts);
  };

  const toggleEnvironment = (env, opts) => {
    if (!env) return;
    if (act?.composerDraftTarget) {
      try {
        if (isEnvAttached(env)) {
          let targetCid = null;
          try { targetCid = wn(env.environmentId, env.label)?.contextId; } catch {}
          const next = draftEnvContexts.filter(ec => t3EnvCtxId(ec) !== env.environmentId && (!targetCid || ec?.contextId !== targetCid));
          U.getState().setEnvironmentContexts(act.composerDraftTarget, next);
        } else {
          const ctx = wn(env.environmentId, env.label);
          U.getState().addEnvironmentContexts(act.composerDraftTarget, [ctx], { insertAtCaret: false });
        }
        finishSelect(opts);
        return;
      } catch {}
    }
    runInsert("@" + env.label + " ", opts);
  };

  const matchQ = (title, desc = "") => !qLower || (String(title) + " " + String(desc)).toLowerCase().includes(qLower);

  const localAttachItems = act?.canAttach ? [
    {
      key: "attach-files",
      icon: (0, $.jsx)(ha, { className: "t3e-menu-icon" }),
      label: isZh ? "本地文件与图片" : "Local files & images",
      hint: isZh ? "从电脑选择代码、文档或截图附加到消息" : "Attach code, docs, or screenshots from computer",
      attached: false,
      onSelect: () => { setOpen(false); fileRef.current?.click(); }
    },
    {
      key: "attach-folder",
      icon: (0, $.jsx)(T3Glyph, { name: "folder", className: "t3e-menu-icon" }),
      label: isZh ? "本地文件夹" : "Local folder",
      hint: isZh ? "批量附加整个目录中的文件" : "Attach all files from a directory",
      attached: false,
      onSelect: () => { setOpen(false); dirRef.current?.click(); }
    }
  ].filter(it => matchQ(it.label, it.hint)) : [];

  const linkedPrs = act?.pullRequestProjectId ? OF(act?.pullRequests ?? T3_EMPTY_ARR, act.pullRequestProjectId) : T3_EMPTY_ARR;
  const prByNum = new Map();
  for (const pr of linkedPrs) if (pr && pr.number) prByNum.set(pr.number, pr);
  for (const pr of (prQuery?.data?.entries ?? T3_EMPTY_ARR)) {
    if (pr && pr.number && !prByNum.has(pr.number)) prByNum.set(pr.number, pr);
  }
  const prItems = Array.from(prByNum.values())
    .filter(pr => matchQ("#" + pr.number + " " + (pr.title || ""), pr.repository || ""));

  const sessions = previewState?.sessions || {};
  const surfaceItems = (Array.isArray(openSurfaces) ? openSurfaces : []).map(sf => {
    if (!sf || !sf.id) return null;
    if (sf.kind === "file" && sf.relativePath) {
      const name = ch(sf.relativePath) || sf.relativePath;
      const attached = t3PromptHasToken(draftPrompt, "@", sf.relativePath);
      return {
        key: "sf:" + sf.id,
        icon: (0, $.jsx)(T3Glyph, { name: "file", className: "t3e-menu-icon" }),
        label: name,
        hint: sf.relativePath !== name ? sf.relativePath : "",
        tag: isZh ? "已打开文件" : "Open file",
        attached,
        onSelect: (opts) => attached ? noteAlreadyAttached(opts) : runInsert("@" + sf.relativePath + " ", opts)
      };
    }
    if (sf.kind === "preview" && sf.resourceId) {
      const snap = sessions[sf.resourceId];
      const url = snap?.navStatus?._tag === "Success" ? snap.navStatus.url : (snap?.url || "");
      const title = snap?.title || snap?.navStatus?.title || sf.title || "";
      if (!url) return null;
      let host = url;
      try { host = new URL(url).host || url; } catch {}
      return {
        key: "sf:" + sf.id,
        icon: (0, $.jsx)(T3Glyph, { name: "globe", className: "t3e-menu-icon" }),
        label: title || host,
        hint: host,
        tag: isZh ? "浏览器标签" : "Browser tab",
        attached: draftPrompt.includes(url),
        onSelect: (opts) => draftPrompt.includes(url) ? noteAlreadyAttached(opts) : runInsert(title ? ("[" + title + "](" + url + ") ") : (url + " "), opts)
      };
    }
    if (sf.kind === "pull-request" && sf.number) {
      const fullPr = prByNum.get(sf.number) || { number: sf.number, title: sf.title };
      return {
        key: "sf:" + sf.id,
        icon: (0, $.jsx)(T3Glyph, { name: "pr", className: "t3e-menu-icon" }),
        label: "#" + sf.number,
        hint: fullPr.title || "Pull Request",
        tag: isZh ? "已打开 PR" : "Open PR",
        attached: attachedPrNums.has(sf.number),
        onSelect: (opts) => togglePr(fullPr, opts)
      };
    }
    return null;
  }).filter(it => it && matchQ(it.label, it.hint || ""));

  const fileMatches = Array.isArray(fileSearch?.entries)
    ? fileSearch.entries.slice(0, q.length > 0 ? 20 : 12)
    : T3_EMPTY_ARR;

  const envItems = canAttachEnv && Array.isArray(allEnvs)
    ? allEnvs.filter(env => env && env.environmentId && env.environmentId !== act?.environmentId && matchQ(env.label || "", envMachines?.get?.(env.environmentId) || ""))
    : T3_EMPTY_ARR;

  const rawSkills = Array.isArray(act?.skills) ? act.skills : T3_EMPTY_ARR;
  const skillItems = rawSkills
    .filter(sk => sk && sk.name && matchQ(sk.name, sk.shortDescription || sk.description || ""));

  const recentThreads = (Array.isArray(threadShells) ? threadShells : T3_EMPTY_ARR)
    .filter(th => th && th.id && th.id !== act?.activeThreadId && th.archivedAt === null && th.title && (th.environmentId === act?.environmentId || linkedMap?.has?.(th.environmentId)))
    .filter(th => matchQ(th.title, linkedMap?.get?.(th.environmentId) || ""))
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
    .slice(0, 40);

  const showFilesSection = Boolean(act?.gitCwd) && (fileMatches.length > 0 || fileSearch?.isPending);

  const sections = [];
  if (localAttachItems.length > 0) sections.push({ key: "local", title: isZh ? "添加附件" : "Attachments", items: localAttachItems });
  if (surfaceItems.length > 0) sections.push({ key: "surfaces", title: isZh ? "当前标签页" : "Open tabs", items: surfaceItems });
  if (showFilesSection) {
    sections.push({
      key: "files",
      title: isZh ? "工作区文件" : "Workspace files",
      emptyHint: fileSearch?.isPending && fileMatches.length === 0 ? (isZh ? "正在读取工作区文件..." : "Loading workspace files...") : null,
      items: fileMatches.map(entry => {
        const base = ch(entry.path) || entry.path;
        const dir = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/")));
        const attached = t3PromptHasToken(draftPrompt, "@", entry.path);
        return {
          key: "file:" + entry.kind + ":" + entry.path,
          icon: (0, $.jsx)(T3Glyph, { name: entry.kind === "directory" ? "folder" : "file", className: "t3e-menu-icon" }),
          label: base,
          hint: dir,
          tag: "@",
          attached,
          onSelect: (opts) => attached ? noteAlreadyAttached(opts) : runInsert("@" + entry.path + " ", opts)
        };
      })
    });
  }
  if (prItems.length > 0) {
    sections.push({
      key: "prs",
      title: "Pull Requests",
      items: prItems.map(pr => ({
        key: "pr:" + pr.number,
        icon: (0, $.jsx)(T3Glyph, { name: "pr", className: "t3e-menu-icon" }),
        label: "#" + pr.number,
        hint: pr.title || pr.repository || "Pull Request",
        tag: "PR",
        attached: attachedPrNums.has(pr.number),
        onSelect: (opts) => togglePr(pr, opts)
      }))
    });
  }
  if (envItems.length > 0) {
    sections.push({
      key: "envs",
      title: isZh ? "联机环境" : "Environments",
      items: envItems.map(env => ({
        key: "env:" + env.environmentId,
        icon: (0, $.jsx)(T3Glyph, { name: "server", className: "t3e-menu-icon" }),
        label: env.label,
        tag: isZh ? "远程机器" : "Remote",
        attached: isEnvAttached(env),
        onSelect: (opts) => toggleEnvironment(env, opts)
      }))
    });
  }
  if (skillItems.length > 0) {
    sections.push({
      key: "skills",
      title: isZh ? "技能与插件" : "Skills & plugins",
      items: skillItems.map(sk => {
        const attached = t3PromptHasToken(draftPrompt, "$", sk.name);
        return {
          key: "skill:" + sk.name,
          icon: (0, $.jsx)(ka, { className: "t3e-menu-icon" }),
          label: sk.name,
          hint: sk.shortDescription || sk.description || (isZh ? "为本次消息附加技能" : "Attach skill to this message"),
          tag: "$",
          attached,
          onSelect: (opts) => attached ? noteAlreadyAttached(opts) : runInsert("$" + sk.name + " ", opts)
        };
      })
    });
  }
  if (recentThreads.length > 0) {
    sections.push({
      key: "threads",
      title: isZh ? "历史对话" : "Recent threads",
      items: recentThreads.map(th => {
        const machine = th.environmentId !== act?.environmentId ? linkedMap?.get?.(th.environmentId) : null;
        const tagLabel = machine || (th.lineage?.sideChat ? (isZh ? "侧边对话" : "Side chat") : (isZh ? "历史对话" : "Thread"));
        return {
          key: "th:" + th.environmentId + ":" + th.id,
          icon: (0, $.jsx)(T3Glyph, { name: "chat", className: "t3e-menu-icon" }),
          label: th.title,
          tag: tagLabel,
          attached: isThreadAttached(th),
          onSelect: (opts) => toggleThread(th, opts)
        };
      })
    });
  }

  const flatItems = [];
  const renderedSections = sections.map(sec => ({
    ...sec,
    items: sec.items.map(it => ({ ...it, idx: flatItems.push(it) - 1 }))
  }));
  const hasAny = flatItems.length > 0 || showFilesSection;
  const safeActiveIdx = flatItems.length > 0 ? Math.max(0, Math.min(activeIdx, flatItems.length - 1)) : -1;

  const moveActive = (next) => {
    setActiveIdx(next);
    window.requestAnimationFrame?.(() => {
      listRef.current?.querySelector('[data-t3e-plus-idx="' + next + '"]')?.scrollIntoView({ block: "nearest" });
    });
  };

  const handlePanelKeyDown = (ev) => {
    if (ev.nativeEvent?.isComposing || ev.keyCode === 229) return;
    if (ev.key === "ArrowDown") {
      if (flatItems.length === 0) return;
      ev.preventDefault();
      moveActive((safeActiveIdx + 1) % flatItems.length);
    } else if (ev.key === "ArrowUp") {
      if (flatItems.length === 0) return;
      ev.preventDefault();
      moveActive((safeActiveIdx - 1 + flatItems.length) % flatItems.length);
    } else if (ev.key === "Enter") {
      if (safeActiveIdx < 0 || !flatItems[safeActiveIdx]) return;
      ev.preventDefault();
      ev.stopPropagation();
      flatItems[safeActiveIdx].onSelect?.({ keepOpen: ev.shiftKey });
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      if (query) {
        setQuery("");
        setActiveIdx(0);
      } else {
        setOpen(false);
      }
    }
  };

  const searchPlaceholder = isZh ? "搜索要附加的文件、标签页、PR、对话或技能..." : "Search files, tabs, PRs, threads, or skills...";
  const attachedLabel = isZh ? "已附加" : "Attached";

  return (0, $.jsxs)("div", {
    className: "t3e-plus-panel",
    onKeyDown: handlePanelKeyDown,
    children: [
      (0, $.jsxs)("div", {
        className: "t3e-plus-search-wrap",
        children: [
          (0, $.jsx)(T3Glyph, { name: "search", className: "t3e-plus-search-icon" }),
          (0, $.jsx)("input", {
            ref: searchRef,
            type: "text",
            role: "combobox",
            "aria-autocomplete": "list",
            "aria-expanded": open && flatItems.length > 0,
            "aria-controls": "t3e-plus-listbox",
            "aria-activedescendant": safeActiveIdx >= 0 ? \`t3e-plus-opt-\${safeActiveIdx}\` : undefined,
            "aria-label": searchPlaceholder,
            value: query,
            onChange: (ev) => setQuery(ev.target.value),
            placeholder: searchPlaceholder,
            className: "t3e-model-search"
          })
        ]
      }),
      (0, $.jsxs)("div", {
        ref: listRef,
        id: "t3e-plus-listbox",
        role: "listbox",
        className: "t3e-plus-list",
        children: [
          renderedSections.map(sec => (0, $.jsxs)(Z.Fragment, {
            children: [
              (0, $.jsx)("div", { className: "t3e-plus-sec", children: sec.title }),
              sec.emptyHint
                ? (0, $.jsx)("div", { className: "t3e-plus-empty-hint", children: sec.emptyHint })
                : sec.items.map(item => (0, $.jsx)(T3PlusMenuItem, {
                    icon: item.icon,
                    label: item.label,
                    hint: item.hint,
                    tag: item.tag,
                    attached: item.attached,
                    attachedLabel,
                    active: item.idx === safeActiveIdx,
                    idx: item.idx,
                    onHover: () => { if (activeIdx !== item.idx) setActiveIdx(item.idx); },
                    onSelect: item.onSelect
                  }, item.key))
            ]
          }, sec.key)),
          !hasAny ? (0, $.jsx)("div", {
            className: "px-3 py-5 text-center text-xs text-muted-foreground",
            children: isZh ? "未找到可附加的文件、对话、PR 或技能" : "No matching files, threads, PRs, or skills"
          }) : null
        ]
      }),
      (0, $.jsx)("div", {
        className: "t3e-plus-footer",
        children: (0, $.jsx)("span", { className: "truncate", children: isZh ? "↑↓ 选择 · Enter 附加 · Shift+Enter 连续附加 · Esc 关闭" : "↑↓ Select · Enter Attach · Shift+Enter Keep open · Esc Close" })
      })
    ]
  });
}

function T3Tip({ label, side = "top", children }) {
  if (!label) return children;
  return (0, $.jsxs)(jn, {
    children: [
      (0, $.jsx)(an, { render: children }),
      (0, $.jsx)(Zt, { side, sideOffset: 6, children: label })
    ]
  });
}

const T3_PERM_COPY_ZH = {
  "approval-required": {
    title: "请求批准",
    desc: "编辑外部文件和使用互联网时始终询问",
    short: "请求批准"
  },
  "auto-accept-edits": {
    title: "自动批准编辑",
    desc: "自动批准工作区文件编辑，其他操作请求批准",
    short: "自动编辑"
  },
  auto: {
    title: "帮我批准",
    desc: "仅对检测到的风险操作请求批准",
    short: "帮我批准"
  },
  "full-access": {
    title: "完全访问权限",
    desc: "可不受限制地访问互联网和你电脑上的任何文件",
    short: "完全访问"
  }
};

function T3ComposerPermissionsBtn() {
  const isZh = t3UrIsZh();
  const ctx = (0, Z.useContext)(T3ComposerCtx);
  const [open, setOpen] = (0, Z.useState)(false);
  const options = ctx?.runtimeModeOptions;
  const runtimeMode = ctx?.runtimeMode;
  const onChange = ctx?.onRuntimeModeChange;
  if (!Array.isArray(options) || options.length === 0) return null;
  const current = options.find(o => o.mode === runtimeMode) || options[0];
  if (!current) return null;
  const Icon = current.icon;
  const isFullAccess = current.mode === "full-access";
  const curCopy = isZh ? T3_PERM_COPY_ZH[current.mode] : null;
  const triggerLabel = curCopy?.short || current.label;

  return (0, $.jsxs)(el, {
    open,
    onOpenChange: setOpen,
    children: [
      (0, $.jsx)(Qc, {
        render: (0, $.jsx)("button", {
          type: "button",
          onPointerDown: qI,
          "data-composer-permissions-trigger": true,
          "data-t3e-own-perm": "true",
          "data-full-access": isFullAccess ? "true" : "false",
          "aria-label": triggerLabel,
          className: "t3e-perm-btn"
        }),
        children: [
          Icon ? (0, $.jsx)(Icon, { "aria-hidden": "true", className: "size-3.5 shrink-0" }) : null,
          (0, $.jsx)("span", { className: "t3e-permissions-label truncate leading-none", children: triggerLabel })
        ]
      }),
      (0, $.jsx)(Zc, {
        side: "top",
        align: "start",
        sideOffset: 10,
        padding: "compact",
        initialFocus: false,
        "aria-label": isZh ? "权限控制" : "Permissions",
        children: open ? (0, $.jsxs)("div", {
          className: "t3e-perm-card",
          children: [
            (0, $.jsx)("div", { className: "t3e-perm-hdr", children: isZh ? "应如何批准操作？" : "How should actions be approved?" }),
            options.map((opt) => {
              const OptIcon = opt.icon;
              const copy = isZh ? T3_PERM_COPY_ZH[opt.mode] : null;
              const isSelected = opt.mode === current.mode;
              const isDanger = opt.mode === "full-access";
              const isDisabled = opt.disabledReason !== void 0;
              return (0, $.jsxs)("button", {
                type: "button",
                disabled: isDisabled,
                "aria-pressed": isSelected,
                "data-danger": isDanger ? "true" : "false",
                "data-selected": isSelected ? "true" : "false",
                className: "t3e-perm-opt",
                onClick: () => {
                  if (isDisabled) return;
                  if (opt.mode !== runtimeMode) onChange?.(opt.mode);
                  setOpen(false);
                },
                children: [
                  (0, $.jsx)("span", {
                    className: "t3e-perm-opt-icon",
                    children: OptIcon ? (0, $.jsx)(OptIcon, { "aria-hidden": "true", className: "size-4" }) : null
                  }),
                  (0, $.jsxs)("span", {
                    className: "t3e-perm-opt-body",
                    children: [
                      (0, $.jsx)("span", { className: "t3e-perm-opt-title", children: copy?.title || opt.label }),
                      (0, $.jsx)("span", { className: "t3e-perm-opt-desc", children: opt.disabledReason || copy?.desc || opt.description || "" })
                    ]
                  }),
                  isSelected ? (0, $.jsx)(T3Glyph, { name: "check", className: "t3e-perm-check" }) : null
                ]
              }, opt.mode);
            })
          ]
        }) : null
      })
    ]
  });
}

function T3ComposerQuotaRing() {
  const ctx = (0, Z.useContext)(T3RingsCtx);
  const composerAct = (0, Z.useContext)(T3ComposerCtx);
  const [open, setOpen] = (0, Z.useState)(false);
  const tFn = zt();
  const fmtFn = kt();
  const nowStr = Ny();
  const now = Date.parse(\`\${nowStr}:00Z\`);
  const activeInstanceId = composerAct?.providerInstanceId ?? ctx?.providerInstanceId ?? null;
  const limits = t3ResolveLimits(
    ctx ? { ...ctx, providerInstanceId: activeInstanceId } : null,
    now
  );
  if (!limits || TC(limits, fmtFn) || !limits.windows.length) return null;
  const paired = t3PairUsageWindows(limits.windows);
  const activeModel = composerAct?.activeModel || ctx?.activeModel || "";
  const primary = t3SelectPrimaryQuotaForModel(paired, activeModel);
  if (!primary) return null;
  const providerName = (ctx?.providers || []).find(p => p && p.instanceId === activeInstanceId)?.displayName || "";
  const isDual = primary.kind === "dual";
  const sPct = isDual ? U_(primary.shortWindow) : U_(primary.window);
  const lPct = isDual ? U_(primary.longWindow) : null;
  const sCol = t3QuotaColor(sPct, false);
  const lCol = lPct !== null ? t3QuotaColor(lPct, true) : sCol;
  const displayPct = isDual ? Math.min(sPct, lPct) : sPct;
  const textCol = displayPct <= 20 ? t3QuotaColor(displayPct, false) : undefined;
  const isZh = t3UrIsZh();
  const quotaAria = isZh
    ? (providerName ? \`\${providerName} · \${primary.title} 额度剩余 \${sPct}%，悬停查看全部额度\` : \`\${primary.title} 额度剩余 \${sPct}%，悬停查看全部额度\`)
    : (providerName ? \`\${providerName} · \${primary.title} \${sPct}% remaining, hover for quota details\` : \`\${primary.title} \${sPct}% remaining, hover for quota details\`);
  return (0, $.jsxs)(el, {
    open,
    onOpenChange: setOpen,
    children: [
      (0, $.jsx)(Qc, {
        openOnHover: true,
        delay: 80,
        closeDelay: 160,
        render: (0, $.jsx)("button", {
          type: "button",
          onPointerDown: qI,
          "aria-label": quotaAria,
          className: "t3e-pill inline-flex shrink-0 cursor-pointer items-center gap-1.5 font-medium tabular-nums text-foreground"
        }),
        children: [
          isDual
            ? (0, $.jsx)(T3RingSvg, { size: 16, outerPct: lPct, innerPct: sPct, outerColor: lCol, innerColor: sCol, stroke: 1.8, gap: 1.4 })
            : (0, $.jsx)(T3RingSvg, { size: 16, outerPct: sPct, innerPct: null, outerColor: sCol, stroke: 2.0 }),
          (0, $.jsx)("span", { className: "t3e-q-text leading-none", style: textCol ? { color: textCol } : undefined, children: \`\${sPct}%\` })
        ]
      }),
      (0, $.jsx)(Zc, {
        side: "top",
        align: "start",
        sideOffset: 10,
        padding: "compact",
        "aria-label": isZh ? "用量" : "Usage",
        children: open ? (0, $.jsx)(T3QuotaPopoverCard, { limits, now, tFn, fmtFn, activeKey: primary.key, providerName, onClose: () => setOpen(false) }) : null
      })
    ]
  });
}

function T3ComposerContextRing() {
  const isZh = t3UrIsZh();
  const ctx = (0, Z.useContext)(T3RingsCtx);
  const [open, setOpen] = (0, Z.useState)(false);
  const loc = Ye();
  const usage = ctx?.contextWindow ?? null;
  if (!usage) return null;
  const maxT = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const rawPct = maxT !== null && usage.usedPercentage !== null ? Math.max(0, Math.min(100, usage.usedPercentage)) : null;
  const pct = rawPct !== null ? Math.round(rawPct) : 0;
  const pctText = t3FormatPct(rawPct);
  const usedText = GP(usage.usedTokens);
  const costText = t3FormatCost(usage.cost);
  const inlineText = [pctText ? \`\${pctText} · \${usedText}\` : usedText, costText].filter(Boolean).join(" · ");
  const col = rawPct !== null ? t3ContextColor(pct) : "currentColor";
  return (0, $.jsxs)(el, {
    open,
    onOpenChange: setOpen,
    children: [
      (0, $.jsx)(Qc, {
        openOnHover: true,
        delay: 80,
        closeDelay: 160,
        render: (0, $.jsx)("button", {
          type: "button",
          onPointerDown: qI,
          "aria-label": isZh ? \`上下文 \${inlineText}，悬停查看统计详情\` : \`Context \${inlineText}, hover for details\`,
          className: "t3e-pill t3e-context-trigger me-1 inline-flex shrink-0 cursor-pointer items-center gap-1.5 font-medium tabular-nums text-muted-foreground"
        }),
        children: [
          (0, $.jsx)("span", {
            className: "t3e-ctx-text leading-none",
            style: rawPct !== null && pct >= 80 ? { color: col } : undefined,
            children: inlineText
          }),
          (0, $.jsx)(T3RingSvg, { size: 16, outerPct: pct, innerPct: null, outerColor: col, stroke: 2.0, trackOpacity: 0.22 })
        ]
      }),
      (0, $.jsx)(Zc, {
        side: "top",
        align: "end",
        sideOffset: 10,
        padding: "compact",
        "aria-label": isZh ? "上下文与统计" : "Context & stats",
        children: open ? (0, $.jsx)(T3ContextPopoverCard, { usage, stats: ctx?.threadStats, loc }) : null
      })
    ]
  });
}

function T3EffortSlider({ steps, activeIndex, disabled, onSelectIndex }) {
  const trackRef = (0, Z.useRef)(null);
  const draggingRef = (0, Z.useRef)(false);
  const count = steps.length;
  const clamped = Math.max(0, Math.min(count - 1, activeIndex));
  const ratio = count <= 1 ? 1 : clamped / (count - 1);
  const thumbLeft = count <= 1 ? "calc(100% - 15px)" : \`calc(15px + (100% - 30px) * \${ratio})\`;
  const fillWidth = count <= 1 || clamped === count - 1 ? "100%" : \`calc(30px + (100% - 30px) * \${ratio})\`;

  const pickFromClientX = (clientX) => {
    if (disabled || !trackRef.current || count <= 1) return;
    const rect = trackRef.current.getBoundingClientRect();
    if (!rect.width) return;
    const usable = Math.max(1, rect.width - 30);
    const rel = Math.max(0, Math.min(1, (clientX - rect.left - 15) / usable));
    const idx = Math.round(rel * (count - 1));
    if (idx !== clamped) onSelectIndex(idx);
  };

  return (0, $.jsxs)("div", {
    className: "flex flex-col",
    children: [
      (0, $.jsxs)("div", {
        ref: trackRef,
        role: "slider",
        tabIndex: disabled ? -1 : 0,
        "aria-disabled": disabled ? "true" : undefined,
        "aria-label": t3UrIsZh() ? "思考深度" : "Reasoning effort",
        "aria-valuemin": 0,
        "aria-valuemax": Math.max(0, count - 1),
        "aria-valuenow": clamped,
        "aria-valuetext": steps[clamped]?.label ?? "",
        "data-max": count > 1 && clamped === count - 1 ? "true" : undefined,
        className: "t3e-slider-track",
        onPointerDown: (ev) => {
          if (disabled) return;
          ev.preventDefault();
          draggingRef.current = true;
          ev.currentTarget.setPointerCapture?.(ev.pointerId);
          pickFromClientX(ev.clientX);
        },
        onPointerMove: (ev) => {
          if (disabled || (!draggingRef.current && !(ev.buttons & 1))) return;
          pickFromClientX(ev.clientX);
        },
        onPointerUp: () => { draggingRef.current = false; },
        onPointerCancel: () => { draggingRef.current = false; },
        onLostPointerCapture: () => { draggingRef.current = false; },
        onKeyDown: (ev) => {
          if (disabled || count === 0) return;
          if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
            ev.preventDefault();
            onSelectIndex(Math.max(0, clamped - 1));
          } else if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
            ev.preventDefault();
            onSelectIndex(Math.min(count - 1, clamped + 1));
          } else if (ev.key === "Home") {
            ev.preventDefault();
            onSelectIndex(0);
          } else if (ev.key === "End") {
            ev.preventDefault();
            onSelectIndex(count - 1);
          }
        },
        children: [
          count > 1 && steps.map((step, index) => (0, $.jsx)("span", {
            className: "t3e-effort-tick",
            "data-filled": index <= clamped ? "true" : undefined,
            "aria-hidden": true,
            style: { left: "calc(15px + (100% - 30px) * " + index / (count - 1) + ")" }
          }, step.id)),
          (0, $.jsx)("div", { className: "t3e-slider-fill", style: { width: fillWidth } }),
          (0, $.jsx)("div", { className: "t3e-slider-thumb", style: { left: thumbLeft } })
        ]
      })
    ]
  });
}

function T3UnifiedModelControls({
  traits,
  instanceEntries,
  modelOptionsByInstance,
  activeInstanceId,
  activeModel,
  lockedProvider,
  disabled,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  onSelectProviderModel,
  getModelDisabledReason
}) {
  const isZh = t3UrIsZh();
  const [uncontrolledOpen, setUncontrolledOpen] = (0, Z.useState)(false);
  const panelOpen = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen;
  const setPanelOpen = (next) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    controlledOnOpenChange?.(next);
  };
  const [view, setView] = (0, Z.useState)("effort");
  const [viewedInstanceId, setViewedInstanceId] = (0, Z.useState)(activeInstanceId);
  const [searchQuery, setSearchQuery] = (0, Z.useState)("");
  const [harnessesExpanded, setHarnessesExpanded] = (0, Z.useState)(false);
  const ringsCtx = (0, Z.useContext)(T3RingsCtx);
  const fmtFn = kt();
  const nowStr = Ny();
  const now = Date.parse(\`\${nowStr}:00Z\`);
  const wasOpenRef = (0, Z.useRef)(false);

  const ctrl = traits ? fr(traits) : null;
  const effortState = ctrl && !ctrl.modelIsUnavailable
    ? rz(ctrl.selectDescriptors, ctrl.booleanDescriptors)
    : null;
  const speedState = ctrl && !ctrl.modelIsUnavailable
    ? nz(ctrl.selectDescriptors, ctrl.booleanDescriptors)
    : null;

  const effort = effortState?.effort ?? null;
  let steps = [];
  let activeIdx = 0;
  let activeLabel = "";
  let defaultIdx = 0;

  if (effort) {
    if (effort.kind === "select") {
      const choices = Jr(effort.descriptor) || [];
      steps = choices.map(ch => ({ id: ch.id, label: ch.label || ch.id }));
      const curId = ctrl.selectValue(effort.descriptor);
      const found = steps.findIndex(s => s.id === curId);
      activeIdx = found >= 0 ? found : 0;
      activeLabel = steps[activeIdx]?.label ?? "";
      const defVal = effort.descriptor.defaultValue;
      const defFound = defVal != null ? steps.findIndex(s => s.id === defVal) : -1;
      defaultIdx = defFound >= 0 ? defFound : Math.min(1, Math.max(0, steps.length - 1));
    } else if (effort.kind === "boolean") {
      steps = [{ id: "off", label: isZh ? "关" : "Off" }, { id: "on", label: isZh ? "开" : "On" }];
      activeIdx = effort.descriptor.currentValue === true ? 1 : 0;
      activeLabel = isZh ? (activeIdx === 1 ? "开启" : "关闭") : (activeIdx === 1 ? "On" : "Off");
      defaultIdx = 1;
    }
  }

  const speedSelect = speedState?.speedSelect ?? null;
  const fastToggle = speedState?.fastToggle ?? null;
  const hasFast = Boolean(speedSelect || fastToggle);
  let fastActive = false;
  if (fastToggle) {
    fastActive = fastToggle.currentValue === true;
  } else if (speedSelect) {
    const curSpeed = ctrl.selectValue(speedSelect);
    const speedChoices = Jr(speedSelect) || [];
    const curObj = speedChoices.find(c => c.id === curSpeed);
    fastActive = curObj?.label === "Fast" || curObj?.label === "Ultrafast" || /fast/i.test(String(curSpeed || ""));
  }

  const showEffortView = steps.length > 0 || hasFast;

  (0, Z.useEffect)(() => {
    if (panelOpen && !wasOpenRef.current) {
      setViewedInstanceId(activeInstanceId);
      setSearchQuery("");
      setView(showEffortView ? "effort" : "models");
    }
    wasOpenRef.current = panelOpen;
  }, [panelOpen, activeInstanceId, showEffortView]);

  const handleSelectStep = (idx) => {
    if (!effort || !ctrl || disabled) return;
    if (effort.kind === "select") {
      const target = steps[idx];
      if (target) ctrl.changeSelect(effort.descriptor, target.id);
    } else if (effort.kind === "boolean") {
      ctrl.changeBoolean(effort.descriptor.id, idx === 1);
    }
  };

  const handleToggleFast = () => {
    if (!ctrl || disabled) return;
    if (fastToggle) {
      ctrl.changeBoolean(fastToggle.id, !fastToggle.currentValue);
    } else if (speedSelect) {
      const choices = Jr(speedSelect) || [];
      if (choices.length < 2) return;
      const curId = ctrl.selectValue(speedSelect);
      const curI = choices.findIndex(c => c.id === curId);
      const next = choices[(curI + 1) % choices.length];
      if (next) ctrl.changeSelect(speedSelect, next.id);
    }
  };

  const handleResetEffort = () => {
    if (!ctrl || disabled) return;
    if (effort && steps.length > 0) handleSelectStep(defaultIdx);
    if (fastToggle && fastToggle.currentValue === true) {
      ctrl.changeBoolean(fastToggle.id, false);
    } else if (speedSelect) {
      const choices = Jr(speedSelect) || [];
      const std = choices.find(c => !/fast/i.test(String(c.label || c.id || ""))) || choices[0];
      if (std) ctrl.changeSelect(speedSelect, std.id);
    }
  };

  const rawEntries = Array.isArray(instanceEntries) ? instanceEntries : [];
  const enabledEntries = rawEntries.filter(it => {
    if (!it) return false;
    if (it.instanceId === activeInstanceId) return true;
    return it.enabled === true && Xn(it);
  });

  const activeEntry = enabledEntries.find(it => it.instanceId === activeInstanceId) || rawEntries.find(it => it.instanceId === activeInstanceId) || null;
  const activeModels = modelOptionsByInstance?.get?.(activeInstanceId) ?? [];
  const activeModelObj = activeModels.find(m => m.slug === activeModel);
  const modelTitle = activeModelObj?.name || activeModel || activeEntry?.displayName || (isZh ? "选择模型" : "Select model");

  const isEffortView = view === "effort" && showEffortView;

  const renderPopoverBody = () => {
    const effectiveViewedId = enabledEntries.some(it => it.instanceId === viewedInstanceId)
      ? viewedInstanceId
      : activeInstanceId;
    const viewedModelsRaw = (modelOptionsByInstance?.get?.(effectiveViewedId) ?? []).filter(m => m && !m.isUnavailable && m.slug !== "antigravity-default");
    const normQ = searchQuery.trim().toLowerCase();
    const viewedModels = normQ
      ? viewedModelsRaw.filter(m => ((m.name || "") + " " + (m.slug || "")).toLowerCase().includes(normQ))
      : viewedModelsRaw;

    const viewedEntry = enabledEntries.find(it => it.instanceId === effectiveViewedId) || rawEntries.find(it => it.instanceId === effectiveViewedId) || null;
    const viewedLimits = ringsCtx
      ? t3ResolveLimits({ providerInstanceId: effectiveViewedId, providers: ringsCtx.providers, sources: ringsCtx.sources }, now)
      : null;
    const viewedUnavail = viewedLimits ? TC(viewedLimits, fmtFn) : null;
    const viewedPaired = viewedLimits && !viewedUnavail && Array.isArray(viewedLimits.windows) && viewedLimits.windows.length
      ? t3PairUsageWindows(viewedLimits.windows)
      : [];

    const COLLAPSED_HARNESS_LIMIT = 4;
    const orderedEntries = (() => {
      if (enabledEntries.length <= COLLAPSED_HARNESS_LIMIT) return enabledEntries;
      const pinnedIdx = enabledEntries.findIndex(it => it.instanceId === effectiveViewedId);
      if (pinnedIdx < COLLAPSED_HARNESS_LIMIT) return enabledEntries;
      const copy = enabledEntries.slice();
      const [picked] = copy.splice(pinnedIdx, 1);
      copy.splice(COLLAPSED_HARNESS_LIMIT - 1, 0, picked);
      return copy;
    })();
    const hasMoreHarnesses = orderedEntries.length > COLLAPSED_HARNESS_LIMIT;
    const visibleEntries = harnessesExpanded || !hasMoreHarnesses
      ? orderedEntries
      : orderedEntries.slice(0, COLLAPSED_HARNESS_LIMIT);
    const hiddenCount = orderedEntries.length - visibleEntries.length;

    return isEffortView
          ? (0, $.jsxs)("div", {
              className: "t3e-effort-card",
              children: [
                (0, $.jsxs)("div", {
                  className: "t3e-effort-top",
                  children: [
                    (0, $.jsx)(T3Tip, {
                      label: isZh
                        ? (hasFast ? (fastActive ? "快速模式：已开启" : "切换快速模式") : "当前模型不支持快速模式")
                        : (hasFast ? (fastActive ? "Fast mode: On" : "Toggle fast mode") : "Fast mode unavailable for this model"),
                      children: (0, $.jsx)("button", {
                        type: "button",
                        "aria-disabled": !hasFast || disabled ? "true" : undefined,
                        "data-active": fastActive ? "true" : "false",
                        "aria-label": isZh
                          ? (hasFast ? "切换快速模式" : "当前模型不支持快速模式")
                          : (hasFast ? "Toggle fast mode" : "Fast mode unavailable for this model"),
                        onClick: () => { if (hasFast && !disabled) handleToggleFast(); },
                        className: "t3e-icon-btn cursor-pointer",
                        children: (0, $.jsx)(T3FastBoltIcon, { active: fastActive, size: 18 })
                      })
                    }),
                    (0, $.jsx)(T3Tip, {
                      label: isZh ? "切换渠道与模型" : "Switch provider & model",
                      children: (0, $.jsxs)("button", {
                        type: "button",
                        className: "t3e-effort-switch-btn",
                        onClick: () => setView("models"),
                        children: [
                          (0, $.jsx)("span", {
                            className: "t3e-effort-title t3e-effort-heading truncate font-semibold",
                            children: activeLabel || (isZh ? "思考深度" : "Reasoning effort")
                          }),
                          (0, $.jsxs)("span", {
                            className: "t3e-effort-model-sub",
                            children: [
                              (0, $.jsx)("span", { className: "truncate", children: modelTitle }),
                              (0, $.jsx)(T3Glyph, { name: "chevron-right", className: "t3e-chev" })
                            ]
                          })
                        ]
                      })
                    }),
                    (0, $.jsx)(T3Tip, {
                      label: isZh ? "恢复默认思考深度" : "Reset default effort",
                      children: (0, $.jsx)("button", {
                        type: "button",
                        "aria-disabled": (!effort && !hasFast) || disabled ? "true" : undefined,
                        "aria-label": isZh ? "恢复默认思考深度" : "Reset default effort",
                        onClick: () => { if ((effort || hasFast) && !disabled) handleResetEffort(); },
                        className: "t3e-icon-btn cursor-pointer",
                        children: (0, $.jsx)(T3ResetArcIcon, { size: 18 })
                      })
                    })
                  ]
                }),
                steps.length > 0
                  ? (0, $.jsx)(T3EffortSlider, { steps, activeIndex: activeIdx, disabled, onSelectIndex: handleSelectStep })
                  : null
              ]
            })
          : (0, $.jsxs)("div", {
              className: "flex w-64 flex-col gap-2 p-1 text-xs text-foreground",
              children: [
                (0, $.jsxs)("div", {
                  className: "flex items-center justify-between gap-2 px-0.5",
                  children: [
                    (0, $.jsxs)("div", {
                      className: "flex items-center gap-1",
                      children: [
                        showEffortView
                          ? (0, $.jsx)(T3Tip, {
                              label: isZh ? "返回思考深度" : "Back to effort",
                              children: (0, $.jsx)("button", {
                                type: "button",
                                "aria-label": isZh ? "返回思考深度" : "Back to effort",
                                onClick: () => setView("effort"),
                                className: "t3e-row inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground",
                                children: "‹"
                              })
                            })
                          : null,
                        (0, $.jsx)("span", { className: "text-[13px] font-semibold leading-none tracking-tight text-foreground", children: isZh ? "选择模型" : "Select model" })
                      ]
                    }),
                    lockedProvider
                      ? (0, $.jsx)("span", { className: "text-[11px] text-muted-foreground", children: isZh ? "已锁定引擎" : "Provider locked" })
                      : hasMoreHarnesses
                        ? (0, $.jsx)("button", {
                            type: "button",
                            onClick: () => setHarnessesExpanded(v => !v),
                            className: "t3e-row inline-flex cursor-pointer items-center gap-0.5 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground",
                            children: harnessesExpanded
                              ? [(0, $.jsx)("span", { children: isZh ? "收起" : "Show less" }, "t"), (0, $.jsx)(T3Glyph, { name: "chevron-up", className: "t3e-chev" }, "g")]
                              : [(0, $.jsx)("span", { children: (isZh ? "展开 +" : "More +") + hiddenCount }, "t"), (0, $.jsx)(T3Glyph, { name: "chevron-down", className: "t3e-chev" }, "g")]
                          })
                        : null
                  ]
                }),
                enabledEntries.length > 1 ? (0, $.jsx)("div", {
                  className: "t3e-harness-grid",
                  children: visibleEntries.map(entry => {
                    const isViewed = entry.instanceId === effectiveViewedId;
                    const isLockedOut = Boolean(lockedProvider && entry.driverKind !== lockedProvider && entry.instanceId !== activeInstanceId);
                    return (0, $.jsxs)("button", {
                      type: "button",
                      disabled: disabled || isLockedOut,
                      "aria-pressed": isViewed,
                      "data-selected": isViewed ? "true" : "false",
                      onClick: () => {
                        if (isLockedOut) return;
                        setViewedInstanceId(entry.instanceId);
                        setSearchQuery("");
                      },
                      className: "t3e-harness-chip inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground",
                      children: [
                        (0, $.jsx)(px, {
                          driverKind: entry.driverKind,
                          displayName: entry.displayName,
                          accentColor: entry.accentColor,
                          acpRegistryAgentId: entry.acpRegistryAgentId,
                          acpRegistryIconUrl: entry.acpRegistryIconUrl,
                          className: "size-3.5 shrink-0",
                          iconClassName: "size-3.5"
                        }),
                        (0, $.jsx)("span", { className: "min-w-0 flex-1 truncate text-left", children: entry.displayName })
                      ]
                    }, entry.instanceId);
                  })
                }) : null,
                ringsCtx
                  ? (0, $.jsx)("div", {
                      className: "t3e-harness-quota",
                      "data-harness-id": effectiveViewedId || "",
                      children: viewedPaired.length > 0
                        ? viewedPaired.map(item => {
                            if (item.kind === "dual") {
                              const sPct = U_(item.shortWindow);
                              const lPct = U_(item.longWindow);
                              const sCol = t3QuotaColor(sPct, false);
                              const lCol = t3QuotaColor(lPct, true);
                              return (0, $.jsxs)("span", {
                                className: "t3e-harness-quota-item",
                                children: [
                                  viewedPaired.length > 1
                                    ? (0, $.jsx)("span", { className: "truncate text-muted-foreground", children: item.title })
                                    : (viewedEntry?.displayName ? (0, $.jsx)("span", { className: "truncate text-muted-foreground", children: viewedEntry.displayName }) : null),
                                  (0, $.jsx)("span", { className: "inline-block size-1.5 shrink-0 rounded-full", style: { backgroundColor: sCol } }),
                                  (0, $.jsx)("span", { className: "font-medium text-foreground", style: sPct <= 20 ? { color: sCol } : undefined, children: \`5h \${sPct}%\` }),
                                  (0, $.jsx)("span", { className: "text-muted-foreground", children: "/" }),
                                  (0, $.jsx)("span", { className: "inline-block size-1.5 shrink-0 rounded-full", style: { backgroundColor: lCol } }),
                                  (0, $.jsx)("span", { className: "text-muted-foreground", style: lPct <= 20 ? { color: lCol } : undefined, children: \`7d \${lPct}%\` })
                                ]
                              }, item.key);
                            }
                            const pct = U_(item.window);
                            const col = t3QuotaColor(pct, false);
                            return (0, $.jsxs)("span", {
                              className: "t3e-harness-quota-item",
                              children: [
                                (0, $.jsx)("span", { className: "inline-block size-1.5 shrink-0 rounded-full", style: { backgroundColor: col } }),
                                (0, $.jsx)("span", { className: "truncate text-muted-foreground", children: viewedPaired.length > 1 ? item.title : (viewedEntry?.displayName || item.title) }),
                                (0, $.jsx)("span", { className: "font-medium text-foreground", style: pct <= 20 ? { color: col } : undefined, children: \`\${pct}%\` })
                              ]
                            }, item.key);
                          })
                        : (0, $.jsx)("span", {
                            className: "truncate text-muted-foreground",
                            children: viewedUnavail || (isZh
                              ? (viewedEntry?.displayName ? \`\${viewedEntry.displayName} 暂无配额统计\` : "当前渠道暂无配额统计")
                              : (viewedEntry?.displayName ? \`No quota stats for \${viewedEntry.displayName}\` : "No quota stats for this provider"))
                          })
                    })
                  : null,
                viewedModelsRaw.length > 6 ? (0, $.jsx)("input", {
                  type: "text",
                  value: searchQuery,
                  onChange: (ev) => setSearchQuery(ev.currentTarget.value),
                  "aria-label": isZh ? "搜索模型" : "Search models",
                  placeholder: isZh ? "搜索模型..." : "Search models...",
                  className: "t3e-model-search"
                }) : null,
                (0, $.jsx)("div", {
                  className: "t3e-model-list flex flex-col gap-0.5",
                  children: viewedModels.length > 0
                    ? viewedModels.map(m => {
                        const isSelected = effectiveViewedId === activeInstanceId && m.slug === activeModel;
                        const disabledReason = getModelDisabledReason?.(effectiveViewedId, m.slug) ?? null;
                        const rowQuota = viewedPaired.length > 0 ? t3SelectPrimaryQuotaForModel(viewedPaired, m.slug) : null;
                        const rowPct = rowQuota ? (rowQuota.kind === "dual" ? U_(rowQuota.shortWindow) : U_(rowQuota.window)) : null;
                        const rowCol = rowPct !== null ? t3QuotaColor(rowPct, false) : null;
                        return (0, $.jsxs)("button", {
                          type: "button",
                          disabled: disabled || Boolean(disabledReason),
                          "aria-pressed": isSelected,
                          "data-selected": isSelected ? "true" : "false",
                          onClick: () => {
                            if (disabled || disabledReason) return;
                            setViewedInstanceId(effectiveViewedId);
                            setSearchQuery("");
                            onSelectProviderModel?.(effectiveViewedId, m.slug, { focusComposer: false });
                            setView("effort");
                          },
                          className: "t3e-row t3e-model-row flex w-full cursor-pointer items-center justify-between text-left",
                          children: [
                            (0, $.jsx)("span", {
                              className: isSelected ? "min-w-0 flex-1 truncate text-[13px] font-medium text-foreground" : "min-w-0 flex-1 truncate text-[13px] text-foreground",
                              children: m.name || m.slug
                            }),
                            rowPct !== null
                              ? (0, $.jsx)("span", {
                                  className: "t3e-model-quota shrink-0",
                                  style: rowPct <= 20 ? { color: rowCol, fontWeight: 500 } : undefined,
                                  children: \`\${rowPct}%\`
                                })
                              : null,
                            isSelected ? (0, $.jsx)(T3Glyph, { name: "check", className: "t3e-check" }) : null
                          ]
                        }, \`\${effectiveViewedId}:\${m.slug}\`);
                      })
                    : (0, $.jsx)("div", { className: "px-2 py-2.5 text-center text-[11px] text-muted-foreground", children: isZh ? "未找到匹配模型" : "No matching models" })
                })
              ]
            });
  };

  return (0, $.jsxs)(el, {
    open: panelOpen,
    onOpenChange: setPanelOpen,
    children: [
      (0, $.jsx)(Qc, {
        render: (0, $.jsx)("button", {
          type: "button",
          disabled,
          onPointerDown: qI,
          "aria-label": activeLabel ? \`\${modelTitle} · \${activeLabel}\` : (isZh ? \`切换模型：\${modelTitle}\` : \`Switch model: \${modelTitle}\`),
          className: "t3e-pill t3e-model-trigger inline-flex cursor-pointer items-center font-medium text-foreground"
        }),
        children: [
          fastActive
            ? (0, $.jsx)("span", {
                className: "t3e-fast-inline",
                "aria-hidden": true,
                children: (0, $.jsx)(T3FastBoltIcon, { active: true, size: 16 })
              })
            : null,
          activeEntry
            ? (0, $.jsx)(px, {
                driverKind: activeEntry.driverKind,
                displayName: activeEntry.displayName,
                accentColor: activeEntry.accentColor,
                acpRegistryAgentId: activeEntry.acpRegistryAgentId,
                acpRegistryIconUrl: activeEntry.acpRegistryIconUrl,
                className: "size-4 shrink-0",
                iconClassName: "size-4"
              })
            : null,
          (0, $.jsx)("span", { className: "t3e-model-name truncate", children: modelTitle }),
          activeLabel
            ? (0, $.jsx)("span", { className: "t3e-eff-text t3e-model-eff-sep", children: activeLabel })
            : null
        ]
      }),
      (0, $.jsx)(Zc, {
        side: "top",
        align: "end",
        sideOffset: 10,
        padding: "compact",
        initialFocus: false,
        "aria-label": isEffortView ? (isZh ? "选择思考深度与模型" : "Select reasoning effort & model") : (isZh ? "选择模型与渠道" : "Select model & provider"),
        children: panelOpen ? renderPopoverBody() : null
      })
    ]
  });
}
const T3DetailsUsageRingsMemo = t3Memo(T3DetailsUsageRings);
const T3DetailsContextRingMemo = t3Memo(T3DetailsContextRing);
const T3ComposerPermissionsBtnMemo = t3Memo(T3ComposerPermissionsBtn);
const T3ComposerQuotaRingMemo = t3Memo(T3ComposerQuotaRing);
const T3ComposerContextRingMemo = t3Memo(T3ComposerContextRing);
const T3UnifiedModelControlsMemo = t3Memo(T3UnifiedModelControls);
`;

function apply(source) {
  const iDU = source.indexOf(duStart);
  const iOU = source.indexOf(ouStart);
  const iKU = source.indexOf(kuStart);
  assert(iDU >= 0 && iOU > iDU && iKU > iOU, "Could not locate DU/OU/kU anchors in _chat bundle");
  assert.equal(iDU, source.lastIndexOf(duStart), "DU anchor is not unique");
  assert.equal(iOU, source.lastIndexOf(ouStart), "OU anchor is not unique");
  assert.equal(iKU, source.lastIndexOf(kuStart), "kU anchor is not unique");
  assert(
    source.includes(composerLeftAnchor) && source.indexOf(composerLeftAnchor) === source.lastIndexOf(composerLeftAnchor),
    "Composer left footer anchor changed"
  );
  assert(
    source.includes(composerControlsAnchor) && source.indexOf(composerControlsAnchor) === source.lastIndexOf(composerControlsAnchor),
    "Composer controls anchor changed"
  );
  assert(
    source.includes(composerReturnStartAnchor) && source.indexOf(composerReturnStartAnchor) === source.lastIndexOf(composerReturnStartAnchor),
    "Composer form return start anchor changed"
  );
  assert(
    source.includes(composerReturnEndAnchor) && source.indexOf(composerReturnEndAnchor) === source.lastIndexOf(composerReturnEndAnchor),
    "Composer form return end anchor changed"
  );
  assert(
    source.includes(providerReturnAnchor) && source.indexOf(providerReturnAnchor) === source.lastIndexOf(providerReturnAnchor),
    "Chat view return anchor changed"
  );
  assert(
    source.includes(tzControlsAnchor) && source.indexOf(tzControlsAnchor) === source.lastIndexOf(tzControlsAnchor),
    "Composer Tz controls anchor changed"
  );
  assert(
    source.includes(permissionsLabelAnchor) && source.indexOf(permissionsLabelAnchor) === source.lastIndexOf(permissionsLabelAnchor),
    "Composer permissions label anchor changed"
  );

  let patched =
    source.slice(0, iDU) +
    "function DU(e){return(0,$.jsx)(T3DetailsUsageRingsMemo,e)}" +
    "function OU(e){return(0,$.jsx)(T3DetailsContextRingMemo,e)}" +
    source.slice(iKU);

  patched = patched.replace(
    composerLeftAnchor,
    '!_c?(0,$.jsxs)(`div`,{className:`t3e-footer-left me-2 flex shrink-0 items-center gap-1.5`,children:[(0,$.jsx)(T3ComposerPlusMenu,{}),(0,$.jsx)(T3ComposerPermissionsBtnMemo,{}),(0,$.jsx)(T3ComposerQuotaRingMemo,{})]}):null,'
  );
  patched = patched.replace(
    composerControlsAnchor,
    'className:Cr(`relative flex min-w-0 flex-1 items-center justify-end gap-0.5`,_c&&`hidden`),children:[(0,$.jsx)(T3ComposerContextRingMemo,{}),Vl]})'
  );
  patched = patched.replace(
    tzControlsAnchor,
    'children:[(0,$.jsx)(T3UnifiedModelControlsMemo,{traits:fe,instanceEntries:I,modelOptionsByInstance:R,activeInstanceId:_e,activeModel:ve,lockedProvider:P,disabled:ge,open:B,onOpenChange:V,onSelectProviderModel:j,getModelDisabledReason:U}),(0,$.jsxs)($.Fragment,{children:[me.filter(b=>b.id!==`mode`&&b.id!==`permissions`).map'
  );
  patched = patched.replace(
    permissionsLabelAnchor,
    'children:[g,(0,$.jsx)(`span`,{className:`t3e-permissions-label`,children:c.label}),_]}),t[24]=o'
  );
  patched = patched.replace(
    composerReturnStartAnchor,
    't[1173]=af):af=t[1173],(0,$.jsx)(T3ComposerCtxProvider,{canAttach:go,addComposerAttachments:lu,focusComposer:it,composerRef:pa,insertText:gu,providerInstanceId:Br,activeModel:Di||Ci?.model||oe?.model||se?.model||``,runtimeMode:e.runtimeMode,runtimeModeOptions:ti,onRuntimeModeChange:rt,composerDraftTarget:i,environmentId:a,routeThreadRef:_,gitCwd:xe,pullRequestProjectId:Ce,activeThreadId:C,linkedEnvironments:Wa,skills:pi,pullRequests:Ee,children:(0,$.jsxs)(`form`,'
  );
  patched = patched.replace(
    composerReturnEndAnchor,
    'tf,nf,rf,af]})})})]})})});function zz(e)'
  );
  patched = patched.replace(
    providerReturnAnchor,
    'return(0,$.jsx)(T3RingsCtxProvider,{providerInstanceId:vs,providers:Ko,sources:Vo?.usageLimitSources??XW,contextWindow:Dc,activeModel:Wr?.modelSelection?.model||``,runs:Y?.runs,messages:Y?.messages,turnItems:Y?.turnItems,children:(0,$.jsx)(Ug,{threadRef:Xi,cwd:xu,checkpoints:Y?.checkpoints,children:bv})})'
  );

  return patched.replace(/\n?\/\/# sourceMappingURL=.*$/m, "") + "\n" + RUNTIME_MODULE + "\n";
}

module.exports = {
  id: ID,
  name: "加号菜单 + 常驻权限 + 合一模型/思考深度面板 + 模型联动双环与统计",
  marker: MARKER,
  legacyMarkers: ["T3_USAGE_RINGS_V1", "T3_USAGE_RINGS_V2", "T3_USAGE_RINGS_V3", "T3_USAGE_RINGS_V4", "T3_USAGE_RINGS_V5", "T3_USAGE_RINGS_V6", "T3_USAGE_RINGS_V7", "T3_USAGE_RINGS_V8", "T3_USAGE_RINGS_V9", "T3_USAGE_RINGS_V10", "T3_USAGE_RINGS_V11", "T3_USAGE_RINGS_V12", "T3_USAGE_RINGS_V13", "T3_USAGE_RINGS_V14", "T3_USAGE_RINGS_V15", "T3_USAGE_RINGS_V16", "T3_USAGE_RINGS_V17", "T3_USAGE_RINGS_V18", "T3_USAGE_RINGS_V19", "T3_USAGE_RINGS_V20"],
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  apply,
  t3ClassifyWindow,
  t3BaseWindowName,
  t3PairUsageWindows,
  t3SelectPrimaryQuotaForModel,
};

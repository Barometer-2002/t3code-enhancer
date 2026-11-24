const assert = require("node:assert/strict");

const ID = "usage-rings";
const MARKER = "T3_USAGE_RINGS_V11";
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
  return cleaned || "配额";
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
    const text = (
      item.kind === "dual"
        ? `${item.title || ""} ${item.shortWindow?.label || ""} ${item.longWindow?.label || ""}`
        : `${item.title || ""} ${item.window?.label || ""}`
    ).toLowerCase();

    let score = 0;

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

    // 3. Model family match
    if (isClaude && /\bclaude\b/.test(text)) score += 60;
    if (isGpt && /\b(gpt|codex|openai)\b/.test(text)) score += 60;
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

const RUNTIME_MODULE = `
/* ${MARKER} */
const T3RingsCtx = (0, Z.createContext)(null);
const T3ComposerCtx = (0, Z.createContext)(null);
${t3ClassifyWindow.toString()}
${t3BaseWindowName.toString()}
${t3PairUsageWindows.toString()}
${t3SelectPrimaryQuotaForModel.toString()}

(function t3EnsureEnhancerStyles() {
  if (typeof document === "undefined") return;
  const styleId = "t3-enhancer-rings-style-v4";
  if (document.getElementById(styleId)) return;
  const elStyle = document.createElement("style");
  elStyle.id = styleId;
  elStyle.textContent = \`
    /* 统一尺寸约定：底栏主圆钮 32px (+17px)、底栏胶囊 28px (圆角 8px)、菜单与弹出图标 15px (1.35px 线宽) */
    .t3e-plus-btn {
      width: 32px;
      height: 32px;
      border-radius: 9999px;
      background-color: rgba(0, 0, 0, 0.055);
      color: var(--foreground);
      transition: background-color 140ms ease, color 140ms ease, transform 110ms ease;
    }
    .t3e-plus-btn:hover {
      background-color: rgba(0, 0, 0, 0.095);
    }
    .t3e-plus-btn[data-popup-open],
    .t3e-plus-btn:active {
      background-color: rgba(0, 0, 0, 0.13);
    }
    .t3e-plus-btn:active {
      transform: scale(0.95);
    }
    .dark .t3e-plus-btn {
      background-color: rgba(255, 255, 255, 0.085);
    }
    .dark .t3e-plus-btn:hover {
      background-color: rgba(255, 255, 255, 0.14);
    }
    .dark .t3e-plus-btn[data-popup-open],
    .dark .t3e-plus-btn:active {
      background-color: rgba(255, 255, 255, 0.19);
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
      background-color: rgba(84, 104, 231, 0.12);
      color: #4658c8;
    }
    .dark .t3e-active-badge {
      background-color: rgba(107, 126, 242, 0.22);
      color: #9baaff;
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
    .t3e-effort-title {
      color: #4658c8;
    }
    .dark .t3e-effort-title {
      color: #8b9dff;
    }
    .t3e-effort-heading {
      font-size: 15px;
      line-height: 20px;
    }
    .t3e-slider-track {
      position: relative;
      height: 30px;
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
      border-radius: 9999px;
      background-color: #5468e7;
      transition: width 150ms cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: none;
    }
    .dark .t3e-slider-fill {
      background-color: #6b7ef2;
    }
    .t3e-slider-thumb {
      position: absolute;
      top: 50%;
      width: 24px;
      height: 24px;
      border-radius: 9999px;
      background-color: #ffffff;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(0, 0, 0, 0.06);
      transform: translate(-50%, -50%);
      transition: left 150ms cubic-bezier(0.22, 1, 0.36, 1), transform 110ms ease;
      pointer-events: none;
      z-index: 2;
    }
    .t3e-slider-track:active .t3e-slider-thumb {
      transform: translate(-50%, -50%) scale(1.06);
    }
    .t3e-slider-dot {
      position: absolute;
      top: 50%;
      width: 5px;
      height: 5px;
      border-radius: 9999px;
      transform: translate(-50%, -50%);
      pointer-events: none;
      z-index: 1;
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
    .t3e-slider-track[data-max="true"] .t3e-slider-dot {
      opacity: 0;
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
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background-color: rgba(0, 0, 0, 0.05);
      color: var(--muted-foreground);
      transition: background-color 140ms ease, color 140ms ease;
    }
    .t3e-icon-btn:hover:not(:disabled) {
      background-color: rgba(0, 0, 0, 0.09);
      color: var(--foreground);
    }
    .dark .t3e-icon-btn {
      background-color: rgba(255, 255, 255, 0.08);
    }
    .dark .t3e-icon-btn:hover:not(:disabled) {
      background-color: rgba(255, 255, 255, 0.14);
      color: var(--foreground);
    }
    .t3e-icon-btn[data-active="true"] {
      background-color: rgba(84, 104, 231, 0.15);
      color: #4658c8;
    }
    .dark .t3e-icon-btn[data-active="true"] {
      background-color: rgba(107, 126, 242, 0.24);
      color: #9baaff;
    }
    .t3e-icon-btn:disabled {
      opacity: 0.38;
      cursor: not-allowed;
    }
    .t3e-icon-btn svg,
    .t3e-icon-btn svg.lucide {
      width: 15px !important;
      height: 15px !important;
      stroke-width: 1.45px !important;
      flex-shrink: 0;
    }
    .t3e-icon-btn svg :is(path, circle, rect, line, polyline, polygon) {
      vector-effect: non-scaling-stroke !important;
    }
    .t3e-harness-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }
    .t3e-harness-chip {
      height: 30px;
      width: 100%;
      padding: 0 9px;
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
      background-color: rgba(84, 104, 231, 0.10);
      border-color: rgba(84, 104, 231, 0.36);
      color: var(--foreground);
    }
    .dark .t3e-harness-chip[data-selected="true"] {
      background-color: rgba(107, 126, 242, 0.18);
      border-color: rgba(139, 157, 255, 0.42);
      color: var(--foreground);
    }
    .t3e-harness-chip:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }
    .t3e-model-trigger {
      max-width: 176px;
    }
    .t3e-model-search {
      height: 30px;
      width: 100%;
      padding: 0 10px;
      border-radius: 8px;
      border: 1px solid rgba(0, 0, 0, 0.08);
      background-color: rgba(0, 0, 0, 0.025);
      color: var(--foreground);
      font-size: 12px;
      outline: none;
      transition: border-color 140ms ease, background-color 140ms ease;
    }
    .t3e-model-search:focus {
      border-color: rgba(84, 104, 231, 0.5);
      background-color: var(--background);
    }
    .dark .t3e-model-search {
      border-color: rgba(255, 255, 255, 0.10);
      background-color: rgba(255, 255, 255, 0.04);
    }
    .dark .t3e-model-search:focus {
      border-color: rgba(139, 157, 255, 0.55);
      background-color: rgba(255, 255, 255, 0.06);
    }
    .t3e-model-list {
      max-height: 248px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .t3e-model-row {
      min-height: 32px;
      padding: 5px 10px;
      gap: 8px;
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
    html body svg.lucide.t3e-check { width: 15px !important; height: 15px !important; color: #4658c8; }
    .dark svg.lucide.t3e-check { color: #8b9dff; }
    /* 窄窗口自适应：JS 按底栏宽度标记档位 (data-t3e-w)，逐级收起文字，避免互相覆盖 */
    .t3e-model-trigger > span { max-width: var(--t3e-name-max, 176px); }
    [data-t3e-w="1"] .t3e-ctx-text,
    [data-t3e-w="2"] .t3e-ctx-text,
    [data-t3e-w="2"] .t3e-q-text,
    [data-t3e-w="2"] .t3e-eff-text { display: none; }
    [data-t3e-w="2"] .t3e-pill { padding: 0 6px; gap: 4px; }

    .t3e-model-row:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  \`;
  document.head.appendChild(elStyle);
})();

(function t3FooterFit() {
  if (typeof document === "undefined" || typeof ResizeObserver === "undefined") return;
  const seen = new WeakSet();
  const ro = new ResizeObserver(function (entries) {
    entries.forEach(function (en) {
      const w = en.contentRect.width;
      const row = en.target;
      if (!w) return;
      const tier = w < 410 ? "2" : w < 480 ? "1" : "0";
      if (row.getAttribute("data-t3e-w") !== tier) row.setAttribute("data-t3e-w", tier);
      const max = tier === "0" ? 176 : Math.max(32, Math.min(176, w - (tier === "2" ? 216 : 300)));
      row.style.setProperty("--t3e-name-max", max + "px");
    });
  });
  let queued = false;
  function scan() {
    queued = false;
    document.querySelectorAll(".t3e-footer-left").forEach(function (left) {
      const row = left.parentElement;
      if (row && !seen.has(row)) { seen.add(row); ro.observe(row); }
    });
  }
  new MutationObserver(function () {
    if (!queued) { queued = true; requestAnimationFrame(scan); }
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();
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

function T3RingSvg({ size = 36, outerPct = null, innerPct = null, outerColor = "#D4714E", innerColor = "#2F855A", stroke = 3.3, gap = null, trackOpacity = 0.16 }) {
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
}

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

function t3FormatDurationMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return Math.round(ms) + " ms";
  const sec = ms / 1000;
  if (sec < 60) return (sec < 10 ? sec.toFixed(1) : Math.round(sec)) + " 秒";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? \`\${m} 分 \${s} 秒\` : \`\${m} 分\`;
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

function T3QuotaPopoverCard({ limits, now, tFn, fmtFn, activeKey, onClose }) {
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
          (0, $.jsx)("span", { className: "text-[13px] font-semibold leading-none tracking-tight text-foreground", children: "用量" }),
          (0, $.jsx)("span", { className: "text-[11px] text-muted-foreground", children: "5h / 7d 实时配额" })
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
                        isCurrent ? (0, $.jsx)("span", { className: "t3e-active-badge shrink-0", children: "当前" }) : null
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
                        sDur ? (0, $.jsx)("span", { className: "truncate text-[11px] text-muted-foreground", children: \`\${sDur}后重置\` }) : null
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
                        lDur ? (0, $.jsx)("span", { className: "truncate text-[11px] text-muted-foreground", children: \`\${lDur}后重置\` }) : null
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
                          isCurrent ? (0, $.jsx)("span", { className: "t3e-active-badge shrink-0", children: "当前" }) : null
                        ]
                      }),
                      (0, $.jsx)("span", { className: "shrink-0 font-medium tabular-nums text-foreground", style: pct <= 20 ? { color: col } : undefined, children: \`\${pct}%\` })
                    ]
                  }),
                  dur ? (0, $.jsx)("span", { className: "truncate text-[11px] text-muted-foreground tabular-nums", children: \`\${dur}后重置\` }) : null
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
            (0, $.jsx)("span", { children: "查看完整用量" }),
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
  const maxT = usage && usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const pct = maxT !== null && usage.usedPercentage !== null ? Math.max(0, Math.min(100, usage.usedPercentage)) : null;
  const pctLabel = t3FormatPct(pct);
  const threshold = usage?.autoCompactThreshold ?? null;
  const threshPct = maxT !== null && threshold !== null && threshold > 0 && threshold < maxT ? (threshold / maxT) * 100 : null;
  const remaining = maxT !== null ? Math.max(0, maxT - usage.usedTokens) : null;
  const toCompact = threshold !== null && threshold > 0 ? Math.max(0, threshold - usage.usedTokens) : null;
  const barCol = pct !== null ? (pct >= 90 ? "#DC2626" : pct >= 80 ? "#D97706" : "currentColor") : "currentColor";

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
      (0, $.jsx)("div", { className: "text-[13px] font-semibold leading-none tracking-tight text-foreground", children: "上下文与统计" }),
      (0, $.jsxs)("div", {
        className: "flex flex-col gap-1.5",
        children: [
          (0, $.jsxs)("div", {
            className: "t3e-text-125 flex items-center justify-between gap-2",
            children: [
              (0, $.jsx)("span", { className: "text-muted-foreground", children: "上下文" }),
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
          (0, $.jsx)("span", { className: "text-[11px] font-semibold text-muted-foreground", children: "会话" }),
          costStr ? (0, $.jsx)(T3StatRow, { label: "费用估算", value: costStr }) : null,
          avgCache ? (0, $.jsx)(T3StatRow, { label: "平均缓存命中", value: avgCache }) : null,
          lastCache ? (0, $.jsx)(T3StatRow, { label: "最近缓存命中 (CH)", value: lastCache }) : null,
          runs.length > 0 || messages.length > 0 ? (0, $.jsx)(T3StatRow, {
            label: "回合 / 消息",
            value: \`\${runs.length} 轮 · \${messages.length} 条\`
          }) : null,
          toolCount !== null ? (0, $.jsx)(T3StatRow, { label: "工具与步骤", value: \`\${toolCount} 项\` }) : null,
          threshold !== null && threshold > 0 ? (0, $.jsx)(T3StatRow, {
            label: "自动压缩",
            value: toCompact > 0 ? \`\${GP(threshold)}（余 \${GP(toCompact)}）\` : \`\${GP(threshold)}（已达）\`
          }) : null
        ]
      }),
      durStr || hasLastIO ? (0, $.jsxs)("div", {
        className: "flex flex-col gap-1 border-t border-border/60 pt-2",
        children: [
          (0, $.jsx)("span", { className: "text-[11px] font-semibold text-muted-foreground", children: "本轮" }),
          durStr ? (0, $.jsx)(T3StatRow, { label: "本轮耗时", value: durStr }) : null,
          hasLastIO ? (0, $.jsx)(T3StatRow, {
            label: "输入 / 输出",
            value: \`\${GP(usage.lastInputTokens ?? 0)} / \${GP(usage.lastOutputTokens ?? 0)}\`
          }) : null
        ]
      }) : null,
      (0, $.jsxs)("div", {
        className: "flex flex-col gap-1 border-t border-border/60 pt-2",
        children: [
          (0, $.jsx)("span", { className: "text-[11px] font-semibold text-muted-foreground", children: "Token" }),
          hasIO ? (0, $.jsx)(T3StatRow, {
            label: "输入 / 输出",
            value: \`\${GP(usage.inputTokens ?? 0)} / \${GP(usage.outputTokens ?? 0)}\`
          }) : (0, $.jsx)(T3StatRow, {
            label: "当前已用",
            value: usage.usedTokens.toLocaleString(loc)
          }),
          usage?.cachedInputTokens != null && usage.cachedInputTokens > 0 ? (0, $.jsx)(T3StatRow, {
            label: "缓存读取",
            value: GP(usage.cachedInputTokens)
          }) : null,
          usage?.reasoningOutputTokens != null && usage.reasoningOutputTokens > 0 ? (0, $.jsx)(T3StatRow, {
            label: "推理输出",
            value: GP(usage.reasoningOutputTokens)
          }) : null,
          maxT !== null ? (0, $.jsx)(T3StatRow, {
            label: "窗口上限 / 剩余",
            value: \`\${GP(maxT)} / \${GP(remaining)}\`
          }) : null,
          totalTok !== null ? (0, $.jsx)(T3StatRow, {
            label: "累计总数",
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
  const fmtFn = kt();
  const nowStr = Ny();
  const loc = Ye();
  const now = Date.parse(\`\${nowStr}:00Z\`);
  const limits = t3ResolveLimits(ctx, now);
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
          "aria-label": "上下文与统计",
          children: (0, $.jsx)(T3ContextPopoverCard, { usage: n, stats: ctx?.threadStats, loc })
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
  "arrow-right": ["M5 12h14", "m12 5 7 7-7 7"]
};
function T3Glyph({ name, className }) {
  return (0, $.jsx)("svg", {
    xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
    className: "lucide lucide-" + name + " t3e-glyph" + (className ? " " + className : ""),
    children: (T3_GLYPHS[name] || []).map((d, i) => (0, $.jsx)("path", { d }, i))
  });
}
function T3PlusMenuItem({ icon, label, hint, onSelect }) {
  return (0, $.jsxs)("button", {
    type: "button",
    onClick: onSelect,
    className: "t3e-row t3e-menu-row flex w-full cursor-pointer items-center text-left focus-visible:outline-none",
    children: [
      (0, $.jsx)("span", { className: "t3e-menu-icon-slot", children: icon }),
      (0, $.jsxs)("span", {
        className: "flex min-w-0 flex-1 items-baseline gap-2",
        children: [
          (0, $.jsx)("span", { className: "shrink-0 text-[13px] font-medium leading-5 text-foreground", children: label }),
          hint ? (0, $.jsx)("span", { className: "min-w-0 truncate text-xs leading-5 text-muted-foreground", children: hint }) : null
        ]
      })
    ]
  });
}

function T3ComposerPlusMenu() {
  const act = (0, Z.useContext)(T3ComposerCtx);
  const [open, setOpen] = (0, Z.useState)(false);
  const fileRef = (0, Z.useRef)(null);

  const runInsert = (token) => {
    setOpen(false);
    window.requestAnimationFrame(() => {
      act?.insertText?.(token, { ensureLeadingBoundary: true });
      act?.focusAtEnd?.();
    });
  };

  const handleFileChange = (ev) => {
    const files = Array.from(ev.currentTarget.files ?? []);
    ev.currentTarget.value = "";
    if (!files.length) return;
    act?.addComposerAttachments?.(files).then(handled => {
      if (!handled) act?.focusComposer?.();
    });
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
      (0, $.jsxs)(el, {
        open,
        onOpenChange: setOpen,
        children: [
          (0, $.jsx)(Qc, {
            render: (0, $.jsx)("button", {
              type: "button",
              onPointerDown: qI,
              "aria-label": "添加内容或打开多功能菜单",
              className: "t3e-plus-btn inline-flex shrink-0 cursor-pointer items-center justify-center"
            }),
            children: (0, $.jsx)(za, {})
          }),
          (0, $.jsx)(Zc, {
            side: "top",
            align: "start",
            sideOffset: 10,
            padding: "compact",
            "aria-label": "多功能菜单",
            children: (0, $.jsxs)("div", {
              className: "flex w-72 flex-col py-0.5 text-foreground",
              children: [
                (0, $.jsx)("div", { className: "px-2.5 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground", children: "添加" }),
                act?.canAttach ? (0, $.jsx)(T3PlusMenuItem, {
                  icon: (0, $.jsx)(ha, { className: "t3e-menu-icon" }),
                  label: "文件和图片",
                  hint: "附加本地文件或截图",
                  onSelect: () => {
                    setOpen(false);
                    fileRef.current?.click();
                  }
                }) : null,
                (0, $.jsx)(T3PlusMenuItem, {
                  icon: (0, $.jsx)(Aa, { className: "t3e-menu-icon" }),
                  label: "引用工作区文件",
                  hint: "输入 @ 检索文件或会话",
                  onSelect: () => runInsert("@")
                }),
                (0, $.jsx)(T3PlusMenuItem, {
                  icon: (0, $.jsx)(ka, { className: "t3e-menu-icon" }),
                  label: "技能与扩展",
                  hint: "输入 $ 调用已安装 Skills",
                  onSelect: () => runInsert("$")
                }),
                (0, $.jsx)("div", { className: "my-1.5 border-t border-border/60" }),
                (0, $.jsx)("div", { className: "px-2.5 pb-1 text-[11px] font-medium text-muted-foreground", children: "模式与命令" }),
                act?.sideChatAvailable ? (0, $.jsx)(T3PlusMenuItem, {
                  icon: (0, $.jsx)(Fa, { className: "t3e-menu-icon" }),
                  label: "侧边对话",
                  hint: "输入 /btw 发起旁路提问",
                  onSelect: () => runInsert("/btw ")
                }) : null,
                act?.canCompact ? (0, $.jsx)(T3PlusMenuItem, {
                  icon: (0, $.jsx)(ra, { className: "t3e-menu-icon" }),
                  label: "压缩上下文",
                  hint: "整理当前对话释放空间",
                  onSelect: () => {
                    setOpen(false);
                    act.onCompactContext?.();
                  }
                }) : null,
                typeof act?.onFreshSession === "function" ? (0, $.jsx)(T3PlusMenuItem, {
                  icon: (0, $.jsx)(Ba, { className: "t3e-menu-icon" }),
                  label: "新建干净上下文",
                  hint: "清空上下文继续当前线程",
                  onSelect: () => {
                    setOpen(false);
                    act.onFreshSession?.();
                  }
                }) : null,
                (0, $.jsx)(T3PlusMenuItem, {
                  icon: (0, $.jsx)(Ga, { className: "t3e-menu-icon" }),
                  label: "斜杠命令",
                  hint: "输入 / 打开全部内置命令",
                  onSelect: () => runInsert("/")
                })
              ]
            })
          })
        ]
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
  const limits = t3ResolveLimits(ctx, now);
  if (!limits || TC(limits, fmtFn) || !limits.windows.length) return null;
  const paired = t3PairUsageWindows(limits.windows);
  const activeModel = composerAct?.activeModel || ctx?.activeModel || "";
  const primary = t3SelectPrimaryQuotaForModel(paired, activeModel);
  if (!primary) return null;
  const isDual = primary.kind === "dual";
  const sPct = isDual ? U_(primary.shortWindow) : U_(primary.window);
  const lPct = isDual ? U_(primary.longWindow) : null;
  const sCol = t3QuotaColor(sPct, false);
  const lCol = lPct !== null ? t3QuotaColor(lPct, true) : sCol;
  const displayPct = isDual ? Math.min(sPct, lPct) : sPct;
  const textCol = displayPct <= 20 ? t3QuotaColor(displayPct, false) : undefined;
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
          "aria-label": \`\${primary.title} 额度剩余 \${sPct}%，悬停查看全部额度\`,
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
        "aria-label": "用量",
        children: (0, $.jsx)(T3QuotaPopoverCard, { limits, now, tFn, fmtFn, activeKey: primary.key, onClose: () => setOpen(false) })
      })
    ]
  });
}

function T3ComposerContextRing() {
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
          "aria-label": \`上下文 \${inlineText}，悬停查看统计详情\`,
          className: "t3e-pill me-1 inline-flex shrink-0 cursor-pointer items-center gap-1.5 font-medium tabular-nums text-muted-foreground"
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
        "aria-label": "上下文与统计",
        children: (0, $.jsx)(T3ContextPopoverCard, { usage, stats: ctx?.threadStats, loc })
      })
    ]
  });
}

function t3PickDefaultModelForInstance(entry, modelOptionsByInstance) {
  const list = (modelOptionsByInstance?.get?.(entry.instanceId) ?? []).filter(m => m && !m.isUnavailable);
  const nonDefault = list.find(m => m.slug && m.slug !== "antigravity-default");
  if (nonDefault) return nonDefault.slug;
  if (list[0]?.slug) return list[0].slug;
  if (entry.defaultModel) return entry.defaultModel;
  return null;
}

function T3EffortSlider({ steps, activeIndex, disabled, onSelectIndex }) {
  const trackRef = (0, Z.useRef)(null);
  const count = steps.length;
  const clamped = Math.max(0, Math.min(count - 1, activeIndex));
  const pctFor = (idx) => {
    if (count <= 1) return 50;
    const margin = 6;
    return margin + (idx / (count - 1)) * (100 - margin * 2);
  };
  const thumbPct = pctFor(clamped);
  const fillPct = count <= 1 || clamped === count - 1 ? 100 : Math.min(100, thumbPct + 5.5);

  const pickFromClientX = (clientX) => {
    if (disabled || !trackRef.current || count <= 1) return;
    const rect = trackRef.current.getBoundingClientRect();
    if (!rect.width) return;
    const rel = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const idx = Math.round(rel * (count - 1));
    if (idx !== clamped) onSelectIndex(idx);
  };

  return (0, $.jsxs)("div", {
    className: "flex flex-col gap-1.5",
    children: [
      (0, $.jsxs)("div", {
        ref: trackRef,
        role: "slider",
        tabIndex: disabled ? -1 : 0,
        "aria-label": "思考深度",
        "aria-valuemin": 0,
        "aria-valuemax": Math.max(0, count - 1),
        "aria-valuenow": clamped,
        "aria-valuetext": steps[clamped]?.label ?? "",
        "data-max": count > 1 && clamped === count - 1 ? "true" : undefined,
        className: "t3e-slider-track",
        onPointerDown: (ev) => {
          if (disabled) return;
          ev.preventDefault();
          ev.currentTarget.setPointerCapture?.(ev.pointerId);
          pickFromClientX(ev.clientX);
        },
        onPointerMove: (ev) => {
          if (disabled || !(ev.buttons & 1)) return;
          pickFromClientX(ev.clientX);
        },
        onKeyDown: (ev) => {
          if (disabled) return;
          if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
            ev.preventDefault();
            onSelectIndex(Math.max(0, clamped - 1));
          } else if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
            ev.preventDefault();
            onSelectIndex(Math.min(count - 1, clamped + 1));
          }
        },
        children: [
          (0, $.jsx)("div", { className: "t3e-slider-fill", style: { width: \`\${fillPct}%\` } }),
          steps.map((st, idx) => (0, $.jsx)("span", {
            className: "t3e-slider-dot",
            style: {
              left: \`\${pctFor(idx)}%\`,
              backgroundColor: idx < clamped ? "rgba(255,255,255,0.65)" : idx === clamped ? "transparent" : "rgba(127,127,127,0.5)"
            }
          }, st.id)),
          (0, $.jsx)("div", { className: "t3e-slider-thumb", style: { left: \`\${thumbPct}%\` } })
        ]
      }),
      (0, $.jsx)("div", {
        className: "flex items-center justify-between gap-1 px-1",
        children: steps.map((st, idx) => (0, $.jsx)("button", {
          type: "button",
          disabled,
          onClick: () => !disabled && onSelectIndex(idx),
          className: idx === clamped
            ? "t3e-effort-title cursor-pointer truncate text-[11px] font-semibold"
            : "cursor-pointer truncate text-[11px] text-muted-foreground hover:text-foreground",
          children: st.label
        }, st.id))
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
  getModelDisabledReason,
  runtimeMode,
  runtimeModeOptions,
  onRuntimeModeChange
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = (0, Z.useState)(false);
  const modelOpen = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen;
  const setModelOpen = (next) => {
    setUncontrolledOpen(next);
    controlledOnOpenChange?.(next);
  };
  const [effortOpen, setEffortOpen] = (0, Z.useState)(false);
  const [viewedInstanceId, setViewedInstanceId] = (0, Z.useState)(activeInstanceId);
  const [searchQuery, setSearchQuery] = (0, Z.useState)("");
  const [harnessesExpanded, setHarnessesExpanded] = (0, Z.useState)(false);

  (0, Z.useEffect)(() => {
    if (modelOpen) {
      setViewedInstanceId(activeInstanceId);
      setSearchQuery("");
    }
  }, [modelOpen, activeInstanceId]);

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
      steps = [{ id: "off", label: "关" }, { id: "on", label: "开" }];
      activeIdx = effort.descriptor.currentValue === true ? 1 : 0;
      activeLabel = activeIdx === 1 ? "开启" : "关闭";
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
  const modelTitle = activeModelObj?.name || activeModel || activeEntry?.displayName || "选择模型";

  const effectiveViewedId = enabledEntries.some(it => it.instanceId === viewedInstanceId)
    ? viewedInstanceId
    : activeInstanceId;
  const viewedEntry = enabledEntries.find(it => it.instanceId === effectiveViewedId) || activeEntry;
  const viewedModelsRaw = (modelOptionsByInstance?.get?.(effectiveViewedId) ?? []).filter(m => m && !m.isUnavailable && m.slug !== "antigravity-default");
  const normQ = searchQuery.trim().toLowerCase();
  const viewedModels = normQ
    ? viewedModelsRaw.filter(m => ((m.name || "") + " " + (m.slug || "")).toLowerCase().includes(normQ))
    : viewedModelsRaw;

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

  const showEffortBtn = steps.length > 0 || hasFast;

  return (0, $.jsxs)(Z.Fragment, {
    children: [
      (0, $.jsxs)(el, {
        open: modelOpen,
        onOpenChange: (v) => {
          setModelOpen(v);
          if (v) setEffortOpen(false);
        },
        children: [
          (0, $.jsx)(Qc, {
            render: (0, $.jsx)("button", {
              type: "button",
              disabled,
              onPointerDown: qI,
              "aria-label": \`切换模型或 Harness：\${modelTitle}\`,
              className: "t3e-pill t3e-model-trigger inline-flex shrink-0 cursor-pointer items-center gap-1.5 font-medium text-foreground"
            }),
            children: [
              activeEntry ? (0, $.jsx)(px, {
                driverKind: activeEntry.driverKind,
                displayName: activeEntry.displayName,
                accentColor: activeEntry.accentColor,
                acpRegistryAgentId: activeEntry.acpRegistryAgentId,
                acpRegistryIconUrl: activeEntry.acpRegistryIconUrl,
                className: "size-4 shrink-0",
                iconClassName: "size-4"
              }) : null,
              (0, $.jsx)("span", { className: "truncate leading-none", children: modelTitle })
            ]
          }),
          (0, $.jsx)(Zc, {
            side: "top",
            align: "end",
            sideOffset: 10,
            padding: "compact",
            "aria-label": "选择模型与 Harness",
            children: (0, $.jsxs)("div", {
              className: "flex w-72 flex-col gap-2.5 p-1 text-xs text-foreground",
              children: [
                (0, $.jsxs)("div", {
                  className: "flex items-center justify-between gap-2 px-1",
                  children: [
                    (0, $.jsx)("span", { className: "text-[13px] font-semibold leading-none tracking-tight text-foreground", children: "选择模型" }),
                    lockedProvider
                      ? (0, $.jsx)("span", { className: "text-[11px] text-muted-foreground", children: "当前线程已锁定引擎" })
                      : hasMoreHarnesses
                        ? (0, $.jsx)("button", {
                            type: "button",
                            onClick: () => setHarnessesExpanded(v => !v),
                            className: "t3e-row inline-flex cursor-pointer items-center gap-0.5 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground",
                            children: harnessesExpanded ? [(0, $.jsx)("span", { children: "收起" }, "t"), (0, $.jsx)(T3Glyph, { name: "chevron-up", className: "t3e-chev" }, "g")] : [(0, $.jsx)("span", { children: "展开 +" + hiddenCount }, "t"), (0, $.jsx)(T3Glyph, { name: "chevron-down", className: "t3e-chev" }, "g")]
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
                      "data-selected": isViewed ? "true" : "false",
                      title: isLockedOut ? "当前会话已锁定原 Harness" : entry.displayName,
                      onClick: () => {
                        if (isLockedOut) return;
                        setViewedInstanceId(entry.instanceId);
                        setSearchQuery("");
                      },
                      className: "t3e-harness-chip inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground",
                      children: [
                        (0, $.jsx)(px, {
                          driverKind: entry.driverKind,
                          displayName: entry.displayName,
                          accentColor: entry.accentColor,
                          acpRegistryAgentId: entry.acpRegistryAgentId,
                          acpRegistryIconUrl: entry.acpRegistryIconUrl,
                          className: "size-4 shrink-0",
                          iconClassName: "size-4"
                        }),
                        (0, $.jsx)("span", { className: "min-w-0 flex-1 truncate text-left", children: entry.displayName })
                      ]
                    }, entry.instanceId);
                  })
                }) : null,
                viewedModelsRaw.length > 6 ? (0, $.jsx)("input", {
                  type: "text",
                  value: searchQuery,
                  onChange: (ev) => setSearchQuery(ev.currentTarget.value),
                  placeholder: "搜索模型...",
                  className: "t3e-model-search"
                }) : null,
                (0, $.jsx)("div", {
                  className: "t3e-model-list flex flex-col gap-0.5",
                  children: viewedModels.length > 0
                    ? viewedModels.map(m => {
                        const isSelected = effectiveViewedId === activeInstanceId && m.slug === activeModel;
                        const disabledReason = getModelDisabledReason?.(effectiveViewedId, m.slug) ?? null;
                        return (0, $.jsxs)("button", {
                          type: "button",
                          disabled: disabled || Boolean(disabledReason),
                          "data-selected": isSelected ? "true" : "false",
                          title: disabledReason || m.name || m.slug,
                          onClick: () => {
                            if (disabled || disabledReason) return;
                            onSelectProviderModel?.(effectiveViewedId, m.slug);
                            setModelOpen(false);
                          },
                          className: "t3e-row t3e-model-row flex w-full cursor-pointer items-center justify-between text-left",
                          children: [
                            (0, $.jsxs)("span", {
                              className: "flex min-w-0 flex-1 items-center gap-2",
                              children: [
                                (0, $.jsx)("span", {
                                  className: isSelected ? "truncate text-[13px] font-medium text-foreground" : "truncate text-[13px] text-foreground",
                                  children: m.name || m.slug
                                })
                              ]
                            }),
                            isSelected ? (0, $.jsx)(T3Glyph, { name: "check", className: "t3e-check" }) : null
                          ]
                        }, \`\${effectiveViewedId}:\${m.slug}\`);
                      })
                    : (0, $.jsx)("div", { className: "px-2 py-3 text-center text-[11px] text-muted-foreground", children: "未找到匹配模型" })
                }),
                (0, $.jsxs)("div", {
                  className: "flex items-center justify-between gap-2 border-t border-border/60 pt-2",
                  children: [
                    runtimeModeOptions && runtimeModeOptions.length > 0
                      ? (0, $.jsx)(xz, { runtimeMode, options: runtimeModeOptions, onChange: onRuntimeModeChange })
                      : (0, $.jsx)("span", {}),
                    showEffortBtn ? (0, $.jsxs)("button", {
                      type: "button",
                      onClick: () => {
                        setModelOpen(false);
                        window.requestAnimationFrame(() => setEffortOpen(true));
                      },
                      className: "t3e-row inline-flex cursor-pointer items-center gap-1 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground",
                      children: [
                        (0, $.jsx)("span", { children: activeLabel ? \`思考深度 · \${activeLabel}\` : "思考深度" }),
                        (0, $.jsx)(T3Glyph, { name: "chevron-right", className: "t3e-chev" })
                      ]
                    }) : null
                  ]
                })
              ]
            })
          })
        ]
      }),
      showEffortBtn ? (0, $.jsxs)(el, {
        open: effortOpen,
        onOpenChange: (v) => {
          setEffortOpen(v);
          if (v) setModelOpen(false);
        },
        children: [
          (0, $.jsx)(Qc, {
            render: (0, $.jsx)("button", {
              type: "button",
              disabled,
              onPointerDown: qI,
              "aria-label": activeLabel ? \`调整思考深度：\${activeLabel}\` : "调整思考深度",
              className: "t3e-pill inline-flex shrink-0 cursor-pointer items-center gap-1.5 font-medium text-muted-foreground"
            }),
            children: [
              steps.length > 0
                ? (0, $.jsx)(ez, { count: Math.min(5, Math.max(2, steps.length)), filled: Math.min(5, activeIdx + 1), size: "sm" })
                : null,
              fastActive ? (0, $.jsx)(ra, { className: "size-3 shrink-0 text-amber-500" }) : null,
              (0, $.jsx)("span", { className: (steps.length > 0 ? "t3e-eff-text " : "") + "leading-none", children: activeLabel || "快速" })
            ]
          }),
          (0, $.jsx)(Zc, {
            side: "top",
            align: "end",
            sideOffset: 10,
            padding: "compact",
            "aria-label": "选择思考深度",
            children: (0, $.jsxs)("div", {
              className: "flex w-72 flex-col gap-3 p-1 text-xs text-foreground",
              children: [
                (0, $.jsxs)("div", {
                  className: "flex items-center justify-between gap-2",
                  children: [
                    (0, $.jsx)("button", {
                      type: "button",
                      disabled: !hasFast || disabled,
                      "data-active": fastActive ? "true" : "false",
                      title: hasFast ? (fastActive ? "快速模式：已开启" : "切换快速模式") : "当前模型不支持快速模式",
                      "aria-label": hasFast ? "切换快速模式" : "当前模型不支持快速模式",
                      onClick: handleToggleFast,
                      className: "t3e-icon-btn cursor-pointer",
                      children: (0, $.jsx)(ra, { className: "t3e-menu-icon" })
                    }),
                    (0, $.jsxs)("div", {
                      className: "flex min-w-0 flex-1 flex-col items-center text-center",
                      children: [
                        (0, $.jsx)("span", {
                          className: "t3e-effort-title t3e-effort-heading truncate font-semibold",
                          children: activeLabel || "思考深度"
                        }),
                        (0, $.jsxs)("button", {
                          type: "button",
                          onClick: () => {
                            setEffortOpen(false);
                            window.requestAnimationFrame(() => setModelOpen(true));
                          },
                          className: "mt-0.5 inline-flex max-w-full cursor-pointer items-center gap-0.5 truncate text-xs leading-4 text-muted-foreground hover:text-foreground",
                          children: [
                            (0, $.jsx)("span", { className: "truncate", children: modelTitle }),
                            (0, $.jsx)(T3Glyph, { name: "chevron-right", className: "t3e-chev" })
                          ]
                        })
                      ]
                    }),
                    (0, $.jsx)("button", {
                      type: "button",
                      disabled: (!effort && !hasFast) || disabled,
                      title: "恢复默认深度",
                      "aria-label": "恢复默认思考深度",
                      onClick: handleResetEffort,
                      className: "t3e-icon-btn cursor-pointer",
                      children: (0, $.jsx)(Ba, { className: "t3e-menu-icon" })
                    })
                  ]
                }),
                steps.length > 0
                  ? (0, $.jsx)(T3EffortSlider, { steps, activeIndex: activeIdx, disabled, onSelectIndex: handleSelectStep })
                  : (0, $.jsx)("div", { className: "rounded-lg bg-muted/40 px-2.5 py-2 text-center text-[11px] text-muted-foreground", children: "当前模型无独立思考深度档位" })
              ]
            })
          })
        ]
      }) : null
    ]
  });
}
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

  let patched =
    source.slice(0, iDU) +
    "function DU(e){return T3DetailsUsageRings(e)}" +
    "function OU(e){return T3DetailsContextRing(e)}" +
    source.slice(iKU);

  patched = patched.replace(
    composerLeftAnchor,
    '!_c?(0,$.jsxs)(`div`,{className:`t3e-footer-left me-2 flex shrink-0 items-center gap-1.5`,children:[(0,$.jsx)(T3ComposerPlusMenu,{}),(0,$.jsx)(T3ComposerQuotaRing,{})]}):null,'
  );
  patched = patched.replace(
    composerControlsAnchor,
    'className:Cr(`relative flex min-w-0 flex-1 items-center justify-end gap-0.5`,_c&&`hidden`),children:[(0,$.jsx)(T3ComposerContextRing,{}),Vl]})'
  );
  patched = patched.replace(
    tzControlsAnchor,
    'children:[(0,$.jsx)(T3UnifiedModelControls,{traits:fe,instanceEntries:I,modelOptionsByInstance:R,activeInstanceId:_e,activeModel:ve,lockedProvider:P,disabled:ge,open:B,onOpenChange:V,onSelectProviderModel:j,getModelDisabledReason:U,runtimeMode:m,runtimeModeOptions:g,onRuntimeModeChange:_}),(0,$.jsxs)($.Fragment,{children:[me.map'
  );
  patched = patched.replace(
    composerReturnStartAnchor,
    't[1173]=af):af=t[1173],(0,$.jsx)(T3ComposerCtx.Provider,{value:{canAttach:go,addComposerAttachments:lu,focusComposer:it,focusAtEnd:()=>pa.current?.focusAtEnd(),insertText:gu,onCompactContext:Be,canCompact:!ue&&!fe&&typeof Be===`function`,onFreshSession:e.onFreshSession,sideChatAvailable:e.sideChatAvailable===!0&&!e.sideChatDisabledReason,activeModel:Di||Ci?.model||oe?.model||se?.model||``},children:(0,$.jsxs)(`form`,'
  );
  patched = patched.replace(
    composerReturnEndAnchor,
    'tf,nf,rf,af]})})})]})})});function zz(e)'
  );
  patched = patched.replace(
    providerReturnAnchor,
    'return(0,$.jsx)(T3RingsCtx.Provider,{value:{providerInstanceId:vs,providers:Ko,sources:Vo?.usageLimitSources??XW,contextWindow:Dc,activeModel:Wr?.modelSelection?.model||``,threadStats:{runs:Y?.runs,messages:Y?.messages,turnItems:Y?.turnItems}},children:(0,$.jsx)(Ug,{threadRef:Xi,cwd:xu,checkpoints:Y?.checkpoints,children:bv})})'
  );

  return patched.replace(/\n?\/\/# sourceMappingURL=.*$/m, "") + "\n" + RUNTIME_MODULE + "\n";
}

module.exports = {
  id: ID,
  name: "加号菜单 + 替换原生模型/思考深度双面板 + 模型联动双环与统计",
  marker: MARKER,
  legacyMarkers: ["T3_USAGE_RINGS_V1", "T3_USAGE_RINGS_V2", "T3_USAGE_RINGS_V3", "T3_USAGE_RINGS_V4", "T3_USAGE_RINGS_V5", "T3_USAGE_RINGS_V6", "T3_USAGE_RINGS_V7", "T3_USAGE_RINGS_V8", "T3_USAGE_RINGS_V9", "T3_USAGE_RINGS_V10"],
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  apply,
  t3ClassifyWindow,
  t3BaseWindowName,
  t3PairUsageWindows,
  t3SelectPrimaryQuotaForModel,
};

/**
 * External ESM runtime for workspace floating panels, tab tearing, and docking deck.
 * Pure ES module with ZERO minified host dependencies.
 */

export const PREVIEW_LAYOUT_EVENT = "t3e-preview-layout";
export const PREVIEW_FLOAT_STORAGE_KEY = "t3e-floating-preview-frame";
export const PREVIEW_FLOAT_CORNER_RADIUS = 13;

function t3WpIsZh() {
  return typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
}

export function t3BrowserLayoutMode(element, fitSourceContent) {
  if (fitSourceContent) return true;
  return element?.closest?.(".t3e-floating-window")?.getAttribute("data-t3e-kind") === "preview" ? "responsive" : false;
}

export function workspaceFloatFrame(frame, bounds, direction = "", dx = 0, dy = 0) {
  const limit = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  const margin = 8;
  const width = Math.max(0, bounds.width - margin * 2);
  const height = Math.max(0, bounds.height - margin * 2);
  const minWidth = Math.min(frame.width < 230 ? frame.width : 230, width);
  const minHeight = Math.min(frame.height < 150 ? frame.height : 150, height);
  const w = limit(frame.width, minWidth, width);
  const h = limit(frame.height, minHeight, height);
  let x = limit(frame.x, margin, margin + width - w);
  let y = limit(frame.y, margin, margin + height - h);
  let right = x + w;
  let bottom = y + h;

  if (direction === "move") {
    x = limit(x + dx, margin, margin + width - w);
    y = limit(y + dy, margin, margin + height - h);
    return { x, y, width: w, height: h };
  }
  if (direction.includes("w")) x = limit(x + dx, margin, right - minWidth);
  if (direction.includes("e")) right = limit(right + dx, x + minWidth, margin + width);
  if (direction.includes("n")) y = limit(y + dy, margin, bottom - minHeight);
  if (direction.includes("s")) bottom = limit(bottom + dy, y + minHeight, margin + height);
  return { x, y, width: right - x, height: bottom - y };
}

export function workspaceSnapFrame(frame, bounds, threshold = 18) {
  const margin = 8;
  const { width, height } = frame;
  let { x, y } = frame;
  if (x - margin <= threshold) x = margin;
  else if (bounds.width - margin - (x + width) <= threshold) x = Math.max(margin, bounds.width - margin - width);
  if (y - margin <= threshold) y = margin;
  else if (bounds.height - margin - (y + height) <= threshold) y = Math.max(margin, bounds.height - margin - height);
  return { x, y, width, height };
}

export function defaultChatFloatFrame(bounds) {
  const width = Math.min(432, Math.max(360, Math.round(bounds.width * 0.36)));
  const height = Math.min(580, Math.max(400, Math.round(bounds.height * 0.68)));
  return workspaceFloatFrame({ x: bounds.width - width - 16, y: bounds.height - height - 16, width, height }, bounds);
}

export function chatPillFrame(frame, bounds, position) {
  const width = Math.min(232, Math.max(0, bounds.width - 16));
  const height = Math.min(38, Math.max(0, bounds.height - 16));
  const x = position?.x ?? frame.x + frame.width - width;
  const y = position?.y ?? frame.y + frame.height - height;
  return workspaceFloatFrame({ x, y, width, height }, bounds);
}

export function defaultPreviewFloatFrame(bounds) {
  const width = Math.min(416, Math.max(360, Math.round(bounds.width * 0.26)));
  const height = Math.min(520, Math.max(380, Math.round(bounds.height * 0.54)));
  return workspaceFloatFrame({ x: bounds.width - width - 12, y: bounds.height - height - 12, width, height }, bounds);
}

export function serializePreviewFloatFrame(frame, bounds) {
  if (!frame || !Number.isFinite(frame.x) || !Number.isFinite(frame.y)
    || !Number.isFinite(frame.width) || !Number.isFinite(frame.height)
    || frame.width <= 0 || frame.height <= 0) return null;
  const x = Math.round(frame.x);
  const y = Math.round(frame.y);
  const width = Math.round(frame.width);
  const height = Math.round(frame.height);
  const hasBounds = bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0;
  if (!hasBounds) return { x, y, width, height };
  return {
    x,
    y,
    width,
    height,
    anchorRight: (x + width / 2) >= bounds.width / 2,
    anchorBottom: (y + height / 2) >= bounds.height / 2,
    rightGap: Math.max(8, Math.round(bounds.width - (x + width))),
    bottomGap: Math.max(8, Math.round(bounds.height - (y + height))),
  };
}

export function restorePreviewFloatFrame(saved, bounds) {
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)
    || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)
    || saved.width <= 0 || saved.height <= 0) return null;
  const hasBounds = bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0;
  const x = hasBounds && saved.anchorRight && Number.isFinite(saved.rightGap)
    ? bounds.width - saved.width - saved.rightGap
    : saved.x;
  const y = hasBounds && saved.anchorBottom && Number.isFinite(saved.bottomGap)
    ? bounds.height - saved.height - saved.bottomGap
    : saved.y;
  return hasBounds
    ? workspaceFloatFrame({ x, y, width: saved.width, height: saved.height }, bounds)
    : { x, y, width: saved.width, height: saved.height };
}

function loadSavedPreviewFrame() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(PREVIEW_FLOAT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveSavedPreviewFrame(frame, bounds) {
  try {
    if (typeof localStorage === "undefined") return;
    const record = serializePreviewFloatFrame(frame, bounds);
    if (record) localStorage.setItem(PREVIEW_FLOAT_STORAGE_KEY, JSON.stringify(record));
  } catch {}
}

export function placeSurfaceFloat(bounds, occupied, preview, point, savedFrame) {
  const restored = preview && savedFrame ? restorePreviewFloatFrame(savedFrame, bounds) : null;
  const fallback = preview ? defaultPreviewFloatFrame(bounds) : null;
  const width = restored ? restored.width : (fallback ? fallback.width : Math.min(540, Math.round(bounds.width * 0.68)));
  const height = restored ? restored.height : (fallback ? fallback.height : Math.min(420, Math.round(bounds.height * 0.72)));
  const at = (x, y) => workspaceFloatFrame({ x, y, width, height }, bounds);
  if (point) return at(point.x - Math.round(width * 0.35), point.y - 16);

  const preferred = restored ?? (fallback ?? at(bounds.width - width - 16, 16));
  if (restored && occupied.length === 0) return restored;
  const xs = [preferred.x, preview ? 12 : 16];
  const ys = preview ? [preferred.y, 12] : [preferred.y, bounds.height - height - 16];
  for (const frame of occupied) {
    xs.push(frame.x - width - 12, frame.x + frame.width + 12);
    ys.push(frame.y - height - 12, frame.y + frame.height + 12);
  }
  let best = preferred;
  let bestOverlap = Infinity;
  let bestDistance = Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const candidate = at(x, y);
      const overlap = occupied.reduce((sum, item) => sum
        + Math.max(0, Math.min(candidate.x + candidate.width, item.x + item.width) - Math.max(candidate.x, item.x))
        * Math.max(0, Math.min(candidate.y + candidate.height, item.y + item.height) - Math.max(candidate.y, item.y)), 0);
      const distance = Math.hypot(candidate.x - preferred.x, candidate.y - preferred.y);
      if (overlap > bestOverlap || (overlap === bestOverlap && distance >= bestDistance)) continue;
      best = candidate;
      bestOverlap = overlap;
      bestDistance = distance;
    }
  }
  return best;
}

// Source-only patch calls cannot inspect the sibling chunks for browser settings.
function standaloneBrowserAddress(input) {
  const address = input.trim();
  if (!address) throw new TypeError("Browser address is empty");
  const local = /^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i.test(address);
  const bareHost = /^[^\s/:]+(?:\.[^\s./:]+)+(?=[:/?#]|$)/.test(address);
  const explicit = /^[a-z][a-z\d+.-]*:/i.test(address) && !local && !/^[^:/]+:\d+(?:[/?#]|$)/.test(address);
  if (explicit || local || bareHost) {
    const url = new URL(explicit ? address : (local ? "http://" : "https://") + address);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Unsupported browser protocol");
    return url.href;
  }
  return "https://duckduckgo.com/?q=" + encodeURIComponent(address);
}

export function createFloatingPanelsRuntime(host) {
  const {
    React,
    jsx,
    jsxs,
    Fragment = React.Fragment,
    createPortal,
    useI18n,
    useStableCallback,
    Button,
    CloseIcon,
    Tooltip,
    TooltipTrigger,
    TooltipPopup,
    PanelShell,
    SurfaceContent = PanelShell,
    rightPanelStore,
    getPanelState,
    diffPanelStore,
    threadRefKey,
    miniPlayerStore,
    getMiniPlayer,
    focusTerminal,
    resolveBrowserAddress,
    browserSearchTemplate,
    getBrowserSettings,
  } = host;

  const DefaultCloseIcon = ({ "aria-hidden": ariaHidden, className = "size-3.5" }) => jsx("svg", {
    viewBox: "0 0 16 16",
    width: 14,
    height: 14,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    "aria-hidden": ariaHidden,
    className,
    children: [
      jsx("path", { d: "M4 4l8 8" }),
      jsx("path", { d: "M12 4l-8 8" })
    ]
  });
  const SafeCloseIcon = CloseIcon || DefaultCloseIcon;

  const stableCallback = useStableCallback || ((fn) => React.useCallback(fn, []));

  const styles = `
.t3e-floating-deck { position: absolute; inset: var(--t3e-window-bar, 0px) 0 0 0; pointer-events: none; }
@keyframes t3e-float-pop {
  from { opacity: 0; transform: scale(0.92) translateY(-10px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes t3e-ghost-in {
  from { opacity: 0; scale: 0.88; }
  to { opacity: 1; scale: 1; }
}
.t3e-floating-window {
  position: absolute; display: flex; flex-direction: column; pointer-events: auto;
  background: var(--background); color: var(--foreground);
  border: 1px solid rgba(0, 0, 0, 0.10); border-radius: 14px;
  box-shadow: 0 12px 36px -6px rgba(0, 0, 0, 0.20), 0 2px 8px rgba(0, 0, 0, 0.06); box-sizing: border-box;
  -webkit-app-region: no-drag;
  animation: t3e-float-pop 200ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  transition: opacity 150ms ease, transform 150ms cubic-bezier(0.22, 1, 0.36, 1);
}
.dark .t3e-floating-window {
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow: 0 14px 40px -6px rgba(0, 0, 0, 0.52), 0 2px 10px rgba(0, 0, 0, 0.28);
}
.t3e-floating-window[data-docking] {
  opacity: 0;
  transform: scale(0.94) translateX(22px);
  pointer-events: none;
}
.t3e-floating-header {
  flex: 0 0 34px; display: flex; align-items: center; gap: 6px;
  padding-inline: 12px 6px; border-bottom: 1px solid var(--border);
  border-radius: 13px 13px 0 0;
  touch-action: none; user-select: none; cursor: grab;
  transition: flex-basis 180ms cubic-bezier(0.22, 1, 0.36, 1), border-color 160ms ease;
}
.t3e-floating-header:active, [data-t3e-preview-drag]:active { cursor: grabbing; }
.t3e-floating-header-grip {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 14px; height: 14px; color: var(--muted-foreground); opacity: 0.55;
  transition: opacity 140ms ease, color 140ms ease;
}
.t3e-floating-header:hover .t3e-floating-header-grip { opacity: 0.95; color: var(--foreground); }
.t3e-floating-header-actions {
  display: inline-flex; align-items: center; gap: 2px; flex: none;
}
.t3e-floating-header-actions button {
  display: inline-flex !important; align-items: center !important; justify-content: center !important;
  width: 24px !important; min-width: 24px !important; height: 24px !important;
  padding: 0 !important; border-radius: 7px !important;
}
.t3e-floating-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12.5px; font-weight: 500; }
.t3e-floating-window[data-compact] .t3e-floating-header { flex-basis: 22px; border-bottom-color: transparent; }
.t3e-floating-window[data-compact] .t3e-floating-header > * { opacity: 0; transition: opacity 160ms ease; }
.t3e-floating-window[data-compact]:hover .t3e-floating-header,
.t3e-floating-window[data-compact]:focus-within .t3e-floating-header { flex-basis: 34px; border-bottom-color: var(--border); }
.t3e-floating-window[data-compact]:hover .t3e-floating-header > *,
.t3e-floating-window[data-compact]:focus-within .t3e-floating-header > * { opacity: 1; }
.t3e-floating-window[data-compact] [data-surface-subheader] { display: none !important; }
.t3e-floating-body {
  position: relative; flex: 1 1 0; min-height: 0; min-width: 0;
  display: flex; overflow: hidden; border-radius: 0 0 13px 13px;
}
/* 浏览器浮窗：四边统一圆角 + 宽大顶部拖拽栏 + 紧凑均衡工具栏 */
.t3e-floating-window[data-t3e-kind="preview"] {
  container: t3e-floating-preview / inline-size;
  border-radius: 14px;
}
.t3e-floating-window[data-t3e-kind="preview"] .t3e-floating-header {
  flex: 0 0 32px;
  padding-inline: 10px 6px;
  border-bottom-color: var(--cx-line-soft, var(--border));
}
.t3e-floating-window[data-t3e-kind="preview"] .t3e-floating-body {
  border-radius: 0 0 13px 13px;
}
.t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader] {
  display: flex !important;
  align-items: center !important;
  height: 38px !important;
  min-height: 38px !important;
  padding-inline: 8px !important;
  gap: 4px !important;
  border-radius: 0 !important;
  border-bottom: 1px solid var(--cx-line-soft, var(--border)) !important;
  overflow: hidden;
  cursor: grab;
  user-select: none;
}
.t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader]:active {
  cursor: grabbing;
}
.t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader] [role="group"] {
  display: inline-flex !important;
  align-items: center !important;
  gap: 1px !important;
  flex: none !important;
}
.t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader] button {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex: 0 0 26px !important;
  width: 26px !important;
  min-width: 26px !important;
  height: 26px !important;
  padding: 0 !important;
  border-radius: 7px !important;
}
.t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader] button svg {
  width: 14px !important;
  height: 14px !important;
}
.t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader]:has([data-preview-url-input]) [data-slot="input-group"],
.t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader] [data-slot="input-group"] {
  flex: 1 1 0% !important;
  min-width: 64px !important;
  height: 28px !important;
  min-height: 28px !important;
  margin-inline: 2px !important;
  padding-inline: 10px 6px !important;
  border-radius: 999px !important;
  overflow: hidden !important;
}
.t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader] [data-slot="input-group"] button {
  flex: 0 0 22px !important;
  width: 22px !important;
  min-width: 22px !important;
  height: 22px !important;
  border-radius: 999px !important;
}
.t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader] input {
  min-width: 0 !important;
  width: 100% !important;
  font-size: 12.5px !important;
  line-height: 18px !important;
  cursor: text;
  user-select: text;
}
@container t3e-floating-preview (width < 320px) {
  .t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader] {
    padding-inline: 6px !important;
    gap: 2px !important;
  }
  .t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader] button {
    flex: 0 0 24px !important;
    width: 24px !important;
    min-width: 24px !important;
    height: 24px !important;
  }
  .t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader]:has([data-preview-url-input]) [data-slot="input-group"],
  .t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader] [data-slot="input-group"] {
    padding-inline: 8px 4px !important;
  }
}
/* 主对话应用内浮窗：零卸载平滑切换，复用统一浮窗边框、阴影与八方向缩放 */
@keyframes t3e-chat-float-in {
  from { opacity: 0.25; }
  to { opacity: 1; }
}
.t3e-chat-floating-window {
  position: absolute !important;
  flex: none !important;
  margin-block-start: 0 !important;
  overflow: hidden !important;
  border-radius: 18px !important;
  animation: t3e-chat-float-in 160ms ease !important;
  transition: none !important;
}
.t3e-chat-floating-window:not([data-t3e-chat-minimized]) {
  container: t3e-floating-chat / size;
  --t3e-chat-heading-height: 40px;
}
.t3e-chat-floating-window[data-t3e-chat-floating] > [data-chat-header] {
  height: var(--t3e-chat-heading-height, 40px) !important;
  min-height: var(--t3e-chat-heading-height, 40px) !important;
  padding-inline: 24px 12px !important;
  border-bottom: 1px solid var(--cx-line-soft, var(--border)) !important;
  border-radius: 17px 17px 0 0 !important;
  -webkit-app-region: no-drag !important;
  cursor: grab !important;
  user-select: none !important;
  touch-action: none !important;
}
.t3e-chat-floating-window > [data-chat-header]:active {
  cursor: grabbing !important;
}
.t3e-chat-floating-window > [data-chat-header] > [data-t3e-chat-heading] {
  padding-inline-end: 0 !important;
}
@container t3e-floating-chat (width < 420px) or (height < 440px) {
  [data-chat-header] { --t3e-chat-heading-height: 36px; }
  .t3e-chat-float-grip { height: 36px; }
  [data-chat-header] > [data-t3e-chat-heading] { gap: 4px; }
  [data-t3e-chat-heading] [data-slot="workspace-breadcrumb-text"] { display: none; }
  .chat-composer-lane { padding-inline: 8px; }
  [data-chat-composer-stack] [data-slot="composer-host"] {
    border-radius: 16px !important;
    box-shadow: none !important;
  }
  [data-chat-composer-stack] [data-slot="composer-host"] > div {
    border-radius: 15px !important;
  }
  [data-chat-composer-stack] [data-chat-composer-body] { padding-block-start: 6px; }
  [data-chat-composer-stack] .composer-tiptap { font-size: 13px !important; line-height: 20px !important; }
  [data-chat-composer-stack] [data-chat-composer-footer] { padding-inline: 6px; padding-bottom: 4px; }
  [data-chat-composer-stack] :is(.t3e-model-name, .t3e-eff-text, .t3e-permissions-label, .t3e-q-text, .t3e-context-trigger) { display: none; }
  [data-chat-composer-stack] :is(.t3e-pill, [data-composer-permissions-trigger]) { min-height: 26px; height: 26px; }
}
.t3e-chat-float-grip {
  position: absolute; top: 0; left: 2px; width: 22px; height: 40px; z-index: 4;
  display: flex; align-items: center; justify-content: center;
  color: var(--muted-foreground); opacity: 0.36;
  touch-action: none; user-select: none; cursor: grab;
  transition: opacity 140ms ease, color 140ms ease;
}
.t3e-chat-float-grip:hover { opacity: 1; color: var(--foreground); }
.t3e-chat-float-grip:active { cursor: grabbing; }
.t3e-chat-toolbar {
  display: flex; align-items: center; flex: none; gap: 4px;
  height: 28px;
  -webkit-app-region: no-drag;
}
.t3e-chat-toolbar[data-t3e-conversation-actions] {
  margin-inline-start: auto;
}
.t3e-chat-toolbar [data-panel-layout-controls] {
  display: flex; align-items: center; height: 28px; gap: 4px !important;
}
.t3e-main-chat-tab {
  order: -1; flex: none; display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding-inline: 10px; border-radius: 7px;
  background: color-mix(in srgb, var(--foreground) 6%, transparent);
  color: var(--foreground); font-size: 12px; white-space: nowrap;
  cursor: pointer; -webkit-app-region: no-drag;
}
.t3e-main-chat-tab:hover { background: color-mix(in srgb, var(--foreground) 11%, transparent); }
.t3e-main-chat-tab[aria-pressed="true"] { background: color-mix(in srgb, var(--foreground) 12%, transparent); }
[data-t3e-main-chat-active] .t3e-new-tab-pill[data-active-tab="false"]:not(:hover) {
  background: transparent !important;
}
[data-t3e-workspace] > [data-chat-column][data-t3e-chat-expanded] {
  position: absolute; z-index: 26;
  inset: calc(var(--t3e-window-bar, 0px) + var(--t3e-workspace-toolbar, var(--workspace-topbar-height, 38px)) + 1px) 0 0;
  margin: 0 !important; width: auto !important; height: auto !important;
  border: 0 !important; border-radius: 0 !important; box-shadow: none !important;
  background: var(--cx-surface, var(--background));
}
[data-t3e-workspace] > [data-chat-column][data-t3e-chat-expanded] > [data-chat-header] {
  --t3e-chat-header-padding-end: 12px;
}
[data-t3e-workspace][data-t3e-main-chat-active] > [data-preview-panel-mode="inline"] [data-right-panel-tabbar] ~ * {
  display: none !important;
}
[data-chat-column][data-t3e-chat-settling="true"] .messages-timeline-scroll {
  opacity: 0 !important;
  transition: none !important;
}
[data-chat-column] .messages-timeline-scroll {
  transition: opacity 75ms ease;
}
[data-t3e-workspace] [data-chat-header] .t3e-chat-toolbar button,
[data-t3e-workspace] .t3e-chat-toolbar button,
.t3e-chat-toolbar button,
[data-right-panel-tabbar] .t3e-chat-toolbar[data-t3e-panel-actions] button {
  display: inline-flex !important; align-items: center !important; justify-content: center !important;
  box-sizing: border-box !important; flex: 0 0 28px !important;
  width: 28px !important; min-width: 28px !important; max-width: 28px !important;
  height: 28px !important; min-height: 28px !important; max-height: 28px !important;
  margin: 0 !important; padding: 0 !important; border: 0 !important; border-radius: 7px !important;
  color: var(--cx-ink-2, var(--muted-foreground)) !important;
  background: transparent !important;
  box-shadow: none !important;
  transform: none !important; scale: none !important;
  cursor: pointer; -webkit-app-region: no-drag;
  transition: background-color 140ms ease, color 140ms ease;
}
[data-t3e-workspace] .t3e-chat-toolbar button:hover:not(:disabled),
[data-t3e-workspace] .t3e-chat-toolbar button:focus-visible:not(:disabled),
.t3e-chat-toolbar button:hover:not(:disabled),
.t3e-chat-toolbar button:focus-visible:not(:disabled) {
  background: var(--cx-hover, rgba(0, 0, 0, 0.06)) !important;
  color: var(--cx-ink-1, var(--foreground)) !important;
}
.dark .t3e-chat-toolbar button:hover:not(:disabled),
.dark .t3e-chat-toolbar button:focus-visible:not(:disabled) {
  background: var(--cx-hover, rgba(255, 255, 255, 0.10)) !important;
}
[data-t3e-workspace] .t3e-chat-toolbar button:is([aria-pressed="true"], [data-pressed]),
.t3e-chat-toolbar button:is([aria-pressed="true"], [data-pressed]) {
  background: var(--cx-selected, rgba(0, 0, 0, 0.08)) !important;
  color: var(--cx-ink-1, var(--foreground)) !important;
}
.dark [data-t3e-workspace] .t3e-chat-toolbar button:is([aria-pressed="true"], [data-pressed]),
.dark .t3e-chat-toolbar button:is([aria-pressed="true"], [data-pressed]) {
  background: var(--cx-selected, rgba(255, 255, 255, 0.14)) !important;
  color: var(--cx-ink-1, var(--foreground)) !important;
}
[data-t3e-workspace] .t3e-chat-toolbar button:is([aria-pressed="true"], [data-pressed]):hover:not(:disabled),
.t3e-chat-toolbar button:is([aria-pressed="true"], [data-pressed]):hover:not(:disabled) {
  background: var(--cx-chip, rgba(0, 0, 0, 0.12)) !important;
  color: var(--cx-ink-1, var(--foreground)) !important;
}
[data-t3e-workspace] .t3e-chat-toolbar button:disabled,
.t3e-chat-toolbar button:disabled {
  opacity: 0.42 !important;
  cursor: default;
}
[data-t3e-workspace] [data-chat-header] .t3e-chat-toolbar button svg,
[data-t3e-workspace] .t3e-chat-toolbar button svg,
.t3e-chat-toolbar button svg,
[data-right-panel-tabbar] .t3e-chat-toolbar[data-t3e-panel-actions] button svg {
  flex: none !important; width: 15px !important; height: 15px !important;
  margin-inline: 0 !important;
  color: currentColor !important; opacity: 1 !important;
  stroke-width: 1.65 !important; stroke-linecap: round; stroke-linejoin: round;
}
.t3e-chat-toolbar button svg :is(path, circle, rect, line, polyline, polygon, ellipse) {
  vector-effect: non-scaling-stroke;
}
.t3e-chat-floating-window[data-t3e-chat-minimized="true"] {
  border-radius: 19px !important;
  box-shadow: 0 8px 24px -6px rgba(0, 0, 0, 0.22), 0 2px 6px rgba(0, 0, 0, 0.08) !important;
}
.t3e-chat-floating-window[data-t3e-chat-minimized="true"] > :not(.t3e-chat-pill):not(.t3e-floating-handle):not(.t3e-chat-float-grip) {
  position: absolute !important; left: 0 !important; top: 0 !important;
  width: var(--t3e-chat-w) !important; height: var(--t3e-chat-h) !important;
  visibility: hidden !important; pointer-events: none !important;
}
.t3e-chat-floating-window[data-t3e-chat-minimized="true"] > :is(.t3e-floating-handle, .t3e-chat-float-grip) { display: none !important; }
.t3e-chat-pill {
  position: absolute; inset: 0; z-index: 6;
  display: flex; align-items: center; gap: 8px; padding: 0 14px;
  border-radius: inherit; background: var(--background); color: var(--foreground);
  font-size: 12.5px; font-weight: 500; line-height: 1;
  cursor: grab; user-select: none; touch-action: none; outline: none;
  transition: background-color 160ms ease;
}
.t3e-chat-pill:active { cursor: grabbing; }
.t3e-chat-pill:hover, .t3e-chat-pill:focus-visible { background: color-mix(in srgb, var(--foreground) 5%, var(--background)); }
.t3e-chat-pill-dot { flex: none; width: 8px; height: 8px; border-radius: 9999px; background: var(--muted-foreground); opacity: 0.5; }
.t3e-chat-pill-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3e-chat-pill-hint { flex: none; font-size: 11px; font-weight: 400; color: var(--muted-foreground); }
.t3e-chat-pill[data-state="working"] .t3e-chat-pill-dot { background: var(--cx-accent, #2563eb); opacity: 1; animation: t3e-pill-pulse 1.4s ease-in-out infinite; }
.t3e-chat-pill[data-state="approval"], .t3e-chat-pill[data-state="input"] { background: color-mix(in srgb, #d97706 13%, var(--background)); }
.t3e-chat-pill[data-state="approval"] .t3e-chat-pill-dot, .t3e-chat-pill[data-state="input"] .t3e-chat-pill-dot { background: #d97706; opacity: 1; animation: t3e-pill-pulse-warn 1.6s ease-in-out infinite; }
.t3e-chat-pill[data-state="done"] .t3e-chat-pill-dot { background: #16a34a; opacity: 1; }
@keyframes t3e-pill-pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--cx-accent, #2563eb) 45%, transparent); } 50% { box-shadow: 0 0 0 5px transparent; } }
@keyframes t3e-pill-pulse-warn { 0%, 100% { box-shadow: 0 0 0 0 rgba(217, 119, 6, 0.45); } 50% { box-shadow: 0 0 0 5px transparent; } }
.t3e-floating-window[data-dragging] .t3e-floating-body { pointer-events: none; }
.t3e-floating-window [data-thread-terminal-drawer] aside { width: 132px !important; min-width: 132px !important; }
.t3e-floating-handle { position: absolute; z-index: 2; touch-action: none; }
.t3e-floating-handle[data-edge=n] { inset: -5px 10px auto; height: 7px; cursor: ns-resize; }
.t3e-floating-handle[data-edge=s] { inset: auto 8px -5px; height: 9px; cursor: ns-resize; }
.t3e-floating-handle[data-edge=w] { inset: 8px auto 8px -5px; width: 9px; cursor: ew-resize; }
.t3e-floating-handle[data-edge=e] { inset: 8px -5px 8px auto; width: 9px; cursor: ew-resize; }
.t3e-floating-handle[data-edge$=w][data-corner] { left: -5px; }
.t3e-floating-handle[data-edge$=e][data-corner] { right: -5px; }
.t3e-floating-handle[data-edge^=n][data-corner] { top: -5px; }
.t3e-floating-handle[data-edge^=s][data-corner] { bottom: -5px; }
.t3e-floating-handle[data-corner] { width: 14px; height: 14px; }
.t3e-floating-handle[data-edge=nw], .t3e-floating-handle[data-edge=se] { cursor: nwse-resize; }
.t3e-floating-handle[data-edge=ne], .t3e-floating-handle[data-edge=sw] { cursor: nesw-resize; }
.t3e-chat-floating-window > .t3e-floating-handle[data-edge=n] { top: 0; height: 5px; }
.t3e-chat-floating-window > .t3e-floating-handle[data-edge=s] { bottom: 0; height: 5px; }
.t3e-chat-floating-window > .t3e-floating-handle[data-edge=w] { left: 0; width: 5px; }
.t3e-chat-floating-window > .t3e-floating-handle[data-edge=e] { right: 0; width: 5px; }
.t3e-chat-floating-window > .t3e-floating-handle[data-corner] { z-index: 5; width: 12px; height: 12px; }
.t3e-chat-floating-window > .t3e-floating-handle[data-edge$=w][data-corner] { left: 1px; }
.t3e-chat-floating-window > .t3e-floating-handle[data-edge$=e][data-corner] { right: 1px; }
.t3e-chat-floating-window > .t3e-floating-handle[data-edge^=n][data-corner] { top: 1px; }
.t3e-chat-floating-window > .t3e-floating-handle[data-edge^=s][data-corner] { bottom: 1px; }
.t3e-floating-dock, .t3e-floating-content {
  position: relative; display: flex; flex-direction: column; min-height: 0; min-width: 0;
  flex: 1 1 0; height: 100%; width: 100%;
}
.t3e-tab-float-btn {
  display: inline-flex !important; align-items: center !important; justify-content: center !important;
  flex: 0 0 18px !important; width: 18px !important; min-width: 18px !important; max-width: 18px !important;
  height: 20px !important; padding: 0 !important; border: 0 !important;
  border-radius: 5px !important; margin-inline-start: 0 !important;
  color: var(--muted-foreground); background: transparent !important;
  cursor: pointer; -webkit-app-region: no-drag; opacity: 0.7;
  transition: background-color 140ms ease, color 140ms ease, opacity 140ms ease;
}
[data-active-tab="true"] .t3e-tab-float-btn {
  color: var(--muted-foreground); background: transparent !important; opacity: 0.85;
}
.t3e-tab-float-btn:hover, .t3e-tab-float-btn:focus-visible {
  background: rgba(0, 0, 0, 0.08) !important; color: var(--foreground) !important; opacity: 1;
}
.dark .t3e-tab-float-btn:hover, .dark .t3e-tab-float-btn:focus-visible {
  background: rgba(255, 255, 255, 0.12) !important; color: var(--foreground) !important; opacity: 1;
}
.t3e-tab-float-btn svg { width: 13px !important; height: 13px !important; }
[data-t3e-detach-ready] { box-shadow: inset 0 -2px var(--cx-accent, var(--primary)); }
.t3e-detach-ghost {
  position: fixed; left: 0; top: 0; width: 236px; height: 146px; z-index: 9999;
  pointer-events: none; border-radius: 14px; overflow: hidden;
  border: 1.5px solid color-mix(in srgb, var(--cx-accent, var(--primary)) 65%, transparent);
  background: color-mix(in srgb, var(--background) 96%, transparent);
  box-shadow: 0 18px 42px -10px rgba(0, 0, 0, 0.24), 0 0 0 1px rgba(0, 0, 0, 0.05);
  display: flex; flex-direction: column;
  animation: t3e-ghost-in 150ms cubic-bezier(0.22, 1, 0.36, 1) both;
  will-change: transform;
}
.dark .t3e-detach-ghost {
  background: color-mix(in srgb, var(--background) 95%, transparent);
  box-shadow: 0 18px 44px -8px rgba(0, 0, 0, 0.56), 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.t3e-detach-ghost-hdr {
  height: 30px; padding: 0 10px; display: flex; align-items: center; gap: 6px;
  border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 500;
  color: var(--foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.t3e-detach-ghost-body {
  flex: 1; display: flex; align-items: center; justify-content: center;
  font-size: 11.5px; color: var(--muted-foreground);
  background: repeating-linear-gradient(135deg, transparent 0 8px, color-mix(in srgb, var(--cx-accent, var(--primary)) 5%, transparent) 8px 16px);
}
[data-t3e-preview-drag]::before {
  content: ""; position: absolute; inset: 2px auto auto 50%; transform: translateX(-50%);
  width: 32px; height: 4px; border-radius: 4px;
  background: var(--popover); box-shadow: 0 0 0 1px rgb(0 0 0 / 25%); opacity: .8;
}
[data-t3e-preview-drag]:hover::before { opacity: 1; }
/* Isolate docked column stacking contexts so internal z-40 separators never pierce floating windows or expanded chat. */
[data-t3e-workspace] > [data-chat-column]:not([data-t3e-chat-floating="true"], [data-t3e-chat-expanded]) {
  position: relative; z-index: 1; isolation: isolate;
}
[data-t3e-workspace] > [data-preview-panel-mode="inline"] {
  position: relative; z-index: 2; isolation: isolate;
}
/* Toolbars now live directly in each pane's own flex header without a fixed overlay. */
[data-t3e-workspace] {
  --t3e-chat-header-padding-end: 12px;
  --t3e-workspace-tabbar-padding-end: 8px;
}
[data-t3e-workspace] > [data-chat-column] > [data-chat-header] > [data-t3e-chat-heading] {
  padding-inline-end: 0 !important;
}
[data-t3e-workspace] > [data-chat-column]:not([data-t3e-chat-floating="true"]) > [data-chat-header] {
  padding-inline-end: var(--t3e-chat-header-padding-end);
}
[data-t3e-workspace] > [data-preview-panel-mode="inline"] [data-right-panel-tabbar] {
  padding-inline-end: var(--t3e-workspace-tabbar-padding-end);
}
/* The panel owns the divider and the leftmost pane owns the outer radius. */
[data-t3e-workspace][data-t3e-swap="true"] > [data-chat-column] { order: 1; }
[data-t3e-workspace][data-t3e-swap="true"] > [data-preview-panel-mode="inline"][data-preview-panel-maximized="false"] {
  --t3e-workspace-panel-border-start: 0px;
  border-inline-start-width: 0 !important;
  border-inline-end: 1px solid var(--cx-line-soft, var(--border));
}
[data-t3e-workspace][data-t3e-swap="true"] > [data-preview-panel-mode="inline"] > .justify-end {
  justify-content: flex-start;
}
[data-t3e-workspace] > [data-preview-panel-mode="inline"] > [role="separator"] {
  inset-inline: -1px auto; width: 6px;
}
[data-t3e-workspace][data-t3e-swap="true"] > [data-preview-panel-mode="inline"] > [role="separator"] {
  inset-inline: auto -5px; width: 6px;
}
[data-t3e-workspace] > [data-preview-panel-mode="inline"] > [role="separator"] > span {
  left: 1px; right: auto; translate: -50% 0;
}
[data-t3e-workspace][data-t3e-swap="true"] > [data-preview-panel-mode="inline"] > [role="separator"] > span {
  left: auto; right: 5px; translate: 50% 0;
}
@media (any-pointer: coarse) {
  [data-t3e-workspace] > [data-preview-panel-mode="inline"] > [role="separator"] { width: 10px; inset-inline: -2px auto; }
  [data-t3e-workspace][data-t3e-swap="true"] > [data-preview-panel-mode="inline"] > [role="separator"] { width: 10px; inset-inline: auto -8px; }
}
@media (min-width: 768px) {
  [data-t3e-workspace][data-t3e-swap="true"]:has(> [data-preview-panel-mode="inline"]:not([data-workspace-unavailable])[data-preview-panel-maximized="false"])
    > [data-chat-column]:not([data-t3e-chat-floating="true"], [data-t3e-chat-expanded]) {
    --t3e-chat-corner: 0px;
    --t3e-chat-border-start: 0px;
    --t3e-chat-edge-shadow: none;
  }
  [data-t3e-workspace][data-t3e-swap="true"] > [data-preview-panel-mode="inline"]:not([data-workspace-unavailable])[data-preview-panel-maximized="false"],
  [data-t3e-workspace][data-t3e-swap="true"] > [data-preview-panel-mode="inline"]:not([data-workspace-unavailable])[data-preview-panel-maximized="false"] > .overflow-clip {
    border-top-left-radius: 14px;
  }
}
.t3e-layout-swap-btn svg {
  transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.t3e-layout-swap-btn[data-swapped="true"] svg {
  transform: scaleX(-1);
}`;

  function t3EnsureFloatStyles() {
    if (typeof document === "undefined" || !document.head) return;
    const id = "t3e-floating-panels-style";
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      if (typeof document.head.prepend === "function") document.head.prepend(el);
      else if (typeof document.head.insertBefore === "function") document.head.insertBefore(el, document.head.firstChild || null);
      else document.head.appendChild(el);
    }
    el.textContent = styles;
  }
  t3EnsureFloatStyles();

  const T3FloatContext = React.createContext(null);
  const T3FloatPositions = new Map();
  const T3FloatEdges = ["n", "s", "w", "e", "nw", "ne", "sw", "se"];
  const T3_CHAT_FLOAT_ID = "__t3e_main_chat__";

  function T3NavigateBrowser(input, createBrowser) {
    const url = resolveBrowserAddress
      ? resolveBrowserAddress(input, browserSearchTemplate(getBrowserSettings()))
      : standaloneBrowserAddress(input);
    return createBrowser(undefined, url);
  }

  function T3LayoutSwapButton() {
    const ctx = React.useContext(T3FloatContext);
    if (!ctx) return null;
    const title = ctx.labels.swapLayout;
    const btn = jsx("button", {
      type: "button",
      className: "t3e-layout-swap-btn",
      "data-t3e-swap-btn": "",
      "data-swapped": ctx.swapped ? "true" : "false",
      "aria-label": title,
      onPointerDown: (ev) => ev.stopPropagation(),
      onClick: (ev) => {
        ev.stopPropagation();
        ctx.toggleSwap();
      },
      children: jsx("svg", {
        "aria-hidden": true, viewBox: "0 0 24 24", width: 15, height: 15, fill: "none",
        stroke: "currentColor",
        children: jsx("path", {
          d: "M16 4l4 4-4 4M20 8H4M8 20l-4-4 4-4M4 16h16"
        })
      })
    });
    return jsxs(Tooltip, {
      children: [
        jsx(TooltipTrigger, { render: btn }),
        jsx(TooltipPopup, { side: "bottom", children: title })
      ]
    });
  }

  function T3ChatToolbar({ controls }) {
    const ctx = React.useContext(T3FloatContext);
    if (!ctx) return null;
    const minimize = ctx.chatFloat ? jsxs(Tooltip, {
      children: [
        jsx(TooltipTrigger, {
          render: jsx("button", {
            type: "button",
            className: "t3e-chat-float-btn",
            "aria-label": ctx.labels.minimizeChat,
            onPointerDown: (ev) => ev.stopPropagation(),
            onClick: (ev) => { ev.stopPropagation(); ctx.toggleChatMinimize(); },
            children: jsx("svg", {
              "aria-hidden": true, viewBox: "0 0 24 24", width: 15, height: 15, fill: "none",
              stroke: "currentColor",
              children: jsx("path", { d: "M5 12h14" })
            })
          })
        }),
        jsx(TooltipPopup, { side: "bottom", children: ctx.labels.minimizeChat })
      ]
    }) : null;
    return jsxs("div", {
      className: "t3e-chat-toolbar",
      "data-t3e-conversation-actions": "",
      children: [controls, minimize]
    });
  }

  function T3PanelToolbar({ fullscreen, sheet = false, maximize, toggle }) {
    const ctx = React.useContext(T3FloatContext);
    const showSwap = Boolean(ctx && !fullscreen && !sheet && !ctx.chatFloat);
    return jsxs(Fragment, {
      children: [
        fullscreen ? jsx("button", {
          type: "button",
          className: "t3e-main-chat-tab",
          "data-t3e-main-chat-tab": "",
          "aria-pressed": ctx?.chatSelected,
          onClick: ctx?.showMainChat,
          children: ctx?.labels?.pillIdle
        }) : null,
        jsxs("div", {
          className: "t3e-chat-toolbar",
          "data-t3e-panel-actions": "",
          children: [showSwap ? jsx(T3LayoutSwapButton, {}) : null, maximize, toggle]
        })
      ]
    });
  }

  function T3ChatColumnShell({ className, style, maximizedAway, workState, onMouseUp, children }) {
    const ctx = React.useContext(T3FloatContext);
    const prevWorkRef = React.useRef(workState);
    const [doneFlash, setDoneFlash] = React.useState(false);
    React.useEffect(() => {
      const was = prevWorkRef.current;
      prevWorkRef.current = workState;
      if (was === "working" && workState === "idle") {
        setDoneFlash(true);
        const timer = setTimeout(() => setDoneFlash(false), 4500);
        return () => clearTimeout(timer);
      }
      if (workState !== "idle") setDoneFlash(false);
    }, [workState]);
    const entry = ctx?.chatFloat?.entry;
    const colRef = React.useRef(null);
    const dragRef = React.useRef(null);
    const moveRafRef = React.useRef(null);
    const pillPosRef = React.useRef(null);
    const pillRef = React.useRef(null);
    const wasMinRef = React.useRef(false);
    const wasAtEndRef = React.useRef(true);
    const settlingRef = React.useRef(false);
    const chatMode = ctx?.fullscreen ? (ctx.chatSelected ? "expanded" : "floating") : "docked";
    const prevChatModeRef = React.useRef(chatMode);
    const [, setPillCommit] = React.useState(0);

    React.useEffect(() => () => {
      if (moveRafRef.current != null) cancelAnimationFrame(moveRafRef.current);
    }, []);

    React.useEffect(() => {
      const col = colRef.current;
      if (!col) return;
      const onScroll = (ev) => {
        const target = ev?.target?.classList?.contains?.("messages-timeline-scroll")
          ? ev.target
          : col.querySelector?.(".messages-timeline-scroll");
        if (!target || settlingRef.current || !target.clientHeight || col.hasAttribute("data-t3e-chat-minimized")) return;
        wasAtEndRef.current = target.scrollHeight - target.scrollTop - target.clientHeight <= 28;
      };
      col.addEventListener("scroll", onScroll, { capture: true, passive: true });
      return () => col.removeEventListener("scroll", onScroll, { capture: true });
    }, []);

    React.useLayoutEffect(() => {
      const prevMode = prevChatModeRef.current;
      prevChatModeRef.current = chatMode;
      const switchedFullscreen = (prevMode === "expanded" && chatMode === "floating")
        || (prevMode === "floating" && chatMode === "expanded");
      if (!switchedFullscreen || !wasAtEndRef.current) return;
      const col = colRef.current;
      const scroller = col?.querySelector?.(".messages-timeline-scroll");
      if (!col || !scroller) return;

      let aborted = false;
      let cleaned = false;
      let rafId = null;
      settlingRef.current = true;
      col.setAttribute("data-t3e-chat-settling", "true");

      const hasOwnScrollTo = Object.prototype.hasOwnProperty.call(scroller, "scrollTo");
      const prevOwnScrollTo = hasOwnScrollTo ? scroller.scrollTo : null;
      const protoScrollTo = Object.getPrototypeOf(scroller)?.scrollTo || scroller.scrollTo;
      if (typeof protoScrollTo === "function") {
        scroller.scrollTo = function (...args) {
          if (args[0] && typeof args[0] === "object") {
            return protoScrollTo.call(this, { ...args[0], behavior: "instant" });
          }
          return protoScrollTo.apply(this, args);
        };
      }

      const pinBottom = () => {
        if (aborted) return;
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (Math.abs(scroller.scrollTop - maxTop) > 1) scroller.scrollTop = maxTop;
      };
      pinBottom();

      let lastW = scroller.clientWidth;
      let lastH = scroller.clientHeight;
      let lastScrollH = scroller.scrollHeight;
      let stableFrames = 0;

      const ro = typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            stableFrames = 0;
            pinBottom();
          })
        : null;
      if (ro) {
        ro.observe(scroller);
        if (scroller.firstElementChild) ro.observe(scroller.firstElementChild);
      }

      const onUserInput = () => {
        aborted = true;
        cleanup();
      };
      scroller.addEventListener("wheel", onUserInput, { passive: true, once: true });
      scroller.addEventListener("touchstart", onUserInput, { passive: true, once: true });
      scroller.addEventListener("pointerdown", onUserInput, { passive: true, once: true });

      let timer = null;
      function cleanup() {
        if (cleaned) return;
        cleaned = true;
        if (timer != null) clearTimeout(timer);
        if (rafId != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
        ro?.disconnect();
        scroller.removeEventListener("wheel", onUserInput);
        scroller.removeEventListener("touchstart", onUserInput);
        scroller.removeEventListener("pointerdown", onUserInput);
        if (typeof protoScrollTo === "function") {
          if (hasOwnScrollTo) scroller.scrollTo = prevOwnScrollTo;
          else delete scroller.scrollTo;
        }
        if (!aborted) pinBottom();
        col.removeAttribute("data-t3e-chat-settling");
        settlingRef.current = false;
      }

      timer = setTimeout(cleanup, 140);
      if (typeof requestAnimationFrame === "function") {
        const tick = () => {
          if (cleaned) return;
          pinBottom();
          const w = scroller.clientWidth;
          const h = scroller.clientHeight;
          const sh = scroller.scrollHeight;
          if (w === lastW && h === lastH && sh === lastScrollH) {
            stableFrames += 1;
            if (stableFrames >= 2) {
              cleanup();
              return;
            }
          } else {
            lastW = w;
            lastH = h;
            lastScrollH = sh;
            stableFrames = 0;
          }
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
      } else {
        cleanup();
      }
      return cleanup;
    }, [chatMode]);

    const clampChat = (f, dir = "", dx = 0, dy = 0) => {
      const b = ctx?.bounds || { width: 0, height: 0 };
      const next = workspaceFloatFrame(f, b, dir, dx, dy);
      if (b.width <= 0 || b.height <= 0) return next;
      const minW = Math.min(320, Math.max(0, b.width - 16));
      const minH = Math.min(280, Math.max(0, b.height - 16));
      let { x, y, width, height } = next;
      if (width < minW) {
        if (dir.includes("w")) x = Math.max(8, x - (minW - width));
        width = minW;
        if (x + width > b.width - 8) x = Math.max(8, b.width - 8 - width);
      }
      if (height < minH) {
        if (dir.includes("n")) y = Math.max(8, y - (minH - height));
        height = minH;
        if (y + height > b.height - 8) y = Math.max(8, b.height - 8 - height);
      }
      return { x, y, width, height };
    };

    const minimized = Boolean(entry && ctx.chatMinimized);
    const fullFrame = entry ? clampChat(entry.frame) : null;
    const pillFrame = entry ? chatPillFrame(fullFrame, ctx.bounds, pillPosRef.current) : null;
    const frame = entry ? (minimized ? pillFrame : fullFrame) : null;

    const applyDomFrame = (nextFrame) => {
      const el = colRef.current;
      if (!el || !nextFrame) return;
      const yOff = ctx?.deckTop || 0;
      el.style.left = nextFrame.x + "px";
      el.style.top = (yOff + nextFrame.y) + "px";
      el.style.width = nextFrame.width + "px";
      el.style.height = nextFrame.height + "px";
    };

    React.useLayoutEffect(() => {
      if (ctx?.chatSelected) return;
      const wasMin = wasMinRef.current;
      wasMinRef.current = minimized;
      if (minimized) {
        if (!wasMin) pillRef.current?.focus({ preventScroll: true });
        return;
      }
      if (entry && pillPosRef.current) {
        const origin = chatPillFrame(fullFrame, ctx.bounds);
        ctx.move(T3_CHAT_FLOAT_ID, clampChat({
          ...fullFrame,
          x: fullFrame.x + pillFrame.x - origin.x,
          y: fullFrame.y + pillFrame.y - origin.y
        }));
      }
      pillPosRef.current = null;
    }, [minimized, ctx?.chatSelected]);

    const expandFromPill = () => ctx.toggleChatMinimize();
    const start = (ev, direction) => {
      if (!entry || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      ctx.raise(T3_CHAT_FLOAT_ID);
      const base = minimized ? pillFrame : fullFrame;
      dragRef.current = { pointerId: ev.pointerId, direction, startX: ev.clientX, startY: ev.clientY, frame: base, minimized, latest: base, moved: false };
      ev.currentTarget.setPointerCapture?.(ev.pointerId);
    };

    const move = (ev) => {
      if (!dragRef.current || dragRef.current.pointerId !== ev.pointerId) return;
      const { direction, startX, startY, frame: base, minimized: wasMin } = dragRef.current;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragRef.current.moved && Math.hypot(dx, dy) < 4) return;
      dragRef.current.moved = true;
      const next = wasMin ? chatPillFrame(fullFrame, ctx.bounds, { x: base.x + dx, y: base.y + dy }) : clampChat(base, direction, dx, dy);
      dragRef.current.latest = next;
      if (moveRafRef.current == null) {
        moveRafRef.current = requestAnimationFrame(() => {
          moveRafRef.current = null;
          const latest = dragRef.current?.latest;
          if (latest) applyDomFrame(latest);
        });
      }
    };

    const finish = (ev) => {
      if (!dragRef.current || dragRef.current.pointerId !== ev.pointerId) return;
      if (moveRafRef.current != null) {
        cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = null;
      }
      const drag = dragRef.current;
      dragRef.current = null;

      if (ev.type !== "pointerup") {
        if (drag.moved) applyDomFrame(frame);
        return;
      }
      const b = ctx.bounds;
      if (drag.minimized) {
        if (!drag.moved) {
          expandFromPill();
          return;
        }
        const snapped = workspaceSnapFrame(drag.latest, b);
        applyDomFrame(snapped);
        pillPosRef.current = { x: snapped.x, y: snapped.y };
        setPillCommit((n) => n + 1);
        return;
      }
      if (!drag.moved) return;
      pillPosRef.current = null;
      const committed = drag.direction === "move" ? workspaceSnapFrame(drag.latest, b) : drag.latest;
      applyDomFrame(committed);
      ctx.move(T3_CHAT_FLOAT_ID, committed);
    };

    const toggleByDoubleClick = (ev) => {
      if (!entry || minimized) return;
      const el = ev.target instanceof Element ? ev.target : null;
      if (!el || !el.closest("[data-chat-header]")) return;
      if (el.closest("button, a, input, textarea, [role='button'], [data-slot='button']")) return;
      ctx.toggleChatMinimize();
    };

    const labels = ctx?.labels || {};
    const pillState = doneFlash ? "done" : (workState || "idle");
    const pillLabel = pillState === "working" ? labels.pillWorking
      : pillState === "approval" ? labels.pillApproval
      : pillState === "input" ? labels.pillInput
      : pillState === "done" ? labels.pillDone
      : labels.pillIdle;

    const pointerHandlers = { onPointerMove: move, onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish };
    const startHeaderDrag = (ev) => {
      if (!entry || ev.button !== 0) return;
      const el = ev.target instanceof Element ? ev.target : null;
      if (!el || !el.closest("[data-chat-header]")) return;
      if (el.closest("button, a, input, textarea, [role='button'], [data-slot='button']")) return;
      start(ev, "move");
    };

    const topOffset = entry ? (ctx.deckTop || 0) : 0;
    const zIndex = entry ? 31 + Math.min(ctx.chatFloat.level, 8) * 2 : undefined;

    return jsxs("div", {
      ref: colRef,
      className: entry ? "flex min-h-0 min-w-0 flex-col overflow-x-hidden t3e-floating-window t3e-chat-floating-window" : className,
      "data-chat-column-maximized-away": maximizedAway && !entry && !ctx?.chatSelected ? "true" : "false",
      "data-t3e-chat-expanded": ctx?.chatSelected ? "" : undefined,
      "data-chat-column": true,
      "data-t3e-chat-floating": entry ? "true" : undefined,
      "data-t3e-chat-minimized": minimized ? "true" : undefined,
      inert: maximizedAway && !entry && !ctx?.chatSelected,
      onMouseUp,
      onDoubleClick: entry ? toggleByDoubleClick : undefined,
      onPointerDownCapture: entry ? () => ctx.raise(T3_CHAT_FLOAT_ID) : undefined,
      ...(entry ? { onPointerDown: startHeaderDrag, ...pointerHandlers } : {}),
      style: entry && frame ? {
        ...style,
        left: frame.x, top: topOffset + frame.y, width: frame.width, height: frame.height, zIndex,
        ...(minimized && fullFrame ? { "--t3e-chat-w": fullFrame.width + "px", "--t3e-chat-h": fullFrame.height + "px" } : {})
      } : style,
      children: [
        entry ? jsx("div", {
          className: "t3e-chat-float-grip",
          title: labels.dragChat,
          "aria-hidden": true,
          onPointerDown: (ev) => start(ev, "move"),
          ...pointerHandlers,
          children: jsx("svg", {
            viewBox: "0 0 12 16", width: 10, height: 14, fill: "currentColor",
            children: [3, 8, 13].flatMap((cy) => [3.5, 8.5].map((cx) => jsx("circle", { cx, cy, r: 1.1 }, cx + "-" + cy)))
          })
        }) : null,
        children,
        entry && !minimized ? T3FloatEdges.map((edge) => jsx("div", {
          className: "t3e-floating-handle", "data-edge": edge, "data-corner": edge.length === 2 ? "" : undefined,
          "aria-hidden": true, onPointerDown: (ev) => start(ev, edge), ...pointerHandlers
        }, edge)) : null,
        minimized ? jsxs("div", {
          className: "t3e-chat-pill",
          ref: pillRef,
          role: "button",
          tabIndex: 0,
          "data-state": pillState,
          title: labels.expandChat,
          "aria-label": labels.expandChat,
          onPointerDown: (ev) => start(ev, "move"),
          onKeyDown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); expandFromPill(); } },
          ...pointerHandlers,
          children: [
            jsx("span", { className: "t3e-chat-pill-dot", "aria-hidden": true }),
            jsx("span", { className: "t3e-chat-pill-label", children: pillLabel }),
            jsx("span", { className: "t3e-chat-pill-hint", children: labels.expandHint })
          ]
        }) : null
      ]
    });
  }

  function T3FloatButton({ label, onClick, undock, tab = false }) {
    return jsx(tab ? "button" : Button, {
      type: "button", ...(!tab ? { variant: "ghost", size: "icon-xs" } : {}), title: label, "aria-label": label, onClick,
      className: tab ? "t3e-tab-float-btn" : undefined,
      onPointerDown: tab ? (event) => event.stopPropagation() : undefined,
      style: { WebkitAppRegion: "no-drag" },
      children: jsx("svg", {
        "aria-hidden": true, viewBox: "0 0 24 24", width: 15, height: 15, fill: "none",
        stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
        children: jsx("path", {
          d: undock ? "M4 8v12h16v-8M10 4h10v10M20 4l-9 9" : "M4 5h16v14H4zM14 5v14M10 12h7m-3-3 3 3-3 3"
        })
      })
    });
  }

  function T3TabFloatAction({ surface, onToggle }) {
    const ctx = React.useContext(T3FloatContext);
    if (!ctx) return null;
    const floating = ctx.windowsById.has(surface.id);
    return jsx(T3FloatButton, {
      label: (floating ? ctx.labels.dock : ctx.labels.float) + " · " + ctx.title(surface),
      undock: !floating, tab: true,
      onClick: (event) => { event.stopPropagation(); onToggle(surface); }
    });
  }

  function t3ShallowObjEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      const k = ka[i];
      if (a[k] !== b[k]) return false;
    }
    return true;
  }

  function t3PanelPropsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.surface === b.surface &&
      a.activeSurfaceId === b.activeSurfaceId &&
      a.threadRef === b.threadRef &&
      a.environmentId === b.environmentId &&
      a.visible === b.visible &&
      a.composerDraftTarget === b.composerDraftTarget &&
      a.keybindings === b.keybindings &&
      a.configuredPreviewUrls === b.configuredPreviewUrls &&
      a.workspaceMutationId === b.workspaceMutationId &&
      a.getShortcutContext === b.getShortcutContext &&
      a.onSendAnnotation === b.onSendAnnotation &&
      a.onCloseSurface === b.onCloseSurface &&
      a.issuesSupported === b.issuesSupported &&
      t3ShallowObjEqual(a.sideChatParentPanel, b.sideChatParentPanel) &&
      t3ShallowObjEqual(a.terminal, b.terminal) &&
      t3ShallowObjEqual(a.pullRequest, b.pullRequest) &&
      t3ShallowObjEqual(a.files, b.files);
  }

  function t3SurfaceMountPropsEqual(prev, next) {
    if (prev === next) return true;
    return prev.surface === next.surface &&
      prev.slot === next.slot &&
      prev.parkingSlot === next.parkingSlot &&
      prev.visible === next.visible &&
      prev.floating === next.floating &&
      prev.onFloatNew === next.onFloatNew &&
      t3PanelPropsEqual(prev.panelProps, next.panelProps);
  }

  function t3LayoutControlsSignatureEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const ap = a.props || {};
    const bp = b.props || {};
    if (Boolean(ap.fullscreen) !== Boolean(bp.fullscreen)) return false;
    if (Boolean(ap.sheet) !== Boolean(bp.sheet)) return false;
    if (Boolean(ap.maximize?.props?.maximized) !== Boolean(bp.maximize?.props?.maximized)) return false;
    return t3ShallowObjEqual(ap.toggle?.props, bp.toggle?.props);
  }

  function T3WorkspacePanelShell(props) {
    const ctx = React.useContext(T3FloatContext);
    const { raise, dockedSurfaces, dockedActiveSurface, chatSelected, showWorkspace } = ctx;
    const propsRef = React.useRef(props);
    propsRef.current = props;
    const layoutControlsRef = React.useRef(props.layoutControls);
    if (!t3LayoutControlsSignatureEqual(layoutControlsRef.current, props.layoutControls)) {
      layoutControlsRef.current = props.layoutControls;
    }
    const stableLayoutControls = layoutControlsRef.current;
    const dockedChild = React.useMemo(() => jsx(T3DockedSurface, {}), []);
    const stableChildren = props.children?.type === T3DockedSurface
      ? dockedChild
      : props.children;

    const toggle = stableCallback((surface, point) => ctx.toggleFloat(surface.id, point));
    const menuLabel = stableCallback((surface) => ctx.windowsById.has(surface.id)
      ? ctx.labels.dock : ctx.labels.float);
    const closeDockedOthers = stableCallback((surface) => {
      for (const s of dockedSurfaces) {
        if (s.id !== surface.id) propsRef.current.onCloseSurface(s);
      }
    });
    const closeDockedAll = stableCallback(() => {
      for (const s of dockedSurfaces) propsRef.current.onCloseSurface(s);
    });
    const closePanel = stableCallback(() => {
      if (ctx.panelProps?.threadRef) rightPanelStore.getState().close(ctx.panelProps.threadRef);
    });
    const onActivate = stableCallback((surface) => {
      showWorkspace();
      propsRef.current.onActivate(surface);
      raise(surface.id);
    });

    const onCloseSheet = stableCallback((...a) => propsRef.current.onCloseSheet?.(...a));
    const onCloseSurface = stableCallback((...a) => propsRef.current.onCloseSurface?.(...a));
    const onOpenInMainView = stableCallback((...a) => propsRef.current.onOpenInMainView?.(...a));
    const onRenameDevice = stableCallback((...a) => propsRef.current.onRenameDevice?.(...a));
    const onCloseSurfacesToRight = stableCallback((...a) => propsRef.current.onCloseSurfacesToRight?.(...a));
    const onMoveSurface = stableCallback((...a) => propsRef.current.onMoveSurface?.(...a));
    const onCopyFilePath = stableCallback((...a) => propsRef.current.onCopyFilePath?.(...a));
    const onAddBrowser = stableCallback((...a) => propsRef.current.onAddBrowser?.(...a));
    const onAddBrowserInProfile = stableCallback((...a) => propsRef.current.onAddBrowserInProfile?.(...a));
    const onDuplicateBrowser = stableCallback((...a) => propsRef.current.onDuplicateBrowser?.(...a));
    const onAddTerminal = stableCallback((...a) => propsRef.current.onAddTerminal?.(...a));
    const onAddDiff = stableCallback((...a) => propsRef.current.onAddDiff?.(...a));
    const onAddFiles = stableCallback((...a) => propsRef.current.onAddFiles?.(...a));
    const onAddPullRequest = stableCallback((...a) => propsRef.current.onAddPullRequest?.(...a));
    const onAddPullRequests = stableCallback((...a) => propsRef.current.onAddPullRequests?.(...a));
    const onAddDevice = stableCallback((...a) => propsRef.current.onAddDevice?.(...a));
    const onAddSideChat = stableCallback((...a) => propsRef.current.onAddSideChat?.(...a));
    const getShortcutContext = stableCallback((...a) => propsRef.current.getShortcutContext?.(...a));
    const enhancerFloatTab = stableCallback((surface, point) => toggle(surface, point));
    const enhancerTabControl = stableCallback((surface) => jsx(T3TabFloatAction, { surface, onToggle: toggle }));
    const hasSideChat = Boolean(props.onAddSideChat);
    const dividerSlot = null;

    return React.useMemo(() => jsx(PanelShell, {
      sheet: propsRef.current.sheet,
      workspaceLayoutElement: propsRef.current.workspaceLayoutElement,
      widthStorageKey: propsRef.current.widthStorageKey,
      sheetAnimationDurationMs: propsRef.current.sheetAnimationDurationMs,
      onCloseSheet,
      open: propsRef.current.open,
      keybindings: propsRef.current.keybindings,
      getShortcutContext,
      maximized: propsRef.current.maximized,
      layoutControls: stableLayoutControls,
      environmentId: propsRef.current.environmentId,
      pendingSurfaceIds: propsRef.current.pendingSurfaceIds,
      previewSessions: propsRef.current.previewSessions,
      desktopByTabId: propsRef.current.desktopByTabId,
      previewRuntimeTabId: propsRef.current.previewRuntimeTabId,
      terminalLabelsById: propsRef.current.terminalLabelsById,
      onCloseSurface,
      onOpenInMainView: propsRef.current.onOpenInMainView ? onOpenInMainView : void 0,
      onRenameDevice,
      onCloseSurfacesToRight,
      onMoveSurface,
      onCopyFilePath,
      onAddBrowser,
      onAddBrowserInProfile,
      onDuplicateBrowser,
      onAddTerminal,
      onAddDiff,
      onAddFiles,
      onAddPullRequest,
      onAddPullRequests,
      onAddDevice,
      onAddSideChat: hasSideChat ? onAddSideChat : void 0,
      browserAvailable: propsRef.current.browserAvailable,
      terminalAvailable: propsRef.current.terminalAvailable,
      diffAvailable: propsRef.current.diffAvailable,
      filesAvailable: propsRef.current.filesAvailable,
      pullRequestAvailable: propsRef.current.pullRequestAvailable,
      pullRequestsAvailable: propsRef.current.pullRequestsAvailable,
      deviceAvailable: propsRef.current.deviceAvailable,
      sideChatAvailable: propsRef.current.sideChatAvailable,
      sideChatDisabledReason: propsRef.current.sideChatDisabledReason,
      enhancerResizeEdge: ctx.swapped ? "right" : "left",
      enhancerDividerSlot: dividerSlot,
      surfaces: dockedSurfaces,
      activeSurfaceId: dockedActiveSurface?.id ?? null,
      onCloseOtherSurfaces: closeDockedOthers,
      onCloseAllSurfaces: closeDockedAll,
      enhancerClosePanel: closePanel,
      enhancerChatSelected: chatSelected,
      enhancerShowWorkspace: showWorkspace,
      enhancerFloatTab,
      enhancerFloatMenuLabel: menuLabel,
      enhancerTabControl,
      onActivate,
      children: stableChildren
    }), [
      props.sheet,
      props.workspaceLayoutElement,
      props.widthStorageKey,
      props.sheetAnimationDurationMs,
      props.open,
      props.keybindings,
      props.maximized,
      stableLayoutControls,
      props.environmentId,
      props.pendingSurfaceIds,
      props.previewSessions,
      props.desktopByTabId,
      props.previewRuntimeTabId,
      props.terminalLabelsById,
      hasSideChat,
      props.browserAvailable,
      props.terminalAvailable,
      props.diffAvailable,
      props.filesAvailable,
      props.pullRequestAvailable,
      props.pullRequestsAvailable,
      props.deviceAvailable,
      props.sideChatAvailable,
      props.sideChatDisabledReason,
      stableChildren,
      dividerSlot,
      ctx.swapped,
      dockedSurfaces,
      dockedActiveSurface,
      chatSelected,
      showWorkspace
    ]);
  }

  function T3DockedSurface() {
    const ctx = React.useContext(T3FloatContext);
    if (!ctx) return null;
    return jsx("div", {
      className: "t3e-floating-dock", ref: ctx.setDockSlot
    });
  }

  const t3PanelMovesPending = new WeakSet();

  function t3MovePanelHost(host, slot) {
    if (host.parentElement === slot) return;
    if (host.isConnected && slot.isConnected && typeof slot.moveBefore === "function") {
      slot.moveBefore(host, null);
    } else {
      slot.appendChild(host);
    }
    if (typeof requestAnimationFrame !== "function") {
      t3SyncNativePreview(host);
      return;
    }
    if (t3PanelMovesPending.has(host)) return;
    t3PanelMovesPending.add(host);
    requestAnimationFrame(() => {
      t3PanelMovesPending.delete(host);
      if (host.isConnected) t3SyncNativePreview(host);
    });
  }

  function t3SyncNativePreview(container) {
    for (const viewport of container.querySelectorAll("[data-browser-surface-slot]")) {
      viewport.dispatchEvent(new Event(PREVIEW_LAYOUT_EVENT));
    }
  }

  const T3SurfaceMount = React.memo(function T3SurfaceMount({ surface, panelProps, slot, parkingSlot, visible, floating, onFloatNew }) {
    const [hostEl] = React.useState(() => {
      const element = document.createElement("div");
      element.className = "t3e-floating-content";
      return element;
    });
    React.useLayoutEffect(() => () => hostEl.remove(), [hostEl]);
    React.useLayoutEffect(() => {
      if (slot) t3MovePanelHost(hostEl, slot);
      else if (parkingSlot?.current) t3MovePanelHost(hostEl, parkingSlot.current);
    }, [hostEl, slot, parkingSlot]);

    const effectivePanelProps = React.useMemo(() => {
      if (!floating || surface.kind !== "terminal" || !panelProps?.terminal) return panelProps;
      const ref = panelProps.threadRef;
      const base = panelProps.terminal;
      return {
        ...panelProps,
        terminal: {
          ...base,
          onSplitTerminal: () => base.onSplitTerminal("horizontal", surface.id),
          onSplitTerminalVertical: () => base.onSplitTerminal("vertical", surface.id),
          onActiveTerminalChange: (tid) => {
            if (ref) {
              rightPanelStore.getState().activateTerminal(ref, surface.id, tid);
              focusTerminal(ref, tid);
            }
          },
          onNewTerminal: () => {
            if (!ref) { base.onNewTerminal(); return; }
            const before = getPanelState(rightPanelStore.getState().byThreadKey, ref);
            const wasOpen = before.isOpen;
            const prevIds = new Set(before.surfaces.map((s) => s.id));
            base.onNewTerminal();
            if (!wasOpen) {
              const after = getPanelState(rightPanelStore.getState().byThreadKey, ref);
              const added = after.surfaces.find((s) => !prevIds.has(s.id));
              if (added) onFloatNew?.(added.id);
            }
          }
        }
      };
    }, [floating, surface.id, surface.kind, panelProps, onFloatNew]);

    const renderProps = floating
      ? { ...effectivePanelProps, activeSurfaceId: surface.id, surface, visible }
      : { ...effectivePanelProps, surface, visible };
    return createPortal(
      jsx(T3FloatContext.Provider, { value: null, children: jsx(SurfaceContent, renderProps) }),
      hostEl
    );
  }, t3SurfaceMountPropsEqual);

  function T3FloatingSurface({ surface, entry, level, title }) {
    const ctx = React.useContext(T3FloatContext);
    const { setFloatSlot } = ctx;
    const setSlot = React.useCallback((slot) => setFloatSlot(surface.id, slot), [setFloatSlot, surface.id]);
    const [dragging, setDragging] = React.useState(false);
    const [docking, setDocking] = React.useState(false);
    const gesture = React.useRef(null);
    const dragRafRef = React.useRef(null);
    const windowRef = React.useRef(null);
    const dockTimerRef = React.useRef(null);
    const dockRef = React.useRef(ctx.dock);
    dockRef.current = ctx.dock;

    React.useEffect(() => () => {
      if (dockTimerRef.current) clearTimeout(dockTimerRef.current);
      if (dragRafRef.current != null) cancelAnimationFrame(dragRafRef.current);
    }, []);

    const handleDock = () => {
      if (docking) return;
      if (surface.kind === "preview") {
        dockRef.current(surface.id);
        return;
      }
      setDocking(true);
      dockTimerRef.current = setTimeout(() => {
        dockTimerRef.current = null;
        dockRef.current(surface.id);
      }, 140);
    };

    const frame = workspaceFloatFrame(entry.frame, ctx.bounds);
    const windowZ = 31 + Math.min(level, 8) * 2;
    const isPreview = surface.kind === "preview";

    const applyDomFrame = (nextFrame) => {
      const el = windowRef.current;
      if (!el || !nextFrame) return;
      el.style.left = nextFrame.x + "px";
      el.style.top = nextFrame.y + "px";
      el.style.width = nextFrame.width + "px";
      el.style.height = nextFrame.height + "px";
      if (!isPreview) {
        if (nextFrame.width < 320 || nextFrame.height < 230) el.setAttribute("data-compact", "");
        else el.removeAttribute("data-compact");
      } else {
        t3SyncNativePreview(el);
      }
    };

    React.useLayoutEffect(() => {
      if (windowRef.current) t3SyncNativePreview(windowRef.current);
    }, [frame.x, frame.y, frame.width, frame.height, windowZ]);

    const raiseWindow = (React.useEffectEvent || stableCallback)(() => ctx.raise(surface.id));
    React.useEffect(() => {
      const element = windowRef.current;
      if (!element) return;
      const raise = () => raiseWindow();
      element.addEventListener("pointerdown", raise, true);
      element.addEventListener("focusin", raise);
      return () => {
        element.removeEventListener("pointerdown", raise, true);
        element.removeEventListener("focusin", raise);
      };
    }, []);

    const start = (event, direction) => {
      if (gesture.current || !event.isPrimary || event.button !== 0 || event.target.closest?.("button, input, textarea, select, a, [role='button']")) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { direction, frame, latest: frame, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      setDragging(true);
      event.preventDefault();
    };

    const startPreviewBarDrag = (event) => {
      if (!event.target.closest?.("[data-surface-subheader]")) return;
      start(event, "move");
    };

    const move = (event) => {
      const drag = gesture.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const nextFrame = workspaceFloatFrame(
        drag.frame, ctx.bounds, drag.direction, event.clientX - drag.x, event.clientY - drag.y
      );
      drag.moved = drag.moved || nextFrame.x !== drag.latest.x || nextFrame.y !== drag.latest.y || nextFrame.width !== drag.latest.width || nextFrame.height !== drag.latest.height;
      drag.latest = nextFrame;
      if (dragRafRef.current == null) {
        dragRafRef.current = requestAnimationFrame(() => {
          dragRafRef.current = null;
          const cur = gesture.current?.latest;
          if (cur) applyDomFrame(cur);
        });
      }
    };

    const finish = (event) => {
      const drag = gesture.current;
      if (drag?.pointerId !== event.pointerId) return;
      if (dragRafRef.current != null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      gesture.current = null;
      setDragging(false);
      const committed = drag.direction === "move" ? workspaceSnapFrame(drag.latest, ctx.bounds) : drag.latest;
      applyDomFrame(committed);
      if (drag.moved || committed.x !== drag.frame.x || committed.y !== drag.frame.y || committed.width !== drag.frame.width || committed.height !== drag.frame.height) {
        ctx.move(surface.id, committed);
      }
    };

    const pointerHandlers = {
      onPointerMove: move, onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish
    };

    return jsxs("section", {
      className: "t3e-floating-window", "aria-label": title, tabIndex: -1, ref: windowRef,
      "data-t3e-floating-id": surface.id,
      "data-t3e-kind": surface.kind,
      "data-compact": !isPreview && (frame.width < 320 || frame.height < 230) ? "" : undefined,
      "data-dragging": dragging ? "" : undefined,
      "data-docking": docking ? "" : undefined,
      onAnimationEnd: () => { if (windowRef.current) t3SyncNativePreview(windowRef.current); },
      style: { left: frame.x, top: frame.y, width: frame.width, height: frame.height, zIndex: windowZ },
      children: [
        jsxs("header", {
          className: "t3e-floating-header",
          onPointerDown: (event) => start(event, "move"),
          ...pointerHandlers,
          children: [
            isPreview ? jsx("span", {
              className: "t3e-floating-header-grip",
              "aria-hidden": true,
              children: jsx("svg", {
                viewBox: "0 0 16 16", width: 12, height: 12, fill: "currentColor",
                children: jsx("path", { d: "M6 3.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm6.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0ZM6 8a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm6.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0ZM6 12.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm6.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z" })
              })
            }) : null,
            jsx("span", { className: "t3e-floating-title", title, children: title }),
            jsxs("div", {
              className: "t3e-floating-header-actions",
              children: [
                jsx(T3FloatButton, { label: ctx.labels.dock, onClick: handleDock }),
                jsx(Button, {
                  type: "button", variant: "ghost", size: "icon-xs", title: ctx.labels.close,
                  "aria-label": ctx.labels.close, onClick: () => ctx.panelProps.onCloseSurface(surface),
                  children: jsx(SafeCloseIcon, { "aria-hidden": true })
                })
              ]
            })
          ]
        }),
        jsx("div", {
          className: "t3e-floating-body", ref: setSlot,
          ...(isPreview ? { onPointerDown: startPreviewBarDrag, ...pointerHandlers } : {})
        }),
        T3FloatEdges.map((edge) => jsx("div", {
          className: "t3e-floating-handle", "data-edge": edge, "data-corner": edge.length === 2 ? "" : undefined,
          "aria-hidden": true, onPointerDown: (event) => start(event, edge), ...pointerHandlers
        }, edge))
      ]
    });
  }

  function T3FloatingDeck() {
    const ctx = React.useContext(T3FloatContext);
    return jsxs("div", {
      className: "t3e-floating-deck", ref: ctx.observeDeck,
      children: [
        jsx("div", { hidden: true, ref: ctx.parkingSlot }),
        ctx.floatingSurfaces.map((surface) =>
          jsx(T3FloatingSurface, {
            surface, ...ctx.windowsById.get(surface.id),
            title: ctx.title(surface)
          }, surface.id)
        )
      ]
    });
  }

  function T3WorkspacePanels({ threadKey, panelProps, surfaces, activeSurface, terminalLabels, fullscreen, children }) {
    const [windows, setWindows] = React.useState(() => T3FloatPositions.get(threadKey) ?? []);
    const [bounds, setBounds] = React.useState({ width: 0, height: 0 });
    const [swapped, setSwapped] = React.useState(() => {
      try {
        return localStorage.getItem("t3e-layout-swap") === "true";
      } catch {
        return false;
      }
    });
    const [dockSlot, setDockSlot] = React.useState(null);
    const [floatSlots, setFloatSlots] = React.useState(() => new Map());
    const deckRef = React.useRef(null);
    const parkingSlot = React.useRef(null);
    const i18n = (typeof useI18n === "function" ? useI18n() : null) || ((k) => k);
    const isZh = t3WpIsZh();
    const labels = React.useMemo(() => isZh
      ? { float: "在应用内浮动", dock: "放回侧边栏", close: "关闭标签页", focus: "在浮窗中查看", dragChat: "拖动主对话浮窗", minimizeChat: "收起为迷你胶囊", expandChat: "展开主对话", expandHint: "展开", pillWorking: "回复中…", pillApproval: "等待确认", pillInput: "等待你的回答", pillDone: "已完成", pillIdle: "主对话", swapLayout: "主对话与工作区互换位置 (Alt+S)" }
      : { float: "Float in workspace", dock: "Dock in panel", close: "Close tab", focus: "Focus floating tab", dragChat: "Drag chat window", minimizeChat: "Minimize to pill", expandChat: "Expand main chat", expandHint: "Expand", pillWorking: "Replying…", pillApproval: "Awaiting approval", pillInput: "Awaiting your answer", pillDone: "Done", pillIdle: "Main chat", swapLayout: "Swap chat and workspace (Alt+S)" }, [isZh]);

    const toggleSwap = React.useCallback(() => {
      setSwapped((prev) => !prev);
    }, []);

    React.useLayoutEffect(() => {
      try {
        localStorage.setItem("t3e-layout-swap", String(swapped));
      } catch {}
      window.dispatchEvent(new Event("resize"));
    }, [swapped]);

    React.useEffect(() => {
      const onKeyDown = (ev) => {
        if (ev.defaultPrevented || ev.repeat || ev.isComposing || ev.getModifierState?.("AltGraph")) return;
        if (ev.altKey && (ev.code === "KeyS" || ev.key === "s" || ev.key === "S") && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
          const el = ev.target instanceof Element ? ev.target : null;
          if (el?.closest("input, textarea, select, [contenteditable], .xterm, [role='dialog']")) return;
          ev.preventDefault();
          ev.stopPropagation();
          toggleSwap();
        }
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [toggleSwap]);

    const [deckTop, setDeckTop] = React.useState(0);
    const [chatMinimized, setChatMinimized] = React.useState(false);
    const [mainChatTab, setMainChatTab] = React.useState(false);
    const chatSelected = fullscreen && mainChatTab;
    const showMainChat = React.useCallback(() => setMainChatTab(true), []);
    const showWorkspace = React.useCallback(() => setMainChatTab(false), []);
    React.useLayoutEffect(showWorkspace, [fullscreen, activeSurface?.id, showWorkspace]);

    const toolDiffRequest = diffPanelStore((state) => {
      const ref = panelProps?.threadRef;
      const selection = ref && state.byThreadKey[threadRefKey(ref)];
      return selection?.kind === "tool-call" ? selection.revealRequestId : undefined;
    });
    const lastToolDiffRequest = React.useRef(toolDiffRequest);
    const lastChatFrame = React.useRef(null);

    const setFloatSlot = React.useCallback((id, slot) => {
      setFloatSlots((old) => {
        if ((old.get(id) ?? null) === slot) return old;
        const next = new Map(old);
        if (slot) next.set(id, slot);
        else next.delete(id);
        return next;
      });
    }, []);

    const observeDeck = React.useCallback((el) => {
      if (!el) return;
      deckRef.current = el;
      const measure = () => {
        setDeckTop((old) => old === el.offsetTop ? old : el.offsetTop);
        setBounds((old) => {
          const { clientWidth: width, clientHeight: height } = el;
          return old.width === width && old.height === height ? old : { width, height };
        });
      };
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      measure();
      return () => { observer.disconnect(); deckRef.current = null; };
    }, []);

    const livePanelState = typeof rightPanelStore === "function" && typeof getPanelState === "function"
      ? rightPanelStore((state) => (panelProps?.threadRef ? getPanelState(state.byThreadKey, panelProps.threadRef) : null))
      : null;
    const liveSurfaces = Array.isArray(livePanelState?.surfaces) ? livePanelState.surfaces : surfaces;
    const liveActiveSurface = Array.isArray(livePanelState?.surfaces)
      ? (livePanelState.surfaces.find((s) => s.id === livePanelState.activeSurfaceId) ?? null)
      : activeSurface;

    React.useEffect(() => {
      const openIds = new Set(liveSurfaces.map((surface) => surface.id));
      setWindows((old) => old.every((entry) => entry.id === T3_CHAT_FLOAT_ID || openIds.has(entry.id)) ? old : old.filter((entry) => entry.id === T3_CHAT_FLOAT_ID || openIds.has(entry.id)));
    }, [liveSurfaces]);

    React.useEffect(() => {
      T3FloatPositions.delete(threadKey);
      const persisted = windows.filter((entry) => entry.id !== T3_CHAT_FLOAT_ID);
      if (persisted.length) T3FloatPositions.set(threadKey, persisted);
      if (T3FloatPositions.size > 16) T3FloatPositions.delete(T3FloatPositions.keys().next().value);
    }, [threadKey, windows]);

    const raise = React.useCallback((id, focus = false) => {
      setWindows((old) => {
        const entry = old.find((item) => item.id === id);
        return !entry || old.at(-1) === entry ? old : [...old.filter((item) => item.id !== id), entry];
      });
      if (focus) deckRef.current?.querySelector('[data-t3e-floating-id="' + CSS.escape(id) + '"]')?.focus();
    }, []);

    const activeId = liveActiveSurface?.id;
    const raiseSelected = (React.useEffectEvent || stableCallback)(raise);
    React.useEffect(() => { if (activeId) raiseSelected(activeId); }, [activeId]);

    const windowsById = React.useMemo(() => new Map(windows.map((entry, index) => [entry.id, { entry, level: index + 1 }])), [windows]);
    const { dockedSurfaces, floatingSurfaces } = React.useMemo(() => {
      const dockedSurfaces = [];
      const floatingSurfaces = [];
      for (const surface of liveSurfaces) {
        (windowsById.has(surface.id) ? floatingSurfaces : dockedSurfaces).push(surface);
      }
      return { dockedSurfaces, floatingSurfaces };
    }, [liveSurfaces, windowsById]);
    const dockedActiveSurface = liveActiveSurface && !windowsById.has(liveActiveSurface.id) ? liveActiveSurface : dockedSurfaces[0] ?? null;
    const dockedCount = dockedSurfaces.length;
    const floatingCount = floatingSurfaces.length;
    const previousPlacement = React.useRef({ dockedCount, floatingCount });
    React.useLayoutEffect(() => {
      const prev = previousPlacement.current;
      previousPlacement.current = { dockedCount, floatingCount };
      if (!fullscreen && dockedCount === 0 && floatingCount > 0 &&
          (prev.dockedCount > 0 || floatingCount > prev.floatingCount) && panelProps?.threadRef) {
        rightPanelStore.getState().close(panelProps.threadRef);
      }
    }, [dockedCount, floatingCount, panelProps?.threadRef, fullscreen]);

    const miniPlayer = miniPlayerStore((state) => getMiniPlayer(state.byThreadKey, panelProps?.threadRef));
    const chatPlacement = windowsById.get(T3_CHAT_FLOAT_ID);
    const chatWindow = chatPlacement?.entry;
    const chatFloat = fullscreen && !chatSelected ? chatPlacement : null;

    React.useLayoutEffect(() => {
      if (fullscreen && !chatWindow && bounds.width && bounds.height) {
        const frame = lastChatFrame.current
          ? workspaceFloatFrame(lastChatFrame.current, bounds)
          : defaultChatFloatFrame(bounds);
        setWindows((old) => [...old.filter((entry) => entry.id !== T3_CHAT_FLOAT_ID), { id: T3_CHAT_FLOAT_ID, frame }]);
      } else if (!fullscreen && chatWindow) {
        lastChatFrame.current = chatWindow.frame;
        setChatMinimized(false);
        setWindows((old) => old.filter((entry) => entry.id !== T3_CHAT_FLOAT_ID));
      }
    }, [fullscreen, chatWindow, bounds]);

    const stateRefs = React.useRef({});
    stateRefs.current = {
      windowsById, bounds, fullscreen, chatSelected, surfaces: liveSurfaces, activeSurface: liveActiveSurface, dockedActiveSurface,
      dockSlot, floatSlots, panelProps, terminalLabels, i18n
    };
    const stablePanelProps = React.useMemo(() => ({
      get threadRef() { return stateRefs.current.panelProps?.threadRef; },
      onCloseSurface: (surface) => stateRefs.current.panelProps?.onCloseSurface?.(surface)
    }), []);

    const getTitle = React.useCallback((surface) => {
      const { terminalLabels: tLabels, i18n: tr } = stateRefs.current;
      switch (surface.kind) {
        case "file": return surface.relativePath;
        case "files": return tr("Files");
        case "diff": return tr("Changes");
        case "terminal": return tLabels.get(surface.activeTerminalId) ?? tr("Terminal");
        case "preview": return tr("Browser");
        case "device": return surface.title ?? tr("Device");
        case "pull-request": return "#" + surface.number;
        case "pull-requests": return tr("Pull requests");
        case "issue": return surface.key;
        case "thread": return tr("Subagent");
        case "linked-thread": return surface.title?.trim() || surface.label || tr("Thread");
        case "side-chat": return tr("Side chat");
        default: return surface.kind;
      }
    }, []);

    const floatSurface = React.useCallback((id, point) => {
      const {
        dockedActiveSurface: dockedActive, dockSlot: curDockSlot, panelProps: curPanelProps,
        windowsById: placements, surfaces: curSurfaces, fullscreen: curFullscreen,
        activeSurface: curActiveSurface, bounds: curBounds, chatSelected: curChatSelected
      } = stateRefs.current;
      if (placements.has(id)) {
        raise(id);
        return;
      }
      const dockedHost = dockedActive?.id === id ? curDockSlot?.firstElementChild : null;
      if (dockedHost && parkingSlot.current) t3MovePanelHost(dockedHost, parkingSlot.current);
      const ref = curPanelProps?.threadRef;
      if (ref && getMiniPlayer(miniPlayerStore.getState().byThreadKey, ref)?.source?.kind === "browser") {
        miniPlayerStore.getState().close(ref);
      }
      const store = rightPanelStore.getState();
      const latestSurfaces = ref ? getPanelState(store.byThreadKey, ref).surfaces : curSurfaces;
      if (ref && curActiveSurface?.id === id) {
        const nextDocked = latestSurfaces.find((surface) => surface.id !== id && !placements.has(surface.id));
        if (nextDocked) store.activateSurface(ref, nextDocked.id);
      }
      const preview = latestSurfaces.some((surface) => surface.id === id && surface.kind === "preview");
      const workspace = deckRef.current?.getBoundingClientRect();
      const effectiveBounds = curBounds.width && curBounds.height
        ? curBounds
        : (deckRef.current ? { width: deckRef.current.clientWidth, height: deckRef.current.clientHeight } : curBounds);
      const position = point && workspace ? { x: point.x - workspace.left, y: point.y - workspace.top } : null;
      const savedPreviewFrame = preview ? loadSavedPreviewFrame() : null;
      setWindows((old) => {
        if (old.some((entry) => entry.id === id)) return old;
        const occupied = old.filter((entry) => entry.id !== T3_CHAT_FLOAT_ID || (curFullscreen && !curChatSelected))
          .map((entry) => workspaceFloatFrame(entry.frame, effectiveBounds));
        const nextFrame = placeSurfaceFloat(effectiveBounds, occupied, preview, position, savedPreviewFrame);
        if (preview && position) saveSavedPreviewFrame(nextFrame, effectiveBounds);
        return [...old, { id, frame: nextFrame }];
      });
    }, [raise]);

    const dockSurface = React.useCallback((id) => {
      const { floatSlots: curFloatSlots, panelProps: curPanelProps } = stateRefs.current;
      const hostEl = curFloatSlots.get(id)?.firstElementChild;
      if (hostEl && parkingSlot.current) t3MovePanelHost(hostEl, parkingSlot.current);
      showWorkspace();
      const store = rightPanelStore.getState();
      if (curPanelProps?.threadRef && getPanelState(store.byThreadKey, curPanelProps.threadRef).surfaces.some((s) => s.id === id)) {
        store.revealSurface(curPanelProps.threadRef, id);
      }
      setWindows((old) => old.filter((entry) => entry.id !== id));
    }, [showWorkspace]);

    const moveWindow = React.useCallback((id, frame) => {
      const { surfaces: curSurfaces, bounds: curBounds } = stateRefs.current;
      if (curSurfaces.some((surface) => surface.id === id && surface.kind === "preview")) {
        const effectiveBounds = curBounds.width && curBounds.height
          ? curBounds
          : (deckRef.current ? { width: deckRef.current.clientWidth, height: deckRef.current.clientHeight } : curBounds);
        saveSavedPreviewFrame(frame, effectiveBounds);
      }
      setWindows((old) => old.map((entry) => entry.id === id ? { id, frame } : entry));
    }, []);

    const toggleChatMinimize = React.useCallback(() => {
      setChatMinimized((value) => !value);
    }, []);

    const toggleFloat = React.useCallback((id, point) => {
      if (!point && stateRefs.current.windowsById.has(id)) dockSurface(id);
      else floatSurface(id, point);
    }, [dockSurface, floatSurface]);

    const ctx = React.useMemo(() => ({
      windowsById, floatingSurfaces, labels, bounds, deckTop, fullscreen, chatFloat, chatMinimized, chatSelected, showMainChat, showWorkspace, dockedSurfaces, dockedActiveSurface, observeDeck, setDockSlot, setFloatSlot, parkingSlot, panelProps: stablePanelProps, raise, deckRef, swapped, toggleSwap, isZh,
      title: getTitle,
      dock: dockSurface,
      move: moveWindow,
      toggleChatMinimize,
      toggleFloat
    }), [windowsById, floatingSurfaces, labels, bounds, deckTop, fullscreen, chatFloat, chatMinimized, chatSelected, showMainChat, showWorkspace, dockedSurfaces, dockedActiveSurface, observeDeck, setDockSlot, setFloatSlot, stablePanelProps, raise, swapped, toggleSwap, isZh, getTitle, dockSurface, moveWindow, toggleChatMinimize, toggleFloat]);

    const revealToolDiff = (React.useEffectEvent || stableCallback)(() => {
      showWorkspace();
      const diff = liveSurfaces.find((surface) => surface.kind === "diff");
      if (diff && windowsById.has(diff.id)) dockSurface(diff.id);
    });

    React.useLayoutEffect(() => {
      if (toolDiffRequest && toolDiffRequest !== lastToolDiffRequest.current) revealToolDiff();
      lastToolDiffRequest.current = toolDiffRequest;
    }, [toolDiffRequest]);

    const adoptMiniBrowser = (React.useEffectEvent || stableCallback)((tabId) => {
      const ref = panelProps?.threadRef;
      if (!ref || !tabId) return;
      miniPlayerStore.getState().close(ref);
      const store = rightPanelStore.getState();
      const cur = getPanelState(store.byThreadKey, ref);
      let target = cur.surfaces.find((s) => s.kind === "preview" && s.resourceId === tabId);
      if (!target) {
        const wasOpen = cur.isOpen;
        store.openBrowser(ref, tabId);
        const after = getPanelState(rightPanelStore.getState().byThreadKey, ref);
        target = after.surfaces.find((s) => s.kind === "preview" && s.resourceId === tabId);
        if (!wasOpen) rightPanelStore.getState().close(ref);
      }
      if (target) floatSurface(target.id);
    });

    React.useLayoutEffect(() => {
      if (miniPlayer?.source?.kind === "browser" && miniPlayer.source.tabId) {
        adoptMiniBrowser(miniPlayer.source.tabId);
      }
    }, [miniPlayer]);

    const mountedList = dockedActiveSurface ? [dockedActiveSurface, ...floatingSurfaces] : floatingSurfaces;
    return jsxs(T3FloatContext.Provider, {
      value: ctx,
      children: [
        React.cloneElement(children, { "data-t3e-swap": swapped ? "true" : undefined, "data-t3e-main-chat-active": chatSelected ? "" : undefined }),
        mountedList.map((surface) => {
          const floating = windowsById.has(surface.id);
          const slot = floating ? floatSlots.get(surface.id) : dockSlot;
          return jsx(T3SurfaceMount, {
            surface, panelProps, slot, parkingSlot, floating, onFloatNew: floatSurface, visible: floating || (!chatSelected && panelProps.visible && dockedSurfaces.length > 0 && Boolean(dockSlot))
          }, surface.id);
        })
      ]
    });
  }

  return {
    T3_CHAT_FLOAT_ID,
    T3FloatContext,
    T3LayoutSwapButton,
    T3DividerSwapButton: T3LayoutSwapButton,
    T3ChatToolbar,
    T3PanelToolbar,
    T3ChatColumnShell,
    T3FloatButton,
    T3TabFloatAction,
    t3ShallowObjEqual,
    t3PanelPropsEqual,
    t3SurfaceMountPropsEqual,
    T3WorkspacePanelShell,
    T3DockedSurface,
    t3PanelMovesPending,
    t3MovePanelHost,
    t3SyncNativePreview,
    T3SurfaceMount,
    T3FloatingSurface,
    T3FloatingDeck,
    T3WorkspacePanels,
    T3NavigateBrowser,
  };
}

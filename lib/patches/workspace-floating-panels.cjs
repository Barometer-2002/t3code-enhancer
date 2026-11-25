"use strict";

const assert = require("node:assert/strict");

const ID = "workspace-floating-panels";
const MARKER = "T3_WORKSPACE_FLOATING_PANELS_V23";
const LEGACY_MARKERS = ["T3_WORKSPACE_FLOATING_PANELS_V1", "T3_WORKSPACE_FLOATING_PANELS_V2", "T3_WORKSPACE_FLOATING_PANELS_V3", "T3_WORKSPACE_FLOATING_PANELS_V4", "T3_WORKSPACE_FLOATING_PANELS_V5", "T3_WORKSPACE_FLOATING_PANELS_V6", "T3_WORKSPACE_FLOATING_PANELS_V7", "T3_WORKSPACE_FLOATING_PANELS_V8", "T3_WORKSPACE_FLOATING_PANELS_V9", "T3_WORKSPACE_FLOATING_PANELS_V10", "T3_WORKSPACE_FLOATING_PANELS_V11", "T3_WORKSPACE_FLOATING_PANELS_V12", "T3_WORKSPACE_FLOATING_PANELS_V13", "T3_WORKSPACE_FLOATING_PANELS_V14", "T3_WORKSPACE_FLOATING_PANELS_V15", "T3_WORKSPACE_FLOATING_PANELS_V16", "T3_WORKSPACE_FLOATING_PANELS_V17", "T3_WORKSPACE_FLOATING_PANELS_V18", "T3_WORKSPACE_FLOATING_PANELS_V19", "T3_WORKSPACE_FLOATING_PANELS_V20", "T3_WORKSPACE_FLOATING_PANELS_V21", "T3_WORKSPACE_FLOATING_PANELS_V22"];
const PREVIEW_LAYOUT_EVENT = "t3e-preview-layout";
const TARGET_REGEX = /^apps\/server\/dist\/client\/assets\/ThreadRouteView-[\w-]+\.js$/;
const ORIGINAL_HASH = "d54743d08ba7971a22d5dc50a422f1974e3db92b1c277b3e72645fbe2e5b74ce";
const TARGET_SPEC = {
  pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
  preferredRegex: TARGET_REGEX,
  includes: ["data-chat-column-maximized-away", "widthStorageKey", "openPreview:e.openPreview,threadRef:e.threadRef"],
};

function t3BrowserLayoutMode(element, fitSourceContent) {
  if (fitSourceContent) return true;
  return element.closest?.(".t3e-floating-window")?.getAttribute("data-t3e-kind") === "preview" ? "responsive" : false;
}

function tabDroppedOutside(bar, startY, endY) {
  return Math.abs(endY - startY) >= 24 && (endY < bar.top - 16 || endY > bar.bottom + 16);
}

function workspaceFloatFrame(frame, bounds, direction = "", dx = 0, dy = 0) {
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

function workspaceSnapFrame(frame, bounds, threshold = 18) {
  const margin = 8;
  const { width, height } = frame;
  let { x, y } = frame;
  if (x - margin <= threshold) x = margin;
  else if (bounds.width - margin - (x + width) <= threshold) x = Math.max(margin, bounds.width - margin - width);
  if (y - margin <= threshold) y = margin;
  else if (bounds.height - margin - (y + height) <= threshold) y = Math.max(margin, bounds.height - margin - height);
  return { x, y, width, height };
}

function defaultChatFloatFrame(bounds) {
  const width = Math.min(432, Math.max(360, Math.round(bounds.width * 0.36)));
  const height = Math.min(580, Math.max(400, Math.round(bounds.height * 0.68)));
  return workspaceFloatFrame({ x: bounds.width - width - 16, y: bounds.height - height - 16, width, height }, bounds);
}

function chatPillFrame(frame, bounds, position) {
  const width = Math.min(232, Math.max(0, bounds.width - 16));
  const height = Math.min(38, Math.max(0, bounds.height - 16));
  const x = position?.x ?? frame.x + frame.width - width;
  const y = position?.y ?? frame.y + frame.height - height;
  return workspaceFloatFrame({ x, y, width, height }, bounds);
}

function placeSurfaceFloat(bounds, occupied, preview, point) {
  const width = Math.min(preview ? 640 : 540, Math.round(bounds.width * 0.68));
  const height = Math.min(preview ? 440 : 420, Math.round(bounds.height * 0.72));
  const at = (x, y) => workspaceFloatFrame({ x, y, width, height }, bounds);
  if (point) return at(point.x - Math.round(width * 0.35), point.y - 16);

  const preferred = at(bounds.width - width - 16, 16);
  const xs = [preferred.x, 16];
  const ys = [preferred.y, bounds.height - height - 16];
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
  flex: 0 0 34px; display: flex; align-items: center; gap: 4px;
  padding-inline: 12px 6px; border-bottom: 1px solid var(--border);
  touch-action: none; user-select: none; cursor: grab;
  transition: flex-basis 180ms cubic-bezier(0.22, 1, 0.36, 1), border-color 160ms ease;
}
.t3e-floating-header:active, [data-t3e-preview-drag]:active { cursor: grabbing; }
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
/* 浏览器浮窗融合瘦身：去掉冗余 34px 标题行，把拖拽手柄与放回/关闭按钮融入 40px 地址栏 */
.t3e-floating-window[data-t3e-kind="preview"] {
  border-radius: 14px 14px 6px 6px;
}
.t3e-floating-window[data-t3e-kind="preview"] .t3e-floating-body {
  border-radius: 13px 13px 5px 5px;
}
.t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader] {
  display: flex !important;
  height: 40px !important;
  min-height: 40px !important;
  padding-inline-start: 28px !important;
  padding-inline-end: 92px !important;
  border-radius: 13px 13px 0 0 !important;
  cursor: grab;
  user-select: none;
}
.t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader]:active {
  cursor: grabbing;
}
.t3e-floating-window[data-t3e-kind="preview"] [data-surface-subheader] input {
  cursor: text;
  user-select: text;
}
.t3e-floating-preview-grip {
  position: absolute; top: 0; left: 0; width: 28px; height: 40px; z-index: 3;
  display: flex; align-items: center; justify-content: center;
  color: var(--muted-foreground); opacity: 0.65;
  touch-action: none; user-select: none; cursor: grab;
  transition: opacity 140ms ease, color 140ms ease;
}
.t3e-floating-preview-grip:hover { opacity: 1; color: var(--foreground); }
.t3e-floating-preview-grip:active { cursor: grabbing; }
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
  background: var(--cx-accent-soft, color-mix(in srgb, var(--cx-accent, var(--primary)) 12%, transparent)) !important;
  color: var(--cx-accent, var(--primary)) !important;
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
.t3e-floating-preview-actions {
  position: absolute; top: 0; right: 0; height: 40px; z-index: 3;
  display: flex; align-items: center; gap: 2px; padding-inline: 8px 8px;
  touch-action: none; user-select: none;
}
.t3e-floating-preview-actions::before {
  content: ""; position: absolute; left: 2px; top: 11px; bottom: 11px; width: 1px;
  background: var(--border); pointer-events: none;
}
.t3e-floating-window[data-dragging] .t3e-floating-body { pointer-events: none; }
.t3e-floating-window [data-thread-terminal-drawer] aside { width: 132px !important; min-width: 132px !important; }
.t3e-floating-handle { position: absolute; z-index: 2; touch-action: none; }
.t3e-floating-handle[data-edge=n] { inset: -5px 8px auto; height: 9px; cursor: ns-resize; }
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
  inset-inline: -5px auto; width: 10px;
}
[data-t3e-workspace][data-t3e-swap="true"] > [data-preview-panel-mode="inline"] > [role="separator"] {
  inset-inline: auto -5px;
}
[data-t3e-workspace] > [data-preview-panel-mode="inline"] > [role="separator"] > span {
  left: 50%; right: auto; translate: -50% 0;
}
@media (any-pointer: coarse) {
  [data-t3e-workspace] > [data-preview-panel-mode="inline"] > [role="separator"] { width: 16px; inset-inline-start: -9px; }
  [data-t3e-workspace][data-t3e-swap="true"] > [data-preview-panel-mode="inline"] > [role="separator"] { inset-inline: auto -9px; }
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
.t3e-divider-swap-btn {
  --t3e-swap-tx: -50%;
  position: absolute; top: 50%; left: -0.5px; z-index: 45;
  transform: translate(var(--t3e-swap-tx), -50%) scale(0.92);
  opacity: 0; pointer-events: none;
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 34px; padding: 0; border-radius: 9999px;
  border: 1px solid rgba(0, 0, 0, 0.10);
  background: var(--cx-surface, var(--background));
  color: var(--cx-ink-3, var(--muted-foreground));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04);
  cursor: pointer; -webkit-app-region: no-drag;
  transition: opacity 150ms ease, transform 150ms cubic-bezier(0.22, 1, 0.36, 1), background-color 140ms ease, color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
}
.dark .t3e-divider-swap-btn {
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.38), 0 1px 2px rgba(0, 0, 0, 0.24);
}
[data-preview-panel-mode="inline"] > [role="separator"]:hover:not(:active) ~ .t3e-divider-swap-btn,
.t3e-divider-swap-btn:hover,
.t3e-divider-swap-btn:focus-visible {
  opacity: 1; pointer-events: auto;
  transform: translate(var(--t3e-swap-tx), -50%) scale(1);
}
.t3e-divider-swap-btn:hover {
  background: var(--cx-card, var(--muted));
  color: var(--cx-ink-1, var(--foreground));
  border-color: rgba(0, 0, 0, 0.18);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.06);
  transform: translate(var(--t3e-swap-tx), -50%) scale(1.03);
  outline: none;
}
.dark .t3e-divider-swap-btn:hover {
  background: var(--cx-chip, var(--accent));
  border-color: rgba(255, 255, 255, 0.22);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.48), 0 1px 3px rgba(0, 0, 0, 0.28);
}
.t3e-divider-swap-btn:active {
  transform: translate(var(--t3e-swap-tx), -50%) scale(0.97);
}
.t3e-divider-swap-btn:focus-visible {
  background: var(--cx-surface, var(--background));
  color: var(--cx-ink-1, var(--foreground));
  border-color: var(--cx-accent-border, var(--ring));
  box-shadow: 0 0 0 2px var(--cx-accent-soft, rgba(37, 99, 235, 0.22)), 0 4px 12px rgba(0, 0, 0, 0.10);
  outline: none;
}
.t3e-divider-swap-btn[aria-pressed="true"] {
  color: var(--cx-ink-2, var(--foreground));
}
[data-t3e-workspace][data-t3e-swap="true"] > [data-preview-panel-mode="inline"] > .t3e-divider-swap-btn {
  --t3e-swap-tx: 50%;
  left: auto; right: -0.5px;
}
@media (hover: none) {
  .t3e-divider-swap-btn {
    opacity: 0.92; pointer-events: auto;
    transform: translate(var(--t3e-swap-tx), -50%) scale(1);
  }
}
.t3e-divider-swap-btn svg {
  width: 12px; height: 12px; flex: none;
  stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round;
}`;

function injectedCode() {
  return `
/* ${MARKER} */
${workspaceFloatFrame.toString()}
${workspaceSnapFrame.toString()}
${defaultChatFloatFrame.toString()}
${chatPillFrame.toString()}
${placeSurfaceFloat.toString()}
${t3BrowserLayoutMode.toString()}
(function t3EnsureFloatStyles() {
  if (typeof document === "undefined" || !document.head) return;
  const id = "t3e-floating-panels-style";
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = ${JSON.stringify(styles)};
})();
const T3FloatContext = Z.createContext(null);
const T3FloatPositions = new Map();
const T3FloatEdges = ["n", "s", "w", "e", "nw", "ne", "sw", "se"];
const T3_CHAT_FLOAT_ID = "__t3e_main_chat__";

function T3NavigateBrowser(input, createBrowser) {
  const url = T3ResolveBrowserAddress(input, T3BrowserSearchTemplate(T3GetBrowserSettings()));
  return createBrowser(undefined, url);
}

function T3DividerSwapButton() {
  const ctx = Z.useContext(T3FloatContext);
  if (!ctx) return null;
  const title = ctx.labels.swapLayout;
  const btn = (0,$.jsx)("button", {
    type: "button",
    className: "t3e-divider-swap-btn",
    "aria-label": title,
    "aria-pressed": ctx.swapped,
    onPointerDown: (ev) => ev.stopPropagation(),
    onClick: (ev) => {
      ev.stopPropagation();
      ctx.toggleSwap();
    },
    children: (0,$.jsx)("svg", {
      "aria-hidden": true, viewBox: "0 0 16 16", width: 12, height: 12, fill: "none",
      stroke: "currentColor",
      children: (0,$.jsx)("path", {
        d: "M3.5 5.5h9M10.25 3.25 12.5 5.5l-2.25 2.25M12.5 10.5h-9M5.75 8.25 3.5 10.5l2.25 2.25"
      })
    })
  });
  return (0,$.jsxs)(fr, {
    children: [
      (0,$.jsx)(bt, { render: btn }),
      (0,$.jsx)(se, { side: ctx.swapped ? "left" : "right", children: title })
    ]
  });
}

function T3ChatToolbar({ controls }) {
  const ctx = Z.useContext(T3FloatContext);
  if (!ctx) return null;
  const minimize = ctx.chatFloat ? (0,$.jsx)(fr, {
    children: [
      (0,$.jsx)(bt, {
        render: (0,$.jsx)("button", {
          type: "button",
          className: "t3e-chat-float-btn",
          "aria-label": ctx.labels.minimizeChat,
          onPointerDown: (ev) => ev.stopPropagation(),
          onClick: (ev) => { ev.stopPropagation(); ctx.toggleChatMinimize(); },
          children: (0,$.jsx)("svg", {
            "aria-hidden": true, viewBox: "0 0 24 24", width: 15, height: 15, fill: "none",
            stroke: "currentColor",
            children: (0,$.jsx)("path", { d: "M5 12h14" })
          })
        })
      }),
      (0,$.jsx)(se, { side: "bottom", children: ctx.labels.minimizeChat })
    ]
  }) : null;
  return (0,$.jsxs)("div", {
    className: "t3e-chat-toolbar",
    "data-t3e-conversation-actions": "",
    children: [controls, minimize]
  });
}

function T3PanelToolbar({ fullscreen, maximize, toggle }) {
  const ctx = Z.useContext(T3FloatContext);
  return (0,$.jsxs)($.Fragment, {
    children: [
      fullscreen ? (0,$.jsx)("button", {
        type: "button",
        className: "t3e-main-chat-tab",
        "data-t3e-main-chat-tab": "",
        "aria-pressed": ctx.chatSelected,
        onClick: ctx.showMainChat,
        children: ctx.labels.pillIdle
      }) : null,
      (0,$.jsxs)("div", {
        className: "t3e-chat-toolbar",
        "data-t3e-panel-actions": "",
        children: [maximize, toggle]
      })
    ]
  });
}

function T3ChatColumnShell({ className, style, maximizedAway, workState, onMouseUp, children }) {
  const ctx = Z.useContext(T3FloatContext);
  const prevWorkRef = Z.useRef(workState);
  const [doneFlash, setDoneFlash] = Z.useState(false);
  Z.useEffect(() => {
    const was = prevWorkRef.current;
    prevWorkRef.current = workState;
    if (was === "working" && workState === "idle") {
      setDoneFlash(true);
      const timer = setTimeout(() => setDoneFlash(false), 4500);
      return () => clearTimeout(timer);
    }
    if (workState !== "idle") setDoneFlash(false);
  }, [workState]);
  const chatIndex = ctx ? ctx.windows.findIndex((entry) => entry.id === T3_CHAT_FLOAT_ID) : -1;
  const entry = chatIndex >= 0 ? ctx.chatFloat : null;
  const colRef = Z.useRef(null);
  const dragRef = Z.useRef(null);
  const moveRafRef = Z.useRef(null);
  const pillPosRef = Z.useRef(null);
  const pillRef = Z.useRef(null);
  const wasMinRef = Z.useRef(false);
  const wasAtEndRef = Z.useRef(true);
  const settlingRef = Z.useRef(false);
  const chatMode = ctx?.fullscreen ? (ctx.chatSelected ? "expanded" : "floating") : "docked";
  const prevChatModeRef = Z.useRef(chatMode);
  const [, setPillCommit] = Z.useState(0);
  Z.useEffect(() => () => {
    if (moveRafRef.current != null) cancelAnimationFrame(moveRafRef.current);
  }, []);
  Z.useEffect(() => {
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
  Z.useLayoutEffect(() => {
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
  Z.useLayoutEffect(() => {
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
  const pillState = doneFlash ? "done" : (workState || "idle");
  const pillLabel = pillState === "working" ? ctx.labels.pillWorking
    : pillState === "approval" ? ctx.labels.pillApproval
    : pillState === "input" ? ctx.labels.pillInput
    : pillState === "done" ? ctx.labels.pillDone
    : ctx.labels.pillIdle;
  const pointerHandlers = { onPointerMove: move, onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish };
  const startHeaderDrag = (ev) => {
    if (!entry || ev.button !== 0) return;
    const el = ev.target instanceof Element ? ev.target : null;
    if (!el || !el.closest("[data-chat-header]")) return;
    if (el.closest("button, a, input, textarea, [role='button'], [data-slot='button']")) return;
    start(ev, "move");
  };
  const topOffset = entry ? (ctx.deckTop || 0) : 0;
  const zIndex = entry ? 31 + Math.min(chatIndex + 1, 8) * 2 : undefined;
  return (0,$.jsxs)("div", {
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
      entry ? (0,$.jsx)("div", {
        className: "t3e-chat-float-grip",
        title: ctx.labels.dragChat,
        "aria-hidden": true,
        onPointerDown: (ev) => start(ev, "move"),
        ...pointerHandlers,
        children: (0,$.jsx)("svg", {
          viewBox: "0 0 12 16", width: 10, height: 14, fill: "currentColor",
          children: [3, 8, 13].flatMap((cy) => [3.5, 8.5].map((cx) => (0,$.jsx)("circle", { cx, cy, r: 1.1 }, cx + "-" + cy)))
        })
      }) : null,
      children,
      entry && !minimized ? T3FloatEdges.map((edge) => (0,$.jsx)("div", {
        className: "t3e-floating-handle", "data-edge": edge, "data-corner": edge.length === 2 ? "" : undefined,
        "aria-hidden": true, onPointerDown: (ev) => start(ev, edge), ...pointerHandlers
      }, edge)) : null,
      minimized ? (0,$.jsxs)("div", {
        className: "t3e-chat-pill",
        ref: pillRef,
        role: "button",
        tabIndex: 0,
        "data-state": pillState,
        title: ctx.labels.expandChat,
        "aria-label": ctx.labels.expandChat,
        onPointerDown: (ev) => start(ev, "move"),
        onKeyDown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); expandFromPill(); } },
        ...pointerHandlers,
        children: [
          (0,$.jsx)("span", { className: "t3e-chat-pill-dot", "aria-hidden": true }),
          (0,$.jsx)("span", { className: "t3e-chat-pill-label", children: pillLabel }),
          (0,$.jsx)("span", { className: "t3e-chat-pill-hint", children: ctx.labels.expandHint })
        ]
      }) : null
    ]
  });
}

function T3FloatButton({ label, onClick, undock, tab = false }) {
  return (0,$.jsx)(tab ? "button" : ot, {
    type: "button", ...(!tab ? { variant: "ghost", size: "icon-xs" } : {}), title: label, "aria-label": label, onClick,
    className: tab ? "t3e-tab-float-btn" : undefined,
    onPointerDown: tab ? (event) => event.stopPropagation() : undefined,
    style: { WebkitAppRegion: "no-drag" },
    children: (0,$.jsx)("svg", {
      "aria-hidden": true, viewBox: "0 0 24 24", width: 15, height: 15, fill: "none",
      stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
      children: (0,$.jsx)("path", {
        d: undock ? "M4 8v12h16v-8M10 4h10v10M20 4l-9 9" : "M4 5h16v14H4zM14 5v14M10 12h7m-3-3 3 3-3 3"
      })
    })
  });
}

function T3TabFloatAction({ surface, onToggle }) {
  const ctx = Z.useContext(T3FloatContext);
  if (!ctx) return null;
  const floating = ctx.windows.some((entry) => entry.id === surface.id);
  return (0,$.jsx)(T3FloatButton, {
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
  if (Boolean(ap.maximize?.props?.maximized) !== Boolean(bp.maximize?.props?.maximized)) return false;
  return t3ShallowObjEqual(ap.toggle?.props, bp.toggle?.props);
}

function T3WorkspacePanelShell(props) {
  const ctx = Z.useContext(T3FloatContext);
  const { raise, dockedSurfaces, dockedActiveSurface, chatSelected, showWorkspace } = ctx;
  const propsRef = Z.useRef(props);
  propsRef.current = props;
  const layoutControlsRef = Z.useRef(props.layoutControls);
  if (!t3LayoutControlsSignatureEqual(layoutControlsRef.current, props.layoutControls)) {
    layoutControlsRef.current = props.layoutControls;
  }
  const stableLayoutControls = layoutControlsRef.current;
  const dockedChild = Z.useMemo(() => (0,$.jsx)(T3DockedSurface, {}), []);
  const stableChildren = props.children?.type === T3DockedSurface
    ? dockedChild
    : props.children;
  const toggle = yp((surface, point) => {
    const floating = ctx.windows.some((entry) => entry.id === surface.id);
    if (point && floating) { ctx.raise(surface.id); return; }
    ctx.toggleFloat(surface.id, point);
  });
  const menuLabel = yp((surface) => ctx.windows.some((entry) => entry.id === surface.id)
    ? ctx.labels.dock : ctx.labels.float);
  const closeDockedOthers = yp((surface) => {
    for (const s of dockedSurfaces) {
      if (s.id !== surface.id) propsRef.current.onCloseSurface(s);
    }
  });
  const closeDockedAll = yp(() => {
    for (const s of dockedSurfaces) propsRef.current.onCloseSurface(s);
  });
  const closePanel = yp(() => {
    if (ctx.panelProps?.threadRef) tm.getState().close(ctx.panelProps.threadRef);
  });
  const onActivate = yp((surface) => {
    showWorkspace();
    propsRef.current.onActivate(surface);
    raise(surface.id);
  });
  const onCloseSheet = yp((...a) => propsRef.current.onCloseSheet?.(...a));
  const onCloseSurface = yp((...a) => propsRef.current.onCloseSurface?.(...a));
  const onRenameDevice = yp((...a) => propsRef.current.onRenameDevice?.(...a));
  const onCloseSurfacesToRight = yp((...a) => propsRef.current.onCloseSurfacesToRight?.(...a));
  const onMoveSurface = yp((...a) => propsRef.current.onMoveSurface?.(...a));
  const onCopyFilePath = yp((...a) => propsRef.current.onCopyFilePath?.(...a));
  const onAddBrowser = yp((...a) => propsRef.current.onAddBrowser?.(...a));
  const onAddBrowserInProfile = yp((...a) => propsRef.current.onAddBrowserInProfile?.(...a));
  const onDuplicateBrowser = yp((...a) => propsRef.current.onDuplicateBrowser?.(...a));
  const onAddTerminal = yp((...a) => propsRef.current.onAddTerminal?.(...a));
  const onAddDiff = yp((...a) => propsRef.current.onAddDiff?.(...a));
  const onAddFiles = yp((...a) => propsRef.current.onAddFiles?.(...a));
  const onAddPullRequest = yp((...a) => propsRef.current.onAddPullRequest?.(...a));
  const onAddPullRequests = yp((...a) => propsRef.current.onAddPullRequests?.(...a));
  const onAddDevice = yp((...a) => propsRef.current.onAddDevice?.(...a));
  const onAddSideChat = yp((...a) => propsRef.current.onAddSideChat?.(...a));
  const getShortcutContext = yp((...a) => propsRef.current.getShortcutContext?.(...a));
  const enhancerFloatTab = yp((surface, point) => toggle(surface, point));
  const enhancerTabControl = yp((surface) => (0,$.jsx)(T3TabFloatAction, { surface, onToggle: toggle }));
  const hasSideChat = Boolean(props.onAddSideChat);
  const showDividerSwap = Boolean(props.open && !props.sheet && !props.maximized && !ctx.chatFloat);
  const dividerSlot = Z.useMemo(() => (showDividerSwap ? (0,$.jsx)(T3DividerSwapButton, {}) : null), [showDividerSwap]);
  return Z.useMemo(() => (0,$.jsx)(oG, {
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
  const ctx = Z.useContext(T3FloatContext);
  if (!ctx) return null;
  return (0,$.jsx)("div", {
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
    viewport.dispatchEvent(new Event("${PREVIEW_LAYOUT_EVENT}"));
  }
}

const T3SurfaceMount = Z.memo(function T3SurfaceMount({ surface, panelProps, slot, parkingSlot, visible, floating, onFloatNew }) {
  // The portal owns one DOM host for this tab. Move the host to keep editor and terminal state.
  const [host] = Z.useState(() => {
    const element = document.createElement("div");
    element.className = "t3e-floating-content";
    return element;
  });
  Z.useLayoutEffect(() => () => host.remove(), [host]);
  Z.useLayoutEffect(() => {
    if (slot) t3MovePanelHost(host, slot);
    else if (parkingSlot?.current) t3MovePanelHost(host, parkingSlot.current);
  }, [host, slot, parkingSlot]);
  const effectivePanelProps = Z.useMemo(() => {
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
            tm.getState().activateTerminal(ref, surface.id, tid);
            $f(ref, tid);
          }
        },
        onNewTerminal: () => {
          if (!ref) { base.onNewTerminal(); return; }
          const before = em(tm.getState().byThreadKey, ref);
          const wasOpen = before.isOpen;
          const prevIds = new Set(before.surfaces.map((s) => s.id));
          base.onNewTerminal();
          if (!wasOpen) {
            const after = em(tm.getState().byThreadKey, ref);
            const added = after.surfaces.find((s) => !prevIds.has(s.id));
            if (added) onFloatNew?.(added.id);
          }
        }
      }
    };
  }, [floating, surface.id, surface.kind, panelProps, onFloatNew]);
  return aF.createPortal((0,$.jsx)(aN, { ...effectivePanelProps, surface, visible }), host);
}, t3SurfaceMountPropsEqual);

function T3FloatingSurface({ surface, entry, level, title }) {
  const ctx = Z.useContext(T3FloatContext);
  const { setFloatSlot } = ctx;
  const setSlot = Z.useCallback((slot) => setFloatSlot(surface.id, slot), [setFloatSlot, surface.id]);
  const [dragging, setDragging] = Z.useState(false);
  const [docking, setDocking] = Z.useState(false);
  const gesture = Z.useRef(null);
  const dragRafRef = Z.useRef(null);
  const windowRef = Z.useRef(null);
  const dockTimerRef = Z.useRef(null);
  const dockRef = Z.useRef(ctx.dock);
  dockRef.current = ctx.dock;
  Z.useEffect(() => () => {
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
  Z.useLayoutEffect(() => {
    if (windowRef.current) t3SyncNativePreview(windowRef.current);
  }, [frame.x, frame.y, frame.width, frame.height, windowZ]);
  const raiseWindow = Z.useEffectEvent(() => ctx.raise(surface.id));
  Z.useEffect(() => {
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
  return (0,$.jsxs)("section", {
    className: "t3e-floating-window", "aria-label": title, tabIndex: -1, ref: windowRef,
    "data-t3e-floating-id": surface.id,
    "data-t3e-kind": surface.kind,
    "data-compact": !isPreview && (frame.width < 320 || frame.height < 230) ? "" : undefined,
    "data-dragging": dragging ? "" : undefined,
    "data-docking": docking ? "" : undefined,
    onAnimationEnd: () => { if (windowRef.current) t3SyncNativePreview(windowRef.current); },
    style: { left: frame.x, top: frame.y, width: frame.width, height: frame.height, zIndex: windowZ },
    children: [
      isPreview
        ? (0,$.jsxs)($.Fragment, {
            children: [
              (0,$.jsx)("div", {
                className: "t3e-floating-preview-grip", title, "aria-label": title,
                onPointerDown: (event) => start(event, "move"), ...pointerHandlers,
                children: (0,$.jsx)("svg", {
                  "aria-hidden": true, viewBox: "0 0 16 16", width: 12, height: 12, fill: "currentColor",
                  children: (0,$.jsx)("path", { d: "M6 3.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm6.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0ZM6 8a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm6.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0ZM6 12.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm6.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z" })
                })
              }),
              (0,$.jsxs)("div", {
                className: "t3e-floating-preview-actions",
                children: [
                  (0,$.jsx)(T3FloatButton, { label: ctx.labels.dock, onClick: handleDock }),
                  (0,$.jsx)(ot, {
                    type: "button", variant: "ghost", size: "icon-xs", title: ctx.labels.close,
                    "aria-label": ctx.labels.close, onClick: () => ctx.panelProps.onCloseSurface(surface),
                    children: (0,$.jsx)(Wv, { "aria-hidden": true })
                  })
                ]
              })
            ]
          })
        : (0,$.jsxs)("header", {
            className: "t3e-floating-header", onPointerDown: (event) => start(event, "move"), ...pointerHandlers,
            children: [
              (0,$.jsx)("span", { className: "t3e-floating-title", title, children: title }),
              (0,$.jsx)(T3FloatButton, { label: ctx.labels.dock, onClick: handleDock }),
              (0,$.jsx)(ot, {
                type: "button", variant: "ghost", size: "icon-xs", title: ctx.labels.close,
                "aria-label": ctx.labels.close, onClick: () => ctx.panelProps.onCloseSurface(surface),
                children: (0,$.jsx)(Wv, { "aria-hidden": true })
              })
            ]
          }),
      (0,$.jsx)("div", {
        className: "t3e-floating-body", ref: setSlot,
        ...(isPreview ? { onPointerDown: startPreviewBarDrag, ...pointerHandlers } : {})
      }),
      T3FloatEdges.map((edge) => (0,$.jsx)("div", {
        className: "t3e-floating-handle", "data-edge": edge, "data-corner": edge.length === 2 ? "" : undefined,
        "aria-hidden": true, onPointerDown: (event) => start(event, edge), ...pointerHandlers
      }, edge))
    ]
  });
}

function T3FloatingDeck() {
  const ctx = Z.useContext(T3FloatContext);
  return (0,$.jsxs)("div", {
    className: "t3e-floating-deck", ref: ctx.observeDeck,
    children: [
      (0,$.jsx)("div", { hidden: true, ref: ctx.parkingSlot }),
      ctx.surfaces.map((surface) => {
        const index = ctx.windows.findIndex((entry) => entry.id === surface.id);
        if (index < 0) return null;
        return (0,$.jsx)(T3FloatingSurface, {
          surface, entry: ctx.windows[index], level: index + 1,
          title: ctx.title(surface)
        }, surface.id);
      })
    ]
  });
}

function T3WorkspacePanels({ threadKey, panelProps, surfaces, activeSurface, terminalLabels, fullscreen, children }) {
  const [windows, setWindows] = Z.useState(() => T3FloatPositions.get(threadKey) ?? []);
  const [bounds, setBounds] = Z.useState({ width: 0, height: 0 });
  const [swapped, setSwapped] = Z.useState(() => {
    try {
      return localStorage.getItem("t3e-layout-swap") === "true";
    } catch {
      return false;
    }
  });
  const [dockSlot, setDockSlot] = Z.useState(null);
  const [floatSlots, setFloatSlots] = Z.useState(() => new Map());
  const deckRef = Z.useRef(null);
  const parkingSlot = Z.useRef(null);
  const i18n = an();
  const isZh = typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || navigator?.language || "");
  const labels = Z.useMemo(() => isZh
    ? { float: "在应用内浮动", dock: "放回侧边栏", close: "关闭标签页", focus: "在浮窗中查看", dragChat: "拖动主对话浮窗", minimizeChat: "收起为迷你胶囊", expandChat: "展开主对话", expandHint: "展开", pillWorking: "回复中…", pillApproval: "等待确认", pillInput: "等待你的回答", pillDone: "已完成", pillIdle: "主对话", swapLayout: "主对话与工作区互换位置 (Alt+S)" }
    : { float: "Float in workspace", dock: "Dock in panel", close: "Close tab", focus: "Focus floating tab", dragChat: "Drag chat window", minimizeChat: "Minimize to pill", expandChat: "Expand main chat", expandHint: "Expand", pillWorking: "Replying…", pillApproval: "Awaiting approval", pillInput: "Awaiting your answer", pillDone: "Done", pillIdle: "Main chat", swapLayout: "Swap chat and workspace (Alt+S)" }, [isZh]);
  const toggleSwap = Z.useCallback(() => {
    setSwapped((prev) => !prev);
  }, []);
  Z.useLayoutEffect(() => {
    try {
      localStorage.setItem("t3e-layout-swap", String(swapped));
    } catch {}
    // The native browser surface needs fresh bounds after the columns move.
    window.dispatchEvent(new Event("resize"));
  }, [swapped]);
  Z.useEffect(() => {
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
  const [deckTop, setDeckTop] = Z.useState(0);
  const [chatMinimized, setChatMinimized] = Z.useState(false);
  const [mainChatTab, setMainChatTab] = Z.useState(false);
  const chatSelected = fullscreen && mainChatTab;
  const showMainChat = Z.useCallback(() => setMainChatTab(true), []);
  const showWorkspace = Z.useCallback(() => setMainChatTab(false), []);
  Z.useLayoutEffect(showWorkspace, [fullscreen, activeSurface?.id, showWorkspace]);
  const toolDiffRequest = t_((state) => {
    const ref = panelProps?.threadRef;
    const selection = ref && state.byThreadKey[Yr(ref)];
    return selection?.kind === "tool-call" ? selection.revealRequestId : undefined;
  });
  const lastToolDiffRequest = Z.useRef(toolDiffRequest);
  const lastChatFrame = Z.useRef(null);
  const setFloatSlot = Z.useCallback((id, slot) => {
    setFloatSlots((old) => {
      if ((old.get(id) ?? null) === slot) return old;
      const next = new Map(old);
      if (slot) next.set(id, slot);
      else next.delete(id);
      return next;
    });
  }, []);
  const observeDeck = Z.useCallback((el) => {
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
  Z.useEffect(() => {
    const openIds = new Set(surfaces.map((surface) => surface.id));
    setWindows((old) => old.every((entry) => entry.id === T3_CHAT_FLOAT_ID || openIds.has(entry.id)) ? old : old.filter((entry) => entry.id === T3_CHAT_FLOAT_ID || openIds.has(entry.id)));
  }, [surfaces]);
  Z.useEffect(() => {
    T3FloatPositions.delete(threadKey);
    const persisted = windows.filter((entry) => entry.id !== T3_CHAT_FLOAT_ID);
    if (persisted.length) T3FloatPositions.set(threadKey, persisted);
    if (T3FloatPositions.size > 16) T3FloatPositions.delete(T3FloatPositions.keys().next().value);
  }, [threadKey, windows]);
  const raise = Z.useCallback((id, focus = false) => {
    setWindows((old) => {
      const entry = old.find((item) => item.id === id);
      return !entry || old.at(-1) === entry ? old : [...old.filter((item) => item.id !== id), entry];
    });
    if (focus) deckRef.current?.querySelector('[data-t3e-floating-id="' + CSS.escape(id) + '"]')?.focus();
  }, []);
  const activeId = activeSurface?.id;
  const raiseSelected = Z.useEffectEvent(raise);
  Z.useEffect(() => { if (activeId) raiseSelected(activeId); }, [activeId]);
  const floatingIds = Z.useMemo(() => new Set(windows.map((entry) => entry.id)), [windows]);
  const dockedSurfaces = Z.useMemo(() => surfaces.filter((surface) => !floatingIds.has(surface.id)), [surfaces, floatingIds]);
  const dockedActiveSurface = Z.useMemo(
    () => (activeSurface && !floatingIds.has(activeSurface.id) ? activeSurface : (dockedSurfaces[0] ?? null)),
    [activeSurface, floatingIds, dockedSurfaces]
  );
  const floatingSurfaceCount = Z.useMemo(() => windows.filter((entry) => entry.id !== T3_CHAT_FLOAT_ID).length, [windows]);
  const prevDockedCountRef = Z.useRef(dockedSurfaces.length);
  Z.useEffect(() => {
    const prev = prevDockedCountRef.current;
    prevDockedCountRef.current = dockedSurfaces.length;
    if (!fullscreen && prev > 0 && dockedSurfaces.length === 0 && floatingSurfaceCount > 0 && panelProps?.threadRef) {
      tm.getState().close(panelProps.threadRef);
    }
  }, [dockedSurfaces.length, floatingSurfaceCount, panelProps?.threadRef, fullscreen]);
  const miniPlayer = o_((state) => c_(state.byThreadKey, panelProps?.threadRef));
  const chatWindow = Z.useMemo(() => windows.find((entry) => entry.id === T3_CHAT_FLOAT_ID), [windows]);
  const chatFloat = fullscreen && !chatSelected ? chatWindow : null;
  Z.useLayoutEffect(() => {
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
  const stateRefs = Z.useRef({});
  stateRefs.current = {
    windows, bounds, fullscreen, surfaces, activeSurface, dockedActiveSurface,
    dockSlot, floatSlots, panelProps, terminalLabels, i18n
  };
  const stablePanelProps = Z.useMemo(() => ({
    get threadRef() { return stateRefs.current.panelProps?.threadRef; },
    onCloseSurface: (surface) => stateRefs.current.panelProps?.onCloseSurface?.(surface)
  }), []);
  const getTitle = Z.useCallback((surface) => {
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
      case "side-chat": return tr("Side chat");
      default: return surface.kind;
    }
  }, []);
  const floatSurface = Z.useCallback((id, point) => {
    const {
      dockedActiveSurface: dockedActive, dockSlot: curDockSlot, panelProps: curPanelProps,
      windows: curWindows, surfaces: curSurfaces, fullscreen: curFullscreen,
      activeSurface: curActiveSurface, bounds: curBounds, chatSelected: curChatSelected
    } = stateRefs.current;
    // Park the docked host before closing/switching the right panel so native surfaces stay connected.
    const dockedHost = dockedActive?.id === id ? curDockSlot?.firstElementChild : null;
    if (dockedHost && parkingSlot.current) t3MovePanelHost(dockedHost, parkingSlot.current);
    if (curPanelProps?.threadRef && c_(o_.getState().byThreadKey, curPanelProps.threadRef)?.source?.kind === "browser") {
      o_.getState().close(curPanelProps.threadRef);
    }
    const store = tm.getState();
    const nextFloatingIds = new Set(curWindows.map((entry) => entry.id));
    nextFloatingIds.add(id);
    const latestSurfaces = curPanelProps?.threadRef ? em(store.byThreadKey, curPanelProps.threadRef).surfaces : curSurfaces;
    const remainingDocked = latestSurfaces.filter((surface) => !nextFloatingIds.has(surface.id));
    if (!remainingDocked.length && !curFullscreen) {
      store.close(curPanelProps.threadRef);
    } else if (remainingDocked.length && curActiveSurface?.id === id) {
      store.activateSurface(curPanelProps.threadRef, remainingDocked[0].id);
    }
    const preview = latestSurfaces.some((surface) => surface.id === id && surface.kind === "preview");
    const workspace = deckRef.current?.getBoundingClientRect();
    const position = point && workspace ? { x: point.x - workspace.left, y: point.y - workspace.top } : null;
    setWindows((old) => {
      if (old.some((entry) => entry.id === id)) return old;
      const occupied = old.filter((entry) => entry.id !== T3_CHAT_FLOAT_ID || (curFullscreen && !curChatSelected))
        .map((entry) => workspaceFloatFrame(entry.frame, curBounds));
      return [...old, { id, frame: placeSurfaceFloat(curBounds, occupied, preview, position) }];
    });
  }, []);
  const dockSurface = Z.useCallback((id) => {
    const { floatSlots: curFloatSlots, panelProps: curPanelProps } = stateRefs.current;
    // Keep the host connected while its window unmounts and the dock gets its ref.
    const host = curFloatSlots.get(id)?.firstElementChild;
    if (host && parkingSlot.current) t3MovePanelHost(host, parkingSlot.current);
    showWorkspace();
    const store = tm.getState();
    if (curPanelProps?.threadRef && em(store.byThreadKey, curPanelProps.threadRef).surfaces.some((s) => s.id === id)) {
      store.revealSurface(curPanelProps.threadRef, id);
    }
    setWindows((old) => old.filter((entry) => entry.id !== id));
  }, [showWorkspace]);
  const moveWindow = Z.useCallback((id, frame) => {
    setWindows((old) => old.map((entry) => entry.id === id ? { id, frame } : entry));
  }, []);
  const toggleChatMinimize = Z.useCallback(() => {
    setChatMinimized((value) => !value);
  }, []);
  const toggleFloat = Z.useCallback((id, point) => {
    if (stateRefs.current.windows.some((entry) => entry.id === id)) dockSurface(id);
    else floatSurface(id, point);
  }, [dockSurface, floatSurface]);
  stateRefs.current.chatSelected = chatSelected;
  const ctx = Z.useMemo(() => ({
    windows, labels, bounds, deckTop, chatFloat, chatMinimized, chatSelected, showMainChat, showWorkspace, surfaces, activeSurface, dockedSurfaces, dockedActiveSurface, observeDeck, setDockSlot, setFloatSlot, parkingSlot, panelProps: stablePanelProps, raise, deckRef, swapped, toggleSwap, isZh,
    title: getTitle,
    float: floatSurface,
    dock: dockSurface,
    move: moveWindow,
    toggleChatMinimize,
    toggleFloat
  }), [windows, labels, bounds, deckTop, chatFloat, chatMinimized, chatSelected, showMainChat, showWorkspace, surfaces, activeSurface, dockedSurfaces, dockedActiveSurface, observeDeck, setDockSlot, setFloatSlot, stablePanelProps, raise, swapped, toggleSwap, isZh, getTitle, floatSurface, dockSurface, moveWindow, toggleChatMinimize, toggleFloat]);
  const revealToolDiff = Z.useEffectEvent(() => {
    showWorkspace();
    const diff = surfaces.find((surface) => surface.kind === "diff");
    if (diff && floatingIds.has(diff.id)) dockSurface(diff.id);
  });
  Z.useLayoutEffect(() => {
    if (toolDiffRequest && toolDiffRequest !== lastToolDiffRequest.current) revealToolDiff();
    lastToolDiffRequest.current = toolDiffRequest;
  }, [toolDiffRequest]);
  // Unify T3 native browser mini-player (o_ / previewMiniPlayerStore) into our single workspace floating window
  // so agent-driven preview_open and user-floated browsers never render two competing windows or fight over <webview> ownership.
  const adoptMiniBrowser = Z.useEffectEvent((tabId) => {
    const ref = panelProps?.threadRef;
    if (!ref || !tabId) return;
    o_.getState().close(ref);
    const store = tm.getState();
    const cur = em(store.byThreadKey, ref);
    let target = cur.surfaces.find((s) => s.kind === "preview" && s.resourceId === tabId);
    if (!target) {
      const wasOpen = cur.isOpen;
      store.openBrowser(ref, tabId);
      const after = em(tm.getState().byThreadKey, ref);
      target = after.surfaces.find((s) => s.kind === "preview" && s.resourceId === tabId);
      if (!wasOpen) tm.getState().close(ref);
    }
    if (!target) return;
    if (windows.some((entry) => entry.id === target.id)) {
      raise(target.id);
    } else {
      floatSurface(target.id);
    }
  });
  Z.useLayoutEffect(() => {
    if (miniPlayer?.source?.kind === "browser" && miniPlayer.source.tabId) {
      adoptMiniBrowser(miniPlayer.source.tabId);
    }
  }, [miniPlayer]);
  const mountedList = Z.useMemo(() => {
    const mounted = new Map();
    if (dockedActiveSurface) mounted.set(dockedActiveSurface.id, dockedActiveSurface);
    for (const surface of surfaces) {
      if (floatingIds.has(surface.id)) mounted.set(surface.id, surface);
    }
    return Array.from(mounted.values());
  }, [dockedActiveSurface, surfaces, floatingIds]);
  return (0,$.jsxs)(T3FloatContext.Provider, {
    value: ctx,
    children: [
      Z.cloneElement(children, { "data-t3e-swap": swapped ? "true" : undefined, "data-t3e-main-chat-active": chatSelected ? "" : undefined }),
      mountedList.map((surface) => {
        const floating = floatingIds.has(surface.id);
        const slot = floating ? floatSlots.get(surface.id) : dockSlot;
        return (0,$.jsx)(T3SurfaceMount, {
          surface, panelProps, slot, parkingSlot, floating, onFloatNew: floatSurface, visible: floating || (!chatSelected && panelProps.visible && dockedSurfaces.length > 0 && Boolean(dockSlot))
        }, surface.id);
      })
    ]
  });
}
`;
}

function replaceOnce(source, anchor, replacement) {
  assert(source.includes(anchor) && source.indexOf(anchor) === source.lastIndexOf(anchor),
    `Could not uniquely locate workspace floating anchor: ${anchor.slice(0, 100)}`);
  return source.replace(anchor, () => replacement);
}

function apply(source, ctx) {
  ctx?.recordInjectedCode?.(injectedCode());
  let patched = replaceOnce(source, "let P_=la?(0,$.jsx)(aN,{surface:$a,",
    "let T3panelProps=la?{surface:$a,");
  patched = replaceOnce(patched, 'import{a as ax,t as ox}from"./preview-m7EqCcVQ.js";',
    'import{a as ax,t as ox,o as T3ResolveBrowserAddress,s as T3BrowserSearchTemplate}from"./preview-m7EqCcVQ.js";');
  patched = replaceOnce(patched, 'p as vv,v as yv,x as bv,z as xv}from"./useSettings-CpP0kvJz.js";',
    'p as vv,v as yv,x as bv,z as xv,r as T3GetBrowserSettings}from"./useSettings-CpP0kvJz.js";');
  patched = replaceOnce(patched, "openPreview:e.openPreview,threadRef:e.threadRef,...e.profileId===void 0?{}:{profileId:e.profileId}",
    "openPreview:e.openPreview,threadRef:e.threadRef,url:e.url,...e.profileId===void 0?{}:{profileId:e.profileId}");
  patched = replaceOnce(patched, "j=(e,t)=>{r&&h&&DA({threadRef:r,openPreview:D,...e===void 0?{}:{profileId:e},...t===void 0?{}:{duplicateFrom:t}}).then(AA)}",
    "j=(e,t)=>{if(!r||!h)return;let url=typeof t===`string`?t:void 0,dup=typeof t===`string`?void 0:t;return DA({threadRef:r,openPreview:D,url,...e===void 0?{}:{profileId:e},...dup===void 0?{}:{duplicateFrom:dup}}).then(result=>{AA(result);return result._tag===`Success`})}");
  patched = replaceOnce(patched, "onAddBrowser:()=>Im(),onAddBrowserInProfile:Lm,",
    "onAddBrowser:(input)=>typeof input===`string`?T3NavigateBrowser(input,Im):Im(),onAddBrowserInProfile:Lm,");
  patched = replaceOnce(patched, "onPendingChange:Ro}}):null,F_=ho!==null",
    "onPendingChange:Ro}}:null,F_=ho!==null");
  patched = replaceOnce(patched, "Xa&&la&&!g?(0,$.jsx)(oG,{sheet:Ma,",
    "Xa&&la&&!g?(0,$.jsx)(T3WorkspacePanelShell,{sheet:Ma,");
  patched = replaceOnce(patched, "a?.kind===`preview`&&a.resourceId?o_.getState().open(r,l_(a.resourceId)):a?.kind===`device`",
    "a?.kind===`device`");
  patched = replaceOnce(patched, "children:P_}):null,uy,dy,py,my]",
    "children:(0,$.jsx)(T3DockedSurface,{})}):null,uy,dy,py,my,la&&!g?(0,$.jsx)(T3FloatingDeck,{}):null]");
  patched = replaceOnce(patched, "let hy=(0,$.jsxs)(`div`,{ref:Vn,",
    "let hy=(0,$.jsxs)(`div`,{ref:Vn,\"data-t3e-workspace\":g?void 0:!0,");
  patched = replaceOnce(patched, "children:[tv,Qa&&!g?Z_:null,",
    "children:[tv,la&&!g?null:Qa&&!g?Z_:null,");
  patched = replaceOnce(patched, "!Qa&&!Za?Z_:null,ao?q_:null,(0,$.jsx)(BV,",
    "!la&&!Qa&&!Za?Z_:null,!la&&ao?q_:null,(0,$.jsx)(BV,");
  patched = replaceOnce(patched, "ref:b,className:ce,onContextMenu:re,children:[q,he]",
    'ref:b,className:ce,"data-t3e-chat-heading":!0,onContextMenu:re,children:[q,he]');
  patched = replaceOnce(patched,
    '(0,$.jsxs)(`div`,{className:rv,"data-chat-column-maximized-away":io?`true`:`false`,"data-chat-column":!0,style:ov,inert:io,onMouseUp:NK,children:[',
    '(0,$.jsxs)(T3ChatColumnShell,{className:rv,style:ov,maximizedAway:io,workState:bc!==null?`approval`:(Sc!==null||ha?.hasPendingUserInput===!0)?`input`:bl?`working`:`idle`,onMouseUp:NK,children:[');
  patched = replaceOnce(patched,
    '...eg?{onFindInThread:rg}:{}})]})',
    '...eg?{onFindInThread:rg}:{}}),la&&!g?(0,$.jsx)(T3ChatToolbar,{controls:(0,$.jsx)(Hy,{...H_,showRightPanelControl:!Ga})}):null]})');
  patched = replaceOnce(patched,
    'layoutControls:Ga?(0,$.jsxs)(`div`,{className:`mr-px flex items-center gap-1`,children:[(0,$.jsx)(Ry,{maximized:io,onToggle:Wm}),G_]}):null,',
    'layoutControls:Ga?(0,$.jsx)(T3PanelToolbar,{fullscreen:io,maximize:(0,$.jsx)(Ry,{maximized:io,onToggle:Wm}),toggle:(0,$.jsx)(Hy,{...H_,showThreadPanelControl:!1,showTerminalControl:!1})}):null,');
  patched = replaceOnce(patched, "t[9]!==c||t[10]!==l?(u={container:l,widthStorageKey:c},",
    "t[9]!==c||t[10]!==l||t[11]?.edge!==e.enhancerResizeEdge?(u={container:l,widthStorageKey:c,edge:e.enhancerResizeEdge},");
  patched = replaceOnce(patched, "function oG(e){let t=(0,Q.c)(25)",
    "function oG(e){let t=(0,Q.c)(26)");
  patched = replaceOnce(patched,
    "t[12]!==d||t[13]!==r||t[14]!==s?(e=(0,$.jsx)(My,{...s,mode:`inline`,maximized:r,inlineSize:d}),t[12]=d,t[13]=r,t[14]=s,t[15]=e)",
    "t[12]!==d||t[13]!==r||t[14]!==s||t[25]!==n?(e=(0,$.jsx)(My,{...s,mode:`inline`,maximized:r,inlineSize:d,layoutControls:n}),t[12]=d,t[13]=r,t[14]=s,t[15]=e,t[25]=n)");
  patched = replaceOnce(patched, "checkpoints:q?.checkpoints,checkpointScopes:q?.checkpointScopes,children:hy})",
    "checkpoints:q?.checkpoints,checkpointScopes:q?.checkpointScopes,children:la&&!g?(0,$.jsx)(T3WorkspacePanels,{threadKey:da,panelProps:T3panelProps,surfaces:to,activeSurface:$a,terminalLabels:ca,fullscreen:io&&!Ma,children:hy},da):hy})");
  patched = replaceOnce(patched, 'D=m?.previewKey===w?m.layout.frame:null,O;',
    'D=m?.previewKey===w?m.layout.frame:null;if(D&&C&&r.position&&i?.width>0&&i?.height>0){let ratio=i.width/i.height,width=Math.min(r.width??D.width,Math.max(1,C.width-24),Math.max(1,C.height-24)*ratio),size={width,height:width/ratio};D={...size,...dc(r.position,C,size)}}let O;');
  patched = replaceOnce(patched, 'className:`group pointer-events-auto absolute z-[49] size-3 touch-none cursor-grab active:cursor-grabbing pointer-coarse:-m-2.5 pointer-coarse:size-8`,style:{right:j,top:j}',
    '"data-t3e-preview-drag":!0,className:`group pointer-events-auto absolute z-[50] h-7 touch-none cursor-grab active:cursor-grabbing`,style:{left:j,right:j,top:j}');
  patched = replaceOnce(patched,
    'fe=e=>{let t=e===void 0?`horizontal`:e;if(!s||l?.kind!==`terminal`||l.terminalIds.length>=4)return;let n=l.id,r=j.launchTerminal({place:e=>tm.getState().splitTerminal(s,n,e,t)});r&&$f(s,r.terminalId)}',
    'fe=(e,sid)=>{let t=e===void 0?`horizontal`:e;if(!s)return;let st=tm.getState(),cur=em(st.byThreadKey,s),sf=typeof sid===`string`?cur.surfaces.find(x=>x.id===sid):l;if(sf?.kind!==`terminal`||sf.terminalIds.length>=4)return;let n=sf.id,keepClosed=typeof sid===`string`&&!cur.isOpen,r=j.launchTerminal({place:e=>{let g=tm.getState();g.splitTerminal(s,n,e,t),keepClosed&&g.close(s)}});r&&$f(s,r.terminalId)}');
  patched = replaceOnce(patched,
    'let r=e.getBoundingClientRect(),i=p.current,a=t.present({x:Math.round(r.x),y:Math.round(r.y),width:Math.max(1,Math.round(r.width)),height:Math.max(1,Math.round(r.height))},i.visible&&r.width>0&&r.height>0,i.cornerRadius,i.zIndex);i.visible&&!a&&(t.release(),t=Gd(n,d),t.present({x:Math.round(r.x),y:Math.round(r.y),width:Math.max(1,Math.round(r.width)),height:Math.max(1,Math.round(r.height))},r.width>0&&r.height>0,i.cornerRadius,i.zIndex))',
    'let r=e.getBoundingClientRect(),i=p.current,fw=e.closest?.(".t3e-floating-window"),zi=fw?(Number(fw.style?.zIndex)||33)+1:i.zIndex,nextMode=t3BrowserLayoutMode(e,d);if(nextMode!==mode&&r.width>0&&r.height>0){t.release();mode=nextMode;t=Gd(n,mode)}let a=t.present({x:Math.round(r.x),y:Math.round(r.y),width:Math.max(1,Math.round(r.width)),height:Math.max(1,Math.round(r.height))},i.visible&&r.width>0&&r.height>0,i.cornerRadius,zi);i.visible&&r.width>0&&r.height>0&&!a&&(t.release(),t=Gd(n,mode),t.present({x:Math.round(r.x),y:Math.round(r.y),width:Math.max(1,Math.round(r.width)),height:Math.max(1,Math.round(r.height))},!0,i.cornerRadius,zi))');
  patched = replaceOnce(patched, 'let t=Gd(n,d),r=()=>{let r=e.getBoundingClientRect()',
    'let mode=t3BrowserLayoutMode(e,d),t=Gd(n,mode),r=()=>{let r=e.getBoundingClientRect()');
  patched = replaceOnce(patched,
    'let o=sx(i,r);return window.addEventListener(`resize`,r),window.addEventListener(`scroll`,r,!0),()=>{o(),',
    'let o=sx(i,r);return e.addEventListener("' + PREVIEW_LAYOUT_EVENT + '",r),window.addEventListener(`resize`,r),window.addEventListener(`scroll`,r,!0),()=>{o(),e.removeEventListener("' + PREVIEW_LAYOUT_EVENT + '",r),');
  return patched.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "") + "\n" + injectedCode();
}

module.exports = {
  id: ID,
  name: "工作区标签页浮动、拖动与缩放",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: TARGET_REGEX,
  targetSpec: TARGET_SPEC,
  originalHash: ORIGINAL_HASH,
  apply,
  workspaceFloatFrame,
  workspaceSnapFrame,
  defaultChatFloatFrame,
  chatPillFrame,
  placeSurfaceFloat,
  t3BrowserLayoutMode,
  tabDroppedOutside,
  responsivePreviewPatch: {
    id: "workspace-floating-preview-responsive",
    name: "工作区浏览器浮窗随宽度排版",
    marker: "T3_WORKSPACE_FLOATING_PREVIEW_RESPONSIVE_V1",
    targetRegex: /^apps\/server\/dist\/client\/assets\/main-[\w-]+\.js$/,
    targetSpec: {
      pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
      preferredRegex: /^apps\/server\/dist\/client\/assets\/main-[\w-]+\.js$/,
      includes: ["fittedSourceContent:r?i?.content??null:null,fitSourceContent:r,", "visible:!1,fittedSourceContent:null,fitSourceContent:!1,updatedAt:"],
    },
    originalHash: "588d75b88444f9852ce6a07e2a8f7ae66cccd5532497e7ca9fb2fe2be0806e4b",
    apply(source) {
      let patched = replaceOnce(source,
        "fittedSourceContent:r?i?.content??null:null,fitSourceContent:r,",
        'fittedSourceContent:r===!0?i?.content??null:null,fitSourceContent:r===!0,responsive:r==="responsive",');
      patched = replaceOnce(patched,
        "visible:!1,fittedSourceContent:null,fitSourceContent:!1,updatedAt:",
        "visible:!1,fittedSourceContent:null,fitSourceContent:!1,responsive:!1,updatedAt:");
      patched = replaceOnce(patched,
        "fitSourceContent:t?.fitSourceContent??!1,fittedSourceContent:t?.fittedSourceContent??null,rect:",
        "fitSourceContent:t?.fitSourceContent??!1,fittedSourceContent:t?.fittedSourceContent??null,responsive:t?.responsive??!1,rect:");
      patched = replaceOnce(patched, "function GE(e){let t=(0,Q.c)(171)",
        'const T3ResponsiveViewport=Object.freeze({_tag:`fill`});function GE(e){/* T3_WORKSPACE_FLOATING_PREVIEW_RESPONSIVE_V1 */let t=(0,Q.c)(171)');
      return replaceOnce(patched, "let w=Yw(kt(C)),T;", "let w=Yw(kt(C)),T;if(w.responsive)o=T3ResponsiveViewport;").replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "");
    },
  },
  tabBarPatch: {
    id: "workspace-floating-tab-bar",
    name: "工作区标签页浮动入口与新标签页启动台",
    marker: "T3_WORKSPACE_FLOATING_TAB_BAR_V12",
    legacyMarkers: ["T3_WORKSPACE_FLOATING_TAB_BAR_V1", "T3_WORKSPACE_FLOATING_TAB_BAR_V2", "T3_WORKSPACE_FLOATING_TAB_BAR_V3", "T3_WORKSPACE_FLOATING_TAB_BAR_V4", "T3_WORKSPACE_FLOATING_TAB_BAR_V5", "T3_WORKSPACE_FLOATING_TAB_BAR_V6", "T3_WORKSPACE_FLOATING_TAB_BAR_V7", "T3_WORKSPACE_FLOATING_TAB_BAR_V8", "T3_WORKSPACE_FLOATING_TAB_BAR_V9", "T3_WORKSPACE_FLOATING_TAB_BAR_V10", "T3_WORKSPACE_FLOATING_TAB_BAR_V11"],
    targetRegex: /^apps\/server\/dist\/client\/assets\/PanelLayoutControls-[\w-]+\.js$/,
    targetSpec: {
      pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
      preferredRegex: /^apps\/server\/dist\/client\/assets\/PanelLayoutControls-[\w-]+\.js$/,
      includes: ["Add panel surface", "open-in-main-view", "data-workspace-focus-key"],
    },
    originalHash: "e361ac3632ba56b325a4a8cbdedd2b59cdc94bc71a1d5e9f31ea4966e550dbb9",
    apply(source) {
      let patched = replaceOnce(source,
        "u;t[2]!==o||t[3]!==c||t[4]!==l?(u={storageKey:c,defaultWidth:l,minWidth:Lo,maxWidth:o,edge:`left`},t[2]=o,t[3]=c,t[4]=l,t[5]=u):u=t[5];",
        "u;let t3Edge=r.edge??`left`;t[2]!==o||t[3]!==c||t[4]!==l||t[5]?.edge!==t3Edge?(u={storageKey:c,defaultWidth:l,minWidth:Lo,maxWidth:o,edge:t3Edge},t[2]=o,t[3]=c,t[4]=l,t[5]=u):u=t[5];");
      patched = replaceOnce(patched,
        "function qo(e){let t=(0,$.c)(67),",
        "function qo(e){let t=(0,$.c)(68),");
      patched = replaceOnce(patched,
        "t[64]!==U||t[65]!==re?(ie=(0,Z.jsxs)(`div`,{ref:S,onFocus:w,onBlur:k,...A,\"data-workspace-focus-key\":j,\"data-workspace-unavailable\":M,onMouseDown:N,onMouseUp:P,className:z,style:V,\"data-preview-panel-mode\":ee,\"data-preview-panel-maximized\":H,children:[U,re]}),t[54]=S,t[55]=e.mode,t[56]=e.onMouseDown,t[57]=e.onMouseUp,t[58]=e.workspaceFocusKey,t[59]=A,t[60]=M,t[61]=z,t[62]=V,t[63]=H,t[64]=U,t[65]=re,t[66]=ie):ie=t[66]",
        "t[64]!==U||t[65]!==re||t[67]!==e.enhancerDividerSlot?(ie=(0,Z.jsxs)(`div`,{ref:S,onFocus:w,onBlur:k,...A,\"data-workspace-focus-key\":j,\"data-workspace-unavailable\":M,onMouseDown:N,onMouseUp:P,className:z,style:V,\"data-preview-panel-mode\":ee,\"data-preview-panel-maximized\":H,children:[U,e.enhancerDividerSlot,re]}),t[54]=S,t[55]=e.mode,t[56]=e.onMouseDown,t[57]=e.onMouseUp,t[58]=e.workspaceFocusKey,t[59]=A,t[60]=M,t[61]=z,t[62]=V,t[63]=H,t[64]=U,t[65]=re,t[67]=e.enhancerDividerSlot,t[66]=ie):ie=t[66]");
      patched = replaceOnce(patched, "function Cp(e){let t=(0,$.c)(13)",
        "function Cp(e){/* T3_WORKSPACE_FLOATING_TAB_BAR_V12 */ const drag=T3TrackTabDrag(e);let t=(0,$.c)(14)");
      patched = replaceOnce(patched, "t[9]!==l||t[10]!==r||t[11]!==u?",
        "t[9]!==l||t[10]!==r||t[11]!==u||t[13]!==drag?");
      patched = replaceOnce(patched, "t[10]=r,t[11]=u,t[12]=d):d=t[12],d}function wp",
        "t[10]=r,t[11]=u,t[12]=d,t[13]=drag):d=t[12],d}function wp");
      patched = replaceOnce(patched, "modifiers:$f,onDragEnd:l,children:u",
        "modifiers:T3TabModifiers,onDragStart:drag.start,onDragCancel:drag.cancel,onDragEnd:e=>{if(!drag.finish(e))l(e)},children:u");
      patched = replaceOnce(patched, "surfaces:Re,onMove:ze,children:Be",
        "surfaces:Re,onMove:ze,enhancerFloatTab:e.enhancerFloatTab,children:Be");
      patched = replaceOnce(patched, "surface:t,dragDisabled:!e.onMoveSurface",
        "surface:t,enhancerTabControl:e.enhancerTabControl,dragDisabled:!e.onMoveSurface");
      patched = replaceOnce(patched, "style:H,className:G,children:I}",
        "style:H,className:G,children:[I,e.enhancerTabControl?.(i)]}");
      patched = replaceOnce(patched, 'ne=(0,Z.jsx)(`div`,{"data-active-tab":L',
        'ne=(0,Z.jsxs)(`div`,{"data-active-tab":L');
      patched = replaceOnce(patched, "s.push({id:`close`,label:n(`Close`)}",
        "e.enhancerFloatTab&&s.push({id:`enhancer-float`,label:e.enhancerFloatMenuLabel(i)});s.push({id:`close`,label:n(`Close`)}");
      patched = replaceOnce(patched, "bb169:switch(d){case`open-in-main-view`",
        "bb169:switch(d){case`enhancer-float`:e.enhancerFloatTab?.(i);break bb169;case`open-in-main-view`");
      patched = replaceOnce(patched, "function kp(e){let t=(0,$.c)(133)",
        "function kp(e){let t=(0,$.c)(136)");
      patched = replaceOnce(patched, "e.open===!1&&h&&g(!1);",
        "e.open===!1&&h&&g(!1);const t3PrevActiveRef=Q.useRef(e.activeSurfaceId);Q.useEffect(()=>{if(t3PrevActiveRef.current!==e.activeSurfaceId){t3PrevActiveRef.current=e.activeSurfaceId;if(h&&e.activeSurfaceId!==null)g(!1);}},[e.activeSurfaceId,h]);");
      patched = replaceOnce(patched, "t[61]!==e||t[62]!==p||t[63]!==l?(",
        "t[61]!==e||t[62]!==p||t[63]!==l||t[133]!==h?(");
      patched = replaceOnce(patched, "active:t.id===e.activeSurfaceId,",
        "active:!h&&!e.enhancerChatSelected&&t.id===e.activeSurfaceId,");
      patched = replaceOnce(patched, "onActivate:K,onClose:q,",
        "onActivate:(s)=>{g(!1);K(s)},onClose:q,");
      patched = replaceOnce(patched, "t[61]=e,t[62]=p,t[63]=l,t[64]=Be):",
        "t[61]=e,t[62]=p,t[63]=l,t[133]=h,t[64]=Be):");
      patched = replaceOnce(patched,
        "let Ue=e.open===!1?null:(0,Z.jsxs)(ae,{open:h,onOpenChange:g,children:[(0,Z.jsx)(le,{ref:f,render:(0,Z.jsx)(A,{\"aria-label\":n(`Add panel surface`),className:`shrink-0`,size:`icon-xs`,variant:`ghost-muted`}),children:(0,Z.jsx)(lt,{className:`size-3.5`})}),(0,Z.jsx)(G,{align:`start`,side:`bottom`,sideOffset:6,onKeyDownCapture:V,children:L.map(t=>{let n=t.icon;return t.label===`Browser`&&t.available?(0,Z.jsxs)(ue,{children:[(0,Z.jsxs)(d,{className:`[&>svg:last-child]:ms-0`,\"aria-keyshortcuts\":t.shortcut,onClick:e=>{Jf(`pointerType`in e.nativeEvent&&typeof e.nativeEvent.pointerType==`string`?e.nativeEvent.pointerType:void 0)&&(g(!1),t.onClick())},children:[(0,Z.jsx)(n,{}),r(t.label),(0,Z.jsx)(F,{children:t.shortcut})]}),(0,Z.jsx)(T,{className:`max-w-56`,children:c.map(t=>(0,Z.jsx)(z,{onClick:()=>e.onAddBrowserInProfile(t.id),children:(0,Z.jsx)(`span`,{className:`min-w-0 truncate`,children:t.name})},t.id))})]},t.label):(0,Z.jsxs)(sp,{available:t.available,disabledReason:t.disabledReason,shortcut:t.shortcut,onClick:t.onClick,children:[(0,Z.jsx)(n,{}),r(t.label)]},t.label)})})]}),We;",
        "let Ue=e.open===!1?null:(0,Z.jsx)(T3NewTabStripControl,{btnRef:f,newTabOpen:h||e.activeSurfaceId===null,selected:!e.enhancerChatSelected,addLabel:n(`Add panel surface`),onOpenNewTab:()=>{e.enhancerShowWorkspace?.();g(!0)},onCloseNewTab:()=>{if(e.activeSurfaceId!==null){g(!1);e.enhancerShowWorkspace?.()}else e.enhancerClosePanel?.()}}),We;");
      patched = replaceOnce(patched,
        "t[115]!==e.terminalAvailable?(Xe=e.activeSurfaceId===null?(0,Z.jsx)(cp,{onAddBrowser:e.onAddBrowser,",
        "t[115]!==e.terminalAvailable||t[134]!==h?(Xe=(h||e.activeSurfaceId===null)?(0,Z.jsx)(T3ChatGptSurfaceLauncher,{onDismiss:()=>g(!1),onAddBrowser:e.onAddBrowser,");
      patched = replaceOnce(patched,
        "t[115]=e.terminalAvailable,t[116]=Xe):",
        "t[115]=e.terminalAvailable,t[134]=h,t[116]=Xe):");
      patched = replaceOnce(patched,
        "t[130]!==Ye||t[131]!==Ze?(Qe=(0,Z.jsxs)(ve,{workspaceArea:!0,workspaceFocusKey:ye,workspaceLabel:be,mode:xe,...Se,...Ce,...X,...Te,...Ee,onMouseDown:De,onMouseUp:Oe,children:[Ye,Ze]}),t[119]=ve,t[120]=e.mode,t[121]=ye,t[122]=be,t[123]=Se,t[124]=Ce,t[125]=X,t[126]=Te,t[127]=Ee,t[128]=De,t[129]=Oe,t[130]=Ye,t[131]=Ze,t[132]=Qe):Qe=t[132]",
        "t[130]!==Ye||t[131]!==Ze||t[135]!==e.enhancerDividerSlot?(Qe=(0,Z.jsxs)(ve,{workspaceArea:!0,workspaceFocusKey:ye,workspaceLabel:be,mode:xe,...Se,...Ce,...X,...Te,...Ee,enhancerDividerSlot:e.enhancerDividerSlot,onMouseDown:De,onMouseUp:Oe,children:[Ye,Ze]}),t[119]=ve,t[120]=e.mode,t[121]=ye,t[122]=be,t[123]=Se,t[124]=Ce,t[125]=X,t[126]=Te,t[127]=Ee,t[128]=De,t[129]=Oe,t[130]=Ye,t[131]=Ze,t[135]=e.enhancerDividerSlot,t[132]=Qe):Qe=t[132]");
      return patched.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "") + "\n" + tabDroppedOutside.toString() + `
function t3WpIsZh() {
  return typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
}
function T3NewTabStripControl({ btnRef, newTabOpen, selected, addLabel, onOpenNewTab, onCloseNewTab }) {
  const isZh = t3WpIsZh();
  if (!newTabOpen) {
    return (0, Z.jsx)(A, {
      ref: btnRef,
      type: "button",
      "aria-label": addLabel,
      className: "t3e-new-tab-add shrink-0",
      size: "icon-xs",
      variant: "ghost-muted",
      onClick: onOpenNewTab,
      children: (0, Z.jsx)(lt, { className: "size-3.5" })
    });
  }
  const title = isZh ? "新标签页" : "New tab";
  const closeTitle = isZh ? "关闭标签页" : "Close tab";
  return (0, Z.jsxs)("div", {
    "data-active-tab": selected ? "true" : "false",
    "data-t3e-new-tab": "true",
    className: "t3e-new-tab-pill",
    children: [
      (0, Z.jsx)("button", {
        type: "button",
        className: "t3e-new-tab-close",
        title: closeTitle,
        "aria-label": closeTitle,
        onClick: (ev) => { ev.stopPropagation(); onCloseNewTab(); },
        children: (0, Z.jsxs)("svg", {
          "aria-hidden": true, viewBox: "0 0 16 16", width: 12, height: 12, fill: "none",
          stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round",
          children: [
            (0, Z.jsx)("path", { d: "M4.5 4.5 11.5 11.5" }, "a"),
            (0, Z.jsx)("path", { d: "M11.5 4.5 4.5 11.5" }, "b")
          ]
        })
      }),
      (0, Z.jsx)("button", {
        ref: btnRef,
        type: "button",
        className: "t3e-new-tab-main",
        title,
        onClick: onOpenNewTab,
        children: (0, Z.jsx)("span", { className: "truncate", children: title })
      })
    ]
  });
}
function T3ChatGptSurfaceLauncher(e) {
  const n = B();
  const r = R();
  const [query, setQuery] = Q.useState("");
  const [showAll, setShowAll] = Q.useState(false);
  const [activeIdx, setActiveIdx] = Q.useState(-1);
  const [addressError, setAddressError] = Q.useState(false);
  const inputRef = Q.useRef(null);
  const rootRef = Q.useRef(null);
  const opening = Q.useRef(false);
  const isZh = t3WpIsZh();
  const wrapPick = (fn) => fn ? (...args) => { e.onDismiss?.(); fn(...args); } : undefined;
  const allItems = [
    { id: "browser", label: a("Browser"), icon: we, shortcut: "B", available: e.browserAvailable, disabledReason: r(Zf.browser), onClick: wrapPick(e.onAddBrowser) },
    { id: "terminal", label: a("Terminal"), icon: ft, shortcut: "T", available: e.terminalAvailable, disabledReason: r(Zf.terminal), onClick: wrapPick(e.onAddTerminal) },
    { id: "files", label: a("Files"), icon: ke, shortcut: "F", available: e.filesAvailable, disabledReason: r(Zf.files), onClick: wrapPick(e.onAddFiles) },
    { id: "diff", label: a("Diff"), icon: $e, shortcut: "D", available: e.diffAvailable, disabledReason: r(Zf.diff), onClick: wrapPick(e.onAddDiff) },
    { id: "device", label: a("Device"), icon: dt, shortcut: "M", available: e.deviceAvailable, disabledReason: r(Zf.device), onClick: wrapPick(e.onAddDevice) },
    ...(e.onAddSideChat ? [{ id: "side-chat", label: a("Side chat"), icon: ho, shortcut: "S", available: e.sideChatAvailable && !e.sideChatDisabledReason, disabledReason: e.sideChatDisabledReason ?? r(Zf.sideChat), onClick: wrapPick(e.onAddSideChat) }] : []),
    { id: "pull-request", label: a("Pull request"), icon: Li.pullRequest, shortcut: "P", available: e.pullRequestAvailable, disabledReason: r(Zf.pullRequest), onClick: wrapPick(e.onAddPullRequest) },
    { id: "linked-items", label: a("Linked items"), icon: Li.link, shortcut: "L", available: e.pullRequestsAvailable, disabledReason: r(Zf.pullRequests), onClick: wrapPick(e.onAddPullRequests) }
  ];
  const availableItems = allItems.filter(dp);
  const unavailableItems = allItems.filter((item) => !item.available);
  const visibleItems = showAll ? allItems : availableItems;
  const selectable = visibleItems.filter(dp);
  const clampedIdx = selectable.length === 0 ? -1 : Math.min(activeIdx, selectable.length - 1);
  const onShortcutKey = Q.useEffectEvent((ev) => {
    if (ev.defaultPrevented || ev.repeat || ev.isComposing) return;
    const target = ip(availableItems, ev);
    if (!target || !rootRef.current || rootRef.current.getClientRects().length === 0 || document.querySelector(Xf)) return;
    const el = ev.composedPath()[0] ?? ev.target;
    if (el instanceof Element && ap(el)) return;
    ev.preventDefault();
    ev.stopPropagation();
    target.onClick();
  });
  Q.useEffect(() => {
    const handler = (ev) => onShortcutKey(ev);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
  const handleSubmit = async (ev) => {
    ev.preventDefault();
    const raw = query.trim();
    if (!raw || !e.browserAvailable || !e.onAddBrowser || opening.current) return;
    opening.current = true;
    setAddressError(false);
    try {
      if (await e.onAddBrowser(raw)) e.onDismiss?.();
      else setAddressError(true);
    } catch {
      setAddressError(true);
    } finally {
      opening.current = false;
    }
  };
  const handleKeyDown = (ev) => {
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === "Escape") {
      if (ev.target instanceof Element && ap(ev.target) && query) {
        ev.preventDefault();
        setQuery("");
        setAddressError(false);
      } else {
        ev.preventDefault();
        e.onDismiss?.();
      }
      return;
    }
    if (ev.target instanceof Element && ap(ev.target)) return;
    if (selectable.length === 0) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowRight") {
      ev.preventDefault();
      setActiveIdx((clampedIdx + 1) % selectable.length);
    } else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      setActiveIdx(clampedIdx === -1 ? selectable.length - 1 : (clampedIdx - 1 + selectable.length) % selectable.length);
    } else if (ev.key === "Enter" && clampedIdx >= 0 && selectable[clampedIdx]) {
      ev.preventDefault();
      selectable[clampedIdx].onClick();
    }
  };
  const shortcutKeys = availableItems.map(lp).join("");
  const hasMoreMenu = unavailableItems.length > 0 || (e.browserAvailable && e.browserProfiles.length > 1);
  return (0, Z.jsx)("div", {
    ref: rootRef,
    "data-workspace-focus-default": true,
    tabIndex: 0,
    onKeyDown: handleKeyDown,
    "aria-label": n("Open a surface"),
    "data-surface-launcher-keys": shortcutKeys,
    className: "t3e-launcher-root scrollbar-gutter-both",
    children: (0, Z.jsxs)("div", {
      className: "t3e-launcher-inner",
      children: [
        (0, Z.jsxs)("form", {
          className: "t3e-launcher-search",
          onSubmit: handleSubmit,
          children: [
            (0, Z.jsxs)("svg", {
              "aria-hidden": true, viewBox: "0 0 24 24", width: 16, height: 16, fill: "none",
              stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round",
              className: "t3e-launcher-search-icon",
              children: [
                (0, Z.jsx)("circle", { cx: 11, cy: 11, r: 7 }, "c"),
                (0, Z.jsx)("path", { d: "m20 20-3.5-3.5" }, "p")
              ]
            }),
            (0, Z.jsx)("input", {
              ref: inputRef,
              type: "text",
              value: query,
              onChange: (ev) => { setQuery(ev.target.value); setAddressError(false); },
              placeholder: isZh ? "搜索网页或输入网址" : "Search the web or enter a URL",
              "aria-label": isZh ? "浏览器地址栏" : "Browser address bar",
              disabled: !e.browserAvailable,
              enterKeyHint: "go",
              className: "t3e-launcher-input",
              spellCheck: false
            }),
            query ? (0, Z.jsx)("button", {
              type: "button",
              className: "t3e-launcher-clear",
              "aria-label": isZh ? "清除" : "Clear",
              onClick: () => { setQuery(""); setAddressError(false); inputRef.current?.focus(); },
              children: "×"
            }) : null
          ]
        }),
        addressError ? (0, Z.jsx)("p", {
          className: "mb-2 text-xs text-muted-foreground",
          role: "status",
          children: isZh ? "无法打开此地址或搜索结果，请检查输入后重试。" : "Could not open this address or search. Check the input and try again."
        }) : null,
        (0, Z.jsxs)("div", {
          className: "t3e-launcher-section",
          children: [
            (0, Z.jsxs)("div", {
              className: "t3e-launcher-sec-hdr",
              children: [
                (0, Z.jsx)("span", { className: "t3e-launcher-sec-title", children: isZh ? "打开" : "Open" }),
                hasMoreMenu ? (0, Z.jsxs)(ae, {
                  children: [
                    (0, Z.jsx)(le, {
                      render: (0, Z.jsx)("button", {
                        type: "button",
                        className: "t3e-launcher-more-btn",
                        "aria-label": isZh ? "更多选项" : "More options"
                      }),
                      children: (0, Z.jsxs)("svg", {
                        "aria-hidden": true, viewBox: "0 0 24 24", width: 16, height: 16, fill: "currentColor",
                        children: [
                          (0, Z.jsx)("circle", { cx: 6, cy: 12, r: 1.5 }, "1"),
                          (0, Z.jsx)("circle", { cx: 12, cy: 12, r: 1.5 }, "2"),
                          (0, Z.jsx)("circle", { cx: 18, cy: 12, r: 1.5 }, "3")
                        ]
                      })
                    }),
                    (0, Z.jsxs)(G, {
                      align: "end", side: "bottom", sideOffset: 6, className: "min-w-44",
                      children: [
                        unavailableItems.length > 0 ? (0, Z.jsx)(z, {
                          onClick: () => setShowAll((v) => !v),
                          children: isZh ? (showAll ? "隐藏不可用面板" : "显示全部面板 (" + unavailableItems.length + " 项不可用)") : (showAll ? "Hide unavailable panels" : "Show all panels")
                        }) : null,
                        ...(e.browserAvailable && e.browserProfiles.length > 1
                          ? e.browserProfiles.map((prof) => (0, Z.jsx)(z, {
                              onClick: () => { e.onDismiss?.(); e.onAddBrowserInProfile(prof.id); },
                              children: (isZh ? "浏览器 · " : "Browser · ") + prof.name
                            }, "prof:" + prof.id))
                          : [])
                      ]
                    })
                  ]
                }) : null
              ]
            }),
            visibleItems.length > 0
              ? (0, Z.jsx)("div", {
                  className: "t3e-launcher-grid",
                  children: visibleItems.map((item) => {
                    const isActive = clampedIdx !== -1 && selectable[clampedIdx] === item;
                    const cardInner = (0, Z.jsxs)("button", {
                      type: "button",
                      disabled: !item.available,
                      onClick: item.available ? item.onClick : undefined,
                      onMouseEnter: () => item.available && setActiveIdx(selectable.indexOf(item)),
                      onMouseLeave: () => setActiveIdx((old) => old === selectable.indexOf(item) ? -1 : old),
                      className: Y("t3e-launcher-card", isActive && "is-active", !item.available && "is-disabled"),
                      children: [
                        (0, Z.jsxs)("div", {
                          className: "t3e-launcher-card-top",
                          children: [
                            (0, Z.jsx)("span", { className: "t3e-launcher-card-icon", children: up(item, "size-4") }),
                            (0, Z.jsx)("span", { className: "t3e-launcher-card-kbd", children: item.shortcut })
                          ]
                        }),
                        (0, Z.jsx)("span", { className: "t3e-launcher-card-label", children: r(item.label) })
                      ]
                    });
                    if (!item.available && item.disabledReason) {
                      return (0, Z.jsx)(op, { reason: item.disabledReason, trigger: cardInner }, item.id);
                    }
                    if (item.id === "browser" && item.available && e.browserProfiles.length > 1) {
                      return (0, Z.jsxs)("div", {
                        className: "t3e-launcher-card-wrap",
                        children: [
                          cardInner,
                          (0, Z.jsxs)(ae, {
                            children: [
                              (0, Z.jsx)(le, {
                                render: (0, Z.jsx)("button", {
                                  type: "button",
                                  className: "t3e-launcher-profile-btn",
                                  "aria-label": n("Open browser in a profile"),
                                  onClick: (ev) => ev.stopPropagation()
                                }),
                                children: (0, Z.jsx)(Be, { className: "size-3" })
                              }),
                              (0, Z.jsx)(G, {
                                align: "end", side: "bottom", sideOffset: 6, className: "max-w-56",
                                children: e.browserProfiles.map((prof) => (0, Z.jsx)(z, {
                                  onClick: () => { e.onDismiss?.(); e.onAddBrowserInProfile(prof.id); },
                                  children: (0, Z.jsx)("span", { className: "min-w-0 truncate", children: prof.name })
                                }, prof.id))
                              })
                            ]
                          })
                        ]
                      }, item.id);
                    }
                    return (0, Z.jsx)("div", { className: "t3e-launcher-card-wrap", children: cardInner }, item.id);
                  })
                })
              : (0, Z.jsx)("div", {
                  className: "t3e-launcher-empty",
                  children: isZh ? "未找到匹配的面板，按回车打开文件或浏览器" : "No matching panels — press Enter to open Files or Browser"
                })
          ]
        })
      ]
    })
  });
}
function T3ClampTabBeforeAdd({ transform, draggingNodeRect, active }) {
  if (!draggingNodeRect || typeof document === "undefined") return transform;
  const tabEl = active?.data?.current?.sortable?.node?.current
    || document.querySelector('[data-right-panel-tab-list] [data-active-tab]');
  const rowEl = tabEl?.parentElement;
  if (!rowEl) return transform;
  const tabs = rowEl.querySelectorAll(':scope > [data-active-tab]');
  if (!tabs.length) return transform;
  const addEl = tabs[tabs.length - 1].nextElementSibling;
  const rowRect = rowEl.getBoundingClientRect();
  const minLeft = rowRect.left;
  const maxRight = addEl ? addEl.getBoundingClientRect().left - 4 : rowRect.right;
  const minX = minLeft - draggingNodeRect.left;
  const maxX = Math.max(minX, maxRight - draggingNodeRect.right);
  return {
    ...transform,
    x: Math.min(Math.max(transform.x, minX), maxX),
    y: 0
  };
}
const T3TabModifiers = typeof $f !== "undefined" ? [...$f, T3ClampTabBeforeAdd] : [T3ClampTabBeforeAdd];
function T3TrackTabDrag(props) {
  const drag = Q.useRef(null);
  Q.useEffect(() => () => drag.current?.cancel(), []);
  return Q.useMemo(() => ({
    start(event) {
      drag.current?.cancel();
      const pointer = event.activatorEvent;
      const bar = pointer?.target?.closest?.('[data-right-panel-tabbar]');
      if (!props.enhancerFloatTab || !bar || typeof pointer.clientY !== "number") return;
      const tab = pointer.target.closest('[data-active-tab]');
      const zone = (tab ?? bar).getBoundingClientRect();
      const tabTitle = (tab?.textContent || "").trim() || "Window";
      const isZh = t3WpIsZh();
      const record = { zone, startY: pointer.clientY, point: { x: pointer.clientX, y: pointer.clientY }, ghost: null };
      const ensureGhost = () => {
        if (record.ghost || typeof document === "undefined" || !document.body) return record.ghost;
        const el = document.createElement("div");
        el.className = "t3e-detach-ghost";
        const hdr = document.createElement("div");
        hdr.className = "t3e-detach-ghost-hdr";
        hdr.textContent = tabTitle;
        const body = document.createElement("div");
        body.className = "t3e-detach-ghost-body";
        body.textContent = isZh ? "松开以独立窗口打开" : "Release to float window";
        el.appendChild(hdr);
        el.appendChild(body);
        document.body.appendChild(el);
        record.ghost = el;
        return el;
      };
      const removeGhost = () => {
        if (record.ghost) {
          record.ghost.remove();
          record.ghost = null;
        }
      };
      const track = (event) => {
        if (event.pointerId !== pointer.pointerId) return;
        record.point = { x: event.clientX, y: event.clientY };
        const outside = tabDroppedOutside(zone, record.startY, event.clientY);
        bar.toggleAttribute("data-t3e-detach-ready", outside);
        if (outside) {
          const ghost = ensureGhost();
          if (ghost) ghost.style.transform = "translate3d(" + Math.round(event.clientX - 118) + "px," + Math.round(event.clientY - 16) + "px,0)";
        } else {
          removeGhost();
        }
      };
      record.cancel = () => {
        window.removeEventListener("pointermove", track, true);
        window.removeEventListener("pointerup", track, true);
        window.removeEventListener("pointercancel", record.cancel, true);
        window.removeEventListener("blur", record.cancel, true);
        bar.removeAttribute("data-t3e-detach-ready");
        removeGhost();
        drag.current = null;
      };
      window.addEventListener("pointermove", track, true);
      window.addEventListener("pointerup", track, true);
      window.addEventListener("pointercancel", record.cancel, true);
      window.addEventListener("blur", record.cancel, true);
      drag.current = record;
    },
    cancel() { drag.current?.cancel(); },
    finish(event) {
      const record = drag.current;
      if (!record) return false;
      record.cancel();
      const surface = props.surfaces.find((item) => item.id === event.active.id);
      if (!surface || !tabDroppedOutside(record.zone, record.startY, record.point.y)) return false;
      props.enhancerFloatTab(surface, record.point);
      return true;
    }
  }), [props.enhancerFloatTab, props.surfaces]);
}
`;
    }
  },
  previewToolbarPatch: {
    id: "workspace-floating-preview-toolbar",
    name: "浏览器浮动入口统一到标签栏",
    marker: "T3_WORKSPACE_FLOATING_PREVIEW_TOOLBAR_V1",
    targetRegex: /^apps\/server\/dist\/client\/assets\/PreviewPanel-[\w-]+\.js$/,
    targetSpec: {
      pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
      preferredRegex: /^apps\/server\/dist\/client\/assets\/PreviewPanel-[\w-]+\.js$/,
      includes: ["children:[Se,oe,Me,Ne,W,Pe,ae]"],
    },
    originalHash: "392279013e375e241ad05496a708290e05dd71832ece5da1152cefdf44a22637",
    apply(source) {
      return replaceOnce(source, "children:[Se,oe,Me,Ne,W,Pe,ae]",
        "children:[Se,oe,Me,Ne,W,/* T3_WORKSPACE_FLOATING_PREVIEW_TOOLBAR_V1 */ ae]").replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "");
    }
  }
};

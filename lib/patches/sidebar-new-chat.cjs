"use strict";

const assert = require("node:assert/strict");
const { findUniqueFunction } = require("../js-ast.cjs");
const { APP_SHELL } = require("../resolver.cjs");

const ID = "sidebar-new-chat";
const MARKER = "T3_SIDEBAR_NEW_CHAT_V5";
const LEGACY_MARKERS = ["T3_SIDEBAR_NEW_CHAT_V1", "T3_SIDEBAR_NEW_CHAT_V2", "T3_SIDEBAR_NEW_CHAT_V3", "T3_SIDEBAR_NEW_CHAT_V4"];
const ORIGINAL_HASH = "c016e4750075b866ebfee6f747eef4db8e48fe7148556848bb9ca132b92ddd4d";
const KNOWN_HASHES = ["588d75b88444f9852ce6a07e2a8f7ae66cccd5532497e7ca9fb2fe2be0806e4b"];

function apply(source, ctx) {
  const fn = findUniqueFunction(
    source,
    (_fn, src) => src.includes("Clear thread search") && src.includes("sidebar-thread-search-results"),
    "sidebar-header",
    ctx?.getTokens?.()
  );

  const src = fn.source;

  const jsxMatch = src.match(/\(0,\s*([A-Za-z_$][\w$]*)\.jsx[s]?\)\(/);
  assert(jsxMatch, "Could not extract jsx identifier from sidebar function");
  const jsx = jsxMatch[1];

  const searchIconMatch = src.match(/\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{className:[`'"]size-4 shrink-0 text-\(--sidebar-icon-color\)[`'"]\}/);
  assert(searchIconMatch, "Could not extract searchIcon from sidebar function");
  const searchIcon = searchIconMatch[1];

  const inputMatch = src.match(/\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{ref:[A-Za-z_$][\w$]*,nativeInput:!0,type:[`'"]search[`'"]/);
  assert(inputMatch, "Could not extract inputComp from sidebar function");
  const inputComp = inputMatch[1];

  const clearBtnMatch = src.match(/\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{type:[`'"]button[`'"],size:[`'"]icon-micro[`'"],variant:[`'"]ghost-muted[`'"].*?children:\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{className:[`'"]size-3[`'"]\}/);
  assert(clearBtnMatch, "Could not extract btnComp and clearIcon from sidebar function");
  const btnComp = clearBtnMatch[1];
  const clearIcon = clearBtnMatch[2];

  const newChatIconMatch = src.match(/\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{\}\)/);
  assert(newChatIconMatch, "Could not extract newChatIcon from sidebar function");
  const newChatIcon = newChatIconMatch[1];

  const tFnMatch = src.match(/onClearSearch:[A-Za-z_$][\w$]*\}=[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\(\)/);
  assert(tFnMatch, "Could not extract tFn from sidebar function");
  const tFn = tFnMatch[1];

  const listRegex = /className:`flex-1`,role:`presentation`,children:\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\]/g;
  const listMatches = [...source.matchAll(listRegex)];
  assert.equal(listMatches.length, 1, "Could not uniquely locate sidebar thread-list group");
  const listAnchor = listMatches[0][0];

  const replacement = `/* ${MARKER} */
function t3EnsureSbStyles() {
  if (typeof document === "undefined" || !document.head || typeof document.createElement !== "function" || document.getElementById("t3e-sb-styles")) return;
  const st = document.createElement("style");
  st.id = "t3e-sb-styles";
  st.textContent = [
    '[data-slot="sidebar-group"]:has(> [data-t3e-sidebar-header="true"]) { padding-bottom: 2px !important; margin-bottom: 0 !important; }',
    '[data-t3e-sidebar-thread-list][data-slot="sidebar-group"] { padding-block-start: 0 !important; }',
    '.t3e-sb-header { display: flex; flex-direction: column; gap: 3px; padding-bottom: 0; margin-bottom: 0; }',
    '.t3e-sb-topbar { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-height: 32px; }',
    '.t3e-sb-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }',
    '.t3e-sb-actions button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 8px; }',
    '.t3e-sb-search-box { display: flex; flex: 1 1 auto; min-width: 0; height: 32px; align-items: center; gap: 8px; border-radius: 8px; padding: 0 8px 0 10px; font-size: 13px; line-height: 20px; color: var(--cx-ink-2, var(--muted-foreground, #52525b)); background: transparent; transition: background-color 140ms ease, box-shadow 140ms ease, color 140ms ease; }',
    '.t3e-sb-search-box:hover { background: var(--cx-hover, var(--accent, rgba(127, 127, 127, 0.1))); color: var(--cx-ink-1, var(--foreground, #0d0d0d)); }',
    '.t3e-sb-search-box:focus-within { background: var(--cx-hover, var(--accent, rgba(127, 127, 127, 0.1))); color: var(--cx-ink-1, var(--foreground, #0d0d0d)); box-shadow: inset 0 0 0 1px var(--cx-line, var(--border, rgba(127, 127, 127, 0.22))); }',
    '.t3e-sb-search-box [data-slot="input-control"] { border: 0 !important; background: transparent !important; box-shadow: none !important; border-radius: 0 !important; }',
    '.t3e-sb-search-box [data-slot="input-control"]::before { display: none !important; content: none !important; }',
    '.t3e-sb-search-box [data-slot="input-control"]:focus-within { background: transparent !important; box-shadow: none !important; }',
    '.t3e-new-chat-btn { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--cx-ink-1, var(--foreground, #0d0d0d)); font-size: 13px; line-height: 20px; font-weight: 400; text-align: left; cursor: pointer; transition: background-color 140ms ease, color 140ms ease; }',
    '.t3e-new-chat-btn:hover { background: var(--cx-hover, var(--accent, rgba(127, 127, 127, 0.1))); }',
    '.t3e-new-chat-btn:active { background: var(--cx-selected, var(--accent, rgba(127, 127, 127, 0.16))); }',
    '.t3e-new-chat-btn:disabled { pointer-events: none; opacity: 0.5; }',
    '.t3e-new-chat-icon { width: 15px !important; height: 15px !important; flex-shrink: 0; color: var(--cx-ink-2, var(--muted-foreground, #52525b)); }',
    '.t3e-new-chat-label { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.t3e-new-chat-kbd { flex-shrink: 0; font-size: 12px; color: var(--cx-ink-3, var(--muted-foreground, #71717a)); opacity: 0; transition: opacity 140ms ease; }',
    '.t3e-new-chat-btn:hover .t3e-new-chat-kbd { opacity: 0.78; }',
  ].join("\\n");
  document.head.prepend(st);
}
function ${fn.name}(e){
  t3EnsureSbStyles();
  const {
    hasProjects: n,
    projectScope: r,
    onNewThread: a,
    newThreadDisabled: o,
    newThreadShortcutLabel: s,
    newThreadInProjectShortcutLabel: sp,
    showNewThreadInProjectHint: sc,
    searchInputRef: u,
    searchQuery: d,
    onSearchQueryChange: f,
    onSearchKeyDown: p,
    isSearching: m,
    searchResultCount: h,
    activeSearchResultIndex: g,
    onClearSearch: _
  } = e;
  const v = ${tFn}();
  const isZh = typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
  const newChatLabel = isZh ? "新聊天" : "New chat";
  const searchPlaceholder = v("Search", { $context: "search field placeholder" });
  const searchAriaLabel = v("Search threads");
  const hasResults = m && h > 0;
  const hasActiveResult = hasResults && typeof g === "number" && g >= 0 && g < h;

  const handleNewChatClick = (ev) => {
    a?.(ev);
  };

  const baseTitle = s
    ? v("New thread ({shortcut})", { shortcut: s })
    : newChatLabel;
  const shiftHint = sc
    ? (sp
        ? v("New thread in current project: Shift+click ({shortcut})", { shortcut: sp })
        : v("New thread in current project: Shift+click"))
    : null;
  const newChatTitle = shiftHint ? \`\${baseTitle} · \${shiftHint}\` : baseTitle;

  return (0, ${jsx}.jsxs)("div", {
    className: "t3e-sb-header",
    "data-t3e-sidebar-header": "true",
    children: [
      (0, ${jsx}.jsxs)("div", {
        className: "t3e-sb-topbar",
        children: [
          (0, ${jsx}.jsxs)("div", {
            className: "t3e-sb-search-box",
            children: [
              (0, ${jsx}.jsx)(${searchIcon}, { className: "size-4 shrink-0 text-(--sidebar-icon-color)", "aria-hidden": true }),
              (0, ${jsx}.jsx)(${inputComp}, {
                ref: u,
                nativeInput: true,
                type: "search",
                value: d,
                onChange: (ev) => f(ev.currentTarget.value),
                onKeyDown: p,
                placeholder: searchPlaceholder,
                "aria-label": searchAriaLabel,
                role: "combobox",
                "aria-autocomplete": "list",
                "aria-expanded": hasResults,
                "aria-controls": hasResults ? "sidebar-thread-search-results" : void 0,
                "aria-activedescendant": hasActiveResult ? \`sidebar-thread-search-result-\${g}\` : void 0,
                className: "min-w-0 flex-1"
              }),
              m
                ? (0, ${jsx}.jsx)(${btnComp}, {
                    type: "button",
                    size: "icon-micro",
                    variant: "ghost-muted",
                    className: "shrink-0",
                    "aria-label": v("Clear thread search"),
                    onClick: () => {
                      _();
                      u?.current?.focus?.();
                    },
                    children: (0, ${jsx}.jsx)(${clearIcon}, { className: "size-3", "aria-hidden": true })
                  })
                : null
            ]
          }),
          n
            ? (0, ${jsx}.jsx)("div", {
                className: "t3e-sb-actions",
                children: r
              })
            : null
        ]
      }),
      (0, ${jsx}.jsxs)("button", {
        type: "button",
        disabled: o,
        onClick: handleNewChatClick,
        title: newChatTitle,
        "aria-label": newChatLabel,
        className: "t3e-new-chat-btn",
        children: [
          (0, ${jsx}.jsx)(${newChatIcon}, { className: "t3e-new-chat-icon", "aria-hidden": true }),
          (0, ${jsx}.jsx)("span", { className: "t3e-new-chat-label", children: newChatLabel }),
          s
            ? (0, ${jsx}.jsx)("span", {
                className: "t3e-new-chat-kbd",
                "aria-hidden": true,
                children: s
              })
            : null
        ]
      })
    ]
  });
}
`;

  ctx?.recordInjectedCode?.(replacement);

  return (source.slice(0, fn.start) + replacement + source.slice(fn.end))
    .replace(listAnchor, () => '"data-t3e-sidebar-thread-list":!0,' + listAnchor);
}

module.exports = {
  id: ID,
  name: "侧边栏常驻搜索框与「新聊天」独立入口",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: APP_SHELL.preferredRegex,
  targetSpec: APP_SHELL,
  originalHash: ORIGINAL_HASH,
  knownHashes: KNOWN_HASHES,
  apply,
};

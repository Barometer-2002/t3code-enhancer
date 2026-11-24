"use strict";

const assert = require("node:assert/strict");

const ID = "sidebar-new-chat";
const MARKER = "T3_SIDEBAR_NEW_CHAT_V4";
const LEGACY_MARKERS = ["T3_SIDEBAR_NEW_CHAT_V1", "T3_SIDEBAR_NEW_CHAT_V2", "T3_SIDEBAR_NEW_CHAT_V3"];
const TARGET_REGEX = /^apps\/server\/dist\/client\/assets\/main-[\w-]+\.js$/;
const ORIGINAL_HASH = "341fd2f65a4484a4f306778419d7a81832ba61e3a988eefafbd3f4fd897733b4";

const ewStart = "function eW(e){";
const ewEnd = "}function tW(e){";

function apply(source) {
  const start = source.indexOf(ewStart);
  assert(start >= 0 && start === source.lastIndexOf(ewStart), "Could not uniquely locate eW in main bundle");
  const end = source.indexOf(ewEnd, start);
  assert(end > start && end === source.lastIndexOf(ewEnd), "Could not uniquely locate tW after eW in main bundle");

  const replacement = `/* ${MARKER} */
function eW(e){
  const {
    hasProjects: n,
    projectScope: r,
    onNewProject: i,
    onNewThread: a,
    newThreadDisabled: o,
    newThreadShortcutLabel: s,
    searchInputRef: u,
    searchQuery: d,
    onSearchQueryChange: f,
    onSearchKeyDown: p,
    isSearching: m,
    searchResultCount: h,
    activeSearchResultIndex: g,
    onClearSearch: _
  } = e;
  const v = Rt();
  const { scratchEnvironmentId, startScratchThread } = PJ();
  const isZh = typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
  const newChatLabel = isZh ? "新聊天" : "New chat";
  const searchPlaceholder = v("Search", { $context: "search field placeholder" });
  const searchAriaLabel = v("Search threads");
  const hasResults = m && h > 0;
  const hasActiveResult = hasResults && typeof g === "number" && g >= 0 && g < h;

  const handleNewChatClick = (ev) => {
    if (ev && ev.shiftKey) {
      a?.(ev);
      return;
    }
    const envId = scratchEnvironmentId ? scratchEnvironmentId(null) : null;
    if (envId != null && typeof startScratchThread === "function") {
      Promise.resolve(startScratchThread(envId)).catch(() => {});
      return;
    }
    a?.(ev);
  };

  const newChatTitle = s
    ? v("New thread ({shortcut})", { shortcut: s })
    : newChatLabel;

  return (0, Z.jsxs)("div", {
    className: "t3e-sb-header",
    "data-t3e-sidebar-header": "true",
    children: [
      (0, Z.jsxs)("div", {
        className: "t3e-sb-topbar",
        children: [
          (0, Z.jsxs)("div", {
            className: "t3e-sb-search-box",
            children: [
              (0, Z.jsx)(ai, { className: "size-4 shrink-0 text-(--sidebar-icon-color)", "aria-hidden": true }),
              (0, Z.jsx)(Xg, {
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
                ? (0, Z.jsx)(Xe, {
                    type: "button",
                    size: "icon-micro",
                    variant: "ghost-muted",
                    className: "shrink-0",
                    "aria-label": v("Clear thread search"),
                    onClick: () => {
                      _();
                      u?.current?.focus?.();
                    },
                    children: (0, Z.jsx)(fa, { className: "size-3", "aria-hidden": true })
                  })
                : null
            ]
          }),
          n
            ? (0, Z.jsxs)("div", {
                className: "t3e-sb-actions",
                children: [
                  r,
                  (0, Z.jsx)(tW, {
                    label: v("Add project"),
                    onClick: i,
                    children: (0, Z.jsx)(ci, {})
                  })
                ]
              })
            : null
        ]
      }),
      (0, Z.jsxs)("button", {
        type: "button",
        disabled: o,
        onClick: handleNewChatClick,
        title: newChatTitle,
        "aria-label": newChatLabel,
        className: "t3e-new-chat-btn",
        children: [
          (0, Z.jsx)(Fx, { className: "t3e-new-chat-icon", "aria-hidden": true }),
          (0, Z.jsx)("span", { className: "t3e-new-chat-label", children: newChatLabel }),
          s
            ? (0, Z.jsx)("span", {
                className: "t3e-new-chat-kbd",
                "aria-hidden": true,
                children: s
              })
            : null
        ]
      })
    ]
  });
`;

  const listAnchor = 'className:`flex-1`,role:`presentation`,children:[no,ro,io]';
  assert(source.includes(listAnchor) && source.indexOf(listAnchor) === source.lastIndexOf(listAnchor),
    "Could not uniquely locate sidebar thread-list group");
  return (source.slice(0, start) + replacement + source.slice(end))
    .replace(listAnchor, '"data-t3e-sidebar-thread-list":!0,' + listAnchor)
    .replace(/\n?\/\/# sourceMappingURL=.*$/m, "");
}

module.exports = {
  id: ID,
  name: "侧边栏常驻搜索框与「新聊天」独立入口",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  apply,
};

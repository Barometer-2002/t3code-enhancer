/**
 * External ESM runtime for workspace tab bar controls, new tab pill, launcher, and drag tear-off.
 * Pure ES module with ZERO minified host dependencies.
 */

export function tabDroppedOutside(bar, startY, endY) {
  return Math.abs(endY - startY) >= 24 && (endY < bar.top - 16 || endY > bar.bottom + 16);
}

function t3WpIsZh() {
  return typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
}

const LAUNCHER_IDS = {
  B: "browser", T: "terminal", F: "files", D: "diff", M: "device", S: "side-chat",
  P: "pull-request", L: "linked-items"
};
const LAUNCHER_ORDER = Object.values(LAUNCHER_IDS);

export function createTabBarRuntime(host) {
  const {
    React,
    jsx,
    jsxs,
    useI18n,
    useFormatMessage,
    cn,
    Button,
    PlusIcon,
    Menu,
    MenuTrigger,
    MenuPopup,
    MenuItem,
    ChevronDown,
    tabModifiers = [],
    matchShortcut,
    renderItemIcon,
    DisabledTooltip,
    isEditableTarget,
    popupSelector,
  } = host;

  function T3NewTabStripControl({ btnRef, newTabOpen, selected, addLabel, onOpenNewTab, onCloseNewTab }) {
    const isZh = t3WpIsZh();
    if (!newTabOpen) {
      return jsx(Button, {
        ref: btnRef,
        type: "button",
        "aria-label": addLabel,
        className: "t3e-new-tab-add shrink-0",
        size: "icon-xs",
        variant: "ghost-muted",
        onClick: onOpenNewTab,
        children: jsx(PlusIcon, { className: "size-3.5" })
      });
    }
    const title = isZh ? "新标签页" : "New tab";
    const closeTitle = isZh ? "关闭标签页" : "Close tab";
    return jsxs("div", {
      "data-active-tab": selected ? "true" : "false",
      "data-t3e-new-tab": "true",
      className: "t3e-new-tab-pill",
      children: [
        jsx("button", {
          type: "button",
          className: "t3e-new-tab-close",
          title: closeTitle,
          "aria-label": closeTitle,
          onClick: (ev) => { ev.stopPropagation(); onCloseNewTab(); },
          children: jsxs("svg", {
            "aria-hidden": true, viewBox: "0 0 16 16", width: 12, height: 12, fill: "none",
            stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round",
            children: [
              jsx("path", { d: "M4.5 4.5 11.5 11.5" }, "a"),
              jsx("path", { d: "M11.5 4.5 4.5 11.5" }, "b")
            ]
          })
        }),
        jsx("button", {
          ref: btnRef,
          type: "button",
          className: "t3e-new-tab-main",
          title,
          onClick: onOpenNewTab,
          children: jsx("span", { className: "truncate", children: title })
        })
      ]
    });
  }

  function T3ChatGptSurfaceLauncher(props) {
    const i18n = typeof useI18n === "function" ? useI18n() : (s) => s;
    const formatMessage = typeof useFormatMessage === "function" ? useFormatMessage() : (s) => s;
    const [query, setQuery] = React.useState("");
    const [showAll, setShowAll] = React.useState(false);
    const [activeIdx, setActiveIdx] = React.useState(-1);
    const [addressError, setAddressError] = React.useState(false);
    const inputRef = React.useRef(null);
    const rootRef = React.useRef(null);
    const opening = React.useRef(false);
    const isZh = t3WpIsZh();

    const wrapPick = (fn) => fn ? (...args) => { props.onDismiss?.(); fn(...args); } : undefined;

    const items = (props.items || []).map((item) => ({
      ...item,
      id: item.id || LAUNCHER_IDS[item.shortcut] ||
        (typeof item.label === "string" ? item.label.toLowerCase().replace(/\s+/g, "-") : String(item.shortcut || "item")),
      onClick: wrapPick(item.onClick),
    }));
    const rank = (item) => {
      const index = LAUNCHER_ORDER.indexOf(item.id);
      return index < 0 ? LAUNCHER_ORDER.length : index;
    };
    const allItems = items.sort((a, b) => rank(a) - rank(b));

    const selectable = allItems.filter((item) => item.available);
    const unavailableCount = allItems.length - selectable.length;
    const visibleItems = showAll ? allItems : selectable;
    const clampedIdx = selectable.length === 0 ? -1 : Math.min(activeIdx, selectable.length - 1);

    const onShortcutKey = (React.useEffectEvent || ((fn) => fn))((ev) => {
      if (ev.defaultPrevented || ev.repeat || ev.isComposing) return;
      const target = typeof matchShortcut === "function" ? matchShortcut(selectable, ev) : null;
      if (!target || !rootRef.current || rootRef.current.getClientRects().length === 0 || document.querySelector(popupSelector)) return;
      const el = ev.composedPath()[0] ?? ev.target;
      if (el instanceof Element && typeof isEditableTarget === "function" && isEditableTarget(el)) return;
      ev.preventDefault();
      ev.stopPropagation();
      target.onClick?.();
    });

    React.useEffect(() => {
      const handler = (ev) => onShortcutKey(ev);
      window.addEventListener("keydown", handler, true);
      return () => window.removeEventListener("keydown", handler, true);
    }, []);

    const handleSubmit = async (ev) => {
      ev.preventDefault();
      const raw = query.trim();
      if (!raw || !props.browserAvailable || !props.onAddBrowser || opening.current) return;
      opening.current = true;
      setAddressError(false);
      try {
        if (await props.onAddBrowser(raw)) props.onDismiss?.();
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
        if (ev.target instanceof Element && typeof isEditableTarget === "function" && isEditableTarget(ev.target) && query) {
          ev.preventDefault();
          setQuery("");
          setAddressError(false);
        } else {
          ev.preventDefault();
          props.onDismiss?.();
        }
        return;
      }
      if (ev.target instanceof Element && typeof isEditableTarget === "function" && isEditableTarget(ev.target)) return;
      if (selectable.length === 0) return;
      if (ev.key === "ArrowDown" || ev.key === "ArrowRight") {
        ev.preventDefault();
        setActiveIdx((clampedIdx + 1) % selectable.length);
      } else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        setActiveIdx(clampedIdx === -1 ? selectable.length - 1 : (clampedIdx - 1 + selectable.length) % selectable.length);
      } else if (ev.key === "Enter" && clampedIdx >= 0 && selectable[clampedIdx]) {
        ev.preventDefault();
        selectable[clampedIdx].onClick?.();
      }
    };

    const shortcutKeys = selectable.map((item) => item.shortcut || "").join("");
    const browserProfiles = props.browserProfiles || [];
    const showBrowserProfiles = props.browserAvailable && browserProfiles.length > 1;
    const hasMoreMenu = unavailableCount > 0 || showBrowserProfiles;
    const renderProfiles = (renderLabel, keyPrefix = "") => browserProfiles.map((profile) =>
      jsx(MenuItem, {
        onClick: wrapPick(() => props.onAddBrowserInProfile?.(profile.id)),
        children: renderLabel(profile.name)
      }, keyPrefix + profile.id)
    );

    return jsx("div", {
      ref: rootRef,
      "data-workspace-focus-default": true,
      tabIndex: 0,
      onKeyDown: handleKeyDown,
      "aria-label": i18n("Open a surface"),
      "data-surface-launcher-keys": shortcutKeys,
      className: "t3e-launcher-root scrollbar-gutter-both",
      children: jsxs("div", {
        className: "t3e-launcher-inner",
        children: [
          jsxs("form", {
            className: "t3e-launcher-search",
            onSubmit: handleSubmit,
            children: [
              jsxs("svg", {
                "aria-hidden": true, viewBox: "0 0 24 24", width: 16, height: 16, fill: "none",
                stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round",
                className: "t3e-launcher-search-icon",
                children: [
                  jsx("circle", { cx: 11, cy: 11, r: 7 }, "c"),
                  jsx("path", { d: "m20 20-3.5-3.5" }, "p")
                ]
              }),
              jsx("input", {
                ref: inputRef,
                type: "text",
                value: query,
                onChange: (ev) => { setQuery(ev.target.value); setAddressError(false); },
                placeholder: isZh ? "搜索网页或输入网址" : "Search the web or enter a URL",
                "aria-label": isZh ? "浏览器地址栏" : "Browser address bar",
                disabled: !props.browserAvailable,
                enterKeyHint: "go",
                className: "t3e-launcher-input",
                spellCheck: false
              }),
              query ? jsx("button", {
                type: "button",
                className: "t3e-launcher-clear",
                "aria-label": isZh ? "清除" : "Clear",
                onClick: () => { setQuery(""); setAddressError(false); inputRef.current?.focus(); },
                children: "×"
              }) : null
            ]
          }),
          addressError ? jsx("p", {
            className: "mb-2 text-xs text-muted-foreground",
            role: "status",
            children: isZh ? "无法打开此地址或搜索结果，请检查输入后重试。" : "Could not open this address or search. Check the input and try again."
          }) : null,
          jsxs("div", {
            className: "t3e-launcher-section",
            children: [
              jsxs("div", {
                className: "t3e-launcher-sec-hdr",
                children: [
                  jsx("span", { className: "t3e-launcher-sec-title", children: isZh ? "打开" : "Open" }),
                  hasMoreMenu ? jsxs(Menu, {
                    children: [
                      jsx(MenuTrigger, {
                        render: jsx("button", {
                          type: "button",
                          className: "t3e-launcher-more-btn",
                          "aria-label": isZh ? "更多选项" : "More options"
                        }),
                        children: jsxs("svg", {
                          "aria-hidden": true, viewBox: "0 0 24 24", width: 16, height: 16, fill: "currentColor",
                          children: [
                            jsx("circle", { cx: 6, cy: 12, r: 1.5 }, "1"),
                            jsx("circle", { cx: 12, cy: 12, r: 1.5 }, "2"),
                            jsx("circle", { cx: 18, cy: 12, r: 1.5 }, "3")
                          ]
                        })
                      }),
                      jsxs(MenuPopup, {
                        align: "end", side: "bottom", sideOffset: 6, className: "min-w-44",
                        children: [
                          unavailableCount > 0 ? jsx(MenuItem, {
                            onClick: () => setShowAll((v) => !v),
                            children: isZh ? (showAll ? "隐藏不可用面板" : "显示全部面板 (" + unavailableCount + " 项不可用)") : (showAll ? "Hide unavailable panels" : "Show all panels")
                          }) : null,
                          ...(showBrowserProfiles
                            ? renderProfiles((name) => (isZh ? "浏览器 · " : "Browser · ") + name, "prof:")
                            : [])
                        ]
                      })
                    ]
                  }) : null
                ]
              }),
              visibleItems.length > 0
                ? jsx("div", {
                    className: "t3e-launcher-grid",
                    children: visibleItems.map((item) => {
                      const isActive = clampedIdx !== -1 && selectable[clampedIdx] === item;
                      const cardInner = jsxs("button", {
                        type: "button",
                        disabled: !item.available,
                        onClick: item.available ? item.onClick : undefined,
                        onMouseEnter: () => item.available && setActiveIdx(selectable.indexOf(item)),
                        onMouseLeave: () => setActiveIdx((old) => old === selectable.indexOf(item) ? -1 : old),
                        className: typeof cn === "function" ? cn("t3e-launcher-card", isActive && "is-active", !item.available && "is-disabled") : `t3e-launcher-card ${isActive ? "is-active" : ""} ${!item.available ? "is-disabled" : ""}`.trim(),
                        children: [
                          jsxs("div", {
                            className: "t3e-launcher-card-top",
                            children: [
                              jsx("span", { className: "t3e-launcher-card-icon", children: typeof renderItemIcon === "function" ? renderItemIcon(item, "size-4") : (item.icon ? jsx(item.icon, { className: "size-4" }) : null) }),
                              jsx("span", { className: "t3e-launcher-card-kbd", children: item.shortcut })
                            ]
                          }),
                          jsx("span", { className: "t3e-launcher-card-label", children: formatMessage(item.label) })
                        ]
                      });
                      if (!item.available && item.disabledReason && typeof DisabledTooltip === "function") {
                        return jsx(DisabledTooltip, { reason: item.disabledReason, trigger: cardInner }, item.id);
                      }
                      if (item.id === "browser" && item.available && browserProfiles.length > 1) {
                        return jsxs("div", {
                          className: "t3e-launcher-card-wrap",
                          children: [
                            cardInner,
                            jsxs(Menu, {
                              children: [
                                jsx(MenuTrigger, {
                                  render: jsx("button", {
                                    type: "button",
                                    className: "t3e-launcher-profile-btn",
                                    "aria-label": i18n("Open browser in a profile"),
                                    onClick: (ev) => ev.stopPropagation()
                                  }),
                                  children: jsx(ChevronDown, { className: "size-3" })
                                }),
                                jsx(MenuPopup, {
                                  align: "end", side: "bottom", sideOffset: 6, className: "max-w-56",
                                  children: renderProfiles((name) => jsx("span", { className: "min-w-0 truncate", children: name }))
                                })
                              ]
                            })
                          ]
                        }, item.id);
                      }
                      return jsx("div", { className: "t3e-launcher-card-wrap", children: cardInner }, item.id);
                    })
                  })
                : jsx("div", {
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

  const T3TabModifiers = Array.isArray(tabModifiers) ? [...tabModifiers, T3ClampTabBeforeAdd] : [T3ClampTabBeforeAdd];

  function T3TrackTabDrag(props) {
    const drag = React.useRef(null);
    React.useEffect(() => () => drag.current?.cancel(), []);
    return React.useMemo(() => ({
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

  return {
    T3NewTabStripControl,
    T3ChatGptSurfaceLauncher,
    T3ClampTabBeforeAdd,
    T3TabModifiers,
    T3TrackTabDrag,
  };
}

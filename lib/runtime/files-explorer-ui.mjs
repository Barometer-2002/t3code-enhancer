/**
 * External ESM runtime for files-changes-explorer enhancements.
 * Clean ESM without minified host variable names.
 */

export function t3NormalizeRelPath(raw) {
  return String(raw || "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
}

export function t3BuildChangedFileTree(files, query) {
  const q = String(query || "").trim().toLowerCase();
  const list = Array.isArray(files) ? files : [];
  const filtered = q
    ? list.filter((f) => String(f?.path || "").toLowerCase().includes(q))
    : list;

  const root = { kind: "dir", name: "", path: "", dirs: new Map(), files: [] };
  const seenPaths = new Set();
  for (const f of filtered) {
    const raw = String(f?.path || "");
    if (!raw || /[\\/]$/.test(raw)) continue;
    const norm = t3NormalizeRelPath(raw);
    if (!norm || seenPaths.has(norm)) continue;
    seenPaths.add(norm);
    const parts = norm.split("/").filter(Boolean);
    if (!parts.length) continue;
    let cur = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      prefix = prefix ? prefix + "/" + seg : seg;
      if (!cur.dirs.has(seg)) {
        cur.dirs.set(seg, { kind: "dir", name: seg, path: prefix, dirs: new Map(), files: [] });
      }
      cur = cur.dirs.get(seg);
    }
    const insertions = Number(f.insertions) || 0;
    const deletions = Number(f.deletions) || 0;
    const isNew = f?.status === "added" || f?.status === "untracked" || f?.operation === "add" || (insertions > 0 && deletions === 0);
    cur.files.push({
      kind: "file",
      name: parts[parts.length - 1],
      path: norm,
      insertions,
      deletions,
      isNew,
    });
  }

  function finalize(node) {
    const dirs = Array.from(node.dirs.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(finalize);
    const sortedFiles = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
    return {
      kind: "dir",
      name: node.name,
      path: node.path,
      children: dirs.concat(sortedFiles),
    };
  }
  return finalize(root).children;
}

export function createFilesExplorerRuntime(host = {}) {
  const { React, jsx, jsxs, gitQueries, useQuery, diffPanelStore, rightPanelStore } = host;
  const T3_FE_EMPTY_FILES = [];

  function t3EnsureFeStyles() {
    if (typeof document === "undefined" || !document.head || document.getElementById("t3e-fe-styles")) return;
    const st = document.createElement("style");
    st.id = "t3e-fe-styles";
    st.textContent = `
.t3e-fe-changes-wrap{display:flex;flex-direction:column;gap:2px;padding:6px 6px 4px;border-bottom:1px solid var(--border)}
.t3e-fe-all-changes-btn,.t3e-fe-sec-hdr{display:flex;align-items:center;gap:6px;width:100%;height:26px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--foreground);font-size:12px;text-align:left;cursor:pointer}
.t3e-fe-all-changes-btn:hover,.t3e-fe-sec-hdr:hover,.t3e-fe-dir-row:hover,.t3e-fe-file-row:hover{background:var(--accent)}
.t3e-fe-all-files-hdr{margin:4px 6px 0;width:calc(100% - 12px)}
.t3e-fe-icon,.t3e-fe-file-icon{width:14px;height:14px;flex:0 0 auto;opacity:.8}
.t3e-fe-chev{width:12px;height:12px;flex:0 0 auto;opacity:.7;transition:transform .12s ease}
.t3e-fe-chev.is-open{transform:rotate(90deg)}
.t3e-fe-trunc{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3e-fe-count{font-family:var(--font-mono);font-size:11px;opacity:.7;flex:0 0 auto}
.t3e-fe-dot{width:6px;height:6px;border-radius:999px;background:var(--primary,#3b82f6);flex:0 0 auto}
.t3e-fe-changed-list{display:flex;flex-direction:column;gap:1px}
.t3e-fe-dir-row,.t3e-fe-file-row{display:flex;align-items:center;gap:6px;width:100%;height:26px;padding-right:6px;border:0;border-radius:6px;background:transparent;color:var(--foreground);font-size:12px;text-align:left}
.t3e-fe-dir-row{cursor:pointer}
.t3e-fe-file-row.is-active{background:var(--accent)}
.t3e-fe-file-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3e-fe-file-name.is-add{color:#15803d}
.t3e-fe-file-name.is-mod{color:var(--foreground)}
.t3e-fe-badge{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border:0;border-radius:4px;background:transparent;cursor:pointer;flex:0 0 auto}
.t3e-fe-badge.is-add{color:#15803d}
.t3e-fe-badge.is-mod{color:var(--warning,#d97706)}
.t3e-fe-empty{padding:6px 10px;font-size:12px;opacity:.65}
`;
    document.head.appendChild(st);
  }

  function T3FeAllChangesIcon() {
    return jsxs("svg", {
      className: "t3e-fe-icon",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      children: [
        jsx("path", { d: "M8 6h13M8 12h13M8 18h13" }),
        jsx("circle", { cx: "3.5", cy: "6", r: "1", fill: "currentColor", stroke: "none" }),
        jsx("circle", { cx: "3.5", cy: "12", r: "1", fill: "currentColor", stroke: "none" }),
        jsx("circle", { cx: "3.5", cy: "18", r: "1", fill: "currentColor", stroke: "none" })
      ]
    });
  }

  function T3FeChevron({ open }) {
    return jsx("svg", {
      className: open ? "t3e-fe-chev is-open" : "t3e-fe-chev",
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      children: jsx("path", { d: "M6 4l4 4-4 4" })
    });
  }

  function t3FeFileAccent(name) {
    const ext = String(name || "").toLowerCase().split(".").pop();
    if (ext === "js" || ext === "cjs" || ext === "mjs" || ext === "jsx") return "#d97706";
    if (ext === "ts" || ext === "tsx") return "#2563eb";
    if (ext === "json") return "#ea580c";
    if (ext === "md" || ext === "mdx") return "#16a34a";
    if (ext === "css" || ext === "scss") return "#7c3aed";
    if (ext === "py") return "#0284c7";
    return "";
  }

  function T3FeFileIcon({ name }) {
    const accent = t3FeFileAccent(name);
    return jsxs("svg", {
      className: "t3e-fe-file-icon",
      style: accent ? { color: accent, opacity: 0.85 } : undefined,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      children: [
        jsx("path", { d: "M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z" }),
        jsx("path", { d: "M14 2v5h5" })
      ]
    });
  }

  function T3FeDiffBadge({ isNew, onClick, title }) {
    return jsx("button", {
      type: "button",
      className: isNew ? "t3e-fe-badge is-add" : "t3e-fe-badge is-mod",
      "aria-label": title,
      onClick,
      children: isNew
        ? jsx("svg", {
            viewBox: "0 0 12 12",
            width: 10,
            height: 10,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: "1.8",
            strokeLinecap: "round",
            "aria-hidden": true,
            children: jsx("path", { d: "M6 2.5v7M2.5 6h7" })
          })
        : jsx("svg", {
            viewBox: "0 0 12 12",
            width: 10,
            height: 10,
            fill: "currentColor",
            "aria-hidden": true,
            children: jsx("circle", { cx: "6", cy: "6", r: "2" })
          })
    });
  }

  function T3FeChangedTreeNodes({
    nodes,
    depth,
    isSearching,
    collapsedDirs,
    onToggleDir,
    normSelected,
    onOpenFile,
    openInDiffTitle,
    openAllChanges
  }) {
    return nodes.map((node) => {
      const padLeft = 10 + depth * 14;
      if (node.kind === "dir") {
        const isOpen = isSearching || !collapsedDirs[node.path];
        return jsxs(
          React.Fragment,
          {
            children: [
              jsxs("button", {
                type: "button",
                className: "t3e-fe-dir-row",
                style: { paddingLeft: padLeft + "px" },
                "aria-expanded": isOpen,
                title: node.path,
                onClick: () => onToggleDir(node.path),
                children: [
                  jsx(T3FeChevron, { open: isOpen }),
                  jsx("span", { className: "t3e-fe-trunc", children: node.name }),
                  jsx("span", { className: "t3e-fe-dot", "aria-hidden": true })
                ]
              }),
              isOpen
                ? jsx(T3FeChangedTreeNodes, {
                    nodes: node.children,
                    depth: depth + 1,
                    isSearching,
                    collapsedDirs,
                    onToggleDir,
                    normSelected,
                    onOpenFile,
                    openInDiffTitle,
                    openAllChanges
                  })
                : null
            ]
          },
          "d:" + node.path
        );
      }
      const isActive = normSelected === node.path;
      const isNew = typeof node.isNew === "boolean" ? node.isNew : (node.insertions > 0 && node.deletions === 0);
      return jsxs(
        "div",
        {
          className: isActive ? "t3e-fe-file-row is-active" : "t3e-fe-file-row",
          style: { paddingLeft: padLeft + 4 + "px" },
          children: [
            jsxs("button", {
              type: "button",
              className: "t3e-fe-file-main",
              style: {
                display: "flex",
                alignItems: "center",
                gap: "7px",
                flex: "1 1 0%",
                minWidth: 0,
                height: "100%",
                border: 0,
                padding: 0,
                background: "transparent",
                color: "inherit",
                textAlign: "left",
                cursor: "pointer"
              },
              title: node.path,
              "aria-current": isActive ? "true" : undefined,
              onClick: () => onOpenFile?.(node.path),
              children: [
                jsx(T3FeFileIcon, { name: node.name }),
                jsx("span", {
                  className: isNew ? "t3e-fe-file-name is-add" : "t3e-fe-file-name is-mod",
                  children: node.name
                })
              ]
            }),
            jsx(T3FeDiffBadge, {
              isNew,
              title: openInDiffTitle,
              onClick: openAllChanges
            })
          ]
        },
        "f:" + node.path
      );
    });
  }

  function T3FilesChangesLayout({
    header,
    errorNode,
    moreNode,
    loadingNode,
    allFilesNode,
    environmentId,
    cwd,
    threadRef,
    searchQuery,
    selectedPath,
    onOpenFile,
    hostFolder
  }) {
    const isZh = typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
    const [changesOpen, setChangesOpen] = React.useState(true);
    const [allFilesOpen, setAllFilesOpen] = React.useState(true);
    const [collapsedDirs, setCollapsedDirs] = React.useState({});
    React.useEffect(() => {
      t3EnsureFeStyles();
    }, []);
    React.useEffect(() => { setCollapsedDirs({}); }, [cwd]);

    const canShowChanges = Boolean(!hostFolder && environmentId && cwd && threadRef);
    const statusAtom = React.useMemo(
      () => canShowChanges && typeof gitQueries?.status === "function" ? gitQueries.status({ environmentId, input: { cwd } }) : null,
      [canShowChanges, environmentId, cwd]
    );
    const statusQuery = typeof useQuery === "function" ? useQuery(statusAtom) : { data: null };
    const isRepo = statusQuery?.data ? statusQuery.data.isRepo !== false : true;
    const rawFiles = statusQuery?.data?.workingTree?.files ?? T3_FE_EMPTY_FILES;
    const totalChanges = rawFiles.length;
    const showChangesSplit = canShowChanges && isRepo && totalChanges > 0;
    const showChangedTree = showChangesSplit && changesOpen;
    const treeNodes = React.useMemo(
      () => showChangedTree ? t3BuildChangedFileTree(rawFiles, searchQuery) : T3_FE_EMPTY_FILES,
      [showChangedTree, rawFiles, searchQuery]
    );

    const toggleDir = (dirPath) => {
      setCollapsedDirs((prev) => ({ ...prev, [dirPath]: !prev[dirPath] }));
    };

    const openAllChanges = (ev) => {
      if (ev) ev.stopPropagation();
      if (!threadRef) return;
      if (diffPanelStore?.getState) {
        diffPanelStore.getState().selectGitScope(threadRef, totalChanges > 0 ? "unstaged" : "branch");
      }
      if (rightPanelStore?.getState) {
        rightPanelStore.getState().open(threadRef, "diff");
      }
    };

    const allChangesLabel = isZh ? "所有更改" : "All changes";
    const changedFilesLabel = isZh ? "已更改的文件" : "Changed files";
    const allFilesLabel = isZh ? "所有文件" : "All files";
    const openInDiffTitle = isZh ? "在变更专栏查看 Diff" : "View diff in Changes";
    const normSelected = typeof selectedPath === "string" ? t3NormalizeRelPath(selectedPath) : "";
    const isSearching = Boolean(String(searchQuery || "").trim());

    return jsxs(React.Fragment, {
      children: [
        header,
        showChangesSplit
          ? jsxs("div", {
              className: "t3e-fe-changes-wrap",
              children: [
                jsxs("button", {
                  type: "button",
                  className: "t3e-fe-all-changes-btn",
                  onClick: openAllChanges,
                  title: isZh ? "打开侧边栏变更专栏查看全部 Diff" : "Open Changes diff view",
                  children: [
                    jsx(T3FeAllChangesIcon, {}),
                    jsx("span", { className: "t3e-fe-trunc", children: allChangesLabel }),
                    jsx("span", { className: "t3e-fe-count", children: totalChanges })
                  ]
                }),
                jsxs("div", {
                  className: "t3e-fe-section",
                  children: [
                    jsxs("button", {
                      type: "button",
                      className: "t3e-fe-sec-hdr",
                      "aria-expanded": changesOpen,
                      onClick: () => setChangesOpen((v) => !v),
                      children: [
                        jsx(T3FeChevron, { open: changesOpen }),
                        jsx("span", { className: "t3e-fe-trunc", children: changedFilesLabel }),
                        jsx("span", { className: "t3e-fe-dot", "aria-hidden": true })
                      ]
                    }),
                    changesOpen
                      ? jsx("div", {
                          className: "t3e-fe-changed-list",
                          children: treeNodes.length > 0
                            ? jsx(T3FeChangedTreeNodes, {
                                nodes: treeNodes,
                                depth: 1,
                                isSearching,
                                collapsedDirs,
                                onToggleDir: toggleDir,
                                normSelected,
                                onOpenFile,
                                openInDiffTitle,
                                openAllChanges
                              })
                            : jsx("div", {
                                className: "t3e-fe-empty",
                                children: isZh ? "无匹配的更改文件" : "No matching changed files"
                              })
                        })
                      : null
                  ]
                })
              ]
            })
          : null,
        showChangesSplit
          ? jsxs("button", {
              type: "button",
              className: "t3e-fe-sec-hdr t3e-fe-all-files-hdr",
              "aria-expanded": allFilesOpen,
              onClick: () => setAllFilesOpen((v) => !v),
              children: [
                jsx(T3FeChevron, { open: allFilesOpen }),
                jsx("span", { className: "t3e-fe-trunc", children: allFilesLabel })
              ]
            })
          : null,
        jsxs("div", {
          className: "flex min-h-0 flex-1 flex-col overflow-hidden",
          style: showChangesSplit && !allFilesOpen ? { display: "none" } : undefined,
          children: [errorNode, moreNode, loadingNode, allFilesNode]
        })
      ]
    });
  }

  return {
    t3NormalizeRelPath,
    t3BuildChangedFileTree,
    T3FeChangedTreeNodes,
    T3FilesChangesLayout,
  };
}

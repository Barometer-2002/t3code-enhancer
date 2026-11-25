"use strict";

const assert = require("node:assert/strict");

const ID = "inline-file-diff";
const MARKER = "T3_INLINE_FILE_DIFF_V8";
const LEGACY_MARKERS = ["T3_INLINE_FILE_DIFF_V1", "T3_INLINE_FILE_DIFF_V2", "T3_INLINE_FILE_DIFF_V3", "T3_INLINE_FILE_DIFF_V4", "T3_INLINE_FILE_DIFF_V5", "T3_INLINE_FILE_DIFF_V6", "T3_INLINE_FILE_DIFF_V7"];
const TARGET_REGEX = /^apps\/server\/dist\/client\/assets\/useTimelineFollow-[\w-]+\.js$/;
const ORIGINAL_HASH = "afeaa4340a84a41745b0133a8e552db55c821e68c9085de78e22f299cb6fde37";

const seAnchor =
  "let Se;t[186]!==be||t[187]!==xe?(Se=(0,$.jsx)(`div`,{className:`min-w-0 flex-1 overflow-hidden`,children:(0,$.jsxs)(`p`,{className:`flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed`,children:[be,xe]})}),t[186]=be,t[187]=xe,t[188]=Se):Se=t[188];";

function t3ParseUnifiedDiff(diffStr, oldStr, newStr) {
  const rows = [];
  let additions = 0;
  let deletions = 0;
  let isBinary = false;
  const splitNormalizedLines = (value) => {
    const lines = value.replace(/\r\n/g, "\n").split("\n");
    // Drop trailing single empty element from final newline
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const raw = typeof diffStr === "string" ? diffStr.replace(/\r\n/g, "\n") : "";

  if (raw.trim()) {
    const lines = splitNormalizedLines(raw);

    let oldLine = 1;
    let newLine = 1;
    let sawHunk = false;
    let inBinaryPatch = false;
    let hunkIndex = 0;

    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        sawHunk = false;
        inBinaryPatch = false;
        if (rows.length > 0) {
          rows.push({ kind: "hunk", lineNo: "···", sign: "", text: line.slice(11).trim() });
        }
        continue;
      }
      if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) {
        isBinary = true;
        inBinaryPatch = line.startsWith("GIT binary patch");
        continue;
      }
      if (inBinaryPatch) {
        continue;
      }
      if (
        !sawHunk &&
        (line.startsWith("index ") ||
          line.startsWith("new file mode") ||
          line.startsWith("deleted file mode") ||
          line.startsWith("old mode") ||
          line.startsWith("new mode") ||
          line.startsWith("rename from ") ||
          line.startsWith("rename to ") ||
          line.startsWith("copy from ") ||
          line.startsWith("copy to ") ||
          line.startsWith("similarity index ") ||
          line.startsWith("dissimilarity index ") ||
          line.startsWith("--- ") ||
          line.startsWith("+++ "))
      ) {
        continue;
      }
      const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/.exec(line);
      if (hunk) {
        sawHunk = true;
        if (hunkIndex > 0) {
          rows.push({ kind: "hunk", lineNo: "···", sign: "", text: hunk[3] ? hunk[3].trim() : "" });
        }
        const parsedOld = Number.parseInt(hunk[1], 10);
        const parsedNew = Number.parseInt(hunk[2], 10);
        oldLine = Number.isNaN(parsedOld) ? 1 : parsedOld;
        newLine = Number.isNaN(parsedNew) ? 1 : parsedNew;
        hunkIndex++;
        continue;
      }
      if (line.startsWith("\\ No newline at end of file")) {
        continue;
      }
      if (line.startsWith("+") && (sawHunk || !line.startsWith("+++"))) {
        additions++;
        rows.push({ kind: "add", lineNo: String(newLine++), sign: "+", text: line.slice(1) });
      } else if (line.startsWith("-") && (sawHunk || !line.startsWith("---"))) {
        deletions++;
        rows.push({ kind: "del", lineNo: String(oldLine++), sign: "-", text: line.slice(1) });
      } else if (sawHunk || line.startsWith(" ")) {
        rows.push({
          kind: "ctx",
          lineNo: String(newLine),
          sign: " ",
          text: line.startsWith(" ") ? line.slice(1) : line,
        });
        oldLine++;
        newLine++;
      } else {
        rows.push({ kind: "ctx", lineNo: String(newLine++), sign: " ", text: line });
      }
    }
  } else if (typeof oldStr === "string" || typeof newStr === "string") {
    if (typeof oldStr === "string" && oldStr.length > 0) {
      const oldLines = splitNormalizedLines(oldStr);
      oldLines.forEach((text, idx) => {
        deletions++;
        rows.push({ kind: "del", lineNo: String(idx + 1), sign: "-", text });
      });
    }
    if (typeof newStr === "string" && newStr.length > 0) {
      const newLines = splitNormalizedLines(newStr);
      newLines.forEach((text, idx) => {
        additions++;
        rows.push({ kind: "add", lineNo: String(idx + 1), sign: "+", text });
      });
    }
  }

  return { rows, additions, deletions, isBinary };
}

function t3CheckpointPath(path, roots) {
  const normalize = (value) => String(value ?? "").replaceAll("\\", "/").replace(/^\/(?=[a-z]:)/i, "").replace(/^\.\//, "");
  const file = normalize(path);
  if (!/^(?:[a-z]:|\/)/i.test(file)) return file;
  const windows = /^[a-z]:/i.test(file);
  for (const value of roots) {
    const root = normalize(value).replace(/\/+$/, "");
    if (root && (windows ? file.toLowerCase().startsWith(root.toLowerCase() + "/") : file.startsWith(root + "/"))) {
      return file.slice(root.length + 1);
    }
  }
  return "";
}

function t3SelectCheckpointFilePatch(diff, path, parse) {
  if (!diff || !path) return null;
  for (const patch of diff.split(/(?=^diff --git )/m)) {
    const parsed = parse(patch, "inline-checkpoint");
    if (parsed?.kind === "files" && parsed.files.some((file) => file.name === path || file.prevName === path)) {
      return patch;
    }
  }
  return null;
}

function buildInjectedComponents() {
  return `
/* ${MARKER} */
${t3ParseUnifiedDiff.toString()}
${t3CheckpointPath.toString()}
${t3SelectCheckpointFilePatch.toString()}

function t3EnsureDiffStyles() {
  if (typeof document === "undefined" || !document.head || document.getElementById("t3e-inline-diff-style")) return;
  const st = document.createElement("style");
  st.id = "t3e-inline-diff-style";
  st.textContent = \`
.t3e-fc-row{display:flex;align-items:baseline;gap:6px;min-width:0;width:100%;font-size:14px;line-height:1.5;margin:0}
.t3e-fc-verb{flex:0 0 auto;color:var(--foreground)}
.t3e-fc-link{color:var(--primary,#3b82f6);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3e-fc-stats{display:inline-flex;align-items:baseline;gap:4px;font-family:var(--font-mono);font-size:12px;flex:0 0 auto}
.t3e-fc-add{color:#15803d}
.t3e-fc-del{color:#dc2626}
.t3e-diff-card{border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--card,var(--background))}
.t3e-diff-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border)}
.t3e-diff-header-left{display:flex;align-items:baseline;gap:8px;min-width:0;flex:1}
.t3e-diff-title{font-family:var(--font-mono);font-size:12px;line-height:1.4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:transparent;border:0;padding:0;text-align:left;cursor:pointer}
.t3e-diff-header-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
.t3e-diff-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;border:0;background:transparent;color:var(--muted-foreground);cursor:pointer}
.t3e-diff-icon-btn:hover{background:var(--accent);color:var(--foreground)}
.t3e-diff-btn-icon{width:14px;height:14px}
.t3e-diff-body{overflow-x:auto;font-family:var(--font-mono);font-size:12px;line-height:1.5}
.t3e-diff-line{display:grid;grid-template-columns:42px 18px minmax(0,1fr);padding:0 8px}
.t3e-diff-line.is-add{background:rgba(22,163,74,.1)}
.t3e-diff-line.is-del{background:rgba(220,38,38,.1)}
.t3e-diff-line.is-hunk{color:var(--muted-foreground);background:var(--muted)}
.t3e-diff-ln{opacity:.55;user-select:none;text-align:right;padding-right:8px}
.t3e-diff-sign{user-select:none}
.t3e-diff-code{white-space:pre}
.t3e-diff-more{width:100%;padding:6px 10px;border:0;border-top:1px solid var(--border);background:transparent;color:var(--primary,#3b82f6);font-size:12px;cursor:pointer;text-align:left}
.t3e-diff-changes-list{padding:8px 10px;font-family:var(--font-mono);font-size:12px}
\`;
  document.head.appendChild(st);
}

function T3DiffCopyIcon() {
  return (0, $.jsxs)("svg", {
    className: "t3e-diff-btn-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    children: [
      (0, $.jsx)("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
      (0, $.jsx)("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
    ]
  });
}

function T3DiffSideIcon() {
  return (0, $.jsxs)("svg", {
    className: "t3e-diff-btn-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    children: [
      (0, $.jsx)("rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }),
      (0, $.jsx)("path", { d: "M15 4v16" })
    ]
  });
}

function t3IsZhLocale() {
  return typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
}

function t3ShortFileName(relPath) {
  const s = String(relPath || "").replace(/\\\\/g, "/");
  const idx = s.lastIndexOf("/");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function T3FileChangeRowLabel({ projectedItem, workspaceRoot, fallbackNode, expanded }) {
  Z.useEffect(t3EnsureDiffStyles, []);
  const item = projectedItem?.item;
  const isFileChange = Boolean(item && item.type === "file_change");
  const needsDiffParse = isFileChange && (item.additions === void 0 || item.deletions === void 0);
  const parsed = Z.useMemo(
    () => (needsDiffParse ? t3ParseUnifiedDiff(item.diffStr, item.oldStr, item.newStr) : null),
    [needsDiffParse, item?.diffStr, item?.oldStr, item?.newStr]
  );
  if (!isFileChange) return fallbackNode;

  const isZh = t3IsZhLocale();
  const rawPath = item.fileName || item.changes?.[0]?.path || "";
  const relPath = rawPath ? Xr(rawPath, workspaceRoot) : "";
  const shortName = t3ShortFileName(relPath) || relPath;
  const adds = item.additions !== void 0 ? item.additions : (parsed ? parsed.additions : 0);
  const dels = item.deletions !== void 0 ? item.deletions : (parsed ? parsed.deletions : 0);
  const showStats = adds > 0 || dels > 0;
  const op = item.changes?.[0]?.operation;
  const verb = expanded
    ? (isZh ? "已编辑的文件" : "Edited file")
    : op === "add"
      ? (isZh ? "已新建" : "Created")
      : op === "delete"
        ? (isZh ? "已删除" : "Deleted")
        : (isZh ? "已编辑" : "Edited");

  return (0, $.jsx)("div", {
    className: "min-w-0 flex-1 overflow-hidden",
    children: (0, $.jsxs)("p", {
      className: "t3e-fc-row",
      children: [
        (0, $.jsx)("span", { className: "t3e-fc-verb", children: verb }),
        !expanded && relPath
          ? (0, $.jsx)("span", {
              className: "t3e-fc-link",
              children: shortName,
            })
          : null,
        !expanded && showStats
          ? (0, $.jsxs)("span", {
              className: "t3e-fc-stats",
              children: [
                adds > 0
                  ? (0, $.jsxs)("span", { className: "t3e-fc-add", children: ["+", io(adds)] })
                  : null,
                dels > 0
                  ? (0, $.jsxs)("span", { className: "t3e-fc-del", children: ["-", io(dels)] })
                  : null,
              ],
            })
          : null,
      ],
    }),
  });
}

function T3InlineFileDiffCard({ item, projectedItem, detail, workspaceRoot, cwd, onOpenToolDiff }) {
  const [copied, setCopied] = Z.useState(false);
  const copyTimerRef = Z.useRef(null);
  Z.useEffect(() => {
    if (typeof t3EnsureDiffStyles === "function") t3EnsureDiffStyles();
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);
  const isZh = t3IsZhLocale();
  const rawPath = item.fileName || item.changes?.[0]?.path || "";
  const relPath = rawPath ? Xr(rawPath, workspaceRoot) : "";
  const shortName = t3ShortFileName(relPath) || relPath;
  const recorded = Z.useMemo(
    () => t3ParseUnifiedDiff(item.diffStr, item.oldStr, item.newStr),
    [item.diffStr, item.oldStr, item.newStr]
  );
  const turnId = item.runId ?? projectedItem?.item?.runId ?? null;
  const checkpointPath = t3CheckpointPath(rawPath, [cwd, workspaceRoot]);
  const environmentId = detail?.environmentId ?? null;
  const threadId = projectedItem?.sourceThreadId ?? null;
  const useCheckpoint = Boolean(turnId && checkpointPath && !detail?.pending && !recorded.isBinary && recorded.rows.length === 0);
  const threadRef = Z.useMemo(
    () => useCheckpoint && environmentId && threadId ? { environmentId, threadId } : null,
    [useCheckpoint, environmentId, threadId]
  );
  const checkpoints = T3UseCheckpointSummaries(threadRef);
  const count = checkpoints.find((checkpoint) => checkpoint.runId === turnId)?.checkpointTurnCount;
  const toTurnCount = Number.isInteger(count) && count > 0 ? count : null;
  const turnDiff = T3UseCheckpointDiff({
    environmentId: threadRef?.environmentId ?? null,
    threadId: threadRef?.threadId ?? null,
    fromTurnCount: toTurnCount === null ? null : toTurnCount - 1,
    toTurnCount,
    ignoreWhitespace: false
  }, { enabled: threadRef !== null && toTurnCount !== null });
  const checkpointPatch = Z.useMemo(
    () => threadRef ? t3SelectCheckpointFilePatch(turnDiff.data?.diff, checkpointPath, T3ParseCheckpointDiff) : null,
    [threadRef, turnDiff.data?.diff, checkpointPath]
  );
  const checkpointDiff = Z.useMemo(() => checkpointPatch ? t3ParseUnifiedDiff(checkpointPatch) : null, [checkpointPatch]);
  const parsed = checkpointDiff ?? recorded;
  const adds = checkpointDiff ? parsed.additions : item.additions ?? parsed.additions;
  const dels = checkpointDiff ? parsed.deletions : item.deletions ?? parsed.deletions;
  const showStats = adds > 0 || dels > 0;
  const copySource = checkpointPatch || (typeof item.diffStr === "string" && item.diffStr.trim() ? item.diffStr : "") || item.newStr || item.oldStr || "";
  Z.useEffect(() => {
    setCopied(false);
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, [copySource]);

  const openSideDiff = (ev) => {
    ev?.stopPropagation?.();
    if (typeof onOpenToolDiff === "function" && projectedItem?.sourceThreadId && projectedItem?.sourceItemId) {
      const revealRequestId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : String(Date.now()) + "-" + Math.random().toString(36).slice(2);
      const payload = {
        threadId: projectedItem.sourceThreadId,
        itemId: projectedItem.sourceItemId,
        revision: Ua(projectedItem.item),
        filePath: checkpointPath || relPath,
        revealRequestId,
      };
      if (turnId) payload.turnId = turnId;
      if (!detail?.pending && recorded.rows.length === 0) payload.preferGitFallback = true;
      onOpenToolDiff(payload);
    }
  };

  const handleCopy = (ev) => {
    ev.stopPropagation();
    if (!copySource || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(copySource).then(() => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 1400);
    }).catch(() => {});
  };

  const previewRowLimit = 320;
  const visibleRows = parsed.rows.slice(0, previewRowLimit);
  const hiddenCount = parsed.rows.length - visibleRows.length;

  return (0, $.jsxs)("div", {
    className: "t3e-diff-card",
    "data-v2-item-inspector": "file_change",
    onClick: (ev) => ev.stopPropagation(),
    children: [
      (0, $.jsxs)("div", {
        className: "t3e-diff-header",
        children: [
          (0, $.jsxs)("div", {
            className: "t3e-diff-header-left",
            children: [
              typeof onOpenToolDiff === "function"
                ? (0, $.jsx)("button", {
                    type: "button",
                    className: "t3e-fc-link t3e-diff-title",
                    title: relPath || shortName,
                    onClick: openSideDiff,
                    children: relPath || shortName,
                  })
                : (0, $.jsx)("span", { className: "t3e-diff-title", title: relPath, children: relPath || shortName }),
              showStats
                ? (0, $.jsxs)("span", {
                    className: "t3e-fc-stats",
                    children: [
                      adds > 0
                        ? (0, $.jsxs)("span", { className: "t3e-fc-add", children: ["+", io(adds)] })
                        : null,
                      dels > 0
                        ? (0, $.jsxs)("span", { className: "t3e-fc-del", children: ["-", io(dels)] })
                        : null,
                    ],
                  })
                : null,
              checkpointDiff
                ? (0, $.jsx)("span", {
                    className: "shrink-0 text-[11px] text-muted-foreground",
                    children: isZh ? "本轮 Git 变更" : "Turn Git diff"
                  })
                : null,
            ],
          }),
          (0, $.jsxs)("div", {
            className: "t3e-diff-header-actions",
            children: [
              copySource
                ? (0, $.jsx)("button", {
                    type: "button",
                    className: "t3e-diff-icon-btn",
                    title: copied ? (isZh ? "已复制" : "Copied") : (isZh ? "复制变更内容" : "Copy diff"),
                    "aria-label": isZh ? "复制变更内容" : "Copy diff",
                    onClick: handleCopy,
                    children: copied ? "✓" : (0, $.jsx)(T3DiffCopyIcon, {}),
                  })
                : null,
              typeof onOpenToolDiff === "function"
                ? (0, $.jsx)("button", {
                    type: "button",
                    className: "t3e-diff-icon-btn",
                    title: isZh ? "在右侧边栏查看变更" : "Open in side Diff panel",
                    "aria-label": isZh ? "在右侧边栏查看变更" : "Open in side Diff panel",
                    onClick: openSideDiff,
                    children: (0, $.jsx)(T3DiffSideIcon, {}),
                  })
                : null,
            ],
          }),
        ],
      }),
      visibleRows.length > 0
        ? (0, $.jsxs)("div", {
            className: "t3e-diff-body",
            children: [
              visibleRows.map((row, idx) =>
                (0, $.jsxs)(
                  "div",
                  {
                    className: \`t3e-diff-line is-\${row.kind}\`,
                    children: [
                      (0, $.jsx)("span", { className: "t3e-diff-ln", children: row.lineNo }),
                      (0, $.jsx)("span", { className: "t3e-diff-sign", children: row.sign }),
                      (0, $.jsx)("span", { className: "t3e-diff-code", children: row.text || " " }),
                    ],
                  },
                  idx
                )
              ),
              hiddenCount > 0 && typeof onOpenToolDiff === "function"
                ? (0, $.jsx)("button", {
                    type: "button",
                    className: "t3e-diff-more",
                    onClick: openSideDiff,
                    children: isZh
                      ? \`在侧栏查看剩余 \${hiddenCount} 行\`
                      : \`View \${hiddenCount} more lines in the side panel\`,
                  })
                : null,
            ],
          })
        : (0, $.jsxs)("div", {
            className: "t3e-diff-changes-list",
            children: [
              Array.isArray(item.changes) && item.changes.length > 0
                ? (0, $.jsx)("ul", {
                    style: { margin: "0 0 6px", padding: 0, listStyle: "none" },
                    children: item.changes.map((c, idx) =>
                      (0, $.jsxs)(
                        "li",
                        {
                          children: [
                            c.operation,
                            " ",
                            c.oldPath ? \`\${Xr(c.oldPath, workspaceRoot)} → \` : "",
                            Xr(c.path, workspaceRoot),
                          ],
                        },
                        idx + ":" + JSON.stringify([c.operation, c.oldPath, c.path])
                      )
                    ),
                  })
                : null,
              (0, $.jsx)("div", {
                role: "status",
                style: { opacity: 0.72, fontFamily: "var(--font-sans)" },
                children: detail?.pending || (toTurnCount !== null && turnDiff.isPending)
                  ? (isZh ? "正在加载此次编辑的 Diff…" : "Loading the diff for this edit…")
                  : detail?.error
                    ? (isZh ? "无法读取此次编辑的 Diff。" : "Could not load the diff for this edit.")
                    : parsed.isBinary
                      ? (isZh ? "二进制文件已变更（不支持行级内联 Diff）。" : "Binary file changed (no line-level diff).")
                      : (isZh ? "此次编辑记录没有逐行 Diff。" : "No line-level diff was recorded for this edit."),
              }),
            ],
          }),
    ],
  });
}
const t3DiffMemo = (fn) => (typeof Z !== "undefined" && typeof Z.memo === "function" ? (0, Z.memo)(fn) : fn);
const T3FileChangeRowLabelMemo = t3DiffMemo(T3FileChangeRowLabel);
const T3InlineFileDiffCardMemo = t3DiffMemo(T3InlineFileDiffCard);
`;
}

function apply(source) {
  const seReplacement =
    seAnchor +
    "if(n.projectedItem?.item?.type===`file_change`){Se=(0,$.jsx)(T3FileChangeRowLabelMemo,{projectedItem:n.projectedItem,workspaceRoot:r,fallbackNode:Se,expanded:b});}";

  const detailGate = "c=!a&&Fa(s),i[0]=a,i[1]=s,i[2]=c";
  const detailPanel = "o=a.item,s=a.output;wd(i||s.pending,e.onInitialOutputReady);";
  for (const anchor of [seAnchor, detailGate, detailPanel]) {
    assert(source.includes(anchor) && source.indexOf(anchor) === source.lastIndexOf(anchor),
      "Could not uniquely locate the timeline edit inspector");
  }
  const checkpointImports =
    'import{A as T3UseCheckpointSummaries}from"./entities-Y4q5SLTL.js";' +
    'import{t as T3UseCheckpointDiff}from"./queries-XZRbm-wI.js";' +
    'import{c as T3ParseCheckpointDiff}from"./diffRendering-V1eQtYIe.js";';
  const patched = source
    .replace(detailGate, () => "c=!a&&(Fa(s)||s.type===`file_change`),i[0]=a,i[1]=s,i[2]=c")
    .replace(detailPanel, () => detailPanel +
      "if(o.type===`file_change`)return(0,$.jsx)(T3InlineFileDiffCardMemo,{item:o,projectedItem:e.projectedItem,detail:s,workspaceRoot:e.workspaceRoot,cwd:e.cwd,onOpenToolDiff:e.onOpenToolDiff});")
    .replace(seAnchor, () => seReplacement);
  return checkpointImports + patched.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "") + "\n" + buildInjectedComponents() + "\n";
}

const SIDE_REVEAL_MARKER = "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V4";

function t3NormDiffPath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/^\/(?=[a-z]:)/i, "");
}

function t3DiffMatchesTarget(file, target, workspaceRoot) {
  let left = t3NormDiffPath(file);
  let right = t3NormDiffPath(target);
  if (!right) return true;
  const windowsPath = /^(?:[a-z]:\/|\/\/)/i;
  if ([left, right, t3NormDiffPath(workspaceRoot)].some((value) => windowsPath.test(value))) {
    left = left.toLowerCase();
    right = right.toLowerCase();
  }
  const isAbsolute = (value) => value.startsWith("/") || windowsPath.test(value);
  if (isAbsolute(left) && !isAbsolute(right)) return left.endsWith("/" + right);
  if (isAbsolute(right) && !isAbsolute(left)) return right.endsWith("/" + left);
  return left === right;
}

function buildSideRevealHelpers() {
  return [
    t3NormDiffPath.toString(),
    t3DiffMatchesTarget.toString(),
    "function t3PatchHasFile(e,t,n,r){if(!e||typeof e!==`string`||!e.trim())return!1;let i=it(e,`t3-diff-probe`,{ignoreWhitespace:n},r);if(!i||i.kind!==`files`||i.files.length===0)return!1;return!t||i.files.some(e=>t3DiffMatchesTarget(M(e),t,r))}",
    "function t3PickToolDiffFallback(e){let{rawZ:t,sn:n,cn:r,I:i,f:a,O:o,ln:s,P:c,N:l,V:u}=e;if(!t)return null;let d=t.filePath?t3NormDiffPath(t.filePath):null;if(r?.type===`file_change`&&typeof r.diffStr==`string`&&r.diffStr.trim()){let e=Ut(r,i,a),n=e?.patch?it(e.patch,`t3-tool-probe`,{ignoreWhitespace:o},a):null;if(n?.kind===`files`&&n.files.length>0){if(!d||(n.files.length===1&&(r.changes?.length??0)<=1&&!e?.truncated)||n.files.some(e=>t3DiffMatchesTarget(M(e),d,a)))return null}}if(!t.preferGitFallback&&n.isPending)return null;let p=t.turnId??r?.runId??null,m=s&&p?u.find(e=>e.runId===p)??null:null,h=Boolean(s&&c&&l!=null&&i!=null);return m?{mode:`turn`,turn:m,turnId:m.runId,canUnstaged:h}:h?{mode:`unstaged`,turn:null,turnId:null,canUnstaged:!0}:null}",
  ].join("\n");
}

module.exports = {
  id: ID,
  name: "文件编辑内联 Diff 预览与侧栏定位",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  apply,
  t3ParseUnifiedDiff,
  sideRevealPatch: {
    id: "inline-file-diff-side-reveal",
    name: "侧栏展开此次编辑的 Diff",
    marker: SIDE_REVEAL_MARKER,
    legacyMarkers: ["T3_INLINE_FILE_DIFF_SIDE_REVEAL_V1", "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V2", "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V3"],
    targetRegex: /^apps\/server\/dist\/client\/assets\/DiffPanel-[\w-]+\.js$/,
    originalHash: "0b4d7099ae3a38d2ea760fc7f8cc6ae99d04ba00a2115647bb3e772876b8d846",
    apply(source) {
      const selection =
        "let hn=R.kind===`turn`?R.turnId:null,H=R.kind===`unstaged`||R.kind===`commit`?R.kind:`branch`,U=R.kind===`commit`?R.sha:null,W=R.kind===`branch`||R.kind===`commit`?R.baseRef:null,Fn=R.kind===`turn`?R.filePath??null:null,In=R.kind===`turn`?R.revealRequestId:0";
      const turnFetchTail = "let Zn=ft(Jn,Xn),Qn=";
      const hideFilter = "li=e=>{let t=M(e);return!k||t===Fn||!yt(t)}";
      const reveal = "if(!Fn){Mi.current=null;return}let e=JSON.stringify([K,Fn,In]);Mi.current!==e&&ji(Fn)&&(Mi.current=e)";
      const exportAnchor = "export{H as default};";
      for (const anchor of [selection, turnFetchTail, hideFilter, reveal, exportAnchor]) {
        assert(source.includes(anchor) && source.indexOf(anchor) === source.lastIndexOf(anchor), "Could not locate the Diff panel file reveal");
      }
      return source
        .replace(
          selection,
          () =>
            `/* ${SIDE_REVEAL_MARKER} */let t3RawZ=z,t3Fb=t3PickToolDiffFallback({rawZ:t3RawZ,sn:sn,cn:cn,I:I,f:f,O:O,ln:ln,P:P,N:N,V:V}),t3GitMode=t3Fb?.mode??null;if(t3GitMode===\`unstaged\`){B=!0;z=null;en=Yt}else if(t3GitMode===\`turn\`){B=!1;z=null;en=Yt}let hn=R.kind===\`turn\`?R.turnId:t3Fb?.turnId??null,H=t3GitMode===\`unstaged\`?\`unstaged\`:R.kind===\`unstaged\`||R.kind===\`commit\`?R.kind:\`branch\`,U=R.kind===\`commit\`?R.sha:null,W=R.kind===\`branch\`||R.kind===\`commit\`?R.baseRef:null,Fn=t3RawZ?.revealRequestId?(t3RawZ.filePath?t3NormDiffPath(t3RawZ.filePath):null):R.kind===\`turn\`?R.filePath??null:null,In=t3RawZ?.revealRequestId??(R.kind===\`turn\`?R.revealRequestId:0)`
        )
        .replace(
          turnFetchTail,
          () =>
            "let Zn=ft(Jn,Xn);if(t3GitMode===`turn`&&!Zn.isPending&&(Zn.error||!t3PatchHasFile(Zn.data?.diff,Fn,O,f))&&t3Fb.canUnstaged){t3GitMode=`unstaged`;B=!0;H=`unstaged`;G=void 0;hn=null;Bn=`unstaged`;K=j?`${j.environmentId}:${j.threadId}:${Bn}`:null;Vn=K??Bn}let Qn="
        )
        .replace(
          hideFilter,
          () => "li=e=>{let t=M(e);return!k||(Boolean(Fn)&&t3DiffMatchesTarget(t,Fn,f))||!yt(t)}"
        )
        .replace(
          reveal,
          () =>
            "let path=(()=>{if(!t3RawZ?.revealRequestId)return Fn;let hit=Fn?ai.find(x=>M(x.fileDiff)===Fn)||ai.find(x=>t3DiffMatchesTarget(M(x.fileDiff),Fn,f)):ai[0];return hit?M(hit.fileDiff):!t3GitMode&&ai.length===1?M(ai[0].fileDiff):Fn})();if(!path){Mi.current=null;return}let e=JSON.stringify([K,path,In]);Mi.current!==e&&ji(path)&&(Mi.current=e)"
        )
        .replace(
          exportAnchor,
          () => buildSideRevealHelpers() + "\n" + exportAnchor
        )
        .replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "");
    },
  },
  quietReviewToastPatch: {
    id: "inline-file-diff-quiet-review-toast",
    name: "屏蔽后台 Diff 预览慢请求弹窗",
    marker: "T3_QUIET_REVIEW_SLOW_TOAST_V1",
    legacyMarkers: [],
    targetRegex: /^apps\/server\/dist\/client\/assets\/runtime-DLJNEawq\.js$/,
    originalHash: "199c4d57a2df75076060ab094c2d63ecd8e903b9e851189c6323207f5c7f1fe1",
    apply(source) {
      const anchor = "function b_(e){return!e.includes(`subscribe`)&&!e.startsWith(`pullRequests.`)&&!h_.has(e)}";
      assert(source.includes(anchor) && source.indexOf(anchor) === source.lastIndexOf(anchor), "Could not locate slow RPC request filter in runtime bundle");
      return source
        .replace(
          anchor,
          () => "function b_(e){/* T3_QUIET_REVIEW_SLOW_TOAST_V1 */return!e.includes(`subscribe`)&&!e.startsWith(`pullRequests.`)&&!e.startsWith(`review.`)&&!h_.has(e)}"
        )
        .replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "");
    },
  },
};

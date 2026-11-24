"use strict";

const assert = require("node:assert/strict");

const ID = "inline-file-diff";
const MARKER = "T3_INLINE_FILE_DIFF_V4";
const TARGET_REGEX = /^apps\/server\/dist\/client\/assets\/useTimelineFollow-[\w-]+\.js$/;
const ORIGINAL_HASH = "afeaa4340a84a41745b0133a8e552db55c821e68c9085de78e22f299cb6fde37";

const fcStartAnchor =
  "let u;t[17]!==o||t[18]!==e?(u=o.type===`file_change`?";
const fcEndAnchor =
  "):null,t[17]=o,t[18]=e,t[19]=u):u=t[19];";

const seAnchor =
  "let Se;t[186]!==be||t[187]!==xe?(Se=(0,$.jsx)(`div`,{className:`min-w-0 flex-1 overflow-hidden`,children:(0,$.jsxs)(`p`,{className:`flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed`,children:[be,xe]})}),t[186]=be,t[187]=xe,t[188]=Se):Se=t[188];";

function t3ParseUnifiedDiff(diffStr, oldStr, newStr) {
  const rows = [];
  let additions = 0;
  let deletions = 0;
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
    let hunkIndex = 0;

    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        sawHunk = false;
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
          line.startsWith("GIT binary patch") ||
          line.startsWith("Binary files ") ||
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

  return { rows, additions, deletions };
}

function buildInjectedComponents() {
  return `
/* ${MARKER} */
${t3ParseUnifiedDiff.toString()}

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
  const item = projectedItem?.item;
  if (!item || item.type !== "file_change") return fallbackNode;

  const isZh = t3IsZhLocale();
  const rawPath = item.fileName || item.changes?.[0]?.path || "";
  const relPath = rawPath ? Xr(rawPath, workspaceRoot) : "";
  const shortName = t3ShortFileName(relPath) || relPath;
  const parsed = item.additions === void 0 || item.deletions === void 0
    ? t3ParseUnifiedDiff(item.diffStr, item.oldStr, item.newStr)
    : null;
  const adds = item.additions !== void 0 ? item.additions : (parsed ? parsed.additions : 0);
  const dels = item.deletions !== void 0 ? item.deletions : (parsed ? parsed.deletions : 0);
  const showStats = (item.additions !== void 0 || item.deletions !== void 0 || (parsed && (parsed.additions > 0 || parsed.deletions > 0))) && (adds > 0 || dels > 0);
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

function T3InlineFileDiffCard({ item, projectedItem, detail, workspaceRoot, onOpenToolDiff }) {
  const [copied, setCopied] = Z.useState(false);
  const copyTimerRef = Z.useRef(null);
  Z.useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);
  const isZh = t3IsZhLocale();
  const rawPath = item.fileName || item.changes?.[0]?.path || "";
  const relPath = rawPath ? Xr(rawPath, workspaceRoot) : "";
  const shortName = t3ShortFileName(relPath) || relPath;
  const parsed = Z.useMemo(
    () => t3ParseUnifiedDiff(item.diffStr, item.oldStr, item.newStr),
    [item.diffStr, item.oldStr, item.newStr]
  );
  const adds = item.additions !== void 0 ? item.additions : parsed.additions;
  const dels = item.deletions !== void 0 ? item.deletions : parsed.deletions;
  const showStats = (item.additions !== void 0 || item.deletions !== void 0 || adds > 0 || dels > 0) && (adds > 0 || dels > 0);
  const copySource = (typeof item.diffStr === "string" && item.diffStr.trim() ? item.diffStr : "") || item.newStr || item.oldStr || "";

  const openSideDiff = (ev) => {
    ev?.stopPropagation?.();
    if (typeof onOpenToolDiff === "function" && projectedItem?.sourceThreadId && projectedItem?.sourceItemId) {
      onOpenToolDiff({
        threadId: projectedItem.sourceThreadId,
        itemId: projectedItem.sourceItemId,
        revision: Ua(projectedItem.item),
        filePath: relPath,
        revealRequestId: crypto.randomUUID(),
      });
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
                            c.oldPath ? \`\${c.oldPath} → \` : "",
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
                children: detail?.pending
                  ? (isZh ? "正在加载此次编辑的 Diff…" : "Loading the diff for this edit…")
                  : detail?.error
                    ? (isZh ? "无法读取此次编辑的 Diff。" : "Could not load the diff for this edit.")
                    : (isZh ? "此次编辑记录没有逐行 Diff。" : "No line-level diff was recorded for this edit."),
              }),
            ],
          }),
    ],
  });
}
`;
}

function apply(source) {
  const iFc = source.indexOf(fcStartAnchor);
  assert(iFc >= 0 && iFc === source.lastIndexOf(fcStartAnchor), "Could not uniquely locate file_change start anchor in timeline bundle");
  const iFcEnd = source.indexOf(fcEndAnchor, iFc);
  assert(iFcEnd > iFc && iFcEnd === source.indexOf(fcEndAnchor, iFc + fcStartAnchor.length), "Could not locate file_change end anchor in timeline bundle");
  assert(source.includes(seAnchor) && source.indexOf(seAnchor) === source.lastIndexOf(seAnchor), "Could not uniquely locate Se work-entry label anchor in timeline bundle");

  const fcReplacement =
    "let u;t[17]!==o||t[18]!==e||t[74]!==s?(u=o.type===`file_change`?(0,$.jsx)(T3InlineFileDiffCard,{item:o,projectedItem:e.projectedItem,detail:s,workspaceRoot:e.workspaceRoot,onOpenToolDiff:e.onOpenToolDiff}):null,t[17]=o,t[18]=e,t[19]=u,t[74]=s):u=t[19];";

  const seReplacement =
    seAnchor +
    "if(n.projectedItem?.item?.type===`file_change`){Se=(0,$.jsx)(T3FileChangeRowLabel,{projectedItem:n.projectedItem,workspaceRoot:r,fallbackNode:Se,expanded:b});}";

  let patched =
    source.slice(0, iFc) +
    fcReplacement +
    source.slice(iFcEnd + fcEndAnchor.length);

  const detailGate = "c=!a&&Fa(s),i[0]=a,i[1]=s,i[2]=c";
  assert(patched.includes(detailGate) && patched.indexOf(detailGate) === patched.lastIndexOf(detailGate),
    "Could not uniquely locate the timeline's on-demand detail gate");
  const detailPanel = "var o_=(0,Z.memo)(function(e){let t=(0,Q.c)(74)";
  assert(patched.includes(detailPanel) && patched.indexOf(detailPanel) === patched.lastIndexOf(detailPanel),
    "Could not locate the timeline detail panel memo slots");
  patched = patched
    .replace(detailGate, () => "c=!a&&(Fa(s)||s.type===`file_change`),i[0]=a,i[1]=s,i[2]=c")
    .replace(detailPanel, () => "var o_=(0,Z.memo)(function(e){let t=(0,Q.c)(75)")
    .replace(seAnchor, () => seReplacement);
  patched = patched.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "") + "\n" + buildInjectedComponents() + "\n";
  return patched;
}

const SIDE_REVEAL_MARKER = "T3_INLINE_FILE_DIFF_SIDE_REVEAL_V2";

module.exports = {
  id: ID,
  name: "文件编辑内联 Diff 预览与侧栏定位",
  marker: MARKER,
  legacyMarkers: ["T3_INLINE_FILE_DIFF_V1", "T3_INLINE_FILE_DIFF_V2", "T3_INLINE_FILE_DIFF_V3"],
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  apply,
  t3ParseUnifiedDiff,
  sideRevealPatch: {
    id: "inline-file-diff-side-reveal",
    name: "侧栏展开此次编辑的 Diff",
    marker: SIDE_REVEAL_MARKER,
    legacyMarkers: ["T3_INLINE_FILE_DIFF_SIDE_REVEAL_V1"],
    targetRegex: /^apps\/server\/dist\/client\/assets\/DiffPanel-[\w-]+\.js$/,
    originalHash: "0b4d7099ae3a38d2ea760fc7f8cc6ae99d04ba00a2115647bb3e772876b8d846",
    apply(source) {
      const selection = "Fn=R.kind===`turn`?R.filePath??null:null,In=R.kind===`turn`?R.revealRequestId:0";
      const hideFilter = "li=e=>{let t=M(e);return!k||t===Fn||!yt(t)}";
      const reveal = "if(!Fn){Mi.current=null;return}let e=JSON.stringify([K,Fn,In]);Mi.current!==e&&ji(Fn)&&(Mi.current=e)";
      for (const anchor of [selection, hideFilter, reveal]) {
        assert(source.includes(anchor) && source.indexOf(anchor) === source.lastIndexOf(anchor), "Could not locate the Diff panel file reveal");
      }
      return source
        .replace(
          selection,
          () => `/* ${SIDE_REVEAL_MARKER} */Fn=z?.revealRequestId?(z.filePath?String(z.filePath).replaceAll(\`\\\\\`,\`/\`).replace(/^\\.\\//,\`\`):null):R.kind===\`turn\`?R.filePath??null:null,In=z?.revealRequestId??(R.kind===\`turn\`?R.revealRequestId:0)`
        )
        .replace(
          hideFilter,
          () => "li=e=>{let t=M(e),n=p=>String(p??``).replaceAll(`\\\\`, `/`).replace(/^\\.\\//,``),nt=n(t),nf=n(Fn);return!k||t===Fn||(Boolean(nf)&&(nt===nf||nt.endsWith(`/`+nf)||nf.endsWith(`/`+nt)))||!yt(t)}"
        )
        .replace(
          reveal,
          () => "let path=(()=>{if(!z?.revealRequestId)return Fn;let n=p=>String(p??``).replaceAll(`\\\\`, `/`).replace(/^\\.\\//,``),nf=n(Fn),hit=nf?ai.find(x=>M(x.fileDiff)===Fn)||ai.find(x=>n(M(x.fileDiff))===nf)||ai.find(x=>{let mp=n(M(x.fileDiff));return mp.endsWith(`/${nf}`)||nf.endsWith(`/${mp}`)}):ai[0];return hit?M(hit.fileDiff):ai.length===1?M(ai[0].fileDiff):Fn})();if(!path){Mi.current=null;return}let e=JSON.stringify([K,path,In]);Mi.current!==e&&ji(path)&&(Mi.current=e)"
        )
        .replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "");
    },
  },
};

/**
 * External ESM runtime for inline-file-diff and side-reveal enhancements.
 * Clean ESM without minified host variable names.
 */

export function t3ParseUnifiedDiff(diffStr, oldStr, newStr, maxRows = Infinity) {
  const rows = [];
  let rowCount = 0;
  let additions = 0;
  let deletions = 0;
  let isBinary = false;
  const appendRow = (kind, lineNo, sign, text, skip = 0) => {
    rowCount++;
    if (rows.length < maxRows) {
      rows.push({ kind, lineNo: String(lineNo), sign, text: skip ? text.slice(skip) : text });
    }
  };
  const splitNormalizedLines = (value) => {
    const lines = value.replace(/\r\n/g, "\n").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const raw = typeof diffStr === "string" ? diffStr : "";

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
        if (rowCount > 0) {
          appendRow("hunk", "···", "", line.slice(11).trim());
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
          appendRow("hunk", "···", "", hunk[3].trim());
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
        appendRow("add", newLine++, "+", line, 1);
      } else if (line.startsWith("-") && (sawHunk || !line.startsWith("---"))) {
        deletions++;
        appendRow("del", oldLine++, "-", line, 1);
      } else if (sawHunk || line.startsWith(" ")) {
        appendRow("ctx", newLine, " ", line, line.startsWith(" ") ? 1 : 0);
        oldLine++;
        newLine++;
      } else {
        appendRow("ctx", newLine++, " ", line);
      }
    }
  } else if (typeof oldStr === "string" || typeof newStr === "string") {
    if (typeof oldStr === "string" && oldStr.length > 0) {
      const oldLines = splitNormalizedLines(oldStr);
      oldLines.forEach((text, idx) => {
        deletions++;
        appendRow("del", idx + 1, "-", text);
      });
    }
    if (typeof newStr === "string" && newStr.length > 0) {
      const newLines = splitNormalizedLines(newStr);
      newLines.forEach((text, idx) => {
        additions++;
        appendRow("add", idx + 1, "+", text);
      });
    }
  }

  return { rows, rowCount, additions, deletions, isBinary };
}

export function t3CheckpointPath(path, roots) {
  const file = t3NormDiffPath(path);
  if (!/^(?:[a-z]:|\/)/i.test(file)) return file;
  const windows = /^(?:[a-z]:|\/\/)/i.test(file);
  for (const value of roots || []) {
    const root = t3NormDiffPath(value).replace(/\/+$/, "");
    if (root && (windows ? file.toLowerCase().startsWith(root.toLowerCase() + "/") : file.startsWith(root + "/"))) {
      return file.slice(root.length + 1);
    }
  }
  return "";
}

export function t3NormDiffPath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/^\/(?=[a-z]:)/i, "");
}

export function t3DiffMatchesTarget(file, target, workspaceRoot) {
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

function t3SelectCheckpointFilePatch(data, filePath, parse, workspaceRoot) {
  if (!data) return null;
  const target = t3CheckpointPath(filePath, [workspaceRoot]) || t3NormDiffPath(filePath);
  const sections = [{ diff: data.diff, relativePath: "" }, ...(data.repositories ?? [])];
  for (const { diff, relativePath } of sections) {
    if (typeof diff !== "string" || !diff.trim()) continue;
    const prefix = t3NormDiffPath(relativePath).replace(/\/+$/, "");
    const matches = (name) => Boolean(name) && t3DiffMatchesTarget(
      prefix ? `${prefix}/${t3NormDiffPath(name)}` : name, target, workspaceRoot
    );
    for (const patch of diff.split(/(?=^diff --git )/m)) {
      const parsed = parse(patch, "t3-checkpoint");
      if (parsed?.kind === "files" && parsed.files.some((file) => matches(file.name) || matches(file.prevName))) {
        return patch;
      }
    }
  }
  return null;
}

export function createSideRevealHelpers(host = {}) {
  const { extractToolPatch, parsePatch, getFileName = (file) => file?.name } = host;

  function parseFiles(patch, key, ignoreWhitespace) {
    if (typeof patch !== "string" || !patch.trim()) return [];
    const parsed = parsePatch?.(patch, key, { ignoreWhitespace });
    return parsed?.kind === "files" ? parsed.files : [];
  }

  function findFile(files, target, workspaceRoot) {
    return files.find((file) => getFileName(file) === target)
      ?? files.find((file) => t3DiffMatchesTarget(getFileName(file), target, workspaceRoot)
        || (file?.prevName && t3DiffMatchesTarget(file.prevName, target, workspaceRoot)));
  }

  function t3CheckpointHasFile(data, target, ignoreWhitespace, workspaceRoot) {
    return Boolean(t3SelectCheckpointFilePatch(
      data, target, (patch, key) => parsePatch?.(patch, key, { ignoreWhitespace }), workspaceRoot
    ));
  }

  function t3ResolveRevealPath(target, files, rows, workspaceRoot, isToolDiff) {
    if (target) {
      const file = findFile(files, target, workspaceRoot);
      if (file) return getFileName(file);
      if (!isToolDiff || rows.length !== 1) return target;
    }
    return rows.length ? getFileName(rows[0].fileDiff) : null;
  }

  function t3PickToolDiffFallback(options) {
    const { rawTarget, toolQuery, toolItem, cwd, workspaceRoot, formatMessage, ignoreWhitespace, isRepo, canReadFiles, projectMeta, turns } = options;
    if (!rawTarget) return null;
    const targetPath = rawTarget.filePath ? t3NormDiffPath(rawTarget.filePath) : null;
    if (toolItem?.type === "file_change" && typeof toolItem.diffStr === "string" && toolItem.diffStr.trim()) {
      const extracted = extractToolPatch?.(toolItem, workspaceRoot, formatMessage);
      const files = parseFiles(extracted?.patch, "t3-tool-probe", ignoreWhitespace);
      const completeSingleFile = files.length === 1 && (toolItem.changes?.length ?? 0) <= 1 && !extracted?.truncated;
      if (files.length && (!targetPath || completeSingleFile || findFile(files, targetPath, workspaceRoot))) return null;
    }
    if (!rawTarget.preferGitFallback && toolQuery?.isPending) return null;
    const turnId = rawTarget.turnId ?? toolItem?.runId ?? null;
    const turn = isRepo && turnId && Array.isArray(turns) ? (turns.find((t) => t.runId === turnId) ?? null) : null;
    const canUnstaged = Boolean(isRepo && canReadFiles && projectMeta != null && cwd != null);
    return turn
      ? { mode: "turn", turn, turnId: turn.runId, canUnstaged }
      : canUnstaged
        ? { mode: "unstaged", turn: null, turnId: null, canUnstaged: true }
        : null;
  }

  return {
    t3NormDiffPath,
    t3DiffMatchesTarget,
    t3CheckpointHasFile,
    t3PickToolDiffFallback,
    t3ResolveRevealPath,
  };
}

export function createInlineDiffRuntime(host = {}) {
  const {
    React,
    jsx,
    jsxs,
    resolveRelPath,
    useCheckpointSummaries,
    useCheckpointDiff,
    parseCheckpointDiff,
    observeIntersection,
    useTurnItemDetail,
    getItemRevision,
    formatCompact,
    reviewQueries,
    useQuery,
  } = host;

  function t3EnsureDiffStyles() {
    if (typeof document === "undefined" || !document.head || document.getElementById("t3e-inline-diff-style")) return;
    const st = document.createElement("style");
    st.id = "t3e-inline-diff-style";
    st.textContent = `
.t3e-fc-row{display:flex;align-items:baseline;gap:6px;min-width:0;width:100%;font-size:14px;line-height:1.5;margin:0}
.t3e-fc-verb{flex:0 0 auto}
.t3e-fc-link{color:inherit;border-bottom:1px dotted currentColor;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3e-fc-stats{display:inline-flex;align-items:baseline;gap:4px;font-family:var(--font-mono);font-size:12px;flex:0 0 auto}
.t3e-fc-add{color:#15803d}
.t3e-fc-del{color:#dc2626}
.t3e-diff-card{margin:4px 0 6px;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--card,var(--background))}
.t3e-diff-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px 7px 12px;background:var(--muted,transparent);border-bottom:1px solid var(--border)}
.t3e-diff-header-left{display:flex;align-items:baseline;gap:8px;min-width:0;flex:1}
.t3e-diff-title{font-family:var(--font-mono);font-size:12px;line-height:1.4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:transparent;border:0;border-bottom:1px solid transparent;padding:0;text-align:left;cursor:pointer;color:var(--foreground)}
.t3e-diff-title:hover{border-bottom-color:currentColor}
.t3e-diff-header-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
.t3e-diff-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;border:0;background:transparent;color:var(--muted-foreground);cursor:pointer}
.t3e-diff-icon-btn:hover{background:var(--accent);color:var(--foreground)}
.t3e-diff-btn-icon{width:14px;height:14px}
.t3e-diff-body{max-height:min(19rem,40dvh);overflow:auto;font-family:var(--font-mono);font-size:12px;line-height:19px}
.t3e-diff-line{display:flex;min-width:max-content;width:100%;border-left:3px solid transparent;padding:0 12px 0 0}
.t3e-diff-line.is-add{background:rgba(34,197,94,.11);border-left-color:#16a34a}
.t3e-diff-line.is-del{background:rgba(239,68,68,.10);border-left-color:#dc2626}
.t3e-diff-line.is-hunk{color:var(--muted-foreground);background:var(--muted)}
.t3e-diff-ln{flex:0 0 36px;opacity:.55;user-select:none;text-align:right;padding-right:10px;font-variant-numeric:tabular-nums}
.t3e-diff-sign{flex:0 0 14px;text-align:center;user-select:none}
.t3e-diff-code{white-space:pre}
.t3e-diff-more{width:100%;padding:6px 12px;border:0;border-top:1px solid var(--border);background:transparent;color:var(--primary,#3b82f6);font-size:12px;cursor:pointer;text-align:left}
.t3e-diff-changes-list{padding:8px 12px;font-family:var(--font-mono);font-size:12px}
`;
    if (typeof document.head.prepend === "function") document.head.prepend(st);
    else if (typeof document.head.insertBefore === "function") document.head.insertBefore(st, document.head.firstChild || null);
    else document.head.appendChild(st);
  }

  function T3DiffCopyIcon() {
    return jsxs("svg", {
      className: "t3e-diff-btn-icon",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      children: [
        jsx("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
        jsx("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
      ]
    });
  }

  function T3DiffSideIcon() {
    return jsxs("svg", {
      className: "t3e-diff-btn-icon",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      children: [
        jsx("rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }),
        jsx("path", { d: "M15 4v16" })
      ]
    });
  }

  function t3IsZhLocale() {
    return typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
  }

  function t3ShortFileName(relPath) {
    const s = String(relPath || "").replace(/\\/g, "/");
    const idx = s.lastIndexOf("/");
    return idx >= 0 ? s.slice(idx + 1) : s;
  }

  function t3RenderFileChangeStats(summary, item, parsed) {
    const adds = [summary?.additions, item?.additions, parsed?.additions].find(Number.isFinite);
    const dels = [summary?.deletions, item?.deletions, parsed?.deletions].find(Number.isFinite);
    if (!(adds > 0 || dels > 0)) return null;
    return jsxs("span", {
      className: "t3e-fc-stats",
      children: [
        adds > 0 ? jsxs("span", { className: "t3e-fc-add", children: ["+", typeof formatCompact === "function" ? formatCompact(adds) : adds] }) : null,
        dels > 0 ? jsxs("span", { className: "t3e-fc-del", children: ["-", typeof formatCompact === "function" ? formatCompact(dels) : dels] }) : null,
      ],
    });
  }

  const T3_EMPTY_FILE_DIFF = { rows: [], rowCount: 0, additions: 0, deletions: 0, isBinary: false };

  function t3UseInlineFilePatch(item, projectedItem, environmentId, workspaceRoot, cwd, { maxRows, allowCheckpoint, allowWorkingTree = false, enabled = true }) {
    const recorded = React.useMemo(
      () => enabled ? t3ParseUnifiedDiff(item?.diffStr, item?.oldStr, item?.newStr, maxRows) : T3_EMPTY_FILE_DIFF,
      [enabled, maxRows, item?.diffStr, item?.oldStr, item?.newStr]
    );
    const turnId = item?.runId ?? projectedItem?.item?.runId ?? null;
    const checkpointPath = t3CheckpointPath(item?.fileName || item?.changes?.[0]?.path || "", [cwd, workspaceRoot]);
    const threadId = projectedItem?.sourceThreadId ?? null;
    const useCheckpoint = Boolean(enabled && allowCheckpoint && turnId && checkpointPath && !recorded.isBinary && recorded.rowCount === 0);
    const threadRef = React.useMemo(
      () => useCheckpoint && environmentId && threadId ? { environmentId, threadId } : null,
      [useCheckpoint, environmentId, threadId]
    );
    const checkpoints = typeof useCheckpointSummaries === "function" ? useCheckpointSummaries(threadRef) : [];
    const count = Array.isArray(checkpoints) ? checkpoints.find((checkpoint) => checkpoint.runId === turnId)?.checkpointTurnCount : null;
    const toTurnCount = Number.isInteger(count) && count > 0 ? count : null;
    const fetchCheckpoint = threadRef !== null && toTurnCount !== null;
    const turnDiff = typeof useCheckpointDiff === "function" ? useCheckpointDiff({
      environmentId: threadRef?.environmentId ?? null,
      threadId: threadRef?.threadId ?? null,
      fromTurnCount: toTurnCount === null ? null : toTurnCount - 1,
      toTurnCount,
      ignoreWhitespace: false
    }, { enabled: fetchCheckpoint }) : { data: null, isPending: false };
    const checkpointRoot = cwd ?? workspaceRoot;
    const checkpointPatch = React.useMemo(
      () => fetchCheckpoint && typeof parseCheckpointDiff === "function"
        ? t3SelectCheckpointFilePatch(turnDiff.data, checkpointPath, parseCheckpointDiff, checkpointRoot)
        : null,
      [fetchCheckpoint, turnDiff.data, checkpointPath, checkpointRoot]
    );
    const checkpointDiff = React.useMemo(
      () => checkpointPatch ? t3ParseUnifiedDiff(checkpointPatch, undefined, undefined, maxRows) : null,
      [checkpointPatch, maxRows]
    );
    const checkpointPending = fetchCheckpoint && turnDiff.isPending;
    const fetchWorkingTree = Boolean(
      enabled &&
      allowWorkingTree &&
      !recorded.isBinary &&
      recorded.rowCount === 0 &&
      !checkpointPatch &&
      !checkpointPending &&
      environmentId &&
      checkpointRoot &&
      checkpointPath &&
      typeof reviewQueries?.diffPreview === "function" &&
      typeof useQuery === "function"
    );
    const wtQuery = React.useMemo(
      () => fetchWorkingTree
        ? reviewQueries.diffPreview({
            environmentId,
            input: { cwd: checkpointRoot, ignoreWhitespace: false, sourceKind: "working-tree" },
          })
        : null,
      [fetchWorkingTree, environmentId, checkpointRoot]
    );
    const wtResult = typeof useQuery === "function" ? useQuery(wtQuery) : { data: null, isPending: false };
    const workingTreeSource = wtResult?.data?.sources?.find?.((s) => s.kind === "working-tree") ?? null;
    const workingTreePatch = React.useMemo(
      () => fetchWorkingTree && workingTreeSource?.diff && typeof parseCheckpointDiff === "function"
        ? t3SelectCheckpointFilePatch({ diff: workingTreeSource.diff }, checkpointPath, parseCheckpointDiff, checkpointRoot)
        : null,
      [fetchWorkingTree, workingTreeSource?.diff, checkpointPath, checkpointRoot]
    );
    const workingTreeDiff = React.useMemo(
      () => workingTreePatch ? t3ParseUnifiedDiff(workingTreePatch, undefined, undefined, maxRows) : null,
      [workingTreePatch, maxRows]
    );
    const workingTreePending = Boolean(fetchWorkingTree && wtResult?.isPending && !workingTreeSource);
    return {
      turnId,
      checkpointPath,
      checkpointPatch,
      workingTreePatch,
      recorded,
      parsed: checkpointDiff ?? workingTreeDiff ?? recorded,
      checkpointPending,
      workingTreePending,
    };
  }

  function T3FileChangeRowLabel({ projectedItem, workspaceRoot, cwd, environmentId, source, expanded }) {
    React.useEffect(t3EnsureDiffStyles, []);
    const summary = projectedItem?.item;
    const rowRef = React.useRef(null);
    const [visible, setVisible] = React.useState(false);
    const hasCounts = Number.isFinite(summary?.additions) && Number.isFinite(summary?.deletions);
    const hasDiff = typeof summary?.diffStr === "string" && summary.diffStr.trim().length > 0;
    const needsDetail = !expanded && !hasCounts && !(hasDiff || summary?.oldStr || summary?.newStr);
    React.useEffect(() => {
      if (!needsDetail || !rowRef.current || typeof observeIntersection !== "function") return;
      return observeIntersection(rowRef.current, (entry) => setVisible(entry.isIntersecting));
    }, [needsDetail]);
    const { sourceItemId, sourceThreadId } = projectedItem || {};
    const request = React.useMemo(
      () => needsDetail && visible && environmentId && sourceThreadId && sourceItemId
        ? { environmentId, threadId: sourceThreadId, itemId: sourceItemId, revision: typeof getItemRevision === "function" ? getItemRevision(summary) : summary?.updatedAt }
        : null,
      [needsDetail, visible, environmentId, sourceThreadId, sourceItemId, summary]
    );
    const detail = typeof useTurnItemDetail === "function" ? useTurnItemDetail(request, source?.detail) : { data: null, isPending: false };
    const item = request && detail.data?.item?.type === "file_change" ? detail.data.item : summary;
    const { parsed } = t3UseInlineFilePatch(
      item, projectedItem, environmentId, workspaceRoot, cwd, {
        maxRows: 0,
        enabled: !expanded && !hasCounts && !(Number.isFinite(item?.additions) && Number.isFinite(item?.deletions)),
        allowCheckpoint: request !== null && !detail.isPending
      }
    );

    const isZh = t3IsZhLocale();
    const rawPath = item?.fileName || item?.changes?.[0]?.path || "";
    const relPath = rawPath ? (typeof resolveRelPath === "function" ? resolveRelPath(rawPath, workspaceRoot) : rawPath) : "";
    const shortName = t3ShortFileName(relPath) || relPath;
    const op = item?.changes?.[0]?.operation;
    const verb = expanded
      ? (isZh ? "已编辑的文件" : "Edited file")
      : op === "add"
        ? (isZh ? "已新建" : "Created")
        : op === "delete"
          ? (isZh ? "已删除" : "Deleted")
          : (isZh ? "已编辑" : "Edited");

    return jsx("div", {
      className: "min-w-0 flex-1 overflow-hidden",
      ref: rowRef,
      children: jsxs("p", {
        className: "t3e-fc-row",
        children: [
          jsx("span", { className: "t3e-fc-verb", children: verb }),
          !expanded && relPath
            ? jsx("span", {
                className: "t3e-fc-link",
                children: shortName,
              })
            : null,
          !expanded ? t3RenderFileChangeStats(summary, item, parsed) : null,
        ],
      }),
    });
  }

  function T3InlineFileDiffCard({ item, projectedItem, detail, workspaceRoot, cwd, onOpenToolDiff }) {
    const [copied, setCopied] = React.useState(false);
    const copyTimerRef = React.useRef(null);
    React.useEffect(() => {
      t3EnsureDiffStyles();
      return () => {
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      };
    }, []);
    const isZh = t3IsZhLocale();
    const rawPath = item?.fileName || item?.changes?.[0]?.path || "";
    const relPath = rawPath ? (typeof resolveRelPath === "function" ? resolveRelPath(rawPath, workspaceRoot) : rawPath) : "";
    const shortName = t3ShortFileName(relPath) || relPath;
    const { turnId, checkpointPath, checkpointPatch, workingTreePatch, recorded, parsed, checkpointPending, workingTreePending } = t3UseInlineFilePatch(
      item, projectedItem, detail?.environmentId ?? projectedItem?.environmentId, workspaceRoot, cwd, { maxRows: 320, allowCheckpoint: !detail?.pending, allowWorkingTree: !detail?.pending }
    );
    const copySource = checkpointPatch || workingTreePatch || (typeof item?.diffStr === "string" && item.diffStr.trim() ? item.diffStr : "") || item?.newStr || item?.oldStr || "";
    React.useEffect(() => {
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
          revision: typeof getItemRevision === "function" ? getItemRevision(projectedItem.item) : projectedItem.item?.updatedAt,
          filePath: checkpointPath || relPath,
          revealRequestId,
        };
        if (turnId) payload.turnId = turnId;
        if (!detail?.pending && recorded.rowCount === 0) payload.preferGitFallback = true;
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

    const visibleRows = parsed.rows;
    const hiddenCount = parsed.rowCount - visibleRows.length;

    return jsxs("div", {
      className: "t3e-diff-card",
      "data-v2-item-inspector": "file_change",
      onClick: (ev) => ev.stopPropagation(),
      children: [
        jsxs("div", {
          className: "t3e-diff-header",
          children: [
            jsxs("div", {
              className: "t3e-diff-header-left",
              children: [
                typeof onOpenToolDiff === "function"
                  ? jsx("button", {
                      type: "button",
                      className: "t3e-fc-link t3e-diff-title",
                      title: relPath || shortName,
                      onClick: openSideDiff,
                      children: relPath || shortName,
                    })
                  : jsx("span", { className: "t3e-diff-title", title: relPath, children: relPath || shortName }),
                t3RenderFileChangeStats(projectedItem?.item, item, parsed),
                checkpointPatch
                  ? jsx("span", {
                      className: "shrink-0 text-[11px] text-muted-foreground",
                      title: isZh
                        ? "当前提供方未记录单步 Diff，此处显示本轮对该文件的汇总 Git 变更"
                        : "Provider did not record a per-edit diff; showing this turn's combined Git diff for this file",
                      children: isZh ? "本轮汇总 Git 变更" : "Turn net Git diff"
                    })
                  : workingTreePatch
                    ? jsx("span", {
                        className: "shrink-0 text-[11px] text-muted-foreground",
                        title: isZh
                          ? "当前提供方未记录单步 Diff，此处显示该文件当前工作区未提交变更"
                          : "Provider did not record a per-edit diff; showing current working-tree diff for this file",
                        children: isZh ? "工作区变更" : "Working tree"
                      })
                    : null,
              ],
            }),
            jsxs("div", {
              className: "t3e-diff-header-actions",
              children: [
                copySource
                  ? jsx("button", {
                      type: "button",
                      className: "t3e-diff-icon-btn",
                      title: copied ? (isZh ? "已复制" : "Copied") : (isZh ? "复制变更内容" : "Copy diff"),
                      "aria-label": isZh ? "复制变更内容" : "Copy diff",
                      onClick: handleCopy,
                      children: copied ? "✓" : jsx(T3DiffCopyIcon, {}),
                    })
                  : null,
                typeof onOpenToolDiff === "function"
                  ? jsx("button", {
                      type: "button",
                      className: "t3e-diff-icon-btn",
                      title: isZh ? "在右侧边栏查看变更" : "Open in side Diff panel",
                      "aria-label": isZh ? "在右侧边栏查看变更" : "Open in side Diff panel",
                      onClick: openSideDiff,
                      children: jsx(T3DiffSideIcon, {}),
                    })
                  : null,
              ],
            }),
          ],
        }),
        visibleRows.length > 0
          ? jsxs("div", {
              className: "t3e-diff-body",
              children: [
                visibleRows.map((row, idx) =>
                  jsxs(
                    "div",
                    {
                      className: `t3e-diff-line is-${row.kind}`,
                      children: [
                        jsx("span", { className: "t3e-diff-ln", children: row.lineNo }),
                        jsx("span", { className: "t3e-diff-sign", children: row.sign }),
                        jsx("span", { className: "t3e-diff-code", children: row.text || " " }),
                      ],
                    },
                    idx
                  )
                ),
                hiddenCount > 0 && typeof onOpenToolDiff === "function"
                  ? jsx("button", {
                      type: "button",
                      className: "t3e-diff-more",
                      onClick: openSideDiff,
                      children: isZh
                        ? `在侧栏查看剩余 ${hiddenCount} 行`
                        : `View ${hiddenCount} more lines in the side panel`,
                    })
                  : null,
              ],
            })
          : jsxs("div", {
              className: "t3e-diff-changes-list",
              children: [
                Array.isArray(item?.changes) && item.changes.length > 0
                  ? jsx("ul", {
                      style: { margin: "0 0 6px", padding: 0, listStyle: "none" },
                      children: item.changes.map((c, idx) =>
                        jsxs(
                          "li",
                          {
                            children: [
                              c.operation,
                              " ",
                              c.oldPath ? `${typeof resolveRelPath === "function" ? resolveRelPath(c.oldPath, workspaceRoot) : c.oldPath} → ` : "",
                              typeof resolveRelPath === "function" ? resolveRelPath(c.path, workspaceRoot) : c.path,
                            ],
                          },
                          idx + ":" + JSON.stringify([c.operation, c.oldPath, c.path])
                        )
                      ),
                    })
                  : null,
                jsx("div", {
                  role: "status",
                  style: { opacity: 0.72, fontFamily: "var(--font-sans)" },
                  children: detail?.pending || checkpointPending || workingTreePending
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

  const t3DiffMemo = (fn) => (typeof React !== "undefined" && typeof React.memo === "function" ? React.memo(fn) : fn);
  const T3FileChangeRowLabelMemo = t3DiffMemo(T3FileChangeRowLabel);
  const T3InlineFileDiffCardMemo = t3DiffMemo(T3InlineFileDiffCard);

  return {
    T3FileChangeRowLabel,
    T3FileChangeRowLabelMemo,
    T3InlineFileDiffCard,
    T3InlineFileDiffCardMemo,
    t3RenderFileChangeStats,
  };
}

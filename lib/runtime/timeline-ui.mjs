/**
 * External ESM runtime for timeline cascade collapse, flat tool groups, and same-file folding.
 * Pure ES module with ZERO minified host dependencies.
 */

export function disclosureIds(rows) {
  const ids = { attempts: new Set(), groups: new Set(), details: new Set(), entries: new Set() };
  for (const row of rows || []) {
    if (row.kind === "attempt-fold") ids.attempts.add(row.attemptId);
    if ((row.kind === "work-toggle" || row.kind === "work-live" || row.kind === "thinking") && row.groupId !== undefined) {
      ids.groups.add(row.groupId);
    }
    if (row.kind === "work" && row.isExpandedToolGroup) ids.details.add(row.id);
    if (row.kind === "work") {
      for (const entry of row.groupedEntries ?? []) {
        ids.entries.add(entry.id);
        ids.entries.add(`${entry.id}:file-fold`);
      }
      for (const entry of row.entries ?? []) {
        ids.entries.add(entry.id);
        ids.entries.add(`${entry.id}:file-fold`);
      }
    }
    if (row.kind === "event") ids.entries.add(`subagent-group:${row.id}`);
  }
  return ids;
}

export function resetHiddenDisclosures(before, after, state) {
  const previous = disclosureIds(before);
  const remaining = disclosureIds(after);
  const hiddenAttempts = new Set();
  const hiddenGroups = new Set();
  for (const id of previous.attempts) if (!remaining.attempts.has(id)) hiddenAttempts.add(id);
  for (const id of previous.groups) if (!remaining.groups.has(id)) hiddenGroups.add(id);
  for (const id of previous.details) if (!remaining.details.has(id)) state?.scrollPositions?.delete?.(id);
  for (const id of previous.entries) if (!remaining.entries.has(id)) state?.expandedEntries?.delete?.(id);
  return { hiddenAttempts, hiddenGroups };
}

export function updateDisclosure(ids, id) {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export const T3_PATH_KEYS = [
  "Path", "path", "filePath", "file_path", "relativePath",
  "filename", "fileName", "targetFile", "target_file", "targetPath", "target_path",
];

function t3ParseMaybeObject(val) {
  if (!val) return null;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof val === "object" ? val : null;
}

function t3CollectPathsFromInput(value, out, seen, depth) {
  if (!value || depth > 4 || out.length >= 8) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      t3CollectPathsFromInput(item, out, seen, depth + 1);
      if (out.length >= 8) return;
    }
    return;
  }
  const obj = t3ParseMaybeObject(value);
  if (!obj || Array.isArray(obj)) return;
  for (const key of T3_PATH_KEYS) {
    const raw = obj[key];
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
        if (out.length >= 8) return;
      }
    }
  }
  for (const nested of ["locations", "item", "input", "rawInput", "arguments", "result", "data", "changes"]) {
    if (nested in obj) {
      t3CollectPathsFromInput(obj[nested], out, seen, depth + 1);
      if (out.length >= 8) return;
    }
  }
}

export function t3NormFilePath(raw, workspaceRoot, resolveRelPath) {
  let resolved = String(raw || "").trim();
  if (!resolved) return null;
  if (typeof resolveRelPath === "function") {
    try {
      const rel = resolveRelPath(resolved, workspaceRoot);
      if (typeof rel === "string" && rel.trim()) resolved = rel.trim();
    } catch {
      // keep raw fallback
    }
  }
  const normalized = resolved.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized) return null;
  const keyPath = /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
  return { displayPath: normalized, keyPath };
}

export function t3ExtractWorkEntryPaths(entry, extraPaths) {
  const out = [];
  const seen = new Set();
  const push = (val) => {
    if (typeof val !== "string") return;
    const trimmed = val.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  };
  if (Array.isArray(entry?.changedFiles)) {
    for (const f of entry.changedFiles) push(f);
  }
  if (Array.isArray(extraPaths)) {
    for (const f of extraPaths) push(f);
  }
  if (out.length === 0) {
    const inputSource = entry?.structuredPayload?.input ?? entry?.toolData?.input ?? entry?.toolData;
    t3CollectPathsFromInput(inputSource, out, seen, 0);
  }
  if (out.length === 0 && entry?.viewedImagePath) push(entry.viewedImagePath);
  if (out.length === 0 && typeof entry?.detail === "string") {
    const detail = entry.detail.trim();
    if (detail && !/[\r\n]/.test(detail) && (detail.includes("/") || detail.includes("\\") || /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(detail))) {
      push(detail);
    }
  }
  return out;
}

export function t3GetFoldableFileInfo(entry, workspaceRoot, deps = {}) {
  if (!entry) return null;
  const itemType = entry.itemType;
  if (
    itemType === "reasoning" ||
    itemType === "notification" ||
    itemType === "system_notice" ||
    itemType === "todo_list" ||
    itemType === "approval_request" ||
    itemType === "user_input_request" ||
    itemType === "error" ||
    entry.questionAnswer !== undefined
  ) {
    return null;
  }
  const projType = entry.projectedItem?.item?.type;
  if (
    projType === "approval_request" ||
    projType === "user_input_request" ||
    (projType === "error" && entry.projectedItem?.item?.status === "failed") ||
    entry.toolLifecycleStatus === "failed" ||
    entry.projectedItem?.item?.status === "failed" ||
    (typeof deps.isEntryFailed === "function" && deps.isEntryFailed(entry))
  ) {
    return null;
  }
  const action = typeof deps.getAction === "function" ? deps.getAction(entry) : entry.action;
  const kind = action === "read" ? "read" : (action === "edit" || itemType === "file_change") ? "edit" : null;
  if (!kind) return null;

  const extra = [];
  if (typeof deps.extractPaths === "function") {
    for (const p of deps.extractPaths(entry) || []) extra.push(p);
  }
  if (kind === "read" && typeof deps.extractReadDetailPath === "function") {
    const single = deps.extractReadDetailPath(entry);
    if (single) extra.push(single);
  }
  const rawPaths = t3ExtractWorkEntryPaths(entry, extra);
  const byKey = new Map();
  for (const raw of rawPaths) {
    const norm = t3NormFilePath(raw, workspaceRoot, deps.resolveRelPath);
    if (norm && !byKey.has(norm.keyPath)) byKey.set(norm.keyPath, norm);
  }
  if (byKey.size !== 1) return null;
  const [only] = byKey.values();
  return {
    key: `${kind}:${only.keyPath}`,
    kind,
    filePath: only.displayPath,
  };
}

export function t3FormatReadRanges(entries) {
  const ranges = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const inp = t3ParseMaybeObject(entry?.structuredPayload?.input ?? entry?.toolData?.input ?? entry?.toolData);
    if (!inp) continue;
    const rawStart = inp.StartLine ?? inp.startLine ?? inp.start_line ?? inp.offset;
    const rawEnd = inp.EndLine ?? inp.endLine ?? inp.end_line;
    const rawLimit = inp.limit;
    if (rawStart === undefined || rawStart === null || (typeof rawStart === "string" && rawStart.trim() === "")) continue;
    const s = Number(rawStart);
    if (!Number.isFinite(s) || s < 0) continue;
    const hasEnd = rawEnd !== undefined && rawEnd !== null && !(typeof rawEnd === "string" && rawEnd.trim() === "");
    const e = hasEnd ? Number(rawEnd) : NaN;
    const hasLimit = rawLimit !== undefined && rawLimit !== null && !(typeof rawLimit === "string" && rawLimit.trim() === "");
    const lim = hasLimit ? Number(rawLimit) : NaN;
    let label = null;
    if (Number.isFinite(e) && e >= s) {
      label = `L${s}-${e}`;
    } else if (Number.isFinite(lim) && lim > 0) {
      const startLine = s === 0 ? 1 : s;
      label = `L${startLine}-${startLine + lim - 1}`;
    } else if (s > 0) {
      label = `L${s}+`;
    }
    if (label && !seen.has(label)) {
      seen.add(label);
      ranges.push(label);
    }
  }
  if (ranges.length === 0) return null;
  return ranges.length <= 2 ? ranges.join(", ") : `${ranges.slice(0, 2).join(", ")} +${ranges.length - 2}`;
}

export function t3AggregateEditStats(entries) {
  let additions = 0;
  let deletions = 0;
  for (const entry of entries || []) {
    const item = entry?.projectedItem?.item ?? entry?.structuredPayload ?? entry;
    if (Number.isFinite(item?.additions) && Number.isFinite(item?.deletions)) {
      additions += item.additions;
      deletions += item.deletions;
      continue;
    }
    if (typeof item?.diffStr !== "string") return null;
    let inHunk = false;
    let sawHunk = false;
    let added = 0;
    let removed = 0;
    for (const line of item.diffStr.split(/\r?\n/)) {
      if (line.startsWith("diff --git ") || line.startsWith("GIT binary patch")) {
        inHunk = false;
      } else if (/^@@\s+-\d+/.test(line)) {
        inHunk = true;
        sawHunk = true;
      } else if (inHunk && line.startsWith("+")) {
        added++;
      } else if (inHunk && line.startsWith("-")) {
        removed++;
      }
    }
    if (!sawHunk) return null;
    additions += Number.isFinite(item.additions) ? item.additions : added;
    deletions += Number.isFinite(item.deletions) ? item.deletions : removed;
  }
  return entries?.length ? { additions, deletions } : null;
}

export function groupSameFileEntries(entries, workspaceRoot, deps = {}) {
  const result = [];
  let currentGroup = null;
  const flushGroup = () => {
    if (!currentGroup) return;
    if (currentGroup.entries.length >= 2) {
      result.push({
        type: "file-group",
        id: `${currentGroup.entries[0].id}:file-fold`,
        key: currentGroup.key,
        kind: currentGroup.kind,
        filePath: currentGroup.filePath,
        entries: currentGroup.entries,
      });
    } else {
      result.push({ type: "single", entry: currentGroup.entries[0] });
    }
    currentGroup = null;
  };
  for (const entry of entries || []) {
    const info = t3GetFoldableFileInfo(entry, workspaceRoot, deps);
    if (!info) {
      flushGroup();
      result.push({ type: "single", entry });
      continue;
    }
    if (currentGroup && currentGroup.key === info.key) {
      currentGroup.entries.push(entry);
    } else {
      flushGroup();
      currentGroup = { key: info.key, kind: info.kind, filePath: info.filePath, entries: [entry] };
    }
  }
  flushGroup();
  return result;
}

function t3EnsureTimelineStyles() {
  if (typeof document === "undefined" || !document.head || document.getElementById("t3e-timeline-styles")) return;
  const st = document.createElement("style");
  st.id = "t3e-timeline-styles";
  st.textContent = `
.t3e-tool-group-flat{display:flex;flex-direction:column;gap:2px}
.t3e-same-file-children{padding-left:18px;border-left:1px solid var(--border);margin:2px 0 4px 8px}
`;
  if (typeof document.head.prepend === "function") document.head.prepend(st);
  else if (typeof document.head.insertBefore === "function") document.head.insertBefore(st, document.head.firstChild || null);
  else document.head.appendChild(st);
}

export function createTimelineRuntime(host = {}) {
  const {
    React,
    jsx,
    jsxs,
    Fragment,
    workGroupCtx,
    timelineCtx,
    useI18n,
    isEntryFailed,
    getAction,
    extractPaths,
    extractReadDetailPath,
    resolveRelPath,
    WorkRow,
    WorkIcon,
    ChevronRight,
    Timestamp,
    WorkEntryRow,
    useCheckpointSummaries,
    useCheckpointDiff,
    parseCheckpointDiff,
    reviewQueries,
    useQuery,
  } = host;

  function t3NormRelForDiff(value) {
    return String(value ?? "").replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/^\/(?=[a-z]:)/i, "");
  }

  function t3MatchFilePath(candidate, target, root) {
    let left = t3NormRelForDiff(candidate);
    let right = t3NormRelForDiff(target);
    if (!left || !right) return false;
    const isWin = /^(?:[a-z]:\/|\/\/)/i;
    if ([left, right, t3NormRelForDiff(root)].some((v) => isWin.test(v))) {
      left = left.toLowerCase();
      right = right.toLowerCase();
    }
    const isAbs = (v) => v.startsWith("/") || isWin.test(v);
    if (isAbs(left) && !isAbs(right)) return left.endsWith("/" + right);
    if (isAbs(right) && !isAbs(left)) return right.endsWith("/" + left);
    return left === right || right.endsWith("/" + left) || left.endsWith("/" + right);
  }

  function t3CountPatchStats(data, filePath, root) {
    if (!data || typeof parseCheckpointDiff !== "function") return null;
    const sections = [{ diff: data.diff, relativePath: "" }, ...(data.repositories ?? [])];
    for (const { diff, relativePath } of sections) {
      if (typeof diff !== "string" || !diff.trim()) continue;
      const prefix = t3NormRelForDiff(relativePath).replace(/\/+$/, "");
      for (const patch of diff.split(/(?=^diff --git )/m)) {
        const parsed = parseCheckpointDiff(patch, "t3-group-stats");
        if (
          parsed?.kind === "files" &&
          parsed.files.some((f) => {
            const name = prefix && f?.name ? `${prefix}/${t3NormRelForDiff(f.name)}` : f?.name;
            const prev = prefix && f?.prevName ? `${prefix}/${t3NormRelForDiff(f.prevName)}` : f?.prevName;
            return t3MatchFilePath(name, filePath, root) || t3MatchFilePath(prev, filePath, root);
          })
        ) {
          let additions = 0;
          let deletions = 0;
          let inHunk = false;
          for (const line of patch.split(/\r?\n/)) {
            if (line.startsWith("diff --git ") || line.startsWith("GIT binary patch")) inHunk = false;
            else if (/^@@\s+-\d+/.test(line)) inHunk = true;
            else if (inHunk && line.startsWith("+")) additions++;
            else if (inHunk && line.startsWith("-")) deletions++;
          }
          return { additions, deletions };
        }
      }
    }
    return null;
  }

  const _jsx = jsx || React?.jsx;
  const _jsxs = jsxs || jsx || React?.jsxs;
  const _Fragment = Fragment || React?.Fragment;
  const useState = typeof React?.useState === "function" ? React.useState : (init) => [typeof init === "function" ? init() : init, () => {}];
  const useEffect = typeof React?.useEffect === "function" ? React.useEffect : () => {};
  const useMemo = typeof React?.useMemo === "function" ? React.useMemo : (fn) => fn();
  const useCtx = (ctx) => {
    if (!ctx) return null;
    if (typeof React?.use === "function") return React.use(ctx);
    if (typeof React?.useContext === "function") return React.useContext(ctx);
    return null;
  };

  function T3SameFileGroup({ group, workspaceRoot }) {
    const cdCtx = useCtx(workGroupCtx);
    const tlCtx = useCtx(timelineCtx);
    const translate = typeof useI18n === "function" ? useI18n() : (s) => s;
    const isStateExpanded = Boolean(cdCtx?.state?.expandedEntries?.has?.(group.id));
    const [expanded, setExpanded] = useState(() => isStateExpanded);
    useEffect(() => {
      t3EnsureTimelineStyles();
    }, []);
    useEffect(() => {
      setExpanded(isStateExpanded);
    }, [isStateExpanded]);
    const isZh = /[\u4e00-\u9fff]/.test(translate("Read")) || (typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || ""));
    const hasFailure = group.entries.some((e) => typeof isEntryFailed === "function" && Boolean(isEntryFailed(e)));
    const inProgress = group.entries.some((e) => e.toolLifecycleStatus === "inProgress");
    const count = group.entries.length;
    const toggle = (ev) => {
      if (ev?.target?.closest?.(".t3e-same-file-children")) return;
      const next = !expanded;
      if (cdCtx) {
        cdCtx.onToggleEntry?.(!next, group.id);
        if (next) {
          cdCtx.state?.expandedEntries?.add?.(group.id);
        } else {
          cdCtx.state?.expandedEntries?.delete?.(group.id);
          for (const entry of group.entries) {
            if (cdCtx.state?.expandedEntries?.has?.(entry.id)) {
              cdCtx.onToggleEntry?.(true, entry.id);
              cdCtx.state.expandedEntries.delete(entry.id);
            }
          }
        }
      }
      setExpanded(next);
    };
    const baseLabel = group.kind === "edit"
      ? (isZh ? (inProgress ? "正在编辑 " : "已编辑 ") + group.filePath : (inProgress ? "Editing " : "Edited ") + group.filePath)
      : (isZh ? (inProgress ? "正在读取 " : "已读取 ") + group.filePath : (inProgress ? "Reading " : "Read ") + group.filePath);
    const countText = isZh
      ? (group.kind === "edit" ? count + " 次更改" : count + " 次读取")
      : ("×" + count);
    const rangeText = useMemo(() => (group.kind === "read" ? t3FormatReadRanges(group.entries) : null), [group.kind, group.entries]);
    const directEditStats = useMemo(() => (group.kind === "edit" ? t3AggregateEditStats(group.entries) : null), [group.kind, group.entries]);
    const envId = tlCtx?.activeThreadEnvironmentId ?? null;
    const cwd = tlCtx?.markdownCwd ?? workspaceRoot ?? null;
    const sampleProj = group.entries.find((e) => e?.projectedItem?.sourceThreadId)?.projectedItem ?? null;
    const threadId = sampleProj?.sourceThreadId ?? null;
    const turnId = group.entries.at(-1)?.projectedItem?.item?.runId ?? sampleProj?.item?.runId ?? null;
    const needGitStats = Boolean(
      group.kind === "edit" &&
      directEditStats === null &&
      envId &&
      group.filePath
    );
    const threadRef = useMemo(
      () => needGitStats && threadId && turnId && typeof useCheckpointSummaries === "function"
        ? { environmentId: envId, threadId }
        : null,
      [needGitStats, envId, threadId, turnId]
    );
    const checkpoints = typeof useCheckpointSummaries === "function" ? useCheckpointSummaries(threadRef) : [];
    const cpCount = Array.isArray(checkpoints) ? checkpoints.find((cp) => cp.runId === turnId)?.checkpointTurnCount : null;
    const toTurnCount = Number.isInteger(cpCount) && cpCount > 0 ? cpCount : null;
    const fetchCheckpoint = Boolean(threadRef && toTurnCount !== null && typeof useCheckpointDiff === "function");
    const turnDiff = typeof useCheckpointDiff === "function"
      ? useCheckpointDiff(
          {
            environmentId: threadRef?.environmentId ?? null,
            threadId: threadRef?.threadId ?? null,
            fromTurnCount: toTurnCount === null ? null : toTurnCount - 1,
            toTurnCount,
            ignoreWhitespace: false,
          },
          { enabled: fetchCheckpoint }
        )
      : { data: null, isPending: false };
    const cpStats = useMemo(
      () => fetchCheckpoint ? t3CountPatchStats(turnDiff?.data, group.filePath, cwd) : null,
      [fetchCheckpoint, turnDiff?.data, group.filePath, cwd]
    );
    const fetchWorkingTree = Boolean(
      needGitStats &&
      !cpStats &&
      !(fetchCheckpoint && turnDiff?.isPending) &&
      cwd &&
      typeof reviewQueries?.diffPreview === "function" &&
      typeof useQuery === "function"
    );
    const wtQuery = useMemo(
      () => fetchWorkingTree
        ? reviewQueries.diffPreview({
            environmentId: envId,
            input: { cwd, ignoreWhitespace: false, sourceKind: "working-tree" },
          })
        : null,
      [fetchWorkingTree, envId, cwd]
    );
    const wtResult = typeof useQuery === "function" ? useQuery(wtQuery) : { data: null };
    const wtSource = wtResult?.data?.sources?.find?.((s) => s.kind === "working-tree") ?? null;
    const wtStats = useMemo(
      () => fetchWorkingTree && wtSource?.diff ? t3CountPatchStats({ diff: wtSource.diff }, group.filePath, cwd) : null,
      [fetchWorkingTree, wtSource?.diff, group.filePath, cwd]
    );
    const editStats = directEditStats ?? cpStats ?? wtStats;
    const showEditStats = Boolean(editStats && (editStats.additions > 0 || editStats.deletions > 0));
    const ariaLabel = baseLabel + " (" + countText + ")";
    const iconClass = hasFailure
      ? "flex size-4 items-center justify-center text-destructive"
      : "flex size-4 items-center justify-center text-icon-muted";
    const labelClass = hasFailure ? "font-medium text-destructive" : "text-foreground/80";
    const latestCreatedAt = group.entries.at(-1)?.createdAt ?? group.entries[0]?.createdAt;
    const labelNode = (0, _jsx)("div", {
      className: "min-w-0 flex-1 overflow-hidden",
      children: (0, _jsxs)("p", {
        className: "flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed",
        children: [
          (0, _jsxs)("span", {
            className: "min-w-0 flex-1 truncate " + labelClass,
            children: [
              baseLabel,
              (0, _jsx)("span", {
                className: "ms-1.5 text-muted-foreground opacity-80",
                children: rangeText ? " · " + countText + " (" + rangeText + ")" : " · " + countText,
              }),
              showEditStats
                ? (0, _jsxs)("span", {
                    className: "t3e-fc-stats ms-1.5 inline-flex items-baseline gap-1",
                    children: [
                      editStats.additions > 0
                        ? (0, _jsx)("span", { className: "t3e-fc-add", children: "+" + editStats.additions })
                        : null,
                      editStats.deletions > 0
                        ? (0, _jsx)("span", { className: "t3e-fc-del", children: "-" + editStats.deletions })
                        : null,
                    ],
                  })
                : null,
            ],
          }),
        ],
      }),
    });
    const trailingNode = (0, _jsxs)(_Fragment, {
      children: [
        (0, _jsx)("span", {
          className: "flex size-4 shrink-0 items-center justify-center",
          "aria-hidden": true,
          children: (0, _jsx)(ChevronRight, {
            className: expanded
              ? "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200 rotate-90"
              : "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
          }),
        }),
        latestCreatedAt && tlCtx?.timestampFormat
          ? (0, _jsx)(Timestamp, { createdAt: latestCreatedAt, timestampFormat: tlCtx.timestampFormat })
          : null,
      ],
    });
    const toggleProps = {
      role: "button",
      tabIndex: 0,
      "aria-label": ariaLabel,
      "aria-expanded": expanded,
      onKeyDown: (ev) => {
        if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) {
          ev.preventDefault();
          toggle();
        }
      },
    };
    return (0, _jsx)(WorkRow, {
      "data-work-entry-id": group.id,
      "data-t3e-same-file-group": group.kind,
      onClick: toggle,
      toggle: toggleProps,
      icon: (0, _jsx)("span", {
        className: iconClass,
        children: (0, _jsx)(WorkIcon, {
          fallbackName: hasFailure ? "circle-alert" : group.kind === "edit" ? "square-pen" : "eye",
          className: "block size-4 shrink-0 stroke-2",
          muted: !hasFailure,
        }),
      }),
      label: labelNode,
      trailing: trailingNode,
      children: expanded
        ? (0, _jsx)("div", {
            "data-tool-group-scroll": true,
            className: "t3e-same-file-children cursor-auto flex min-w-0 flex-col gap-1",
            onClick: (ev) => ev?.stopPropagation?.(),
            onPointerDown: (ev) => ev?.stopPropagation?.(),
            children: group.entries.map((entry) => (0, _jsx)(WorkEntryRow, { workEntry: entry, workspaceRoot }, entry.id)),
          })
        : null,
    });
  }

  function t3RenderSameFileChildren(entries, workspaceRoot) {
    const grouped = groupSameFileEntries(entries, workspaceRoot, {
      isEntryFailed: typeof isEntryFailed === "function" ? isEntryFailed : undefined,
      getAction: typeof getAction === "function" ? getAction : undefined,
      extractPaths: typeof extractPaths === "function" ? extractPaths : undefined,
      extractReadDetailPath: typeof extractReadDetailPath === "function" ? extractReadDetailPath : undefined,
      resolveRelPath: typeof resolveRelPath === "function" ? resolveRelPath : undefined,
    });
    return grouped.map((item) =>
      item.type === "file-group"
        ? (0, _jsx)(T3SameFileGroup, { group: item, workspaceRoot }, item.id)
        : (0, _jsx)(WorkEntryRow, { workEntry: item.entry, workspaceRoot }, item.entry.id)
    );
  }

  return { T3SameFileGroup, t3RenderSameFileChildren };
}

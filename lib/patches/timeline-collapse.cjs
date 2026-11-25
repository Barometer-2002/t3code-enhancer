"use strict";

const assert = require("node:assert/strict");

const ID = "timeline-collapse";
const MARKER = "T3_TIMELINE_CASCADE_V6";
const LEGACY_MARKERS = ["T3_TIMELINE_CASCADE_V1", "T3_TIMELINE_CASCADE_V2", "T3_TIMELINE_CASCADE_V3", "T3_TIMELINE_CASCADE_V4", "T3_TIMELINE_CASCADE_V5"];
const TARGET_REGEX = /^apps\/server\/dist\/client\/assets\/useTimelineFollow-[\w-]+\.js$/;
const ORIGINAL_HASH = "afeaa4340a84a41745b0133a8e552db55c821e68c9085de78e22f299cb6fde37";

const handlersStart = "let cn=sn,ln;";
const handlersEnd = "let mn=pn,hn=F?.runId";
const rowsAnchor = 'let Vn=Dx(Ex(`${Y}\\0${ve??``}`,Bn),Y),Hn;';
const toolGroupStart = "function R_(e){let t=(0,Q.c)(63),{anchorKey:n,disclosureAnchorKey:r,entries:i,groupedEntries:a,workspaceRoot:o}=e,";
const toolGroupEnd = "var z_=e=>e.id;";

function disclosureIds(rows) {
  const ids = { attempts: new Set(), groups: new Set(), details: new Set(), entries: new Set() };
  for (const row of rows) {
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

function resetHiddenDisclosures(before, after, state) {
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

function updateDisclosure(ids, id) {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

const T3_PATH_KEYS = [
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

function t3NormFilePath(raw, workspaceRoot, resolveRelPath) {
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

function t3ExtractWorkEntryPaths(entry, extraPaths) {
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

function t3GetFoldableFileInfo(entry, workspaceRoot, deps = {}) {
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
  if (projType === "approval_request" || projType === "user_input_request" || (projType === "error" && entry.projectedItem?.item?.status === "failed")) {
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

function t3FormatReadRanges(entries) {
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

function t3AggregateEditStats(entries) {
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

function groupSameFileEntries(entries, workspaceRoot, deps = {}) {
  const buckets = new Map();
  const infos = (entries || []).map((entry) => {
    const info = t3GetFoldableFileInfo(entry, workspaceRoot, deps);
    if (info) {
      let list = buckets.get(info.key);
      if (!list) {
        list = [];
        buckets.set(info.key, list);
      }
      list.push(entry);
    }
    return info;
  });
  const result = [];
  const emitted = new Set();
  for (let idx = 0; idx < (entries || []).length; idx += 1) {
    const entry = entries[idx];
    const info = infos[idx];
    const bucket = info ? buckets.get(info.key) : null;
    if (!info || !bucket || bucket.length < 2) {
      result.push({ type: "single", entry });
    } else if (!emitted.has(info.key)) {
      emitted.add(info.key);
      result.push({
        type: "file-group",
        id: `${bucket[0].id}:file-fold`,
        key: info.key,
        kind: info.kind,
        filePath: info.filePath,
        entries: bucket,
      });
    }
  }
  return result;
}

function apply(source) {
  const start = source.indexOf(handlersStart);
  const end = source.indexOf(handlersEnd);
  assert(start >= 0 && end > start && start === source.lastIndexOf(handlersStart), "Timeline toggle handlers changed");
  assert.equal(end, source.lastIndexOf(handlersEnd), "Timeline handlers end anchor changed");
  assert(source.includes(rowsAnchor) && source.indexOf(rowsAnchor) === source.lastIndexOf(rowsAnchor), "Timeline projection changed");
  assert(!/\b(?:un|fn|mn|ln|pn)\b/.test(source.slice(end + handlersEnd.length, source.indexOf(rowsAnchor))), "A handler or temp var is used before projection");

  const helpers = [
    disclosureIds,
    resetHiddenDisclosures,
    updateDisclosure,
    t3ParseMaybeObject,
    t3CollectPathsFromInput,
    t3NormFilePath,
    t3ExtractWorkEntryPaths,
    t3GetFoldableFileInfo,
    t3FormatReadRanges,
    t3AggregateEditStats,
    groupSameFileEntries,
  ].map((fn) => fn.toString()).join("\n") + `
const T3_PATH_KEYS = ${JSON.stringify(T3_PATH_KEYS)};
const t3UseMemo = typeof Z !== "undefined" && typeof Z.useMemo === "function" ? Z.useMemo : (fn) => fn();
const t3UseEffect = typeof Z !== "undefined" && typeof Z.useEffect === "function" ? Z.useEffect : () => {};
function t3EnsureTimelineStyles() {
  if (typeof document === "undefined" || !document.head || document.getElementById("t3e-timeline-styles")) return;
  const st = document.createElement("style");
  st.id = "t3e-timeline-styles";
  st.textContent = \`
.t3e-tool-group-flat{display:flex;flex-direction:column;gap:2px}
.t3e-same-file-children{padding-left:18px;border-left:1px solid var(--border);margin:2px 0 4px 8px}
\`;
  document.head.appendChild(st);
}
function T3SameFileGroup({ group, workspaceRoot }) {
  const cdCtx = (0, Z.use)(Cd);
  const tlCtx = (0, Z.use)(xd);
  const translate = J();
  const isStateExpanded = Boolean(cdCtx?.state?.expandedEntries?.has?.(group.id));
  const [expanded, setExpanded] = (0, Z.useState)(() => isStateExpanded);
  t3UseEffect(() => {
    t3EnsureTimelineStyles();
  }, []);
  t3UseEffect(() => {
    setExpanded(isStateExpanded);
  }, [isStateExpanded]);
  const isZh = /[\\u4e00-\\u9fff]/.test(translate("Read")) || (typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || ""));
  const hasFailure = group.entries.some((e) => typeof ws === "function" && Boolean(ws(e)));
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
  const rangeText = t3UseMemo(() => (group.kind === "read" ? t3FormatReadRanges(group.entries) : null), [group.kind, group.entries]);
  const editStats = t3UseMemo(() => (group.kind === "edit" ? t3AggregateEditStats(group.entries) : null), [group.kind, group.entries]);
  const showEditStats = Boolean(editStats && (editStats.additions > 0 || editStats.deletions > 0));
  const ariaLabel = baseLabel + " (" + countText + ")";
  const iconClass = hasFailure
    ? "flex size-4 items-center justify-center text-destructive"
    : "flex size-4 items-center justify-center text-icon-muted";
  const labelClass = hasFailure ? "font-medium text-destructive" : "text-foreground/80";
  const latestCreatedAt = group.entries.at(-1)?.createdAt ?? group.entries[0]?.createdAt;
  const labelNode = (0, $.jsx)("div", {
    className: "min-w-0 flex-1 overflow-hidden",
    children: (0, $.jsxs)("p", {
      className: "flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed",
      children: [
        (0, $.jsxs)("span", {
          className: "min-w-0 flex-1 truncate " + labelClass,
          children: [
            baseLabel,
            (0, $.jsx)("span", {
              className: "ms-1.5 text-muted-foreground opacity-80",
              children: rangeText ? " · " + countText + " (" + rangeText + ")" : " · " + countText,
            }),
            showEditStats
              ? (0, $.jsxs)("span", {
                  className: "t3e-fc-stats ms-1.5 inline-flex items-baseline gap-1",
                  children: [
                    editStats.additions > 0
                      ? (0, $.jsx)("span", { className: "t3e-fc-add", children: "+" + editStats.additions })
                      : null,
                    editStats.deletions > 0
                      ? (0, $.jsx)("span", { className: "t3e-fc-del", children: "-" + editStats.deletions })
                      : null,
                  ],
                })
              : null,
          ],
        }),
      ],
    }),
  });
  const trailingNode = (0, $.jsxs)($.Fragment, {
    children: [
      (0, $.jsx)("span", {
        className: "flex size-4 shrink-0 items-center justify-center",
        "aria-hidden": true,
        children: (0, $.jsx)(Nt, {
          className: expanded
            ? "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200 rotate-90"
            : "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
        }),
      }),
      latestCreatedAt && tlCtx?.timestampFormat
        ? (0, $.jsx)(uc, { createdAt: latestCreatedAt, timestampFormat: tlCtx.timestampFormat })
        : null,
    ],
  });
  return (0, $.jsx)(Zf, {
    "data-work-entry-id": group.id,
    "data-t3e-same-file-group": group.kind,
    role: "button",
    tabIndex: 0,
    "aria-label": ariaLabel,
    "aria-expanded": expanded,
    onClick: toggle,
    onKeyDown: (ev) => {
      if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) {
        ev.preventDefault();
        toggle();
      }
    },
    icon: (0, $.jsx)("span", {
      className: iconClass,
      children: (0, $.jsx)(Vp, {
        fallbackName: hasFailure ? "circle-alert" : group.kind === "edit" ? "square-pen" : "eye",
        className: "block size-4 shrink-0 stroke-2",
        muted: !hasFailure,
      }),
    }),
    label: labelNode,
    trailing: trailingNode,
    children: expanded
      ? (0, $.jsx)("div", {
          "data-tool-group-scroll": true,
          className: "t3e-same-file-children cursor-auto flex min-w-0 flex-col gap-1",
          onClick: (ev) => ev?.stopPropagation?.(),
          onPointerDown: (ev) => ev?.stopPropagation?.(),
          children: group.entries.map((entry) => (0, $.jsx)(D_, { workEntry: entry, workspaceRoot }, entry.id)),
        })
      : null,
  });
}
function t3RenderSameFileChildren(entries, workspaceRoot) {
  const grouped = groupSameFileEntries(entries, workspaceRoot, {
    getAction: typeof fs === "function" ? fs : undefined,
    extractPaths: typeof ym === "function" ? ym : undefined,
    extractReadDetailPath: typeof ds === "function" ? ds : undefined,
    resolveRelPath: typeof Xr === "function" ? Xr : undefined,
  });
  return grouped.map((item) =>
    item.type === "file-group"
      ? (0, $.jsx)(T3SameFileGroup, { group: item, workspaceRoot }, item.id)
      : (0, $.jsx)(D_, { workEntry: item.entry, workspaceRoot }, item.entry.id)
  );
}
`;
  const callbacks = `
/* ${MARKER} */
const clearHiddenTimelineRows = (nextProjection) => {
  const changed = resetHiddenDisclosures(Vn, Dh(nextProjection), Kt);
  if (changed.hiddenAttempts.size) Dt(ids => new Set([...ids].filter(id => !changed.hiddenAttempts.has(id))));
  if (changed.hiddenGroups.size) wt(ids => new Set([...ids].filter(id => !changed.hiddenGroups.has(id))));
};
const un = fa(id => {
  cn(\`turn-fold:\${id}\`);
  if (jn.has(id)) clearHiddenTimelineRows({ ...Bn, expandedRunIds: updateDisclosure(jn, id) });
  bt(ids => updateDisclosure(ids, id));
});
const fn = fa((id, rowId) => {
  cn(rowId, St.has(id) ? undefined : { contentKey: \`\${id}:details\` });
  if (St.has(id)) clearHiddenTimelineRows({ ...Bn, expandedWorkGroupIds: updateDisclosure(St, id) });
  wt(ids => updateDisclosure(ids, id));
});
const mn = fa(id => {
  cn(\`attempt-fold:\${id}\`);
  if (Fn.has(id)) clearHiddenTimelineRows({ ...Bn, expandedAttemptIds: updateDisclosure(Fn, id) });
  Dt(ids => updateDisclosure(ids, id));
});
`;
  const tgStart = source.indexOf(toolGroupStart);
  const tgEnd = source.indexOf(toolGroupEnd, tgStart >= 0 ? tgStart : 0);
  assert(tgStart >= 0 && tgEnd > tgStart && tgStart === source.lastIndexOf(toolGroupStart), "Tool group R_ anchor changed");

  const flatToolGroupFn =
    "var R_=(0,Z.memo)(function(e){" +
    "let{disclosureAnchorKey:r,entries:i,groupedEntries:a,workspaceRoot:o}=e," +
    "{workGroupViewState:s,onToggleWorkEntry:c,onWorkEntryContentReady:l}=(0,Z.use)(xd)," +
    "u=J(),w=I_(a)," +
    "O=(0,Z.useMemo)(()=>({state:s,viewedImages:w,onToggleEntry:(t,n)=>c(r,t,n),onContentReady:t=>l?.(r,t)}),[s,w,r,c,l])," +
    "k=(0,Z.useMemo)(()=>t3RenderSameFileChildren(i,o),[i,o]);" +
    "return(0,$.jsx)(Cd,{value:O,children:(0,$.jsx)(Kf,{children:(0,$.jsx)(`div`,{role:`region`,\"aria-label\":u(`Tool calls`),\"data-tool-group-scroll\":!0,className:`t3e-tool-group-flat`,children:k})})})});" +
    toolGroupEnd;

  let patched = source.slice(0, start) + "let cn=sn," + "hn=F?.runId" + source.slice(end + handlersEnd.length);
  const pTgStart = patched.indexOf(toolGroupStart);
  const pTgEnd = patched.indexOf(toolGroupEnd, pTgStart);
  patched = patched.slice(0, pTgStart) + flatToolGroupFn + patched.slice(pTgEnd + toolGroupEnd.length);

  return (
    patched
      .replace(rowsAnchor, () => rowsAnchor + callbacks)
      .replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "") +
    "\n" +
    helpers +
    "\n"
  );
}

const summaryPatch = {
  id: "timeline-collapse-summary",
  name: "同文件操作摘要去重计数",
  marker: "T3_TIMELINE_SUMMARY_V2",
  legacyMarkers: ["T3_TIMELINE_SUMMARY_V1"],
  targetRegex: /^apps\/server\/dist\/client\/assets\/session-logic-[\w-]+\.js$/,
  originalHash: "2509accad1112e483945003853e194f5630b173edc88eccb726c8480654cb9c4",
  apply(source) {
    const ceAnchor = "var ce=[`path`,`filePath`,`file_path`,`relativePath`,`filename`,`fileName`,`newPath`,`oldPath`];";
    const beAnchor = "function Be(e,t){if(e!==`edit`)return t.length;let n=new Set,r=0;for(let e of t)if(!e.changedFiles||e.changedFiles.length===0)r+=1;else for(let t of e.changedFiles)n.add(t);return n.size+r}";
    assert(source.includes(ceAnchor) && source.indexOf(ceAnchor) === source.lastIndexOf(ceAnchor), "Could not locate session-logic path keys anchor");
    assert(source.includes(beAnchor) && source.indexOf(beAnchor) === source.lastIndexOf(beAnchor), "Could not locate session-logic Be count anchor");
    const normHelper = "let norm=p=>{let s=String(p??``).trim().replaceAll(`\\\\`, `/`).replace(/^\\.\\//,``);return/^[A-Za-z]:\\//.test(s)?s.toLowerCase():s};";
    const replacementBe =
      `function Be(e,t){/* ${summaryPatch.marker} */` +
      normHelper +
      "if(e===`edit`){let n=new Set,r=0;for(let e of t){let i=(e.changedFiles?.length??e.changedFiles?.size??0)>0?e.changedFiles:w(V(e));if(!i||(i.length??i.size??0)===0)r+=1;else for(let t of i)n.add(norm(t))}return n.size+r}" +
      "if(e===`read`){let n=new Set,r=0;for(let e of t){let i=Le(e),a=i?[i]:w({input:V(e),detail:e.detail});if(!a||(a.length??a.size??0)===0)r+=1;else for(let t of a)n.add(norm(t))}return n.size+r}" +
      "return t.length}";
    return source
      .replace(ceAnchor, "var ce=[`path`,`Path`,`filePath`,`file_path`,`relativePath`,`filename`,`fileName`,`targetFile`,`target_file`,`targetPath`,`target_path`,`newPath`,`oldPath`];")
      .replace(beAnchor, replacementBe)
      .replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "");
  },
};

module.exports = {
  id: ID,
  name: "收起上级联动收起下级 + 一级工具列表平铺展开 + 同文件折叠",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  apply,
  summaryPatch,
  disclosureIds,
  resetHiddenDisclosures,
  updateDisclosure,
  t3NormFilePath,
  t3ExtractWorkEntryPaths,
  t3GetFoldableFileInfo,
  t3FormatReadRanges,
  t3AggregateEditStats,
  groupSameFileEntries,
};

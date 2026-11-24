"use strict";

const assert = require("node:assert/strict");

const ID = "timeline-collapse";
const MARKER = "T3_TIMELINE_CASCADE_V2";
const LEGACY_MARKERS = ["T3_TIMELINE_CASCADE_V1"];
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
      for (const entry of row.groupedEntries ?? []) ids.entries.add(entry.id);
      for (const entry of row.entries ?? []) ids.entries.add(entry.id);
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

function apply(source) {
  const start = source.indexOf(handlersStart);
  const end = source.indexOf(handlersEnd);
  assert(start >= 0 && end > start && start === source.lastIndexOf(handlersStart), "Timeline toggle handlers changed");
  assert.equal(end, source.lastIndexOf(handlersEnd), "Timeline handlers end anchor changed");
  assert(source.includes(rowsAnchor) && source.indexOf(rowsAnchor) === source.lastIndexOf(rowsAnchor), "Timeline projection changed");
  assert(!/\b(?:un|fn|mn|ln|pn)\b/.test(source.slice(end + handlersEnd.length, source.indexOf(rowsAnchor))), "A handler or temp var is used before projection");

  const helpers = [disclosureIds, resetHiddenDisclosures, updateDisclosure].map((fn) => fn.toString()).join("\n");
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
    "function R_(e){" +
    "let{disclosureAnchorKey:r,entries:i,groupedEntries:a,workspaceRoot:o}=e," +
    "{workGroupViewState:s,onToggleWorkEntry:c,onWorkEntryContentReady:l}=(0,Z.use)(xd)," +
    "u=J(),w=I_(a)," +
    "O=(0,Z.useMemo)(()=>({state:s,viewedImages:w,onToggleEntry:(t,n)=>c(r,t,n),onContentReady:t=>l?.(r,t)}),[s,w,r,c,l]);" +
    "return(0,$.jsx)(Cd,{value:O,children:(0,$.jsx)(Kf,{children:(0,$.jsx)(`div`,{role:`region`,\"aria-label\":u(`Tool calls`),\"data-tool-group-scroll\":!0,className:`t3e-tool-group-flat`,children:i.map(t=>(0,$.jsx)(D_,{workEntry:t,workspaceRoot:o},t.id))})})})}" +
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

module.exports = {
  id: ID,
  name: "收起上级联动收起下级 + 一级工具列表平铺展开",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  apply,
  disclosureIds,
  resetHiddenDisclosures,
  updateDisclosure,
};

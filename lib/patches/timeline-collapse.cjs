const assert = require("node:assert/strict");

const ID = "timeline-collapse";
const MARKER = "T3_TIMELINE_CASCADE_V1";

const PROFILE_0111 = {
  version: "0.1.11",
  targetRegex: /^apps\/server\/dist\/client\/assets\/useTimelineFollow-[\w-]+\.js$/,
  originalHash: "afeaa4340a84a41745b0133a8e552db55c821e68c9085de78e22f299cb6fde37",
  handlersStart: "let cn=sn,ln;",
  handlersEnd: "let mn=pn,hn=F?.runId",
  replacedPrefix: "let cn=sn,hn=F?.runId",
  rowsAnchor: 'let Vn=Dx(Ex(`${Y}\\0${ve??``}`,Bn),Y),Hn;',
  handlerNamesRegex: /\b(?:un|fn|mn)\b/,
  sym: {
    rows: "Vn",
    projectRows: (arg) => `Dh(${arg})`,
    viewState: "Kt",
    projInput: "Bn",
    stableCb: "fa",
    anchorScroll: "cn",
    turnHandler: "un",
    groupHandler: "fn",
    attemptHandler: "mn",
    runIds: "jn",
    setRunIds: "bt",
    groupIds: "St",
    setGroupIds: "wt",
    attemptIds: "Fn",
    setAttemptIds: "Dt",
  },
};

const PROFILE_0112 = {
  version: "0.1.12",
  targetRegex: /^apps\/server\/dist\/client\/assets\/ReadOnlyThreadTimeline-[\w-]+\.js$/,
  originalHash: "4f05fa222be71b9cb2fc21f98580cc78c11453e98e06285456718594b0082231",
  handlersStart: "let mn=pn,hn;",
  handlersEnd: "let bn=yn,xn=F?.runId",
  replacedPrefix: "let mn=pn,xn=F?.runId",
  rowsAnchor: 'let qn=Wy(Uy(`${St}\\0${be??``}`,Kn),St),Jn;',
  handlerNamesRegex: /\b(?:gn|vn|bn)\b/,
  sym: {
    rows: "qn",
    // ReadOnlyThreadTimeline destructures `onFileDownload:he` inside the component; calling jf(arg) defaults to module-scope Ri safely.
    projectRows: (arg) => `jf(${arg}).rows`,
    viewState: "Qt",
    projInput: "Kn",
    stableCb: "Ja",
    anchorScroll: "mn",
    turnHandler: "gn",
    groupHandler: "vn",
    attemptHandler: "bn",
    runIds: "Ln",
    setRunIds: "Ot",
    groupIds: "At",
    setGroupIds: "jt",
    attemptIds: "Vn",
    setAttemptIds: "Pt",
  },
};

function disclosureIds(rows) {
  const ids = { attempts: new Set(), groups: new Set(), details: new Set(), entries: new Set() };
  for (const row of rows) {
    if (row.kind === "attempt-fold") ids.attempts.add(row.attemptId);
    if ((row.kind === "work-toggle" || row.kind === "work-live" || row.kind === "thinking") && row.groupId !== undefined) {
      ids.groups.add(row.groupId);
    }
    if (row.kind === "work" && row.isExpandedToolGroup) ids.details.add(row.id);
    if (row.kind === "work") {
      for (const entry of row.groupedEntries) ids.entries.add(entry.id);
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
  for (const id of previous.details) if (!remaining.details.has(id)) state.scrollPositions.delete(id);
  for (const id of previous.entries) if (!remaining.entries.has(id)) state.expandedEntries.delete(id);
  return { hiddenAttempts, hiddenGroups };
}

function updateDisclosure(ids, id, hidden = []) {
  const next = new Set(ids);
  for (const child of hidden) next.delete(child);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function applyWithProfile(source, profile) {
  const start = source.indexOf(profile.handlersStart);
  const end = source.indexOf(profile.handlersEnd);
  assert(start >= 0 && end > start && start === source.lastIndexOf(profile.handlersStart), "Timeline toggle handlers changed");
  assert.equal(end, source.lastIndexOf(profile.handlersEnd), "Timeline handlers end anchor changed");
  const rowsPos = source.indexOf(profile.rowsAnchor);
  assert(rowsPos >= 0 && rowsPos === source.lastIndexOf(profile.rowsAnchor), "Timeline projection changed");
  assert(!profile.handlerNamesRegex.test(source.slice(end + profile.handlersEnd.length, rowsPos)), "A handler is used before projection");

  const s = profile.sym;
  const helpers = [disclosureIds, resetHiddenDisclosures, updateDisclosure].map((fn) => fn.toString()).join("\n");
  const callbacks = `
/* ${MARKER} */
const clearHiddenTimelineRows = (nextProjection) => {
  const changed = resetHiddenDisclosures(${s.rows}, ${s.projectRows("nextProjection")}, ${s.viewState});
  if (changed.hiddenAttempts.size) ${s.setAttemptIds}(ids => new Set([...ids].filter(id => !changed.hiddenAttempts.has(id))));
  if (changed.hiddenGroups.size) ${s.setGroupIds}(ids => new Set([...ids].filter(id => !changed.hiddenGroups.has(id))));
};
const ${s.turnHandler} = ${s.stableCb}(id => {
  ${s.anchorScroll}(\`turn-fold:\${id}\`);
  if (${s.runIds}.has(id)) clearHiddenTimelineRows({ ...${s.projInput}, expandedRunIds: updateDisclosure(${s.runIds}, id) });
  ${s.setRunIds}(ids => updateDisclosure(ids, id));
});
const ${s.groupHandler} = ${s.stableCb}((id, rowId) => {
  ${s.anchorScroll}(rowId, ${s.groupIds}.has(id) ? undefined : { contentKey: \`\${id}:details\` });
  if (${s.groupIds}.has(id)) clearHiddenTimelineRows({ ...${s.projInput}, expandedWorkGroupIds: updateDisclosure(${s.groupIds}, id) });
  ${s.setGroupIds}(ids => updateDisclosure(ids, id));
});
const ${s.attemptHandler} = ${s.stableCb}(id => {
  ${s.anchorScroll}(\`attempt-fold:\${id}\`);
  if (${s.attemptIds}.has(id)) clearHiddenTimelineRows({ ...${s.projInput}, expandedAttemptIds: updateDisclosure(${s.attemptIds}, id) });
  ${s.setAttemptIds}(ids => updateDisclosure(ids, id));
});
`;
  const patched = source.slice(0, start) + profile.replacedPrefix + source.slice(end + profile.handlersEnd.length);
  return (
    patched
      .replace(profile.rowsAnchor, profile.rowsAnchor + callbacks)
      .replace(/\n?\/\/# sourceMappingURL=.*$/m, "") +
    "\n" +
    helpers +
    "\n"
  );
}

const apply0111 = (source) => applyWithProfile(source, PROFILE_0111);
const apply0112 = (source) => applyWithProfile(source, PROFILE_0112);

const TARGETS = [
  {
    version: PROFILE_0111.version,
    targetRegex: PROFILE_0111.targetRegex,
    originalHash: PROFILE_0111.originalHash,
    apply: apply0111,
  },
  {
    version: PROFILE_0112.version,
    targetRegex: PROFILE_0112.targetRegex,
    originalHash: PROFILE_0112.originalHash,
    apply: apply0112,
  },
];

module.exports = {
  id: ID,
  name: "收起上级联动收起下级菜单",
  marker: MARKER,
  targetRegex: PROFILE_0111.targetRegex,
  originalHash: PROFILE_0111.originalHash,
  apply: apply0111,
  targets: TARGETS,
  disclosureIds,
  resetHiddenDisclosures,
  updateDisclosure,
};

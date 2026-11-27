"use strict";

const assert = require("node:assert/strict");
const { findUniqueFunction, parseImports, tokenize, unquote } = require("../js-ast.cjs");
const { THREAD_ROUTE } = require("../resolver.cjs");

const ID = "new-chat-layout";
const MARKER = "T3_NEW_CHAT_LAYOUT_V9";
const LEGACY_MARKERS = ["T3_NEW_CHAT_LAYOUT_V1", "T3_NEW_CHAT_LAYOUT_V2", "T3_NEW_CHAT_LAYOUT_V3", "T3_NEW_CHAT_LAYOUT_V4", "T3_NEW_CHAT_LAYOUT_V5", "T3_NEW_CHAT_LAYOUT_V6", "T3_NEW_CHAT_LAYOUT_V7", "T3_NEW_CHAT_LAYOUT_V8"];
const ORIGINAL_HASH = "5464ddf4e47841a1799079fdc05145474013f8c268224390b2dccf3f76521c9f";
const KNOWN_HASHES = ["d54743d08ba7971a22d5dc50a422f1974e3db92b1c277b3e72645fbe2e5b74ce"];

function extractChatSymbols(source, ctx) {
  const gVFn = findUniqueFunction(
    source,
    (_fn, src) => src.includes("activeProjectRef") && src.includes("activeProjectTitle") && src.includes("scratchWorkspaceRootFor"),
    "project-picker-component",
    ctx?.getTokens?.()
  );
  const src = gVFn.source;

  // React & JSX
  let react = null;
  let jsx = null;
  if (ctx?.resolveReactBindings) {
    const rb = ctx.resolveReactBindings();
    react = rb.react;
    jsx = rb.jsx;
  } else {
    const jsxUse = source.match(/\(0,\s*([A-Za-z_$][\w$]*)\.jsxs?\)\(/);
    if (jsxUse) jsx = jsxUse[1];
    const reactUse = source.match(/(?:\(0,\s*([A-Za-z_$][\w$]*)\.(?:useState|useRef|useEffect|useMemo|useLayoutEffect|memo|createContext)\)|([A-Za-z_$][\w$]*)\.(?:Suspense|Fragment|memo|useState|useRef))/);
    if (reactUse) react = reactUse[1] || reactUse[2];
  }
  assert(react && jsx, "Could not resolve React/JSX bindings for new-chat-layout");

  // Dr (clsx / cn)
  let Dr = null;
  if (ctx?.resolveImportedAlias) {
    try {
      const resolved = ctx.resolveImportedAlias(/utils-.*\.js$/, (local, text, ex, decl) => decl(local)?.includes("qp(e)") || ex.exported === "t", "cn/clsx");
      if (resolved.local) Dr = resolved.local;
    } catch {
      // fallback to import scan below
    }
  }
  if (!Dr) {
    const imports = ctx?.getImports ? ctx.getImports() : parseImports(source);
    const utilsImp = imports.find((i) => /utils-.*\.js/.test(i.specifier));
    const tSpec = utilsImp?.specifiers.find((s) => s.imported === "t");
    if (tSpec?.local) Dr = tSpec.local;
  }
  assert(Dr, "Could not resolve cn/clsx helper for new-chat-layout");

  // Branch picker component (IP)
  const branchFn = findUniqueFunction(
    source,
    (_fn, s) => s.includes("effectiveEnvModeOverride") && s.includes("activeThreadBranchOverride") && s.includes("onActiveThreadBranchOverrideChange"),
    "branch-picker-component",
    ctx?.getTokens?.()
  );
  const IP = branchFn.name;

  // gV components & hooks (supports both v0.1.12 explicit store hooks and v0.1.13 draft-switch helper)
  const headMatch = src.match(/\{draftId:[A-Za-z_$][\w$]*,activeProjectRef:[A-Za-z_$][\w$]*,activeProjectTitle:[A-Za-z_$][\w$]*\}=[A-Za-z_$][\w$]*,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),\{environments:[A-Za-z_$][\w$]*\}=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)/);
  let an, Vs, uv, xv, vv = null, Mp = null, L, OV = null, DV = null, EV = null, addProjectDialog = null;
  let Qd, cv, y, Sp;
  let useDraftSwitchHelper = false;
  if (headMatch) {
    an = headMatch[2];
    Vs = headMatch[4];
    uv = headMatch[5];
    xv = headMatch[7];
    vv = headMatch[9];
    Mp = headMatch[10];
    L = headMatch[12];
    OV = headMatch[13];
    DV = headMatch[16];
    const evMatch = src.match(/=([A-Za-z_$][\w$]*),\{scratchEnvironmentId:[A-Za-z_$][\w$]*,scratchWorkspaceRootFor:[A-Za-z_$][\w$]*,openScratchProject:[A-Za-z_$][\w$]*\}=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)/);
    assert(evMatch, "Could not extract EV/Qd/cv/y/Sp from gV");
    EV = evMatch[1];
    Qd = evMatch[2];
    cv = evMatch[4];
    y = evMatch[6];
    Sp = evMatch[7];
  } else {
    const headMatchV13 = src.match(/\{draftId:[A-Za-z_$][\w$]*,activeProjectRef:[A-Za-z_$][\w$]*,activeProjectTitle:[A-Za-z_$][\w$]*\}=[A-Za-z_$][\w$]*,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),\{environments:[A-Za-z_$][\w$]*\}=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),/);
    assert(headMatchV13, "Could not extract head symbols from gV");
    useDraftSwitchHelper = true;
    an = headMatchV13[2];
    Vs = headMatchV13[4];
    uv = headMatchV13[5];
    xv = headMatchV13[7];
    const storeMatch = src.match(/([A-Za-z_$][\w$]*)\.getState\(\)\.getDraftSession\(/);
    assert(storeMatch, "Could not extract draft store (L) from gV");
    L = storeMatch[1];
    const dialogMatch = src.match(/([A-Za-z_$][\w$]*)\(\{open:`add-project`,draftId:/);
    assert(dialogMatch, "Could not extract add-project dialog trigger from gV");
    addProjectDialog = dialogMatch[1];
    const scratchMatch = src.match(/\{scratchEnvironmentId:[A-Za-z_$][\w$]*,scratchWorkspaceRootFor:[A-Za-z_$][\w$]*,openScratchProject:[A-Za-z_$][\w$]*\}=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)/);
    assert(scratchMatch, "Could not extract Qd/cv/y/Sp from gV");
    Qd = scratchMatch[1];
    cv = scratchMatch[3];
    y = scratchMatch[5];
    Sp = scratchMatch[6];
  }

  const gsMatch = src.match(/([A-Za-z_$][\w$]*)\(\),[A-Za-z_$][\w$]*=\(0,\s*[A-Za-z_$][\w$]*\.useRef\)\(null\),\{canPinProjectGroup:[A-Za-z_$][\w$]*,toggleProjectGroupPin:[A-Za-z_$][\w$]*\}=([A-Za-z_$][\w$]*)\(\)/);
  assert(gsMatch, "Could not extract gS and kv from gV");
  const gS = gsMatch[1];
  const kv = gsMatch[2];

  // 3. TV, rd, wC, wV
  const mapTvMatch = src.match(/\.map\(([A-Za-z_$][\w$]*)\)\).*?=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\).*?=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\).*?\.map\(([A-Za-z_$][\w$]*)\)\)/);
  assert(mapTvMatch, "Could not extract TV/rd/wC/wV from gV");
  const TV = mapTvMatch[1];
  const rd = mapTvMatch[2];
  const wC = mapTvMatch[3];
  const wV = mapTvMatch[4];

  // 4. TC, Pp, CV, Rt, Ib
  const tcMatch = src.match(/([A-Za-z_$][\w$]*)\(\{groups:([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\),preferredProjectRef:[A-Za-z_$][\w$]*\}\).*?\.map\(([A-Za-z_$][\w$]*)\)/);
  assert(tcMatch, "Could not extract TC/Pp/CV from gV");
  const TC = tcMatch[1];
  const Pp = tcMatch[2];
  const CV = tcMatch[3];

  const rtMatch = src.match(/([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\)===\1\([A-Za-z_$][\w$]*\)/);
  assert(rtMatch, "Could not extract Rt from gV");
  const Rt = rtMatch[1];

  const ibMatch = src.match(/([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.environmentId\)\)/);
  assert(ibMatch, "Could not extract Ib from gV");
  const Ib = ibMatch[1];

  // 5. Cu, SV, hV, xV, bV
  const svMatch = src.match(/\.map\(([A-Za-z_$][\w$]*)\),.*?\{value:([A-Za-z_$][\w$]*),label:/);
  assert(svMatch, "Could not extract SV and hV from gV");
  const SV = svMatch[1];
  const hV = svMatch[2];

  const cuDirect = src.match(/,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*);let [A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.map/);
  assert(cuDirect, "Could not extract Cu from gV");
  const Cu = cuDirect[2];

  const xvMatch = src.match(/=\w+\(\w+,([A-Za-z_$][\w$]*),\w+\),.*?\.filter\(/);
  assert(xvMatch, "Could not extract xV from gV");
  const xV = xvMatch[1];

  const bvMatch = src.match(/\.contains\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*,([A-Za-z_$][\w$]*)\)/);
  assert(bvMatch, "Could not extract bV from gV");
  const bV = bvMatch[1];

  // 6. Rr, Ct, Ed, Np (v0.1.12) or switchDraftFn, Rr (v0.1.13)
  let Rr, Ct = null, Ed = null, Np = null, switchDraftFn = null;
  if (!useDraftSwitchHelper) {
    const rrMatch = src.match(/([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.environmentId,[A-Za-z_$][\w$]*\.id\);([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\)\?\(.*?,([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\)/);
    assert(rrMatch, "Could not extract Rr/Ct/Ed from gV");
    Rr = rrMatch[1];
    Ct = rrMatch[2];
    Ed = rrMatch[3];

    const npMatch = src.match(/([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\),!0\)/);
    assert(npMatch, "Could not extract Np from gV");
    Np = npMatch[1];
  } else {
    const swMatch = src.match(/([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,([A-Za-z_$][\w$]*)\)\|\|[A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)\(\2\.environmentId,\2\.id\)\)/);
    assert(swMatch, "Could not extract switchDraftFn/Rr from gV");
    switchDraftFn = swMatch[1];
    Rr = swMatch[3];
  }

  // 7. bS, yV, vV, xS, yS, hS, vS, J, mS, _S, dV, fg, Hd, wv, sy, Dv, Au
  const bsMatch = src.match(/\(0,\s*[A-Za-z_$][\w$]*\.jsxs?\)\(([A-Za-z_$][\w$]*),\{items:[A-Za-z_$][\w$]*,filteredItems:[A-Za-z_$][\w$]*,autoHighlight:!0,itemToStringLabel:([A-Za-z_$][\w$]*),isItemEqualToValue:([A-Za-z_$][\w$]*)/);
  assert(bsMatch, "Could not extract bS/yV/vV from gV");
  const bS = bsMatch[1];
  const yV = bsMatch[2];
  const vV = bsMatch[3];

  const gvTokens = tokenize(src);
  const triggerPropTok = gvTokens.findIndex((tok, i) =>
    (tok.type === "string" || tok.type === "template") &&
    unquote(tok.value) === "data-draft-project-trigger" &&
    gvTokens[i + 1]?.type === "punct" &&
    gvTokens[i + 1].value === ":"
  );
  assert(triggerPropTok > 0, "Could not locate data-draft-project-trigger in gV");
  let xS = null;
  let triggerDepth = 0;
  for (let i = triggerPropTok - 1; i >= 3; i--) {
    const tok = gvTokens[i];
    if (tok.type !== "punct") continue;
    if (tok.value === "}" || tok.value === ")" || tok.value === "]") {
      triggerDepth++;
    } else if (tok.value === "{" || tok.value === "(" || tok.value === "[") {
      if (triggerDepth === 0 && tok.value === "{") {
        if (
          gvTokens[i - 1]?.type === "punct" && gvTokens[i - 1].value === "," &&
          gvTokens[i - 2]?.type === "ident" &&
          gvTokens[i - 3]?.type === "punct" && gvTokens[i - 3].value === "("
        ) {
          xS = gvTokens[i - 2].value;
        }
        break;
      }
      triggerDepth--;
    }
  }
  assert(xS, "Could not extract xS from gV");
  const allImports = ctx?.getImports ? ctx.getImports() : parseImports(source);
  const comboboxImp = allImports.find((imp) => imp.specifiers.some((sp) => sp.local === bS));
  if (comboboxImp) {
    assert(
      comboboxImp.specifiers.some((sp) => sp.local === xS),
      `Extracted project trigger ${xS} must come from the same combobox module as ${bS} (${comboboxImp.specifier})`
    );
  }

  const dvMatch = src.match(/"data-draft-project-trigger":.*?\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{value:/);
  assert(dvMatch, "Could not extract dV from gV");
  const dV = dvMatch[1];

  const ysMatch = src.match(/\(0,\s*[A-Za-z_$][\w$]*\.jsxs?\)\(([A-Za-z_$][\w$]*),\{align:[`'"]center[`'"]/);
  assert(ysMatch, "Could not extract yS from gV");
  const yS = ysMatch[1];

  const hsMatch = src.match(/\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{"aria-label":/);
  assert(hsMatch, "Could not extract hS from gV");
  const hS = hsMatch[1];

  const vsMatch = src.match(/\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{children:\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{children:[`'"]No matching projects\.[`'"]\}\)\}\)/);
  assert(vsMatch, "Could not extract vS and J from gV");
  const vS = vsMatch[1];
  const J = vsMatch[2];

  const msMatch = src.match(/\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{children:[A-Za-z_$][\w$]*=>\{/);
  assert(msMatch, "Could not extract mS from gV");
  const mS = msMatch[1];

  const underSMatch = src.match(/\(0,\s*[A-Za-z_$][\w$]*\.jsxs?\)\(([A-Za-z_$][\w$]*),\{hideIndicator:!0,value:[A-Za-z_$][\w$]*,children:\[[A-Za-z_$][\w$]*\.value===[A-Za-z_$][\w$]*\?\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{className:[`'"]size-4 shrink-0[`'"]\}\):[A-Za-z_$][\w$]*\?\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{project:/);
  assert(underSMatch, "Could not extract _S/fg/Hd from gV");
  const _S = underSMatch[1];
  const fg = underSMatch[2];
  const Hd = underSMatch[3];

  const wvMatch = src.match(/\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{name:[A-Za-z_$][\w$]*\.group\.displayName,pinned:[A-Za-z_$][\w$]*\.group\.pinned,shortcutLabel:([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[`'"]thread\.pin[`'"]\)/);
  assert(wvMatch, "Could not extract wv and sy from gV");
  const wv = wvMatch[1];
  const sy = wvMatch[2];

  const dvKeyMatch = src.match(/([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\&\&\([A-Za-z_$][\w$]*\.preventDefault\(\)/);
  assert(dvKeyMatch, "Could not extract Dv from gV");
  const Dv = dvKeyMatch[1];

  const auMatch = src.match(/\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{group:[A-Za-z_$][\w$]*\.group,primaryEnvironmentId:[A-Za-z_$][\w$]*,machineByEnvironmentId:[A-Za-z_$][\w$]*\}\)/);
  assert(auMatch, "Could not extract Au from gV");
  const Au = auMatch[1];

  return {
    react, jsx, Dr, IP, an, Vs, uv, xv, vv, Mp, L, OV, DV, EV, addProjectDialog, Qd, cv, y, Sp, gS, kv,
    TV, rd, wC, wV, TC, Pp, CV, Rt, Ib, SV, hV, Cu, xV, bV, Rr, Ct, Ed, Np, switchDraftFn, useDraftSwitchHelper,
    bS, yV, vV, xS, dV, yS, hS, vS, J, mS, _S, fg, Hd, wv, sy, Dv, Au
  };
}

function buildInjectedComponents(sym) {
  const {
    jsx, react, Dr, IP, an, Vs, uv, xv, vv, Mp, L, OV, DV, EV, addProjectDialog, Qd, cv, y, Sp, gS, kv,
    TV, rd, wC, wV, TC, Pp, CV, Rt, Ib, SV, hV, Cu, xV, bV, Rr, Ct, Ed, Np, switchDraftFn, useDraftSwitchHelper,
    bS, yV, vV, xS, dV, yS, hS, vS, J, mS, _S, fg, Hd, wv, sy, Dv, Au
  } = sym;

  return `
/* ${MARKER} */
const T3_NO_PROJECT_VAL = "__t3e_no_project__";

function t3NcIsZh() {
  return typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
}

const T3_NC_SVGS = {
  cloud: { className: "t3e-nc-hero-icon", viewBox: "0 0 48 48", strokeWidth: "2.1", xmlns: "http://www.w3.org/2000/svg", els: [
    ["path", { d: "M16.2 35.8h15.6c4.6 0 8.2-3.4 8.2-7.8 0-3.7-2.6-6.8-6.1-7.6-.8-5.1-5.1-8.9-10.4-8.9-5.8 0-10.5 4.7-10.5 10.5 0 .4 0 .8.1 1.2-3 .9-5.1 3.6-5.1 6.8 0 3.2 2.4 5.8 5.6 5.8h2.6Z" }],
    ["path", { d: "M18.8 22.8 22.2 26l-3.4 3.2M24.8 29.2h4.4" }],
  ] },
  laptop: { className: "t3e-nc-icon", strokeWidth: "1.6", els: [["rect", { x: "3", y: "4", width: "18", height: "12", rx: "2" }], ["path", { d: "M2 20h20" }]] },
  remote: { className: "t3e-nc-icon", strokeWidth: "1.6", els: [["rect", { x: "3", y: "4", width: "18", height: "6", rx: "1.5" }], ["rect", { x: "3", y: "14", width: "18", height: "6", rx: "1.5" }], ["circle", { cx: "7", cy: "7", r: "0.8", fill: "currentColor" }], ["circle", { cx: "7", cy: "17", r: "0.8", fill: "currentColor" }]] },
  folder: { className: "t3e-nc-icon", strokeWidth: "1.6", els: [["path", { d: "M3 7a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" }]] },
  dots: { className: "t3e-nc-dots-icon", fill: "currentColor", els: [["circle", { cx: "6", cy: "12", r: "1.8" }], ["circle", { cx: "12", cy: "12", r: "1.8" }], ["circle", { cx: "18", cy: "12", r: "1.8" }]] },
  worktree: { className: "t3e-nc-icon", strokeWidth: "1.6", els: [["path", { d: "M4 12h6l5-6h5" }], ["path", { d: "M10 12l5 6h5" }], ["path", { d: "M17 4l3 2-3 2" }], ["path", { d: "M17 16l3 2-3 2" }]] },
  branch: { className: "t3e-nc-icon", strokeWidth: "1.6", els: [["circle", { cx: "6", cy: "6", r: "2.2" }], ["circle", { cx: "18", cy: "7", r: "2.2" }], ["circle", { cx: "6", cy: "18", r: "2.2" }], ["path", { d: "M6 8.2v7.6M18 9.2c0 4-3 4.8-12 4.8" }]] },
  clear: { className: "t3e-nc-clear-icon", viewBox: "0 0 16 16", els: [["circle", { cx: "8", cy: "8", r: "7", fill: "currentColor", fillOpacity: "0.42" }], ["path", { d: "M5.6 5.6 10.4 10.4M10.4 5.6 5.6 10.4", stroke: "var(--cx-surface, #fff)", strokeWidth: "1.5", strokeLinecap: "round" }]] },
  close: { className: "t3e-nc-icon", strokeWidth: "1.7", els: [["path", { d: "M18 6 6 18M6 6l12 12" }]] },
};

function t3NcSvg(name) {
  const s = T3_NC_SVGS[name];
  const stroked = Boolean(s.strokeWidth);
  const children = s.els.map(([tag, props], i) => (0, ${jsx}.jsx)(tag, { ...props, key: i }));
  return (0, ${jsx}[s.els.length > 1 ? "jsxs" : "jsx"])("svg", {
    className: s.className,
    viewBox: s.viewBox || "0 0 24 24",
    fill: s.fill || "none",
    ...(s.xmlns ? { xmlns: s.xmlns } : {}),
    ...(stroked ? { stroke: "currentColor", strokeWidth: s.strokeWidth, strokeLinecap: "round", strokeLinejoin: "round" } : {}),
    "aria-hidden": true,
    children: s.els.length === 1 ? children[0] : children,
  });
}

const T3NewChatCloudIcon = () => t3NcSvg("cloud");
const T3LaptopIcon = () => t3NcSvg("laptop");
const T3RemoteIcon = () => t3NcSvg("remote");
const T3FolderIcon = () => t3NcSvg("folder");
const T3DotsIcon = () => t3NcSvg("dots");
const T3WorktreeIcon = () => t3NcSvg("worktree");
const T3BranchIcon = () => t3NcSvg("branch");
const T3ClearCircleIcon = () => t3NcSvg("clear");
const T3CloseXIcon = () => t3NcSvg("close");

function T3NewChatHero({ activeProjectRef, activeProjectTitle }) {
  const t = ${an}();
  const projects = ${Vs}();
  const { scratchWorkspaceRootFor } = ${Qd}();
  const isZh = t3NcIsZh();
  const heroRef = ${react}.useRef(null);
  const projObj = activeProjectRef === null ? null : projects.find((p) => p.environmentId === activeProjectRef.environmentId && p.id === activeProjectRef.projectId) ?? null;
  const isScratch = projObj !== null && ${Ib}(projObj, scratchWorkspaceRootFor(projObj.environmentId));
  const showProjectInTitle = !isScratch && Boolean(activeProjectTitle);

  const openProjectPicker = () => {
    const scope = heroRef.current?.closest?.("[data-chat-composer-overlay]") ?? null;
    const trigger = scope?.querySelector?.("[data-draft-project-trigger]") ?? null;
    if (trigger && typeof trigger.click === "function") trigger.click();
  };

  return (0, ${jsx}.jsxs)("div", {
    ref: heroRef,
    className: "t3e-nc-hero",
    "data-t3e-new-chat-hero": "true",
    children: [
      (0, ${jsx}.jsx)(T3NewChatCloudIcon, {}),
      showProjectInTitle
        ? (0, ${jsx}.jsxs)("h1", {
            className: "t3e-nc-hero-title",
            children: [
              isZh ? "你想让我们在 " : "What should we build in ",
              (0, ${jsx}.jsx)("button", {
                type: "button",
                className: "t3e-nc-hero-project-btn",
                "aria-label": isZh ? \`切换项目：\${activeProjectTitle}\` : \`Switch project: \${activeProjectTitle}\`,
                onClick: openProjectPicker,
                children: activeProjectTitle
              }),
              isZh ? " 中构建什么？" : "?"
            ]
          })
        : (0, ${jsx}.jsx)("h1", {
            className: "t3e-nc-hero-title",
            children: isZh ? "我们要构建什么？" : t("What should we work on?")
          })
    ]
  });
}

function T3NewChatTray(props) {
  const {
    draftId: n,
    activeProjectRef: r,
    activeProjectTitle: i,
    environmentId,
    threadId,
    worktreePath,
    isServerThread,
    showGitControls,
    forceNewWorktree,
    envMode,
    onEnvModeChange,
    startFromOrigin,
    onStartFromOriginChange,
    envLocked,
    activeThreadBranchOverride,
    onActiveThreadBranchOverrideChange,
    onCheckoutPullRequestRequest,
    onComposerFocusRequest,
    availableEnvironments,
    onEnvironmentChange,
    autoEnvironmentLabel,
    onAutoEnvironment
  } = props;

  const isZh = t3NcIsZh();
  const a = ${an}();
  const o = ${Vs}();
  const { environments: allEnvs } = ${uv}();
  const primaryEnvId = ${xv}();
${useDraftSwitchHelper ? "" : `  const groupingSettings = ${vv}(${Mp});\n  const setDraftLogical = ${L}(${OV});\n  const getDraftSession = ${L}(${DV});\n`}  const handleNewThread = ${cv}();
  const keybindings = ${y}(${Sp});
  const filterApi = ${gS}();
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = ${Qd}();
  const { canPinProjectGroup, toggleProjectGroupPin } = ${kv}();

  const [projOpen, setProjOpen] = ${react}.useState(false);
  const [projQuery, setProjQuery] = ${react}.useState("");
  const [envMenuOpen, setEnvMenuOpen] = ${react}.useState(false);
  const [moreOpen, setMoreOpen] = ${react}.useState(false);
  const highlightRef = ${react}.useRef(null);
  const scratchTokenRef = ${react}.useRef(null);
  const mountedRef = ${react}.useRef(true);
  const latestDraftIdRef = ${react}.useRef(n);
  latestDraftIdRef.current = n;
  const envMenuRef = ${react}.useRef(null);
  const envTriggerRef = ${react}.useRef(null);
  const moreMenuRef = ${react}.useRef(null);
  const branchPickerRef = ${react}.useRef(null);
  const moreTriggerRef = ${react}.useRef(null);

  ${react}.useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  ${react}.useEffect(() => {
    if (!envMenuOpen && !moreOpen) return;
    const onDown = (ev) => {
      if (envMenuOpen && envMenuRef.current && !envMenuRef.current.contains(ev.target)) {
        setEnvMenuOpen(false);
      }
      if (moreOpen && moreMenuRef.current && !moreMenuRef.current.contains(ev.target)) {
        const branchTrigger = branchPickerRef.current?.querySelector("button[aria-expanded=true]");
        if (branchTrigger && ev.target?.closest?.('[data-slot="combobox-popup"], [data-slot="menu-popup"], [data-slot="popover-popup"], [role="listbox"]')) {
          return;
        }
        setMoreOpen(false);
      }
    };
    const onKey = (ev) => {
      if (ev.key !== "Escape") return;
      let handled = false;
      if (envMenuOpen) {
        setEnvMenuOpen(false);
        if (envMenuRef.current?.contains(ev.target)) envTriggerRef.current?.focus();
        handled = true;
      }
      if (moreOpen && !branchPickerRef.current?.querySelector("button[aria-expanded=true]")) {
        setMoreOpen(false);
        if (moreMenuRef.current?.contains(ev.target)) moreTriggerRef.current?.focus();
        handled = true;
      }
      if (handled) ev.stopPropagation();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [envMenuOpen, moreOpen]);

  const envMap = new Map(allEnvs.map(${TV}));
  const groups = ${rd}(envMap);
  const multiMachine = ${wC}(groups);
  const machineMap = new Map(allEnvs.map(${wV}));
  const resolvedGroups = ${TC}({ groups: ${Pp}(groups), preferredProjectRef: r });
  const groupByKey = new Map(resolvedGroups.map(${CV}));
  const activeGroup = r === null ? null : groups.find((g) => g.memberProjectRefs.some((ref) => ${Rt}(ref) === ${Rt}(r))) ?? null;
  const activeProjectKey = activeGroup?.projectKey ?? "";
  const activeProjectObj = r === null ? null : o.find((p) => p.environmentId === r.environmentId && p.id === r.projectId) ?? null;
  const isScratch = activeProjectObj !== null && ${Ib}(activeProjectObj, scratchWorkspaceRootFor(activeProjectObj.environmentId));
  const nonScratchGroups = resolvedGroups.filter(({ targetProject }) => !${Ib}(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)));
  const hasSelectedProject = !isScratch && Boolean(i);
  const noProjectLabel = isZh ? "不在项目中工作" : "Work without a project";
  const rawItems = [
    ...nonScratchGroups.map(${SV}),
    { value: ${hV}, label: isZh ? "新建项目" : a("Add project") },
    ...(hasSelectedProject ? [{ value: T3_NO_PROJECT_VAL, label: noProjectLabel }] : [])
  ];
  const items = ${Cu}(rawItems, ${xV}, projOpen);
  const trimmed = projQuery.trim();
  const filteredItems = trimmed.length === 0
    ? items
    : items.filter((it) => it.value !== ${hV} && it.value !== T3_NO_PROJECT_VAL && filterApi.contains(it, trimmed, ${bV}));
  const selectedItem = items.find((it) => it.value === activeProjectKey) ?? null;

  const getDraftKey = () => {
    const d = n ? ${L}.getState().getDraftSession(n) : null;
    return d ? \`\${d.environmentId}:\${d.projectId}:\${d.logicalProjectKey}\` : null;
  };

  const switchToProject = (project, logicalKey) => {
    if (!n) return;
    scratchTokenRef.current = null;
${useDraftSwitchHelper
  ? `    if (!${switchDraftFn}(n, project)) {\n      handleNewThread(${Rr}(project.environmentId, project.id));\n    }`
  : `    const ref = ${Rr}(project.environmentId, project.id);\n    if (${Ct}(getDraftSession(n))) {\n      setDraftLogical(logicalKey, ref, n);\n      ${Ed}(n, ref);\n    } else {\n      handleNewThread(ref);\n    }`}
  };

  const switchToScratchOnEnv = async (targetEnvId) => {
    const resolvedEnv = targetEnvId ?? scratchEnvironmentId(r?.environmentId ?? null);
    if (!resolvedEnv) return;
    const token = Symbol("scratch");
    scratchTokenRef.current = token;
    const beforeKey = getDraftKey();
    const beforeDraftId = n;
    try {
      const scratchProj = await openScratchProject(resolvedEnv);
      if (!mountedRef.current || !scratchProj || scratchTokenRef.current !== token) return;
      if (latestDraftIdRef.current !== beforeDraftId || getDraftKey() !== beforeKey) return;
      switchToProject(scratchProj${useDraftSwitchHelper ? "" : `, ${Np}(scratchProj, groupingSettings)`});
    } catch {
      // ignore failed scratch environment switch
    } finally {
      if (scratchTokenRef.current === token) scratchTokenRef.current = null;
    }
  };

  const scratchEnvs = allEnvs.filter((env) => scratchWorkspaceRootFor(env.environmentId) !== null);
  const rawEnvList = isScratch
    ? scratchEnvs
    : (availableEnvironments && availableEnvironments.length > 0 ? availableEnvironments : allEnvs);
  const envChoices = rawEnvList.map((env) => {
    const isLocal = env.environmentId === primaryEnvId;
    return {
      environmentId: env.environmentId,
      label: isLocal ? (isZh ? "此计算机" : "This computer") : (env.label || env.environmentId),
      isLocal
    };
  });

  const currentEnvId = environmentId || r?.environmentId || primaryEnvId;
  const fallbackEnvObj = allEnvs.find((e) => e.environmentId === currentEnvId) || null;
  const fallbackIsLocal = fallbackEnvObj ? fallbackEnvObj.environmentId === primaryEnvId : currentEnvId === primaryEnvId;
  const activeEnvInfo = envChoices.find((e) => e.environmentId === currentEnvId)
    || {
      environmentId: currentEnvId,
      label: fallbackIsLocal ? (isZh ? "此计算机" : "This computer") : (fallbackEnvObj?.label || currentEnvId),
      isLocal: fallbackIsLocal
    };
  const canSwitchEnv = !envLocked && (envChoices.length > 1 || Boolean(onAutoEnvironment));

  const effectiveEnvMode = forceNewWorktree ? "worktree" : envMode;
  const isWorktreeOn = effectiveEnvMode === "worktree";
  const worktreeDisabled = Boolean(envLocked || forceNewWorktree || (isServerThread && worktreePath !== null));
  const showMoreSettings = hasSelectedProject && Boolean(showGitControls) && Boolean(environmentId) && Boolean(threadId);

  const selectProjectLabel = isZh ? "选择项目" : "Select project";
  const moreTitle = isZh ? "更多设置" : "More settings";
  const newWorktreeLabel = isZh ? "新建工作树" : "New worktree";
  const branchLabel = isZh ? "分支" : "Branch";

  return (0, ${jsx}.jsxs)("div", {
    className: "t3e-nc-tray",
    "data-t3e-new-chat-tray": "true",
    children: [
      (0, ${jsx}.jsxs)("div", {
        className: "t3e-nc-tray-left",
        children: [
          (0, ${jsx}.jsxs)("div", {
            className: "t3e-nc-rel",
            ref: envMenuRef,
            children: [
              (0, ${jsx}.jsxs)("button", {
                type: "button",
                ref: envTriggerRef,
                "aria-disabled": !canSwitchEnv || undefined,
                ...(canSwitchEnv ? { "aria-haspopup": "menu", "aria-expanded": envMenuOpen } : {}),
                className: ${Dr}("t3e-nc-env-btn", canSwitchEnv && "is-interactive", envMenuOpen && "is-open"),
                onClick: () => {
                  if (canSwitchEnv) setEnvMenuOpen((v) => !v);
                },
                title: activeEnvInfo.label,
                children: [
                  activeEnvInfo.isLocal ? (0, ${jsx}.jsx)(T3LaptopIcon, {}) : (0, ${jsx}.jsx)(T3RemoteIcon, {}),
                  (0, ${jsx}.jsx)("span", { className: "t3e-nc-trunc", children: autoEnvironmentLabel || activeEnvInfo.label })
                ]
              }),
              envMenuOpen && canSwitchEnv
                ? (0, ${jsx}.jsxs)("div", {
                    className: "t3e-nc-popover t3e-nc-env-pop",
                    role: "menu",
                    children: [
                      (0, ${jsx}.jsx)("div", {
                        className: "t3e-nc-pop-title",
                        children: isZh ? "运行环境" : "Run on"
                      }),
                      onAutoEnvironment
                        ? (0, ${jsx}.jsxs)("button", {
                            type: "button",
                            role: "menuitemradio",
                            "aria-checked": Boolean(autoEnvironmentLabel),
                            className: ${Dr}("t3e-nc-pop-item", Boolean(autoEnvironmentLabel) && "is-active"),
                            onClick: () => {
                              setEnvMenuOpen(false);
                              onAutoEnvironment();
                            },
                            children: [
                              (0, ${jsx}.jsx)(T3RemoteIcon, {}),
                              (0, ${jsx}.jsx)("span", { className: "t3e-nc-trunc", children: autoEnvironmentLabel || a("Auto balance") })
                            ]
                          })
                        : null,
                      envChoices.map((env) =>
                        (0, ${jsx}.jsxs)(
                          "button",
                          {
                            type: "button",
                            role: "menuitemradio",
                            "aria-checked": !autoEnvironmentLabel && env.environmentId === currentEnvId,
                            className: ${Dr}("t3e-nc-pop-item", !autoEnvironmentLabel && env.environmentId === currentEnvId && "is-active"),
                            onClick: () => {
                              setEnvMenuOpen(false);
                              if (env.environmentId === currentEnvId) return;
                              if (isScratch) {
                                void switchToScratchOnEnv(env.environmentId);
                              } else if (typeof onEnvironmentChange === "function") {
                                onEnvironmentChange(env.environmentId);
                              }
                            },
                            children: [
                              env.isLocal ? (0, ${jsx}.jsx)(T3LaptopIcon, {}) : (0, ${jsx}.jsx)(T3RemoteIcon, {}),
                              (0, ${jsx}.jsx)("span", { className: "t3e-nc-pop-item-label", children: env.label }),
                              !autoEnvironmentLabel && env.environmentId === currentEnvId
                                ? (0, ${jsx}.jsx)("span", { className: "t3e-nc-check", children: "✓" })
                                : null
                            ]
                          },
                          env.environmentId
                        )
                      )
                    ]
                  })
                : null
            ]
          }),

          (0, ${jsx}.jsxs)(${bS}, {
            items,
            filteredItems,
            autoHighlight: true,
            itemToStringLabel: ${yV},
            isItemEqualToValue: ${vV},
            open: projOpen,
            onItemHighlighted: (ev) => { highlightRef.current = ev?.value ?? null; },
            onOpenChange: (open) => { setProjOpen(open); setProjQuery(""); },
            value: selectedItem,
            onValueChange: (val) => {
              if (!val) return;
              setProjOpen(false);
              if (val.value === ${hV}) {
                ${addProjectDialog ? `${addProjectDialog}({ open: "add-project", draftId: n })` : `${EV}()`};
                return;
              }
              if (val.value === T3_NO_PROJECT_VAL) {
                setMoreOpen(false);
                void switchToScratchOnEnv(null);
                return;
              }
              const target = groupByKey.get(val.value);
              if (target && val.value !== activeProjectKey) {
                switchToProject(target.targetProject, target.group.projectKey);
              }
            },
            children: [
              hasSelectedProject
                ? (0, ${jsx}.jsxs)("div", {
                    className: "t3e-nc-proj-pill",
                    children: [
                      (0, ${jsx}.jsx)("button", {
                        type: "button",
                        className: "t3e-nc-proj-clear",
                        title: noProjectLabel,
                        "aria-label": noProjectLabel,
                        onClick: (ev) => {
                          ev.stopPropagation();
                          setMoreOpen(false);
                          void switchToScratchOnEnv(null);
                        },
                        children: (0, ${jsx}.jsx)(T3ClearCircleIcon, {})
                      }),
                      (0, ${jsx}.jsx)(${xS}, {
                        render: (0, ${jsx}.jsx)("button", {
                          type: "button",
                          className: "t3e-nc-proj-name"
                        }),
                        "data-draft-project-trigger": "",
                        children: (0, ${jsx}.jsx)(${dV}, { value: i, singleLine: true })
                      })
                    ]
                  })
                : (0, ${jsx}.jsxs)(${xS}, {
                    render: (0, ${jsx}.jsx)("button", {
                      type: "button",
                      className: "t3e-nc-proj-empty"
                    }),
                    "data-draft-project-trigger": "",
                    children: [
                      (0, ${jsx}.jsx)(T3FolderIcon, {}),
                      (0, ${jsx}.jsx)("span", { className: "t3e-nc-trunc", children: selectProjectLabel })
                    ]
                  }),
              (0, ${jsx}.jsxs)(${yS}, {
                align: "start",
                side: "top",
                sideOffset: 8,
                className: "w-72 overflow-hidden",
                children: [
                  (0, ${jsx}.jsx)(${hS}, {
                    "aria-label": a("Search projects"),
                    placeholder: a("Search projects..."),
                    value: projQuery,
                    onChange: (ev) => setProjQuery(ev.target.value),
                    onKeyDown: (ev) => {
                      const cur = highlightRef.current;
                      const grp = cur ? groupByKey.get(cur)?.group : void 0;
                      if (grp && canPinProjectGroup(grp) && ${Dv}(ev, keybindings)) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        toggleProjectGroupPin(grp);
                      }
                    }
                  }),
                  (0, ${jsx}.jsx)(${vS}, { children: (0, ${jsx}.jsx)(${J}, { children: isZh ? "未找到匹配的项目。" : a("No matching projects.") }) }),
                  (0, ${jsx}.jsx)(${mS}, {
                    children: (item) => {
                      const entry = groupByKey.get(item.value);
                      return (0, ${jsx}.jsxs)(
                        ${_S},
                        {
                          hideIndicator: true,
                          value: item,
                          children: [
                            item.value === ${hV}
                              ? (0, ${jsx}.jsx)(${fg}, { className: "size-4 shrink-0" })
                              : item.value === T3_NO_PROJECT_VAL
                                ? (0, ${jsx}.jsx)(T3CloseXIcon, {})
                                : entry
                                  ? (0, ${jsx}.jsx)(${Hd}, { project: entry.group, className: "size-4 shrink-0" })
                                  : null,
                            (0, ${jsx}.jsx)("span", {
                              className: "min-w-0 flex-1 truncate text-sm",
                              children: (0, ${jsx}.jsx)(${dV}, { value: item.label })
                            }),
                            entry && canPinProjectGroup(entry.group)
                              ? (0, ${jsx}.jsx)(${wv}, {
                                  name: entry.group.displayName,
                                  pinned: entry.group.pinned,
                                  shortcutLabel: ${sy}(keybindings, "thread.pin"),
                                  onToggle: () => toggleProjectGroupPin(entry.group)
                                })
                              : null,
                            entry && multiMachine
                              ? (0, ${jsx}.jsx)(${Au}, {
                                  group: entry.group,
                                  primaryEnvironmentId: primaryEnvId,
                                  machineByEnvironmentId: machineMap
                                })
                              : null
                          ]
                        },
                        item.value
                      );
                    }
                  })
                ]
              })
            ]
          }),

          showMoreSettings
            ? (0, ${jsx}.jsxs)("div", {
                className: "t3e-nc-rel",
                ref: moreMenuRef,
                children: [
                  (0, ${jsx}.jsx)("button", {
                    type: "button",
                    className: ${Dr}("t3e-nc-more-btn", moreOpen && "is-open"),
                    ref: moreTriggerRef,
                    "aria-label": moreTitle,
                    "aria-expanded": moreOpen,
                    title: moreTitle,
                    onClick: () => setMoreOpen((v) => !v),
                    children: (0, ${jsx}.jsx)(T3DotsIcon, {})
                  }),
                  moreOpen
                    ? (0, ${jsx}.jsxs)("div", {
                        className: "t3e-nc-popover t3e-nc-more-pop",
                        role: "dialog",
                        "aria-label": moreTitle,
                        "data-t3e-more-popover": "true",
                        children: [
                          (0, ${jsx}.jsx)("div", { className: "t3e-nc-pop-title", children: moreTitle }),
                          (0, ${jsx}.jsxs)("div", {
                            className: "t3e-nc-more-row",
                            onClick: () => {
                              if (!worktreeDisabled && typeof onEnvModeChange === "function") {
                                onEnvModeChange(isWorktreeOn ? "local" : "worktree");
                              }
                            },
                            children: [
                              (0, ${jsx}.jsxs)("span", {
                                className: "t3e-nc-more-label",
                                children: [
                                  (0, ${jsx}.jsx)(T3WorktreeIcon, {}),
                                  (0, ${jsx}.jsx)("span", { className: "t3e-nc-trunc", children: newWorktreeLabel })
                                ]
                              }),
                              (0, ${jsx}.jsx)("button", {
                                type: "button",
                                role: "switch",
                                "aria-label": newWorktreeLabel,
                                "aria-checked": isWorktreeOn,
                                disabled: worktreeDisabled,
                                className: ${Dr}("t3e-nc-switch", isWorktreeOn && "is-on"),
                                onClick: (ev) => {
                                  ev.stopPropagation();
                                  if (!worktreeDisabled && typeof onEnvModeChange === "function") {
                                    onEnvModeChange(isWorktreeOn ? "local" : "worktree");
                                  }
                                },
                                children: (0, ${jsx}.jsx)("span", { className: "t3e-nc-switch-thumb" })
                              })
                            ]
                          }),
                          (0, ${jsx}.jsxs)("div", {
                            className: "t3e-nc-more-row t3e-nc-branch-row",
                            onClick: (ev) => {
                              if (!ev.currentTarget.contains(ev.target) || ev.target.closest?.("button")) return;
                              branchPickerRef.current?.querySelector("button")?.click();
                            },
                            children: [
                              (0, ${jsx}.jsxs)("span", {
                                className: "t3e-nc-more-label",
                                children: [
                                  (0, ${jsx}.jsx)(T3BranchIcon, {}),
                                  (0, ${jsx}.jsx)("span", { children: branchLabel })
                                ]
                              }),
                              (0, ${jsx}.jsxs)("div", {
                                className: "t3e-nc-branch-picker",
                                ref: branchPickerRef,
                                children: [
                                  (0, ${jsx}.jsx)(${IP}, {
                                    forceNewWorktree: Boolean(forceNewWorktree),
                                    className: "min-w-0 max-w-full justify-end",
                                    environmentId,
                                    threadId,
                                    ...(n ? { draftId: n } : {}),
                                    envLocked: Boolean(envLocked),
                                    effectiveEnvModeOverride: effectiveEnvMode,
                                    ...(activeThreadBranchOverride === void 0 ? {} : { activeThreadBranchOverride }),
                                    ...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {}),
                                    startFromOrigin,
                                    onStartFromOriginChange,
                                    ...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {}),
                                    ...(onComposerFocusRequest ? { onComposerFocusRequest } : {})
                                  }),
                                  (0, ${jsx}.jsx)("span", {
                                    className: "t3e-nc-chevron",
                                    "aria-hidden": true,
                                    children: "›"
                                  })
                                ]
                              })
                            ]
                          })
                        ]
                      })
                    : null
                ]
              })
            : null
        ]
      })
    ]
  });
}
`;
}

function apply(source, ctx) {
  const syms = extractChatSymbols(source, ctx);

  // Anchor 1: L_/R_ layout
  const lAndRRegex = /let\s+([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\?[`'"]pointer-events-none absolute inset-0 z-20 flex items-center \[@media\(max-height:34rem\)\]:items-end[`'"]:[`'"]pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1\.5 sm:pt-2[`'"],([A-Za-z_$][\w$]*)=\2\?\(0,\s*([A-Za-z_$][\w$]*)\.jsx\)\([`'"]div[`'"],\{className:[`'"]absolute inset-x-0 bottom-full[`'"],children:\(0,\s*\4\.jsx\)\([`'"]div[`'"],\{className:[`'"]pb-4 group-has-data-\[composer-shoulder-tab\]\/composer-stack:pb-0[`'"],style:.*?,children:\(0,\s*\4\.jsx\)\(([A-Za-z_$][\w$]*),\{draftId:([A-Za-z_$][\w$]*),activeProjectRef:([A-Za-z_$][\w$]*),activeProjectTitle:([A-Za-z_$][\w$]*)\?\.title\?\?null\}\)\}\)\}\):null/;

  const lAndRMatch = source.match(lAndRRegex);
  assert(lAndRMatch, "Could not locate L_/R_ new-session layout anchor in ThreadRouteView bundle");
  const [lAndRAnchor, Pv, wu, Iv, , , draftId, activeProjectRef, activeProjectTitle] = lAndRMatch;

  // Extract toolbar props
  const toolbarPropsRegex = /forceNewWorktree:([A-Za-z_$][\w$]*)!==null,.*?environmentId:([A-Za-z_$][\w$]*)\.environmentId,.*?isServerThread:([A-Za-z_$][\w$]*),showGitControls:([A-Za-z_$][\w$]*),.*?onEnvModeChange:([A-Za-z_$][\w$]*),startFromOrigin:([A-Za-z_$][\w$]*),onStartFromOriginChange:([A-Za-z_$][\w$]*),envMode:([A-Za-z_$][\w$]*),\.\.\.([A-Za-z_$][\w$]*)\?\{activeThreadBranchOverride:([A-Za-z_$][\w$]*),onActiveThreadBranchOverrideChange:([A-Za-z_$][\w$]*)\}:\{\},envLocked:([A-Za-z_$][\w$]*),onComposerFocusRequest:([A-Za-z_$][\w$]*),\.\.\.([A-Za-z_$][\w$]*)\?\{onCheckoutPullRequestRequest:([A-Za-z_$][\w$]*)\}:\{\},\.\.\.([A-Za-z_$][\w$]*)\?\{onEnvironmentChange:([A-Za-z_$][\w$]*)\}:\{\},autoEnvironmentLabel:([A-Za-z_$][\w$]*),onAutoEnvironment:[A-Za-z_$][\w$]*&&![A-Za-z_$][\w$]*&&([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\.loadBalancingEnabled\?([A-Za-z_$][\w$]*):void 0,availableEnvironments:([A-Za-z_$][\w$]*),.*environmentId:([A-Za-z_$][\w$]*),runtimeMode:/;

  const tbMatch = source.match(toolbarPropsRegex);
  assert(tbMatch, "Could not extract toolbar props from ThreadRouteView bundle");
  const [, Cr, Kr, Gr, um, Mg, am, Pg, rm, Xp, im, nm, Ls, Qd, Xi, ss, Rs, Xd, qd, Zo, Bs, Kd, Xo, iFallback] = tbMatch;

  const lAndRReplacement =
    `let ${Pv}=${wu}?\`pointer-events-none absolute inset-0 z-20 flex flex-col justify-between\`:\`pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2\`,` +
    `${Iv}=${wu}?(0,${syms.jsx}.jsx)(T3NewChatTray,{` +
    `draftId:${draftId},activeProjectRef:${activeProjectRef},activeProjectTitle:${activeProjectTitle}?.title??null,` +
    `environmentId:${Kr}?.environmentId??${iFallback},threadId:${Kr}?.id??null,worktreePath:${Kr}?.worktreePath??null,` +
    `isServerThread:${Gr},showGitControls:${um},forceNewWorktree:${Cr}!==null,` +
    `envMode:${rm},onEnvModeChange:${Mg},startFromOrigin:${am},onStartFromOriginChange:${Pg},envLocked:${Ls},` +
    `...${Xp}?{activeThreadBranchOverride:${im},onActiveThreadBranchOverrideChange:${nm}}:{},` +
    `...${Xi}?{onCheckoutPullRequestRequest:${ss}}:{},` +
    `onComposerFocusRequest:${Qd},availableEnvironments:${Xo},` +
    `...${Rs}?{onEnvironmentChange:${Xd}}:{},` +
    `autoEnvironmentLabel:${qd},` +
    `onAutoEnvironment:${draftId}&&!${Ls}&&${Zo}&&${Bs}.loadBalancingEnabled?${Kd}:void 0` +
    `}):null`;

  // Anchor 2: overlay
  const overlayRegex = /([A-Za-z_$][\w$]*)=\(0,\s*([A-Za-z_$][\w$]*)\.jsx\)\([`'"]div[`'"],\{(\.\.\.([A-Za-z_$][\w$]*),ref:([A-Za-z_$][\w$]*),inert:([A-Za-z_$][\w$]*),"data-chat-composer-overlay":[`'"]true[`'"],className:[A-Za-z_$][\w$]*,children:([A-Za-z_$][\w$]*))\}\)/;
  const overlayMatch = source.match(overlayRegex);
  assert(overlayMatch, "Could not locate av composer overlay anchor in ThreadRouteView bundle");
  const [avOverlayAnchor, ny, , , Mv, Nv, An, ey] = overlayMatch;

  const avOverlayReplacement =
    `${ny}=(0,${syms.jsx}.jsxs)(\`div\`,{...${Mv},ref:${Nv},inert:${An},"data-chat-composer-overlay":\`true\`,"data-t3e-new-chat-layout":${wu}?\`true\`:void 0,className:${Pv},children:[${wu}?(0,${syms.jsx}.jsx)(T3NewChatHero,{activeProjectRef:${activeProjectRef},activeProjectTitle:${activeProjectTitle}?.title??null}):null,${ey}]})`;

  // Anchor 3: permissions trailing
  const permRegex = /\.\.\.([A-Za-z_$][\w$]*)\?\{\}:\{trailing:\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{environmentId:[A-Za-z_$][\w$]*,runtimeMode:[^}]*\}\)\}/;
  const permMatch = source.match(permRegex);
  assert(permMatch, "Could not locate trailing permissions anchor in ThreadRouteView bundle");
  const [hpTrailingPermAnchor, GrPerm] = permMatch;

  // Anchor 4: Notice and stack
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const jsxEsc = escapeRe(syms.jsx);
  const noticePattern = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\.length>0\?\(0,\s*([A-Za-z_$][\w$]*)\.jsx\)\([`'"]div[`'"],\{className:[`'"]absolute inset-x-0 top-full flex flex-col gap-1 pt-4 \[@media\(max-height:34rem\)\]:static[`'"],children:\(0,\s*[A-Za-z_$][\w$]*\.jsx\)\(([A-Za-z_$][\w$]*),\{items:[A-Za-z_$][\w$]*,detached:!0\}\)\}\):null,([A-Za-z_$][\w$]*)\[(\d+)\]=([A-Za-z_$][\w$]*),\6\[(\d+)\]=([A-Za-z_$][\w$]*),\6\[(\d+)\]=([A-Za-z_$][\w$]*)\):[A-Za-z_$][\w$]*=\6\[\11\];/;
  const nMatch = source.match(noticePattern);
  assert(nMatch, "Could not locate notice below-composer anchor in ThreadRouteView bundle");
  const [nFull, Yv, , Xh, , fy, memoArr, slot1Idx, slot1Var, slot2Idx, slot2Var, slotYv] = nMatch;

  const memoArrEsc = escapeRe(memoArr);
  const yvEsc = escapeRe(Yv);
  const relPattern = new RegExp(`let\\s+([A-Za-z_$][\\w$]*);${memoArrEsc}\\[(\\d+)\\]!==([A-Za-z_$][\\w$]*)\\|\\|${memoArrEsc}\\[(\\d+)\\]!==${yvEsc}\\?\\(\\1=\\(0,\\s*${jsxEsc}\\.jsxs?\\)\\([\`'"]div[\`'"],\\{className:[\`'"]relative[\`'"],children:\\[\\3,${yvEsc}\\]\\}\\),${memoArrEsc}\\[\\2\\]=\\3,${memoArrEsc}\\[\\4\\]=${yvEsc},${memoArrEsc}\\[(\\d+)\\]=\\1\\):\\1=${memoArrEsc}\\[\\5\\];`);
  const rMatch = source.match(relPattern);
  assert(rMatch, "Could not locate relative wrapper block in ThreadRouteView bundle");
  const [rFull, Xv, slotJv, Jv, slotYvInRel, slotXv] = rMatch;

  const stackPattern = new RegExp(`let\\s+([A-Za-z_$][\\w$]*);${memoArrEsc}\\[(\\d+)\\]!==([A-Za-z_$][\\w$]*)\\|\\|${memoArrEsc}\\[(\\d+)\\]!==([A-Za-z_$][\\w$]*)\\?\\(\\1=\\(0,\\s*${jsxEsc}\\.jsxs?\\)\\([\`'"]div[\`'"],\\{"data-chat-composer-stack":[\`'"]true[\`'"],className:[\`'"]group\\/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-\\(--chat-content-max-width\\)[\`'"],children:\\[\\3,\\5\\]\\}\\),${memoArrEsc}\\[\\2\\]=\\3,${memoArrEsc}\\[\\4\\]=\\5,${memoArrEsc}\\[(\\d+)\\]=\\1\\):\\1=${memoArrEsc}\\[\\6\\];`);
  const sMatch = source.match(stackPattern);
  assert(sMatch, "Could not locate stack block in ThreadRouteView bundle");
  const [sFull, stackVar, slotIv, , slotQv, Qv, slotStack] = sMatch;

  const nRep = `${Yv}=${wu}&&${Xh}.length>0?(0,${syms.jsx}.jsx)(\`div\`,{className:\`mb-2.5 flex flex-col gap-1.5\`,children:(0,${syms.jsx}.jsx)(${fy},{items:${Xh},detached:!0})}):null,${memoArr}[${slot1Idx}]=${slot1Var},${memoArr}[${slot2Idx}]=${slot2Var},${memoArr}[${slotYv}]=${Yv}):${Yv}=${memoArr}[${slotYv}];`;
  const rRep = `let ${Xv};${memoArr}[${slotJv}]!==${Jv}?(${Xv}=(0,${syms.jsx}.jsx)(\`div\`,{className:\`relative\`,children:${Jv}}),${memoArr}[${slotJv}]=${Jv},${memoArr}[${slotXv}]=${Xv}):${Xv}=${memoArr}[${slotXv}];`;
  const sRep = `let ${stackVar};${memoArr}[${slotIv}]!==${Iv}||${memoArr}[${slotQv}]!==${Qv}||${memoArr}[${slotYvInRel}]!==${Yv}?(${stackVar}=(0,${syms.jsx}.jsxs)(\`div\`,{"data-chat-composer-stack":\`true\`,className:\`group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)\`,children:[${Yv},${Iv},${Qv}]}),${memoArr}[${slotIv}]=${Iv},${memoArr}[${slotQv}]=${Qv},${memoArr}[${slotYvInRel}]=${Yv},${memoArr}[${slotStack}]=${stackVar}):${stackVar}=${memoArr}[${slotStack}];`;

  let patched = source
    .replace(lAndRAnchor, () => lAndRReplacement)
    .replace(avOverlayAnchor, () => avOverlayReplacement)
    .replace(nFull, () => nRep)
    .replace(rFull, () => rRep)
    .replace(sFull, () => sRep);

  if (ctx?.isEnabled?.("usage-rings")) {
    patched = patched.replace(hpTrailingPermAnchor, () => `...${GrPerm}?{}:{trailing:null}`);
  }

  const injected = buildInjectedComponents(syms);
  ctx?.recordInjectedCode?.(injected);

  return patched + "\n" + injected + "\n";
}

module.exports = {
  id: ID,
  name: "新建对话 ChatGPT 吸底布局与环境/项目/分支托盘",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: THREAD_ROUTE.preferredRegex,
  targetSpec: THREAD_ROUTE,
  originalHash: ORIGINAL_HASH,
  knownHashes: KNOWN_HASHES,
  apply,
};

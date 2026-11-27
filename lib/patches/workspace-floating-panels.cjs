"use strict";

const assert = require("node:assert/strict");
const { mountRuntime, loadRuntimeExports } = require("../runtime-loader.cjs");
const { APP_SHELL, THREAD_ROUTE, createPatchContext, findEntryBySpec, resolveRelativeKey } = require("../resolver.cjs");
const { tokenize, findMatchingToken, getTopLevelDeclSource } = require("../js-ast.cjs");

const ID = "workspace-floating-panels";
const MARKER = "T3_WORKSPACE_FLOATING_PANELS_V31";
const LEGACY_MARKERS = Array.from({ length: 30 }, (_, index) => "T3_WORKSPACE_FLOATING_PANELS_V" + (index + 1));
const PREVIEW_LAYOUT_EVENT = "t3e-preview-layout";
const ORIGINAL_HASH = "5464ddf4e47841a1799079fdc05145474013f8c268224390b2dccf3f76521c9f";
const KNOWN_HASHES = ["d54743d08ba7971a22d5dc50a422f1974e3db92b1c277b3e72645fbe2e5b74ce"];

const TAB_BAR_MARKER = "T3_WORKSPACE_FLOATING_TAB_BAR_V16";
const TOOLBAR_MARKER = "T3_WORKSPACE_FLOATING_PREVIEW_TOOLBAR_V2";
const RESPONSIVE_MARKER = "T3_WORKSPACE_FLOATING_PREVIEW_RESPONSIVE_V2";

const identifier = "[A-Za-z_$][\\w$]*";
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function unique(source, pattern, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, "g"))];
  assert.equal(matches.length, 1, `Could not uniquely locate ${label} (found ${matches.length})`);
  return matches[0];
}

// @name captures an identifier. #name captures a memo slot already used by the host.
function anchor(source, template, known = {}) {
  const captures = new Set();
  const pattern = template.split(/([@#][A-Za-z]\w*)/).map((part) => {
    if (!/^[@#]/.test(part)) return escapeRegex(part);
    const name = part.slice(1);
    if (Object.hasOwn(known, name)) return escapeRegex(String(known[name]));
    if (captures.has(name)) return `\\k<${name}>`;
    captures.add(name);
    return `(?<${name}>${part[0] === "@" ? identifier : "\\d+"})`;
  }).join("");
  const match = unique(source, new RegExp(pattern), template.slice(0, 100));
  match.groups = { ...known, ...(match.groups || {}) };
  return match;
}

function edit(source, template, replacement, known) {
  const match = anchor(source, template, known);
  const values = { ...known, ...match.groups };
  const next = replacement.replace(/[@#]([A-Za-z]\w*)/g, (_, name) => {
    assert(Object.hasOwn(values, name), `Missing capture ${name} in ${template}`);
    return values[name];
  });
  return source.replace(match[0], () => next);
}

function editFunctions(source, ctx, edits) {
  // Every function is located against the input of the patch. Apply from right to left
  // so the cached token positions remain valid.
  const updates = edits.map(([template, transform]) => {
    const match = anchor(source, template);
    const fn = ctx.findEnclosingFunction(match.index);
    assert(fn, `Could not locate the function containing ${template}`);
    const updated = transform(fn.source, match.groups);
    ctx.recordInjectedCode(`(${updated})`);
    return { ...fn, updated };
  }).sort((a, b) => b.start - a.start);
  let boundary = source.length;
  for (const { start, end, updated } of updates) {
    assert(end <= boundary, "Workspace edits overlap");
    source = source.slice(0, start) + updated + source.slice(end);
    boundary = start;
  }
  return source;
}

function beforeMemo(source, code) {
  const match = unique(source, /\{let [\w$]+=\(0,[\w$]+\.c\)\(\d+\)/, "compiler memo initialization");
  return source.replace(match[0], () => "{" + code + match[0].slice(1));
}

function installRuntime(source, ctx, name, factory, result, bindings, imports = []) {
  const marker = name === "floating-panels-ui" ? MARKER : TAB_BAR_MARKER;
  const bridge = `/* ${marker} */\nconst { ${result.join(", ")} } = ${factory}({\n` +
    Object.entries(bindings).map(([key, value]) => `  ${key}: ${value}`).join(",\n") + "\n});\n";
  return mountRuntime(source, ctx, name, [...imports, factory], bridge);
}

function browserBindings(ctx) {
  if (!ctx.asar || !ctx.entry) return {};
  // The preview toolbar calls the same address parser with the current client settings.
  // Resolve that call through the toolbar's imports, including the export aliases.
  const target = findEntryBySpec(ctx.asar, previewToolbarPatch.targetSpec, "browser address toolbar",
    [TOOLBAR_MARKER]);
  const preview = createPatchContext(ctx.asar, target, target.content.toString("utf8"));
  const address = preview.resolveImportedAlias(
    (specifier, _key, text) => /^\.\/preview-/.test(specifier) && text?.includes("unsupported-protocol") && text.includes("browserCustomSearchUrl"),
    (local, _text, _record, decl) => /unsupported-protocol/.test(decl(local) || "") && /=\w+\.(?:duckduckgo|google)/.test(decl(local) || ""),
    "browser address parser"
  );
  assert(address.local, "Preview toolbar does not import its address parser");
  const call = unique(preview.source, new RegExp(`(?<![\\w$.])${escapeRegex(address.local)}\\(${identifier},(${identifier})\\((${identifier})\\(\\)\\)\\)`),
    "browser address, search template and settings call");
  function add(local, alias) {
    const rec = preview.getImports().find((imp) => imp.specifiers.some((spec) => spec.local === local));
    assert(rec, `Preview toolbar is missing the import for ${alias}`);
    const spec = rec.specifiers.find((spec) => spec.local === local);
    return ctx.ensureChunkImport(resolveRelativeKey(target.key, rec.specifier),
      (_local, _text, ex) => ex.exported === spec.imported, alias, alias).local;
  }
  return {
    resolveBrowserAddress: add(address.local, "T3ResolveBrowserAddress"),
    browserSearchTemplate: add(call[1], "T3BrowserSearchTemplate"),
    getBrowserSettings: add(call[2], "T3GetBrowserSettings"),
  };
}

function editThreadLayout(source) {
  const surface = anchor(source, 'let @panel=@thread?(0,@jsx.jsx)(@content,{surface:@active,activeSurfaceId:@resolved?.id??null,threadRef:@thread,').groups;
  const shell = anchor(source, '@visible&&@thread&&!@compact?(0,@jsx.jsx)(@shell,{sheet:@sheet,', surface).groups;
  const controls = anchor(source, '(0,@jsx.jsx)(@controls,{...@controlProps,showThreadPanelControl:@showThread})', surface).groups;
  const state = anchor(source, 'isWorking:@working,runlessWorkActive:@runless!==null,isCompacting:@compacting,awaitingUser:@approval===null?@input!==null||@threadInfo?.hasPendingUserInput===!0?`input`:null:`approval`,').groups;
  const panelProps = anchor(source, 'surfaces:@surfaces,environmentId:@thread.environmentId,activeSurfaceId:@active?.id??null,pendingSurfaceIds:@pending,previewSessions:@sessions.sessions,desktopByTabId:@sessions.desktopByTabId,previewRuntimeTabId:@runtime,terminalLabelsById:@labels,', surface).groups;
  const livePanel = anchor(source, '{activeSurface:@liveActive,surfaces:@panelState.surfaces}', surface).groups;
  const threadKey = anchor(source, 'let @key=@rawKey,@connection=@status(@thread?.environmentId??null),', surface).groups.key;
  const layout = anchor(source, 'let @layout=(0,@jsx.jsxs)(`div`,{ref:@root,className:`relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background`,', surface).groups;
  const maximized = anchor(source, 'layoutControls:@open?(0,@jsx.jsxs)(`div`,{className:`mr-px flex items-center gap-1`,children:[(0,@jsx.jsx)(@maximize,{maximized:@maximized,onToggle:@toggle}),@oldControls]}):null,', surface).groups;
  const names = { ...surface, ...shell, ...controls, ...state, ...panelProps, ...livePanel, ...layout, ...maximized, key: threadKey };
  let next = edit(source, 'let @panel=@thread?(0,@jsx.jsx)(@content,{surface:@active,',
    'let T3panelProps=@thread?{surface:@active,', names);
  next = edit(next, 'onPendingChange:@pendingChange}}):null,@nextPanel=@project!==null',
    'onPendingChange:@pendingChange}}:null,@nextPanel=@project!==null');
  next = edit(next, '@visible&&@thread&&!@compact?(0,@jsx.jsx)(@shell,{sheet:@sheet,',
    '@visible&&@thread&&!@compact?(0,@jsx.jsx)(T3WorkspacePanelShell,{sheet:@sheet,', names);
  next = edit(next, 'onAddBrowser:()=>@create(),onAddBrowserInProfile:@profile,',
    'onAddBrowser:(input)=>typeof input===`string`?T3NavigateBrowser(input,@create):@create(),onAddBrowserInProfile:@profile,');
  next = edit(next, 'children:@panel}):null,@first,@second,@third,@fourth]',
    'children:(0,@jsx.jsx)(T3DockedSurface,{})}):null,@first,@second,@third,@fourth,@thread&&!@compact?(0,@jsx.jsx)(T3FloatingDeck,{}):null]', names);
  next = edit(next, 'let @layout=(0,@jsx.jsxs)(`div`,{ref:@root,',
    'let @layout=(0,@jsx.jsxs)(`div`,{ref:@root,"data-t3e-workspace":@compact?void 0:!0,', names);
  const legacy = anchor(next, 'children:[@first,@showMini&&!@compact?@mini:null,(0,@jsx.jsxs)(`div`,{className:@className,"data-chat-column-maximized-away":', names).groups;
  const threadNames = { ...names, showMini: legacy.showMini, mini: legacy.mini };
  next = edit(next, '@showMini&&!@compact?@mini:null,(0,@jsx.jsxs)(`div`,{className:@className,"data-chat-column-maximized-away":',
    '@thread&&!@compact?null:@showMini&&!@compact?@mini:null,(0,@jsx.jsxs)(`div`,{className:@className,"data-chat-column-maximized-away":', threadNames);
  next = edit(next, '!@showMini&&!@isSheet?@mini:null,@showToggle?@toggleComponent:null,(0,@jsx.jsx)(@breadcrumb,{activeThreadEnvironmentId:',
    '!@thread&&!@showMini&&!@isSheet?@mini:null,!@thread&&@showToggle?@toggleComponent:null,(0,@jsx.jsx)(@breadcrumb,{activeThreadEnvironmentId:', threadNames);
  next = edit(next, '(0,@jsx.jsxs)(`div`,{className:@className,"data-chat-column-maximized-away":@maximized?`true`:`false`,"data-chat-column":!0,style:@style,inert:@maximized,onMouseUp:@mouseUp,children:[',
    '(0,@jsx.jsxs)(T3ChatColumnShell,{className:@className,style:@style,maximizedAway:@maximized,workState:@approval!==null?`approval`:(@input!==null||@threadInfo?.hasPendingUserInput===!0)?`input`:@working?`working`:`idle`,onMouseUp:@mouseUp,children:[', names);
  next = edit(next, '...@find?{onFindInThread:@onFind}:{}})]})',
    '...@find?{onFindInThread:@onFind}:{}}),@thread&&!@compact?(0,@jsx.jsx)(T3ChatToolbar,{controls:(0,@jsx.jsx)(@controls,{...@controlProps,showRightPanelControl:!@open})}):null]})', names);
  next = edit(next, 'layoutControls:@open?(0,@jsx.jsxs)(`div`,{className:`mr-px flex items-center gap-1`,children:[(0,@jsx.jsx)(@maximize,{maximized:@maximized,onToggle:@toggle}),@oldControls]}):null,',
    'layoutControls:@open?(0,@jsx.jsx)(T3PanelToolbar,{fullscreen:@maximized,sheet:@sheet,maximize:(0,@jsx.jsx)(@maximize,{maximized:@maximized,onToggle:@toggle}),toggle:(0,@jsx.jsx)(@controls,{...@controlProps,showThreadPanelControl:!1,showTerminalControl:!1})}):null,', names);
  return edit(next, 'checkpoints:@details?.checkpoints,checkpointScopes:@details?.checkpointScopes,children:@layout})',
    'checkpoints:@details?.checkpoints,checkpointScopes:@details?.checkpointScopes,children:@thread&&!@compact?(0,@jsx.jsx)(T3WorkspacePanels,{threadKey:@key,panelProps:T3panelProps,surfaces:@panelState.surfaces,activeSurface:@liveActive,terminalLabels:@labels,fullscreen:@maximized&&!@sheet,children:@layout},@key):@layout})', names);
}

function editPanelShell(source, ctx) {
  const { source: resized, cacheVar, slots: [slot] } = ctx.allocateMemoSlots(source, 1);
  const props = anchor(source, 'function @fn(@props){let @cache=(0,@compiler.c)(').groups.props;
  const known = { cache: cacheVar, props, slot };
  const next = edit(resized,
    '@cache[#widthSlot]!==@width||@cache[#containerSlot]!==@container?(@size={container:@container,widthStorageKey:@width},@cache[#widthSlot]=@width,@cache[#containerSlot]=@container,@cache[#sizeSlot]=@size)',
    '@cache[#widthSlot]!==@width||@cache[#containerSlot]!==@container||@cache[#sizeSlot]?.edge!==@props.enhancerResizeEdge?(@size={container:@container,widthStorageKey:@width,edge:@props.enhancerResizeEdge},@cache[#widthSlot]=@width,@cache[#containerSlot]=@container,@cache[#sizeSlot]=@size)', known);
  const layout = anchor(source, 'maximized:@maximized,layoutControls:@controls,...@rest}=@props', known).groups;
  return edit(next,
    '@cache[#propsSlot]!==@rest?(@out=(0,@jsx.jsx)(@panel,{...@rest,mode:`inline`,maximized:@maximized,inlineSize:@size}),',
    '@cache[#propsSlot]!==@rest||@cache[#slot]!==@controls?(@out=(0,@jsx.jsx)(@panel,{...@rest,mode:`inline`,maximized:@maximized,inlineSize:@size,layoutControls:@controls}),@cache[#slot]=@controls,', { ...known, ...layout });
}

const terminalSplit = '@split=@direction=>{let @orientation=@direction===void 0?`horizontal`:@direction;if(!@thread||@active?.kind!==`terminal`||@active.terminalIds.length>=4)return;let @id=@active.id,@launched=@launcher.launchTerminal({place:@terminal=>@store.getState().splitTerminal(@thread,@id,@terminal,@orientation)});@launched&&@focus(@thread,@launched.terminalId)}';
const previewPresentationLegacy = 'let @lease=@claim(@tab,@fit),@update=()=>{let @rect=@element.getBoundingClientRect(),@options=@ref.current,@accepted=@lease.present(';
const previewPresentationSheet = 'let @lease=@claim(@tab,@fit),@sheetEl=@element.closest(`[data-slot="sheet-viewport"]`),@sheetZ=@sheetEl&&Number(getComputedStyle(@sheetEl).zIndex)+1||0;@sheetEl?.parentElement&&@sheetZ>0&&@setSheet({zIndex:@sheetZ,container:@sheetEl.parentElement});let @update=()=>{let @rect=@element.getBoundingClientRect(),@options=@ref.current,@effZ=Math.max(@options.zIndex,@sheetZ),@accepted=@lease.present(';
const previewPresentationAnchor = 'let @lease=@claim(@tab,@fit),';
const miniFrame = '@frame=@layout?.previewKey===@key?@layout.layout.frame:null,@inset;';
const browserCallback = '@create=(@profile,@duplicate)=>{@thread&&@available&&@open({threadRef:@thread,openPreview:@preview,...@profile===void 0?{}:{profileId:@profile},...@duplicate===void 0?{}:{duplicateFrom:@duplicate}}).then(@report)}';

function resolveTooltipAndCloseBindings(source, ctx, jsx) {
  try {
    return anchor(source,
      '(0,@jsx.jsxs)(@tooltip,{children:[(0,@jsx.jsx)(@trigger,{render:(0,@jsx.jsx)(@button,{variant:`ghost`,size:`icon-xs`,"aria-label":@i18n(`Close floating preview`),onPointerDown:@noDrag,onClick:@close}),children:(0,@jsx.jsx)(@closeIcon,{})}),(0,@jsx.jsx)(@popup,',
      { jsx }).groups;
  } catch {
    const wrapped = anchor(source,
      '(0,@jsx.jsx)(@wrapped,{render:(0,@jsx.jsx)(@button,{variant:`ghost`,size:`icon-xs`,"aria-label":@i18n(`Close floating preview`),onPointerDown:@noDrag,onClick:@close}),label:(0,@jsx.jsx)(@jsx.Fragment,{children:(0,@jsx.jsx)(@msg,{children:`Close floating preview`})}),children:(0,@jsx.jsx)(@closeIcon,{})})',
      { jsx }).groups;
    let tooltip = null;
    let trigger = null;
    let popup = null;
    if (ctx.asar && ctx.entry && typeof ctx.ensureChunkImport === "function") {
      const utilsSpec = {
        pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
        preferredRegex: /^apps\/server\/dist\/client\/assets\/utils-[\w-]+\.js$/,
        includes: ["tooltip-popup", "tooltip-trigger"],
      };
      trigger = ctx.ensureChunkImport(utilsSpec, (l, _t, _e, decl) => Boolean(decl(l)?.includes("tooltip-trigger")), "T3TooltipTrigger", "TooltipTrigger").local;
      popup = ctx.ensureChunkImport(utilsSpec, (l, _t, _e, decl) => Boolean(decl(l)?.includes("tooltip-popup")), "T3TooltipPopup", "TooltipPopup").local;
      tooltip = ctx.ensureChunkImport(utilsSpec, (l, _t, _e, decl) => {
        const d = decl(l) || "";
        return d.includes("actionsRef") && d.includes("release(");
      }, "T3Tooltip", "Tooltip").local;
    } else {
      const pair = source.match(new RegExp(`\\(0,${escapeRegex(jsx)}\\.jsxs\\)\\((${identifier}),\\{children:\\[\\(0,${escapeRegex(jsx)}\\.jsx\\)\\((${identifier}),\\{render:[^}]+data-draft-project-trigger[\\s\\S]{0,400}\\(0,${escapeRegex(jsx)}\\.jsx\\)\\((${identifier}),\\{side:\`top\``));
      assert(pair, "Could not resolve Tooltip/TooltipTrigger/TooltipPopup bindings");
      [, tooltip, trigger, popup] = pair;
    }
    return { tooltip, trigger, popup, button: wrapped.button, closeIcon: wrapped.closeIcon };
  }
}

function apply(source, context) {
  const ctx = context || createPatchContext(null, null, source);
  const { jsx, react } = ctx.resolveReactBindings();
  assert(jsx && react, "Missing workspace React or JSX runtime");
  const shellAnchor = 'sheet:@sheet,workspaceLayoutElement:@container,widthStorageKey:@width,sheetAnimationDurationMs:@duration,onCloseSheet:@close,maximized:@maximized,layoutControls:@controls,...@rest}=@props';
  const content = anchor(source, 'let @panel=@thread?(0,@jsx.jsx)(@content,{surface:@active,activeSurfaceId:@resolved?.id??null,threadRef:@thread,', { jsx }).groups.content;
  const shell = ctx.findEnclosingFunction(anchor(source, shellAnchor).index);
  assert(shell?.name, "Missing workspace panel shell");
  const { focus, store } = anchor(source, terminalSplit).groups;
  const { state: getPanelState } = anchor(source, 'let @snapshot=@store.getState(),{surfaces:@surfaces}=@state(@snapshot.byThreadKey,@input.threadRef)', { store }).groups;
  const { mini, getMini } = anchor(source, '@read=@state=>@getMini(@state.byThreadKey,@thread),@cache[#slot]=@thread,@cache[#next]=@read);let @current=@mini(@read),@nextUi;@cache[#surfaceSlot]===@panelState.surfaces?@nextUi=@cache[#uiSlot]:').groups;
  const { diff } = anchor(source, '@diff.getState().selectToolCall(@thread,@id),@store.getState().open(@thread,`diff`)', { store }).groups;
  const { threadKey } = anchor(source, '@thread?@threadKey(@thread):null,@memo[#refSlot]=@thread,@memo[#keySlot]=@computed);let @key=@computed,@online=@status(@thread?.environmentId??null),').groups;
  const { translator } = anchor(source, '{surface:@surface,threadRef:@thread,visible:@visible,onCloseSurface:@close}=@props,@message=@translator();if(@surface===null)return null;').groups;
  const { portal } = anchor(source, '(0,@portal.createPortal)((0,@jsx.jsx)(`div`,{className:`pointer-events-auto fixed z-40 flex flex-col`,"data-composer-drawer-layer":', { jsx }).groups;
  const { tooltip, trigger, button, closeIcon, popup } = resolveTooltipAndCloseBindings(source, ctx, jsx);
  const stableChunk = /^\.\/useStableCallback-[^/]+\.js$/;
  const useStableCallback = ctx.resolveImportedAlias(stableChunk, null, "stable callback hook").local;

  const previewTarget = source.includes('[data-slot="sheet-viewport"]') ? previewPresentationSheet : previewPresentationLegacy;
  const next = editFunctions(source, ctx, [
    ['"data-chat-column-maximized-away":@maximized?`true`:`false`,"data-chat-column":!0,style:@style', editThreadLayout],
    [shellAnchor, (fn) => editPanelShell(fn, ctx)],
    ['ref:@ref,className:@className,onContextMenu:@menu,children:[@breadcrumb,@links]', (fn) =>
      edit(fn, 'ref:@ref,className:@className,onContextMenu:@menu,children:[@breadcrumb,@links]',
        'ref:@ref,className:@className,"data-t3e-chat-heading":!0,onContextMenu:@menu,children:[@breadcrumb,@links]')],
    ['openPreview:@options.openPreview,threadRef:@options.threadRef,...@options.profileId===void 0?{}:{profileId:@options.profileId}', (fn) =>
      edit(fn, 'openPreview:@options.openPreview,threadRef:@options.threadRef,...@options.profileId===void 0?{}:{profileId:@options.profileId}',
        'openPreview:@options.openPreview,threadRef:@options.threadRef,url:@options.url,...@options.profileId===void 0?{}:{profileId:@options.profileId}')],
    [browserCallback, (fn) => edit(edit(fn, browserCallback,
      '@create=(@profile,@duplicate)=>{if(!@thread||!@available)return;let url=typeof @duplicate===`string`?@duplicate:void 0,dup=typeof @duplicate===`string`?void 0:@duplicate;return @open({threadRef:@thread,openPreview:@preview,url,...@profile===void 0?{}:{profileId:@profile},...dup===void 0?{}:{duplicateFrom:dup}}).then(result=>{@report(result);return result._tag===`Success`})}'), '@active?.kind===`preview`&&@active.resourceId?@mini.getState().open(@thread,@source(@active.resourceId)):@active?.kind===`device`', '@active?.kind===`device`')],
    [terminalSplit, (fn) => edit(fn, terminalSplit,
      '@split=(@direction,surfaceId)=>{let @orientation=@direction===void 0?`horizontal`:@direction;if(!@thread)return;let state=@store.getState(),current=@panelState(state.byThreadKey,@thread),surface=typeof surfaceId===`string`?current.surfaces.find(item=>item.id===surfaceId):@active;if(surface?.kind!==`terminal`||surface.terminalIds.length>=4)return;let @id=surface.id,keepClosed=typeof surfaceId===`string`&&!current.isOpen,@launched=@launcher.launchTerminal({place:@terminal=>{let state=@store.getState();state.splitTerminal(@thread,@id,@terminal,@orientation),keepClosed&&state.close(@thread)}});@launched&&@focus(@thread,@launched.terminalId)}', { panelState: getPanelState })],
    [miniFrame, (fn) => editMiniPlayer(fn, anchor(source, 'position:@position({x:@drag.frame.x+@delta.x,y:@drag.frame.y+@delta.y},@container,@drag.frame)', {}).groups.position)],
    [previewTarget, editPreviewPresentation],
  ]);
  return installRuntime(next, ctx, "floating-panels-ui", "createFloatingPanelsRuntime", [
    "T3WorkspacePanels", "T3WorkspacePanelShell", "T3DockedSurface", "T3FloatingDeck",
    "T3ChatColumnShell", "T3ChatToolbar", "T3PanelToolbar", "T3NavigateBrowser",
  ], {
    React: react, jsx: `${jsx}.jsx`, jsxs: `${jsx}.jsxs`, Fragment: `${jsx}.Fragment`,
    createPortal: `${portal}.createPortal`, useI18n: translator, useStableCallback,
    Button: button, CloseIcon: closeIcon, Tooltip: tooltip, TooltipTrigger: trigger, TooltipPopup: popup,
    PanelShell: shell.name, SurfaceContent: content, rightPanelStore: store, getPanelState,
    diffPanelStore: diff, threadRefKey: threadKey, miniPlayerStore: mini, getMiniPlayer: getMini, focusTerminal: focus,
    ...browserBindings(ctx),
  }, ["t3BrowserLayoutMode"]);
}

function editMiniPlayer(source, position) {
  const { mini, size } = anchor(source, 'miniPlayer:@mini,sourceSize:@size,label:@label,onOpenInPanel:').groups;
  const { container } = anchor(source, 'let @container=@layout?.container??null,@key,@temp;').groups;
  const next = edit(source, miniFrame,
    '@frame=@layout?.previewKey===@key?@layout.layout.frame:null;if(@frame&&@container&&@mini.position&&@size?.width>0&&@size?.height>0){let ratio=@size.width/@size.height,width=Math.min(@mini.width??@frame.width,Math.max(1,@container.width-24),Math.max(1,@container.height-24)*ratio),size={width,height:width/ratio};@frame={...size,...@position(@mini.position,@container,size)}}let @inset;',
    { container, mini, size, position });
  return edit(next,
    'className:`group pointer-events-auto absolute z-[49] size-3 touch-none cursor-grab active:cursor-grabbing pointer-coarse:-m-2.5 pointer-coarse:size-8`,style:{right:@inset,top:@inset}',
    '"data-t3e-preview-drag":!0,className:`group pointer-events-auto absolute z-[50] h-7 touch-none cursor-grab active:cursor-grabbing`,style:{left:@inset,right:@inset,top:@inset}');
}

function editPreviewPresentation(source) {
  const hasSheet = source.includes('[data-slot="sheet-viewport"]');
  const template = hasSheet ? previewPresentationSheet : previewPresentationLegacy;
  const names = anchor(source, template).groups;
  const { lease, claim, element, tab, fit, rect, options, effZ } = names;
  const baseZ = hasSheet ? effZ : `${options}.zIndex`;
  const box = `{x:Math.round(${rect}.x),y:Math.round(${rect}.y),width:Math.max(1,Math.round(${rect}.width)),height:Math.max(1,Math.round(${rect}.height))}`;
  const visible = `${rect}.width>0&&${rect}.height>0`;
  const headReplacement = hasSheet
    ? 'let mode=t3BrowserLayoutMode(@element,@fit),@lease=@claim(@tab,mode),@sheetEl=@element.closest(`[data-slot="sheet-viewport"]`),@sheetZ=@sheetEl&&Number(getComputedStyle(@sheetEl).zIndex)+1||0;@sheetEl?.parentElement&&@sheetZ>0&&@setSheet({zIndex:@sheetZ,container:@sheetEl.parentElement});let @update=()=>{let @rect=@element.getBoundingClientRect(),@options=@ref.current,@effZ=Math.max(@options.zIndex,@sheetZ),'
      + `floating=@element.closest?.(".t3e-floating-window"),zIndex=floating?(Number(floating.style?.zIndex)||33)+1:${baseZ},cornerRadius=floating?(@options.cornerRadius||13):@options.cornerRadius,nextMode=t3BrowserLayoutMode(@element,@fit);if(nextMode!==mode&&${visible}){@lease.release();mode=nextMode;@lease=@claim(@tab,mode)}let @accepted=@lease.present(`
    : 'let mode=t3BrowserLayoutMode(@element,@fit),@lease=@claim(@tab,mode),@update=()=>{let @rect=@element.getBoundingClientRect(),@options=@ref.current,'
      + `floating=@element.closest?.(".t3e-floating-window"),zIndex=floating?(Number(floating.style?.zIndex)||33)+1:${baseZ},cornerRadius=floating?(@options.cornerRadius||13):@options.cornerRadius,nextMode=t3BrowserLayoutMode(@element,@fit);if(nextMode!==mode&&${visible}){@lease.release();mode=nextMode;@lease=@claim(@tab,mode)}let @accepted=@lease.present(`;
  let next = edit(source, template, headReplacement, names);
  next = edit(next, `${box},${options}.visible&&${visible},${options}.cornerRadius,${baseZ});@options.visible&&!@accepted&&(@lease.release(),@lease=@claim(@tab,@fit),@lease.present(${box},${visible},@options.cornerRadius,${baseZ}))`,
    `${box},${options}.visible&&${visible},cornerRadius,zIndex);@options.visible&&${visible}&&!@accepted&&(@lease.release(),@lease=@claim(@tab,mode),@lease.present(${box},!0,cornerRadius,zIndex))`, names);
  return edit(next, 'return window.addEventListener(`resize`,@update),window.addEventListener(`scroll`,@update,!0),()=>{@cleanup(),',
    `return @element.addEventListener("${PREVIEW_LAYOUT_EVENT}",@update),window.addEventListener(\`resize\`,@update),window.addEventListener(\`scroll\`,@update,!0),()=>{@cleanup(),@element.removeEventListener("${PREVIEW_LAYOUT_EVENT}",@update),`,
    names);
}

const tabDrag = 'sensors:@sensors,collisionDetection:@collision,modifiers:@modifiers,onDragEnd:@end,children:@children';
const panelWrapper = '"data-preview-panel-mode":@mode,"data-preview-panel-maximized":@maximized,children:[@divider,@content]';
const launcherItem = '{label:@message(`Browser`),icon:@browser,shortcut:`B`,available:@props.browserAvailable,disabledReason:@format(@reasons.browser),onClick:@props.onAddBrowser}';
const launcherStart = 'let @cache=(0,@compiler.c)(#slots),@i18n=@useI18n(),@format=@useFormatMessage(),[@selected,@setSelected]=(0,@react.useState)(-1),@items=[' + launcherItem;
const addSurfaceLegacy = 'let @add=@props.open===!1?null:(0,@jsx.jsxs)(@menu,{open:@open,onOpenChange:@setOpen,children:[(0,@jsx.jsx)(@trigger,{ref:@ref,render:(0,@jsx.jsx)(@button,{"aria-label":@i18n(`Add panel surface`),className:`shrink-0`,size:`icon-xs`,variant:`ghost-muted`}),children:(0,@jsx.jsx)(@plus,{className:`size-3.5`})}),';
const addSurfaceV13 = 'let @add=@props.open!==!1&&@canAdd?(0,@jsx.jsxs)(@menu,{open:@open,onOpenChange:@setOpen,children:[(0,@jsx.jsx)(@trigger,{ref:@ref,render:(0,@jsx.jsx)(@button,{"aria-label":@i18n(`Add panel surface`),className:`shrink-0`,size:`icon-xs`,variant:`ghost-muted`}),children:(0,@jsx.jsx)(@plus,{className:`size-3.5`})}),';
const menuProfile = '{"aria-label":@i18n(`Open browser in a profile`),className:`absolute top-1/2 right-8 -translate-y-1/2`,size:`icon-xs`,variant:`ghost-muted`}),children:(0,@jsx.jsx)(@chevron,{className:`size-3.5`})}),(0,@jsx.jsx)(@popup,{align:`end`,side:`bottom`,sideOffset:6,className:`max-w-56`,children:@props.browserProfiles.map(@profile=>(0,@jsx.jsx)(@item,';

function detectAddSurfaceTemplate(source, jsx) {
  return new RegExp(`let ${identifier}=${identifier}\\.open!==!1&&${identifier}\\?\\(0,${escapeRegex(jsx)}\\.jsxs\\)`).test(source)
    ? addSurfaceV13
    : addSurfaceLegacy;
}

function editTabStrip(source, ctx, launcher, react, jsx) {
  const addTemplate = detectAddSurfaceTemplate(source, jsx);
  const names = anchor(source, addTemplate, { jsx }).groups;
  const { source: resized, cacheVar, slots: [activeSlot, dividerSlot] } = ctx.allocateMemoSlots(source, 2);
  const known = { ...names, cache: cacheVar, activeSlot, dividerSlot, launcher, react };
  const closeMenuGuard = names.canAdd ? '(@props.open===!1||!@canAdd)&&@open&&@setOpen(!1);' : '@props.open===!1&&@open&&@setOpen(!1);';
  let next = edit(resized, closeMenuGuard,
    `${closeMenuGuard}const previousActive=@react.useRef(@props.activeSurfaceId);@react.useEffect(()=>{if(previousActive.current!==@props.activeSurfaceId){previousActive.current=@props.activeSurfaceId;if(@open&&@props.activeSurfaceId!==null)@setOpen(!1);}},[@props.activeSurfaceId,@open]);`, known);
  next = edit(next, '@cache[#propsSlot]!==@props||@cache[#pendingSlot]!==@pending||@cache[#themeSlot]!==@theme?(@tabs=',
    '@cache[#propsSlot]!==@props||@cache[#pendingSlot]!==@pending||@cache[#themeSlot]!==@theme||@cache[#activeSlot]!==@open?(@tabs=', known);
  next = edit(next, '@cache[#propsSlot]=@props,@cache[#pendingSlot]=@pending,@cache[#themeSlot]=@theme,@cache[#tabSlot]=@tabs):',
    '@cache[#propsSlot]=@props,@cache[#pendingSlot]=@pending,@cache[#themeSlot]=@theme,@cache[#activeSlot]=@open,@cache[#tabSlot]=@tabs):', known);
  next = edit(next, 'active:@surface.id===@props.activeSurfaceId,',
    'active:!@open&&!@props.enhancerChatSelected&&@surface.id===@props.activeSurfaceId,', known);
  next = edit(next, 'onActivate:@activate,onClose:@close,',
    'onActivate:(surface)=>{@setOpen(!1);@activate(surface)},onClose:@close,', known);
  next = edit(next, 'surfaces:@surfaces,onMove:@move,children:@tabs',
    'surfaces:@surfaces,onMove:@move,enhancerFloatTab:@props.enhancerFloatTab,children:@tabs', known);
  next = edit(next, 'surface:@surface,dragDisabled:!@props.onMoveSurface',
    'surface:@surface,enhancerTabControl:@props.enhancerTabControl,dragDisabled:!@props.onMoveSurface', known);
  next = edit(next, '@actions.push({id:`close`,label:@i18n(`Close`)}',
    '@props.enhancerFloatTab&&@actions.push({id:`enhancer-float`,label:@props.enhancerFloatMenuLabel(@surface)});@actions.push({id:`close`,label:@i18n(`Close`)}',
    { ...known, surface: anchor(source,
      'async(@event,@surface)=>{@event.preventDefault(),@event.stopPropagation();let @bridge=@getBridge();if(!@bridge)return;let @index=@props.surfaces.findIndex(', known).groups.surface });
  next = edit(next, '@label:switch(@choice){case`open-in-main-view`:(@surface.kind===`thread`||@surface.kind===`linked-thread`)&&@props.onOpenInMainView?.(@surface);',
    '@label:switch(@choice){case`enhancer-float`:@props.enhancerFloatTab?.(@surface);break @label;case`open-in-main-view`:(@surface.kind===`thread`||@surface.kind===`linked-thread`)&&@props.onOpenInMainView?.(@surface);', known);

  // Replace the original add menu expression, preserving the strip and the native
  // context-menu callbacks, including the browser duplicate action.
  const addRegex = names.canAdd
    ? new RegExp(`let ${escapeRegex(names.add)}=${escapeRegex(names.props)}\\.open!==!1&&${escapeRegex(names.canAdd)}\\?[\\s\\S]+?\\):null,(${identifier});`)
    : new RegExp(`let ${escapeRegex(names.add)}=${escapeRegex(names.props)}\\.open===!1\\?null:[\\s\\S]+?\\),(${identifier});`);
  const add = unique(next, addRegex, "add surface menu expression");
  next = next.replace(add[0], () => {
    const { add: variable, open, setOpen, ref, i18n, props, canAdd } = names;
    const jsxAlias = names.jsx || jsx;
    assert(jsxAlias && jsxAlias !== "undefined", "Missing tab bar JSX runtime binding");
    const hideCond = canAdd ? `${props}.open===!1||!${canAdd}` : `${props}.open===!1`;
    return `let ${variable}=${hideCond}?null:(0,${jsxAlias}.jsx)(T3NewTabStripControl,{btnRef:${ref},newTabOpen:${open}||${props}.activeSurfaceId===null,selected:!${props}.enhancerChatSelected,addLabel:${i18n}(\`Add panel surface\`),onOpenNewTab:()=>{${props}.enhancerShowWorkspace?.();${setOpen}(!0)},onCloseNewTab:()=>{if(${props}.activeSurfaceId!==null){${setOpen}(!1);${props}.enhancerShowWorkspace?.()}else ${props}.enhancerClosePanel?.()}}),${add[1]};`;
  });

  const launch = anchor(next, '@result=@props.activeSurfaceId===null?(0,@jsx.jsx)(@launcher,{onAddBrowser:@props.onAddBrowser,', known);
  const content = anchor(next, '"data-right-panel-surface-content":!0,children:@result}', { result: launch.groups.result });
  const render = next.slice(launch.index, content.index);
  const end = anchor(render, 'sideChatDisabledReason:@props.sideChatDisabledReason??null}):@props.children', known);
  const start = render.indexOf('{onAddBrowser:');
  const result = launch.groups.result;
  const memo = unique(next, new RegExp(`let ${escapeRegex(result)};[^;]+?;(?=let )`), "launcher memo block");
  assert(memo[0].includes(launch[0]), "Launcher render escaped its memo block");
  const props = render.slice(start + 1, end.index + end[0].indexOf("}"));
  next = next.replace(memo[0], () =>
    `let ${result}=${names.open}||${names.props}.activeSurfaceId===null?(0,${names.jsx || jsx}.jsx)(${launcher},{${props},onDuplicateBrowser:${names.props}.onDuplicateBrowser,onDismiss:()=>${names.setOpen}(!1)}):${names.props}.children;`);

  next = edit(next,
    '@cache[#lastSlot]!==@content?(@out=(0,@jsx.jsxs)(@shell,{workspaceArea:!0,workspaceFocusKey:@key,workspaceLabel:@label,mode:@mode,',
    '@cache[#lastSlot]!==@content||@cache[#dividerSlot]!==@props.enhancerDividerSlot?(@out=(0,@jsx.jsxs)(@shell,{workspaceArea:!0,workspaceFocusKey:@key,workspaceLabel:@label,mode:@mode,enhancerDividerSlot:@props.enhancerDividerSlot,', known);
  return edit(next,
    '@cache[#lastSlot]=@content,@cache[#outSlot]=@out):@out=@cache[#outSlot],@out}',
    '@cache[#lastSlot]=@content,@cache[#dividerSlot]=@props.enhancerDividerSlot,@cache[#outSlot]=@out):@out=@cache[#outSlot],@out}', known);
}

function editDrag(source, ctx) {
  const { source: resized, cacheVar, slots: [slot] } = ctx.allocateMemoSlots(source, 1);
  const props = anchor(source, 'function @handler(@props){let @cache=(0,@compiler.c)(').groups.props;
  const { end, sensors, children } = anchor(source, tabDrag).groups;
  const known = { cache: cacheVar, slot, end, sensors, children };
  let next = beforeMemo(resized, `const drag=T3TrackTabDrag(${props});`);
  next = edit(next, '@cache[#endSlot]!==@end||@cache[#sensorSlot]!==@sensors||@cache[#childSlot]!==@children?',
    '@cache[#endSlot]!==@end||@cache[#sensorSlot]!==@sensors||@cache[#childSlot]!==@children||@cache[#slot]!==drag?', known);
  next = edit(next, '@cache[#childSlot]=@children,@cache[#resultSlot]=@result):@result=@cache[#resultSlot],@result}',
    '@cache[#childSlot]=@children,@cache[#resultSlot]=@result,@cache[#slot]=drag):@result=@cache[#resultSlot],@result}', known);
  return edit(next, tabDrag,
    'sensors:@sensors,collisionDetection:@collision,modifiers:T3TabModifiers,onDragStart:drag.start,onDragCancel:drag.cancel,onDragEnd:event=>{if(!drag.finish(event))@end(event)},children:@children', known);
}

function editPanelWrapper(source, ctx) {
  const { source: resized, cacheVar, slots: [slot] } = ctx.allocateMemoSlots(source, 1);
  const props = anchor(source, 'function @fn(@props){let @cache=(0,@compiler.c)(').groups.props;
  const { content } = anchor(source, panelWrapper).groups;
  const names = { cache: cacheVar, props, content, slot };
  let next = edit(resized, '@cache[#contentSlot]!==@content?(@result=(0,@jsx.jsxs)(`div`,{ref:',
    '@cache[#contentSlot]!==@content||@cache[#slot]!==@props.enhancerDividerSlot?(@result=(0,@jsx.jsxs)(`div`,{ref:', names);
  next = edit(next, panelWrapper, '"data-preview-panel-mode":@mode,"data-preview-panel-maximized":@maximized,children:[@divider,@props.enhancerDividerSlot,@content]', names);
  return edit(next, '@cache[#contentSlot]=@content,@cache[#outSlot]=@result):@result=@cache[#outSlot]',
    '@cache[#contentSlot]=@content,@cache[#slot]=@props.enhancerDividerSlot,@cache[#outSlot]=@result):@result=@cache[#outSlot]', names);
}

const resizeOptions = '@cache[#widthSlot]!==@width||@cache[#keySlot]!==@key||@cache[#defaultSlot]!==@defaultWidth?(@options={storageKey:@key,defaultWidth:@defaultWidth,minWidth:@minimum,maxWidth:@width,edge:`left`},@cache[#widthSlot]=@width,@cache[#keySlot]=@key,@cache[#defaultSlot]=@defaultWidth,@cache[#resultSlot]=@options):@options=@cache[#resultSlot];';
const tabContent = '@out=(0,@jsx.jsx)(`div`,{"data-active-tab":@active,';

function applyTabBar(source, context) {
  const ctx = context || createPatchContext(null, null, source);
  const { jsx } = ctx.resolveReactBindings();
  assert(jsx, "Missing tab bar JSX runtime");
  const launch = anchor(source, launcherStart).groups;
  const addSurfaceTemplate = detectAddSurfaceTemplate(source, jsx);
  const menu = anchor(source, addSurfaceTemplate, { jsx }).groups;
  const profiles = anchor(source, menuProfile, { jsx }).groups;
  const originalLauncher = ctx.findEnclosingFunction(anchor(source, launcherStart).index);
  assert(originalLauncher?.name, "Missing original surface launcher");
  const launcher = originalLauncher.source;
  const { cn } = anchor(launcher, '@className=@cn(`scrollbar-gutter-both flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 outline-none`,').groups;
  const { matchShortcut, popupSelector } = anchor(launcher, 'let @selected=@matchShortcut(@items,@event);if(!@selected||document.querySelector(@popupSelector))return;').groups;
  const { isEditableTarget } = anchor(launcher, 'instanceof Element&&@isEditableTarget(@target)||(@event.preventDefault(),@event.stopPropagation(),').groups;
  const { renderItemIcon } = anchor(launcher, ',@alias=@renderItemIcon,@label;').groups;
  const { DisabledTooltip } = anchor(launcher, ':(0,@jsx.jsx)(@DisabledTooltip,{reason:@item.disabledReason,trigger:', { jsx }).groups;
  const { modifiers } = anchor(source, tabDrag).groups;
  const next = editFunctions(source, ctx, [
    [addSurfaceTemplate, (fn) => editTabStrip(fn, ctx, originalLauncher.name, launch.react, jsx)],
    [launcherStart, (fn) => {
      const head = anchor(fn, launcherStart).groups;
      const items = anchor(fn, '@items=[' + launcherItem, head);
      const start = items.index + items[0].indexOf("[");
      const tokens = tokenize(fn.slice(start));
      const end = tokens[findMatchingToken(tokens, 0)].end + start;
      return `function ${originalLauncher.name}(${head.props}){let ${head.format}=${head.useFormatMessage}(),${head.items}=${fn.slice(start, end)};return (0,${jsx}.jsx)(T3ChatGptSurfaceLauncher,{...${head.props},items:${head.items}})}`;
    }],
    [resizeOptions, (fn) => {
      const { config } = anchor(fn, '@enabled=@config.enabled??!0,@container=@config.container,').groups;
      const updated = edit(fn, resizeOptions,
        '@cache[#widthSlot]!==@width||@cache[#keySlot]!==@key||@cache[#defaultSlot]!==@defaultWidth||@cache[#resultSlot]?.edge!==t3Edge?(@options={storageKey:@key,defaultWidth:@defaultWidth,minWidth:@minimum,maxWidth:@width,edge:t3Edge},@cache[#widthSlot]=@width,@cache[#keySlot]=@key,@cache[#defaultSlot]=@defaultWidth,@cache[#resultSlot]=@options):@options=@cache[#resultSlot];');
      return edit(updated, '@defaultWidth=@config.defaultWidth??@fallback,@options;', '@defaultWidth=@config.defaultWidth??@fallback,@options;let t3Edge=@config.edge??`left`;', { config });
    }],
    [tabDrag, (fn) => editDrag(fn, ctx)],
    [panelWrapper, (fn) => editPanelWrapper(fn, ctx)],
    [tabContent, (fn) => {
      const props = anchor(fn, 'function @fn(@props){let @cache=(0,@compiler.c)(').groups.props;
      const { surface: item } = anchor(fn, '{surface:@surface,audio:@audio,audioRuntimeTabId:@tab,onActivate:', {}).groups;
      return edit(edit(fn, tabContent, '@out=(0,@jsx.jsxs)(`div`,{"data-active-tab":@active,'),
        'style:@style,className:@className,children:@children}',
        'style:@style,className:@className,children:[@children,@props.enhancerTabControl?.(@surface)]}', { props, surface: item });
    }],
  ]);
  return installRuntime(next, ctx, "tab-bar-ui", "createTabBarRuntime",
    ["T3NewTabStripControl", "T3ChatGptSurfaceLauncher", "T3TrackTabDrag", "T3TabModifiers"], {
      React: launch.react, jsx: `${jsx}.jsx`, jsxs: `${jsx}.jsxs`, useI18n: launch.useI18n,
      useFormatMessage: launch.useFormatMessage, cn, Button: menu.button, PlusIcon: menu.plus,
      Menu: menu.menu, MenuTrigger: menu.trigger, MenuPopup: profiles.popup, MenuItem: profiles.item,
      ChevronDown: profiles.chevron, tabModifiers: modifiers, matchShortcut, renderItemIcon, DisabledTooltip, isEditableTarget,
      popupSelector,
    });
}

const viewportSelection = 'fitSourceContent:@state?.fitSourceContent??!1,fittedSourceContent:@state?.fittedSourceContent??null,rect:';
const viewportClaim = 'fittedSourceContent:@fit?@state?.content??null:null,fitSourceContent:@fit,';
const viewportRelease = 'visible:!1,fittedSourceContent:null,fitSourceContent:!1,updatedAt:';
const previewOverlayStyle = '{active:@active,cornerRadius:@radius=0,hiddenSize:@hidden,keepPaintableWhenInactive:@keep=!1,rect:@rect,renderingActive:@rendering,zIndex:@zIndex=30}=@props;return @active&&@rect?{left:@rect.x,top:@rect.y,width:@rect.width,height:@rect.height,zIndex:@zIndex,pointerEvents:`auto`,...@radius>0?{borderRadius:@radius}:{}}:';
const previewStyleCall = 'keepPaintableWhenInactive:@keep(navigator.platform),cornerRadius:@selection.cornerRadius,zIndex:@selection.zIndex,rect:@rect,hiddenSize:';

function applyResponsivePreview(source, context) {
  const ctx = context || createPatchContext(null, null, source);
  const next = editFunctions(source, ctx, [
    [previewOverlayStyle, (fn) => edit(fn, previewOverlayStyle,
      '{active:@active,cornerRadius:@radius=0,responsive:t3Responsive=!1,hiddenSize:@hidden,keepPaintableWhenInactive:@keep=!1,rect:@rect,renderingActive:@rendering,zIndex:@zIndex=30}=@props;return @active&&@rect?{left:@rect.x,top:@rect.y,width:@rect.width,height:@rect.height,zIndex:@zIndex,pointerEvents:`auto`,...@radius>0?t3Responsive?{borderBottomLeftRadius:@radius,borderBottomRightRadius:@radius,clipPath:`inset(0 round 0 0 ${@radius}px ${@radius}px)`}:{borderRadius:@radius}:{}}:')],
    [viewportSelection, (fn) => {
      const { state } = anchor(fn, viewportSelection).groups;
      const { viewport } = anchor(fn, 'initialUrl:@url,viewport:@viewport,pictureInPicture:@pip,').groups;
      const selector = anchor(fn, '@selector=@local=>{let @state=@local.byTabId[@tab];return{content:', { state }).groups.selector;
      let updated = edit(fn, viewportSelection,
        'fitSourceContent:@state?.fitSourceContent??!1,fittedSourceContent:@state?.fittedSourceContent??null,responsive:@state?.responsive??!1,rect:', { state });
      const { selection } = anchor(updated, 'let @selection=@store(@shallow(@selector)),@next;', { selector }).groups;
      updated = edit(updated, 'let @selection=@store(@shallow(@selector)),@next;',
        'let @selection=@store(@shallow(@selector)),@next;if(@selection.responsive)@viewport=T3ResponsiveViewport;', { selector, viewport, selection });
      updated = edit(updated, previewStyleCall,
        'keepPaintableWhenInactive:@keep(navigator.platform),cornerRadius:@selection.cornerRadius,responsive:@selection.responsive,zIndex:@selection.zIndex,rect:@rect,hiddenSize:', { selection });
      return beforeMemo(updated, `/* ${RESPONSIVE_MARKER} */`);
    }],
  ]);
  const claim = edit(next, viewportClaim,
    'fittedSourceContent:@fit===!0?@state?.content??null:null,fitSourceContent:@fit===!0,responsive:@fit==="responsive",');
  const released = edit(claim, viewportRelease, 'visible:!1,fittedSourceContent:null,fitSourceContent:!1,responsive:!1,updatedAt:');
  const fn = ctx.findEnclosingFunction(anchor(source, viewportSelection).index);
  const { state } = anchor(fn.source, viewportSelection).groups;
  const { selector } = anchor(fn.source, '@selector=@local=>{let @state=@local.byTabId[@tab];return{content:', { state }).groups;
  const { store } = anchor(fn.source, 'let @selection=@store(@shallow(@selector)),@next;', { selector }).groups;
  const storeCode = getTopLevelDeclSource(released, store);
  assert(storeCode?.includes('responsive:'), "Missing browser viewport store declaration");
  ctx.recordInjectedCode("const " + storeCode);
  const declaration = 'const T3ResponsiveViewport=Object.freeze({_tag:`fill`});';
  ctx.recordInjectedCode(declaration);
  return declaration + released;
}

function applyPreviewToolbar(source, context) {
  const ctx = context || createPatchContext(null, null, source);
  return editFunctions(source, ctx, [[
    '"data-surface-subheader":!0,children:[@first,',
    (fn) => {
      const float = unique(fn, new RegExp(`let (${identifier});[^;]+?\\(\\1=${identifier}\\?\\(0,${identifier}\\.jsxs?\\)\\([^;]+?Close floating preview`),
        "floating preview toolbar control")[1];
      const row = unique(fn, /"data-surface-subheader":!0,children:\[([\w$,]+)\]/, "preview toolbar children");
      const children = row[1].split(",");
      assert.equal(children.filter((child) => child === float).length, 1, "Could not isolate preview float control");
      children.splice(children.indexOf(float), 1);
      return fn.replace(row[0], () => `"data-surface-subheader":!0,children:[/* ${TOOLBAR_MARKER} */${children.join(",")}]`);
    },
  ]]);
}

const {
  workspaceFloatFrame, workspaceSnapFrame, defaultChatFloatFrame, defaultPreviewFloatFrame,
  serializePreviewFloatFrame, restorePreviewFloatFrame, chatPillFrame,
  placeSurfaceFloat, t3BrowserLayoutMode,
} = loadRuntimeExports("floating-panels-ui");
const { tabDroppedOutside } = loadRuntimeExports("tab-bar-ui");
const responsivePreviewPatch = {
  id: "workspace-floating-preview-responsive",
  name: "工作区浏览器浮窗随宽度排版",
  marker: RESPONSIVE_MARKER,
  legacyMarkers: ["T3_WORKSPACE_FLOATING_PREVIEW_RESPONSIVE_V1"],
  targetRegex: APP_SHELL.preferredRegex,
  targetSpec: APP_SHELL,
  originalHash: "c016e4750075b866ebfee6f747eef4db8e48fe7148556848bb9ca132b92ddd4d",
  knownHashes: ["588d75b88444f9852ce6a07e2a8f7ae66cccd5532497e7ca9fb2fe2be0806e4b"],
  apply: applyResponsivePreview,
};
const tabBarPatch = {
  id: "workspace-floating-tab-bar",
  name: "工作区标签页浮动入口与新标签页启动台",
  marker: TAB_BAR_MARKER,
  legacyMarkers: Array.from({ length: 15 }, (_, index) => "T3_WORKSPACE_FLOATING_TAB_BAR_V" + (index + 1)),
  targetRegex: /^apps\/server\/dist\/client\/assets\/PanelLayoutControls-[\w-]+\.js$/,
  targetSpec: {
    pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
    preferredRegex: /^apps\/server\/dist\/client\/assets\/PanelLayoutControls-[\w-]+\.js$/,
    includes: ["Add panel surface", "open-in-main-view", "data-workspace-focus-key", "Open a surface"],
  },
  originalHash: "a0c9c71591386a74719619c81c751ca5f074c3ac13e93b1ddef343267ad1988a",
  knownHashes: ["e361ac3632ba56b325a4a8cbdedd2b59cdc94bc71a1d5e9f31ea4966e550dbb9"],
  apply: applyTabBar,
};
const previewToolbarPatch = {
  id: "workspace-floating-preview-toolbar",
  name: "浏览器浮动入口统一到标签栏",
  marker: TOOLBAR_MARKER,
  legacyMarkers: ["T3_WORKSPACE_FLOATING_PREVIEW_TOOLBAR_V1"],
  targetRegex: /^apps\/server\/dist\/client\/assets\/PreviewPanel-[\w-]+\.js$/,
  targetSpec: {
    pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
    preferredRegex: /^apps\/server\/dist\/client\/assets\/PreviewPanel-[\w-]+\.js$/,
    includes: ["Close floating preview", "Float preview over chat", "data-surface-subheader"],
  },
  originalHash: "20cea0b6deb7e0ed42b3adec93e3a3940fff269ec359b1366af81815b3ae482e",
  knownHashes: ["392279013e375e241ad05496a708290e05dd71832ece5da1152cefdf44a22637"],
  apply: applyPreviewToolbar,
};
module.exports = {
  id: ID,
  name: "工作区标签页浮动、拖动与缩放",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: THREAD_ROUTE.preferredRegex,
  targetSpec: THREAD_ROUTE,
  originalHash: ORIGINAL_HASH,
  knownHashes: KNOWN_HASHES,
  apply,
  workspaceFloatFrame,
  workspaceSnapFrame,
  defaultChatFloatFrame,
  defaultPreviewFloatFrame,
  serializePreviewFloatFrame,
  restorePreviewFloatFrame,
  chatPillFrame,
  placeSurfaceFloat,
  t3BrowserLayoutMode,
  tabDroppedOutside,
  responsivePreviewPatch,
  tabBarPatch,
  previewToolbarPatch,
};

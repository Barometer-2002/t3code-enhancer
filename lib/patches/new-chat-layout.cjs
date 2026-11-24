"use strict";

const assert = require("node:assert/strict");

const ID = "new-chat-layout";
const MARKER = "T3_NEW_CHAT_LAYOUT_V6";
const LEGACY_MARKERS = ["T3_NEW_CHAT_LAYOUT_V1", "T3_NEW_CHAT_LAYOUT_V2", "T3_NEW_CHAT_LAYOUT_V3", "T3_NEW_CHAT_LAYOUT_V4", "T3_NEW_CHAT_LAYOUT_V5"];
const TARGET_REGEX = /^apps\/server\/dist\/client\/assets\/_chat-[\w-]+\.js$/;
const ORIGINAL_HASH = "e5f61017c214605ad2251948b0e53af63901b7337dd0b22c36feebb404b85654";

const lAndRAnchor =
  "let L_=Sl?`pointer-events-none absolute inset-0 z-20 flex items-center [@media(max-height:34rem)]:items-end`:`pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2`,R_=Sl?(0,$.jsx)(`div`,{className:`absolute inset-x-0 bottom-full`,children:(0,$.jsx)(`div`,{className:`pb-4 group-has-data-[composer-shoulder-tab]/composer-stack:pb-0`,style:m?{viewTransitionName:er}:void 0,children:(0,$.jsx)(LB,{draftId:y,activeProjectRef:Xa,activeProjectTitle:Za?.title??null})})}):null";

const avOverlayAnchor =
  'av=(0,$.jsx)(`div`,{...F_,ref:I_,inert:wn,"data-chat-composer-overlay":`true`,className:L_,children:iv})';

const hpTrailingPermAnchor =
  "...Ur?{}:{trailing:(0,$.jsx)(sF,{environmentId:i,runtimeMode:Ri,supportedRuntimeModes:bs?.supportedRuntimeModes,onRuntimeModeChange:Gh})}";

const noticeBelowAnchor =
  "$_=Sl&&lh.length>0?(0,$.jsx)(`div`,{className:`absolute inset-x-0 top-full flex flex-col gap-1 pt-4 [@media(max-height:34rem)]:static`,children:(0,$.jsx)(QF,{items:lh,detached:!0})}):null,t[669]=lh,t[670]=Sl,t[671]=$_):$_=t[671];let ev;t[672]!==Z_||t[673]!==$_?(ev=(0,$.jsxs)(`div`,{className:`relative`,children:[Z_,$_]}),t[672]=Z_,t[673]=$_,t[674]=ev):ev=t[674];let tv;t[675]===Symbol.for(`react.memo_cache_sentinel`)?(tv=(0,$.jsx)(`div`,{\"aria-hidden\":!0,className:`h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]`}),t[675]=tv):tv=t[675];let nv;t[676]!==wl||t[677]!==z_||t[678]!==B_||t[679]!==ev?(nv=(0,$.jsxs)(`div`,{ref:wl,className:`relative z-10`,style:z_,children:[B_,ev,tv]}),t[676]=wl,t[677]=z_,t[678]=B_,t[679]=ev,t[680]=nv):nv=t[680];let rv;t[681]!==R_||t[682]!==nv?(rv=(0,$.jsxs)(`div`,{\"data-chat-composer-stack\":`true`,className:`group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)`,children:[R_,nv]}),t[681]=R_,t[682]=nv,t[683]=rv):rv=t[683];";

function buildInjectedComponents() {
  return `
/* ${MARKER} */
const T3_NO_PROJECT_VAL = "__t3e_no_project__";

function t3NcIsZh() {
  return typeof document !== "undefined" && /^zh/i.test(document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
}

function T3NewChatCloudIcon() {
  return (0, $.jsxs)("svg", {
    className: "t3e-nc-hero-icon",
    viewBox: "0 0 48 48",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    "aria-hidden": true,
    children: [
      (0, $.jsx)("path", {
        d: "M16.2 35.8h15.6c4.6 0 8.2-3.4 8.2-7.8 0-3.7-2.6-6.8-6.1-7.6-.8-5.1-5.1-8.9-10.4-8.9-5.8 0-10.5 4.7-10.5 10.5 0 .4 0 .8.1 1.2-3 .9-5.1 3.6-5.1 6.8 0 3.2 2.4 5.8 5.6 5.8h2.6Z",
        stroke: "currentColor",
        strokeWidth: "2.1",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }),
      (0, $.jsx)("path", {
        d: "M18.8 22.8 22.2 26l-3.4 3.2M24.8 29.2h4.4",
        stroke: "currentColor",
        strokeWidth: "2.1",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      })
    ]
  });
}

function T3NewChatHero({ activeProjectRef, activeProjectTitle }) {
  const t = zt();
  const projects = lu();
  const { scratchWorkspaceRootFor } = vx();
  const isZh = t3NcIsZh();
  const heroRef = Z.useRef(null);
  const projObj = activeProjectRef === null ? null : projects.find((p) => p.environmentId === activeProjectRef.environmentId && p.id === activeProjectRef.projectId) ?? null;
  const isScratch = projObj !== null && Qs(projObj, scratchWorkspaceRootFor(projObj.environmentId));
  const showProjectInTitle = !isScratch && Boolean(activeProjectTitle);

  const openProjectPicker = () => {
    const scope = heroRef.current?.closest?.("[data-chat-composer-overlay]") ?? null;
    const trigger = scope?.querySelector?.("[data-draft-project-trigger]") ?? null;
    if (trigger && typeof trigger.click === "function") trigger.click();
  };

  return (0, $.jsxs)("div", {
    ref: heroRef,
    className: "t3e-nc-hero",
    "data-t3e-new-chat-hero": "true",
    children: [
      (0, $.jsx)(T3NewChatCloudIcon, {}),
      showProjectInTitle
        ? (0, $.jsxs)("h1", {
            className: "t3e-nc-hero-title",
            children: [
              isZh ? "你想让我们在 " : "What should we build in ",
              (0, $.jsx)("button", {
                type: "button",
                className: "t3e-nc-hero-project-btn",
                "aria-label": isZh ? \`切换项目：\${activeProjectTitle}\` : \`Switch project: \${activeProjectTitle}\`,
                onClick: openProjectPicker,
                children: activeProjectTitle
              }),
              isZh ? " 中构建什么？" : "?"
            ]
          })
        : (0, $.jsx)("h1", {
            className: "t3e-nc-hero-title",
            children: isZh ? "我们要构建什么？" : t("What should we work on?")
          })
    ]
  });
}

function T3LaptopIcon() {
  return (0, $.jsxs)("svg", {
    className: "t3e-nc-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    children: [
      (0, $.jsx)("rect", { x: "3", y: "4", width: "18", height: "12", rx: "2" }),
      (0, $.jsx)("path", { d: "M2 20h20" })
    ]
  });
}

function T3RemoteIcon() {
  return (0, $.jsxs)("svg", {
    className: "t3e-nc-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    children: [
      (0, $.jsx)("rect", { x: "3", y: "4", width: "18", height: "6", rx: "1.5" }),
      (0, $.jsx)("rect", { x: "3", y: "14", width: "18", height: "6", rx: "1.5" }),
      (0, $.jsx)("circle", { cx: "7", cy: "7", r: "0.8", fill: "currentColor" }),
      (0, $.jsx)("circle", { cx: "7", cy: "17", r: "0.8", fill: "currentColor" })
    ]
  });
}

function T3FolderIcon() {
  return (0, $.jsx)("svg", {
    className: "t3e-nc-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    children: (0, $.jsx)("path", {
      d: "M3 7a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
    })
  });
}

function T3DotsIcon() {
  return (0, $.jsxs)("svg", {
    className: "t3e-nc-dots-icon",
    viewBox: "0 0 24 24",
    fill: "currentColor",
    "aria-hidden": true,
    children: [
      (0, $.jsx)("circle", { cx: "6", cy: "12", r: "1.8" }),
      (0, $.jsx)("circle", { cx: "12", cy: "12", r: "1.8" }),
      (0, $.jsx)("circle", { cx: "18", cy: "12", r: "1.8" })
    ]
  });
}

function T3WorktreeIcon() {
  return (0, $.jsxs)("svg", {
    className: "t3e-nc-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    children: [
      (0, $.jsx)("path", { d: "M4 12h6l5-6h5" }),
      (0, $.jsx)("path", { d: "M10 12l5 6h5" }),
      (0, $.jsx)("path", { d: "M17 4l3 2-3 2" }),
      (0, $.jsx)("path", { d: "M17 16l3 2-3 2" })
    ]
  });
}

function T3BranchIcon() {
  return (0, $.jsxs)("svg", {
    className: "t3e-nc-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    children: [
      (0, $.jsx)("circle", { cx: "6", cy: "6", r: "2.2" }),
      (0, $.jsx)("circle", { cx: "18", cy: "7", r: "2.2" }),
      (0, $.jsx)("circle", { cx: "6", cy: "18", r: "2.2" }),
      (0, $.jsx)("path", { d: "M6 8.2v7.6M18 9.2c0 4-3 4.8-12 4.8" })
    ]
  });
}

function T3ClearCircleIcon() {
  return (0, $.jsxs)("svg", {
    className: "t3e-nc-clear-icon",
    viewBox: "0 0 16 16",
    fill: "none",
    "aria-hidden": true,
    children: [
      (0, $.jsx)("circle", { cx: "8", cy: "8", r: "7", fill: "currentColor", fillOpacity: "0.42" }),
      (0, $.jsx)("path", {
        d: "M5.6 5.6 10.4 10.4M10.4 5.6 5.6 10.4",
        stroke: "var(--cx-surface, #fff)",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      })
    ]
  });
}

function T3CloseXIcon() {
  return (0, $.jsx)("svg", {
    className: "t3e-nc-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    children: (0, $.jsx)("path", { d: "M18 6 6 18M6 6l12 12" })
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
  const a = zt();
  const o = lu();
  const { environments: allEnvs } = Ep();
  const primaryEnvId = Lp();
  const groupingSettings = Pp(Dh);
  const setDraftLogical = U(YB);
  const getDraftSession = U(JB);
  const handleNewThread = H_();
  const keybindings = mr(Vs);
  const filterApi = rl();
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = vx();
  const { canPinProjectGroup, toggleProjectGroupPin } = z_();

  const [projOpen, setProjOpen] = Z.useState(false);
  const [projQuery, setProjQuery] = Z.useState("");
  const [envMenuOpen, setEnvMenuOpen] = Z.useState(false);
  const [moreOpen, setMoreOpen] = Z.useState(false);
  const highlightRef = Z.useRef(null);
  const scratchTokenRef = Z.useRef(null);
  const mountedRef = Z.useRef(true);
  const latestDraftIdRef = Z.useRef(n);
  latestDraftIdRef.current = n;
  const envMenuRef = Z.useRef(null);
  const envTriggerRef = Z.useRef(null);
  const moreMenuRef = Z.useRef(null);
  const branchPickerRef = Z.useRef(null);
  const moreTriggerRef = Z.useRef(null);

  Z.useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  Z.useEffect(() => {
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

  const envMap = new Map(allEnvs.map(KB));
  const groups = tb(envMap);
  const multiMachine = Mh(groups);
  const machineMap = new Map(allEnvs.map(GB));
  const resolvedGroups = Nh({ groups: Ah(groups), preferredProjectRef: r });
  const groupByKey = new Map(resolvedGroups.map(WB));
  const activeGroup = r === null ? null : groups.find((g) => g.memberProjectRefs.some((ref) => M(ref) === M(r))) ?? null;
  const activeProjectKey = activeGroup?.projectKey ?? "";
  const activeProjectObj = r === null ? null : o.find((p) => p.environmentId === r.environmentId && p.id === r.projectId) ?? null;
  const isScratch = activeProjectObj !== null && Qs(activeProjectObj, scratchWorkspaceRootFor(activeProjectObj.environmentId));
  const nonScratchGroups = resolvedGroups.filter(({ targetProject }) => !Qs(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)));
  const hasSelectedProject = !isScratch && Boolean(i);
  const noProjectLabel = isZh ? "不在项目中工作" : "Work without a project";
  const rawItems = [
    ...nonScratchGroups.map(UB),
    { value: IB, label: isZh ? "新建项目" : a("Add project") },
    ...(hasSelectedProject ? [{ value: T3_NO_PROJECT_VAL, label: noProjectLabel }] : [])
  ];
  const items = Kb(rawItems, HB, projOpen);
  const trimmed = projQuery.trim();
  const filteredItems = trimmed.length === 0
    ? items
    : items.filter((it) => it.value !== IB && it.value !== T3_NO_PROJECT_VAL && filterApi.contains(it, trimmed, VB));
  const selectedItem = items.find((it) => it.value === activeProjectKey) ?? null;

  const getDraftKey = () => {
    const d = n ? U.getState().getDraftSession(n) : null;
    return d ? \`\${d.environmentId}:\${d.projectId}:\${d.logicalProjectKey}\` : null;
  };

  const switchToProject = (project, logicalKey) => {
    if (!n) return;
    scratchTokenRef.current = null;
    const ref = ft(project.environmentId, project.id);
    if (Ut(getDraftSession(n))) {
      setDraftLogical(logicalKey, ref, n);
      fx(n, ref);
    } else {
      handleNewThread(ref);
    }
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
      switchToProject(scratchProj, Oh(scratchProj, groupingSettings));
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
  const activeEnvInfo = envChoices.find((e) => e.environmentId === currentEnvId)
    || { environmentId: currentEnvId, label: isZh ? "此计算机" : "This computer", isLocal: true };
  const canSwitchEnv = !envLocked && (envChoices.length > 1 || Boolean(onAutoEnvironment));

  const effectiveEnvMode = forceNewWorktree ? "worktree" : envMode;
  const isWorktreeOn = effectiveEnvMode === "worktree";
  const worktreeDisabled = Boolean(envLocked || forceNewWorktree || (isServerThread && worktreePath !== null));
  const showMoreSettings = hasSelectedProject && Boolean(showGitControls) && Boolean(environmentId) && Boolean(threadId);

  const selectProjectLabel = isZh ? "选择项目" : "Select project";
  const moreTitle = isZh ? "更多设置" : "More settings";
  const newWorktreeLabel = isZh ? "新建工作树" : "New worktree";
  const branchLabel = isZh ? "分支" : "Branch";

  return (0, $.jsxs)("div", {
    className: "t3e-nc-tray",
    "data-t3e-new-chat-tray": "true",
    children: [
      (0, $.jsxs)("div", {
        className: "t3e-nc-tray-left",
        children: [
          (0, $.jsxs)("div", {
            className: "t3e-nc-rel",
            ref: envMenuRef,
            children: [
              (0, $.jsxs)("button", {
                type: "button",
                ref: envTriggerRef,
                "aria-disabled": !canSwitchEnv || undefined,
                ...(canSwitchEnv ? { "aria-haspopup": "menu", "aria-expanded": envMenuOpen } : {}),
                className: Cr("t3e-nc-env-btn", canSwitchEnv && "is-interactive", envMenuOpen && "is-open"),
                onClick: () => {
                  if (canSwitchEnv) setEnvMenuOpen((v) => !v);
                },
                title: activeEnvInfo.label,
                children: [
                  activeEnvInfo.isLocal ? (0, $.jsx)(T3LaptopIcon, {}) : (0, $.jsx)(T3RemoteIcon, {}),
                  (0, $.jsx)("span", { className: "t3e-nc-trunc", children: autoEnvironmentLabel || activeEnvInfo.label })
                ]
              }),
              envMenuOpen && canSwitchEnv
                ? (0, $.jsxs)("div", {
                    className: "t3e-nc-popover t3e-nc-env-pop",
                    role: "menu",
                    children: [
                      (0, $.jsx)("div", {
                        className: "t3e-nc-pop-title",
                        children: isZh ? "运行环境" : "Run on"
                      }),
                      onAutoEnvironment
                        ? (0, $.jsxs)("button", {
                            type: "button",
                            role: "menuitemradio",
                            "aria-checked": Boolean(autoEnvironmentLabel),
                            className: Cr("t3e-nc-pop-item", Boolean(autoEnvironmentLabel) && "is-active"),
                            onClick: () => {
                              setEnvMenuOpen(false);
                              onAutoEnvironment();
                            },
                            children: [
                              (0, $.jsx)(T3RemoteIcon, {}),
                              (0, $.jsx)("span", { className: "t3e-nc-trunc", children: autoEnvironmentLabel || a("Auto balance") })
                            ]
                          })
                        : null,
                      envChoices.map((env) =>
                        (0, $.jsxs)(
                          "button",
                          {
                            type: "button",
                            role: "menuitemradio",
                            "aria-checked": !autoEnvironmentLabel && env.environmentId === currentEnvId,
                            className: Cr("t3e-nc-pop-item", !autoEnvironmentLabel && env.environmentId === currentEnvId && "is-active"),
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
                              env.isLocal ? (0, $.jsx)(T3LaptopIcon, {}) : (0, $.jsx)(T3RemoteIcon, {}),
                              (0, $.jsx)("span", { className: "t3e-nc-pop-item-label", children: env.label }),
                              !autoEnvironmentLabel && env.environmentId === currentEnvId
                                ? (0, $.jsx)("span", { className: "t3e-nc-check", children: "✓" })
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

          (0, $.jsxs)(sl, {
            items,
            filteredItems,
            autoHighlight: true,
            itemToStringLabel: BB,
            isItemEqualToValue: zB,
            open: projOpen,
            onItemHighlighted: (ev) => { highlightRef.current = ev?.value ?? null; },
            onOpenChange: (open) => { setProjOpen(open); setProjQuery(""); },
            value: selectedItem,
            onValueChange: (val) => {
              if (!val) return;
              setProjOpen(false);
              if (val.value === IB) {
                qB();
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
                ? (0, $.jsxs)("div", {
                    className: "t3e-nc-proj-pill",
                    children: [
                      (0, $.jsx)("button", {
                        type: "button",
                        className: "t3e-nc-proj-clear",
                        title: noProjectLabel,
                        "aria-label": noProjectLabel,
                        onClick: (ev) => {
                          ev.stopPropagation();
                          setMoreOpen(false);
                          void switchToScratchOnEnv(null);
                        },
                        children: (0, $.jsx)(T3ClearCircleIcon, {})
                      }),
                      (0, $.jsx)(cl, {
                        render: (0, $.jsx)("button", {
                          type: "button",
                          className: "t3e-nc-proj-name"
                        }),
                        "data-draft-project-trigger": "",
                        children: (0, $.jsx)(MB, { value: i, singleLine: true })
                      })
                    ]
                  })
                : (0, $.jsxs)(cl, {
                    render: (0, $.jsx)("button", {
                      type: "button",
                      className: "t3e-nc-proj-empty"
                    }),
                    "data-draft-project-trigger": "",
                    children: [
                      (0, $.jsx)(T3FolderIcon, {}),
                      (0, $.jsx)("span", { className: "t3e-nc-trunc", children: selectProjectLabel })
                    ]
                  }),
              (0, $.jsxs)(ol, {
                align: "start",
                side: "top",
                sideOffset: 8,
                className: "w-72 overflow-hidden",
                children: [
                  (0, $.jsx)(nl, {
                    "aria-label": a("Search projects"),
                    placeholder: a("Search projects..."),
                    value: projQuery,
                    onChange: (ev) => setProjQuery(ev.target.value),
                    onKeyDown: (ev) => {
                      const cur = highlightRef.current;
                      const grp = cur ? groupByKey.get(cur)?.group : void 0;
                      if (grp && canPinProjectGroup(grp) && R_(ev, keybindings)) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        toggleProjectGroupPin(grp);
                      }
                    }
                  }),
                  (0, $.jsx)(al, { children: (0, $.jsx)(X, { children: isZh ? "未找到匹配的项目。" : a("No matching projects.") }) }),
                  (0, $.jsx)(tl, {
                    children: (item) => {
                      const entry = groupByKey.get(item.value);
                      return (0, $.jsxs)(
                        il,
                        {
                          hideIndicator: true,
                          value: item,
                          children: [
                            item.value === IB
                              ? (0, $.jsx)(Ci, { className: "size-4 shrink-0" })
                              : item.value === T3_NO_PROJECT_VAL
                                ? (0, $.jsx)(T3CloseXIcon, {})
                                : entry
                                  ? (0, $.jsx)(yb, { project: entry.group, className: "size-4 shrink-0" })
                                  : null,
                            (0, $.jsx)("span", {
                              className: "min-w-0 flex-1 truncate text-sm",
                              children: (0, $.jsx)(MB, { value: item.label })
                            }),
                            entry && canPinProjectGroup(entry.group)
                              ? (0, $.jsx)(B_, {
                                  name: entry.group.displayName,
                                  pinned: entry.group.pinned,
                                  shortcutLabel: Qm(keybindings, "thread.pin"),
                                  onToggle: () => toggleProjectGroupPin(entry.group)
                                })
                              : null,
                            entry && multiMachine
                              ? (0, $.jsx)(Rb, {
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
            ? (0, $.jsxs)("div", {
                className: "t3e-nc-rel",
                ref: moreMenuRef,
                children: [
                  (0, $.jsx)("button", {
                    type: "button",
                    className: Cr("t3e-nc-more-btn", moreOpen && "is-open"),
                    ref: moreTriggerRef,
                    "aria-label": moreTitle,
                    "aria-expanded": moreOpen,
                    title: moreTitle,
                    onClick: () => setMoreOpen((v) => !v),
                    children: (0, $.jsx)(T3DotsIcon, {})
                  }),
                  moreOpen
                    ? (0, $.jsxs)("div", {
                        className: "t3e-nc-popover t3e-nc-more-pop",
                        role: "dialog",
                        "aria-label": moreTitle,
                        "data-t3e-more-popover": "true",
                        children: [
                          (0, $.jsx)("div", { className: "t3e-nc-pop-title", children: moreTitle }),
                          (0, $.jsxs)("div", {
                            className: "t3e-nc-more-row",
                            onClick: () => {
                              if (!worktreeDisabled && typeof onEnvModeChange === "function") {
                                onEnvModeChange(isWorktreeOn ? "local" : "worktree");
                              }
                            },
                            children: [
                              (0, $.jsxs)("span", {
                                className: "t3e-nc-more-label",
                                children: [
                                  (0, $.jsx)(T3WorktreeIcon, {}),
                                  (0, $.jsx)("span", { className: "t3e-nc-trunc", children: newWorktreeLabel })
                                ]
                              }),
                              (0, $.jsx)("button", {
                                type: "button",
                                role: "switch",
                                "aria-label": newWorktreeLabel,
                                "aria-checked": isWorktreeOn,
                                disabled: worktreeDisabled,
                                className: Cr("t3e-nc-switch", isWorktreeOn && "is-on"),
                                onClick: (ev) => {
                                  ev.stopPropagation();
                                  if (!worktreeDisabled && typeof onEnvModeChange === "function") {
                                    onEnvModeChange(isWorktreeOn ? "local" : "worktree");
                                  }
                                },
                                children: (0, $.jsx)("span", { className: "t3e-nc-switch-thumb" })
                              })
                            ]
                          }),
                          (0, $.jsxs)("div", {
                            className: "t3e-nc-more-row t3e-nc-branch-row",
                            onClick: (ev) => {
                              if (!ev.currentTarget.contains(ev.target) || ev.target.closest?.("button")) return;
                              branchPickerRef.current?.querySelector("button")?.click();
                            },
                            children: [
                              (0, $.jsxs)("span", {
                                className: "t3e-nc-more-label",
                                children: [
                                  (0, $.jsx)(T3BranchIcon, {}),
                                  (0, $.jsx)("span", { children: branchLabel })
                                ]
                              }),
                              (0, $.jsxs)("div", {
                                className: "t3e-nc-branch-picker",
                                ref: branchPickerRef,
                                children: [
                                  (0, $.jsx)(dP, {
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
                                  (0, $.jsx)("span", {
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

function apply(source) {
  assert(
    source.includes(lAndRAnchor) && source.indexOf(lAndRAnchor) === source.lastIndexOf(lAndRAnchor),
    "Could not uniquely locate L_/R_ new-session layout anchor in _chat bundle"
  );
  assert(
    source.includes(avOverlayAnchor) && source.indexOf(avOverlayAnchor) === source.lastIndexOf(avOverlayAnchor),
    "Could not uniquely locate av composer overlay anchor in _chat bundle"
  );
  assert(
    source.includes(hpTrailingPermAnchor) && source.indexOf(hpTrailingPermAnchor) === source.lastIndexOf(hpTrailingPermAnchor),
    "Could not uniquely locate HP trailing sF permissions anchor in _chat bundle"
  );
  assert(
    source.includes(noticeBelowAnchor) && source.indexOf(noticeBelowAnchor) === source.lastIndexOf(noticeBelowAnchor),
    "Could not uniquely locate detached notice below-composer anchor in _chat bundle"
  );

  const lAndRReplacement =
    "let L_=Sl?`pointer-events-none absolute inset-0 z-20 flex flex-col justify-between`:`pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2`," +
    "R_=Sl?(0,$.jsx)(T3NewChatTray,{" +
    "draftId:y,activeProjectRef:Xa,activeProjectTitle:Za?.title??null," +
    "environmentId:Wr?.environmentId??i,threadId:Wr?.id??null,worktreePath:Wr?.worktreePath??null," +
    "isServerThread:Ur,showGitControls:wu,forceNewWorktree:br!==null," +
    "envMode:Sp,onEnvModeChange:Kh,startFromOrigin:Dp,onStartFromOriginChange:Jh,envLocked:os," +
    "...vp?{activeThreadBranchOverride:wp,onActiveThreadBranchOverrideChange:xp}:{}," +
    "...Bi?{onCheckoutPullRequestRequest:Bo}:{}," +
    "onComposerFocusRequest:ld,availableEnvironments:Ao," +
    "...ss?{onEnvironmentChange:sd}:{}," +
    "autoEnvironmentLabel:rd," +
    "onAutoEnvironment:y&&!os&&Mo&&cs.loadBalancingEnabled?nd:void 0" +
    "}):null";

  const avOverlayReplacement =
    'av=(0,$.jsxs)(`div`,{...F_,ref:I_,inert:wn,"data-chat-composer-overlay":`true`,"data-t3e-new-chat-layout":Sl?`true`:void 0,className:L_,children:[Sl?(0,$.jsx)(T3NewChatHero,{activeProjectRef:Xa,activeProjectTitle:Za?.title??null}):null,iv]})';

  const noticeAboveReplacement =
    "$_=Sl&&lh.length>0?(0,$.jsx)(`div`,{className:`mb-2.5 flex flex-col gap-1.5`,children:(0,$.jsx)(QF,{items:lh,detached:!0})}):null,t[669]=lh,t[670]=Sl,t[671]=$_):$_=t[671];let ev;t[672]!==Z_?(ev=(0,$.jsx)(`div`,{className:`relative`,children:Z_}),t[672]=Z_,t[674]=ev):ev=t[674];let tv;t[675]===Symbol.for(`react.memo_cache_sentinel`)?(tv=(0,$.jsx)(`div`,{\"aria-hidden\":!0,className:`h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]`}),t[675]=tv):tv=t[675];let nv;t[676]!==wl||t[677]!==z_||t[678]!==B_||t[679]!==ev?(nv=(0,$.jsxs)(`div`,{ref:wl,className:`relative z-10`,style:z_,children:[B_,ev,tv]}),t[676]=wl,t[677]=z_,t[678]=B_,t[679]=ev,t[680]=nv):nv=t[680];let rv;t[681]!==R_||t[682]!==nv||t[673]!==$_?(rv=(0,$.jsxs)(`div`,{\"data-chat-composer-stack\":`true`,className:`group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)`,children:[$_,R_,nv]}),t[681]=R_,t[682]=nv,t[673]=$_,t[683]=rv):rv=t[683];";

  const hasUsageRings = source.includes("T3_USAGE_RINGS_");
  let patched = source
    .replace(lAndRAnchor, lAndRReplacement)
    .replace(avOverlayAnchor, avOverlayReplacement)
    .replace(noticeBelowAnchor, noticeAboveReplacement);
  if (hasUsageRings) {
    patched = patched.replace(hpTrailingPermAnchor, "...Ur?{}:{trailing:null}");
  }

  patched = patched.replace(/\n?\/\/# sourceMappingURL=.*$/m, "") + "\n" + buildInjectedComponents() + "\n";
  return patched;
}

module.exports = {
  id: ID,
  name: "新建对话 ChatGPT 吸底布局与环境/项目/分支托盘",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  apply,
};

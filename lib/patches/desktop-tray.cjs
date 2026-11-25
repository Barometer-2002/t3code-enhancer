"use strict";

const assert = require("node:assert/strict");

const ID = "desktop-tray";
const MARKER = "T3_DESKTOP_TRAY_V1";
const LEGACY_MARKERS = [];
const TARGET_REGEX = /^apps\/desktop\/dist-electron\/main\.cjs$/;
const ORIGINAL_HASH = "873697d72e3daf3388b16ff8b0ca68bb2cbe15327005b8404b755b53228ebcc6";

function replaceOnce(text, target, replacement) {
  const index = text.indexOf(target);
  assert(index >= 0, `Could not find target snippet in desktop main bundle: ${target.slice(0, 80)}`);
  assert.equal(text.indexOf(target, index + target.length), -1, `Target snippet was not unique in desktop main bundle: ${target.slice(0, 80)}`);
  return text.slice(0, index) + replacement + text.slice(index + target.length);
}

function trayRuntimeHelpers() {
  return `
/* ${MARKER} */
const T3_TRAY_SETTINGS_FILE = "enhancer-tray.json";
const T3TrayState = {
  tray: null,
  hooks: null,
  closeToTray: true,
  quitting: false,
  failed: false,
};

function t3TraySettingsPath(stateDir) {
  return node_path.join(stateDir, T3_TRAY_SETTINGS_FILE);
}

function t3ReadCloseToTray(stateDir) {
  if (!stateDir) return true;
  try {
    const raw = node_fs.readFileSync(t3TraySettingsPath(stateDir), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.closeToTray === "boolean") return parsed.closeToTray;
  } catch {}
  return true;
}

function t3WriteCloseToTray(stateDir, enabled) {
  if (!stateDir) return;
  try {
    node_fs.mkdirSync(stateDir, { recursive: true });
    node_fs.writeFileSync(t3TraySettingsPath(stateDir), JSON.stringify({ closeToTray: Boolean(enabled) }, null, 2) + "\\n", "utf8");
  } catch {}
}

function t3TrayLocaleTag() {
  const active = typeof activeLocale === "string" ? activeLocale.trim() : "";
  if (active && active !== "en") return active;
  if (active === "en") {
    try {
      const langs = electron.app.getPreferredSystemLanguages?.() || [];
      if (langs[0] && /^zh\\b/i.test(String(langs[0]))) return active;
    } catch {}
    return "en";
  }
  try {
    const langs = electron.app.getPreferredSystemLanguages?.() || [];
    return langs[0] ? String(langs[0]) : "en";
  } catch {
    return "en";
  }
}

function t3TrayLabels(displayName) {
  const tag = t3TrayLocaleTag().toLowerCase();
  if (tag.startsWith("zh")) {
    if (tag.includes("tw") || tag.includes("hk") || tag.includes("hant")) {
      return {
        open: "開啟主視窗",
        hide: "隱藏到系統匣",
        closeToTray: "關閉視窗時隱藏到系統匣",
        settings: "設定...",
        quit: \`退出 \${displayName}\`,
      };
    }
    return {
      open: "打开主窗口",
      hide: "隐藏到托盘",
      closeToTray: "关闭窗口时最小化到托盘",
      settings: "设置...",
      quit: \`退出 \${displayName}\`,
    };
  }
  return {
    open: "Open Window",
    hide: "Hide to Tray",
    closeToTray: "Hide to tray on close",
    settings: "Settings...",
    quit: \`Quit \${displayName}\`,
  };
}

function t3UnwrapOption(opt) {
  return opt && opt._tag === "Some" && typeof opt.value === "string" ? opt.value : null;
}

function t3ResolveTrayImage(hooks) {
  const iconPaths = hooks?.iconPaths || {};
  const platform = hooks?.environment?.platform || process.platform;
  const candidates = platform === "win32"
    ? [t3UnwrapOption(iconPaths.ico), t3UnwrapOption(iconPaths.png)]
    : [t3UnwrapOption(iconPaths.png), t3UnwrapOption(iconPaths.ico)];
  const fallback = platform === "win32"
    ? node_path.join(__dirname, "../prod-resources/icon.ico")
    : node_path.join(__dirname, "../prod-resources/icon.png");
  if (!candidates.includes(fallback)) candidates.push(fallback);
  for (const filePath of candidates) {
    if (!filePath) continue;
    try {
      let image = electron.nativeImage.createFromPath(filePath);
      if (image && !image.isEmpty()) {
        if (platform === "darwin") image = image.resize({ width: 18, height: 18 });
        else if (platform === "linux") {
          const size = image.getSize();
          if (size.width > 32 || size.height > 32) image = image.resize({ width: 22, height: 22 });
        }
        return image;
      }
    } catch {}
  }
  return null;
}

function t3HasLiveTray() {
  if (!T3TrayState.tray) return false;
  try {
    return typeof T3TrayState.tray.isDestroyed === "function" ? !T3TrayState.tray.isDestroyed() : true;
  } catch {
    return false;
  }
}

function t3RegisterTrayHooks(hooks) {
  T3TrayState.hooks = hooks;
  T3TrayState.closeToTray = t3ReadCloseToTray(hooks?.environment?.stateDir);
  t3RefreshTrayMenu();
}

function t3BeginTrayQuit() {
  T3TrayState.quitting = true;
}

function t3ShouldHideToTrayOnClose(win) {
  if (T3TrayState.quitting || !T3TrayState.closeToTray) return false;
  if (!win || win.isDestroyed()) return false;
  return t3HasLiveTray();
}

function t3HideWindowToTray(win) {
  if (!win || win.isDestroyed() || T3TrayState.quitting) return;
  const platform = T3TrayState.hooks?.environment?.platform || process.platform;
  if (platform === "darwin" && win.isFullScreen?.()) {
    win.once("leave-full-screen", () => {
      if (!win.isDestroyed() && !T3TrayState.quitting) {
        win.hide();
        t3RefreshTrayMenu();
      }
    });
    win.setFullScreen(false);
    return;
  }
  win.hide();
  t3RefreshTrayMenu();
}

function t3BuildTrayMenuTemplate() {
  const hooks = T3TrayState.hooks;
  const displayName = hooks?.environment?.displayName || "T3 Code";
  const labels = t3TrayLabels(displayName);
  const win = hooks?.getMainWindow?.() || null;
  const canHide = Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
  return [
    {
      label: labels.open,
      click: () => hooks?.showMainWindow?.(),
    },
    {
      label: labels.hide,
      enabled: canHide,
      click: () => {
        const target = hooks?.getMainWindow?.();
        if (target && !target.isDestroyed()) {
          hooks?.flushBounds?.();
          t3HideWindowToTray(target);
        }
      },
    },
    { type: "separator" },
    {
      label: labels.closeToTray,
      type: "checkbox",
      checked: T3TrayState.closeToTray,
      click: (menuItem) => {
        const next = typeof menuItem?.checked === "boolean" ? menuItem.checked : !T3TrayState.closeToTray;
        T3TrayState.closeToTray = next;
        t3WriteCloseToTray(hooks?.environment?.stateDir, next);
        t3RefreshTrayMenu();
      },
    },
    {
      label: labels.settings,
      click: () => hooks?.openSettings?.(),
    },
    { type: "separator" },
    {
      label: labels.quit,
      click: () => hooks?.quitApp?.(),
    },
  ];
}

function t3RefreshTrayMenu() {
  if (!t3HasLiveTray()) return;
  try {
    const displayName = T3TrayState.hooks?.environment?.displayName || "T3 Code";
    T3TrayState.tray.setToolTip(displayName);
    T3TrayState.tray.setContextMenu(electron.Menu.buildFromTemplate(t3BuildTrayMenuTemplate()));
  } catch {}
}

function t3EnsureTray() {
  if (T3TrayState.quitting || T3TrayState.failed || !T3TrayState.hooks) return null;
  if (t3HasLiveTray()) {
    t3RefreshTrayMenu();
    return T3TrayState.tray;
  }
  const image = t3ResolveTrayImage(T3TrayState.hooks);
  if (!image) {
    T3TrayState.failed = true;
    return null;
  }
  try {
    const tray = new electron.Tray(image);
    T3TrayState.tray = tray;
    if ((T3TrayState.hooks.environment?.platform || process.platform) !== "darwin") {
      tray.on("click", () => {
        T3TrayState.hooks?.showMainWindow?.();
      });
    }
    t3RefreshTrayMenu();
    return tray;
  } catch {
    T3TrayState.failed = true;
    T3TrayState.tray = null;
    return null;
  }
}

function t3DisposeTray() {
  const tray = T3TrayState.tray;
  T3TrayState.tray = null;
  if (!tray) return;
  try {
    if (typeof tray.isDestroyed !== "function" || !tray.isDestroyed()) tray.destroy();
  } catch {}
}
`;
}

function apply(source) {
  let patched = replaceOnce(
    source,
    "const backendReadyRef = yield* make$91(false);\n\tlet backendHasStarted = false;\n\tlet mainClosedDuringStartup = false;\n\tconst splashWindowRef = yield* make$91(none$1());\n\tconst context = yield* context$1();\n\tconst runFork = runForkWith(context);\n\tconst runPromise = runPromiseWith(context);",
    "const backendReadyRef = yield* make$91(false);\n\tlet backendHasStarted = false;\n\tlet mainClosedDuringStartup = false;\n\tconst splashWindowRef = yield* make$91(none$1());\n\tconst context = yield* context$1();\n\tconst runFork = runForkWith(context);\n\tconst runPromise = runPromiseWith(context);\n\tconst t3InitialIconPaths = yield* assets.iconPaths;\n\tlet t3MainWindowRef = null;"
  );

  patched = replaceOnce(
    patched,
    'yield* rendererHistory.register(window.webContents, { surface: "main" });',
    't3MainWindowRef = window;\n\t\tyield* rendererHistory.register(window.webContents, { surface: "main" });'
  );

  patched = replaceOnce(
    patched,
    'window.on("close", () => {\n\t\t\trunFork(flushBoundsPersist);\n\t\t});',
    'window.on("show", t3RefreshTrayMenu);\n\t\twindow.on("hide", t3RefreshTrayMenu);\n\t\twindow.on("minimize", t3RefreshTrayMenu);\n\t\twindow.on("restore", t3RefreshTrayMenu);\n\t\twindow.on("close", (event) => {\n\t\t\trunFork(flushBoundsPersist);\n\t\t\tif (t3ShouldHideToTrayOnClose(window)) {\n\t\t\t\tevent.preventDefault();\n\t\t\t\tt3HideWindowToTray(window);\n\t\t\t}\n\t\t});'
  );

  patched = replaceOnce(
    patched,
    'window.on("closed", () => {\n\t\t\tif (!backendHasStarted) mainClosedDuringStartup = true;',
    'window.on("closed", () => {\n\t\t\tif (t3MainWindowRef === window) t3MainWindowRef = null;\n\t\t\tt3RefreshTrayMenu();\n\t\t\tif (!backendHasStarted) mainClosedDuringStartup = true;'
  );

  patched = replaceOnce(
    patched,
    "\treturn DesktopWindow.of({\n\t\tcreateMain:",
    `\tt3RegisterTrayHooks({\n\t\tenvironment,\n\t\ticonPaths: t3InitialIconPaths,\n\t\tgetMainWindow: () => t3MainWindowRef && !t3MainWindowRef.isDestroyed() ? t3MainWindowRef : null,\n\t\tflushBounds: () => runFork(flushBoundsPersist),\n\t\tshowMainWindow: () => runPromise(gen(function* () {\n\t\t\tif (yield* get$5(desktopState.quitting)) return;\n\t\t\tconst existing = yield* currentMainWindow;\n\t\t\tif (isSome(existing) && !existing.value.isDestroyed()) {\n\t\t\t\tconst win = existing.value;\n\t\t\t\tif (pendingMainReveals.has(win)) yield* revealMain(win);\n\t\t\t\telse {\n\t\t\t\t\tif (win.isMinimized()) win.restore();\n\t\t\t\t\tif (!win.isVisible()) win.show();\n\t\t\t\t\tif (environment.platform === "win32") win.moveTop();\n\t\t\t\t\tif (environment.platform === "darwin") electron.app.focus({ steal: true });\n\t\t\t\t\telse electron.app.focus();\n\t\t\t\t\twin.focus();\n\t\t\t\t}\n\t\t\t\tt3RefreshTrayMenu();\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tyield* revealOrCreateMain;\n\t\t\tt3RefreshTrayMenu();\n\t\t})),\n\t\topenSettings: () => runPromise(dispatchRendererEvent(MENU_ACTION_CHANNEL, "open-settings", { reveal: true })),\n\t\tquitApp: () => {\n\t\t\tt3BeginTrayQuit();\n\t\t\tt3DisposeTray();\n\t\t\trunPromise(electronApp.quit);\n\t\t},\n\t});\n\treturn DesktopWindow.of({\n\t\tcreateMain:`
  );

  patched = replaceOnce(
    patched,
    "yield* electronMenu.setApplicationMenu(template);",
    "yield* electronMenu.setApplicationMenu(template);\n\t\tt3EnsureTray();"
  );

  patched = replaceOnce(
    patched,
    'electronApp.on("before-quit", (event) => {\n\t\t\thandleBeforeQuit(event, runEffect, quit);',
    'electronApp.on("before-quit", (event) => {\n\t\t\tt3BeginTrayQuit();\n\t\t\tt3DisposeTray();\n\t\t\thandleBeforeQuit(event, runEffect, quit);'
  );

  patched = replaceOnce(
    patched,
    'electronApp.onBeforeQuitForUpdate(() => {\n\t\t\tquit.phase = "allowed";',
    'electronApp.onBeforeQuitForUpdate(() => {\n\t\t\tt3BeginTrayQuit();\n\t\t\tt3DisposeTray();\n\t\t\tquit.phase = "allowed";'
  );

  patched = replaceOnce(
    patched,
    "yield* set$2(state.quitting, true);\n\t\t\tyield* requestDesktopShutdownAndWait();",
    "t3BeginTrayQuit();\n\t\t\tt3DisposeTray();\n\t\t\tyield* set$2(state.quitting, true);\n\t\t\tyield* requestDesktopShutdownAndWait();"
  );

  patched = replaceOnce(
    patched,
    'yield* addFinalizer(() => stopAllPoolInstances().pipe(ensuring$2(rendererHistory.shutdown), ensuring$2(shutdown.markComplete), withSpan$2("desktop.app.shutdown")));',
    'yield* addFinalizer(() => sync(() => { t3BeginTrayQuit(); t3DisposeTray(); }).pipe(andThen(stopAllPoolInstances()), ensuring$2(rendererHistory.shutdown), ensuring$2(shutdown.markComplete), withSpan$2("desktop.app.shutdown")));'
  );

  return patched.replace(/\n?\/\/# sourceMappingURL=.*$/m, "") + "\n" + trayRuntimeHelpers();
}

module.exports = {
  id: ID,
  name: "后台系统托盘（关闭主窗口最小化到托盘，托盘唤醒与彻底退出）",
  marker: MARKER,
  legacyMarkers: LEGACY_MARKERS,
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  apply,
  trayRuntimeHelpers,
};

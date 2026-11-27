#!/usr/bin/env node
"use strict";

// Note: Adapted from original macOS PR (0b8cc00) for current multi-pack / no-telemetry / upgrade / repair support.
// Verified on Apple Silicon (macOS 27, T3 Code 0.1.12); helper logic is also covered by cross-platform unit tests in tests/verify.cjs.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ALL_PATCHES,
  matchesSelectedPatches,
  inferRepairPlanOptions,
  applicablePatchesForArchive,
  inspectArchive,
  summarizeModuleStates,
  buildPatchedArchive,
} = require("./lib/engine.cjs");
const { digest, readAsar } = require("./lib/asar.cjs");
const { withInstallDirectoryLock, recoverPreviousInstall, replaceStagedInstall, cleanupStagingDirectories } = require("./lib/install-state.cjs");
const {
  resolveInstallPlan,
  parsePlatformArgs,
  promptInteractiveAction,
} = require("./lib/packs.cjs");
const {
  getThemeStatus,
  getUserdataDir: resolveUserdataDir,
  prepareProfileAt,
  formatThemeStatusText,
  uninstallTheme,
  reportThemeUninstall,
} = require("./lib/theme-manager.cjs");
const { ENHANCER_TAG, T3_BASELINE_VERSION } = require("./lib/version.cjs");

const T3_VERSION = T3_BASELINE_VERSION;
const T3_TEAM_ID = "ARK85ZXQ4Z";
const DEFAULT_SOURCE = "/Applications/T3 Code (Beta).app";
const BUNDLE_ID = "com.t3tools.t3code.enhancer";
const DISPLAY_NAME = "T3 Code Enhancer";
const PROFILE_NAME = "t3code-enhancer-profile";
const APP_ASAR = path.join("Contents", "Resources", "app.asar");
const INFO_PLIST = path.join("Contents", "Info.plist");

// macOS 上 Electron userData 固定为 ~/Library/Application Support/t3code-v2，没有环境变量可改。
// 移到独立配置目录后，增强版拥有自己的单实例锁，可以和官方版同时运行。
const userDataPatch = {
  id: "macos-user-data",
  name: "独立 Electron 用户数据目录",
  scope: "desktop",
  marker: `"${PROFILE_NAME}/electron"`,
  legacyMarkers: [],
  targetRegex: /^apps\/desktop\/dist-electron\/main\.cjs$/,
  targetSpec: {
    pathRegex: /^apps\/desktop\/dist-electron\/main\.cjs$/,
    includes: ['current: "t3code-v2",'],
  },
  originalHash: "3767e3a14ef66756b8e404e11a2a472bb22c1993f710b932653f24bd29f50cdd",
  apply(text) {
    const anchor = 'current: "t3code-v2",';
    assert.equal(text.split(anchor).length, 2, "无法唯一定位 userData 目录名");
    return text.replace(anchor, () => `current: "${PROFILE_NAME}/electron",`);
  },
};
const PATCHES = [...ALL_PATCHES, userDataPatch];

function getMacosPaths(homedir = os.homedir()) {
  const applicationsDirectory = path.join(homedir, "Applications");
  return {
    applicationsDirectory,
    installDirectory: path.join(applicationsDirectory, `${DISPLAY_NAME}.app`),
    installLock: path.join(applicationsDirectory, ".t3code-enhancer-install.lock"),
    previousApp: path.join(applicationsDirectory, ".t3code-enhancer-previous.app"),
    profileDirectory: path.join(homedir, "Library", "Application Support", PROFILE_NAME),
    sharedUserdata: path.join(homedir, ".t3", "userdata"),
  };
}

function getUserdataDir(sharedData, paths = getMacosPaths()) {
  return resolveUserdataDir(sharedData, paths.profileDirectory, paths.sharedUserdata);
}

function readPlist(app, key, format = "raw") {
  const output = execFileSync("plutil", ["-extract", key, format, "-o", "-", path.join(app, INFO_PLIST)], { encoding: "utf8" });
  return format === "json" ? JSON.parse(output) : output.trim();
}

function readOptionalPlist(app, key, format = "raw", fallback = undefined) {
  try {
    return readPlist(app, key, format);
  } catch {
    return fallback;
  }
}

function writePlist(app, key, value) {
  const plistPath = path.join(app, INFO_PLIST);
  if (typeof value === "string") {
    execFileSync("plutil", ["-replace", key, "-string", value, plistPath]);
    return;
  }
  execFileSync("plutil", ["-replace", key, "-json", JSON.stringify(value), plistPath]);
}

function isManagedInstall(app) {
  const stat = fs.lstatSync(app, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || !fs.existsSync(path.join(app, INFO_PLIST))) return false;
  const version = readOptionalPlist(app, "CFBundleShortVersionString");
  return readOptionalPlist(app, "CFBundleIdentifier") === BUNDLE_ID
    && (version === T3_VERSION || (typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)));
}

// --shared-data 安装不设置 T3CODE_HOME，和官方版一样使用 ~/.t3。
function usesSharedData(app) {
  const env = readOptionalPlist(app, "LSEnvironment", "json", null);
  return env && typeof env === "object" && !Array.isArray(env) ? !("T3CODE_HOME" in env) : false;
}

function isRunning(paths = getMacosPaths(), options = {}) {
  const allowMissing = options.allowMissing === true;
  if (!fs.existsSync(paths.installDirectory)) return false;
  // 按可执行文件的 inode 查找进程；命令行里的路径写法取决于启动方式，符号链接下不可靠。
  const execName = readOptionalPlist(paths.installDirectory, "CFBundleExecutable");
  if (!execName) {
    if (allowMissing) return false;
    assert(execName, `无法读取增强版可执行文件名：${paths.installDirectory}`);
  }
  const executable = path.join(paths.installDirectory, "Contents", "MacOS", execName);
  // 文件不存在时 lsof 同样返回 1，必须先排除，否则会误判为未运行。
  if (!fs.existsSync(executable)) {
    if (allowMissing) return false;
    assert(fs.existsSync(executable), `找不到增强版的可执行文件，无法判断是否在运行：${executable}`);
  }
  try {
    return execFileSync("lsof", ["-w", "-t", executable], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() !== "";
  } catch (error) {
    if (error.status === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return false;
    throw error;
  }
}

function verifyOfficialSignature(app) {
  try {
    execFileSync("codesign", [
      "--verify", "--deep", "--strict",
      "--test-requirement", `=anchor apple generic and certificate leaf[subject.OU] = "${T3_TEAM_ID}"`,
      app,
    ], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    throw new Error(`官方签名校验失败，请重新安装官方 T3 Code ${T3_VERSION}：${error.stderr?.toString().trim()}`);
  }
}

function prepareProfile(sharedData, options = {}, paths = getMacosPaths()) {
  return prepareProfileAt(getUserdataDir(sharedData, paths), options);
}

function buildInfoPlistEnv(existingEnv = {}, sharedData = false, paths = getMacosPaths(), options = {}) {
  const next = {};
  if (existingEnv && typeof existingEnv === "object" && !Array.isArray(existingEnv)) {
    for (const [k, v] of Object.entries(existingEnv)) {
      if (typeof v === "string") next[k] = v;
    }
  }
  if (sharedData) {
    delete next.T3CODE_HOME;
    delete next.T3CODE_PORT;
  } else {
    next.T3CODE_HOME = path.join(paths.profileDirectory, "t3-home");
    next.T3CODE_PORT = "3774";
  }
  next.T3CODE_DISABLE_AUTO_UPDATE = "1";
  if (options.disableTelemetry !== false) {
    next.T3CODE_TELEMETRY_ENABLED = "false";
    next.T3CODE_OTEL_SDK_DISABLED = "true";
  } else {
    delete next.T3CODE_TELEMETRY_ENABLED;
    delete next.T3CODE_OTEL_SDK_DISABLED;
  }
  return next;
}

function selectMacosPatches(plan, sharedData) {
  return sharedData ? plan.selectedPatches : [...plan.selectedPatches, userDataPatch];
}

function inspectMacosModules(asarPath, sharedData) {
  const expectedPatches = sharedData ? ALL_PATCHES : PATCHES;
  const { modules, appVersion, buildMeta } = inspectArchive(asarPath, expectedPatches);
  const summary = summarizeModuleStates(modules);
  assert(
    summary.allRecognized && (summary.hasKnownEnhancement || summary.allPristine),
    "安装目录中的补丁不完整或无法识别"
  );
  return { modules, summary, appVersion, buildMeta };
}

function inspectInstall(paths = getMacosPaths()) {
  const { installDirectory } = paths;
  if (!fs.lstatSync(installDirectory, { throwIfNoEntry: false })) return null;
  assert(isManagedInstall(installDirectory), `安装位置已被其他应用占用：${installDirectory}`);
  const sharedData = usesSharedData(installDirectory);
  const { modules, summary, appVersion, buildMeta } = inspectMacosModules(path.join(installDirectory, APP_ASAR), sharedData);
  const currentEnv = readOptionalPlist(installDirectory, "LSEnvironment", "json", {});
  const themeStatus = getThemeStatus(getUserdataDir(sharedData, paths));
  return { sharedData, modules, summary, currentEnv, themeStatus, appVersion, buildMeta };
}

function status(existing, paths = getMacosPaths()) {
  const { installDirectory, previousApp, profileDirectory } = paths;
  if (existing === undefined) {
    try {
      existing = inspectInstall(paths);
    } catch (err) {
      if (isManagedInstall(installDirectory)) {
        console.log(`检测到受管理的 macOS 安装 (${installDirectory})，当前包无法直接识别（${err.message.split("\n")[0]}）。`);
        console.log("若之前安装自更早版本（如 v0.1.1 的 0.1.11），请退出应用后运行 install（使用新版官方 T3 Code .app）升级，或运行 repair 修复。");
        return;
      }
      throw err;
    }
  }
  if (!existing) {
    console.log(fs.lstatSync(previousApp, { throwIfNoEntry: false })
      ? `上次升级未完成，旧应用仍保存在 ${previousApp}。运行 node macos.cjs repair 可恢复。`
      : "macOS 增强版尚未安装。");
    return;
  }
  const installedList = existing.modules.filter((m) => m.installed).map((m) => m.id);
  const versionStr = existing.appVersion ? `v${existing.appVersion}` : `v${T3_VERSION}`;
  const compatTier = existing.summary.autoAdapted
    ? "跨版本自动适配 (auto-adapted)"
    : existing.summary.allRecognized
      ? "已验证 (verified)"
      : "不兼容 (incompatible)";
  console.log(`T3 Code ${versionStr} macOS 增强版已安装 (t3code-enhancer ${ENHANCER_TAG}) [兼容性: ${compatTier}]，${isRunning(paths, { allowMissing: true }) ? "运行中" : "未运行"}。`);
  console.log(
    existing.summary.allInstalled
      ? "补丁：已是最新版（全部模块）。"
      : existing.summary.outdated
        ? "补丁：已安装旧版。退出增强版后重新运行 node macos.cjs install 升级。"
        : installedList.length > 0
          ? `补丁：已按模块安装（${installedList.join(", ")}）。`
          : "补丁：当前为纯净原版 ASAR（仅主题或待打补丁）。"
  );
  console.log("主题：", formatThemeStatusText(existing.themeStatus));
  console.log(`启动：open "${installDirectory}"`);
  console.log(existing.sharedData ? "数据：与官方版共用 ~/.t3，两者不能同时运行" : `独立配置：${profileDirectory}`);
  if (existing.summary.outdated) {
    console.log("\n待更新模块：");
    for (const m of existing.modules.filter((mod) => !mod.installed)) {
      console.log(`  - [${m.outdated ? "↑" : " "}] ${m.id} (${m.name})`);
    }
  }
}

function withInstallLock(operation, paths = getMacosPaths()) {
  const { installDirectory, installLock, previousApp } = paths;
  return withInstallDirectoryLock(installLock, () => {
    recoverPreviousInstall(installDirectory, previousApp, isManagedInstall, () => inspectInstall(paths));
    return operation();
  });
}

function envNeedsUpdate(currentEnv, expectedEnv) {
  const a = currentEnv && typeof currentEnv === "object" && !Array.isArray(currentEnv) ? currentEnv : {};
  const b = expectedEnv || {};
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return true;
  return ka.some((k) => !Object.prototype.hasOwnProperty.call(b, k) || a[k] !== b[k]);
}

function install(input, options = {}, paths = getMacosPaths()) {
  const flags = options.flags || new Set();
  const plan = resolveInstallPlan(ALL_PATCHES, {
    preset: options.preset || null,
    packs: options.packs || null,
    flags,
    excludePatchIds: options.excludePatchIds || [],
    exactPatchIds: options.exactPatchIds || null,
  });
  const requestedSharedData = flags.has("--shared-data") || options.sharedData === true;
  if (plan.needsLayer3Warning) {
    console.log("[提示] --official 仅安装 Layer 1 官方样式层，部分功能补丁的视觉样式可能不完整；纯官方主题建议配合 --preset theme-only 或 --preset clean 使用。");
  }

  if (plan.themeOnly) return withInstallLock(() => {
    let existing = null;
    try { existing = inspectInstall(paths); } catch {}
    const dirExists = Boolean(fs.lstatSync(paths.installDirectory, { throwIfNoEntry: false }));
    const sharedData = existing
      ? existing.sharedData
      : dirExists
        ? usesSharedData(paths.installDirectory)
        : requestedSharedData;
    assert(!requestedSharedData || sharedData, "当前为独立配置模式，无需 --shared-data（如需切换请先卸载）");
    const res = prepareProfile(sharedData, { officialOnly: plan.officialOnly }, paths);
    console.log(`[主题] 已安装 chatgpt-app 主题（${plan.officialOnly ? "仅官方稳定层 Layer 1" : "完整分层主题 Layer 1-3"}） -> ${res.targetPath}`);
    // 没有增强版副本时，卸载无法推断共用目录，必须显式带上 --shared-data。
    if (sharedData && !dirExists) console.log("[提示] 卸载此主题：node macos.cjs uninstall --theme-only --shared-data");
  }, paths);

  return withInstallLock(() => {
    if (options.repair) cleanupStagingDirectories(paths.applicationsDirectory);
    let existing = null;
    let existingCorrupt = false;
    try {
      existing = inspectInstall(paths);
    } catch (err) {
      if ((options.repair || input || fs.existsSync(DEFAULT_SOURCE)) && isManagedInstall(paths.installDirectory)) {
        existingCorrupt = true;
      } else {
        throw err;
      }
    }

    const sharedData = existing
      ? existing.sharedData
      : existingCorrupt
        ? usesSharedData(paths.installDirectory)
        : requestedSharedData;
    assert(!requestedSharedData || sharedData, "切换为共用数据模式前，请先卸载增强版");
    const selectedPatches = selectMacosPatches(plan, sharedData);

    const expectedEnv = buildInfoPlistEnv(existing?.currentEnv, sharedData, paths, { disableTelemetry: plan.telemetryDisabled });
    if (
      existing && !input && !options.repair &&
      matchesSelectedPatches(existing.modules, selectedPatches) &&
      !envNeedsUpdate(existing.currentEnv, expectedEnv)
    ) {
      if (plan.includeTheme) {
        prepareProfile(sharedData, { officialOnly: plan.officialOnly }, paths);
      }
      return status(inspectInstall(paths), paths);
    }

    if (existing || existingCorrupt) {
      assert(!isRunning(paths, { allowMissing: existingCorrupt }), "请先退出 macOS 增强版，再运行升级或修复命令");
    }

    const source = path.resolve(input || DEFAULT_SOURCE);
    assert(fs.existsSync(source), `找不到官方 T3 Code 应用：${source}（请传入实际 .app 路径或使用 --app <路径>）`);
    assert(fs.existsSync(path.join(source, INFO_PLIST)), `无效的官方 T3 Code 应用（缺少 ${INFO_PLIST}）：${source}`);
    console.log("校验官方 T3 Code 的版本与签名…");
    const sourceVersion = readPlist(source, "CFBundleShortVersionString");
    assert(sourceVersion, `无法读取官方应用版本：${source}`);
    const staging = fs.mkdtempSync(path.join(paths.applicationsDirectory, ".t3code-enhancer-"));
    const themeTx = plan.includeTheme
      ? require("./lib/theme-manager.cjs").prepareThemeTransaction(getUserdataDir(sharedData, paths), {
          officialOnly: plan.officialOnly,
          createSettingsIfMissing: true,
        })
      : null;
    try {
      const app = path.join(staging, `${DISPLAY_NAME}.app`);
      execFileSync("ditto", [source, app]);
      // 校验复制出的副本，保证打补丁的正是官方签名覆盖的那份文件。
      verifyOfficialSignature(app);
      // ditto 会带上原版的下载隔离标记，ad-hoc 签名的副本带着它会被 Gatekeeper 拦截。
      const attributes = execFileSync("xattr", ["-r", app], { encoding: "utf8" });
      if (/(?:^|: )com\.apple\.quarantine$/m.test(attributes)) {
        execFileSync("xattr", ["-dr", "com.apple.quarantine", app]);
      }
      console.log("构建并校验补丁…");
      const target = path.join(app, APP_ASAR);
      const inspectedTarget = inspectArchive(target, selectedPatches);
      const targetSummary = summarizeModuleStates(inspectedTarget.modules);
      assert(targetSummary.allRecognized, `目标 ASAR 与补丁不兼容（版本 ${sourceVersion}），已中止安装。`);
      const compatTier = targetSummary.autoAdapted ? "跨版本自动适配 (auto-adapted)" : "已验证 (verified)";
      const detectedVer = inspectedTarget.appVersion || sourceVersion;
      console.log(`[兼容性] 检测到版本 v${detectedVer} · ${compatTier}`);
      const targetPatches = applicablePatchesForArchive(inspectedTarget.asar, selectedPatches);
      if (targetPatches.length > 0) {
        const patched = target + ".patched";
        const report = buildPatchedArchive(inspectedTarget.asar, targetPatches, patched, { plan });
        for (const r of report) {
          const tag = r.compat === "auto-adapted" ? " (跨版本自动适配)" : "";
          console.log(`  ✓ ${r.id} -> ${r.key}${tag}`);
        }
        fs.chmodSync(patched, fs.statSync(target).mode & 0o777);
        fs.renameSync(patched, target);
      }
      // Electron 的 ASAR 完整性值是头部 JSON 的 SHA-256。
      const { archive } = readAsar(target);
      writePlist(app, "ElectronAsarIntegrity", {
        "Resources/app.asar": { algorithm: "SHA256", hash: digest(archive.subarray(16, 16 + archive.readUInt32LE(12))) },
      });
      writePlist(app, "CFBundleIdentifier", BUNDLE_ID);
      writePlist(app, "CFBundleDisplayName", DISPLAY_NAME);
      writePlist(app, "LSEnvironment", buildInfoPlistEnv(
        readOptionalPlist(app, "LSEnvironment", "json", {}),
        sharedData,
        paths,
        { disableTelemetry: plan.telemetryDisabled }
      ));
      // 修改后官方签名失效，改用本机 ad-hoc 签名；不带官方 entitlements，其中部分需要官方描述文件。
      console.log("本机重新签名…");
      try {
        execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "pipe" });
        execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
      } catch (signErr) {
        const msg = signErr.stderr?.toString().trim() || signErr.message;
        throw new Error(`本机 ad-hoc 重签名或签名校验失败：${msg}`, { cause: signErr });
      }

      const replacing = Boolean(existing || existingCorrupt);
      if (replacing) {
        assert(!isRunning(paths, { allowMissing: existingCorrupt }), "请先退出 macOS 增强版，再运行升级或修复命令");
      }
      replaceStagedInstall(app, paths.installDirectory, replacing ? paths.previousApp : null, themeTx ? {
        afterCommit: () => {
          const res = themeTx.commit();
          if (!res.activated) {
            console.warn("[提示] 主题已写入，但未能自动激活：请检查设置文件后手动切换主题");
          }
        },
        onRollback: () => themeTx.rollback(),
      } : undefined);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return status(inspectInstall(paths), paths);
  }, paths);
}

function repair(input = DEFAULT_SOURCE, options = {}, paths = getMacosPaths()) {
  const flags = new Set(options.flags || []);
  let effectiveOptions = { ...options, flags, repair: true };
  if (!options.preset && !options.packs && !flags.has("--theme-only") && !flags.has("--patch-only")) {
    let existing = null;
    const installDirectory = fs.lstatSync(paths.installDirectory, { throwIfNoEntry: false })
      ? paths.installDirectory : paths.previousApp;
    try { existing = inspectInstall({ ...paths, installDirectory }); } catch {}
    if (existing) {
      const coreModules = existing.modules.filter((m) => m.id !== "macos-user-data");
      const inferred = inferRepairPlanOptions(
        coreModules,
        existing.themeStatus,
        flags,
        existing.buildMeta?.plan ? [existing.buildMeta.plan] : []
      );
      if (inferred.officialOnly) flags.add("--official");
      if (inferred.patchOnly) flags.add("--patch-only");
      effectiveOptions = {
        ...effectiveOptions,
        preset: inferred.preset ?? undefined,
        packs: inferred.packs ?? undefined,
        excludePatchIds: inferred.excludePatchIds,
        exactPatchIds: inferred.exactPatchIds,
      };
    }
  }
  console.log("[修复] 正在检查并修复 macOS 增强版应用、签名、环境变量与主题…");
  return install(input, effectiveOptions, paths);
}

function uninstall(flags = new Set(), paths = getMacosPaths()) {
  if (flags.has("--theme-only")) {
    if (flags.has("--keep-theme")) return;
    return withInstallDirectoryLock(paths.installLock, () => {
      const installed = [paths.installDirectory, paths.previousApp].find(isManagedInstall);
      const sharedData = installed ? usesSharedData(installed) : flags.has("--shared-data");
      reportThemeUninstall(getUserdataDir(sharedData, paths));
    });
  }
  return withInstallLock(() => {
    const { installDirectory, profileDirectory } = paths;
    const keepTheme = flags.has("--keep-theme");
    const purgeProfile = flags.has("--purge-profile");
    if (!fs.lstatSync(installDirectory, { throwIfNoEntry: false })) {
      cleanupStagingDirectories(paths.applicationsDirectory);
      if (purgeProfile && fs.existsSync(profileDirectory)) {
        fs.rmSync(profileDirectory, { recursive: true, force: true });
        console.log(`已清理独立配置目录：${profileDirectory}`);
      }
      return status(null, paths);
    }
    assert(isManagedInstall(installDirectory), `无法确认是本工具安装的应用：${installDirectory}`);
    assert(!isRunning(paths), "请先退出 macOS 增强版，再运行卸载命令");
    const sharedData = usesSharedData(installDirectory);
    if (!keepTheme) {
      uninstallTheme(getUserdataDir(sharedData, paths));
    }
    fs.rmSync(installDirectory, { recursive: true, force: true });
    cleanupStagingDirectories(paths.applicationsDirectory);
    if (purgeProfile && !sharedData && fs.existsSync(profileDirectory)) {
      fs.rmSync(profileDirectory, { recursive: true, force: true });
      console.log(`已卸载 macOS 增强版并彻底清理独立配置目录：${profileDirectory}`);
      return;
    }
    console.log(sharedData
      ? "已卸载 macOS 增强版。会话和项目仍在 ~/.t3，官方版可以继续使用"
      : `已卸载 macOS 增强版。独立配置和会话保存在 ${profileDirectory}`);
  }, paths);
}

function parseMacosArgs(argv) {
  return parsePlatformArgs(argv);
}

function printUsage() {
  console.log(`用法：
  node macos.cjs install [<T3 Code.app>] [--preset <id>] [--packs <a,b>] [--shared-data] [--official] [--interactive]
  node macos.cjs repair  [<T3 Code.app>] [--preset <id>] [--packs <a,b>] [--official]
  node macos.cjs status
  node macos.cjs uninstall [--theme-only] [--keep-theme] [--purge-profile]
  node macos.cjs --version

默认官方 App 路径：${DEFAULT_SOURCE}
可选预设 (--preset)：full（默认完整版）| chat-lite（轻量对话）| clean（主题+去遥测）| privacy-only（纯去遥测）| theme-only（纯主题）
可选模块 (--packs) ：theme, privacy, composer, chat, workspace`);
}

async function runMacosCli(argv) {
  const { command, input, extra, flags, preset, packs } = parseMacosArgs(argv);
  if (!command || flags.has("--help")) {
    printUsage();
    return;
  }
  if (command === "version" || flags.has("--version")) {
    console.log(require("./lib/version.cjs").formatVersionBanner());
    return;
  }
  assert(process.platform === "darwin", "仅支持 macOS");
  assert(process.getuid() !== 0, "请以桌面用户运行");
  assert(extra.length === 0, "命令参数不正确");
  const paths = getMacosPaths();

  if (command === "install") {
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log(`  T3 Code macOS 增强版安装与升级 (t3code-enhancer ${ENHANCER_TAG})`);
      console.log("============================================================\n");
    }
    if (flags.has("--interactive") && !preset && !packs && !flags.has("--theme-only")) {
      const pick = await promptInteractiveAction({
        askSharedData: true,
        defaultSharedData: flags.has("--shared-data"),
        patchOnly: flags.has("--patch-only"),
        promptInputLabel: !input && !fs.existsSync(DEFAULT_SOURCE) ? "请输入官方 T3 Code (Beta).app 路径: " : "",
      });
      if (pick.action === "cancel") return;
      const effectiveInput = input || pick.inputPath;
      if (pick.action === "repair") return repair(effectiveInput, { flags }, paths);
      if (pick.action === "uninstall") return uninstall(flags, paths);
      if (pick.officialOnly) flags.add("--official");
      if (pick.sharedData) flags.add("--shared-data");
      return install(effectiveInput, { flags, preset: pick.preset, packs: pick.packs }, paths);
    }
    return install(input, { flags, preset, packs }, paths);
  }
  if (command === "repair") {
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log(`  T3 Code macOS 增强版修复工具 (t3code-enhancer ${ENHANCER_TAG})`);
      console.log("============================================================\n");
    }
    return repair(input, { flags, preset, packs }, paths);
  }
  if (command === "status") {
    assert(input === undefined, "命令参数不正确");
    return status(undefined, paths);
  }
  if (command === "uninstall") {
    assert(input === undefined, "命令参数不正确");
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log(`  T3 Code macOS 增强版卸载工具 (t3code-enhancer ${ENHANCER_TAG})`);
      console.log("============================================================\n");
    }
    return uninstall(flags, paths);
  }
  throw new Error(`未知命令：${command}`);
}

if (require.main === module) {
  runMacosCli(process.argv.slice(2)).catch((error) => {
    console.error("错误:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  T3_VERSION,
  T3_TEAM_ID,
  DEFAULT_SOURCE,
  BUNDLE_ID,
  DISPLAY_NAME,
  PROFILE_NAME,
  APP_ASAR,
  INFO_PLIST,
  userDataPatch,
  PATCHES,
  getMacosPaths,
  getUserdataDir,
  buildInfoPlistEnv,
  envNeedsUpdate,
  selectMacosPatches,
  matchesSelectedPatches,
  inspectMacosModules,
  status,
  install,
  repair,
  uninstall,
  prepareProfile,
  parseMacosArgs,
  runMacosCli,
};

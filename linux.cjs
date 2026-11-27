#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
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
  resolvePristineBaseline,
  buildPatchedArchive,
  isLinuxAppRunning,
} = require("./lib/engine.cjs");
const { digest, writeVerifiedAsarCopy } = require("./lib/asar.cjs");
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
  prepareThemeTransaction,
  formatThemeStatusText,
  uninstallTheme,
  reportThemeUninstall,
} = require("./lib/theme-manager.cjs");
const { ENHANCER_TAG, T3_BASELINE_VERSION } = require("./lib/version.cjs");

const T3_VERSION = T3_BASELINE_VERSION;
// SHA-256 published on the upstream v0.1.12 release asset.
const APPIMAGE_HASH = "66b91551571df6d29b55cb590295edf411cff96c95a8feb3f41c3ca595d722e2";
const MANAGED_FILE = ".t3code-enhancer-appimage";
const SHARED_DATA_FILE = ".t3code-enhancer-shared-data";
const APP_DIRECTORY = "squashfs-root";
const APP_ASAR = path.join(APP_DIRECTORY, "resources", "app.asar");
const BACKUP_SUFFIX = ".before-t3code-enhancer";

function getLinuxPaths(env = process.env, homedir = os.homedir()) {
  const dataHome = env.XDG_DATA_HOME || path.join(homedir, ".local", "share");
  return {
    dataHome,
    installDirectory: path.join(dataHome, "t3code-enhancer"),
    installLock: path.join(dataHome, ".t3code-enhancer-install.lock"),
    previousDirectory: path.join(dataHome, ".t3code-enhancer-previous"),
    profileDirectory: path.join(dataHome, "t3code-enhancer-profile"),
    sharedUserdata: path.join(homedir, ".t3", "userdata"),
  };
}

function buildLauncher(sharedData, options = {}) {
  const disableTelemetry = options.disableTelemetry !== false;
  const telemetryLine = disableTelemetry
    ? "export T3CODE_TELEMETRY_ENABLED=false T3CODE_OTEL_SDK_DISABLED=true\n"
    : "";
  if (sharedData) {
    return `#!/bin/sh
set -eu
base="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
export T3CODE_DISABLE_AUTO_UPDATE=1
${telemetryLine}exec "$base/squashfs-root/AppRun" "$@"
`;
  }
  return `#!/bin/sh
set -eu
base="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
profile="$base/../t3code-enhancer-profile"
export T3CODE_HOME="$profile/t3-home"
export XDG_CONFIG_HOME="$profile/config" XDG_DATA_HOME="$profile/data" XDG_CACHE_HOME="$profile/cache"
export T3CODE_PORT="\${T3CODE_PORT:-3774}" T3CODE_DISABLE_AUTO_UPDATE=1
${telemetryLine}exec "$base/squashfs-root/AppRun" "$@"
`;
}

function isManagedInstall(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return false;
  const marker = path.join(directory, MANAGED_FILE);
  if (!fs.existsSync(marker)) return false;
  const content = fs.readFileSync(marker, "utf8").trim();
  return content === T3_VERSION || /^\d+\.\d+\.\d+/.test(content);
}

function usesSharedData(directory) {
  if (fs.existsSync(path.join(directory, SHARED_DATA_FILE))) return true;
  const launchPath = path.join(directory, "launch.sh");
  if (!fs.existsSync(launchPath)) return false;
  return !fs.readFileSync(launchPath, "utf8").includes("T3CODE_HOME=");
}

function isRunning(directory) {
  const appSubdir = path.join(directory, APP_DIRECTORY);
  if (!fs.existsSync(appSubdir)) return false;
  const appPath = fs.realpathSync(appSubdir);
  const asarPath = path.join(directory, APP_ASAR);
  return isLinuxAppRunning(asarPath) || isLinuxAppRunning(path.join(appPath, "resources", "app.asar"));
}

function getUserdataDir(sharedData, paths = getLinuxPaths()) {
  return resolveUserdataDir(sharedData, paths.profileDirectory, paths.sharedUserdata);
}

function prepareProfile(sharedData, options = {}, paths = getLinuxPaths()) {
  return prepareProfileAt(getUserdataDir(sharedData, paths), options);
}

function inspectInstall(paths = getLinuxPaths()) {
  const { installDirectory } = paths;
  if (!fs.lstatSync(installDirectory, { throwIfNoEntry: false })) return null;
  assert(isManagedInstall(installDirectory), `安装目录已被其他文件占用：${installDirectory}`);
  const asarPath = path.join(installDirectory, APP_ASAR);
  const backupPath = asarPath + BACKUP_SUFFIX;
  const { asar, modules, appVersion, buildMeta } = inspectArchive(asarPath, ALL_PATCHES);
  const summary = summarizeModuleStates(modules);
  const hasBackup = fs.existsSync(backupPath);
  assert(
    summary.allRecognized && (summary.hasKnownEnhancement || summary.allPristine || hasBackup),
    "安装目录中的补丁不完整或无法识别"
  );
  const sharedData = usesSharedData(installDirectory);
  const themeStatus = getThemeStatus(getUserdataDir(sharedData, paths));
  return { sharedData, asar, modules, summary, hasBackup, asarPath, backupPath, themeStatus, appVersion, buildMeta };
}

function status(paths = getLinuxPaths()) {
  const { installDirectory, previousDirectory, profileDirectory } = paths;
  let existing = null;
  try {
    existing = inspectInstall(paths);
  } catch (err) {
    if (isManagedInstall(installDirectory)) {
      console.log(`检测到受管理的 Linux 安装 (${installDirectory})，当前包无法直接识别（${err.message}）。`);
      console.log("若之前安装自更早版本（如 v0.1.0 / v0.1.1 的 0.1.11），请先退出应用并传入新版官方 AppImage 升级，或运行 repair 修复。");
      return;
    }
    throw err;
  }
  if (!existing) {
    console.log(fs.lstatSync(previousDirectory, { throwIfNoEntry: false })
      ? `上次升级未完成，旧安装仍保存在 ${previousDirectory}。运行 node linux.cjs repair 可恢复。`
      : "Linux 增强版尚未安装。");
    return;
  }
  const installedList = existing.modules.filter((m) => m.installed).map((m) => m.id);
  const versionStr = existing.appVersion ? `v${existing.appVersion}` : `v${T3_VERSION}`;
  const compatTier = existing.summary.autoAdapted
    ? "跨版本自动适配 (auto-adapted)"
    : existing.summary.allRecognized
      ? "已验证 (verified)"
      : "不兼容 (incompatible)";
  console.log(`T3 Code ${versionStr} Linux 增强版已安装 (t3code-enhancer ${ENHANCER_TAG}) [兼容性: ${compatTier}]，${isRunning(installDirectory) ? "运行中" : "未运行"}。`);
  console.log(
    existing.summary.allInstalled
      ? "补丁：已是最新版（全部模块）。"
      : existing.summary.outdated
        ? "补丁：已安装旧版（退出增强版后运行 node linux.cjs install 升级）。"
        : installedList.length > 0
          ? `补丁：已按模块安装（${installedList.join(", ")}）。`
          : "补丁：当前为纯净原版 ASAR（仅主题或待打补丁）。"
  );
  console.log("主题：", formatThemeStatusText(existing.themeStatus));
  console.log("原版 ASAR 备份：", existing.hasBackup ? existing.backupPath : "尚未创建（下次传入 AppImage 升级时将自动补建）");
  console.log(`启动：${path.join(installDirectory, "launch.sh")}`);
  console.log(existing.sharedData ? "数据：与官方版共用 ~/.t3，两者不能同时运行" : `独立配置：${profileDirectory}`);
  if (existing.summary.outdated) {
    console.log("\n待更新模块：");
    for (const m of existing.modules.filter((mod) => !mod.installed)) {
      console.log(`  - [${m.outdated ? "↑" : " "}] ${m.id} (${m.name})`);
    }
  }
}

function cleanupStaleStaging(paths) {
  if (!fs.existsSync(paths.dataHome)) return;
  cleanupStagingDirectories(paths.dataHome);
  const resourcesDir = path.join(paths.installDirectory, APP_DIRECTORY, "resources");
  if (fs.existsSync(resourcesDir)) {
    for (const name of fs.readdirSync(resourcesDir)) {
      if (name.startsWith("app.asar.") && (name.endsWith(".tmp") || name.endsWith(".patched"))) {
        fs.rmSync(path.join(resourcesDir, name), { force: true });
      }
    }
  }
}

function withInstallLock(operation, paths = getLinuxPaths()) {
  const { installDirectory, installLock, previousDirectory } = paths;
  return withInstallDirectoryLock(installLock, () => {
    recoverPreviousInstall(installDirectory, previousDirectory, isManagedInstall, () => inspectInstall(paths));
    return operation();
  });
}

function writeLauncherFiles(targetDir, sharedData, options = {}) {
  fs.writeFileSync(path.join(targetDir, "launch.sh"), buildLauncher(sharedData, options), { mode: 0o700 });
  fs.writeFileSync(path.join(targetDir, MANAGED_FILE), T3_VERSION + "\n");
  const sharedMarker = path.join(targetDir, SHARED_DATA_FILE);
  if (sharedData) {
    fs.writeFileSync(sharedMarker, "1\n");
  } else if (fs.existsSync(sharedMarker)) {
    fs.unlinkSync(sharedMarker);
  }
}

function install(input, options = {}, paths = getLinuxPaths()) {
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
    if (sharedData && !dirExists) console.log("[提示] 卸载此主题：node linux.cjs uninstall --theme-only --shared-data");
  }, paths);

  return withInstallLock(() => {
    if (options.repair) cleanupStaleStaging(paths);
    let existing = null;
    let existingCorrupt = false;
    try {
      existing = inspectInstall(paths);
    } catch (err) {
      if ((options.repair || input) && isManagedInstall(paths.installDirectory)) {
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
    const selectedPatches = plan.selectedPatches;

    const archiveSelected = existing
      ? applicablePatchesForArchive(existing.asar, selectedPatches)
      : selectedPatches;
    if (
      existing && !options.repair && !input &&
      matchesSelectedPatches(existing.modules, archiveSelected) &&
      buildLauncher(sharedData, { disableTelemetry: plan.telemetryDisabled }) ===
        (fs.existsSync(path.join(paths.installDirectory, "launch.sh"))
          ? fs.readFileSync(path.join(paths.installDirectory, "launch.sh"), "utf8")
          : "")
    ) {
      if (plan.includeTheme) {
        prepareProfile(sharedData, { officialOnly: plan.officialOnly }, paths);
      }
      return status(paths);
    }

    if (existing || existingCorrupt) {
      assert(!isRunning(paths.installDirectory), "请先退出 Linux 增强版，再运行升级或修复命令");
    }

    if ((existing || existingCorrupt) && !input) {
      const asarPath = path.join(paths.installDirectory, APP_ASAR);
      const backupPath = asarPath + BACKUP_SUFFIX;
      let baseline;
      try {
        baseline = resolvePristineBaseline({
          source: asarPath,
          backup: backupPath,
          legacyBackup: asarPath + ".before-timeline-collapse",
        });
      } catch (error) {
        throw new Error(`${error.message}。可传入官方 AppImage 重建受管理的副本。`, { cause: error });
      }
      const baselineSummary = summarizeModuleStates(baseline.modules);
      assert(baselineSummary.allRecognized, `基线 ASAR 包含未识别的版本内容，已中止安装。`);
      const compatTier = baselineSummary.autoAdapted ? "跨版本自动适配 (auto-adapted)" : "已验证 (verified)";
      const verStr = baseline.appVersion ? `v${baseline.appVersion}` : `v${T3_VERSION}`;
      console.log(`[兼容性] 原版基线版本 ${verStr} · ${compatTier}`);
      const stagingAsar = `${asarPath}.${randomUUID()}.tmp`;
      const asarRollback = `${asarPath}.${randomUUID()}.rollback`;
      const targetPatches = applicablePatchesForArchive(baseline.asar, selectedPatches);
      const userdataDir = getUserdataDir(sharedData, paths);
      const themeTx = plan.includeTheme
        ? prepareThemeTransaction(userdataDir, { officialOnly: plan.officialOnly, createSettingsIfMissing: true })
        : null;
      const launchPath = path.join(paths.installDirectory, "launch.sh");
      const managedPath = path.join(paths.installDirectory, MANAGED_FILE);
      const sharedMarkerPath = path.join(paths.installDirectory, SHARED_DATA_FILE);
      const launcherSnap = {
        launch: fs.existsSync(launchPath) ? fs.readFileSync(launchPath) : null,
        managed: fs.existsSync(managedPath) ? fs.readFileSync(managedPath) : null,
        shared: fs.existsSync(sharedMarkerPath) ? fs.readFileSync(sharedMarkerPath) : null,
      };
      let asarReplaced = false;
      let keepAsarRollback = false;
      try {
        if (targetPatches.length > 0) {
          console.log(`正在基于原版备份构建补丁（${targetPatches.map((p) => p.id).join(" + ")}）…`);
          const report = buildPatchedArchive(baseline.asar, targetPatches, stagingAsar, { plan });
          for (const r of report) {
            const tag = r.compat === "auto-adapted" ? " (跨版本自动适配)" : "";
            console.log(`  ✓ ${r.id} -> ${r.key}${tag}`);
          }
        } else {
          console.log("正在还原为纯净原版 app.asar…");
          writeVerifiedAsarCopy(baseline.path, stagingAsar, {
            expectedArchive: baseline.asar.archive,
            label: "原版恢复校验不一致",
          });
        }
        if (baseline.path !== backupPath) {
          writeVerifiedAsarCopy(baseline.path, backupPath, {
            overwrite: true,
            expectedArchive: baseline.asar.archive,
            label: "原版备份校验不一致",
          });
        }
        const stat = fs.statSync(asarPath, { throwIfNoEntry: false }) ?? fs.statSync(baseline.path);
        fs.chmodSync(stagingAsar, stat.mode & 0o777);
        if (fs.existsSync(asarPath)) {
          fs.copyFileSync(asarPath, asarRollback, fs.constants.COPYFILE_EXCL);
        }
        assert(!isRunning(paths.installDirectory), "请先退出 Linux 增强版，再运行升级或修复命令");
        fs.renameSync(stagingAsar, asarPath);
        asarReplaced = true;
        if (themeTx) {
          const res = themeTx.commit();
          if (!res.activated) {
            console.warn("[提示] 主题已写入，但未能自动激活：请检查设置文件后手动切换主题");
          }
        }
        writeLauncherFiles(paths.installDirectory, sharedData, { disableTelemetry: plan.telemetryDisabled });
      } catch (err) {
        if (asarReplaced) {
          const rollbackErrors = [];
          try { themeTx?.rollback(); } catch (e) { rollbackErrors.push(`主题回滚（${e.message}）`); }
          try {
            if (launcherSnap.launch !== null) fs.writeFileSync(launchPath, launcherSnap.launch, { mode: 0o700 });
            if (launcherSnap.managed !== null) fs.writeFileSync(managedPath, launcherSnap.managed);
            if (launcherSnap.shared !== null) fs.writeFileSync(sharedMarkerPath, launcherSnap.shared);
            else if (fs.existsSync(sharedMarkerPath)) fs.unlinkSync(sharedMarkerPath);
          } catch (e) { rollbackErrors.push(`启动器回滚（${e.message}）`); }
          try {
            if (fs.existsSync(asarRollback)) fs.renameSync(asarRollback, asarPath);
            else fs.rmSync(asarPath, { force: true });
          } catch (e) {
            keepAsarRollback = true;
            rollbackErrors.push(`${asarPath}（${e.message}，回滚副本：${asarRollback}）`);
          }
          if (rollbackErrors.length) {
            throw new Error(`${err.message}。已提交 app.asar 且回滚失败：${rollbackErrors.join("、")}`, { cause: err });
          }
        }
        throw err;
      } finally {
        if (fs.existsSync(stagingAsar)) fs.unlinkSync(stagingAsar);
        if (!keepAsarRollback) fs.rmSync(asarRollback, { force: true });
      }
      return status(paths);
    }

    assert(input, "请提供官方 T3-Code-x86_64.AppImage 的路径");
    const source = path.resolve(input);
    assert(fs.statSync(source).isFile(), "AppImage 路径必须是文件");
    fs.mkdirSync(paths.dataHome, { recursive: true });
    const staging = fs.mkdtempSync(path.join(paths.dataHome, ".t3code-enhancer-"));
    const themeTx = plan.includeTheme
      ? prepareThemeTransaction(getUserdataDir(sharedData, paths), { officialOnly: plan.officialOnly, createSettingsIfMissing: true })
      : null;
    try {
      const image = path.join(staging, "T3-Code-x86_64.AppImage");
      fs.copyFileSync(source, image, fs.constants.COPYFILE_EXCL);
      assert.equal(digest(fs.readFileSync(image)), APPIMAGE_HASH,
        `需要官方 T3 Code ${T3_VERSION} x86_64 AppImage（SHA-256 不匹配）`);
      fs.chmodSync(image, 0o700);
      console.log("解包官方 AppImage 并校验前端补丁…");
      execFileSync(image, ["--appimage-extract"], { cwd: staging, stdio: ["ignore", "ignore", "inherit"] });
      fs.unlinkSync(image);
      fs.accessSync(path.join(staging, APP_DIRECTORY, "AppRun"), fs.constants.X_OK);
      const target = path.join(staging, APP_ASAR);
      const backup = target + BACKUP_SUFFIX;
      const baseline = inspectArchive(target, ALL_PATCHES);
      const baselineSummary = summarizeModuleStates(baseline.modules);
      assert(baselineSummary.allRecognized, `目标 ASAR 与补丁不兼容，已中止安装。`);
      const compatTier = baselineSummary.autoAdapted ? "跨版本自动适配 (auto-adapted)" : "已验证 (verified)";
      const verStr = baseline.appVersion ? `v${baseline.appVersion}` : `v${T3_VERSION}`;
      console.log(`[兼容性] 检测到版本 ${verStr} · ${compatTier}`);
      writeVerifiedAsarCopy(target, backup, {
        overwrite: true,
        expectedArchive: baseline.asar.archive,
        label: "原版备份校验不一致",
      });
      const targetPatches = applicablePatchesForArchive(baseline.asar, selectedPatches);
      if (targetPatches.length > 0) {
        const patched = target + ".patched";
        const report = buildPatchedArchive(baseline.asar, targetPatches, patched, { plan });
        for (const r of report) {
          const tag = r.compat === "auto-adapted" ? " (跨版本自动适配)" : "";
          console.log(`  ✓ ${r.id} -> ${r.key}${tag}`);
        }
        fs.chmodSync(patched, fs.statSync(target).mode & 0o777);
        fs.renameSync(patched, target);
      }
      writeLauncherFiles(staging, sharedData, { disableTelemetry: plan.telemetryDisabled });
      const replacing = Boolean(existing || existingCorrupt);
      if (replacing) {
        assert(!isRunning(paths.installDirectory), "请先退出 Linux 增强版，再运行升级或修复命令");
      }
      replaceStagedInstall(staging, paths.installDirectory, replacing ? paths.previousDirectory : null, themeTx ? { afterCommit: () => themeTx.commit(), onRollback: () => themeTx.rollback() } : undefined);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return status(paths);
  }, paths);
}

function repair(input, options = {}, paths = getLinuxPaths()) {
  const flags = new Set(options.flags || []);
  let effectiveOptions = { ...options, flags, repair: true };
  if (!options.preset && !options.packs && !flags.has("--theme-only") && !flags.has("--patch-only")) {
    let existing = null;
    const installDirectory = fs.lstatSync(paths.installDirectory, { throwIfNoEntry: false })
      ? paths.installDirectory : paths.previousDirectory;
    try { existing = inspectInstall({ ...paths, installDirectory }); } catch {}
    if (existing) {
      const inferred = inferRepairPlanOptions(
        existing.modules,
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
  console.log("[修复] 正在检查并修复 Linux 增强版安装、原版备份与主题状态…");
  return install(input, effectiveOptions, paths);
}

function uninstall(flags = new Set(), paths = getLinuxPaths()) {
  if (flags.has("--theme-only")) {
    if (flags.has("--keep-theme")) return;
    return withInstallDirectoryLock(paths.installLock, () => {
      const installed = [paths.installDirectory, paths.previousDirectory].find(isManagedInstall);
      const sharedData = installed ? usesSharedData(installed) : flags.has("--shared-data");
      reportThemeUninstall(getUserdataDir(sharedData, paths));
    });
  }
  return withInstallLock(() => {
    const { installDirectory, profileDirectory } = paths;
    const keepTheme = flags.has("--keep-theme");
    const purgeProfile = flags.has("--purge-profile");
    if (!fs.lstatSync(installDirectory, { throwIfNoEntry: false })) {
      cleanupStaleStaging(paths);
      if (purgeProfile && fs.existsSync(profileDirectory)) {
        fs.rmSync(profileDirectory, { recursive: true, force: true });
        console.log(`已清理独立配置目录：${profileDirectory}`);
      }
      return status(paths);
    }
    assert(isManagedInstall(installDirectory), `无法确认是本工具安装的目录：${installDirectory}`);
    assert(!isRunning(installDirectory), "请先退出 Linux 增强版，再运行卸载命令");
    const sharedData = usesSharedData(installDirectory);
    if (!keepTheme) {
      uninstallTheme(getUserdataDir(sharedData, paths));
    }
    fs.rmSync(installDirectory, { recursive: true, force: true });
    cleanupStaleStaging(paths);
    if (purgeProfile && !sharedData && fs.existsSync(profileDirectory)) {
      fs.rmSync(profileDirectory, { recursive: true, force: true });
      console.log(`已卸载 Linux 增强版并彻底清理独立配置目录：${profileDirectory}`);
      return;
    }
    console.log(sharedData
      ? "已卸载 Linux 增强版。会话和项目仍在 ~/.t3，官方版可以继续使用"
      : `已卸载 Linux 增强版。独立配置和会话保存在 ${profileDirectory}`);
  }, paths);
}

function parseLinuxArgs(argv) {
  return parsePlatformArgs(argv);
}

function printUsage() {
  console.log(`用法：
  node linux.cjs install [<AppImage>] [--preset <id>] [--packs <a,b>] [--shared-data] [--official] [--interactive]
  node linux.cjs repair  [<AppImage>] [--preset <id>] [--packs <a,b>] [--official]
  node linux.cjs status
  node linux.cjs uninstall [--theme-only] [--keep-theme] [--purge-profile]
  node linux.cjs --version

可选预设 (--preset)：full（默认完整版）| chat-lite（轻量对话）| clean（主题+去遥测）| privacy-only（纯去遥测）| theme-only（纯主题）
可选模块 (--packs) ：theme, privacy, composer, chat, workspace`);
}

async function runLinuxCli(argv) {
  const { command, input, extra, flags, preset, packs } = parseLinuxArgs(argv);
  if (!command || flags.has("--help")) {
    printUsage();
    return;
  }
  if (command === "version" || flags.has("--version")) {
    console.log(require("./lib/version.cjs").formatVersionBanner());
    return;
  }
  assert(process.platform === "linux" && process.arch === "x64", "仅支持 Linux x86_64");
  assert(process.getuid() !== 0, "请以桌面用户运行");
  const paths = getLinuxPaths();
  assert(path.isAbsolute(paths.dataHome), "XDG_DATA_HOME 必须是绝对路径");
  assert(extra.length === 0, "命令参数不正确");

  if (command === "install") {
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log(`  T3 Code Linux 增强版安装与升级 (t3code-enhancer ${ENHANCER_TAG})`);
      console.log("============================================================\n");
    }
    if (flags.has("--interactive") && !preset && !packs && !flags.has("--theme-only")) {
      let hasExisting = false;
      try { hasExisting = Boolean(inspectInstall(paths)); } catch {}
      const pick = await promptInteractiveAction({
        askSharedData: true,
        defaultSharedData: flags.has("--shared-data"),
        patchOnly: flags.has("--patch-only"),
        promptInputLabel: !hasExisting && !input ? "请输入官方 T3-Code-x86_64.AppImage 路径（可直接拖入终端）: " : "",
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
      console.log(`  T3 Code Linux 增强版修复工具 (t3code-enhancer ${ENHANCER_TAG})`);
      console.log("============================================================\n");
    }
    return repair(input, { flags, preset, packs }, paths);
  }
  if (command === "status") {
    assert(input === undefined, "命令参数不正确");
    return status(paths);
  }
  if (command === "uninstall") {
    assert(input === undefined, "命令参数不正确");
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log(`  T3 Code Linux 增强版卸载工具 (t3code-enhancer ${ENHANCER_TAG})`);
      console.log("============================================================\n");
    }
    return uninstall(flags, paths);
  }
  throw new Error(`未知命令：${command}`);
}

if (require.main === module) {
  runLinuxCli(process.argv.slice(2)).catch((error) => {
    console.error("错误:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  T3_VERSION,
  APPIMAGE_HASH,
  MANAGED_FILE,
  SHARED_DATA_FILE,
  APP_ASAR,
  BACKUP_SUFFIX,
  getLinuxPaths,
  buildLauncher,
  isManagedInstall,
  usesSharedData,
  getUserdataDir,
  prepareProfile,
  inspectInstall,
  status,
  install,
  repair,
  uninstall,
  matchesSelectedPatches,
  parseLinuxArgs,
  writeLauncherFiles,
  runLinuxCli,
};

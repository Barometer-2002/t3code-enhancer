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
const { digest, readAsar, writeVerifiedAsarCopy } = require("./lib/asar.cjs");
const { withInstallDirectoryLock, retirePreviousInstall } = require("./lib/install-state.cjs");
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
} = require("./lib/theme-manager.cjs");

const T3_VERSION = "0.1.11";
const APPIMAGE_HASH = "8baa06a7bbaa3f729d69466fb211ed7006d6a6e4d800b9ecdacd831fd1686b14";
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
  return fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === T3_VERSION + "\n";
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
  return prepareProfileAt(getUserdataDir(sharedData, paths), sharedData, options);
}

function inspectInstall(paths = getLinuxPaths()) {
  const { installDirectory } = paths;
  if (!fs.lstatSync(installDirectory, { throwIfNoEntry: false })) return null;
  assert(isManagedInstall(installDirectory), `安装目录已被其他文件占用：${installDirectory}`);
  const asarPath = path.join(installDirectory, APP_ASAR);
  const backupPath = asarPath + BACKUP_SUFFIX;
  const { asar, modules } = inspectArchive(asarPath, ALL_PATCHES);
  const summary = summarizeModuleStates(modules);
  const hasBackup = fs.existsSync(backupPath);
  assert(
    summary.allRecognized && (summary.hasKnownEnhancement || summary.allPristine || hasBackup),
    "安装目录中的补丁不完整或无法识别"
  );
  const sharedData = usesSharedData(installDirectory);
  const themeStatus = getThemeStatus(getUserdataDir(sharedData, paths));
  return { sharedData, asar, modules, summary, hasBackup, asarPath, backupPath, themeStatus };
}

function status(paths = getLinuxPaths()) {
  const { installDirectory, previousDirectory, profileDirectory } = paths;
  const existing = inspectInstall(paths);
  if (!existing) {
    console.log(fs.lstatSync(previousDirectory, { throwIfNoEntry: false })
      ? `上次升级未完成，旧安装仍保存在 ${previousDirectory}。运行 node linux.cjs repair 可恢复。`
      : "Linux 增强版尚未安装。");
    return;
  }
  const installedList = existing.modules.filter((m) => m.installed).map((m) => m.id);
  console.log(`T3 Code ${T3_VERSION} Linux 增强版已安装，${isRunning(installDirectory) ? "运行中" : "未运行"}。`);
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
  for (const name of fs.readdirSync(paths.dataHome)) {
    if (/^\.t3code-enhancer-[A-Za-z0-9]{6}$/.test(name)) {
      fs.rmSync(path.join(paths.dataHome, name), { recursive: true, force: true });
    }
  }
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
    if (fs.lstatSync(previousDirectory, { throwIfNoEntry: false })) {
      assert(isManagedInstall(previousDirectory), `无法确认旧安装备份：${previousDirectory}`);
      if (fs.lstatSync(installDirectory, { throwIfNoEntry: false })) {
        inspectInstall(paths);
        retirePreviousInstall(previousDirectory);
        assert(!fs.existsSync(previousDirectory), `无法清理旧安装备份：${previousDirectory}`);
      } else {
        fs.renameSync(previousDirectory, installDirectory);
      }
    }
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
    if (!res.activated) {
      console.warn(`[提示] 主题已写入，但未能自动激活：${res.reason || "请检查设置文件后手动切换主题"}`);
    }
  }, paths);

  return withInstallLock(() => {
    if (options.repair) cleanupStaleStaging(paths);
    let existing = null;
    let existingCorrupt = false;
    try {
      existing = inspectInstall(paths);
    } catch (err) {
      if (options.repair && isManagedInstall(paths.installDirectory)) {
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
        const themeRes = prepareProfile(sharedData, { officialOnly: plan.officialOnly }, paths);
        if (!themeRes.activated) {
          console.warn(`[提示] 主题已写入，但未能自动激活：${themeRes.reason || "请检查设置文件后手动切换主题"}`);
        }
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
      const stagingAsar = `${asarPath}.${randomUUID()}.tmp`;
      const targetPatches = applicablePatchesForArchive(baseline.asar, selectedPatches);
      try {
        if (targetPatches.length > 0) {
          console.log(`正在基于原版备份构建补丁（${targetPatches.map((p) => p.id).join(" + ")}）…`);
          buildPatchedArchive(baseline.asar, targetPatches, stagingAsar);
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
        assert(!isRunning(paths.installDirectory), "请先退出 Linux 增强版，再运行升级或修复命令");
        fs.renameSync(stagingAsar, asarPath);
      } finally {
        if (fs.existsSync(stagingAsar)) fs.unlinkSync(stagingAsar);
      }
      if (plan.includeTheme) {
        const themeRes = prepareProfile(sharedData, { officialOnly: plan.officialOnly }, paths);
        if (!themeRes.activated) {
          console.warn(`[提示] 主题已写入，但未能自动激活：${themeRes.reason || "请检查设置文件后手动切换主题"}`);
        }
      }
      writeLauncherFiles(paths.installDirectory, sharedData, { disableTelemetry: plan.telemetryDisabled });
      return status(paths);
    }

    assert(input, "请提供官方 T3-Code-x86_64.AppImage 的路径");
    const source = path.resolve(input);
    assert(fs.statSync(source).isFile(), "AppImage 路径必须是文件");
    fs.mkdirSync(paths.dataHome, { recursive: true });
    const staging = fs.mkdtempSync(path.join(paths.dataHome, ".t3code-enhancer-"));
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
      writeVerifiedAsarCopy(target, backup, {
        overwrite: true,
        expectedArchive: baseline.asar.archive,
        label: "原版备份校验不一致",
      });
      const targetPatches = applicablePatchesForArchive(baseline.asar, selectedPatches);
      if (targetPatches.length > 0) {
        const patched = target + ".patched";
        buildPatchedArchive(baseline.asar, targetPatches, patched);
        fs.chmodSync(patched, fs.statSync(target).mode & 0o777);
        fs.renameSync(patched, target);
      }
      writeLauncherFiles(staging, sharedData, { disableTelemetry: plan.telemetryDisabled });
      if (existing || existingCorrupt) {
        assert(!isRunning(paths.installDirectory), "请先退出 Linux 增强版，再运行升级或修复命令");
        fs.renameSync(paths.installDirectory, paths.previousDirectory);
      }
      try {
        fs.renameSync(staging, paths.installDirectory);
      } catch (error) {
        if (existing || existingCorrupt) {
          try {
            fs.renameSync(paths.previousDirectory, paths.installDirectory);
          } catch (rollbackError) {
            throw new Error(`安装失败，无法恢复原安装目录。旧安装仍保存在 ${paths.previousDirectory}（${rollbackError.message}）`, { cause: error });
          }
        }
        throw error;
      }
      if (existing || existingCorrupt) retirePreviousInstall(paths.previousDirectory);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    if (plan.includeTheme) {
      const themeRes = prepareProfile(sharedData, { officialOnly: plan.officialOnly }, paths);
      if (!themeRes.activated) console.warn(`[提示] 主题已写入，但未能自动激活：${themeRes.reason || "请检查设置文件后手动切换主题"}`);
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
      const inferred = inferRepairPlanOptions(existing.modules, existing.themeStatus);
      if (inferred.officialOnly) flags.add("--official");
      if (inferred.patchOnly) flags.add("--patch-only");
      effectiveOptions = {
        ...effectiveOptions,
        preset: inferred.preset ?? undefined,
        packs: inferred.packs ?? undefined,
      };
    }
  }
  console.log("[修复] 正在检查并修复 Linux 增强版安装、原版备份与主题状态…");
  return install(input, effectiveOptions, paths);
}

function uninstall(flags = new Set(), paths = getLinuxPaths()) {
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
  node linux.cjs uninstall [--keep-theme] [--purge-profile]

可选预设 (--preset)：full（默认完整版）| chat-lite（轻量对话）| clean（主题+去遥测）| privacy-only（纯去遥测）| theme-only（纯主题）
可选模块 (--packs) ：theme, privacy, composer, chat, workspace`);
}

async function runLinuxCli(argv) {
  const { command, input, extra, flags, preset, packs } = parseLinuxArgs(argv);
  if (!command || flags.has("--help")) {
    printUsage();
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
      console.log("  T3 Code Linux 增强版安装与升级 (t3code-enhancer)");
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
      console.log("  T3 Code Linux 增强版修复工具 (t3code-enhancer)");
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
      console.log("  T3 Code Linux 增强版卸载工具 (t3code-enhancer)");
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
  matchesSelectedPatches,
  parseLinuxArgs,
  writeLauncherFiles,
  runLinuxCli,
};

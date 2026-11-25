#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { readAsar } = require("./lib/asar.cjs");
const {
  ALL_PATCHES,
  selectPatches,
  applicablePatchesForArchive,
  getLinuxAsarCandidates,
  getAsarPaths,
  getArchiveTargetPaths,
  isLinuxAppRunning,
  isT3Running,
  assertT3Closed,
  inspectArchive,
  summarizeModuleStates,
  resolvePristineBaseline,
  buildPatchedArchive,
} = require("./lib/engine.cjs");
const { getThemeStatus, installTheme, uninstallTheme } = require("./lib/theme-manager.cjs");
const {
  PACKS,
  PRESETS,
  resolveInstallPlan,
  consumePackFlags,
  promptInteractiveAction,
} = require("./lib/packs.cjs");

function cleanupStaleAsarStaging(sourcePath) {
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(base + ".") && name.endsWith(".tmp")) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

function cmdStatus(asarOverride) {
  const theme = getThemeStatus();
  console.log("=== T3 Code 主题与体验强化状态 ===");
  console.log(
    "主题文件 (chatgpt-app) :",
    theme.installed
      ? `${theme.matchesBundled ? "已安装（最新" : "已安装（与项目内版本有差异"} · ${theme.active ? "已激活" : "未激活"}）`
      : "未安装"
  );
  console.log("主题备份 :", theme.hasBackup ? "存在" : "无");

  let targetPaths;
  try {
    targetPaths = getArchiveTargetPaths(asarOverride);
  } catch (err) {
    console.log("安装包路径 :", `未检测到（${err.message}）`);
    return;
  }

  const running = isT3Running(targetPaths[0].source);
  const upgradeHint = process.platform === "win32" ? "install.cmd" : "node cli.cjs install";
  console.log("T3 Code 运行状态 :", running ? "运行中（安装/修复/卸载补丁需先退出）" : "已退出");
  for (const paths of targetPaths) {
    const label = targetPaths.length > 1 ? ` (${path.basename(paths.source)})` : "";
    console.log(`安装包路径${label} :`, paths.source);
    console.log(`原版 ASAR 备份${label} :`, fs.existsSync(paths.backup) ? paths.backup : fs.existsSync(paths.legacyBackup) ? `${paths.legacyBackup}（旧版备份，安装时将自动继承）` : "尚未创建");
  }
  console.log("\n前端与桌面增强模块：");
  for (const paths of targetPaths) {
    const current = inspectArchive(paths.source);
    for (const m of current.modules) {
      const state = m.installed
        ? "已安装（最新）"
        : m.outdated
          ? `已安装旧版（关闭 T3 Code 后重新运行 ${upgradeHint} 升级）`
          : m.pristine
            ? "未安装（兼容原版）"
            : current.modules.some((related) => related.key === m.key && (related.installed || related.outdated))
              ? "未安装（同一文件已有其他补丁）"
              : "未识别版本";
      console.log(`  - [${m.installed ? "✓" : m.outdated ? "↑" : " "}] ${m.id} (${m.name}) : ${state}`);
    }
  }
}

function applyAsarPlanToTarget(plan, paths, options = {}) {
  const asarName = path.basename(paths.source);
  if (options.repair) cleanupStaleAsarStaging(paths.source);
  assertT3Closed(paths.source);
  const baseline = resolvePristineBaseline(paths);
  const targetPatches = applicablePatchesForArchive(baseline.asar, plan.selectedPatches);
  const staging = `${paths.source}.${randomUUID()}.tmp`;
  try {
    if (targetPatches.length > 0) {
      console.log(`[补丁] 正在基于干净原版基线构建 ${asarName}（${targetPatches.map((p) => p.id).join(" + ")}）...`);
      const report = buildPatchedArchive(baseline.asar, targetPatches, staging);
      if (!fs.existsSync(paths.backup)) {
        fs.copyFileSync(baseline.path, paths.backup, fs.constants.COPYFILE_EXCL);
        assert(readAsar(paths.backup).archive.equals(baseline.asar.archive), "原版备份校验不一致");
      }
      assertT3Closed(paths.source);
      fs.renameSync(staging, paths.source);
      for (const r of report) {
        console.log(`[补丁] ✓ ${r.id} -> ${r.key} (${r.patched.slice(0, 12)})`);
      }
      console.log(`[备份] 原版安全备份位于：${paths.backup}`);
    } else {
      const current = inspectArchive(paths.source);
      if (current.modules.every((m) => m.pristine)) return;
      console.log(`[补丁] 当前方案不包含 ${asarName} 补丁，正在还原为纯净原版...`);
      fs.copyFileSync(baseline.path, staging, fs.constants.COPYFILE_EXCL);
      assert(readAsar(staging).archive.equals(baseline.asar.archive), "原版恢复校验不一致");
      assertT3Closed(paths.source);
      fs.renameSync(staging, paths.source);
      console.log(`[备份] 已保留原版备份：${paths.backup}`);
    }
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
}

function applyAsarPlan(plan, asarOverride, options = {}) {
  for (const paths of getArchiveTargetPaths(asarOverride)) {
    applyAsarPlanToTarget(plan, paths, options);
  }
}

function cmdInstall(flags, asarOverride, planOptions = {}) {
  const plan = resolveInstallPlan(ALL_PATCHES, {
    preset: planOptions.preset || null,
    packs: planOptions.packs || null,
    flags,
  });

  if (plan.needsLayer3Warning) {
    console.log("[提示] --official 仅安装 Layer 1 官方样式层，部分功能补丁的视觉样式可能不完整；纯官方主题建议配合 --preset theme-only 或 --preset clean 使用。");
  }

  console.log(`[方案] ${plan.presetId} | 模块: ${plan.packIds.join(", ")}`);

  if (plan.includeTheme) {
    const res = installTheme({ officialOnly: plan.officialOnly, createSettingsIfMissing: true });
    console.log(`[主题] 已安装 chatgpt-app 主题（${plan.officialOnly ? "仅官方稳定层 Layer 1" : "完整分层主题 Layer 1-3"}） -> ${res.targetPath}`);
    if (res.backupPath) console.log(`[主题] 原主题已备份 -> ${res.backupPath}`);
  } else if (plan.presetId === "privacy-only") {
    console.log("[主题] 纯去遥测模式：保持现有主题不变。");
  }

  if (plan.themeOnly) {
    console.log("\n主题安装完成（无需重启 T3 Code，在设置 -> 外观中切换生效）。");
    return;
  }

  applyAsarPlan(plan, asarOverride);
  console.log("\n全部安装完成！现在可以重新启动 T3 Code。");
}

function cmdRepair(flags, asarOverride, planOptions = {}) {
  const plan = resolveInstallPlan(ALL_PATCHES, {
    preset: planOptions.preset || null,
    packs: planOptions.packs || null,
    flags,
  });
  if (plan.needsLayer3Warning) {
    console.log("[提示] --official 仅安装 Layer 1 官方样式层，部分功能补丁的视觉样式可能不完整；纯官方主题建议配合 --preset theme-only 或 --preset clean 使用。");
  }
  console.log(`[方案] ${plan.presetId} | 模块: ${plan.packIds.join(", ")}`);
  console.log("[修复] 正在清理残留临时文件并检查主题与 ASAR 完整性...");
  if (plan.includeTheme) {
    const res = installTheme({ officialOnly: plan.officialOnly, createSettingsIfMissing: true });
    console.log(`[修复] 主题已重新校验并写入 -> ${res.targetPath}`);
  }
  if (plan.themeOnly) {
    console.log("\n主题修复完成（无需重启 T3 Code）。");
    return;
  }
  applyAsarPlan(plan, asarOverride, { repair: true });
  console.log("\n修复完成！现在可以重新启动 T3 Code。");
}

function cmdUninstall(flags, asarOverride) {
  const keepTheme = flags.has("--keep-theme");
  const themeOnly = flags.has("--theme-only");
  const purgeBackup = flags.has("--purge-backup");

  const targetPaths = themeOnly ? [] : getArchiveTargetPaths(asarOverride);
  const resolvedTargets = [];
  for (const paths of targetPaths) {
    const asarName = path.basename(paths.source);
    cleanupStaleAsarStaging(paths.source);
    assertT3Closed(paths.source);
    const backupPath = fs.existsSync(paths.backup) ? paths.backup : fs.existsSync(paths.legacyBackup) ? paths.legacyBackup : null;
    if (!backupPath) {
      const current = inspectArchive(paths.source);
      if (current.modules.every((m) => m.pristine)) {
        resolvedTargets.push({ paths, asarName, backupPath: null, alreadyPristine: true });
        continue;
      }
      throw new Error(`未找到原版 ${asarName} 备份文件，无法自动还原。`);
    }
    const original = inspectArchive(backupPath);
    assert(original.modules.every((m) => m.pristine), `备份文件 ${backupPath} 校验不是纯净原版`);
    resolvedTargets.push({ paths, asarName, backupPath, original, alreadyPristine: false });
  }

  if (!keepTheme) {
    const res = uninstallTheme();
    console.log(`[主题] 卸载结果：${res.action} (${res.targetPath})`);
  }
  if (themeOnly) return;

  for (const target of resolvedTargets) {
    const { paths, asarName, backupPath, original, alreadyPristine } = target;
    if (alreadyPristine) {
      console.log(`[补丁] 当前 ${asarName} 已是纯净原版，无需还原。`);
      continue;
    }

    const staging = `${paths.source}.${randomUUID()}.tmp`;
    try {
      fs.copyFileSync(backupPath, staging, fs.constants.COPYFILE_EXCL);
      assert(readAsar(staging).archive.equals(original.asar.archive), "还原文件校验不一致");
      assertT3Closed(paths.source);
      fs.renameSync(staging, paths.source);
      console.log(`[补丁] ✓ 已逐字节还原纯净原版 ${asarName}（来源：${backupPath}）`);
      if (purgeBackup) {
        if (fs.existsSync(paths.backup)) {
          fs.unlinkSync(paths.backup);
          console.log(`[备份] 已移除原版备份文件：${paths.backup}`);
        }
        if (paths.legacyBackup && paths.legacyBackup !== paths.backup && fs.existsSync(paths.legacyBackup)) {
          fs.unlinkSync(paths.legacyBackup);
          console.log(`[备份] 已移除旧版备份文件：${paths.legacyBackup}`);
        }
      }
    } finally {
      if (fs.existsSync(staging)) fs.unlinkSync(staging);
    }
  }
  console.log("\n卸载完成！现在可以重新启动 T3 Code。");
}

function cmdBuild(outputPath, flags, asarOverride, planOptions = {}) {
  assert(outputPath, "请提供输出路径：node cli.cjs build <output.asar>");
  const paths = getAsarPaths(asarOverride);
  const baseline = resolvePristineBaseline(paths);
  const plan = resolveInstallPlan(ALL_PATCHES, {
    preset: planOptions.preset || null,
    packs: planOptions.packs || null,
    flags,
  });
  const resolved = path.resolve(outputPath);
  if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  const report = buildPatchedArchive(baseline.asar, plan.selectedPatches, resolved);
  console.log(JSON.stringify({ output: resolved, preset: plan.presetId, packs: plan.packIds, modules: report }, null, 2));
}

function parseCliArgs(argv) {
  const { remaining, preset, packs } = consumePackFlags(argv);
  const positional = [];
  const flags = new Set();
  let asarPath = null;
  let appImagePath = null;
  let macAppPath = null;
  for (let i = 0; i < remaining.length; i++) {
    const arg = remaining[i];
    if (arg === "--asar") {
      assert(i + 1 < remaining.length && remaining[i + 1].trim() && !remaining[i + 1].startsWith("--"), "请为 --asar 提供路径参数");
      asarPath = remaining[++i];
    } else if (arg.startsWith("--asar=")) {
      asarPath = arg.slice("--asar=".length);
      assert(asarPath.trim(), "请为 --asar= 提供路径参数");
    } else if (arg === "--appimage") {
      assert(i + 1 < remaining.length && remaining[i + 1].trim() && !remaining[i + 1].startsWith("--"), "请为 --appimage 提供路径参数");
      appImagePath = remaining[++i];
    } else if (arg.startsWith("--appimage=")) {
      appImagePath = arg.slice("--appimage=".length);
      assert(appImagePath.trim(), "请为 --appimage= 提供路径参数");
    } else if (arg === "--app") {
      assert(i + 1 < remaining.length && remaining[i + 1].trim() && !remaining[i + 1].startsWith("--"), "请为 --app 提供路径参数");
      macAppPath = remaining[++i];
    } else if (arg.startsWith("--app=")) {
      macAppPath = arg.slice("--app=".length);
      assert(macAppPath.trim(), "请为 --app= 提供路径参数");
    } else if (arg === "-h") {
      flags.add("--help");
    } else if (arg.startsWith("--")) {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }
  const resolvedCmd = positional[0]
    || (flags.has("--help") ? "help"
      : flags.has("--install") ? "install"
      : flags.has("--repair") ? "repair"
      : flags.has("--uninstall") ? "uninstall"
      : flags.has("--build") ? "build"
      : flags.has("--status") ? "status"
      : flags.has("--interactive") ? "install"
      : "status");
  return {
    cmd: resolvedCmd,
    rest: positional.slice(1),
    flags,
    asarPath,
    appImagePath,
    macAppPath,
    preset,
    packs,
  };
}

function stripCliOnlyFlags(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--appimage" || argv[i] === "--app") {
      i++;
    } else if (argv[i].startsWith("--appimage=") || argv[i].startsWith("--app=")) {
      // appended once below if needed
    } else {
      out.push(argv[i]);
    }
  }
  return out;
}

function shouldDelegateToLinux(parsed) {
  if (process.platform !== "linux" || parsed.asarPath || process.env.T3CODE_ASAR) return false;
  if (parsed.cmd === "build") return false;
  const linuxCli = require("./linux.cjs");
  const installed = fs.existsSync(linuxCli.getLinuxPaths().installDirectory);
  if ((parsed.flags.has("--theme-only") || parsed.preset === "theme-only") && !installed && !parsed.appImagePath) {
    return false;
  }
  if (parsed.appImagePath || parsed.rest[0]?.endsWith(".AppImage")) return true;
  if (installed) return true;
  if (parsed.flags.has("--shared-data") || parsed.flags.has("--purge-profile")) return true;
  return !getLinuxAsarCandidates().some((c) => fs.existsSync(c));
}

function shouldDelegateToMacos(parsed) {
  if (process.platform !== "darwin" || parsed.asarPath || process.env.T3CODE_ASAR) return false;
  if (parsed.cmd === "build") return false;
  const macosCli = require("./macos.cjs");
  const paths = macosCli.getMacosPaths();
  const installed = fs.existsSync(paths.installDirectory);
  if ((parsed.flags.has("--theme-only") || parsed.preset === "theme-only") && !installed && !parsed.macAppPath) {
    return false;
  }
  if (parsed.macAppPath || parsed.rest[0]?.replace(/[/\\]+$/, "").endsWith(".app")) return true;
  return installed || fs.existsSync(macosCli.DEFAULT_SOURCE) || parsed.flags.has("--shared-data");
}

function printUsage() {
  console.log(`通用跨平台命令 (Windows / Linux / macOS)：
  node cli.cjs status                  查看主题、备份与全部功能模块状态
  node cli.cjs install                 按默认完整版（或搭配 --interactive 交互菜单）安装/升级
  node cli.cjs repair                  修复损坏文件、补全/恢复备份、修复主题与启动环境
  node cli.cjs uninstall               卸载增强并逐字节还原纯净原版 ASAR
  node cli.cjs build <output.asar>     在副本上试构建并校验（不改动已安装的 T3 Code）

分块打包与版本选择：
  --interactive                        进入交互式菜单选择版本/自由搭配模块
  --preset <name>                      预设版本：${PRESETS.map((p) => p.id).join(" | ")}
  --packs <a,b,c>                      自由搭配：${PACKS.map((p) => p.id).join(", ")}
  --official                           主题仅安装 Layer 1 官方稳定层（零非白名单选择器）
  --theme-only / --patch-only          仅装主题 / 仅装前端补丁

平台专用选项：
  --asar <path>                        显式指定 server.asar / app.asar 路径（Windows / Linux / macOS）
  --appimage <path>                    Linux：指定官方 T3-Code-x86_64.AppImage 路径
  --app <path>                         macOS：指定官方 T3 Code (Beta).app 路径
  --shared-data                        Linux / macOS：与官方版共用 ~/.t3 会话数据
  --keep-theme / --purge-backup        卸载时保留主题 / 清理原版备份
  --purge-profile                      Linux / macOS：卸载时一并清理独立配置目录`);
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const parsed = parseCliArgs(rawArgv);
  const { cmd, rest, flags, asarPath, preset, packs } = parsed;

  if (cmd === "help" || flags.has("--help")) {
    printUsage();
    return;
  }

  if (shouldDelegateToLinux(parsed)) {
    const linuxCli = require("./linux.cjs");
    const forwarded = stripCliOnlyFlags(rawArgv);
    if (!rawArgv.length || !["status", "install", "repair", "uninstall", "restore", "build", "help"].includes(rawArgv[0])) {
      if (rawArgv[0]?.startsWith("--")) forwarded.unshift(cmd);
    }
    if ((cmd === "install" || cmd === "repair") && parsed.appImagePath && !rest[0]) forwarded.push(parsed.appImagePath);
    return linuxCli.runLinuxCli(forwarded);
  }
  if (shouldDelegateToMacos(parsed)) {
    const macosCli = require("./macos.cjs");
    const forwarded = stripCliOnlyFlags(rawArgv);
    if (!rawArgv.length || !["status", "install", "repair", "uninstall", "restore", "build", "help"].includes(rawArgv[0])) {
      if (rawArgv[0]?.startsWith("--")) forwarded.unshift(cmd);
    }
    if ((cmd === "install" || cmd === "repair") && parsed.macAppPath && !rest[0]) forwarded.push(parsed.macAppPath);
    return macosCli.runMacosCli(forwarded);
  }

  if (cmd === "status" || flags.has("--status")) return cmdStatus(asarPath);
  if (cmd === "install" || flags.has("--install")) {
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log("  T3 Code 主题与体验强化通用安装器 (t3code-enhancer)");
      console.log("  支持：主题 · 去遥测 · 输入框/额度圈 · 聊天分级 · 小窗/主侧交换");
      console.log("============================================================\n");
    }
    if (flags.has("--interactive") && !preset && !packs && !flags.has("--theme-only")) {
      const pick = await promptInteractiveAction();
      if (pick.action === "cancel") return;
      if (pick.action === "repair") return cmdRepair(flags, asarPath, {});
      if (pick.action === "uninstall") return cmdUninstall(flags, asarPath);
      if (pick.officialOnly) flags.add("--official");
      return cmdInstall(flags, asarPath, { preset: pick.preset, packs: pick.packs });
    }
    return cmdInstall(flags, asarPath, { preset, packs });
  }
  if (cmd === "repair") {
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log("  T3 Code 主题与体验强化修复工具 (t3code-enhancer)");
      console.log("============================================================\n");
    }
    return cmdRepair(flags, asarPath, { preset, packs });
  }
  if (cmd === "uninstall" || flags.has("--uninstall") || cmd === "restore") {
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log("  T3 Code 主题与体验强化一键卸载 (t3code-enhancer)");
      console.log("  将还原纯净原版 ASAR 并恢复/移除强化主题");
      console.log("============================================================\n");
    }
    return cmdUninstall(flags, asarPath);
  }
  if (cmd === "build" || flags.has("--build")) return cmdBuild(rest[0], flags, asarPath, { preset, packs });

  printUsage();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("错误:", err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  ALL_PATCHES,
  selectPatches,
  applicablePatchesForArchive,
  inspectArchive,
  summarizeModuleStates,
  resolvePristineBaseline,
  buildPatchedArchive,
  getLinuxAsarCandidates,
  getAsarPaths,
  getArchiveTargetPaths,
  isLinuxAppRunning,
  parseCliArgs,
};

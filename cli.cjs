#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { digest, readAsar, findUniqueEntry, validateEsmSyntax, writePatchedAsar } = require("./lib/asar.cjs");
const { getThemeStatus, installTheme, uninstallTheme } = require("./lib/theme-manager.cjs");
const timelineCollapse = require("./lib/patches/timeline-collapse.cjs");
const usageRings = require("./lib/patches/usage-rings.cjs");

const ALL_PATCHES = [timelineCollapse, usageRings];

function getAsarPaths() {
  assert(process.platform === "win32" && process.env.LOCALAPPDATA, "目前仅支持 Windows 版 T3 Code");
  const source = path.join(process.env.LOCALAPPDATA, "Programs", "t3code", "resources", "server.asar");
  const backup = source + ".before-t3code-enhancer";
  const legacyBackup = source + ".before-timeline-collapse";
  return { source, backup, legacyBackup };
}

function isT3Running() {
  const processes = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  return /^"T3 Code(?: \(Beta\))?\.exe"/im.test(processes);
}

function assertT3Closed() {
  assert(!isT3Running(), "请先关闭所有 T3 Code 窗口（彻底退出进程），然后再执行安装或卸载。");
}

function inspectArchive(asarPath, patches = ALL_PATCHES) {
  const asar = readAsar(asarPath);
  const modules = patches.map((p) => {
    const entry = findUniqueEntry(asar, p.targetRegex, p.id);
    const text = entry.content.toString("utf8");
    const installed = text.includes(p.marker);
    const outdated = !installed && Array.isArray(p.legacyMarkers) && p.legacyMarkers.some((m) => text.includes(m));
    const hash = digest(entry.content);
    const pristine = hash === p.originalHash;
    return { id: p.id, name: p.name, key: entry.key, installed, outdated, pristine, hash };
  });
  return { asar, modules };
}

function resolvePristineBaseline(paths) {
  // Prefer dedicated enhancer backup, then legacy timeline-collapse backup, then current source if pristine.
  for (const candidate of [paths.backup, paths.legacyBackup, paths.source]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const info = inspectArchive(candidate);
      if (info.modules.every((m) => m.pristine)) {
        return { path: candidate, asar: info.asar };
      }
    } catch {
      // ignore corrupted/incompatible candidate
    }
  }
  throw new Error(
    "找不到未修改的原版 T3 Code 0.1.11 server.asar 基线文件（可能 T3 Code 已更新版本，请先核对兼容性）。"
  );
}

function buildPatchedArchive(baselineAsar, selectedPatches, outputPath) {
  const replacements = [];
  const report = [];
  for (const patch of selectedPatches) {
    const entry = findUniqueEntry(baselineAsar, patch.targetRegex, patch.id);
    assert.equal(
      digest(entry.content),
      patch.originalHash,
      `基线文件 ${entry.key} 校验和不匹配（仅支持已验证的 T3 Code 0.1.11）`
    );
    const patchedStr = patch.apply(entry.content.toString("utf8"));
    const replacement = Buffer.from(patchedStr, "utf8");
    validateEsmSyntax(replacement, `${patch.id} (${entry.key})`);
    replacements.push({ key: entry.key, replacement });
    report.push({ id: patch.id, key: entry.key, original: patch.originalHash, patched: digest(replacement) });
  }
  writePatchedAsar(baselineAsar, replacements, outputPath);
  return report;
}

function cmdStatus() {
  const paths = getAsarPaths();
  const theme = getThemeStatus();
  const current = inspectArchive(paths.source);
  const running = isT3Running();
  console.log("=== T3 Code 主题与体验强化状态 ===");
  console.log("T3 Code 运行状态 :", running ? "运行中（安装/卸载补丁需先退出）" : "已退出");
  console.log(
    "主题文件 (chatgpt-app) :",
    theme.installed
      ? `${theme.matchesBundled ? "已安装（最新" : "已安装（与项目内版本有差异"} · ${theme.active ? "已激活" : "未激活"}）`
      : "未安装"
  );
  console.log("主题备份 :", theme.hasBackup ? "存在" : "无");
  console.log("安装包路径 :", paths.source);
  console.log("原版 ASAR 备份 :", fs.existsSync(paths.backup) ? paths.backup : fs.existsSync(paths.legacyBackup) ? `${paths.legacyBackup}（旧版备份，安装时将自动继承）` : "尚未创建");
  console.log("\n前端补丁模块：");
  for (const m of current.modules) {
    const state = m.installed
      ? "已安装（最新）"
      : m.outdated
        ? "已安装旧版（关闭 T3 Code 后重新运行 install.cmd 升级）"
        : m.pristine
          ? "未安装（兼容原版）"
          : "未识别版本";
    console.log(`  - [${m.installed ? "✓" : m.outdated ? "↑" : " "}] ${m.id} (${m.name}) : ${state}`);
  }
}

function cmdInstall(flags) {
  const themeOnly = flags.has("--theme-only");
  const patchOnly = flags.has("--patch-only");
  const selectedPatches = ALL_PATCHES.filter((p) => !flags.has(`--no-${p.id}`));

  if (!patchOnly) {
    const res = installTheme();
    console.log(`[主题] 已安装 chatgpt-app 主题 -> ${res.targetPath}`);
    if (res.backupPath) console.log(`[主题] 原主题已备份 -> ${res.backupPath}`);
  }

  if (themeOnly) return;

  assert(selectedPatches.length > 0, "未选择任何需要安装的前端补丁模块。");
  assertT3Closed();
  const paths = getAsarPaths();
  const baseline = resolvePristineBaseline(paths);
  const staging = `${paths.source}.${randomUUID()}.tmp`;
  try {
    console.log(`[补丁] 正在基于干净原版基线构建（${selectedPatches.map((p) => p.id).join(" + ")}）...`);
    const report = buildPatchedArchive(baseline.asar, selectedPatches, staging);
    if (!fs.existsSync(paths.backup)) {
      fs.copyFileSync(baseline.path, paths.backup, fs.constants.COPYFILE_EXCL);
      assert(readAsar(paths.backup).archive.equals(baseline.asar.archive), "原版备份校验不一致");
    }
    assertT3Closed();
    fs.renameSync(staging, paths.source);
    for (const r of report) {
      console.log(`[补丁] ✓ ${r.id} -> ${r.key} (${r.patched.slice(0, 12)})`);
    }
    console.log(`[备份] 原版安全备份位于：${paths.backup}`);
    console.log("\n全部安装完成！现在可以重新启动 T3 Code（在设置 -> 外观中确保选中 ChatGPT App 主题）。");
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
}

function cmdUninstall(flags) {
  const keepTheme = flags.has("--keep-theme");
  const themeOnly = flags.has("--theme-only");

  if (!keepTheme) {
    const res = uninstallTheme();
    console.log(`[主题] 卸载结果：${res.action} (${res.targetPath})`);
  }
  if (themeOnly) return;

  assertT3Closed();
  const paths = getAsarPaths();
  const backupPath = fs.existsSync(paths.backup) ? paths.backup : fs.existsSync(paths.legacyBackup) ? paths.legacyBackup : null;
  if (!backupPath) {
    const current = inspectArchive(paths.source);
    if (current.modules.every((m) => m.pristine)) {
      console.log("[补丁] 当前 server.asar 已是纯净原版，无需还原。");
      return;
    }
    throw new Error("未找到原版 server.asar 备份文件，无法自动还原。");
  }

  const original = inspectArchive(backupPath);
  assert(original.modules.every((m) => m.pristine), `备份文件 ${backupPath} 校验不是纯净原版`);

  const staging = `${paths.source}.${randomUUID()}.tmp`;
  try {
    fs.copyFileSync(backupPath, staging, fs.constants.COPYFILE_EXCL);
    assert(readAsar(staging).archive.equals(original.asar.archive), "还原文件校验不一致");
    assertT3Closed();
    fs.renameSync(staging, paths.source);
    console.log(`[补丁] ✓ 已逐字节还原纯净原版 server.asar（来源：${backupPath}）`);
    console.log("\n卸载完成！现在可以重新启动 T3 Code。");
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
}

function cmdBuild(outputPath, flags) {
  assert(outputPath, "请提供输出路径：node cli.cjs build <output.asar>");
  const paths = getAsarPaths();
  const baseline = resolvePristineBaseline(paths);
  const selectedPatches = ALL_PATCHES.filter((p) => !flags.has(`--no-${p.id}`));
  const resolved = path.resolve(outputPath);
  if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  const report = buildPatchedArchive(baseline.asar, selectedPatches, resolved);
  console.log(JSON.stringify({ output: resolved, modules: report }, null, 2));
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args.find((a) => !a.startsWith("--")) || "status";
  const rest = args.filter((a) => !a.startsWith("--")).slice(1);
  const flags = new Set(args.filter((a) => a.startsWith("--")));

  if (cmd === "status" || cmd === "--status") return cmdStatus();
  if (cmd === "install" || cmd === "--install") {
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log("  T3 Code 主题与体验强化一键安装 (t3code-enhancer)");
      console.log("  包含：ChatGPT App 主题 + 折叠联动 + 加号菜单与可点击圆环");
      console.log("============================================================\n");
    }
    return cmdInstall(flags);
  }
  if (cmd === "uninstall" || cmd === "--uninstall" || cmd === "restore") {
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log("  T3 Code 主题与体验强化一键卸载 (t3code-enhancer)");
      console.log("  将还原纯净原版 server.asar 并恢复/移除强化主题");
      console.log("============================================================\n");
    }
    return cmdUninstall(flags);
  }
  if (cmd === "build" || cmd === "--build") return cmdBuild(rest[0], flags);

  console.log(`用法:
  node cli.cjs status                  查看主题与补丁安装状态
  node cli.cjs install                 安装全部模块（主题 + 折叠联动 + 双层圆环/用量浮层）
  node cli.cjs install --theme-only    仅安装 ChatGPT App 主题（无需关闭 T3 Code）
  node cli.cjs install --patch-only    仅安装前端补丁（保留当前主题）
  node cli.cjs uninstall               卸载全部强化并逐字节还原原版 server.asar
  node cli.cjs uninstall --keep-theme  仅卸载前端补丁，保留主题
  node cli.cjs build <output.asar>     在副本上试构建并校验（不改动已安装的 T3 Code）`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("错误:", err.message);
    process.exitCode = 1;
  }
}

module.exports = { ALL_PATCHES, inspectArchive, resolvePristineBaseline, buildPatchedArchive };

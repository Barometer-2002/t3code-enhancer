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
const SUPPORTED_VERSIONS = ["0.1.11", "0.1.12"];

function getAsarPaths() {
  assert(process.platform === "win32" && process.env.LOCALAPPDATA, "目前仅支持 Windows 版 T3 Code");
  const source = path.join(process.env.LOCALAPPDATA, "Programs", "t3code", "resources", "server.asar");
  const backup = source + ".before-t3code-enhancer";
  const legacyBackup = source + ".before-timeline-collapse";
  return { source, backup, legacyBackup };
}

function isT3Running() {
  const processes = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  return /^"T3 Code(?: \((?:Beta|Nightly)\))?\.exe"/im.test(processes);
}

function assertT3Closed() {
  assert(!isT3Running(), "请先关闭所有 T3 Code 窗口（彻底退出进程），然后再执行安装或卸载。");
}

function getPatchTargets(patch) {
  if (Array.isArray(patch.targets) && patch.targets.length > 0) return patch.targets;
  return [
    {
      version: patch.version || null,
      targetRegex: patch.targetRegex,
      originalHash: patch.originalHash,
      apply: patch.apply,
    },
  ];
}

function resolvePatchTarget(asar, patch) {
  const targets = getPatchTargets(patch);
  if (targets.length === 1) {
    const target = targets[0];
    const entry = findUniqueEntry(asar, target.targetRegex, patch.id);
    const text = entry.content.toString("utf8");
    const installed = text.includes(patch.marker);
    const outdated = !installed && Array.isArray(patch.legacyMarkers) && patch.legacyMarkers.some((m) => text.includes(m));
    const hash = digest(entry.content);
    const pristine = hash === target.originalHash;
    return { target, entry, installed, outdated, pristine, hash };
  }

  const candidates = [];
  for (const target of targets) {
    const matches = asar.entries.filter(({ key }) => target.targetRegex.test(key));
    if (matches.length !== 1) continue;
    const entry = findUniqueEntry(asar, target.targetRegex, `${patch.id}@${target.version || "unknown"}`);
    const text = entry.content.toString("utf8");
    const installed = text.includes(patch.marker);
    const outdated = !installed && Array.isArray(patch.legacyMarkers) && patch.legacyMarkers.some((m) => text.includes(m));
    const hash = digest(entry.content);
    const pristine = hash === target.originalHash;
    candidates.push({ target, entry, installed, outdated, pristine, hash });
  }

  const matched =
    candidates.find((c) => c.pristine) ||
    candidates.find((c) => c.installed || c.outdated) ||
    candidates[0];
  if (matched) return matched;

  const supported = targets.map((t) => t.version).filter(Boolean).join(" / ") || SUPPORTED_VERSIONS.join(" / ");
  throw new Error(`Could not uniquely identify ${patch.id} (supported versions: ${supported})`);
}

function inspectArchive(asarPath, patches = ALL_PATCHES) {
  const asar = readAsar(asarPath);
  const modules = patches.map((p) => {
    const resolved = resolvePatchTarget(asar, p);
    return {
      id: p.id,
      name: p.name,
      version: resolved.target.version || null,
      key: resolved.entry.key,
      installed: resolved.installed,
      outdated: resolved.outdated,
      pristine: resolved.pristine,
      hash: resolved.hash,
    };
  });
  const versions = [...new Set(modules.map((m) => m.version).filter(Boolean))];
  const detectedVersion = versions.length === 1 && modules.every((m) => m.version === versions[0]) ? versions[0] : null;
  return { asar, modules, detectedVersion };
}

function resolvePristineBaseline(paths) {
  let currentInfo = null;
  if (fs.existsSync(paths.source)) {
    try {
      currentInfo = inspectArchive(paths.source);
      if (currentInfo.modules.every((m) => m.pristine)) {
        return { path: paths.source, asar: currentInfo.asar, detectedVersion: currentInfo.detectedVersion };
      }
    } catch {
      // Fall back to backup candidates if current source is corrupted or unreadable.
    }
  }

  for (const candidate of [paths.backup, paths.legacyBackup]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const info = inspectArchive(candidate);
      if (!info.modules.every((m) => m.pristine)) continue;
      if (currentInfo?.detectedVersion && info.detectedVersion && info.detectedVersion !== currentInfo.detectedVersion) {
        continue;
      }
      return { path: candidate, asar: info.asar, detectedVersion: info.detectedVersion };
    } catch {
      // ignore corrupted/incompatible candidate
    }
  }
  throw new Error(
    `找不到未修改的原版 T3 Code (${SUPPORTED_VERSIONS.join(" / ")}) server.asar 基线文件（可能 T3 Code 已更新版本，请先核对兼容性）。`
  );
}

function archiveStaleBackup(backupPath) {
  let label = "previous";
  try {
    const info = inspectArchive(backupPath);
    if (info.detectedVersion) label = info.detectedVersion;
  } catch {
    // Keep generic label when old backup version cannot be inspected.
  }
  let archivedPath = `${backupPath}.${label}`;
  if (fs.existsSync(archivedPath)) {
    archivedPath = `${backupPath}.${label}-${Date.now()}`;
  }
  fs.renameSync(backupPath, archivedPath);
  return archivedPath;
}

function buildPatchedArchive(baselineAsar, selectedPatches, outputPath) {
  const replacements = [];
  const report = [];
  for (const patch of selectedPatches) {
    const resolved = resolvePatchTarget(baselineAsar, patch);
    const supported = getPatchTargets(patch).map((t) => t.version).filter(Boolean).join(" / ") || SUPPORTED_VERSIONS.join(" / ");
    assert.equal(
      resolved.hash,
      resolved.target.originalHash,
      `基线文件 ${resolved.entry.key} 校验和不匹配（仅支持已验证的 T3 Code ${supported}）`
    );
    const patchedStr = resolved.target.apply(resolved.entry.content.toString("utf8"));
    const replacement = Buffer.from(patchedStr, "utf8");
    validateEsmSyntax(replacement, `${patch.id} (${resolved.entry.key})`);
    replacements.push({ key: resolved.entry.key, replacement });
    report.push({
      id: patch.id,
      version: resolved.target.version || null,
      key: resolved.entry.key,
      original: resolved.target.originalHash,
      patched: digest(replacement),
    });
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
  console.log("T3 Code 检测版本 :", current.detectedVersion || "未识别/混合版本");
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
    const verTag = m.version ? ` [v${m.version}]` : "";
    console.log(`  - [${m.installed ? "✓" : m.outdated ? "↑" : " "}] ${m.id}${verTag} (${m.name}) : ${state}`);
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
    const verText = baseline.detectedVersion ? `v${baseline.detectedVersion} ` : "";
    console.log(`[补丁] 正在基于干净原版基线 ${verText}构建（${selectedPatches.map((p) => p.id).join(" + ")}）...`);
    const report = buildPatchedArchive(baseline.asar, selectedPatches, staging);
    if (fs.existsSync(paths.backup)) {
      const existingBackup = readAsar(paths.backup);
      if (!existingBackup.archive.equals(baseline.asar.archive)) {
        const archived = archiveStaleBackup(paths.backup);
        console.log(`[备份] 检测到跨版本旧版备份，已归档至：${archived}`);
      }
    }
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
  let current = null;
  try {
    current = inspectArchive(paths.source);
  } catch {
    current = null;
  }

  if (!backupPath) {
    if (current && current.modules.every((m) => m.pristine)) {
      console.log("[补丁] 当前 server.asar 已是纯净原版，无需还原。");
      return;
    }
    throw new Error("未找到原版 server.asar 备份文件，无法自动还原。");
  }

  const original = inspectArchive(backupPath);
  assert(original.modules.every((m) => m.pristine), `备份文件 ${backupPath} 校验不是纯净原版`);
  if (current?.detectedVersion && original.detectedVersion && current.detectedVersion !== original.detectedVersion) {
    if (current.modules.every((m) => m.pristine)) {
      console.log(`[补丁] 当前 server.asar (${current.detectedVersion}) 已是纯净原版，已跳过旧版本备份还原（${backupPath} 为 ${original.detectedVersion}）。`);
      return;
    }
    throw new Error(
      `备份文件版本 (${original.detectedVersion}) 与当前安装版本 (${current.detectedVersion}) 不匹配，已拒绝跨版本覆盖。`
    );
  }

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
  console.log(JSON.stringify({ detectedVersion: baseline.detectedVersion, output: resolved, modules: report }, null, 2));
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

module.exports = { ALL_PATCHES, getPatchTargets, resolvePatchTarget, inspectArchive, resolvePristineBaseline, buildPatchedArchive };

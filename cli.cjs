#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { writeVerifiedAsarCopy } = require("./lib/asar.cjs");
const {
  ENHANCER_VERSION,
  ENHANCER_TAG,
  T3_BASELINE_VERSION,
} = require("./lib/version.cjs");
const {
  ALL_PATCHES,
  selectPatches,
  matchesSelectedPatches,
  inferRepairPlanOptions,
  applicablePatchesForArchive,
  getLinuxAsarCandidates,
  getAsarPaths,
  getArchiveTargetPaths,
  isLinuxAppRunning,
  isT3Running,
  assertT3Closed,
  inspectArchive,
  inspectCompatibleSource,
  summarizeModuleStates,
  resolvePristineBaseline,
  buildPatchedArchive,
} = require("./lib/engine.cjs");
const { getThemeStatus, formatThemeStatusText, prepareThemeTransaction, reportThemeUninstall } = require("./lib/theme-manager.cjs");
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
    if (name.startsWith(base + ".") && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.tmp$/i.test(name.slice(base.length + 1))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

function getArchiveCompatibilityTier(inspected) {
  const modules = inspected?.modules;
  if (!modules?.length || !summarizeModuleStates(modules).allRecognized) {
    return { tier: "incompatible", label: "不兼容 (incompatible)" };
  }
  if (modules.some(({ compat }) => compat === "auto-adapted")) {
    return { tier: "auto-adapted", label: "跨版本自动适配 (auto-adapted)" };
  }
  return { tier: "verified", label: "已验证 (verified)" };
}

function printVersion() {
  console.log(`t3code-enhancer ${ENHANCER_TAG} (目标基线: T3 Code ${T3_BASELINE_VERSION})`);
}

function cmdStatus(asarOverride) {
  const theme = getThemeStatus();
  console.log(`=== T3 Code 主题与体验强化状态 (t3code-enhancer ${ENHANCER_TAG}) ===`);
  console.log("主题文件 (chatgpt-app) :", formatThemeStatusText(theme));
  console.log("主题备份 :", theme.hasBackup ? "存在" : "无");

  let targetPaths;
  try {
    targetPaths = getArchiveTargetPaths(asarOverride);
  } catch (err) {
    console.log("安装包路径 :", `未检测到（${err.message}）`);
    return;
  }

  const upgradeHint = process.platform === "win32" ? "install.cmd" : "node cli.cjs install";
  try {
    const running = isT3Running(targetPaths[0].source);
    console.log("T3 Code 运行状态 :", running ? "运行中（安装/修复/卸载补丁需先退出）" : "已退出");
  } catch (err) {
    console.log("T3 Code 运行状态 :", `无法检查（${err.message}）`);
  }
  const archives = [];
  for (const paths of targetPaths) {
    const label = targetPaths.length > 1 ? ` (${path.basename(paths.source)})` : "";
    console.log(`安装包路径${label} :`, paths.source);
    try {
      const current = inspectArchive(paths.source);
      archives.push(current);
      const compat = getArchiveCompatibilityTier(current);
      const versionStr = current.appVersion ? `v${current.appVersion}` : "未知版本";
      const enhancerStr = current.enhancerVersion ? ` · 构建版本 v${current.enhancerVersion}` : "";
      console.log(`检测版本与兼容性${label} : ${versionStr} · ${compat.label}${enhancerStr}`);
    } catch (err) {
      console.log(`检测版本与兼容性${label} : 未知版本 · 不兼容 (incompatible) - ${err.message}`);
    }
    console.log(`原版 ASAR 备份${label} :`, fs.existsSync(paths.backup) ? paths.backup : fs.existsSync(paths.legacyBackup) ? `${paths.legacyBackup}（旧版备份，安装时将自动继承）` : "尚未创建");
  }
  console.log("\n前端与桌面增强模块：");
  for (const current of archives) {
    for (const m of current.modules) {
      const state = m.installed
        ? "已安装（最新）"
        : m.outdated
          ? `已安装旧版（关闭 T3 Code 后重新运行 ${upgradeHint} 升级）`
          : m.pristine
            ? (m.compat === "auto-adapted" ? "未安装（跨版本自动适配）" : "未安装（兼容原版）")
            : m.modified || current.modules.some((related) => related.key === m.key && (related.installed || related.outdated))
              ? "未安装（同一文件已有其他补丁）"
              : "未识别版本（不兼容）";
      console.log(`  - [${m.installed ? "✓" : m.outdated ? "↑" : " "}] ${m.id} (${m.name}) : ${state}`);
    }
  }
}

function stageAsarPlan(plan, paths, staging, appliedPatchIds = null) {
  const asarName = path.basename(paths.source);
  const baseline = resolvePristineBaseline(paths, plan.selectedPatches);
  const targetPatches = applicablePatchesForArchive(baseline.asar, plan.selectedPatches);
  for (const p of targetPatches) appliedPatchIds?.add(p.id);
  const versionStr = baseline.appVersion ? `v${baseline.appVersion}` : "未知版本";
  if (targetPatches.length > 0) {
    const compatTier = getArchiveCompatibilityTier(baseline);
    console.log(`[补丁] 正在基于干净原版基线构建 ${asarName} [${versionStr} · 兼容性: ${compatTier.label}]（${targetPatches.map((p) => p.id).join(" + ")}）...`);
    const report = buildPatchedArchive(baseline.asar, targetPatches, staging, { plan });
    if (baseline.path !== paths.backup) {
      writeVerifiedAsarCopy(baseline.path, paths.backup, {
        overwrite: true,
        expectedArchive: baseline.asar.archive,
        label: "原版备份校验不一致",
      });
    }
    return () => {
      for (const r of report) {
        const compatTag = r.compat === "auto-adapted" ? " (跨版本自动适配)" : "";
        console.log(`[补丁] ✓ ${r.id} -> ${r.key} (${r.patched.slice(0, 12)})${compatTag}`);
      }
      console.log(`[备份] 原版安全备份位于：${paths.backup}`);
    };
  }
  if (baseline.path === paths.source) return;
  writeVerifiedAsarCopy(baseline.path, staging, { expectedArchive: baseline.asar.archive });
  return () => console.log(`[补丁] 已还原纯净原版 ${asarName} [${versionStr}]（来源：${baseline.path}）`);
}

function runAsarTransaction(targetPaths, stage, { cleanup = false, assertClosed = assertT3Closed, afterCommit = null, onRollback = null } = {}) {
  assertSafeAsarTargets(targetPaths);
  const lock = path.join(path.dirname(targetPaths[0].source), ".t3code-enhancer-asar.lock");
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`已有 ASAR 维护命令持锁。确认命令已退出后可移除空锁目录：${lock}`, { cause: error });
  }
  const files = targetPaths.map((paths) => {
    const stem = `${paths.source}.${randomUUID()}`;
    return { paths, staging: `${stem}.tmp`, snapshot: `${stem}.rollback`, replaced: false, keepSnapshot: false };
  });
  let txResult;
  try {
    for (const file of files) {
      assertClosed(file.paths.source);
      if (cleanup) cleanupStaleAsarStaging(file.paths.source);
      file.report = stage(file.paths, file.staging);
    }
    const replacements = files.filter((file) => fs.existsSync(file.staging));
    for (const { paths: { source }, snapshot, staging } of replacements) {
      const stat = fs.statSync(source, { throwIfNoEntry: false });
      if (!stat) continue;
      fs.copyFileSync(source, snapshot, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(staging, stat.mode & 0o777);
    }
    try {
      for (const file of replacements) {
        assertClosed(file.paths.source);
        assertSafeAsarTargets([file.paths]);
        fs.renameSync(file.staging, file.paths.source);
        file.replaced = true;
      }
      if (afterCommit) {
        txResult = afterCommit();
      }
    } catch (error) {
      const rollbackErrors = [];
      if (onRollback) {
        try {
          onRollback();
        } catch (rbErr) {
          rollbackErrors.push(`主题事务回滚（${rbErr.message}）`);
        }
      }
      for (const file of replacements.slice().reverse()) {
        if (!file.replaced) continue;
        try {
          if (fs.existsSync(file.snapshot)) fs.renameSync(file.snapshot, file.paths.source);
          else fs.unlinkSync(file.paths.source);
        } catch (rollbackError) {
          file.keepSnapshot = true;
          rollbackErrors.push(`${file.paths.source}（${rollbackError.message}，回滚副本：${file.snapshot}）`);
        }
      }
      const committedFiles = replacements.filter((f) => f.replaced).map((f) => f.paths.source);
      if (rollbackErrors.length) {
        const committedHint = committedFiles.length ? `已提交目标：${committedFiles.join("、")}。` : "";
        throw new Error(`${error.message}。${committedHint}回滚失败：${rollbackErrors.join("、")}`, { cause: error });
      }
      throw error;
    }
    for (const file of files) file.report?.();
    return txResult;
  } finally {
    try {
      for (const file of files) {
        fs.rmSync(file.staging, { force: true });
        if (!file.keepSnapshot) fs.rmSync(file.snapshot, { force: true });
      }
    } finally {
      fs.rmdirSync(lock);
    }
  }
}

const MACOS_BUNDLE_ASAR_RE = /(?:^|[\\/])[^\\/]+\.app[\\/]Contents[\\/]Resources[\\/][^\\/]+\.asar$/i;
const MACOS_BUNDLE_RESOURCES_RE = /(?:^|[\\/])[^\\/]+\.app[\\/]Contents[\\/]Resources$/i;

function resolveCanonicalPath(filePath, realpathFn = fs.realpathSync) {
  let cur = path.resolve(String(filePath || ""));
  const tail = [];
  while (true) {
    try {
      cur = realpathFn(cur);
      break;
    } catch (error) {
      const parent = path.dirname(cur);
      if (parent === cur || !["ENOENT", "ENOTDIR"].includes(error?.code)) break;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return tail.length ? path.join(cur, ...tail) : cur;
}

function isMacosBundleAsarPath(filePath, realpathFn = fs.realpathSync) {
  const raw = String(filePath || "");
  if (!raw) return false;
  const resolved = path.resolve(raw);
  const canonical = resolveCanonicalPath(resolved, realpathFn);
  const canonicalParent = resolveCanonicalPath(path.dirname(resolved), realpathFn);
  return (
    MACOS_BUNDLE_ASAR_RE.test(resolved) ||
    MACOS_BUNDLE_ASAR_RE.test(canonical) ||
    MACOS_BUNDLE_RESOURCES_RE.test(canonicalParent)
  );
}

function assertSafeAsarTargets(targetPaths) {
  for (const paths of targetPaths) {
    for (const candidate of [paths.source, paths.backup, paths.legacyBackup].filter(Boolean)) {
      assert(
        !isMacosBundleAsarPath(candidate),
        `禁止通过通用 --asar 路径原地修改 macOS .app 包内的 ASAR（会破坏签名与 Electron ASAR 完整性校验）：${paths.source}\n请改用 --app <T3 Code .app 路径> 或运行 node macos.cjs install/repair/uninstall，在独立副本上完成重建并重签名。`
      );
    }
  }
}

function reportSkippedPatches(plan, appliedPatchIds, asarOverride) {
  const skipped = plan.selectedPatches.filter((p) => !appliedPatchIds.has(p.id));
  if (skipped.length === 0) return;
  const ids = skipped.map((p) => p.id).join(", ");
  const hasExplicitSingle = Boolean(asarOverride || process.env.T3CODE_ASAR);
  console.log(
    hasExplicitSingle
      ? `[提示] 本次通过显式单档模式执行，以下跨档案补丁未在目标档案中命中而跳过：${ids}（若在 Windows 上仅指定了 server.asar，桌面端补丁需移除 --asar 或单独对 app.asar 再运行一次安装）。`
      : `[提示] 以下已选补丁未在目标档案中匹配到对应文件而跳过：${ids}。`
  );
}

function applyAsarPlan(plan, asarOverride, options = {}) {
  const targetPaths = getArchiveTargetPaths(asarOverride);
  assertSafeAsarTargets(targetPaths);
  const appliedPatchIds = new Set();
  const afterResult = runAsarTransaction(
    targetPaths,
    (paths, staging) => stageAsarPlan(plan, paths, staging, appliedPatchIds),
    {
      cleanup: options.repair,
      assertClosed: options.assertClosed,
      afterCommit: options.afterCommit,
      onRollback: options.onRollback,
    }
  );
  return { appliedPatchIds, afterResult };
}

function cmdInstall(flags, asarOverride, planOptions = {}) {
  const plan = resolveInstallPlan(ALL_PATCHES, {
    preset: planOptions.preset || null,
    packs: planOptions.packs || null,
    flags,
    excludePatchIds: planOptions.excludePatchIds || [],
    exactPatchIds: planOptions.exactPatchIds || null,
  });

  if (plan.needsLayer3Warning) {
    console.log("[提示] --official 仅安装 Layer 1 官方样式层，部分功能补丁的视觉样式可能不完整；纯官方主题建议配合 --preset theme-only 或 --preset clean 使用。");
  }

  console.log(`[方案] ${plan.presetId} | 模块: ${plan.packIds.join(", ")}`);
  const themeTx = plan.includeTheme
    ? prepareThemeTransaction(undefined, { officialOnly: plan.officialOnly, createSettingsIfMissing: true })
    : null;

  let themeRes = null;
  if (plan.themeOnly) {
    try {
      themeRes = themeTx.commit();
    } catch (err) {
      try { themeTx.rollback(); } catch {}
      throw err;
    }
  } else {
    const { appliedPatchIds, afterResult } = applyAsarPlan(plan, asarOverride, {
      assertClosed: planOptions.assertClosed,
      afterCommit: themeTx ? () => themeTx.commit() : null,
      onRollback: themeTx ? () => themeTx.rollback() : null,
    });
    themeRes = afterResult;
    reportSkippedPatches(plan, appliedPatchIds, asarOverride);
  }

  if (plan.includeTheme && themeRes) {
    console.log(`[主题] 已安装 chatgpt-app 主题（${plan.officialOnly ? "仅官方稳定层 Layer 1" : "完整分层主题 Layer 1-3"}） -> ${themeRes.targetPath}`);
    if (themeRes.backupPath) console.log(`[主题] 原主题已备份 -> ${themeRes.backupPath}`);
    if (!themeRes.activated) console.log("[警告] 未能在 settings.json 中自动激活主题（配置文件可能损坏），请在设置 -> 外观中手动选择 ChatGPT App。");
  } else if (plan.presetId === "privacy-only") {
    console.log("[主题] 纯去遥测模式：保持现有主题不变。");
  }

  if (plan.themeOnly) {
    console.log("\n主题安装完成（无需重启 T3 Code，在设置 -> 外观中切换生效）。");
    return;
  }

  console.log("\n全部安装完成！现在可以重新启动 T3 Code。");
}

function resolveRepairPlan(flags, asarOverride, planOptions = {}) {
  const explicitSelection = Boolean(
    planOptions.preset || planOptions.packs || flags.has("--theme-only") || flags.has("--patch-only")
  );
  if (explicitSelection) {
    return resolveInstallPlan(ALL_PATCHES, {
      preset: planOptions.preset || null,
      packs: planOptions.packs || null,
      flags,
      excludePatchIds: planOptions.excludePatchIds || [],
      exactPatchIds: planOptions.exactPatchIds || null,
    });
  }
  const effectiveFlags = new Set(flags);
  const themeStatus = getThemeStatus();
  const mergedModules = [];
  const savedPlans = [];
  for (const paths of getArchiveTargetPaths(asarOverride)) {
    try {
      const inspected = inspectArchive(paths.source);
      mergedModules.push(...inspected.modules);
      if (inspected.buildMeta?.plan) savedPlans.push(inspected.buildMeta.plan);
    } catch {
      // Ignore a corrupt archive so healthy siblings still inform the repair plan.
    }
  }
  const inferred = inferRepairPlanOptions(mergedModules, themeStatus, effectiveFlags, savedPlans);
  if (inferred.officialOnly) effectiveFlags.add("--official");
  if (inferred.patchOnly) effectiveFlags.add("--patch-only");
  return resolveInstallPlan(ALL_PATCHES, {
    preset: inferred.preset,
    packs: inferred.packs,
    flags: effectiveFlags,
    excludePatchIds: inferred.excludePatchIds,
    exactPatchIds: inferred.exactPatchIds,
  });
}

function cmdRepair(flags, asarOverride, planOptions = {}) {
  const plan = resolveRepairPlan(flags, asarOverride, planOptions);
  if (plan.needsLayer3Warning) {
    console.log("[提示] --official 仅安装 Layer 1 官方样式层，部分功能补丁的视觉样式可能不完整；纯官方主题建议配合 --preset theme-only 或 --preset clean 使用。");
  }
  console.log(`[方案] ${plan.presetId} | 模块: ${plan.packIds.join(", ")}`);
  console.log("[修复] 正在清理残留临时文件并检查主题与 ASAR 完整性...");
  const themeTx = plan.includeTheme
    ? prepareThemeTransaction(undefined, { officialOnly: plan.officialOnly, createSettingsIfMissing: true })
    : null;
  let themeRes = null;
  if (plan.themeOnly) {
    try {
      themeRes = themeTx.commit();
    } catch (err) {
      try { themeTx.rollback(); } catch {}
      throw err;
    }
  } else {
    const { appliedPatchIds, afterResult } = applyAsarPlan(plan, asarOverride, {
      repair: true,
      assertClosed: planOptions.assertClosed,
      afterCommit: themeTx ? () => themeTx.commit() : null,
      onRollback: themeTx ? () => themeTx.rollback() : null,
    });
    themeRes = afterResult;
    reportSkippedPatches(plan, appliedPatchIds, asarOverride);
  }
  if (plan.includeTheme && themeRes) {
    console.log(`[修复] 主题已重新校验并写入 -> ${themeRes.targetPath}`);
    if (!themeRes.activated) console.log("[警告] 未能在 settings.json 中自动激活主题，请在设置 -> 外观中手动选择 ChatGPT App。");
  }
  if (plan.themeOnly) {
    console.log("\n主题修复完成（无需重启 T3 Code）。");
    return;
  }
  console.log("\n修复完成！现在可以重新启动 T3 Code。");
}

function cmdUninstall(flags, asarOverride, options = {}) {
  const keepTheme = flags.has("--keep-theme");
  const themeOnly = flags.has("--theme-only");
  const purgeBackup = flags.has("--purge-backup");

  if (!themeOnly) {
    const targetPaths = getArchiveTargetPaths(asarOverride);
    assertSafeAsarTargets(targetPaths);
    runAsarTransaction(targetPaths, (paths, staging) => {
      const asarName = path.basename(paths.source);
      const current = inspectCompatibleSource(paths.source);
      const alreadyPristine = Boolean(current && !current.unreadable && current.modules.every((module) => module.pristine));
      if (!alreadyPristine) {
        const original = resolvePristineBaseline(paths);
        assert(original.path !== paths.source, `未找到原版 ${asarName} 备份文件，无法自动还原。`);
        writeVerifiedAsarCopy(original.path, staging, {
          expectedArchive: original.asar.archive,
          label: "还原文件校验不一致",
        });
      }
      return () => {
        console.log(`[补丁] ${alreadyPristine ? "原版已完整" : "已逐字节还原纯净原版"} ${asarName}`);
        if (purgeBackup) {
          for (const backup of new Set([paths.backup, paths.legacyBackup])) {
            if (!fs.existsSync(backup)) continue;
            fs.unlinkSync(backup);
            console.log(`[备份] 已移除：${backup}`);
          }
        }
      };
    }, { cleanup: true, assertClosed: options.assertClosed });
  }

  if (!keepTheme) reportThemeUninstall();
  if (themeOnly) return;

  console.log("\n卸载完成！现在可以重新启动 T3 Code。");
}

function cmdBuild(outputPath, flags, asarOverride, planOptions = {}) {
  assert(outputPath, "请提供输出路径：node cli.cjs build <output.asar>");
  const plan = resolveInstallPlan(ALL_PATCHES, {
    preset: planOptions.preset || null,
    packs: planOptions.packs || null,
    flags,
  });
  const baseline = resolvePristineBaseline(getAsarPaths(asarOverride), plan.selectedPatches);
  const resolved = path.resolve(outputPath);
  assert(!fs.existsSync(resolved), `构建输出已存在，请指定新文件：${resolved}`);
  const targetPatches = applicablePatchesForArchive(baseline.asar, plan.selectedPatches);
  const staging = `${resolved}.${randomUUID()}.tmp`;
  try {
    const report = buildPatchedArchive(baseline.asar, targetPatches, staging, { plan });
    try {
      fs.linkSync(staging, resolved);
    } catch (error) {
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK"].includes(error.code)) throw error;
      fs.copyFileSync(staging, resolved, fs.constants.COPYFILE_EXCL);
    }
    console.log(JSON.stringify({
      output: resolved,
      enhancerVersion: ENHANCER_VERSION,
      enhancerTag: ENHANCER_TAG,
      preset: plan.presetId,
      packs: plan.packIds,
      appVersion: baseline.appVersion || null,
      compatibility: getArchiveCompatibilityTier(baseline).tier,
      modules: report,
    }, null, 2));
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
}

const CLI_COMMANDS = new Set(["status", "install", "repair", "uninstall", "restore", "build", "help", "version"]);

function isBundlePathArg(value) {
  return typeof value === "string" && (/\.AppImage$/i.test(value) || /\.app[/\\]*$/i.test(value));
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
      assert(i + 1 < remaining.length && remaining[i + 1].trim() && !remaining[i + 1].startsWith("-"), "请为 --asar 提供路径参数");
      asarPath = remaining[++i];
    } else if (arg.startsWith("--asar=")) {
      asarPath = arg.slice("--asar=".length);
      assert(asarPath.trim(), "请为 --asar= 提供路径参数");
    } else if (arg === "--appimage") {
      assert(i + 1 < remaining.length && remaining[i + 1].trim() && !remaining[i + 1].startsWith("-"), "请为 --appimage 提供路径参数");
      appImagePath = remaining[++i];
    } else if (arg.startsWith("--appimage=")) {
      appImagePath = arg.slice("--appimage=".length);
      assert(appImagePath.trim(), "请为 --appimage= 提供路径参数");
    } else if (arg === "--app") {
      assert(i + 1 < remaining.length && remaining[i + 1].trim() && !remaining[i + 1].startsWith("-"), "请为 --app 提供路径参数");
      macAppPath = remaining[++i];
    } else if (arg.startsWith("--app=")) {
      macAppPath = arg.slice("--app=".length);
      assert(macAppPath.trim(), "请为 --app= 提供路径参数");
    } else if (arg === "-h") {
      flags.add("--help");
    } else if (arg === "-v") {
      flags.add("--version");
    } else if (arg.startsWith("--")) {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }
  const hasExplicitCommandFlag =
    flags.has("--help") || flags.has("--version") || flags.has("--install") || flags.has("--repair") ||
    flags.has("--uninstall") || flags.has("--build") || flags.has("--status") || flags.has("--interactive");
  let rawCmd;
  let rest;
  if (positional.length > 0 && CLI_COMMANDS.has(positional[0])) {
    rawCmd = positional[0] === "restore" ? "uninstall" : positional[0];
    rest = positional.slice(1);
  } else if (hasExplicitCommandFlag) {
    rawCmd = null;
    rest = positional;
  } else if (positional.length > 0 && isBundlePathArg(positional[0])) {
    rawCmd = "install";
    rest = positional;
  } else {
    rawCmd = positional[0];
    rest = positional.slice(1);
  }
  const resolvedCmd = rawCmd
    || (flags.has("--help") ? "help"
      : flags.has("--version") ? "version"
      : flags.has("--install") ? "install"
      : flags.has("--repair") ? "repair"
      : flags.has("--uninstall") ? "uninstall"
      : flags.has("--build") ? "build"
      : flags.has("--status") ? "status"
      : flags.has("--interactive") ? "install"
      : (appImagePath || macAppPath) ? "install"
      : "status");
  return {
    cmd: resolvedCmd,
    rest,
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

function buildDelegatedArgs(parsed, rawArgv, extraInputPath) {
  const commandAliases = new Set(["status", "install", "repair", "uninstall", "restore", "--status", "--install", "--repair", "--uninstall"]);
  const stripped = stripCliOnlyFlags(rawArgv).filter((arg) => !commandAliases.has(arg));
  const forwarded = [parsed.cmd, ...stripped];
  if (extraInputPath) {
    assert(parsed.cmd === "install" || parsed.cmd === "repair", "命令参数不正确");
    if (!parsed.rest[0]) forwarded.push(extraInputPath);
  }
  return forwarded;
}

function isThemeOnlySelection(parsed) {
  return Boolean(
    parsed.flags.has("--theme-only")
    || parsed.preset === "theme-only"
    || (Array.isArray(parsed.packs) && parsed.packs.length === 1 && parsed.packs[0].trim().toLowerCase() === "theme")
  );
}

function shouldDelegateToLinux(parsed) {
  if (process.platform !== "linux" || parsed.asarPath || process.env.T3CODE_ASAR) return false;
  if (parsed.cmd === "build" || parsed.cmd === "help" || parsed.cmd === "version" || parsed.flags.has("--help") || parsed.flags.has("--version")) return false;
  const linuxCli = require("./linux.cjs");
  const linuxPaths = linuxCli.getLinuxPaths();
  const installed = fs.existsSync(linuxPaths.installDirectory) || fs.existsSync(linuxPaths.previousDirectory);
  if (isThemeOnlySelection(parsed) && !installed && !parsed.appImagePath) {
    return false;
  }
  if (parsed.appImagePath || /\.AppImage$/i.test(parsed.rest[0] || "")) return true;
  if (installed) return true;
  if (parsed.flags.has("--shared-data") || parsed.flags.has("--purge-profile")) return true;
  return !getLinuxAsarCandidates().some((c) => fs.existsSync(c));
}

function shouldDelegateToMacos(parsed) {
  if (process.platform !== "darwin" || parsed.asarPath || process.env.T3CODE_ASAR) return false;
  if (parsed.cmd === "build" || parsed.cmd === "help" || parsed.cmd === "version" || parsed.flags.has("--help") || parsed.flags.has("--version")) return false;
  const macosCli = require("./macos.cjs");
  const paths = macosCli.getMacosPaths();
  const installed = fs.existsSync(paths.installDirectory) || fs.existsSync(paths.previousApp);
  if (isThemeOnlySelection(parsed) && !installed && !parsed.macAppPath) {
    return false;
  }
  if (parsed.macAppPath || /\.app[/\\]*$/i.test(parsed.rest[0] || "")) return true;
  return installed || fs.existsSync(macosCli.DEFAULT_SOURCE) || parsed.flags.has("--shared-data") || parsed.flags.has("--purge-profile");
}

function printUsage() {
  console.log(`通用跨平台命令 (t3code-enhancer ${ENHANCER_TAG} | Windows / Linux / macOS)：
  node cli.cjs --version               查看当前增强包版本号与目标基线版本 (-v / version)
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
  --asar <path>                        显式指定 server.asar / app.asar 路径（Windows / Linux 解包版；禁用于 macOS .app 原地修改）
  --appimage <path>                    Linux：指定官方 T3-Code-x86_64.AppImage 路径
  --app <path>                         macOS：指定官方 T3 Code (Beta).app 路径（复制后重签名为独立副本）
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
  if (cmd === "version" || flags.has("--version")) {
    printVersion();
    return;
  }

  if (shouldDelegateToLinux(parsed)) {
    const linuxCli = require("./linux.cjs");
    return linuxCli.runLinuxCli(buildDelegatedArgs(parsed, rawArgv, parsed.appImagePath));
  }
  if (shouldDelegateToMacos(parsed)) {
    const macosCli = require("./macos.cjs");
    return macosCli.runMacosCli(buildDelegatedArgs(parsed, rawArgv, parsed.macAppPath));
  }

  if (cmd === "status" || flags.has("--status")) {
    assert(rest.length === 0, "命令参数不正确");
    return cmdStatus(asarPath);
  }
  if (cmd === "install" || flags.has("--install")) {
    assert(rest.length === 0, "命令参数不正确");
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log(`  T3 Code 主题与体验强化通用安装器 (${ENHANCER_TAG})`);
      console.log("  支持：主题 · 去遥测 · 输入框/额度圈 · 聊天分级 · 小窗/主侧交换");
      console.log("============================================================\n");
    }
    if (flags.has("--interactive") && !preset && !packs && !flags.has("--theme-only")) {
      const pick = await promptInteractiveAction({ patchOnly: flags.has("--patch-only") });
      if (pick.action === "cancel") return;
      if (pick.action === "repair") return cmdRepair(flags, asarPath, {});
      if (pick.action === "uninstall") return cmdUninstall(flags, asarPath);
      if (pick.officialOnly) flags.add("--official");
      return cmdInstall(flags, asarPath, { preset: pick.preset, packs: pick.packs });
    }
    return cmdInstall(flags, asarPath, { preset, packs });
  }
  if (cmd === "repair") {
    assert(rest.length === 0, "命令参数不正确");
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log(`  T3 Code 主题与体验强化修复工具 (${ENHANCER_TAG})`);
      console.log("============================================================\n");
    }
    return cmdRepair(flags, asarPath, { preset, packs });
  }
  if (cmd === "uninstall" || flags.has("--uninstall")) {
    assert(rest.length === 0, "命令参数不正确");
    if (flags.has("--banner")) {
      console.log("============================================================");
      console.log(`  T3 Code 主题与体验强化一键卸载 (${ENHANCER_TAG})`);
      console.log("  将还原纯净原版 ASAR 并恢复/移除强化主题");
      console.log("============================================================\n");
    }
    return cmdUninstall(flags, asarPath);
  }
  if (cmd === "build" || flags.has("--build")) {
    assert(rest.length <= 1, "命令参数不正确");
    return cmdBuild(rest[0], flags, asarPath, { preset, packs });
  }

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
  buildDelegatedArgs,
  isThemeOnlySelection,
  shouldDelegateToLinux,
  shouldDelegateToMacos,
  isMacosBundleAsarPath,
  resolveCanonicalPath,
  assertSafeAsarTargets,
  runAsarTransaction,
  matchesSelectedPatches,
  getArchiveCompatibilityTier,
  cmdInstall,
  cmdRepair,
  cmdUninstall,
};

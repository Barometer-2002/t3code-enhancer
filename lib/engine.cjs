"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { digest, readAsar, findUniqueEntry, validateScriptSyntax, writePatchedAsar } = require("./asar.cjs");
const { PACKS, PRESETS, selectPatchesFromList } = require("./packs.cjs");
const timelineCollapse = require("./patches/timeline-collapse.cjs");
const usageRings = require("./patches/usage-rings.cjs");
const sidebarNewChat = require("./patches/sidebar-new-chat.cjs");
const newChatLayout = require("./patches/new-chat-layout.cjs");
const inlineFileDiff = require("./patches/inline-file-diff.cjs");
const filesChangesExplorer = require("./patches/files-changes-explorer.cjs");
const workspaceFloatingPanels = require("./patches/workspace-floating-panels.cjs");
const noTelemetry = require("./patches/no-telemetry.cjs");
const desktopTray = require("./patches/desktop-tray.cjs");

const ALL_PATCHES = [
  noTelemetry, noTelemetry.relayPatch, noTelemetry.clientPatch, noTelemetry.uiPatch,
  timelineCollapse, timelineCollapse.summaryPatch, inlineFileDiff, inlineFileDiff.sideRevealPatch, inlineFileDiff.quietReviewToastPatch, usageRings, sidebarNewChat, newChatLayout, filesChangesExplorer,
  workspaceFloatingPanels, workspaceFloatingPanels.tabBarPatch, workspaceFloatingPanels.previewToolbarPatch,
  workspaceFloatingPanels.responsivePreviewPatch, desktopTray,
];

function isDesktopPatch(patch) {
  return patch.scope === "desktop" || patch.targetRegex.test("apps/desktop/dist-electron/main.cjs");
}

function applicablePatchesForArchive(asar, patches = ALL_PATCHES) {
  const hasServer = asar.entries.some(({ key }) => key.startsWith("apps/server/"));
  const hasDesktop = asar.entries.some(({ key }) => key === "apps/desktop/dist-electron/main.cjs");
  return patches.filter((patch) => (isDesktopPatch(patch) ? hasDesktop : hasServer));
}

function selectPatches(flags) {
  return selectPatchesFromList(ALL_PATCHES, flags);
}

function matchesSelectedPatches(modules, selectedPatches) {
  const selectedIds = new Set(selectedPatches.map((p) => p.id));
  return selectedPatches.every((p) => modules.find((m) => m.id === p.id)?.installed)
    && modules.every((m) => (
      selectedIds.has(m.id)
        ? m.installed
        : (m.pristine || modules.some((other) => selectedIds.has(other.id) && other.key === m.key && other.installed))
    ));
}

function inferRepairPlanOptions(modules, themeStatus, flags = new Set()) {
  const result = { preset: null, packs: null, patchOnly: false, officialOnly: false };
  if (!Array.isArray(modules) || modules.length === 0) return result;
  const summary = summarizeModuleStates(modules);
  if (!summary.allRecognized) return result;

  const hasTheme = themeStatus?.installed && themeStatus.managed !== false;
  const activeIds = new Set(modules.filter((m) => m.installed || m.outdated).map((m) => m.id));
  if (activeIds.size === 0) {
    if (hasTheme) {
      result.preset = "theme-only";
      result.officialOnly = Boolean(themeStatus.officialOnly);
    }
    return result;
  }

  const activePackIds = [];
  if (hasTheme) {
    activePackIds.push("theme");
    result.officialOnly = Boolean(themeStatus.officialOnly);
  }
  for (const pack of PACKS) {
    if (!pack.patchIds.length) continue;
    if (pack.patchIds.some((id) => activeIds.has(id))) {
      activePackIds.push(pack.id);
    }
  }
  if (activePackIds.length === 0) return result;

  for (const preset of PRESETS) {
    if (preset.packs.length === activePackIds.length && preset.packs.every((id) => activePackIds.includes(id))) {
      result.preset = preset.id;
      return result;
    }
  }
  if (!hasTheme) {
    result.patchOnly = true;
  }
  result.packs = activePackIds;
  if (flags.has("--official")) result.officialOnly = true;
  return result;
}

function getLinuxAsarCandidates(env = process.env, homedir = os.homedir()) {
  const dataHome = env.XDG_DATA_HOME || path.join(homedir, ".local", "share");
  return [
    path.join(dataHome, "t3code-enhancer", "squashfs-root", "resources", "app.asar"),
    "/opt/T3 Code/resources/app.asar",
    "/opt/T3 Code/resources/server.asar",
    "/opt/t3code/resources/app.asar",
    "/opt/t3code/resources/server.asar",
    "/usr/lib/t3code/resources/app.asar",
    "/usr/lib/t3code/resources/server.asar",
    "/usr/share/t3code/resources/app.asar",
    "/usr/share/t3code/resources/server.asar",
    path.join(dataHome, "t3code", "resources", "app.asar"),
    path.join(dataHome, "t3code", "resources", "server.asar"),
  ];
}

function getAsarPaths(asarOverride) {
  const explicit = asarOverride || process.env.T3CODE_ASAR;
  let source;
  if (explicit) {
    source = path.resolve(explicit);
  } else if (process.platform === "win32") {
    assert(process.env.LOCALAPPDATA, "未找到 LOCALAPPDATA 环境变量");
    source = path.join(process.env.LOCALAPPDATA, "Programs", "t3code", "resources", "server.asar");
  } else if (process.platform === "linux") {
    source = getLinuxAsarCandidates().find((candidate) => fs.existsSync(candidate));
    assert(
      source,
      "未找到 Linux 版 T3 Code ASAR。官方 AppImage 请直接传入路径或使用 node linux.cjs install <AppImage>；.deb / 解包版请用 --asar <路径> 或 T3CODE_ASAR=<路径> 指定（仅安装主题请加 --preset theme-only）。"
    );
  } else if (process.platform === "darwin") {
    const candidates = [
      path.join(os.homedir(), "Applications", "T3 Code Enhancer.app", "Contents", "Resources", "app.asar"),
      "/Applications/T3 Code (Beta).app/Contents/Resources/app.asar",
    ];
    source = candidates.find((candidate) => fs.existsSync(candidate));
    assert(source, "未找到 macOS 版 T3 Code ASAR，请使用 node macos.cjs 或通过 --asar <路径> 指定。");
  } else {
    throw new Error(`暂不支持当前系统 (${process.platform})，请通过 --asar <路径> 指定 ASAR 文件。`);
  }
  const backup = source + ".before-t3code-enhancer";
  const legacyBackup = source + ".before-timeline-collapse";
  return { source, backup, legacyBackup };
}

function getArchiveTargetPaths(asarOverride) {
  const primary = getAsarPaths(asarOverride);
  if (asarOverride || process.env.T3CODE_ASAR) return [primary];
  const base = path.basename(primary.source);
  if (base !== "server.asar" && base !== "app.asar") return [primary];
  const sibling = getAsarPaths(path.join(path.dirname(primary.source), base === "server.asar" ? "app.asar" : "server.asar"));
  if (!Object.values(sibling).some((candidate) => fs.existsSync(candidate))) return [primary];
  return base === "server.asar" ? [primary, sibling] : [sibling, primary];
}

function resolveAsarAppRoot(resolvedAsar) {
  const parentDir = path.dirname(resolvedAsar);
  if (path.basename(parentDir).toLowerCase() !== "resources") return null;
  const rawRoot = path.dirname(parentDir);
  return fs.existsSync(rawRoot) ? fs.realpathSync(rawRoot) : path.resolve(rawRoot);
}

function isLinuxAppRunning(asarPath, procDir = "/proc") {
  if (!fs.existsSync(procDir)) return false;
  const resolvedAsar = fs.existsSync(asarPath) ? fs.realpathSync(asarPath) : path.resolve(asarPath);
  const appRoot = resolveAsarAppRoot(resolvedAsar);
  for (const pid of fs.readdirSync(procDir)) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    let executable = "";
    try {
      executable = fs.readlinkSync(path.join(procDir, pid, "exe")).replace(/ \(deleted\)$/, "");
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM", "ESRCH"].includes(error.code)) throw error;
    }
    if (appRoot && (executable === appRoot || executable.startsWith(appRoot + path.sep))) return true;
    try {
      const cmdline = fs.readFileSync(path.join(procDir, pid, "cmdline"), "utf8");
      if (!cmdline) continue;
      const argv = cmdline.split("\0").filter(Boolean);
      if (argv.some((arg) => /(?:^|[/\\])(?:cli|linux|macos|verify)\.cjs$/.test(arg))) continue;
      if (argv.some((arg) => arg === resolvedAsar || (appRoot && (arg === appRoot || arg.startsWith(appRoot + path.sep))))) {
        return true;
      }
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM", "ESRCH"].includes(error.code)) throw error;
    }
  }
  return false;
}

function isT3Running(asarPath) {
  if (process.platform === "win32") {
    const processes = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
    return /^"T3 Code(?: \(Beta\))?\.exe"/im.test(processes);
  }
  if (process.platform === "linux") {
    return isLinuxAppRunning(asarPath);
  }
  if (process.platform === "darwin") {
    const resolvedAsar = path.resolve(asarPath);
    const appRoot = resolveAsarAppRoot(resolvedAsar) || resolvedAsar;
    const out = execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).some((line) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || Number(m[1]) === process.pid) return false;
      const cmdline = m[2];
      if (/(?:^|\s|[/\\'"])(?:cli|linux|macos|verify)\.cjs(?:["']?\s|$)/.test(cmdline)) return false;
      return cmdline.includes(appRoot);
    });
  }
  return false;
}

function assertT3Closed(asarPath) {
  assert(!isT3Running(asarPath), "请先关闭所有 T3 Code 窗口（彻底退出进程），然后再执行安装、修复或卸载。");
}

function inspectParsedArchive(asar, patches) {
  const applicable = applicablePatchesForArchive(asar, patches);
  const modules = applicable.map((p) => {
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

function inspectArchive(asarPath, patches = ALL_PATCHES) {
  return inspectParsedArchive(readAsar(asarPath), patches);
}

function inspectCompatibleSource(source, patches = ALL_PATCHES) {
  let asar;
  try {
    asar = readAsar(source);
  } catch (error) {
    if (error.code && !["ENOENT", "ERR_ASSERTION", "ERR_OUT_OF_RANGE"].includes(error.code)) throw error;
    return null;
  }
  let info;
  try {
    info = inspectParsedArchive(asar, patches);
  } catch (error) {
    throw new Error(`当前 ${path.basename(source)} 与已验证的 T3 Code 0.1.11 不兼容，已中止以免使用旧备份覆盖新版：${error.message}`, { cause: error });
  }
  assert(
    info.modules.length > 0 && summarizeModuleStates(info.modules).allRecognized,
    `当前 ${path.basename(source)} 包含未识别的版本内容（可能 T3 Code 已更新），已中止以免使用旧备份覆盖。`
  );
  return info;
}

function summarizeModuleStates(modules) {
  const allInstalled = modules.every((m) => m.installed);
  const allPristine = modules.every((m) => m.pristine);
  const hasKnownEnhancement = modules.some((m) => m.installed || m.outdated);
  const allRecognized = modules.every((m) => (
    m.installed || m.outdated || m.pristine ||
    modules.some((other) => other !== m && other.key === m.key && (other.installed || other.outdated))
  ));
  return {
    allInstalled,
    allPristine,
    hasKnownEnhancement,
    allRecognized,
    outdated: allRecognized && modules.some((m) => m.outdated),
  };
}

function resolvePristineBaseline(paths, patches = ALL_PATCHES) {
  const source = inspectCompatibleSource(paths.source, patches);
  for (const candidate of [paths.backup, paths.legacyBackup]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const info = inspectArchive(candidate, patches);
      if (info.modules.length > 0 && info.modules.every((m) => m.pristine)) {
        return { path: candidate, asar: info.asar };
      }
    } catch {
      // ignore corrupted/incompatible candidate
    }
  }
  if (source?.modules.every((m) => m.pristine)) return { path: paths.source, asar: source.asar };
  throw new Error(
    `找不到未修改的原版 T3 Code 0.1.11 ASAR 基线文件（${path.basename(paths.source)}，可能 T3 Code 已更新版本，请先核对兼容性）。`
  );
}

function buildPatchedArchive(baselineAsar, selectedPatches, outputPath) {
  const applicable = applicablePatchesForArchive(baselineAsar, selectedPatches);
  const grouped = new Map();
  for (const patch of applicable) {
    const entry = findUniqueEntry(baselineAsar, patch.targetRegex, patch.id);
    assert.equal(
      digest(entry.content),
      patch.originalHash,
      `基线文件 ${entry.key} 校验和不匹配（仅支持已验证的 T3 Code 0.1.11）`
    );
    if (!grouped.has(entry.key)) {
      grouped.set(entry.key, { entry, patches: [] });
    }
    grouped.get(entry.key).patches.push(patch);
  }

  const replacements = [];
  const report = [];
  for (const { entry, patches } of grouped.values()) {
    let currentStr = entry.content.toString("utf8");
    for (const patch of patches) {
      currentStr = patch.apply(currentStr);
    }
    const replacement = Buffer.from(currentStr, "utf8");
    validateScriptSyntax(replacement, entry.key, `${patches.map((p) => p.id).join("+")} (${entry.key})`);
    replacements.push({ key: entry.key, replacement });
    const patchedHash = digest(replacement);
    for (const patch of patches) {
      report.push({ id: patch.id, key: entry.key, original: patch.originalHash, patched: patchedHash });
    }
  }
  writePatchedAsar(baselineAsar, replacements, outputPath);
  return report;
}

module.exports = {
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
};

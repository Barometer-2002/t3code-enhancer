"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { digest, readAsar, readEntryBuffer, getAsarAppVersion, validateScriptSyntax, writePatchedAsar } = require("./asar.cjs");
const { parseImports, parseExports } = require("./js-ast.cjs");
const { findPatchTarget, createPatchContext, verifyInjectedScope } = require("./resolver.cjs");
const { ENHANCER_VERSION } = require("./version.cjs");
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
  noTelemetry.desktopPatch,
  timelineCollapse, timelineCollapse.summaryPatch, inlineFileDiff, inlineFileDiff.sideRevealPatch, inlineFileDiff.quietReviewToastPatch, usageRings, sidebarNewChat, newChatLayout, filesChangesExplorer,
  workspaceFloatingPanels, workspaceFloatingPanels.tabBarPatch, workspaceFloatingPanels.previewToolbarPatch,
  workspaceFloatingPanels.responsivePreviewPatch, desktopTray,
];

const BUILD_META_KEY = "t3e-build-meta.json";
const SAVED_PLAN_FILE = ".t3code-enhancer-plan.json";
const RUNTIME_DIR = path.join(__dirname, "runtime");
const PATCH_RUNTIME_NAMES = {
  "timeline-collapse": "timeline-ui",
  "inline-file-diff": "inline-diff-ui",
  "usage-rings": "usage-rings-ui",
  "files-changes-explorer": "files-explorer-ui",
  "workspace-floating-panels": "floating-panels-ui",
  "workspace-floating-tab-bar": "tab-bar-ui",
};

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markerBoundaryRegex(marker) {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(marker)}(?:$|[^A-Za-z0-9_])`);
}

function hasExactMarker(text, marker) {
  return Boolean(marker && markerBoundaryRegex(marker).test(text));
}

const allMarkerAlternation = ALL_PATCHES.flatMap(({ marker, legacyMarkers }) =>
  [marker, ...(legacyMarkers ?? [])]
).filter(Boolean).map(escapeRegExp).join("|");
const enhancementMarkers = new RegExp(`(?:^|[^A-Za-z0-9_])(?:${allMarkerAlternation})(?:$|[^A-Za-z0-9_])`);
const archiveEnhancementCache = new WeakMap();
const runtimeDigestCache = new Map();

function getExpectedRuntimeInfo(rtName) {
  if (!runtimeDigestCache.has(rtName)) {
    const buf = fs.readFileSync(path.join(RUNTIME_DIR, `${rtName}.mjs`));
    const hash = digest(buf);
    runtimeDigestCache.set(rtName, { buf, hash, shortHash: hash.slice(0, 8) });
  }
  return runtimeDigestCache.get(rtName);
}

function verifyPatchRuntimeAsset(asar, entryKey, hostText, patchId) {
  const rtName = PATCH_RUNTIME_NAMES[patchId];
  if (!rtName) return { present: true, valid: true };
  const importRe = new RegExp(
    `import\\s*\\{[^}]+\\}\\s*from\\s*["']\\.\\/(t3e-${escapeRegExp(rtName)}-([0-9a-f]{8})\\.js)["']`
  );
  const m = hostText.match(importRe);
  if (!m) return { present: false, valid: false };
  const [, fileName, shortHash] = m;
  const assetKey = path.posix.join(path.posix.dirname(entryKey), fileName);
  const rec = asar?.byKey?.get(assetKey);
  if (!rec) return { present: true, valid: false };
  try {
    const content = readEntryBuffer(asar, rec);
    if (rec.entry.integrity?.algorithm !== "SHA256") return { present: true, valid: false };
    const actualHash = digest(content);
    if (actualHash !== rec.entry.integrity.hash) return { present: true, valid: false };
    const expected = getExpectedRuntimeInfo(rtName);
    if (shortHash !== expected.shortHash || actualHash !== expected.hash) {
      return { present: true, valid: false };
    }
    return { present: true, valid: true };
  } catch {
    return { present: true, valid: false };
  }
}

function readBuildMeta(asar) {
  const rec = asar?.byKey?.get(BUILD_META_KEY);
  if (!rec) return null;
  try {
    const parsed = JSON.parse(readEntryBuffer(asar, rec).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isDesktopPatch(patch) {
  return patch.scope === "desktop" || Boolean(patch.targetRegex && patch.targetRegex.test("apps/desktop/dist-electron/main.cjs"));
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
        : (!m.installed && !m.outdated && (
            m.pristine ||
            modules.some((other) => selectedIds.has(other.id) && other.key === m.key && other.installed)
          ))
    ));
}

function inferRepairPlanOptions(modules, themeStatus, flags = new Set(), savedPlans = []) {
  const result = {
    preset: null,
    packs: null,
    patchOnly: false,
    officialOnly: false,
    excludePatchIds: [],
    exactPatchIds: null,
  };
  const validSaved = Array.isArray(savedPlans)
    ? savedPlans.filter((p) => p && typeof p === "object" && (Array.isArray(p.selectedPatchIds) || Array.isArray(p.packIds)))
    : [];
  const saved = validSaved.find((p) => Array.isArray(p.selectedPatchIds)) || validSaved[0] || null;
  if (saved) {
    const hasLiveTheme = Boolean(themeStatus?.installed && themeStatus.managed !== false);
    const includeTheme = !flags.has("--patch-only") && (hasLiveTheme || Boolean(saved.includeTheme));
    const officialOnly = hasLiveTheme ? Boolean(themeStatus.officialOnly) : Boolean(saved.officialOnly);
    const basePacks = Array.isArray(saved.packIds) ? [...saved.packIds] : [];
    const packIds = includeTheme && !basePacks.includes("theme")
      ? ["theme", ...basePacks]
      : !includeTheme
        ? basePacks.filter((id) => id !== "theme")
        : basePacks;
    const savedExcludes = Array.isArray(saved.excludedPatchIds) ? [...saved.excludedPatchIds] : [];
    const selectedPatchIds = Array.isArray(saved.selectedPatchIds) ? [...saved.selectedPatchIds] : null;
    if (selectedPatchIds?.length === 0 || (saved.themeOnly && !selectedPatchIds)) {
      if (includeTheme) result.preset = "theme-only";
      else result.exactPatchIds = [];
      result.officialOnly = officialOnly;
      return result;
    }
    const presetMatch = savedExcludes.length === 0
      ? PRESETS.find((p) => p.packs.length === packIds.length && p.packs.every((id) => packIds.includes(id)))
      : null;
    result.preset = presetMatch ? presetMatch.id : null;
    result.packs = presetMatch ? null : packIds;
    result.excludePatchIds = savedExcludes;
    result.exactPatchIds = selectedPatchIds;
    result.patchOnly = !includeTheme || Boolean(saved.patchOnly);
    result.officialOnly = flags.has("--official") ? true : officialOnly;
    return result;
  }

  if (!Array.isArray(modules) || modules.length === 0) return result;
  const summary = summarizeModuleStates(modules);
  if (!summary.allRecognized) return result;

  const hasTheme = !flags.has("--patch-only") && themeStatus?.installed && themeStatus.managed !== false;
  const activeIds = new Set(modules.filter((m) => m.installed || m.outdated).map((m) => m.id));
  if (activeIds.size === 0) {
    if (hasTheme) {
      result.preset = "theme-only";
      result.officialOnly = Boolean(themeStatus.officialOnly);
    } else if (flags.has("--patch-only") && themeStatus?.installed && themeStatus.managed !== false) {
      result.exactPatchIds = [];
    }
    return result;
  }

  const activePackIds = [];
  if (hasTheme) {
    activePackIds.push("theme");
    result.officialOnly = Boolean(themeStatus.officialOnly);
  }
  const moduleById = new Map(modules.map((m) => [m.id, m]));
  const excludedIds = [];
  for (const pack of PACKS) {
    if (!pack.patchIds.length) continue;
    if (pack.patchIds.some((id) => activeIds.has(id))) {
      activePackIds.push(pack.id);
      for (const patchId of pack.patchIds) {
        const mod = moduleById.get(patchId);
        if (mod && !mod.installed && !mod.outdated) {
          excludedIds.push(patchId);
        }
      }
    }
  }
  if (activePackIds.length === 0) return result;

  result.excludePatchIds = Array.from(new Set(excludedIds));
  if (result.excludePatchIds.length === 0) {
    for (const preset of PRESETS) {
      if (preset.packs.length === activePackIds.length && preset.packs.every((id) => activePackIds.includes(id))) {
        result.preset = preset.id;
        return result;
      }
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

const probeCache = new WeakMap();

function isKnownOriginalHash(patch, hash) {
  if (patch.originalHash && hash === patch.originalHash) return true;
  if (Array.isArray(patch.knownHashes) && patch.knownHashes.includes(hash)) return true;
  return false;
}

function hasAnyPatchMarker(text, patches) {
  for (const p of patches) {
    if (p.marker && hasExactMarker(text, p.marker)) return true;
    if (Array.isArray(p.legacyMarkers) && p.legacyMarkers.some((m) => hasExactMarker(text, m))) return true;
  }
  return false;
}

function hasArchiveEnhancements(asar) {
  if (!archiveEnhancementCache.has(asar)) {
    archiveEnhancementCache.set(asar, asar.entries.some((entry) =>
      /\.[cm]?js$/.test(entry.key) && enhancementMarkers.test(readEntryBuffer(asar, entry).toString("utf8"))
    ));
  }
  return archiveEnhancementCache.get(asar);
}

// Keep every marker for a shared host file visible to partial install plans.
function locatePatches(asar, patches) {
  const targets = new Map();
  const knownPatches = [...new Set([...ALL_PATCHES, ...patches])];
  return patches.map((patch) => {
    const spec = patch.targetSpec ?? patch.targetRegex;
    if (!targets.has(spec)) {
      const related = knownPatches.filter((item) => (item.targetSpec ?? item.targetRegex) === spec);
      const entry = findPatchTarget(asar, patch, related);
      const text = entry.content.toString("utf8");
      targets.set(spec, { entry, text, modified: enhancementMarkers.test(text) || hasAnyPatchMarker(text, patches) });
    }
    return { patch, ...targets.get(spec) };
  });
}

function runPatchStep(asar, entry, source, patch, enabledIds) {
  const hostSource = source.replace(/\r?\n?\/\/# sourceMappingURL=[^\r\n]*\s*$/, "");
  const ctx = createPatchContext(asar, entry, hostSource, enabledIds);
  const patched = patch.apply(hostSource, ctx);
  const nextStr = ctx.getInjectedImports().join("") + patched;
  assert(hasExactMarker(nextStr, patch.marker), `Patch ${patch.id} did not emit marker ${patch.marker}`);
  const snippets = ctx.getInjectedCodeSnippets();
  if (snippets.length > 0) {
    verifyInjectedScope(nextStr, snippets, `${patch.id} (${entry.key})`, patch.allowedGlobals || []);
  }
  return { text: nextStr, additions: ctx.getAdditions() };
}

function probeAutoAdapt(asar, entry, text, patch) {
  if (!patch.targetSpec || patch.crossVersion === false) return false;
  let perAsar = probeCache.get(asar);
  if (!perAsar) {
    perAsar = new Map();
    probeCache.set(asar, perAsar);
  }
  const cacheKey = `${patch.id}:${entry.key}`;
  if (perAsar.has(cacheKey)) return perAsar.get(cacheKey);
  let ok = false;
  try {
    const { text: nextStr, additions } = runPatchStep(asar, entry, text, patch);
    validateScriptSyntax(Buffer.from(nextStr, "utf8"), entry.key, `${patch.id} (${entry.key})`);
    for (const add of additions) {
      validateScriptSyntax(add.content, add.key, `${patch.id} runtime (${add.key})`);
    }
    ok = true;
  } catch {
    ok = false;
  }
  perAsar.set(cacheKey, ok);
  return ok;
}

function inspectParsedArchive(asar, patches, useAllIfUnselected = false) {
  let applicable = applicablePatchesForArchive(asar, patches);
  if (useAllIfUnselected && applicable.length === 0) applicable = applicablePatchesForArchive(asar);
  const buildMeta = readBuildMeta(asar);
  const appVersion = getAsarAppVersion(asar) || buildMeta?.appVersion || null;
  const modules = locatePatches(asar, applicable).map(({ patch: p, entry, text, modified }) => {
    const markerCurrent = hasExactMarker(text, p.marker);
    const runtimeCheck = markerCurrent ? verifyPatchRuntimeAsset(asar, entry.key, text, p.id) : { present: true, valid: true };
    const installed = markerCurrent && runtimeCheck.present && runtimeCheck.valid;
    const markerOutdated = !markerCurrent && Array.isArray(p.legacyMarkers) && p.legacyMarkers.some((m) => hasExactMarker(text, m));
    const outdated = markerOutdated || (markerCurrent && !installed);
    const effectiveModified = modified || (markerCurrent && !runtimeCheck.valid);
    const hash = entry.entry.integrity.hash;
    const verifiedHash = isKnownOriginalHash(p, hash);
    const autoAdapted = !effectiveModified && !verifiedHash && probeAutoAdapt(asar, entry, text, p);
    const pristine = verifiedHash || autoAdapted;
    const persistedCompat = (installed || outdated) ? (buildMeta?.modules?.[p.id] ?? null) : null;
    const compat = verifiedHash ? "verified" : autoAdapted ? "auto-adapted" : persistedCompat;
    return {
      id: p.id,
      name: p.name,
      key: entry.key,
      installed,
      outdated,
      pristine,
      compat,
      hash,
      appVersion,
      modified: effectiveModified,
      runtimeInvalid: markerCurrent && !runtimeCheck.valid,
    };
  });
  return { asar, appVersion, enhancerVersion: buildMeta?.enhancerVersion ?? null, buildMeta, modules };
}

function inspectArchive(asarPath, patches = ALL_PATCHES) {
  return inspectParsedArchive(readAsar(asarPath), patches);
}

function isArchiveCorruptionError(error) {
  return Boolean(
    error && (
      ["ENOENT", "ERR_OUT_OF_RANGE", "ERR_ASAR_INTEGRITY"].includes(error.code) ||
      /Integrity check failed|out of range|Unexpected integrity algorithm|shares archive bytes|Invalid ASAR/i.test(error.message || "")
    )
  );
}

function inspectCompatibleSource(source, patches = ALL_PATCHES) {
  let asar;
  try {
    asar = readAsar(source);
  } catch (error) {
    if (error.code && !["ENOENT", "ERR_ASSERTION", "ERR_OUT_OF_RANGE", "ERR_ASAR_INTEGRITY"].includes(error.code)) throw error;
    return null;
  }
  const rawAppVersion = getAsarAppVersion(asar);
  let info;
  try {
    info = inspectParsedArchive(asar, patches, true);
  } catch (error) {
    if (isArchiveCorruptionError(error)) {
      return { unreadable: true, corrupted: true, appVersion: rawAppVersion, error };
    }
    const verLabel = rawAppVersion ? `T3 Code ${rawAppVersion}` : path.basename(source);
    throw new Error(`当前 ${path.basename(source)}（${verLabel}）与补丁语义锚点不兼容，已中止以免使用旧备份覆盖新版：${error.message}`, { cause: error });
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
    m.installed || m.outdated || m.pristine || m.modified ||
    modules.some((other) => other !== m && other.key === m.key && (other.installed || other.outdated))
  ));
  const autoAdapted = modules.some((m) => m.compat === "auto-adapted");
  return {
    allInstalled,
    allPristine,
    hasKnownEnhancement,
    allRecognized,
    autoAdapted,
    outdated: allRecognized && modules.some((m) => m.outdated),
  };
}

function resolvePristineBaseline(paths, patches = ALL_PATCHES, expectedAppVersion = null) {
  const source = inspectCompatibleSource(paths.source, patches);
  const sourceVersion = expectedAppVersion ?? source?.appVersion ?? null;
  const isPristine = ({ asar, modules }) =>
    modules.length > 0 && modules.every((m) => m.pristine) && !hasArchiveEnhancements(asar);
  if (source && !source.unreadable &&
      (!sourceVersion || source.appVersion === sourceVersion) && isPristine(source)) {
    return { path: paths.source, ...source };
  }
  for (const candidate of [paths.backup, paths.legacyBackup]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const info = inspectParsedArchive(readAsar(candidate), patches, true);
      if (sourceVersion && info.appVersion !== sourceVersion) {
        // Never allow an older/different version backup to overwrite a newer T3 Code version
        continue;
      }
      if (isPristine(info)) {
        return { path: candidate, ...info };
      }
    } catch {
      // ignore corrupted/incompatible candidate
    }
  }
  const verHint = sourceVersion ? `T3 Code ${sourceVersion}` : "当前版本 T3 Code";
  throw new Error(
    `找不到未修改的原版 ${verHint} ASAR 基线文件（${path.basename(paths.source)}，可能 T3 Code 已更新版本，请先核对兼容性）。`
  );
}

function getSavedPlanPath(userdataDir) {
  const baseDir = userdataDir || (process.env.T3CODE_HOME
    ? path.join(path.resolve(process.env.T3CODE_HOME), "userdata")
    : path.join(os.homedir(), ".t3", "userdata"));
  return path.join(baseDir, SAVED_PLAN_FILE);
}

function readSavedInstallPlan(userdataDir) {
  const planPath = getSavedPlanPath(userdataDir);
  if (!fs.existsSync(planPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(planPath, "utf8"));
    const candidate = parsed?.plan ?? parsed;
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (Array.isArray(candidate.selectedPatchIds) || Array.isArray(candidate.packIds))
    ) {
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

function prepareSavedPlanTransaction(userdataDir, plan, selectedPatches) {
  const planPath = getSavedPlanPath(userdataDir);
  const dir = path.dirname(planPath);
  const serialized = serializeBuildPlan(plan, selectedPatches);
  let snap = null;
  let committed = false;
  return {
    commit() {
      const previous = serialized.themeOnly ? readSavedInstallPlan(userdataDir) : null;
      const priorPatches = previous?.selectedPatchIds?.length ?? previous?.packIds?.some((id) => id !== "theme");
      if (priorPatches) return;
      const dirExisted = fs.existsSync(dir);
      const existed = fs.existsSync(planPath);
      const prevBytes = existed ? fs.readFileSync(planPath) : null;
      snap = { dirExisted, existed, prevBytes };
      const payload = JSON.stringify({
        enhancerVersion: ENHANCER_VERSION,
        updatedAt: new Date().toISOString(),
        plan: serialized,
      }, null, 2) + "\n";
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${planPath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, planPath);
      } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      }
      committed = true;
    },
    rollback() {
      if (!committed || !snap) return;
      if (snap.existed && snap.prevBytes !== null) {
        const tmp = `${planPath}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(tmp, snap.prevBytes, { mode: 0o600 });
          fs.renameSync(tmp, planPath);
        } finally {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        }
      } else {
        fs.rmSync(planPath, { force: true });
      }
      if (!snap.dirExisted && fs.existsSync(dir)) {
        try {
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        } catch {}
      }
      committed = false;
    },
  };
}

function clearSavedInstallPlan(userdataDir) {
  const planPath = getSavedPlanPath(userdataDir);
  fs.rmSync(planPath, { force: true });
}

function serializeBuildPlan(plan, selectedPatches) {
  if (!plan) return undefined;
  return {
    presetId: plan.presetId || null,
    packIds: Array.isArray(plan.packIds) ? [...plan.packIds] : [],
    selectedPatchIds: Array.isArray(plan.selectedPatches)
      ? plan.selectedPatches.map((p) => p.id)
      : selectedPatches.map((p) => p.id),
    excludedPatchIds: Array.isArray(plan.excludedPatchIds) ? [...plan.excludedPatchIds] : [],
    includeTheme: Boolean(plan.includeTheme),
    officialOnly: Boolean(plan.officialOnly),
    patchOnly: Boolean(plan.patchOnly),
    themeOnly: Boolean(plan.themeOnly),
    telemetryDisabled: Boolean(plan.telemetryDisabled),
  };
}

function buildPatchedArchive(baselineAsar, selectedPatches, outputPath, options = {}) {
  assert(!hasArchiveEnhancements(baselineAsar), "构建补丁需要未修改的原版 ASAR");
  const applicable = applicablePatchesForArchive(baselineAsar, selectedPatches);
  const enabledIds = new Set(applicable.map(({ id }) => id));
  const appVersion = getAsarAppVersion(baselineAsar);
  const grouped = new Map();
  for (const { patch, entry, text, modified } of locatePatches(baselineAsar, applicable)) {
    assert(!modified, `补丁 ${patch.id} 需要未修改的原版文件（${entry.key}）`);
    const entryHash = entry.entry.integrity.hash;
    const verifiedHash = isKnownOriginalHash(patch, entryHash);
    if (!verifiedHash) {
      assert(
        patch.targetSpec && patch.crossVersion !== false,
        `基线文件 ${entry.key} 校验和不匹配（补丁 ${patch.id} 仅支持已验证版本）`
      );
    }
    if (!grouped.has(entry.key)) {
      grouped.set(entry.key, { entry, entryHash, text, patches: [] });
    }
    grouped.get(entry.key).patches.push({ patch, compat: verifiedHash ? "verified" : "auto-adapted" });
  }

  const replacements = [];
  const assets = new Map();
  const report = [];
  for (const { entry, entryHash, text, patches } of grouped.values()) {
    let currentStr = text;
    for (const { patch } of patches) {
      const { text: patched, additions } = runPatchStep(baselineAsar, entry, currentStr, patch, enabledIds);
      currentStr = patched;
      for (const asset of additions) {
        const previous = assets.get(asset.key);
        if (previous) assert(previous.content.equals(asset.content), `Conflicting runtime asset: ${asset.key}`);
        else assets.set(asset.key, asset);
      }
    }
    const replacement = Buffer.from(currentStr, "utf8");
    validateScriptSyntax(replacement, entry.key, `${patches.map((p) => p.patch.id).join("+")} (${entry.key})`);
    replacements.push({ key: entry.key, replacement });
    const patchedHash = digest(replacement);
    for (const { patch, compat } of patches) {
      report.push({
        id: patch.id,
        key: entry.key,
        original: entryHash,
        patched: patchedHash,
        compat,
        appVersion,
      });
    }
  }
  for (const { key, content } of assets.values()) validateScriptSyntax(content, key, key);
  const replacementMap = new Map(replacements.map((r) => [r.key, r.replacement.toString("utf8")]));
  const assetExportsCache = new Map();
  const getModuleTextForKey = (targetKey) => {
    const added = assets.get(targetKey);
    if (added) return added.content.toString("utf8");
    if (replacementMap.has(targetKey)) return replacementMap.get(targetKey);
    if (baselineAsar.byKey.has(targetKey)) return readEntryBuffer(baselineAsar, baselineAsar.byKey.get(targetKey)).toString("utf8");
    return null;
  };
  const getExportSetForKey = (targetKey, visiting = new Set()) => {
    if (assetExportsCache.has(targetKey)) return assetExportsCache.get(targetKey);
    if (visiting.has(targetKey)) return new Set();
    const targetText = getModuleTextForKey(targetKey);
    assert(targetText !== null, `Patched module imports missing asset ${targetKey}`);
    const nextVisiting = new Set(visiting);
    nextVisiting.add(targetKey);
    const names = new Set();
    for (const ex of parseExports(targetText)) {
      if (ex.exported === "*" && ex.from && ex.from.startsWith(".")) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(targetKey), ex.from));
        if (getModuleTextForKey(resolved) !== null) {
          for (const subName of getExportSetForKey(resolved, nextVisiting)) {
            if (subName !== "default") names.add(subName);
          }
        }
        continue;
      }
      if (ex.from && ex.from.startsWith(".")) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(targetKey), ex.from));
        if (getModuleTextForKey(resolved) !== null && ex.local !== "*") {
          const sourceExports = getExportSetForKey(resolved, nextVisiting);
          assert(
            sourceExports.has(ex.local),
            `Re-export "${ex.local}" as "${ex.exported}" from ${ex.from} in ${targetKey} does not match any export of ${resolved}`
          );
        }
      }
      names.add(ex.exported);
    }
    assetExportsCache.set(targetKey, names);
    return names;
  };
  for (const { key, replacement } of replacements) {
    const srcText = replacement.toString("utf8");
    for (const imp of parseImports(srcText)) {
      if (!imp.specifier.startsWith(".")) continue;
      const resolvedKey = path.posix.normalize(path.posix.join(path.posix.dirname(key), imp.specifier));
      const exportsSet = getExportSetForKey(resolvedKey);
      for (const spec of imp.specifiers) {
        if (spec.imported === "*") continue;
        assert(
          exportsSet.has(spec.imported),
          `Injected/retained import "${spec.imported}" from ${imp.specifier} in ${key} does not match any export of ${resolvedKey}`
        );
      }
    }
  }
  for (const { key, content } of assets.values()) {
    for (const imp of parseImports(content.toString("utf8"))) {
      if (!imp.specifier.startsWith(".")) continue;
      const resolvedKey = path.posix.normalize(path.posix.join(path.posix.dirname(key), imp.specifier));
      const exportsSet = getExportSetForKey(resolvedKey);
      for (const spec of imp.specifiers) {
        if (spec.imported === "*") continue;
        assert(
          exportsSet.has(spec.imported),
          `Injected runtime asset "${key}" import "${spec.imported}" from ${imp.specifier} does not match any export of ${resolvedKey}`
        );
      }
    }
  }
  const additionsToWrite = [...assets.values()];
  if (!baselineAsar.byKey.has(BUILD_META_KEY) && !assets.has(BUILD_META_KEY)) {
    const metaModules = {};
    for (const item of report) metaModules[item.id] = item.compat;
    const compatTier = report.some((item) => item.compat === "auto-adapted") ? "auto-adapted" : "verified";
    const serializedPlan = serializeBuildPlan(options?.plan, selectedPatches);
    additionsToWrite.push({
      key: BUILD_META_KEY,
      content: Buffer.from(JSON.stringify({
        enhancerVersion: ENHANCER_VERSION,
        appVersion,
        compatTier,
        modules: metaModules,
        ...(serializedPlan ? { plan: serializedPlan } : {}),
      }, null, 2) + "\n", "utf8"),
    });
  }
  writePatchedAsar(baselineAsar, replacements, outputPath, additionsToWrite);
  return report;
}

module.exports = {
  ALL_PATCHES,
  PATCH_RUNTIME_NAMES,
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
  SAVED_PLAN_FILE,
  getSavedPlanPath,
  readSavedInstallPlan,
  prepareSavedPlanTransaction,
  clearSavedInstallPlan,
};

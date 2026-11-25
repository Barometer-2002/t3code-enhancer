"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const THEME_ID = "chatgpt-app";
const USERDATA_DIR = process.env.T3CODE_HOME
  ? path.join(path.resolve(process.env.T3CODE_HOME), "userdata")
  : path.join(os.homedir(), ".t3", "userdata");
const SOURCE_THEME_PATH = path.resolve(__dirname, "..", "themes", `${THEME_ID}.json`);
const LAYER_1_MARKER = "/* === LAYER 1:";
const LAYER_2_MARKER = "/* === LAYER 2:";

function writeFileAtomic(filePath, content, options = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: options.mode });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function getUserdataDir(sharedData, profileDirectory, sharedUserdata = path.join(os.homedir(), ".t3", "userdata")) {
  return sharedData ? sharedUserdata : path.join(profileDirectory, "t3-home", "userdata");
}

function getThemePaths(userdataDir = USERDATA_DIR) {
  const themesDir = path.join(userdataDir, "themes");
  return {
    userdataDir,
    themesDir,
    settingsPath: path.join(userdataDir, "settings.json"),
    targetThemePath: path.join(themesDir, `${THEME_ID}.json`),
    backupThemePath: path.join(themesDir, `${THEME_ID}.json.before-enhancer`),
  };
}

const { targetThemePath: TARGET_THEME_PATH } = getThemePaths(USERDATA_DIR);

function readSettings(userdataDir = USERDATA_DIR) {
  const { settingsPath } = getThemePaths(userdataDir);
  if (!fs.existsSync(settingsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return null;
  }
}

function setActiveThemeInSettings(themeId, userdataDir = USERDATA_DIR) {
  const { settingsPath } = getThemePaths(userdataDir);
  const settings = readSettings(userdataDir);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  if (themeId) {
    settings.defaultTheme = themeId;
  } else {
    delete settings.defaultTheme;
  }
  settings.defaultThemeSetAt = new Date().toISOString();
  writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return true;
}

function extractOfficialTheme(themeObj) {
  const css = typeof themeObj.css === "string" ? themeObj.css : "";
  const idx = css.indexOf(LAYER_2_MARKER);
  const officialCss = idx >= 0 ? css.slice(0, idx).trimEnd() + "\n" : css;
  return { ...themeObj, css: officialCss };
}

function isEnhancerOwnedTheme(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    const css = typeof parsed?.css === "string" ? parsed.css : "";
    return parsed?.name === "ChatGPT App" && (css.includes(LAYER_1_MARKER) || css.includes(LAYER_2_MARKER));
  } catch {
    return false;
  }
}

function getThemeStatus(userdataDir = USERDATA_DIR) {
  const { targetThemePath, backupThemePath } = getThemePaths(userdataDir);
  const installed = fs.existsSync(targetThemePath);
  const hasBackup = fs.existsSync(backupThemePath);
  const settings = readSettings(userdataDir);
  const active = settings?.defaultTheme === THEME_ID;
  let matchesBundled = false;
  let officialOnly = false;
  let managed = false;
  if (installed && fs.existsSync(SOURCE_THEME_PATH)) {
    try {
      const current = fs.readFileSync(targetThemePath, "utf8");
      managed = isEnhancerOwnedTheme(current);
      const targetParsed = JSON.parse(current);
      const bundledParsed = JSON.parse(fs.readFileSync(SOURCE_THEME_PATH, "utf8"));
      const serializedTarget = JSON.stringify(targetParsed);
      const serializedFull = JSON.stringify(bundledParsed);
      const serializedOfficial = JSON.stringify(extractOfficialTheme(bundledParsed));
      const css = typeof targetParsed?.css === "string" ? targetParsed.css : "";
      officialOnly = css.includes(LAYER_1_MARKER) && !css.includes(LAYER_2_MARKER);
      matchesBundled = serializedTarget === serializedFull || serializedTarget === serializedOfficial;
    } catch {
      matchesBundled = false;
    }
  }
  return { themeId: THEME_ID, targetPath: targetThemePath, installed, active, hasBackup, matchesBundled, officialOnly, managed };
}

function formatThemeStatusText(themeStatus) {
  if (!themeStatus?.installed) return "未安装";
  const layerHint = themeStatus.officialOnly ? " · Layer 1 官方层" : "";
  const versionState = themeStatus.matchesBundled ? "已安装（最新" : "已安装（与项目内版本有差异";
  const activeState = themeStatus.active ? "已激活" : "未激活";
  return `${versionState}${layerHint} · ${activeState}）`;
}

function installThemeAt(userdataDir, options = {}) {
  const officialOnly = options.officialOnly === true;
  const activate = options.activate !== false;
  const { themesDir, settingsPath, targetThemePath, backupThemePath } = getThemePaths(userdataDir);

  fs.mkdirSync(userdataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(themesDir, { recursive: true, mode: 0o700 });
  const raw = fs.readFileSync(SOURCE_THEME_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const content = officialOnly
    ? JSON.stringify(extractOfficialTheme(parsed), null, 2) + "\n"
    : raw;
  if (fs.existsSync(targetThemePath) && !fs.existsSync(backupThemePath)) {
    const current = fs.readFileSync(targetThemePath);
    if (current.toString("utf8") !== content && !isEnhancerOwnedTheme(current.toString("utf8"))) {
      writeFileAtomic(backupThemePath, current);
    }
  }
  writeFileAtomic(targetThemePath, content);

  let activated = false;
  if (activate) {
    activated = setActiveThemeInSettings(THEME_ID, userdataDir);
    if (!activated && !fs.existsSync(settingsPath) && options.createSettingsIfMissing) {
      writeFileAtomic(settingsPath, JSON.stringify({
        defaultTheme: THEME_ID,
        defaultThemeSetAt: new Date().toISOString(),
      }, null, 2) + "\n", { mode: 0o600 });
      activated = true;
    }
  }

  return {
    installed: true,
    officialOnly,
    activated,
    targetPath: targetThemePath,
    backupPath: fs.existsSync(backupThemePath) ? backupThemePath : null,
  };
}

function installTheme(options = {}) {
  return installThemeAt(USERDATA_DIR, options);
}

function prepareProfileAt(userdataDir, sharedData, options = {}) {
  return installThemeAt(userdataDir, {
    officialOnly: options.officialOnly === true,
    activate: !sharedData,
    createSettingsIfMissing: !sharedData,
  });
}

function uninstallTheme(userdataDir = USERDATA_DIR) {
  const { targetThemePath, backupThemePath } = getThemePaths(userdataDir);
  const installed = fs.existsSync(targetThemePath);
  if (installed && !isEnhancerOwnedTheme(fs.readFileSync(targetThemePath, "utf8"))) {
    return { action: "kept-custom-theme", deactivated: false, targetPath: targetThemePath };
  }
  if (fs.existsSync(backupThemePath)) {
    writeFileAtomic(targetThemePath, fs.readFileSync(backupThemePath));
    fs.unlinkSync(backupThemePath);
    return { action: "restored-backup", deactivated: false, targetPath: targetThemePath };
  }
  if (installed) fs.unlinkSync(targetThemePath);
  const deactivated = readSettings(userdataDir)?.defaultTheme === THEME_ID && setActiveThemeInSettings(null, userdataDir);
  return { action: installed ? "removed" : "not-installed", deactivated, targetPath: targetThemePath };
}

module.exports = {
  getThemeStatus,
  formatThemeStatusText,
  getUserdataDir,
  prepareProfileAt,
  installTheme,
  installThemeAt,
  uninstallTheme,
  extractOfficialTheme,
  isEnhancerOwnedTheme,
  LAYER_1_MARKER,
  LAYER_2_MARKER,
  TARGET_THEME_PATH,
  SOURCE_THEME_PATH,
};

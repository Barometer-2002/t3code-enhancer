"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const THEME_ID = "chatgpt-app";
const USERDATA_DIR = process.env.T3CODE_HOME
  ? path.join(path.resolve(process.env.T3CODE_HOME), "userdata")
  : path.join(os.homedir(), ".t3", "userdata");
const SOURCE_THEME_PATH = path.resolve(__dirname, "..", "themes", `${THEME_ID}.json`);
const LAYER_2_MARKER = "/* === LAYER 2:";

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
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return true;
}

function getThemeStatus(userdataDir = USERDATA_DIR) {
  const { targetThemePath, backupThemePath } = getThemePaths(userdataDir);
  const installed = fs.existsSync(targetThemePath);
  const hasBackup = fs.existsSync(backupThemePath);
  const settings = readSettings(userdataDir);
  const active = settings?.defaultTheme === THEME_ID;
  let matchesBundled = false;
  if (installed && fs.existsSync(SOURCE_THEME_PATH)) {
    try {
      const a = JSON.stringify(JSON.parse(fs.readFileSync(targetThemePath, "utf8")));
      const b = JSON.stringify(JSON.parse(fs.readFileSync(SOURCE_THEME_PATH, "utf8")));
      matchesBundled = a === b;
    } catch {
      matchesBundled = false;
    }
  }
  return { themeId: THEME_ID, targetPath: targetThemePath, installed, active, hasBackup, matchesBundled };
}

function extractOfficialTheme(themeObj) {
  const css = typeof themeObj.css === "string" ? themeObj.css : "";
  const idx = css.indexOf(LAYER_2_MARKER);
  const officialCss = idx >= 0 ? css.slice(0, idx).trimEnd() + "\n" : css;
  return { ...themeObj, css: officialCss };
}

function installThemeAt(userdataDir, options = {}) {
  const officialOnly = options.officialOnly === true;
  const activate = options.activate !== false;
  const { themesDir, settingsPath, targetThemePath, backupThemePath } = getThemePaths(userdataDir);

  fs.mkdirSync(themesDir, { recursive: true, mode: 0o700 });
  const raw = fs.readFileSync(SOURCE_THEME_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const content = officialOnly
    ? JSON.stringify(extractOfficialTheme(parsed), null, 2) + "\n"
    : raw;
  if (fs.existsSync(targetThemePath) && !fs.existsSync(backupThemePath)) {
    const current = fs.readFileSync(targetThemePath, "utf8");
    if (current !== content) {
      fs.copyFileSync(targetThemePath, backupThemePath);
    }
  }
  fs.writeFileSync(targetThemePath, content, "utf8");

  let activated = false;
  if (activate) {
    activated = setActiveThemeInSettings(THEME_ID, userdataDir);
    if (!activated && !fs.existsSync(settingsPath) && options.createSettingsIfMissing) {
      fs.writeFileSync(settingsPath, JSON.stringify({
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

function uninstallTheme(userdataDir = USERDATA_DIR) {
  const { targetThemePath, backupThemePath } = getThemePaths(userdataDir);
  const settings = readSettings(userdataDir);
  let deactivated = false;
  if (settings?.defaultTheme === THEME_ID) {
    deactivated = setActiveThemeInSettings(null, userdataDir);
  }
  if (fs.existsSync(backupThemePath)) {
    fs.copyFileSync(backupThemePath, targetThemePath);
    fs.unlinkSync(backupThemePath);
    return { action: "restored-backup", deactivated, targetPath: targetThemePath };
  }
  if (fs.existsSync(targetThemePath)) {
    fs.unlinkSync(targetThemePath);
    return { action: "removed", deactivated, targetPath: targetThemePath };
  }
  return { action: "not-installed", deactivated, targetPath: targetThemePath };
}

module.exports = { getThemeStatus, installTheme, installThemeAt, uninstallTheme, extractOfficialTheme, LAYER_2_MARKER, TARGET_THEME_PATH, SOURCE_THEME_PATH };

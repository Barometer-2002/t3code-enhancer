const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const THEME_ID = "chatgpt-app";
const USERDATA_DIR = path.join(os.homedir(), ".t3", "userdata");
const THEMES_DIR = path.join(USERDATA_DIR, "themes");
const SETTINGS_PATH = path.join(USERDATA_DIR, "settings.json");
const TARGET_THEME_PATH = path.join(THEMES_DIR, `${THEME_ID}.json`);
const BACKUP_THEME_PATH = path.join(THEMES_DIR, `${THEME_ID}.json.before-enhancer`);
const SOURCE_THEME_PATH = path.resolve(__dirname, "..", "themes", `${THEME_ID}.json`);

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function setActiveThemeInSettings(themeId) {
  const settings = readSettings();
  if (!settings || typeof settings !== "object") return false;
  if (themeId) {
    settings.defaultTheme = themeId;
  } else {
    delete settings.defaultTheme;
  }
  settings.defaultThemeSetAt = new Date().toISOString();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return true;
}

function getThemeStatus() {
  const installed = fs.existsSync(TARGET_THEME_PATH);
  const hasBackup = fs.existsSync(BACKUP_THEME_PATH);
  const settings = readSettings();
  const active = settings?.defaultTheme === THEME_ID;
  let matchesBundled = false;
  if (installed && fs.existsSync(SOURCE_THEME_PATH)) {
    try {
      const a = JSON.stringify(JSON.parse(fs.readFileSync(TARGET_THEME_PATH, "utf8")));
      const b = JSON.stringify(JSON.parse(fs.readFileSync(SOURCE_THEME_PATH, "utf8")));
      matchesBundled = a === b;
    } catch {
      matchesBundled = false;
    }
  }
  return { themeId: THEME_ID, targetPath: TARGET_THEME_PATH, installed, active, hasBackup, matchesBundled };
}

function installTheme() {
  fs.mkdirSync(THEMES_DIR, { recursive: true });
  const content = fs.readFileSync(SOURCE_THEME_PATH, "utf8");
  JSON.parse(content); // validate JSON
  if (fs.existsSync(TARGET_THEME_PATH) && !fs.existsSync(BACKUP_THEME_PATH)) {
    fs.copyFileSync(TARGET_THEME_PATH, BACKUP_THEME_PATH);
  }
  fs.writeFileSync(TARGET_THEME_PATH, content, "utf8");
  const activated = setActiveThemeInSettings(THEME_ID);
  return {
    installed: true,
    activated,
    targetPath: TARGET_THEME_PATH,
    backupPath: fs.existsSync(BACKUP_THEME_PATH) ? BACKUP_THEME_PATH : null,
  };
}

function uninstallTheme() {
  const settings = readSettings();
  let deactivated = false;
  if (settings?.defaultTheme === THEME_ID) {
    deactivated = setActiveThemeInSettings(null);
  }
  if (fs.existsSync(BACKUP_THEME_PATH)) {
    fs.copyFileSync(BACKUP_THEME_PATH, TARGET_THEME_PATH);
    fs.unlinkSync(BACKUP_THEME_PATH);
    return { action: "restored-backup", deactivated, targetPath: TARGET_THEME_PATH };
  }
  if (fs.existsSync(TARGET_THEME_PATH)) {
    fs.unlinkSync(TARGET_THEME_PATH);
    return { action: "removed", deactivated, targetPath: TARGET_THEME_PATH };
  }
  return { action: "not-installed", deactivated, targetPath: TARGET_THEME_PATH };
}

module.exports = { getThemeStatus, installTheme, uninstallTheme, TARGET_THEME_PATH, SOURCE_THEME_PATH };

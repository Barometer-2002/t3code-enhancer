#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ALL_PATCHES, inspectArchive, buildPatchedArchive } = require("./cli.cjs");
const { digest, readAsar } = require("./lib/asar.cjs");
const { SOURCE_THEME_PATH } = require("./lib/theme-manager.cjs");

const T3_VERSION = "0.1.11";
const T3_TEAM_ID = "ARK85ZXQ4Z";
const DEFAULT_SOURCE = "/Applications/T3 Code (Beta).app";
const BUNDLE_ID = "com.t3tools.t3code.enhancer";
const DISPLAY_NAME = "T3 Code Enhancer";
const PROFILE_NAME = "t3code-enhancer-profile";
const APP_ASAR = path.join("Contents", "Resources", "app.asar");
const INFO_PLIST = path.join("Contents", "Info.plist");
const applicationsDirectory = path.join(os.homedir(), "Applications");
const installDirectory = path.join(applicationsDirectory, `${DISPLAY_NAME}.app`);
const profileDirectory = path.join(os.homedir(), "Library", "Application Support", PROFILE_NAME);

// macOS 上 Electron userData 固定为 ~/Library/Application Support/t3code-v2，没有环境变量可改。
// 移到独立配置目录后，增强版拥有自己的单实例锁，可以和官方版同时运行。
const userDataPatch = {
  id: "macos-user-data",
  name: "独立 Electron 用户数据目录",
  marker: `"${PROFILE_NAME}/electron"`,
  targetRegex: /^apps\/desktop\/dist-electron\/main\.cjs$/,
  originalHash: "873697d72e3daf3388b16ff8b0ca68bb2cbe15327005b8404b755b53228ebcc6",
  apply(text) {
    const anchor = 'current: "t3code-v2",';
    assert.equal(text.split(anchor).length, 2, "无法唯一定位 userData 目录名");
    return text.replace(anchor, `current: "${PROFILE_NAME}/electron",`);
  },
};
const PATCHES = [...ALL_PATCHES, userDataPatch];

function readPlist(app, key, format = "raw") {
  const output = execFileSync("plutil", ["-extract", key, format, "-o", "-", path.join(app, INFO_PLIST)], { encoding: "utf8" });
  return format === "json" ? JSON.parse(output) : output.trim();
}

function writePlist(app, key, value) {
  execFileSync("plutil", ["-replace", key, "-json", JSON.stringify(value), path.join(app, INFO_PLIST)]);
}

function isManagedInstall() {
  const stat = fs.lstatSync(installDirectory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || !fs.existsSync(path.join(installDirectory, INFO_PLIST))) return false;
  return readPlist(installDirectory, "CFBundleIdentifier") === BUNDLE_ID
    && readPlist(installDirectory, "CFBundleShortVersionString") === T3_VERSION;
}

function isRunning() {
  const processes = execFileSync("ps", ["-axww", "-o", "args="], { encoding: "utf8" });
  return processes.split("\n").some(line => line.startsWith(installDirectory + path.sep));
}

function verifyOfficialSignature(app) {
  try {
    execFileSync("codesign", [
      "--verify", "--deep", "--strict",
      "--test-requirement", `=anchor apple generic and certificate leaf[subject.OU] = "${T3_TEAM_ID}"`,
      app,
    ], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    throw new Error(`官方签名校验失败，请重新安装官方 T3 Code ${T3_VERSION}：${error.stderr?.toString().trim()}`);
  }
}

function writeIfMissing(file, content) {
  try {
    fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

function prepareProfile() {
  const userdata = path.join(profileDirectory, "t3-home", "userdata");
  const themes = path.join(userdata, "themes");
  fs.mkdirSync(themes, { recursive: true, mode: 0o700 });
  writeIfMissing(path.join(themes, "chatgpt-app.json"), fs.readFileSync(SOURCE_THEME_PATH));
  writeIfMissing(path.join(userdata, "settings.json"), JSON.stringify({
    defaultTheme: "chatgpt-app",
    defaultThemeSetAt: new Date().toISOString(),
  }, null, 2) + "\n");
}

function status() {
  if (!fs.lstatSync(installDirectory, { throwIfNoEntry: false })) {
    console.log("macOS 增强版尚未安装。");
    return;
  }
  assert(isManagedInstall(), `安装位置已被其他应用占用：${installDirectory}`);
  const { modules } = inspectArchive(path.join(installDirectory, APP_ASAR), PATCHES);
  assert(modules.every(module => module.installed), "安装目录中的补丁不完整");
  console.log(`T3 Code ${T3_VERSION} macOS 增强版已安装，${isRunning() ? "运行中" : "未运行"}。`);
  console.log(`启动：open "${installDirectory}"`);
  console.log(`独立配置：${profileDirectory}`);
}

function install(input = DEFAULT_SOURCE) {
  if (fs.lstatSync(installDirectory, { throwIfNoEntry: false })) return status();
  const source = path.resolve(input);
  console.log("校验官方 T3 Code 的版本与签名…");
  assert.equal(readPlist(source, "CFBundleShortVersionString"), T3_VERSION, `需要官方 T3 Code ${T3_VERSION}`);
  fs.mkdirSync(applicationsDirectory, { recursive: true });
  const staging = fs.mkdtempSync(path.join(applicationsDirectory, ".t3code-enhancer-"));
  try {
    const app = path.join(staging, `${DISPLAY_NAME}.app`);
    execFileSync("ditto", [source, app]);
    // 校验复制出的副本，保证打补丁的正是官方签名覆盖的那份文件。
    verifyOfficialSignature(app);
    // ditto 会带上原版的下载隔离标记，ad-hoc 签名的副本带着它会被 Gatekeeper 拦截。
    execFileSync("xattr", ["-dr", "com.apple.quarantine", app]);
    console.log("构建并校验补丁…");
    const target = path.join(app, APP_ASAR);
    const patched = target + ".patched";
    buildPatchedArchive(inspectArchive(target, PATCHES).asar, PATCHES, patched);
    fs.chmodSync(patched, fs.statSync(target).mode & 0o777);
    fs.renameSync(patched, target);
    // Electron 的 ASAR 完整性值是头部 JSON 的 SHA-256。
    const { archive } = readAsar(target);
    writePlist(app, "ElectronAsarIntegrity", {
      "Resources/app.asar": { algorithm: "SHA256", hash: digest(archive.subarray(16, 16 + archive.readUInt32LE(12))) },
    });
    writePlist(app, "CFBundleIdentifier", BUNDLE_ID);
    writePlist(app, "CFBundleDisplayName", DISPLAY_NAME);
    writePlist(app, "LSEnvironment", {
      ...readPlist(app, "LSEnvironment", "json"),
      T3CODE_HOME: path.join(profileDirectory, "t3-home"),
      T3CODE_PORT: "3774",
      T3CODE_DISABLE_AUTO_UPDATE: "1",
    });
    // 修改后官方签名失效，改用本机 ad-hoc 签名；不带官方 entitlements，其中部分需要官方描述文件。
    console.log("本机重新签名…");
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "pipe" });
    execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
    prepareProfile();
    fs.renameSync(app, installDirectory);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  status();
}

function uninstall() {
  if (!fs.lstatSync(installDirectory, { throwIfNoEntry: false })) return status();
  assert(isManagedInstall(), `无法确认是本工具安装的应用：${installDirectory}`);
  assert(!isRunning(), "请先退出 macOS 增强版，再运行卸载命令");
  fs.rmSync(installDirectory, { recursive: true });
  console.log(`已卸载 macOS 增强版。独立配置和会话保存在 ${profileDirectory}`);
}

try {
  const [command, input, ...extra] = process.argv.slice(2);
  if (!command || command === "--help") {
    console.log(`用法：node macos.cjs install [T3 Code (Beta).app，默认 ${DEFAULT_SOURCE}] | status | uninstall`);
  } else {
    assert(process.platform === "darwin", "仅支持 macOS");
    assert(process.getuid() !== 0, "请以桌面用户运行");
    assert(extra.length === 0 && (command === "install" || input === undefined), "命令参数不正确");
    if (command === "install") install(input);
    else if (command === "status") status();
    else if (command === "uninstall") uninstall();
    else throw new Error(`未知命令：${command}`);
  }
} catch (error) {
  console.error("错误:", error.message);
  process.exitCode = 1;
}

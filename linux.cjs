#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ALL_PATCHES, inspectArchive, buildPatchedArchive } = require("./cli.cjs");
const { digest } = require("./lib/asar.cjs");
const { SOURCE_THEME_PATH } = require("./lib/theme-manager.cjs");

const T3_VERSION = "0.1.11";
const APPIMAGE_HASH = "8baa06a7bbaa3f729d69466fb211ed7006d6a6e4d800b9ecdacd831fd1686b14";
const MANAGED_FILE = ".t3code-enhancer-appimage";
const APP_DIRECTORY = "squashfs-root";
const APP_ASAR = path.join(APP_DIRECTORY, "resources", "app.asar");
const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const installDirectory = path.join(dataHome, "t3code-enhancer");
const profileDirectory = path.join(dataHome, "t3code-enhancer-profile");
const launcher = `#!/bin/sh
set -eu
base="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
profile="$base/../t3code-enhancer-profile"
export T3CODE_HOME="$profile/t3-home"
export XDG_CONFIG_HOME="$profile/config" XDG_DATA_HOME="$profile/data" XDG_CACHE_HOME="$profile/cache"
export T3CODE_PORT="\${T3CODE_PORT:-3774}" T3CODE_DISABLE_AUTO_UPDATE=1
exec "$base/squashfs-root/AppRun" "$@"
`;

function isManagedInstall(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return false;
  const marker = path.join(directory, MANAGED_FILE);
  return fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === T3_VERSION + "\n";
}

function isRunning(directory) {
  const appPath = fs.realpathSync(path.join(directory, APP_DIRECTORY));
  for (const pid of fs.readdirSync("/proc").filter(entry => /^\d+$/.test(entry))) {
    let executable;
    try {
      executable = fs.readlinkSync(path.join("/proc", pid, "exe"));
    } catch (error) {
      if (["ENOENT", "EACCES", "EPERM", "ESRCH"].includes(error.code)) continue;
      throw error;
    }
    if (executable.startsWith(appPath + path.sep)) return true;
  }
  return false;
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
    console.log("Linux 增强版尚未安装。");
    return;
  }
  assert(isManagedInstall(installDirectory), `安装目录已被其他文件占用：${installDirectory}`);
  const { modules } = inspectArchive(path.join(installDirectory, APP_ASAR));
  assert(modules.every(module => module.installed), "安装目录中的补丁不完整");
  console.log(`T3 Code ${T3_VERSION} Linux 增强版已安装，${isRunning(installDirectory) ? "运行中" : "未运行"}。`);
  console.log(`启动：${path.join(installDirectory, "launch.sh")}`);
  console.log(`独立配置：${profileDirectory}`);
}

function install(input) {
  assert(input, "请提供官方 T3-Code-x86_64.AppImage 的路径");
  if (fs.lstatSync(installDirectory, { throwIfNoEntry: false })) return status();
  const source = path.resolve(input);
  assert(fs.statSync(source).isFile(), "AppImage 路径必须是文件");
  fs.mkdirSync(dataHome, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dataHome, ".t3code-enhancer-"));
  try {
    const image = path.join(staging, "T3-Code-x86_64.AppImage");
    fs.copyFileSync(source, image, fs.constants.COPYFILE_EXCL);
    assert.equal(digest(fs.readFileSync(image)), APPIMAGE_HASH,
      `需要官方 T3 Code ${T3_VERSION} x86_64 AppImage（SHA-256 不匹配）`);
    fs.chmodSync(image, 0o700);
    console.log("解包官方 AppImage 并校验前端补丁…");
    execFileSync(image, ["--appimage-extract"], { cwd: staging, stdio: ["ignore", "ignore", "inherit"] });
    fs.accessSync(path.join(staging, APP_DIRECTORY, "AppRun"), fs.constants.X_OK);
    const target = path.join(staging, APP_ASAR);
    const patched = target + ".patched";
    buildPatchedArchive(inspectArchive(target).asar, ALL_PATCHES, patched);
    fs.chmodSync(patched, fs.statSync(target).mode & 0o777);
    fs.renameSync(patched, target);
    fs.unlinkSync(image);
    prepareProfile();
    fs.writeFileSync(path.join(staging, "launch.sh"), launcher, { mode: 0o700 });
    fs.writeFileSync(path.join(staging, MANAGED_FILE), T3_VERSION + "\n");
    fs.renameSync(staging, installDirectory);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  status();
}

function uninstall() {
  if (!fs.lstatSync(installDirectory, { throwIfNoEntry: false })) return status();
  assert(isManagedInstall(installDirectory), `无法确认是本工具安装的目录：${installDirectory}`);
  assert(!isRunning(installDirectory), "请先退出 Linux 增强版，再运行卸载命令");
  fs.rmSync(installDirectory, { recursive: true });
  console.log(`已卸载 Linux 增强版。独立配置和会话保存在 ${profileDirectory}`);
}

try {
  const [command, input, ...extra] = process.argv.slice(2);
  if (!command || command === "--help") {
    console.log("用法：node linux.cjs install <AppImage> | status | uninstall");
  } else {
    assert(process.platform === "linux" && process.arch === "x64", "仅支持 Linux x86_64");
    assert(process.getuid() !== 0, "请以桌面用户运行");
    assert(path.isAbsolute(dataHome), "XDG_DATA_HOME 必须是绝对路径");
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

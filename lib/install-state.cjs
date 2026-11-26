"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

function withInstallDirectoryLock(lock, operation) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`另一个维护命令持有安装锁。确认该命令已退出后，可移除空锁目录：${lock}`, { cause: error });
  }
  try {
    return operation();
  } finally {
    fs.rmdirSync(lock);
  }
}

function retirePreviousInstall(previous) {
  // Move the backup out of the rollback slot before removing its contents.
  let staging;
  try {
    staging = fs.mkdtempSync(path.join(path.dirname(previous), ".t3code-enhancer-"));
    fs.renameSync(previous, path.join(staging, "previous"));
    fs.rmSync(staging, { recursive: true, force: true });
  } catch (error) {
    const remaining = fs.existsSync(previous) ? previous : staging;
    console.warn(`旧安装清理未完成，请检查 ${remaining}（${error.message}）`);
  }
}

function recoverPreviousInstall(installDirectory, previous, isManagedInstall, inspectCurrent) {
  if (!fs.lstatSync(previous, { throwIfNoEntry: false })) return;
  assert(isManagedInstall(previous), `无法确认旧安装备份：${previous}`);
  if (!fs.lstatSync(installDirectory, { throwIfNoEntry: false })) {
    fs.renameSync(previous, installDirectory);
    return;
  }
  inspectCurrent();
  retirePreviousInstall(previous);
  assert(!fs.existsSync(previous), `无法清理旧安装备份：${previous}`);
}

function replaceStagedInstall(staged, destination, previous, hooks = {}) {
  if (previous) fs.renameSync(destination, previous);
  try {
    fs.renameSync(staged, destination);
    if (typeof hooks.afterCommit === "function") {
      hooks.afterCommit();
    }
  } catch (error) {
    if (typeof hooks.onRollback === "function") {
      try { hooks.onRollback(); } catch {}
    }
    if (previous) {
      try {
        fs.rmSync(destination, { recursive: true, force: true });
        fs.renameSync(previous, destination);
      } catch (rollbackError) {
        throw new Error(`安装失败，无法恢复原安装位置。旧安装仍保存在 ${previous}（${rollbackError.message}）`, { cause: error });
      }
    } else {
      try {
        fs.rmSync(destination, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  }
  if (previous) retirePreviousInstall(previous);
}

function cleanupStagingDirectories(directory) {
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) {
    if (/^\.t3code-enhancer-[A-Za-z0-9]{6}$/.test(name)) {
      fs.rmSync(path.join(directory, name), { recursive: true, force: true });
    }
  }
}

module.exports = { withInstallDirectoryLock, recoverPreviousInstall, replaceStagedInstall, cleanupStagingDirectories };

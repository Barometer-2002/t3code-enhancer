"use strict";

const fs = require("node:fs");
const path = require("node:path");

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

module.exports = { withInstallDirectoryLock, retirePreviousInstall };

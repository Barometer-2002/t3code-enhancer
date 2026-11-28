"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { prepareSavedPlanTransaction } = require("./engine.cjs");
const { prepareThemeTransaction } = require("./theme-manager.cjs");

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

function prepareInstallStateTransaction(plan, userdataDir, planDirectory) {
  const themeTx = plan.includeTheme
    ? prepareThemeTransaction(userdataDir, { officialOnly: plan.officialOnly, createSettingsIfMissing: true })
    : null;
  const planTx = prepareSavedPlanTransaction(planDirectory, plan, plan.selectedPatches);
  let started = false;

  function rollback() {
    if (!started) return;
    started = false;
    const errors = [];
    for (const tx of [planTx, themeTx]) {
      try { tx?.rollback(); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      throw new AggregateError(errors, errors.map((error) => error.message).join("、"));
    }
  }

  return {
    commit() {
      started = true;
      try {
        const theme = themeTx?.commit();
        planTx.commit();
        if (theme && !theme.activated) {
          console.warn("[提示] 主题已写入，但未能自动激活：请检查设置文件后手动切换主题");
        }
      } catch (error) {
        try { rollback(); } catch (rollbackError) {
          throw new Error(`${error.message}。配置回滚失败：${rollbackError.message}`, { cause: error });
        }
        throw error;
      }
    },
    rollback,
  };
}

module.exports = { withInstallDirectoryLock, recoverPreviousInstall, replaceStagedInstall, cleanupStagingDirectories, prepareInstallStateTransaction };

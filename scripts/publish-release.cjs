"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ENHANCER_VERSION,
  ENHANCER_TAG,
  ENHANCER_VERSION_INFO,
  T3_BASELINE_VERSION,
} = require("../lib/version.cjs");
const { runPreflight } = require("./preflight.cjs");
const { verifyPackagedZip } = require("./pack-release.cjs");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const opts = {
    execute: false,
    publish: false,
    allowBranch: false,
    skipPreflight: false,
    skipRemoteCheck: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") opts.execute = true;
    else if (arg === "--publish") opts.publish = true;
    else if (arg === "--allow-branch") opts.allowBranch = true;
    else if (arg === "--skip-preflight") opts.skipPreflight = true;
    else if (arg === "--skip-remote-check") opts.skipRemoteCheck = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(
        [
          "用法: node scripts/publish-release.cjs [选项]",
          "",
          "默认以 dry-run 演练模式运行，仅校验并打印即将执行的命令。",
          "",
          "选项:",
          "  --execute           真正执行 git tag、git push 与 gh release create",
          "  --publish           直接公开发布 Release（默认先创建 --draft 草稿，推荐在网页最后确认）",
          "  --allow-branch      允许在非 main 分支发版（默认仅允许 main）",
          "  --skip-preflight    跳过内置的 preflight --ci 检查",
          "  --skip-remote-check 跳过远端 origin 标签探测（仅离线 dry-run 时使用）",
          "  --json              输出 JSON 检查结果",
        ].join("\n")
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

function runCmd(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || (res.error ? res.error.message : ""),
  };
}

function validateReleaseReadiness(repoRoot = DEFAULT_REPO_ROOT, options = {}) {
  const errors = [];
  const warnings = [];
  const tag = ENHANCER_TAG;
  const zipName = `t3code-enhancer-${tag}.zip`;
  const zipPath = path.join(repoRoot, "dist", zipName);
  const notesPath = path.join(repoRoot, "dist", `release-${tag}.md`);

  const branchRes = runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const branch = branchRes.ok ? branchRes.stdout.trim() : "";
  if (!branch) {
    errors.push("当前目录不是有效的 Git 仓库");
  } else if (branch !== "main" && !options.allowBranch) {
    errors.push(`当前分支为 "${branch}"，发版必须在 main 分支进行（特殊情况可显式传 --allow-branch）`);
  }

  const statusRes = runCmd("git", ["status", "--porcelain"], repoRoot);
  if (!statusRes.ok) {
    errors.push(`无法检查工作区状态：${statusRes.stderr.trim()}`);
  } else if (statusRes.stdout.trim()) {
    errors.push(`工作区存在未提交改动，请先提交或清理：\n${statusRes.stdout.trim()}`);
  }
  const commitRes = runCmd("git", ["rev-parse", "--verify", "HEAD^{commit}"], repoRoot);
  const commit = commitRes.ok ? commitRes.stdout.trim() : "";
  if (!commit) errors.push("无法确认要发布的 Git 提交。");

  // Immutable tag guard (local + remote)
  const localTag = runCmd("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], repoRoot);
  if (localTag.ok && localTag.stdout.trim()) {
    errors.push(`本地已存在标签 ${tag}（禁止原地覆写已发布版本，请先递增 package.json 版本号）`);
  }
  if (!options.skipRemoteCheck) {
    const remoteTag = runCmd("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], repoRoot);
    if (!remoteTag.ok) {
      const msg = `无法查询远端 origin 标签（${remoteTag.stderr.trim() || "可能处于离线环境"}）`;
      if (options.execute) errors.push(msg);
      else warnings.push(msg);
    } else if (remoteTag.stdout.trim()) {
      errors.push(`远端 origin 已存在标签 ${tag}（禁止原地覆写已发布版本）`);
    }
  }

  // Check if local branch is behind origin/main
  if (branch === "main" && !options.skipRemoteCheck) {
    const behindRes = runCmd("git", ["rev-list", "--count", "HEAD..origin/main"], repoRoot);
    if (behindRes.ok && Number(behindRes.stdout.trim()) > 0) {
      errors.push(`本地 main 落后于 origin/main ${behindRes.stdout.trim()} 个提交，请先同步再发版`);
    }
  }

  // Verify ZIP + SHA-256
  let zipInfo = null;
  if (!fs.existsSync(zipPath)) {
    errors.push(`缺少发行包 ${zipPath}，请先运行 npm run release:pack`);
  } else if (commit) {
    try {
      zipInfo = verifyPackagedZip(zipPath, tag, { runUnitTests: false, source: { repoRoot, commit } });
    } catch (err) {
      errors.push(`发行包校验失败：${err.message}`);
    }
  }

  // Verify release notes exist, have no TODO placeholders, and match ZIP SHA-256
  let notesSha256 = null;
  if (!fs.existsSync(notesPath)) {
    errors.push(`缺少发版说明 ${notesPath}（可先运行 npm run release:pack -- --write-notes 生成模板并填写）`);
  } else {
    const notesBytes = fs.readFileSync(notesPath);
    const notes = notesBytes.toString("utf8");
    notesSha256 = createHash("sha256").update(notesBytes).digest("hex");
    if (!notes.trim()) errors.push(`发版说明 ${notesPath} 为空`);
    if (/\bTODO:/i.test(notes)) {
      errors.push(`发版说明 ${notesPath} 仍包含未填写的 TODO: 占位符`);
    }
    if (zipInfo && !notes.includes(zipInfo.sha256)) {
      errors.push(
        `发版说明 ${notesPath} 未包含当前发行包的 SHA-256（${zipInfo.sha256}），请运行 npm run release:pack -- --update-notes 刷新`
      );
    }
  }

  // Run static + unit preflight
  if (!options.skipPreflight && errors.length === 0) {
    const pf = runPreflight(repoRoot, { ci: true, strictClean: true, json: options.json });
    if (!pf.ok) {
      for (const e of pf.errors) errors.push(`preflight: ${e}`);
    }
  }

  // Check gh availability
  const ghCheck = runCmd("gh", ["--version"], repoRoot);
  if (!ghCheck.ok) {
    const msg = "未检测到 GitHub CLI (gh)，无法创建 GitHub Release";
    if (options.execute) errors.push(msg);
    else warnings.push(msg);
  }

  const ghReleaseArgs = [
    "release",
    "create",
    tag,
    zipPath,
    "--verify-tag",
    "--title",
    tag,
    "--notes-file",
    notesPath,
  ];
  if (ENHANCER_VERSION_INFO.isPrerelease) ghReleaseArgs.push("--prerelease");
  if (!options.publish) ghReleaseArgs.push("--draft");

  return {
    ok: errors.length === 0,
    mode: options.execute ? "execute" : "dry-run",
    draft: !options.publish,
    prerelease: ENHANCER_VERSION_INFO.isPrerelease,
    version: ENHANCER_VERSION,
    tag,
    baselineVersion: T3_BASELINE_VERSION,
    branch,
    commit,
    zipPath,
    notesPath,
    notesSha256,
    zipInfo,
    plannedCommands: [
      `git push origin ${commit}:refs/heads/${branch || "main"}`,
      `git tag -a ${tag} ${commit} -m "Release ${tag}"`,
      `git push origin ${tag}`,
      `gh ${ghReleaseArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`,
    ],
    ghReleaseArgs,
    warnings,
    errors,
  };
}

function executeRelease(repoRoot, plan) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-publish-"));
  try {
    const stagedFiles = new Map();
    for (const [file, expectedHash] of [[plan.zipPath, plan.zipInfo.sha256], [plan.notesPath, plan.notesSha256]]) {
      const bytes = fs.readFileSync(file);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        expectedHash,
        `校验后文件发生变更，请重新运行发版校验：${file}`
      );
      const stagedFile = path.join(staging, path.basename(file));
      fs.writeFileSync(stagedFile, bytes, { flag: "wx" });
      stagedFiles.set(file, stagedFile);
    }
    const steps = [
      { cmd: "git", args: ["push", "origin", `${plan.commit}:refs/heads/${plan.branch}`] },
      { cmd: "git", args: ["tag", "-a", plan.tag, plan.commit, "-m", `Release ${plan.tag}`] },
      { cmd: "git", args: ["push", "origin", plan.tag] },
      { cmd: "gh", args: plan.ghReleaseArgs.map((arg) => stagedFiles.get(arg) ?? arg) },
    ];
    const outputs = [];
    for (const step of steps) {
      const res = runCmd(step.cmd, step.args, repoRoot);
      outputs.push({ command: `${step.cmd} ${step.args.join(" ")}`, ok: res.ok, stdout: res.stdout.trim(), stderr: res.stderr.trim() });
      if (!res.ok) {
        throw new Error(`执行失败：${step.cmd} ${step.args.join(" ")}\n${res.stderr || res.stdout}`);
      }
    }
    return outputs;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`错误：${err.message}`);
    process.exit(1);
  }

  const plan = validateReleaseReadiness(DEFAULT_REPO_ROOT, opts);
  if (!plan.ok) {
    if (opts.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.error(`发版前校验未通过（${plan.tag}）：`);
      for (const e of plan.errors) console.error(`  ✖ ${e}`);
      for (const w of plan.warnings) console.warn(`  ⚠ ${w}`);
    }
    process.exit(1);
  }

  if (!opts.execute) {
    if (opts.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(`Dry-run 校验通过：${plan.tag} (${plan.prerelease ? "prerelease" : "stable"}, ${plan.draft ? "draft" : "public"})`);
      if (plan.zipInfo) {
        console.log(`  发行包：${plan.zipPath} (${plan.zipInfo.fileCount} 文件, SHA-256: ${plan.zipInfo.sha256})`);
      }
      console.log("  计划执行命令：");
      for (const cmd of plan.plannedCommands) console.log(`    ${cmd}`);
      if (plan.warnings.length > 0) {
        console.log("  提示：");
        for (const w of plan.warnings) console.log(`    ⚠ ${w}`);
      }
      console.log("\n确认无误后，追加 --execute 即可创建 GitHub Draft Release。");
    }
    process.exit(0);
  }

  try {
    const outputs = executeRelease(DEFAULT_REPO_ROOT, plan);
    const releaseUrl = outputs[outputs.length - 1]?.stdout || "";
    if (opts.json) {
      console.log(JSON.stringify({ ...plan, executed: true, releaseUrl, outputs }, null, 2));
    } else {
      console.log(`\n发版命令执行完成：${plan.tag}`);
      if (releaseUrl) console.log(`  Release 链接：${releaseUrl}`);
      if (plan.draft) {
        console.log("  当前为 Draft 草稿，请前往 GitHub 页面核对说明与附件后点击 Publish release。");
      }
      console.log("  本机实机验证提醒：请先彻底退出 T3 Code（含系统托盘），再运行 node cli.cjs repair。");
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  validateReleaseReadiness,
};

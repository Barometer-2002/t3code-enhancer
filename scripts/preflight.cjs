"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { ALL_PATCHES, PATCH_RUNTIME_NAMES } = require("../lib/engine.cjs");
const { PACKS, PATCH_GROUPS } = require("../lib/packs.cjs");
const { loadRuntimeExports } = require("../lib/runtime-loader.cjs");
const {
  ENHANCER_VERSION,
  ENHANCER_TAG,
  T3_BASELINE_VERSION,
  parseProjectReleaseVersion,
} = require("../lib/version.cjs");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");
const LF_EXTENSIONS = new Set([".cjs", ".mjs", ".json", ".md", ".html", ".svg", ".txt", ".yml", ".yaml"]);
const LF_EXACT_NAMES = new Set([".gitattributes", ".gitignore", "install.sh"]);
const CMD_FILES = ["install.cmd", "repair.cmd", "status.cmd", "uninstall.cmd"];
const SKIP_DIRS = new Set([".git", "dist", "node_modules"]);
const MARKER_VERSION_RE = /^(T3_[A-Z0-9_]+_V)([1-9]\d*)$/;

function parseArgs(argv) {
  const opts = {
    ci: false,
    full: false,
    e2e: false,
    skipTests: false,
    strictClean: false,
    strictMarkers: false,
    json: false,
    baseRef: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ci") opts.ci = true;
    else if (arg === "--full") opts.full = true;
    else if (arg === "--e2e") opts.e2e = true;
    else if (arg === "--skip-tests") opts.skipTests = true;
    else if (arg === "--strict-clean") opts.strictClean = true;
    else if (arg === "--strict-markers") opts.strictMarkers = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--base" && argv[i + 1]) opts.baseRef = argv[++i];
    else if (arg.startsWith("--base=")) opts.baseRef = arg.slice("--base=".length);
    else if (arg === "-h" || arg === "--help") {
      console.log(
        [
          "用法: node scripts/preflight.cjs [选项]",
          "",
          "选项:",
          "  --ci              CI 模式（全部静态/门禁检查 + npm run test:unit）",
          "  --full            本地完整门禁（包含 Suite 17~18 跨版本与事务测试）",
          "  --e2e             追加独立隔离浏览器回归测试（npm run test:e2e）",
          "  --skip-tests      仅跑静态、行尾、登记、文档与 Git diff 门禁",
          "  --strict-clean    要求 Git 工作区完全干净（发版前使用）",
          "  --strict-markers  补丁/运行时改动未递增 MARKER 时直接失败（默认告警）",
          "  --base <ref>      指定对比基准分支/提交（默认自动探测 origin/main / main / HEAD）",
          "  --json            输出机器可读 JSON 报告",
        ].join("\n")
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

function runGit(repoRoot, args, { allowFail = false } = {}) {
  const res = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) {
    if (allowFail) return { ok: false, stdout: "", stderr: res.error.message, status: -1 };
    throw res.error;
  }
  const ok = res.status === 0;
  if (!ok && !allowFail) {
    throw new Error(`git ${args.join(" ")} 失败：${(res.stderr || res.stdout || "").trim()}`);
  }
  return { ok, stdout: res.stdout || "", stderr: res.stderr || "", status: res.status };
}

function isGitRepo(repoRoot) {
  return runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"], { allowFail: true }).stdout.trim() === "true";
}

function walkRepoFiles(repoRoot, currentRel = "", out = []) {
  const fullDir = currentRel ? path.join(repoRoot, currentRel) : repoRoot;
  for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
    const rel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkRepoFiles(repoRoot, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function checkZeroDeps(repoRoot) {
  const errors = [];
  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (pkg[field] && Object.keys(pkg[field]).length > 0) {
      errors.push(`package.json 禁止引入外部依赖（检测到 ${field}: ${Object.keys(pkg[field]).join(", ")}）`);
    }
  }
  try {
    parseProjectReleaseVersion(pkg.version);
  } catch (err) {
    errors.push(`package.json 版本号不合法：${err.message}`);
  }
  return { ok: errors.length === 0, errors, warnings: [], version: pkg.version };
}

function checkPatchAndRuntimeRegistry(repoRoot) {
  const errors = [];
  const warnings = [];

  const seenIds = new Set();
  const patchById = new Map();
  for (const patch of ALL_PATCHES) {
    if (!patch || !patch.id) {
      errors.push("ALL_PATCHES 中存在缺少 id 的补丁项");
      continue;
    }
    if (seenIds.has(patch.id)) errors.push(`ALL_PATCHES 存在重复补丁 id：${patch.id}`);
    seenIds.add(patch.id);
    patchById.set(patch.id, patch);

    if (!patch.targetSpec) {
      errors.push(`补丁 ${patch.id} 缺少 targetSpec（禁止纯 hash 钉死）`);
    }
    if (typeof patch.marker !== "string" || !patch.marker) {
      errors.push(`补丁 ${patch.id} 缺少有效 marker`);
      continue;
    }
    const legacy = Array.isArray(patch.legacyMarkers) ? patch.legacyMarkers : [];
    const legacySet = new Set(legacy);
    if (legacySet.size !== legacy.length) {
      errors.push(`补丁 ${patch.id} 的 legacyMarkers 存在重复项`);
    }
    if (legacySet.has(patch.marker)) {
      errors.push(`补丁 ${patch.id} 的当前 marker "${patch.marker}" 不应出现在 legacyMarkers 中`);
    }
    const m = MARKER_VERSION_RE.exec(patch.marker);
    if (!m) {
      errors.push(`补丁 ${patch.id} 的 marker "${patch.marker}" 不符合 T3_*_V<N> 规范`);
    } else {
      const prefix = m[1];
      const ver = Number(m[2]);
      for (let v = 1; v < ver; v++) {
        const expectedLegacy = `${prefix}${v}`;
        if (!legacySet.has(expectedLegacy)) {
          errors.push(`补丁 ${patch.id} 当前 marker 为 ${patch.marker}，但 legacyMarkers 缺失 ${expectedLegacy}`);
        }
      }
    }
  }

  // Verify PACKS and PATCH_GROUPS cover ALL_PATCHES cleanly
  const packedIds = new Set();
  for (const pack of PACKS) {
    for (const id of pack.patchIds || []) {
      if (!patchById.has(id)) {
        errors.push(`PACKS["${pack.id}"] 引用了未在 ALL_PATCHES 登记的补丁：${id}`);
      }
      packedIds.add(id);
    }
  }
  for (const id of seenIds) {
    if (!packedIds.has(id)) {
      errors.push(`补丁 ${id} 已登记在 ALL_PATCHES，但未加入任何 lib/packs.cjs 的 PACKS`);
    }
  }
  for (const group of PATCH_GROUPS) {
    for (const id of group) {
      if (!patchById.has(id)) {
        errors.push(`PATCH_GROUPS 引用了未在 ALL_PATCHES 登记的补丁：${id}`);
      }
    }
  }

  // Verify lib/runtime/*.mjs <-> PATCH_RUNTIME_NAMES 1-to-1 and zero top-level imports
  const runtimeDir = path.join(repoRoot, "lib", "runtime");
  const diskRuntimes = fs
    .readdirSync(runtimeDir)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => f.slice(0, -4))
    .sort();
  const registeredRuntimes = new Set(Object.values(PATCH_RUNTIME_NAMES));

  for (const [patchId, rtName] of Object.entries(PATCH_RUNTIME_NAMES)) {
    if (!patchById.has(patchId)) {
      errors.push(`PATCH_RUNTIME_NAMES 引用了未知补丁 id：${patchId}`);
    }
    if (!diskRuntimes.includes(rtName)) {
      errors.push(`PATCH_RUNTIME_NAMES["${patchId}"] 指向不存在的运行时：lib/runtime/${rtName}.mjs`);
    }
  }
  for (const rtName of diskRuntimes) {
    if (!registeredRuntimes.has(rtName)) {
      errors.push(`外置运行时 lib/runtime/${rtName}.mjs 未登记到 lib/engine.cjs 的 PATCH_RUNTIME_NAMES`);
    }
    try {
      const exportsObj = loadRuntimeExports(rtName);
      if (!exportsObj || Object.keys(exportsObj).length === 0) {
        errors.push(`外置运行时 lib/runtime/${rtName}.mjs 未导出任何符号`);
      }
    } catch (err) {
      errors.push(`外置运行时 lib/runtime/${rtName}.mjs 校验失败：${err.message}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    patchCount: ALL_PATCHES.length,
    runtimeCount: diskRuntimes.length,
  };
}

function checkEolAndHygiene(repoRoot) {
  const errors = [];
  const warnings = [];

  const installShPath = path.join(repoRoot, "install.sh");
  const installSh = fs.readFileSync(installShPath, "utf8");
  if (installSh.includes("\r\n") || installSh.includes("\r")) {
    errors.push("install.sh 必须使用 LF 行尾");
  }
  if (!installSh.startsWith("#!/usr/bin/env sh\n")) {
    errors.push("install.sh 首行必须保持 #!/usr/bin/env sh");
  }
  if (isGitRepo(repoRoot)) {
    const stage = runGit(repoRoot, ["ls-files", "--stage", "install.sh"], { allowFail: true });
    if (stage.ok && stage.stdout.trim()) {
      const mode = stage.stdout.trim().split(/\s+/)[0];
      if (mode !== "100755") {
        errors.push(`install.sh 在 Git 索引中的权限应为 100755，当前为 ${mode}（可运行 git update-index --chmod=+x install.sh 修复）`);
      }
    }
  }

  for (const cmdFile of CMD_FILES) {
    const raw = fs.readFileSync(path.join(repoRoot, cmdFile), "utf8");
    if (!raw.includes("\r\n")) {
      errors.push(`${cmdFile} 必须使用 CRLF 行尾`);
    }
    if (/(^|[^\r])\n/.test(raw)) {
      errors.push(`${cmdFile} 混入了单独的 LF 行尾，请统一为 CRLF`);
    }
    if (!raw.includes("chcp 65001")) {
      errors.push(`${cmdFile} 必须包含 chcp 65001 以避免 Windows 控制台乱码`);
    }
  }

  for (const rel of walkRepoFiles(repoRoot)) {
    const base = path.basename(rel);
    const ext = path.extname(rel).toLowerCase();
    if (!LF_EXACT_NAMES.has(base) && !LF_EXTENSIONS.has(ext)) continue;
    const raw = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    if (raw.includes("\r\n")) {
      errors.push(`${rel} 含有 CRLF 行尾，应保持 LF（与 .gitattributes 一致）`);
    }
  }

  // Theme layer markers
  const themePath = path.join(repoRoot, "themes", "chatgpt-app.json");
  try {
    const theme = JSON.parse(fs.readFileSync(themePath, "utf8"));
    const css = typeof theme.css === "string" ? theme.css : "";
    const l1 = css.indexOf("/* === LAYER 1:");
    const l2 = css.indexOf("/* === LAYER 2:");
    const l3 = css.indexOf("/* === LAYER 3:");
    if (!(l1 >= 0 && l2 > l1 && l3 > l2)) {
      errors.push("themes/chatgpt-app.json 缺失或破坏了 LAYER 1 / LAYER 2 / LAYER 3 边界注释顺序");
    }
  } catch (err) {
    errors.push(`themes/chatgpt-app.json 解析失败：${err.message}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

function checkDocsAlignment(repoRoot) {
  const errors = [];
  const warnings = [];
  const shieldsTag = ENHANCER_TAG.replace(/-/g, "--");

  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  if (!readme.includes(ENHANCER_TAG) && !readme.includes(shieldsTag)) {
    errors.push(`README.md 未包含当前版本号 ${ENHANCER_TAG}（请同步更新徽章或下载文案）`);
  }
  if (!readme.includes(T3_BASELINE_VERSION)) {
    errors.push(`README.md 未包含当前基线版本 ${T3_BASELINE_VERSION}`);
  }

  const guide = fs.readFileSync(path.join(repoRoot, "使用教程.md"), "utf8");
  if (!guide.includes(ENHANCER_TAG)) {
    errors.push(`使用教程.md 未包含当前版本号 ${ENHANCER_TAG}`);
  }
  if (!guide.includes(T3_BASELINE_VERSION)) {
    errors.push(`使用教程.md 未包含当前基线版本 ${T3_BASELINE_VERSION}`);
  }

  const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
  if (!agents.includes(T3_BASELINE_VERSION)) {
    errors.push(`AGENTS.md 未同步当前基线版本 ${T3_BASELINE_VERSION}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    enhancerTag: ENHANCER_TAG,
    baselineVersion: T3_BASELINE_VERSION,
  };
}

function extractMarkersFromPatchSource(source) {
  const markers = new Set();
  const constRe = /\b(?:const|let|var)\s+[A-Z0-9_]*MARKER\s*=\s*["'](T3_[A-Z0-9_]+_V[1-9]\d*)["']/g;
  for (const m of source.matchAll(constRe)) markers.add(m[1]);
  const propRe = /\bmarker\s*:\s*["'](T3_[A-Z0-9_]+_V[1-9]\d*)["']/g;
  for (const m of source.matchAll(propRe)) markers.add(m[1]);
  return [...markers];
}

function mapPatchFilesToPatches(repoRoot) {
  const map = new Map();
  const patchDir = path.join(repoRoot, "lib", "patches");
  for (const file of fs.readdirSync(patchDir).filter((f) => f.endsWith(".cjs")).sort()) {
    const mod = require(path.join(patchDir, file));
    const list = [];
    const seen = new Set();
    const visit = (val) => {
      if (val && typeof val === "object" && typeof val.id === "string" && typeof val.marker === "string" && !seen.has(val.id)) {
        seen.add(val.id);
        list.push(val);
      }
    };
    visit(mod);
    for (const v of Object.values(mod)) visit(v);
    map.set(`lib/patches/${file}`, list);
  }
  return map;
}

function resolveBaseRef(repoRoot, requestedBase) {
  const candidates = [];
  if (requestedBase) candidates.push(requestedBase);
  if (process.env.GITHUB_BASE_REF) {
    candidates.push(`origin/${process.env.GITHUB_BASE_REF}`, process.env.GITHUB_BASE_REF);
  }
  candidates.push("origin/main", "main", "HEAD");
  for (const ref of candidates) {
    if (!ref) continue;
    const probe = runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
    if (probe.ok) return ref;
  }
  return null;
}

function checkGitAndMarkers(repoRoot, options = {}) {
  const errors = [];
  const warnings = [];

  if (!isGitRepo(repoRoot)) {
    return { ok: true, skipped: true, errors, warnings, baseRef: null, changedFiles: [] };
  }

  const baseRef = resolveBaseRef(repoRoot, options.baseRef);

  // 1) Whitespace / conflict marker check
  for (const args of [["diff", "--check"], ["diff", "--cached", "--check"]]) {
    const res = runGit(repoRoot, args, { allowFail: true });
    if (!res.ok) {
      errors.push(`git ${args.join(" ")} 发现空白或冲突残渣：\n${(res.stdout || res.stderr).trim()}`);
    }
  }
  if (baseRef && baseRef !== "HEAD") {
    const headSha = runGit(repoRoot, ["rev-parse", "HEAD"], { allowFail: true }).stdout.trim();
    const baseSha = runGit(repoRoot, ["rev-parse", baseRef], { allowFail: true }).stdout.trim();
    if (headSha && baseSha && headSha !== baseSha) {
      const rangeCheck = runGit(repoRoot, ["diff", "--check", `${baseRef}...HEAD`], { allowFail: true });
      if (!rangeCheck.ok) {
        errors.push(`git diff --check ${baseRef}...HEAD 发现空白或冲突残渣：\n${(rangeCheck.stdout || rangeCheck.stderr).trim()}`);
      }
    }
  }

  // 2) Clean working tree check if requested
  const statusOut = runGit(repoRoot, ["status", "--porcelain"], { allowFail: true }).stdout;
  if (options.strictClean && statusOut.trim()) {
    errors.push(`工作区存在未提交改动（--strict-clean 禁止继续）：\n${statusOut.trim()}`);
  }

  // 3) Collect changed files vs baseRef + staged + unstaged
  const changedSet = new Set();
  const collectNames = (args) => {
    const res = runGit(repoRoot, args, { allowFail: true });
    if (!res.ok) return;
    for (const line of res.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) changedSet.add(trimmed.replace(/\\/g, "/"));
    }
  };
  if (baseRef) collectNames(["diff", "--name-only", `${baseRef}...HEAD`]);
  collectNames(["diff", "--name-only", "--cached"]);
  collectNames(["diff", "--name-only"]);

  const changedFiles = [...changedSet].sort();

  // 4) Patch / runtime marker bump awareness
  const patchFileMap = mapPatchFilesToPatches(repoRoot);
  const runtimeToPatchFiles = new Map();
  for (const [patchFile, patches] of patchFileMap.entries()) {
    for (const patch of patches) {
      const rtName = PATCH_RUNTIME_NAMES[patch.id];
      if (!rtName) continue;
      const rtPath = `lib/runtime/${rtName}.mjs`;
      if (!runtimeToPatchFiles.has(rtPath)) runtimeToPatchFiles.set(rtPath, new Set());
      runtimeToPatchFiles.get(rtPath).add(patchFile);
    }
  }

  const touchedPatchFiles = new Set();
  for (const rel of changedFiles) {
    if (patchFileMap.has(rel)) touchedPatchFiles.add(rel);
    if (runtimeToPatchFiles.has(rel)) {
      for (const pf of runtimeToPatchFiles.get(rel)) touchedPatchFiles.add(pf);
    }
  }

  if (baseRef && touchedPatchFiles.size > 0) {
    for (const patchFile of [...touchedPatchFiles].sort()) {
      const baseSrcRes = runGit(repoRoot, ["show", `${baseRef}:${patchFile}`], { allowFail: true });
      if (!baseSrcRes.ok) continue; // Newly added patch file
      const baseMarkers = extractMarkersFromPatchSource(baseSrcRes.stdout);
      const currentPatches = patchFileMap.get(patchFile) || [];
      const currentMarkers = new Set(currentPatches.map((p) => p.marker));
      const allCurrentLegacy = new Set(currentPatches.flatMap((p) => p.legacyMarkers || []));

      // If any base marker disappeared from current markers, it MUST be preserved in legacyMarkers.
      for (const oldMarker of baseMarkers) {
        if (!currentMarkers.has(oldMarker) && !allCurrentLegacy.has(oldMarker)) {
          errors.push(`${patchFile} 移除了旧 marker "${oldMarker}"，但未将其加入 legacyMarkers`);
        }
      }

      const anyBumped = baseMarkers.some((oldMarker) => !currentMarkers.has(oldMarker));
      if (baseMarkers.length > 0 && !anyBumped) {
        const msg = `${patchFile}（或其外置运行时）相对 ${baseRef} 有改动，但所有 MARKER 均未递增（若改动了注入结构，请按 AGENTS.md 递增 MARKER 并加入 LEGACY_MARKERS）`;
        if (options.strictMarkers) errors.push(msg);
        else warnings.push(msg);
      }
    }
  }

  return {
    ok: errors.length === 0,
    skipped: false,
    errors,
    warnings,
    baseRef,
    changedFiles,
    touchedPatchFiles: [...touchedPatchFiles].sort(),
  };
}

function runTestCommand(repoRoot, args, label) {
  const res = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${label} 失败（退出码 ${res.status}）`);
  }
}

function runPreflight(repoRoot = DEFAULT_REPO_ROOT, options = {}) {
  const checks = {
    zeroDeps: checkZeroDeps(repoRoot),
    registry: checkPatchAndRuntimeRegistry(repoRoot),
    hygiene: checkEolAndHygiene(repoRoot),
    docs: checkDocsAlignment(repoRoot),
    gitAndMarkers: checkGitAndMarkers(repoRoot, options),
  };

  const errors = [];
  const warnings = [];
  for (const [name, res] of Object.entries(checks)) {
    for (const err of res.errors || []) errors.push(`[${name}] ${err}`);
    for (const warn of res.warnings || []) warnings.push(`[${name}] ${warn}`);
  }

  const testCommands = [];
  if (errors.length === 0 && !options.skipTests) {
    if (options.ci) {
      testCommands.push({ label: "单元测试 (verify --unit)", args: ["tests/verify.cjs", "--unit"] });
    } else if (options.full) {
      testCommands.push({ label: "单元测试 (verify --unit)", args: ["tests/verify.cjs", "--unit"] });
      testCommands.push({ label: "完整验证套件 (verify --full)", args: ["tests/verify.cjs", "--full"] });
    } else {
      testCommands.push({ label: "单元测试 (verify --unit)", args: ["tests/verify.cjs", "--unit"] });
      testCommands.push({ label: "默认验证套件 (verify)", args: ["tests/verify.cjs"] });
    }
    if (options.e2e) {
      testCommands.push({ label: "隔离浏览器回归 (e2e-real)", args: ["tests/e2e-real.cjs"] });
    }
    for (const tc of testCommands) {
      if (!options.json) console.log(`\n==> 运行 ${tc.label}...`);
      try {
        runTestCommand(repoRoot, tc.args, tc.label);
      } catch (err) {
        errors.push(`[tests] ${err.message}`);
        break;
      }
    }
  }

  return {
    ok: errors.length === 0,
    version: ENHANCER_VERSION,
    baselineVersion: T3_BASELINE_VERSION,
    checks,
    testsRun: testCommands.map((t) => t.label),
    warnings,
    errors,
  };
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`错误：${err.message}`);
    process.exit(1);
  }
  const report = runPreflight(DEFAULT_REPO_ROOT, opts);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nt3code-enhancer Preflight (${ENHANCER_TAG} / 基线 T3 Code ${T3_BASELINE_VERSION})`);
    console.log(
      `  补丁数: ${report.checks.registry.patchCount} | 外置运行时: ${report.checks.registry.runtimeCount} | 基准: ${report.checks.gitAndMarkers.baseRef || "无 Git"}`
    );
    if (report.warnings.length > 0) {
      console.log("\n告警：");
      for (const w of report.warnings) console.log(`  ⚠ ${w}`);
    }
    if (report.errors.length > 0) {
      console.error("\n失败项：");
      for (const e of report.errors) console.error(`  ✖ ${e}`);
      process.exit(1);
    }
    console.log("\nPREFLIGHT PASSED.");
  }
  if (!report.ok) process.exit(1);
}

module.exports = {
  parseArgs,
  checkZeroDeps,
  checkPatchAndRuntimeRegistry,
  checkEolAndHygiene,
  checkDocsAlignment,
  checkGitAndMarkers,
  extractMarkersFromPatchSource,
  runPreflight,
};

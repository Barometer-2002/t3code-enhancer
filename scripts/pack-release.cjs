"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  ENHANCER_VERSION,
  ENHANCER_TAG,
  ENHANCER_VERSION_INFO,
  T3_BASELINE_VERSION,
} = require("../lib/version.cjs");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");
const EXCLUDE_PREFIXES = [".git/", ".github/", "dist/", "node_modules/"];
const EXCLUDE_PATTERNS = [/\.asar(?:\.|$)/i, /\.log$/i, /^\.env(?:\.|$)/i];
const CMD_FILES = new Set(["install.cmd", "repair.cmd", "status.cmd", "uninstall.cmd"]);

// Pure JS IEEE 802.3 CRC-32 table so Node 20+ works without zlib.crc32 (added in Node 22.2).
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const year = Math.max(1980, Math.min(2107, d.getUTCFullYear()));
  const dosDate = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const dosTime = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  return { dosTime, dosDate };
}

/**
 * Pure zero-dependency ZIP archive writer with UTF-8 filenames and explicit Unix permissions.
 * @param {Array<{name: string, data: Buffer | null, mode?: number, mtime?: Date}>} entries
 */
function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const isDir = entry.data === null || entry.name.endsWith("/");
    const nameStr = isDir && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name;
    const nameBuf = Buffer.from(nameStr, "utf8");
    const rawBuf = isDir ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const { dosTime, dosDate } = toDosTimeDate(entry.mtime);
    const flags = 0x0800; // UTF-8 filename encoding
    const checksum = crc32(rawBuf);

    let method = 0;
    let payload = rawBuf;
    if (!isDir && rawBuf.length > 0) {
      const deflated = zlib.deflateRawSync(rawBuf, { level: 9 });
      if (deflated.length < rawBuf.length) {
        method = 8;
        payload = deflated;
      }
    }

    const unixMode = entry.mode ?? (isDir ? 0o040755 : 0o100644);
    const dosAttr = isDir ? 0x10 : 0x00;
    const extAttr = (((unixMode & 0xffff) << 16) | dosAttr) >>> 0;

    // Local File Header (30 bytes + filename)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed: 2.0
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(checksum, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(rawBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length

    localParts.push(lfh, nameBuf, payload);

    // Central Directory Header (46 bytes + filename)
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE((3 << 8) | 20, 4); // made by Unix (3), spec 2.0
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(checksum, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(rawBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra len
    cdh.writeUInt16LE(0, 32); // comment len
    cdh.writeUInt16LE(0, 34); // disk start
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(extAttr, 38);
    cdh.writeUInt32LE(offset, 42);

    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function readZipEntries(zipBuf) {
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65557); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert(eocd >= 0, "无效的 ZIP 文件：缺少 EOCD 记录");
  const count = zipBuf.readUInt16LE(eocd + 10);
  const cdOffset = zipBuf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(zipBuf.readUInt32LE(p), 0x02014b50, `Central Directory 第 ${i} 项签名无效`);
    const madeBy = zipBuf.readUInt16LE(p + 4);
    const flags = zipBuf.readUInt16LE(p + 8);
    const method = zipBuf.readUInt16LE(p + 10);
    const expectedCrc = zipBuf.readUInt32LE(p + 16);
    const compSize = zipBuf.readUInt32LE(p + 20);
    const uncompSize = zipBuf.readUInt32LE(p + 24);
    const nameLen = zipBuf.readUInt16LE(p + 28);
    const extraLen = zipBuf.readUInt16LE(p + 30);
    const commentLen = zipBuf.readUInt16LE(p + 32);
    const extAttr = zipBuf.readUInt32LE(p + 38);
    const localOffset = zipBuf.readUInt32LE(p + 42);
    const name = zipBuf.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    assert.equal(zipBuf.readUInt32LE(localOffset), 0x04034b50, `条目 ${name} 的 Local Header 签名无效`);
    const lNameLen = zipBuf.readUInt16LE(localOffset + 26);
    const lExtraLen = zipBuf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compBuf = zipBuf.subarray(dataStart, dataStart + compSize);
    const isDir = name.endsWith("/");

    let data = null;
    if (!isDir) {
      if (method === 0) data = Buffer.from(compBuf);
      else if (method === 8) data = zlib.inflateRawSync(compBuf);
      else throw new Error(`条目 ${name} 使用不支持的压缩方式：${method}`);
      assert.equal(data.length, uncompSize, `条目 ${name} 解压长度不匹配`);
      assert.equal(crc32(data), expectedCrc, `条目 ${name} CRC-32 校验失败`);
    }

    entries.push({
      name,
      isDir,
      madeByHost: madeBy >> 8,
      flags,
      method,
      unixMode: (extAttr >>> 16) & 0o7777,
      data,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractZipToDir(zipBuf, destDir) {
  const entries = readZipEntries(zipBuf);
  const resolvedDest = path.resolve(destDir);
  fs.mkdirSync(resolvedDest, { recursive: true });
  for (const entry of entries) {
    assert(!entry.name.startsWith("/") && !entry.name.includes(".."), `检测到不安全 ZIP 路径：${entry.name}`);
    const outPath = path.resolve(resolvedDest, entry.name);
    assert(outPath === resolvedDest || outPath.startsWith(resolvedDest + path.sep), `ZIP 路径越界：${entry.name}`);
    if (entry.isDir) {
      fs.mkdirSync(outPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, entry.data);
      if (process.platform !== "win32" && (entry.unixMode & 0o111)) {
        fs.chmodSync(outPath, entry.unixMode);
      }
    }
  }
  return entries;
}

function isExcludedPath(relPosix) {
  for (const prefix of EXCLUDE_PREFIXES) {
    if (relPosix === prefix.slice(0, -1) || relPosix.startsWith(prefix)) return true;
  }
  const base = path.posix.basename(relPosix);
  for (const re of EXCLUDE_PATTERNS) {
    if (re.test(relPosix) || re.test(base)) return true;
  }
  return false;
}

function runGit(repoRoot, args) {
  return spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function collectReleaseFiles(repoRoot, { includeUntracked = false } = {}) {
  const modeByPath = new Map();
  const gitCheck = runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  let relPaths = [];

  if (gitCheck.status === 0 && gitCheck.stdout.trim() === "true") {
    const ls = spawnSync("git", ["ls-files", "--stage", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (ls.status !== 0) throw new Error(`git ls-files 失败：${ls.stderr}`);
    for (const rec of ls.stdout.split("\0")) {
      if (!rec) continue;
      const tabIdx = rec.indexOf("\t");
      if (tabIdx < 0) continue;
      const modeStr = rec.slice(0, tabIdx).split(/\s+/)[0];
      const rel = rec.slice(tabIdx + 1).replace(/\\/g, "/");
      if (isExcludedPath(rel)) continue;
      if (!fs.existsSync(path.join(repoRoot, rel))) continue;
      relPaths.push(rel);
      modeByPath.set(rel, modeStr === "100755" ? 0o100755 : 0o100644);
    }
    if (includeUntracked) {
      const others = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (others.status === 0) {
        for (const rec of others.stdout.split("\0")) {
          if (!rec) continue;
          const rel = rec.replace(/\\/g, "/");
          if (isExcludedPath(rel)) continue;
          if (!fs.existsSync(path.join(repoRoot, rel))) continue;
          relPaths.push(rel);
          if (!modeByPath.has(rel)) modeByPath.set(rel, rel === "install.sh" ? 0o100755 : 0o100644);
        }
      }
    }
  } else {
    const walk = (dirRel) => {
      const full = dirRel ? path.join(repoRoot, dirRel) : repoRoot;
      for (const ent of fs.readdirSync(full, { withFileTypes: true })) {
        const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name;
        if (isExcludedPath(rel)) continue;
        if (ent.isDirectory()) walk(rel);
        else if (ent.isFile()) {
          relPaths.push(rel);
          modeByPath.set(rel, rel === "install.sh" ? 0o100755 : 0o100644);
        }
      }
    };
    walk("");
  }

  relPaths = [...new Set(relPaths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return relPaths.map((rel) => ({
    rel,
    mode: rel === "install.sh" ? 0o100755 : (modeByPath.get(rel) || 0o100644),
  }));
}

function getDeterministicTimestamp(repoRoot) {
  const res = runGit(repoRoot, ["log", "-1", "--format=%ct"]);
  if (res.status === 0 && /^\d+$/.test(res.stdout.trim())) {
    return new Date(Number(res.stdout.trim()) * 1000);
  }
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
}

function buildZipEntries(repoRoot, versionTag, { includeUntracked = false } = {}) {
  const rootPrefix = `t3code-enhancer-${versionTag}`;
  const files = collectReleaseFiles(repoRoot, { includeUntracked });
  const mtime = getDeterministicTimestamp(repoRoot);
  const dirSet = new Set([`${rootPrefix}/`]);

  for (const { rel } of files) {
    const parts = rel.split("/");
    let cur = rootPrefix;
    for (let i = 0; i < parts.length - 1; i++) {
      cur += `/${parts[i]}`;
      dirSet.add(`${cur}/`);
    }
  }

  const allItems = [];
  for (const dirName of dirSet) {
    allItems.push({ name: dirName, data: null, mode: 0o040755, mtime });
  }
  for (const { rel, mode } of files) {
    allItems.push({
      name: `${rootPrefix}/${rel}`,
      data: fs.readFileSync(path.join(repoRoot, rel)),
      mode,
      mtime,
    });
  }
  allItems.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { rootPrefix, fileCount: files.length, entries: allItems };
}

function verifyPackagedZip(zipPath, versionTag, { runUnitTests = true } = {}) {
  const zipBuf = fs.readFileSync(zipPath);
  const rootPrefix = `t3code-enhancer-${versionTag}`;
  const entries = readZipEntries(zipBuf);

  const installSh = entries.find((e) => e.name === `${rootPrefix}/install.sh`);
  assert(installSh, `ZIP 缺少 ${rootPrefix}/install.sh`);
  assert.equal(installSh.madeByHost, 3, "install.sh 的 ZIP host 必须为 Unix (3)");
  assert.equal(installSh.unixMode, 0o755, `install.sh 权限应为 0755，实际为 ${installSh.unixMode.toString(8)}`);
  assert(!installSh.data.toString("utf8").includes("\r\n"), "ZIP 内 install.sh 必须保持 LF 行尾");

  for (const cmd of CMD_FILES) {
    const entry = entries.find((e) => e.name === `${rootPrefix}/${cmd}`);
    assert(entry, `ZIP 缺少 ${rootPrefix}/${cmd}`);
    const txt = entry.data.toString("utf8");
    assert(txt.includes("\r\n") && !/(^|[^\r])\n/.test(txt), `ZIP 内 ${cmd} 必须保持纯 CRLF 行尾`);
  }

  assert(
    entries.some((e) => e.name === `${rootPrefix}/使用教程.md`),
    `ZIP 缺少 UTF-8 中文文档 ${rootPrefix}/使用教程.md`
  );

  if (runUnitTests) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-zip-verify-"));
    try {
      extractZipToDir(zipBuf, tmpDir);
      const unpackedRoot = path.join(tmpDir, rootPrefix);
      const res = spawnSync(process.execPath, ["tests/verify.cjs", "--unit"], {
        cwd: unpackedRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      if (res.status !== 0) {
        throw new Error(`解压后单元测试失败：\n${res.stdout || ""}\n${res.stderr || ""}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const sha256 = crypto.createHash("sha256").update(zipBuf).digest("hex");
  const fileCount = entries.filter((e) => !e.isDir).length;
  return { fileCount, byteSize: zipBuf.length, sha256 };
}

function tagExists(repoRoot, tag) {
  const local = runGit(repoRoot, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
  if (local.status === 0 && local.stdout.trim()) return { exists: true, where: "local" };
  return { exists: false, where: null };
}

function buildReleaseNotesTemplate({ versionTag, isPrerelease, zipName, fileCount, byteSize, sha256 }) {
  const channelLabel = isPrerelease ? "预览版（`Prerelease`）" : "正式版（`Latest`）";
  return [
    `\`${versionTag}\` 为 **${channelLabel}**，适配 T3 Code \`${T3_BASELINE_VERSION}\`（向后兼容 \`0.1.12\`）。`,
    "",
    "> **升级提示**：此前已安装旧版的用户，彻底退出 T3 Code（含系统托盘）后，下载解压本版并运行 `repair.cmd` / `node cli.cjs repair`（Linux / macOS 运行 `./install.sh repair`）即可无缝升级，保留原有模块方案。",
    "",
    "---",
    "",
    "## 本版核心更新",
    "",
    "- TODO: 补充本版本的主要修复、适配与功能变更",
    "",
    "---",
    "",
    "## 发行包校验与验证范围",
    "",
    `- **文件名**：\`${zipName}\`（${fileCount} 个文件，${byteSize.toLocaleString("en-US")} 字节）`,
    `- **SHA-256**：\`${sha256}\``,
    "- **验证范围**：",
    `  - **Windows（\`${T3_BASELINE_VERSION}\` 双档）**：TODO: 填写已通过的测试套件（\`test:unit\` / \`test\` / \`test:full\` / \`test:e2e\`）`,
    "  - **Linux & macOS 边界说明**：TODO: 说明真机与合成测试覆盖边界",
    "",
  ].join("\n");
}

function updateNotesChecksum(notesPath, { zipName, fileCount, byteSize, sha256 }) {
  let content = fs.readFileSync(notesPath, "utf8");
  const fileLine = `- **文件名**：\`${zipName}\`（${fileCount} 个文件，${byteSize.toLocaleString("en-US")} 字节）`;
  const hashLine = `- **SHA-256**：\`${sha256}\``;
  let updated = false;
  if (/^- \*\*文件名\*\*：.*$/m.test(content)) {
    content = content.replace(/^- \*\*文件名\*\*：.*$/m, fileLine);
    updated = true;
  }
  if (/^- \*\*SHA-256\*\*：.*$/m.test(content)) {
    content = content.replace(/^- \*\*SHA-256\*\*：.*$/m, hashLine);
    updated = true;
  }
  if (updated) fs.writeFileSync(notesPath, content.replace(/\r\n/g, "\n"), "utf8");
  return updated;
}

function parseArgs(argv) {
  const opts = {
    outPath: null,
    skipCleanCheck: false,
    skipVerify: false,
    writeNotes: false,
    updateNotes: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) opts.outPath = argv[++i];
    else if (arg.startsWith("--out=")) opts.outPath = arg.slice("--out=".length);
    else if (arg === "--skip-clean-check") opts.skipCleanCheck = true;
    else if (arg === "--skip-verify") opts.skipVerify = true;
    else if (arg === "--write-notes") opts.writeNotes = true;
    else if (arg === "--update-notes") opts.updateNotes = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(
        [
          "用法: node scripts/pack-release.cjs [选项]",
          "",
          "选项:",
          "  --out <path>        指定输出 ZIP 路径（默认 dist/t3code-enhancer-v<version>.zip）",
          "  --skip-clean-check  允许在工作区未提交时试打包",
          "  --skip-verify       跳过解压后运行 tests/verify.cjs --unit 验包",
          "  --write-notes       若 dist/release-v<version>.md 不存在则生成模板",
          "  --update-notes      若 dist/release-v<version>.md 已存在则刷新其中的文件名与 SHA-256",
          "  --json              输出 JSON 打包报告",
        ].join("\n")
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

function packRelease(repoRoot = DEFAULT_REPO_ROOT, options = {}) {
  const versionTag = ENHANCER_TAG;
  const zipName = `t3code-enhancer-${versionTag}.zip`;
  const defaultOutPath = path.join(repoRoot, "dist", zipName);
  const outPath = options.outPath ? path.resolve(options.outPath) : defaultOutPath;
  const writingDefaultDist = path.resolve(outPath) === path.resolve(defaultOutPath);

  if (writingDefaultDist) {
    const tagInfo = tagExists(repoRoot, versionTag);
    if (tagInfo.exists && fs.existsSync(outPath)) {
      throw new Error(
        `版本 ${versionTag} 已存在本地标签且发行包 ${zipName} 已生成；根据发版约束禁止原地覆写已发布包。请先递增 package.json 版本号，或使用 --out <临时路径> 做试打包。`
      );
    }
  }

  if (!options.skipCleanCheck) {
    const st = runGit(repoRoot, ["status", "--porcelain"]);
    if (st.status === 0 && st.stdout.trim()) {
      throw new Error(
        `工作区存在未提交改动，拒绝生成正式发行包（试打包请传 --skip-clean-check）：\n${st.stdout.trim()}`
      );
    }
  }

  const { rootPrefix, fileCount, entries } = buildZipEntries(repoRoot, versionTag, {
    includeUntracked: Boolean(options.skipCleanCheck),
  });
  const zipBuf = createZipBuffer(entries);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, zipBuf);

  const verified = verifyPackagedZip(outPath, versionTag, { runUnitTests: !options.skipVerify });
  assert.equal(verified.fileCount, fileCount, "校验文件总数应与打包清单一致");

  let notesPath = null;
  let notesAction = "none";
  if (writingDefaultDist) {
    notesPath = path.join(repoRoot, "dist", `release-${versionTag}.md`);
    if (!fs.existsSync(notesPath) && options.writeNotes) {
      fs.writeFileSync(
        notesPath,
        buildReleaseNotesTemplate({
          versionTag,
          isPrerelease: ENHANCER_VERSION_INFO.isPrerelease,
          zipName,
          ...verified,
        }),
        "utf8"
      );
      notesAction = "created";
    } else if (fs.existsSync(notesPath) && options.updateNotes) {
      const changed = updateNotesChecksum(notesPath, { zipName, ...verified });
      notesAction = changed ? "updated" : "unchanged";
    }
  }

  return {
    ok: true,
    version: ENHANCER_VERSION,
    tag: versionTag,
    channel: ENHANCER_VERSION_INFO.channel,
    rootPrefix,
    zipPath: outPath,
    zipName: path.basename(outPath),
    fileCount: verified.fileCount,
    byteSize: verified.byteSize,
    sha256: verified.sha256,
    unpackedUnitVerified: !options.skipVerify,
    notesPath,
    notesAction,
  };
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = packRelease(DEFAULT_REPO_ROOT, opts);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`已生成发行包：${result.zipPath}`);
      console.log(`  版本：${result.tag} (${result.channel})`);
      console.log(`  文件数：${result.fileCount} | 大小：${result.byteSize.toLocaleString("en-US")} 字节`);
      console.log(`  SHA-256：${result.sha256}`);
      console.log(`  解压验包：${result.unpackedUnitVerified ? "PASSED (tests/verify.cjs --unit)" : "SKIPPED"}`);
      if (result.notesAction !== "none") {
        console.log(`  发版说明：${result.notesPath} (${result.notesAction})`);
      }
    }
  } catch (err) {
    console.error(`打包失败：${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  crc32,
  createZipBuffer,
  readZipEntries,
  extractZipToDir,
  collectReleaseFiles,
  verifyPackagedZip,
  buildReleaseNotesTemplate,
  updateNotesChecksum,
  packRelease,
  parseArgs,
};

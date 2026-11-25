"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readAsar(filePath) {
  const archive = fs.readFileSync(filePath);
  assert(archive.length >= 16, "Invalid ASAR archive: header smaller than 16 bytes");
  assert.equal(archive.readUInt32LE(0), 4, "Unrecognized ASAR size header");
  const headerSize = archive.readUInt32LE(4);
  const innerSize = archive.readUInt32LE(8);
  const jsonSize = archive.readUInt32LE(12);
  assert(headerSize >= 8 && 8 + headerSize <= archive.length, "ASAR header length exceeds archive size");
  assert.equal(headerSize, 8 + Math.ceil(jsonSize / 4) * 4, "Unrecognized ASAR header length");
  assert.equal(innerSize, headerSize - 4, "Unrecognized ASAR inner header length");
  assert(16 + jsonSize <= 8 + headerSize, "ASAR JSON header exceeds header bounds");
  const header = JSON.parse(archive.toString("utf8", 16, 16 + jsonSize));
  assert(header && typeof header === "object" && header.files && typeof header.files === "object", "Invalid ASAR root header");
  const entries = [];
  const byKey = new Map();

  function visit(node, prefix) {
    assert(node.files && typeof node.files === "object", `Invalid ASAR directory node at ${prefix || "/"}`);
    for (const [name, entry] of Object.entries(node.files)) {
      const key = prefix + name;
      if (entry.files) visit(entry, key + "/");
      else if (!entry.unpacked && entry.offset !== undefined) {
        assert(
          (typeof entry.offset === "string" || typeof entry.offset === "number") && /^\d+$/.test(String(entry.offset)),
          `Invalid ASAR entry offset for ${key}`
        );
        const rec = { key, entry };
        entries.push(rec);
        byKey.set(key, rec);
      }
    }
  }
  visit(header, "");

  const body = archive.subarray(8 + headerSize);
  let lastOffset = 0;
  let lastEnd = 0;
  for (const { entry } of entries
    .slice()
    .sort((a, b) => Number(a.entry.offset) - Number(b.entry.offset) || a.entry.size - b.entry.size)) {
    const offset = Number(entry.offset);
    assert(Number.isSafeInteger(offset) && Number.isSafeInteger(entry.size) && entry.size >= 0 && offset >= 0);
    const end = offset + entry.size;
    const sharesBytes = offset === lastOffset && end === lastEnd;
    assert((entry.size === 0 || offset >= lastEnd || sharesBytes) && end <= body.length, "Invalid ASAR entry range");
    if (end > lastEnd) {
      lastOffset = offset;
      lastEnd = end;
    }
  }

  return { archive, header, entries, byKey, body };
}

function readEntryBuffer(asar, rec) {
  const offset = Number(rec.entry.offset);
  return asar.body.subarray(offset, offset + rec.entry.size);
}

function getAsarAppVersion(asar) {
  const rec = asar?.byKey?.get("package.json");
  if (!rec) return null;
  try {
    const pkg = JSON.parse(readEntryBuffer(asar, rec).toString("utf8"));
    return typeof pkg?.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

function findUniqueEntry(asar, regex, label) {
  const matches = asar.entries.filter(({ key }) => regex.test(key));
  assert.equal(matches.length, 1, `Could not uniquely identify ${label} (found ${matches.length})`);
  const rec = matches[0];
  const offset = Number(rec.entry.offset);
  assert(
    !asar.entries.some(({ entry: cand }) => cand !== rec.entry && cand.size > 0 && Number(cand.offset) === offset),
    `${label} shares archive bytes with another entry`
  );
  const content = asar.body.subarray(offset, offset + rec.entry.size);
  assert.equal(rec.entry.integrity?.algorithm, "SHA256", `Unexpected integrity algorithm for ${label}`);
  assert.equal(digest(content), rec.entry.integrity.hash, `Integrity check failed for ${label}`);
  return { ...rec, offset, content };
}

function packHeader(header) {
  const json = Buffer.from(JSON.stringify(header));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16 + paddedLength);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + paddedLength, 4);
  prefix.writeUInt32LE(4 + paddedLength, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  return prefix;
}

function validateScriptSyntax(buffer, entryKey, label) {
  const args = /\.cjs$/i.test(entryKey) ? ["--check"] : ["--input-type=module", "--check"];
  const syntax = spawnSync(process.execPath, args, { input: buffer });
  assert.equal(
    syntax.status,
    0,
    syntax.stderr?.toString()?.trim() || syntax.error?.message || `Syntax check failed for ${label}`
  );
}

function validateEsmSyntax(buffer, label) {
  return validateScriptSyntax(buffer, "module.mjs", label);
}

function writeVerifiedAsarCopy(sourcePath, destPath, options = {}) {
  const overwrite = options.overwrite === true;
  const label = options.label || "ASAR 校验不一致";
  const expectedArchive = options.expectedArchive || readAsar(sourcePath).archive;
  const staging = `${destPath}.${randomUUID()}.tmp`;
  try {
    fs.copyFileSync(sourcePath, staging, fs.constants.COPYFILE_EXCL);
    assert(readAsar(staging).archive.equals(expectedArchive), label);
    if (typeof options.beforeRename === "function") options.beforeRename(staging);
    if (overwrite) {
      fs.renameSync(staging, destPath);
    } else if (!fs.existsSync(destPath)) {
      try {
        fs.linkSync(staging, destPath);
        fs.unlinkSync(staging);
      } catch {
        // Fallback when hardlinks are unsupported across mount/fs boundaries
        if (!fs.existsSync(destPath)) fs.renameSync(staging, destPath);
      }
    }
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
}

function computeIntegrity(buffer, blockSize = 4 * 1024 * 1024) {
  assert(Number.isSafeInteger(blockSize) && blockSize > 0, "Invalid ASAR blockSize");
  const blocks = [];
  for (let start = 0; start < buffer.length; start += blockSize) {
    blocks.push(digest(buffer.subarray(start, start + blockSize)));
  }
  return {
    algorithm: "SHA256",
    blockSize,
    hash: digest(buffer),
    blocks,
  };
}

function insertHeaderEntry(header, key, entry) {
  const parts = key.split("/").filter(Boolean);
  assert(parts.length > 0, `Invalid ASAR addition key: ${key}`);
  let node = header;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (!node.files[seg]) node.files[seg] = { files: {} };
    assert(node.files[seg].files && typeof node.files[seg].files === "object", `ASAR addition parent is not a directory: ${key}`);
    node = node.files[seg];
  }
  const leaf = parts[parts.length - 1];
  assert(!node.files[leaf], `ASAR addition already exists: ${key}`);
  node.files[leaf] = entry;
}

/**
 * Rebuild an ASAR replacing multiple files simultaneously (and optionally adding new files),
 * updating all sibling offsets and SHA-256 block integrity hashes, then verifying every
 * untouched byte matches original.
 * @param {object} asar - Result from readAsar()
 * @param {Array<{ key: string, replacement: Buffer }>} replacements
 * @param {string} outputPath
 * @param {Array<{ key: string, content: Buffer }>} [additions]
 */
function writePatchedAsar(asar, replacements, outputPath, additions = []) {
  const sorted = replacements
    .map(({ key, replacement }) => {
      const rec = asar.byKey.get(key);
      assert(rec, `Missing ASAR entry: ${key}`);
      const offset = Number(rec.entry.offset);
      const oldSize = rec.entry.size;
      return { key, entry: rec.entry, offset, oldSize, oldEnd: offset + oldSize, replacement };
    })
    .sort((a, b) => a.offset - b.offset);

  // Verify non-overlapping replacements and ensure no untouched non-empty entry shares bytes
  for (let i = 1; i < sorted.length; i++) {
    assert(sorted[i].offset >= sorted[i - 1].oldEnd, "Overlapping ASAR replacement ranges");
  }
  const replacedSet = new Set(sorted.map((r) => r.key));
  for (const { key, entry } of asar.entries) {
    if (replacedSet.has(key) || entry.size === 0) continue;
    const pos = Number(entry.offset);
    const end = pos + entry.size;
    for (const r of sorted) {
      assert(end <= r.offset || pos >= r.oldEnd, `Untouched entry ${key} shares archive bytes with replaced ${r.key}`);
    }
  }

  // Deduplicate & validate additions (new files appended after original body)
  const uniqueAdditions = [];
  const addedKeys = new Set();
  for (const item of additions || []) {
    assert(item && typeof item.key === "string" && Buffer.isBuffer(item.content), "Invalid ASAR addition record");
    assert(!asar.byKey.has(item.key), `ASAR addition collides with existing entry: ${item.key}`);
    if (addedKeys.has(item.key)) {
      const existing = uniqueAdditions.find((a) => a.key === item.key);
      assert(existing.content.equals(item.content), `Conflicting duplicate ASAR addition: ${item.key}`);
      continue;
    }
    addedKeys.add(item.key);
    uniqueAdditions.push(item);
  }

  // Deep-clone header so we never mutate caller's header
  const nextHeader = JSON.parse(JSON.stringify(asar.header));
  const nextEntries = [];
  (function visit(node, prefix) {
    for (const [name, entry] of Object.entries(node.files)) {
      const key = prefix + name;
      if (entry.files) visit(entry, key + "/");
      else if (!entry.unpacked && entry.offset !== undefined) {
        nextEntries.push({ key, entry });
      }
    }
  })(nextHeader, "");

  // Compute cumulative byte shift for any original offset
  const repByKey = new Map(sorted.map((r) => [r.key, r]));
  let totalDelta = 0;
  for (const r of sorted) totalDelta += r.replacement.length - r.oldSize;

  for (const { key, entry } of nextEntries) {
    const origPos = Number(entry.offset);
    let delta = 0;
    for (const r of sorted) {
      if (r.key === key) break;
      if (origPos >= r.oldEnd) delta += r.replacement.length - r.oldSize;
    }
    if (delta !== 0) entry.offset = String(origPos + delta);
    const rep = repByKey.get(key);
    if (rep) {
      const blockSize = entry.integrity?.blockSize || 4 * 1024 * 1024;
      entry.size = rep.replacement.length;
      entry.integrity = computeIntegrity(rep.replacement, blockSize);
    }
  }

  // Append added files at the end of the body
  let appendOffset = asar.body.length + totalDelta;
  for (const add of uniqueAdditions) {
    insertHeaderEntry(nextHeader, add.key, {
      size: add.content.length,
      offset: String(appendOffset),
      integrity: computeIntegrity(add.content),
    });
    appendOffset += add.content.length;
  }

  // Assemble new body chunks
  const chunks = [packHeader(nextHeader)];
  let cursor = 0;
  for (const r of sorted) {
    if (r.offset > cursor) chunks.push(asar.body.subarray(cursor, r.offset));
    chunks.push(r.replacement);
    cursor = r.oldEnd;
  }
  if (cursor < asar.body.length) chunks.push(asar.body.subarray(cursor));
  for (const add of uniqueAdditions) {
    chunks.push(add.content);
  }

  fs.writeFileSync(outputPath, Buffer.concat(chunks), { flag: "wx" });

  // Full post-write verification
  const verified = readAsar(outputPath);
  for (const r of sorted) {
    const vRec = verified.byKey.get(r.key);
    assert(vRec, `Patched entry missing after write: ${r.key}`);
    const vOff = Number(vRec.entry.offset);
    const vBytes = verified.body.subarray(vOff, vOff + vRec.entry.size);
    assert(vBytes.equals(r.replacement), `Patched bytes mismatch for ${r.key}`);
    assert.equal(digest(vBytes), vRec.entry.integrity.hash, `Patched hash mismatch for ${r.key}`);
  }
  for (const add of uniqueAdditions) {
    const vRec = verified.byKey.get(add.key);
    assert(vRec, `Added entry missing after write: ${add.key}`);
    const vOff = Number(vRec.entry.offset);
    const vBytes = verified.body.subarray(vOff, vOff + vRec.entry.size);
    assert(vBytes.equals(add.content), `Added bytes mismatch for ${add.key}`);
    assert.equal(digest(vBytes), vRec.entry.integrity.hash, `Added hash mismatch for ${add.key}`);
  }
  // Verify untouched slices byte-for-byte
  let origCur = 0;
  let newCur = 0;
  for (const r of sorted) {
    const len = r.offset - origCur;
    assert(
      verified.body.subarray(newCur, newCur + len).equals(asar.body.subarray(origCur, r.offset)),
      `Untouched ASAR slice before ${r.key} differs`
    );
    origCur = r.oldEnd;
    newCur += len + r.replacement.length;
  }
  const origSuffixLen = asar.body.length - origCur;
  assert(
    verified.body.subarray(newCur, newCur + origSuffixLen).equals(asar.body.subarray(origCur)),
    "Untouched ASAR suffix differs"
  );

  return verified;
}

module.exports = {
  digest,
  readAsar,
  readEntryBuffer,
  getAsarAppVersion,
  findUniqueEntry,
  validateEsmSyntax,
  validateScriptSyntax,
  writeVerifiedAsarCopy,
  writePatchedAsar,
};

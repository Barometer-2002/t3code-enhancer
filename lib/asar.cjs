"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readAsar(filePath) {
  const archive = fs.readFileSync(filePath);
  const headerSize = archive.readUInt32LE(4);
  const jsonSize = archive.readUInt32LE(12);
  assert.equal(archive.readUInt32LE(0), 4, "Unrecognized ASAR size header");
  assert.equal(headerSize, 8 + Math.ceil(jsonSize / 4) * 4, "Unrecognized ASAR header length");
  assert.equal(archive.readUInt32LE(8), headerSize - 4, "Unrecognized ASAR inner header length");
  const header = JSON.parse(archive.toString("utf8", 16, 16 + jsonSize));
  const entries = [];
  const byKey = new Map();

  function visit(node, prefix) {
    for (const [name, entry] of Object.entries(node.files)) {
      const key = prefix + name;
      if (entry.files) visit(entry, key + "/");
      else if (!entry.unpacked && entry.offset !== undefined) {
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

function validateEsmSyntax(buffer, label) {
  const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: buffer });
  assert.equal(syntax.status, 0, syntax.stderr?.toString() || `Syntax check failed for ${label}`);
}

function validateScriptSyntax(buffer, entryKey, label) {
  const args = /\.cjs$/i.test(entryKey) ? ["--check"] : ["--input-type=module", "--check"];
  const syntax = spawnSync(process.execPath, args, { input: buffer });
  assert.equal(syntax.status, 0, syntax.stderr?.toString() || `Syntax check failed for ${label}`);
}

/**
 * Rebuild an ASAR replacing multiple files simultaneously, updating all sibling offsets
 * and SHA-256 block integrity hashes, then verifying every untouched byte matches original.
 * @param {object} asar - Result from readAsar()
 * @param {Array<{ key: string, replacement: Buffer }>} replacements
 * @param {string} outputPath
 */
function writePatchedAsar(asar, replacements, outputPath) {
  const sorted = replacements
    .map(({ key, replacement }) => {
      const rec = asar.byKey.get(key);
      assert(rec, `Missing ASAR entry: ${key}`);
      const offset = Number(rec.entry.offset);
      const oldSize = rec.entry.size;
      return { key, entry: rec.entry, offset, oldSize, oldEnd: offset + oldSize, replacement };
    })
    .sort((a, b) => a.offset - b.offset);

  // Verify non-overlapping replacements
  for (let i = 1; i < sorted.length; i++) {
    assert(sorted[i].offset >= sorted[i - 1].oldEnd, "Overlapping ASAR replacement ranges");
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
      const blockSize = entry.integrity.blockSize;
      assert(Number.isSafeInteger(blockSize) && blockSize > 0, `Invalid blockSize for ${key}`);
      entry.size = rep.replacement.length;
      entry.integrity.hash = digest(rep.replacement);
      entry.integrity.blocks = [];
      for (let start = 0; start < rep.replacement.length; start += blockSize) {
        entry.integrity.blocks.push(digest(rep.replacement.subarray(start, start + blockSize)));
      }
    }
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
  assert(
    verified.body.subarray(newCur).equals(asar.body.subarray(origCur)),
    "Untouched ASAR suffix differs"
  );

  return verified;
}

module.exports = { digest, readAsar, findUniqueEntry, validateEsmSyntax, validateScriptSyntax, writePatchedAsar };

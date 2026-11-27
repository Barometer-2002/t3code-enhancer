"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_JSON_PATH = path.resolve(__dirname, "..", "package.json");
const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PROJECT_RELEASE_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:alpha|beta|preview|rc)\.([1-9]\d*)))?$/;
const T3_BASELINE_VERSION = "0.1.13";

function parsePrereleaseIdentifiers(raw) {
  if (!raw) return [];
  return raw.split(".").map((id) => (/^\d+$/.test(id) ? { numeric: true, big: BigInt(id), raw: id } : { numeric: false, raw: id }));
}

/**
 * Parse a general SemVer 2.0.0 version string with arbitrary-precision numeric comparison support.
 */
function parseSemver(version) {
  assert(typeof version === "string" && version.trim(), "版本号必须为非空字符串");
  const normalized = version.trim();
  const match = SEMVER_REGEX.exec(normalized);
  assert(match, `版本号不符合 SemVer 2.0.0 规范：${version}`);
  const majorBig = BigInt(match[1]);
  const minorBig = BigInt(match[2]);
  const patchBig = BigInt(match[3]);
  const prerelease = match[4] || null;
  const build = match[5] || null;
  const prereleaseParts = parsePrereleaseIdentifiers(prerelease);
  return {
    version: normalized,
    tag: `v${normalized}`,
    major: majorBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(majorBig) : match[1],
    minor: minorBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minorBig) : match[2],
    patch: patchBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(patchBig) : match[3],
    majorBig,
    minorBig,
    patchBig,
    prerelease,
    prereleaseParts,
    build,
    isPrerelease: Boolean(prerelease),
  };
}

/**
 * Compare two SemVer 2.0.0 strings per SemVer 2.0.0 §11 (BigInt numeric ordering; build metadata ignored).
 */
function compareSemver(a, b) {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (va.majorBig !== vb.majorBig) return va.majorBig < vb.majorBig ? -1 : 1;
  if (va.minorBig !== vb.minorBig) return va.minorBig < vb.minorBig ? -1 : 1;
  if (va.patchBig !== vb.patchBig) return va.patchBig < vb.patchBig ? -1 : 1;
  if (!va.isPrerelease && !vb.isPrerelease) return 0;
  if (!va.isPrerelease) return 1;
  if (!vb.isPrerelease) return -1;
  const len = Math.max(va.prereleaseParts.length, vb.prereleaseParts.length);
  for (let i = 0; i < len; i++) {
    const pa = va.prereleaseParts[i];
    const pb = vb.prereleaseParts[i];
    if (!pa) return -1;
    if (!pb) return 1;
    if (pa.numeric && pb.numeric) {
      if (pa.big !== pb.big) return pa.big < pb.big ? -1 : 1;
    } else if (pa.numeric !== pb.numeric) {
      return pa.numeric ? -1 : 1;
    } else if (pa.raw !== pb.raw) {
      return pa.raw < pb.raw ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Parse a project release version under t3code-enhancer's stricter release channel convention:
 * `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-(alpha|beta|preview|rc).<N>` (no build metadata).
 */
function parseProjectReleaseVersion(version) {
  const base = parseSemver(version);
  const relMatch = PROJECT_RELEASE_REGEX.exec(base.version);
  assert(
    relMatch,
    `项目发行版本号不符合规范（应为 MAJOR.MINOR.PATCH 或 MAJOR.MINOR.PATCH-<alpha|beta|preview|rc>.<N>）：${version}`
  );
  const prereleaseTag = relMatch[4] ? relMatch[4].slice(0, relMatch[4].indexOf(".")) : null;
  const prereleaseNumber = relMatch[5] ? BigInt(relMatch[5]) : null;
  return {
    ...base,
    channel: prereleaseTag || "stable",
    prereleaseTag,
    prereleaseNumber: prereleaseNumber !== null && prereleaseNumber <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(prereleaseNumber)
      : relMatch[5] || null,
    prereleaseNumberBig: prereleaseNumber,
  };
}

function readPackageVersion(pkgPath = PACKAGE_JSON_PATH) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return parseProjectReleaseVersion(pkg.version);
}

const INFO = readPackageVersion();

function formatVersionBanner() {
  return `t3code-enhancer ${INFO.tag} (目标基线: T3 Code ${T3_BASELINE_VERSION})`;
}

module.exports = {
  PACKAGE_JSON_PATH,
  SEMVER_REGEX,
  PROJECT_RELEASE_REGEX,
  T3_BASELINE_VERSION,
  ENHANCER_VERSION: INFO.version,
  ENHANCER_TAG: INFO.tag,
  ENHANCER_CHANNEL: INFO.channel,
  ENHANCER_VERSION_INFO: INFO,
  parseSemver,
  compareSemver,
  parseProjectReleaseVersion,
  parseStandardVersion: parseSemver,
  compareStandardVersions: compareSemver,
  readPackageVersion,
  formatVersionBanner,
};

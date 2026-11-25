"use strict";

/**
 * Semantic Cross-Version Chunk Discovery & Symbol Resolution Layer.
 * Allows patches to find target bundles by semantic fingerprints (surviving chunk renames/hashes)
 * and resolve imported/local symbols by cross-chunk export inspection (surviving Rolldown re-minification).
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const { digest, readEntryBuffer, findUniqueEntry } = require("./asar.cjs");
const {
  tokenize,
  parseImports,
  parseExports,
  collectTopLevelBindings,
  findUndeclaredIdentifiers,
  findTopLevelFunctions,
  findUniqueFunction,
  findEnclosingFunction,
  extractDestructuredProps,
  extractObjectLiteralProps,
  allocateMemoSlots,
  getTopLevelDeclSource,
} = require("./js-ast.cjs");

/**
 * Read and integrity-check a single ASAR entry record.
 */
function readVerifiedEntry(asar, rec, label) {
  const offset = Number(rec.entry.offset);
  assert(
    !asar.entries.some(({ entry: cand }) => cand !== rec.entry && cand.size > 0 && Number(cand.offset) === offset),
    `${label} shares archive bytes with another entry`
  );
  const content = readEntryBuffer(asar, rec);
  assert.equal(rec.entry.integrity?.algorithm, "SHA256", `Unexpected integrity algorithm for ${label}`);
  assert.equal(digest(content), rec.entry.integrity.hash, `Integrity check failed for ${label}`);
  return { ...rec, offset, content };
}

/**
 * Find the unique ASAR entry matching a semantic target specification:
 * {
 *   pathRegex: RegExp,          // coarse path filter (e.g. /^apps\/server\/dist\/client\/assets\/.*\.js$/)
 *   preferredRegex?: RegExp,    // optional fast-path filename hint tried first
 *   includes?: string[],        // required literal substrings
 *   anyIncludes?: string[][],   // each inner array requires at least one substring
 *   excludes?: string[],        // forbidden substrings
 *   match?: RegExp[],           // required regexes
 *   test?: (text, key) => bool  // custom predicate
 * }
 */
function findEntryBySpec(asar, spec, label, markers = []) {
  const activeMarkers = Array.isArray(markers) ? markers.filter(Boolean) : [];
  const isInjectedRuntime = (key) => /\/t3e-[^/]+\.js$/.test(key);
  const matchesMarkers = (text) => activeMarkers.length > 0 && activeMarkers.some((m) => text.includes(m));
  const matchesContent = (text, key) => {
    if (Array.isArray(spec.includes) && !spec.includes.every((s) => text.includes(s))) return false;
    if (Array.isArray(spec.anyIncludes) && !spec.anyIncludes.every((group) => group.some((s) => text.includes(s)))) return false;
    if (Array.isArray(spec.excludes) && spec.excludes.some((s) => text.includes(s))) return false;
    if (Array.isArray(spec.match) && !spec.match.every((re) => re.test(text))) return false;
    if (typeof spec.test === "function" && !spec.test(text, key)) return false;
    return true;
  };

  // Fast path: check entries matching preferredRegex first (covers both single chunks and sibling chunks like utils-*.js)
  if (spec.preferredRegex) {
    const fast = asar.entries.filter(({ key }) => !isInjectedRuntime(key) && spec.preferredRegex.test(key));
    if (fast.length > 0) {
      const markerHits = [];
      const semanticHits = [];
      for (const rec of fast) {
        const text = readEntryBuffer(asar, rec).toString("utf8");
        if (matchesMarkers(text)) markerHits.push(rec);
        else if (matchesContent(text, rec.key)) semanticHits.push(rec);
      }
      if (markerHits.length === 1) return readVerifiedEntry(asar, markerHits[0], label);
      if (markerHits.length === 0 && semanticHits.length === 1) return readVerifiedEntry(asar, semanticHits[0], label);
    }
  }

  // Full semantic scan across all non-runtime files matching coarse pathRegex
  const candidates = asar.entries.filter(({ key }) => !isInjectedRuntime(key) && spec.pathRegex.test(key));
  const markerHits = [];
  const semanticHits = [];
  for (const rec of candidates) {
    const text = readEntryBuffer(asar, rec).toString("utf8");
    if (matchesMarkers(text)) markerHits.push(rec);
    if (matchesContent(text, rec.key)) semanticHits.push(rec);
  }
  if (markerHits.length === 1) {
    return readVerifiedEntry(asar, markerHits[0], label);
  }
  assert.equal(
    markerHits.length,
    0,
    `Ambiguous marker match for ${label} (found ${markerHits.length} across ${candidates.length} candidates)`
  );
  assert.equal(
    semanticHits.length,
    1,
    `Could not uniquely identify ${label} by semantic fingerprint (found ${semanticHits.length} across ${candidates.length} candidates)`
  );
  return readVerifiedEntry(asar, semanticHits[0], label);
}

/**
 * Find the target entry for a patch object.
 * Supports `patch.targetSpec` (semantic fingerprint + marker recognition) and falls back to legacy `patch.targetRegex`.
 */
function findPatchTarget(asar, patch) {
  if (patch.targetSpec) {
    const markers = [patch.marker, ...(Array.isArray(patch.legacyMarkers) ? patch.legacyMarkers : [])].filter(Boolean);
    return findEntryBySpec(asar, patch.targetSpec, patch.id, markers);
  }
  return findUniqueEntry(asar, patch.targetRegex, patch.id);
}

/**
 * Resolve a relative ESM specifier from `fromKey` into an ASAR key.
 */
function resolveRelativeKey(fromKey, specifier) {
  if (!specifier.startsWith(".")) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromKey), specifier));
}

/**
 * Inspect an ESM chunk in `asar` to find which exported name maps to a local definition matching `predicate(localName, chunkText, exportRec)`.
 */
function findExportInChunk(asar, chunkKey, predicate, label) {
  const rec = asar.byKey.get(chunkKey);
  assert(rec, `Missing referenced chunk ${chunkKey} while resolving ${label}`);
  const text = readEntryBuffer(asar, rec).toString("utf8");
  const tokens = tokenize(text);
  const exports = parseExports(tokens);
  const decl = (name) => getTopLevelDeclSource(text, name, tokens);
  const matches = exports.filter((ex) => predicate(ex.local, text, ex, decl));
  assert.equal(matches.length, 1, `Could not uniquely identify export ${label} in ${chunkKey} (found ${matches.length})`);
  return { ...matches[0], chunkKey, text };
}

/**
 * Create a rich semantic resolution context for a patch applying to `(asar, entry, source)`.
 */
function createPatchContext(asar, entry, source) {
  let cachedTokens = null;
  let cachedImports = null;
  let cachedExports = null;
  let cachedTopLevel = null;
  let cachedFunctions = null;
  const chunkTextCache = new Map();
  const additions = [];
  const injectedImports = [];
  const injectedCodeSnippets = [];

  const getTokens = () => (cachedTokens ||= tokenize(source));
  const getImports = () => (cachedImports ||= parseImports(getTokens()));
  const getExports = () => (cachedExports ||= parseExports(getTokens()));
  const getTopLevel = () => (cachedTopLevel ||= collectTopLevelBindings(getTokens()));
  const getFunctions = () => (cachedFunctions ||= findTopLevelFunctions(source, getTokens()));

  function readChunkText(key) {
    if (chunkTextCache.has(key)) return chunkTextCache.get(key);
    const rec = asar?.byKey?.get(key);
    if (!rec) return null;
    const text = readEntryBuffer(asar, rec).toString("utf8");
    chunkTextCache.set(key, text);
    return text;
  }

  /**
   * Find an import declaration in the current entry matching `specifierPredicate(specifier, resolvedKey, chunkText)`.
   */
  function findImport(specifierPredicate, label) {
    const imports = getImports();
    const hits = [];
    for (const imp of imports) {
      const resolvedKey = entry ? resolveRelativeKey(entry.key, imp.specifier) : null;
      const chunkText = resolvedKey ? readChunkText(resolvedKey) : null;
      if (specifierPredicate(imp.specifier, resolvedKey, chunkText, imp)) {
        hits.push({ ...imp, resolvedKey, chunkText });
      }
    }
    assert.equal(hits.length, 1, `Could not uniquely find import ${label} (found ${hits.length})`);
    return hits[0];
  }

  /**
   * Find the local alias of a named import from a chunk matching `specifierRegex`.
   * If `exportPredicate` is given and `asar` is available, inspects the target chunk to find
   * the exported name semantically (survives export renaming!), then maps to its local alias.
   * If `fallbackExportName` is given and `asar` is null (synthetic unit test), falls back to matching imported name.
   */
  function resolveImportedAlias(specifierMatcher, exportPredicate, label) {
    const pred = typeof specifierMatcher === "function"
      ? specifierMatcher
      : (spec) => specifierMatcher.test(spec);
    const imp = findImport(pred, label);
    if (!exportPredicate) {
      assert.equal(imp.specifiers.length, 1, `Import ${label} has ${imp.specifiers.length} specifiers; provide exportPredicate`);
      return { local: imp.specifiers[0].local, imported: imp.specifiers[0].imported, importRec: imp };
    }
    if (imp.resolvedKey && imp.chunkText) {
      const targetTokens = tokenize(imp.chunkText);
      const exports = parseExports(targetTokens);
      const decl = (name) => getTopLevelDeclSource(imp.chunkText, name, targetTokens);
      const matchedExports = exports.filter((ex) => exportPredicate(ex.local, imp.chunkText, ex, decl));
      assert.equal(matchedExports.length, 1, `Could not uniquely match export for ${label} in ${imp.resolvedKey} (found ${matchedExports.length})`);
      const targetExported = matchedExports[0].exported;
      const spec = imp.specifiers.find((s) => s.imported === targetExported);
      return {
        local: spec ? spec.local : null,
        imported: targetExported,
        localInTarget: matchedExports[0].local,
        importRec: imp,
      };
    }
    // Without ASAR (e.g. direct patch.apply(source) unit test), fall back to single-specifier or specifier predicate
    const spec = imp.specifiers.find((s) => exportPredicate(s.imported, "", { local: s.imported, exported: s.imported }));
    assert(spec, `Could not resolve imported alias ${label}`);
    return { local: spec.local, imported: spec.imported, importRec: imp };
  }

  /**
   * Ensure an export from a sibling chunk (found by `chunkSpec` in ASAR) is imported into the current entry.
   * If already imported, returns its existing local alias; otherwise records a synthetic `import { exported as preferredAlias } from "./..."`
   * to be prepended when finalizing.
   */
  function ensureChunkImport(chunkSpec, exportPredicate, preferredAlias, label) {
    assert(asar && entry, `ensureChunkImport(${label}) requires ASAR context`);
    const targetEntry = typeof chunkSpec === "string"
      ? { key: chunkSpec, content: readEntryBuffer(asar, asar.byKey.get(chunkSpec)) }
      : findEntryBySpec(asar, chunkSpec, label);
    const relSpecifier = "./" + path.posix.relative(path.posix.dirname(entry.key), targetEntry.key);
    const exp = findExportInChunk(asar, targetEntry.key, exportPredicate, label);
    // Check if already imported in current file
    const existingImp = getImports().find((imp) => resolveRelativeKey(entry.key, imp.specifier) === targetEntry.key);
    const existingSpec = existingImp?.specifiers.find((s) => s.imported === exp.exported);
    if (existingSpec) {
      return { local: existingSpec.local, specifier: relSpecifier, exported: exp.exported, added: false };
    }
    const stmt = `import{${exp.exported} as ${preferredAlias}}from"${relSpecifier}";`;
    injectedImports.push(stmt);
    return { local: preferredAlias, specifier: relSpecifier, exported: exp.exported, added: true };
  }

  /**
   * Auto-detect React, JSX runtime, and React Compiler memo cache (`c`) bindings in a client chunk.
   */
  function resolveReactBindings() {
    const imports = getImports();
    let react = null;
    let jsx = null;
    let compiler = null;

    // 1. Detect `X.jsx` / `X.jsxs` usage directly from source (most reliable across bundles!)
    const jsxUse = source.match(/\(0,([A-Za-z_$][\w$]*)\.jsxs?\)\(/);
    if (jsxUse) jsx = jsxUse[1];

    // 2. Detect React Compiler `(0, X.c)(N)`
    const compUse = source.match(/\(0,([A-Za-z_$][\w$]*)\.c\)\(\d+\)/);
    if (compUse) compiler = compUse[1];

    // 3. Detect React (`X.useState` / `X.useRef` / `X.useEffect` / `X.memo` / `X.useMemo` / `X.createContext`)
    const reactUse = source.match(/(?:\(0,([A-Za-z_$][\w$]*)\.(?:useState|useRef|useEffect|useMemo|useLayoutEffect|memo|createContext)\)|([A-Za-z_$][\w$]*)\.(?:Suspense|Fragment|memo|useState|useRef))/);
    if (reactUse) react = reactUse[1] || reactUse[2];

    // 4. Fallback via imports from `./react-*.js`
    if (!react || !jsx || !compiler) {
      for (const imp of imports) {
        if (!/react/i.test(imp.specifier)) continue;
        const text = imp.resolvedKey ? readChunkText(imp.resolvedKey) : null;
        if (!text) continue;
        for (const s of imp.specifiers) {
          if (!react && text.includes("createElement") && !jsx) react = s.local;
        }
      }
    }

    return { react, jsx, compiler };
  }

  /**
   * Register a brand-new ESM runtime file to be added into `server.asar` under the same
   * directory as the current patched entry (with a content-hashed filename to bust caches).
   * Returns the relative import specifier `./t3e-<base>-<hash8>.js`.
   */
  function addRuntimeAsset(baseName, codeText) {
    assert(entry, "addRuntimeAsset requires ASAR entry context");
    const content = Buffer.from(codeText, "utf8");
    const shortHash = digest(content).slice(0, 8);
    const fileName = `t3e-${baseName}-${shortHash}.js`;
    const key = path.posix.join(path.posix.dirname(entry.key), fileName);
    additions.push({ key, content });
    return { key, fileName, specifier: `./${fileName}` };
  }

  function recordInjectedCode(code) {
    if (code) injectedCodeSnippets.push(code);
  }

  return {
    asar,
    entry,
    source,
    getTokens,
    getImports,
    getExports,
    getTopLevel,
    getFunctions,
    readChunkText,
    findImport,
    resolveImportedAlias,
    ensureChunkImport,
    resolveReactBindings,
    addRuntimeAsset,
    recordInjectedCode,
    getAdditions: () => additions,
    getInjectedImports: () => injectedImports,
    getInjectedCodeSnippets: () => injectedCodeSnippets,
    // Re-export AST helpers on ctx for concise patch code
    findUniqueFunction: (pred, label) => findUniqueFunction(source, pred, label, getTokens()),
    findEnclosingFunction: (pos) => findEnclosingFunction(source, pos, getTokens()),
    extractDestructuredProps,
    extractObjectLiteralProps,
    allocateMemoSlots,
  };
}

/**
 * Static AST Scope Gate: verify that every free identifier in `injectedCode` is declared in
 * `patchedSource`'s top-level scope (or standard globals / `extraAllowed`).
 */
function verifyInjectedScope(patchedSource, injectedSnippets, label, extraAllowed = []) {
  if (!injectedSnippets || injectedSnippets.length === 0) return;
  const topBindings = collectTopLevelBindings(patchedSource);
  for (const snippet of injectedSnippets) {
    const missing = findUndeclaredIdentifiers(snippet, topBindings, extraAllowed);
    assert.equal(
      missing.length,
      0,
      `Static scope check failed for ${label}: undeclared reference(s): ${missing.join(", ")}`
    );
  }
}

module.exports = {
  readVerifiedEntry,
  findEntryBySpec,
  findPatchTarget,
  resolveRelativeKey,
  findExportInChunk,
  createPatchContext,
  verifyInjectedScope,
};

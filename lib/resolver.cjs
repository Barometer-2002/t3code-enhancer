"use strict";

/**
 * Semantic Cross-Version Chunk Discovery & Symbol Resolution Layer.
 * Allows patches to find target bundles by semantic fingerprints (surviving chunk renames/hashes)
 * and resolve imported/local symbols by cross-chunk export inspection (surviving Rolldown re-minification).
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const { digest, readEntryBuffer, readVerifiedEntry, findUniqueEntry } = require("./asar.cjs");
const {
  tokenize,
  parseImports,
  parseExports,
  collectTopLevelBindings,
  findUndeclaredIdentifiers,
  findUniqueFunction,
  findEnclosingFunction,
  allocateMemoSlots,
  getTopLevelDeclSource,
  indexTopLevelDecls,
} = require("./js-ast.cjs");

const CLIENT_ASSETS = /^apps\/server\/dist\/client\/assets\/[^/]+\.js$/;
const THREAD_ROUTE = {
  pathRegex: CLIENT_ASSETS,
  preferredRegex: /^apps\/server\/dist\/client\/assets\/ThreadRouteView-[\w-]+\.js$/,
  includes: ["data-chat-composer-form", "data-chat-column"],
};
const THREAD_TIMELINE = {
  pathRegex: CLIENT_ASSETS,
  preferredRegex: /^apps\/server\/dist\/client\/assets\/ReadOnlyThreadTimeline-[\w-]+\.js$/,
  includes: ["turnItemSource", "markdownCwd", "onInitialOutputReady"],
};
const APP_SHELL = {
  pathRegex: CLIENT_ASSETS,
  preferredRegex: /^apps\/server\/dist\/client\/assets\/main-[\w-]+\.js$/,
  includes: ["Clear thread search", "sidebar-thread-search-results"],
};
const DESKTOP_MAIN = {
  pathRegex: /^apps\/desktop\/dist-electron\/main\.cjs$/,
  includes: ["electron", "whenReady"],
};

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
  const markerRe = activeMarkers.length > 0
    ? new RegExp(`(?:^|[^A-Za-z0-9_])(?:${activeMarkers.map((m) => String(m).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:$|[^A-Za-z0-9_])`)
    : null;
  const matchesMarkers = (text) => Boolean(markerRe && markerRe.test(text));
  const matchesContent = (text, key) => {
    if (Array.isArray(spec.includes) && !spec.includes.every((s) => text.includes(s))) return false;
    if (Array.isArray(spec.anyIncludes) && !spec.anyIncludes.every((group) => group.some((s) => text.includes(s)))) return false;
    if (Array.isArray(spec.excludes) && spec.excludes.some((s) => text.includes(s))) return false;
    if (Array.isArray(spec.match) && !spec.match.every((re) => re.test(text))) return false;
    if (typeof spec.test === "function" && !spec.test(text, key)) return false;
    return true;
  };

  const scan = (candidates) => {
    const markerHits = [];
    const semanticHits = [];
    for (const rec of candidates) {
      const text = readEntryBuffer(asar, rec).toString("utf8");
      if (matchesMarkers(text)) markerHits.push(rec);
      else if (matchesContent(text, rec.key)) semanticHits.push(rec);
    }
    return { markerHits, semanticHits };
  };
  const candidates = asar.entries.filter(({ key }) => !isInjectedRuntime(key) && spec.pathRegex.test(key));
  if (spec.preferredRegex) {
    const { markerHits, semanticHits } = scan(candidates.filter(({ key }) => spec.preferredRegex.test(key)));
    if (markerHits.length === 1) return readVerifiedEntry(asar, markerHits[0], label);
    if (markerHits.length === 0 && semanticHits.length === 1) return readVerifiedEntry(asar, semanticHits[0], label);
  }

  const { markerHits, semanticHits } = scan(candidates);
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
function findPatchTarget(asar, patch, related = [patch]) {
  if (patch.targetSpec) {
    const markers = related.flatMap(({ marker, legacyMarkers = [] }) => [marker, ...legacyMarkers]);
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

const parsedChunkCache = new WeakMap();

function getParsedChunk(asar, key, text) {
  if (asar && key) {
    let perAsar = parsedChunkCache.get(asar);
    if (!perAsar) {
      perAsar = new Map();
      parsedChunkCache.set(asar, perAsar);
    }
    const cached = perAsar.get(key);
    if (cached && cached.text === text) return cached;
    const tokens = tokenize(text);
    const exports = parseExports(tokens);
    const declMap = indexTopLevelDecls(text, tokens);
    const info = { text, tokens, exports, declMap };
    perAsar.set(key, info);
    return info;
  }
  const tokens = tokenize(text);
  return { text, tokens, exports: parseExports(tokens), declMap: indexTopLevelDecls(text, tokens) };
}

function findExport(text, predicate, label, asar = null, key = null) {
  const { exports, declMap } = getParsedChunk(asar, key, text);
  const decl = (name) => declMap.get(name) ?? "";
  const matches = exports.filter((ex) => predicate(ex.local, text, ex, decl));
  assert.equal(matches.length, 1, `Could not uniquely identify export ${label} (found ${matches.length})`);
  return matches[0];
}

/**
 * Create a rich semantic resolution context for a patch applying to `(asar, entry, source)`.
 */
function createPatchContext(asar, entry, source, enabledIds) {
  let cachedTokens = null;
  let cachedImports = null;
  const chunkTextCache = new Map();
  const additions = [];
  const injectedImports = [];
  const injectedCodeSnippets = [];

  const getTokens = () => (cachedTokens ||= tokenize(source));
  const getImports = () => (cachedImports ||= parseImports(getTokens()));

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
   * Without an ASAR, the predicate can match the specifier's imported name.
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
      const target = findExport(imp.chunkText, exportPredicate, `${label} in ${imp.resolvedKey}`, asar, imp.resolvedKey);
      const spec = imp.specifiers.find((s) => s.imported === target.exported);
      return {
        local: spec ? spec.local : null,
        imported: target.exported,
        localInTarget: target.local,
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
  const injectedImportMap = new Map();

  function ensureChunkImport(chunkSpec, exportPredicate, preferredAlias, label) {
    assert(asar && entry, `ensureChunkImport(${label}) requires ASAR context`);
    const targetKey = typeof chunkSpec === "string" ? chunkSpec : findEntryBySpec(asar, chunkSpec, label).key;
    const relSpecifier = "./" + path.posix.relative(path.posix.dirname(entry.key), targetKey);
    const text = readChunkText(targetKey);
    assert(text !== null, `Missing referenced chunk ${targetKey} while resolving ${label}`);
    const exp = findExport(text, exportPredicate, `${label} in ${targetKey}`, asar, targetKey);
    // Check if already imported in current file
    const existingImp = getImports().find((imp) => resolveRelativeKey(entry.key, imp.specifier) === targetKey);
    const existingSpec = existingImp?.specifiers.find((s) => s.imported === exp.exported);
    if (existingSpec) {
      return { local: existingSpec.local, specifier: relSpecifier, exported: exp.exported, added: false };
    }
    const cacheKey = `${relSpecifier}\0${exp.exported}`;
    if (injectedImportMap.has(cacheKey)) {
      return { local: injectedImportMap.get(cacheKey), specifier: relSpecifier, exported: exp.exported, added: false };
    }
    const stmt = `import{${exp.exported} as ${preferredAlias}}from"${relSpecifier}";`;
    injectedImports.push(stmt);
    injectedImportMap.set(cacheKey, preferredAlias);
    return { local: preferredAlias, specifier: relSpecifier, exported: exp.exported, added: true };
  }

  function resolveReactBindings() {
    const reactUse = source.match(/(?:\(0,([A-Za-z_$][\w$]*)\.(?:useState|useRef|useEffect|useMemo|useLayoutEffect|memo|createContext)\)|([A-Za-z_$][\w$]*)\.(?:Suspense|Fragment|memo|useState|useRef))/);
    return {
      react: reactUse?.[1] || reactUse?.[2] || null,
      jsx: source.match(/\(0,([A-Za-z_$][\w$]*)\.jsxs?\)\(/)?.[1] ?? null,
    };
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
    isEnabled: (id) => enabledIds?.has(id) ?? false,
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
    assert(
      !/\(0,\s*undefined\.|\bundefined\.(?:jsx|jsxs|Fragment|useState|useRef|useEffect|useMemo|useCallback|memo|createContext)\b/.test(snippet),
      `Static scope check failed for ${label}: detected accidental "undefined." property access in injected code`
    );
    const missing = findUndeclaredIdentifiers(snippet, topBindings, extraAllowed);
    assert.equal(
      missing.length,
      0,
      `Static scope check failed for ${label}: undeclared reference(s): ${missing.join(", ")}`
    );
  }
}

module.exports = {
  THREAD_ROUTE,
  THREAD_TIMELINE,
  APP_SHELL,
  DESKTOP_MAIN,
  findEntryBySpec,
  findPatchTarget,
  resolveRelativeKey,
  createPatchContext,
  verifyInjectedScope,
};

"use strict";

const assert = require("node:assert/strict");
const { tokenize, findUniqueFunction } = require("../js-ast.cjs");

function stripSourceMap(source) {
  return source.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "");
}

function findStatementEndWithTokens(source, startCharIdx, tokens = tokenize(source)) {
  const tokIdx = tokens.findIndex((t) => t.start >= startCharIdx);
  if (tokIdx < 0) return -1;
  let depth = 0;
  for (let i = tokIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punct") {
      if (t.value === "(" || t.value === "{" || t.value === "[") depth++;
      else if (t.value === ")" || t.value === "}" || t.value === "]") depth--;
      else if (t.value === ";" && depth === 0) return t.end;
    }
  }
  return -1;
}

const ID = "no-telemetry";
const MARKER = "T3_NO_TELEMETRY_V1";
// Exact chunk hashes are pinned where sibling stub chunks share the same prefix (e.g. runtimeLayer-Bq7A-IVc.mjs, utils-C9Glzetk.js).
const TARGET_REGEX = /^apps\/server\/dist\/runtimeLayer-CYImUJjW\.mjs$/;
const ORIGINAL_HASH = "1b8122c5afafd21e0e695087d5e840f3de87df762f9061f16f0e0f037c7d1b7c";

const TARGET_SPEC = {
  pathRegex: /^apps\/server\/dist\/[^/]+\.mjs$/,
  preferredRegex: /^apps\/server\/dist\/runtimeLayer-[\w-]+\.mjs$/,
  includes: ["T3CODE_TELEMETRY_ENABLED", "AnalyticsService", "getTelemetryIdentity", "getServerOwners"],
};

function apply(source, ctx) {
  let patched = source;

  // 1. getTelemetryIdentity
  const idIdx = patched.search(/\bconst\s+getTelemetryIdentity\s*=/);
  assert(idIdx >= 0, "Could not locate getTelemetryIdentity in runtimeLayer");
  const genMatch = patched.slice(idIdx).match(/\bconst\s+getTelemetryIdentity\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*function\s*\*\s*\(\s*\)/);
  const genFn = genMatch ? genMatch[1] : "gen$1";
  const idEnd = findStatementEndWithTokens(patched, idIdx);
  assert(idEnd > idIdx, "Could not locate getTelemetryIdentity statement end in runtimeLayer");
  const idStub = `const getTelemetryIdentity = ${genFn}(function* () {\n\treturn {\n\t\tdistinctId: null,\n\t\tinstallId: null\n\t};\n});`;
  patched = patched.slice(0, idIdx) + idStub + patched.slice(idEnd);

  // 2. getServerOwners
  const ownIdx = patched.search(/\bconst\s+getServerOwners\s*=/);
  assert(ownIdx >= 0, "Could not locate getServerOwners in runtimeLayer");
  const ownGenMatch = patched.slice(ownIdx).match(/\bconst\s+getServerOwners\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*function\s*\*\s*\(\s*\)/);
  const ownGenFn = ownGenMatch ? ownGenMatch[1] : genFn;
  const ownEnd = findStatementEndWithTokens(patched, ownIdx);
  assert(ownEnd > ownIdx, "Could not locate getServerOwners statement end in runtimeLayer");
  const ownStub = `const getServerOwners = ${ownGenFn}(function* () {\n\treturn [];\n});`;
  patched = patched.slice(0, ownIdx) + ownStub + patched.slice(ownEnd);

  // 3. enabled: Boolean$N("T3CODE_TELEMETRY_ENABLED").pipe(...) -> withDefault(false) (handles nested parens in pipe)
  const defaultMatch = patched.match(/enabled:\s*([A-Za-z_$][\w$]*)\("T3CODE_TELEMETRY_ENABLED"\)\.pipe\(/);
  assert(defaultMatch, "Could not locate T3CODE_TELEMETRY_ENABLED default in runtimeLayer");
  const pipeStart = defaultMatch.index;
  const pipeOpenParen = pipeStart + defaultMatch[0].length - 1;
  let parenDepth = 0;
  let pipeCloseParen = -1;
  for (let i = pipeOpenParen; i < patched.length; i++) {
    if (patched[i] === "(") parenDepth++;
    else if (patched[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        pipeCloseParen = i;
        break;
      }
    }
  }
  assert(pipeCloseParen > pipeOpenParen, "Could not balance parens for T3CODE_TELEMETRY_ENABLED pipe");
  const boolVar = defaultMatch[1];
  const pipeArgs = patched.slice(pipeOpenParen + 1, pipeCloseParen);
  const withDefaultFn = pipeArgs.match(/\b(withDefault(?:\$\d+)?)\s*\(/)?.[1] || "withDefault";
  patched = patched.slice(0, pipeStart) + `enabled: ${boolVar}("T3CODE_TELEMETRY_ENABLED").pipe(${withDefaultFn}(false))` + patched.slice(pipeCloseParen + 1);

  // 4. AnalyticsService make generator before effect(AnalyticsService, make$NN)
  const layerMatch = patched.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*effect\(\s*AnalyticsService\s*,\s*([A-Za-z_$][\w$]*)\s*\);/);
  assert(layerMatch, "Could not locate effect(AnalyticsService, ...) in runtimeLayer");
  const makeName = layerMatch[2];
  const makePattern = `const ${makeName} =`;
  const startIdx = patched.indexOf(makePattern);
  assert(startIdx >= 0 && startIdx < layerMatch.index, `Could not locate ${makeName} declaration before AnalyticsService layer`);
  const makeGenMatch = patched.slice(startIdx).match(/^const\s+[A-Za-z_$][\w$]*\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*function\s*\*\s*\(\s*\)/);
  const makeGenFn = makeGenMatch ? makeGenMatch[1] : genFn;
  const endIdx = layerMatch.index;

  const slice = patched.slice(startIdx, endIdx);
  assert(slice.includes("TelemetryEnvConfig"), "Unexpected AnalyticsService slice missing TelemetryEnvConfig");
  assert(!/\bexport\b/.test(slice), "Unexpected export inside AnalyticsService slice");
  const voidIdent = slice.match(/\b(void_(?:\$\d+)?)\b/)?.[1] || patched.match(/\b(void_(?:\$\d+)?)\b/)?.[1] || "void_";

  const noopService = `const ${makeName} = ${makeGenFn}(function* () {
\t/* ${MARKER} */
\treturn AnalyticsService.of({
\t\trecord: () => ${voidIdent},
\t\tflush: ${voidIdent},
\t\trecordOwners: () => ${voidIdent}
\t});
});\n`;
  patched = patched.slice(0, startIdx) + noopService + patched.slice(endIdx);
  ctx?.recordInjectedCode?.(noopService);

  // 5. Older version readProviderLogins stub (if present)
  if (patched.includes("readProviderLogins")) {
    const rplIdx = patched.search(/\bconst\s+readProviderLogins\s*=/);
    if (rplIdx >= 0) {
      const rplEnd = findStatementEndWithTokens(patched, rplIdx);
      if (rplEnd > rplIdx) {
        const rplStub = `const readProviderLogins = () => ({});`;
        patched = patched.slice(0, rplIdx) + rplStub + patched.slice(rplEnd);
      }
    }
  }

  return stripSourceMap(patched);
}

const RELAY_MARKER = "T3_NO_TELEMETRY_RELAY_V1";
const relayPatch = {
  id: "no-telemetry-relay",
  name: "禁用 Relay OTLP 遥测追踪",
  marker: RELAY_MARKER,
  legacyMarkers: [],
  targetRegex: /^apps\/server\/dist\/WorkflowStore-[\w-]+\.mjs$/,
  originalHash: "c7109b336bfbde1b16a585e0cadefeb42fce86d6047f3ee3c0a4cf220dc19c2e",
  targetSpec: {
    pathRegex: /^apps\/server\/dist\/[^/]+\.mjs$/,
    preferredRegex: /^apps\/server\/dist\/WorkflowStore-[\w-]+\.mjs$/,
    includes: ["isRelayTracingEnabled", "T3CODE_TELEMETRY_ENABLED"],
  },
  apply(source) {
    const idx = source.indexOf("const isRelayTracingEnabled =");
    assert(idx >= 0 && idx === source.lastIndexOf("const isRelayTracingEnabled ="), "Could not uniquely locate isRelayTracingEnabled in WorkflowStore");
    const end = findStatementEndWithTokens(source, idx);
    assert(end > idx, "Could not locate isRelayTracingEnabled statement end in WorkflowStore");
    const replacement = `/* ${RELAY_MARKER} */\nconst isRelayTracingEnabled = () => false;`;
    return stripSourceMap(source.slice(0, idx) + replacement + source.slice(end));
  },
};

const CLIENT_MARKER = "T3_NO_TELEMETRY_CLIENT_V1";
const clientPatch = {
  id: "no-telemetry-client",
  name: "禁用客户端 Axiom OTLP 追踪导出",
  marker: CLIENT_MARKER,
  legacyMarkers: [],
  targetRegex: /^apps\/server\/dist\/client\/assets\/utils-Bng1kvMW\.js$/,
  originalHash: "2c855c329eb0054a3a65ae73d8fa459835af581832b8a7a9ab9f8270be0938fe",
  targetSpec: {
    pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
    preferredRegex: /^apps\/server\/dist\/client\/assets\/utils-[\w-]+\.js$/,
    includes: ["X-Axiom-Dataset", "tracesToken", "relay-client"],
  },
  apply(source, ctx) {
    const locateFn = ctx?.findUniqueFunction
      ? (pred, label) => ctx.findUniqueFunction(pred, label)
      : (pred, label) => findUniqueFunction(source, pred, label);
    const fn = locateFn(
      (f, fnSource) => fnSource.includes("X-Axiom-Dataset") && fnSource.includes("tracesToken"),
      "Axiom OTLP exporter in client utils"
    );
    const nullMatch = fn.source.match(/if\s*\([^)]*===null\)\s*return\s*([^;]+);/);
    assert(nullMatch, "Could not parse early null-return in client telemetry exporter");
    const noopExpr = nullMatch[1];
    const replacement = `function ${fn.name}(){/* ${CLIENT_MARKER} */return ${noopExpr}}`;
    return stripSourceMap(source.slice(0, fn.start) + replacement + source.slice(fn.end));
  },
};

const UI_MARKER = "T3_NO_TELEMETRY_UI_V2";
const uiPatch = {
  id: "no-telemetry-ui",
  name: "设置页显示遥测已彻底禁用提示",
  marker: UI_MARKER,
  legacyMarkers: ["T3_NO_TELEMETRY_UI_V1"],
  targetRegex: /^apps\/server\/dist\/client\/assets\/SettingsPanels-[\w-]+\.js$/,
  originalHash: "1f39513ed7e7785e74a16a6ad995dcc45f95f2d69c6658d98507379b9d41f117",
  targetSpec: {
    pathRegex: /^apps\/server\/dist\/client\/assets\/.*\.js$/,
    preferredRegex: /^apps\/server\/dist\/client\/assets\/SettingsPanels-[\w-]+\.js$/,
    includes: ["including the anonymous usage data T3 Code collects."],
  },
  apply(source) {
    const re = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===void 0\?([A-Za-z_$][\w$]*)\(`How we handle your data, including the anonymous usage data T3 Code collects\.`\):\3\(`How we handle your data\. \{telemetryOff\}\`,\{telemetryOff:\2\}\)/;
    const m = source.match(re);
    assert(m, "Could not locate privacy description anchor in SettingsPanels");
    const targetVar = m[1];
    const tFn = m[3];
    const replacement = `/* ${UI_MARKER} */${targetVar}=(()=>{let t3Zh=/[\\u4e00-\\u9fff]/.test(${tFn}(\`How we handle your data. {telemetryOff}\`,{telemetryOff:\`\`}))||(typeof document!=="undefined"&&/^zh/i.test(document.documentElement?.lang||(typeof navigator!=="undefined"?navigator.language:"")||""));return ${tFn}(\`How we handle your data. {telemetryOff}\`,{telemetryOff:t3Zh?"遥测、跨工具账号读取与链路追踪已由 t3code-enhancer 彻底禁用。":"Telemetry, identity file reads, and trace exports are disabled by t3code-enhancer."})})()`;
    return stripSourceMap(source.slice(0, m.index) + replacement + source.slice(m.index + m[0].length));
  },
};

const DESKTOP_MARKER = "T3_NO_TELEMETRY_DESKTOP_V1";
const desktopPatch = {
  id: "no-telemetry-desktop",
  name: "彻底禁用桌面端遥测（环境变量与网络拦截）",
  scope: "desktop",
  marker: DESKTOP_MARKER,
  legacyMarkers: [],
  targetRegex: /^apps\/desktop\/dist-electron\/main\.cjs$/,
  originalHash: "3767e3a14ef66756b8e404e11a2a472bb22c1993f710b932653f24bd29f50cdd",
  targetSpec: {
    pathRegex: /^apps\/desktop\/dist-electron\/main\.cjs$/,
    includes: ["electron", "whenReady"],
  },
  apply(source, ctx) {
    const snippet = `/* ${DESKTOP_MARKER} */
(() => {
  try {
    process.env.T3CODE_TELEMETRY_ENABLED = "false";
    process.env.T3CODE_OTEL_SDK_DISABLED = "true";
    if (typeof globalThis !== "undefined") {
      const kInstalled = Symbol.for("t3code.enhancer.no_telemetry_desktop");
      if (!globalThis[kInstalled]) {
        globalThis[kInstalled] = true;
        const electron = require("electron");
        if (electron && electron.app && typeof electron.app.whenReady === "function") {
          electron.app.whenReady().then(() => {
            try {
              const session = electron.session && electron.session.defaultSession;
              if (session && session.webRequest && session.webRequest.onBeforeRequest) {
                session.webRequest.onBeforeRequest(
                  { urls: ["*://*.posthog.com/*", "*://posthog.com/*", "*://*.axiom.co/*", "*://axiom.co/*"] },
                  (details, cb) => cb({ cancel: true })
                );
              }
            } catch {}
          }).catch(() => {});
        }
      }
    }
  } catch {}
})();\n`;

    ctx?.recordInjectedCode?.(snippet);

    let insertIdx = 0;
    if (source.startsWith("#!")) {
      const nl = source.indexOf("\n");
      insertIdx = nl >= 0 ? nl + 1 : source.length;
    }
    while (insertIdx < source.length) {
      if (source.startsWith("//", insertIdx)) {
        const nl = source.indexOf("\n", insertIdx);
        insertIdx = nl >= 0 ? nl + 1 : source.length;
        continue;
      }
      if (source.startsWith("/*", insertIdx)) {
        const close = source.indexOf("*/", insertIdx);
        insertIdx = close >= 0 ? close + 2 : source.length;
        continue;
      }
      if (/^\s/.test(source[insertIdx])) {
        insertIdx++;
        continue;
      }
      if (source.startsWith('"use strict";', insertIdx) || source.startsWith("'use strict';", insertIdx)) {
        insertIdx += 13;
        continue;
      }
      break;
    }

    return source.slice(0, insertIdx) + snippet + source.slice(insertIdx);
  },
};

module.exports = {
  id: ID,
  name: "彻底禁用遥测（禁读 .claude.json / .codex/auth.json 与 PostHog / Axiom 上报）",
  marker: MARKER,
  legacyMarkers: [],
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  targetSpec: TARGET_SPEC,
  apply,
  relayPatch,
  clientPatch,
  uiPatch,
  desktopPatch,
};

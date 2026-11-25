"use strict";

const assert = require("node:assert/strict");

const ID = "no-telemetry";
const MARKER = "T3_NO_TELEMETRY_V1";
// Exact chunk hashes are pinned where sibling stub chunks share the same prefix (e.g. runtimeLayer-edaSMazH.mjs, utils-C9Glzetk.js).
const TARGET_REGEX = /^apps\/server\/dist\/runtimeLayer-CyWe8jGq\.mjs$/;
const ORIGINAL_HASH = "f341b92a0e63e6e11ae8a74699313bee310babd19d2e2a0901648040246218cb";

const READ_PROVIDER_LOGINS_ANCHOR = `const readProviderLogins = fn("TelemetryIdentity.readProviderLogins")(function* (homeDirectory) {
\tconst path = yield* Path;
\treturn {
\t\tcodexTokens: yield* readJsonIdentityFile("codex", path.join(homeDirectory, ".codex", "auth.json"), decodeCodexAuthJson).pipe(skipOnError, map(flatMap$1((authJson) => fromUndefinedOr(authJson.tokens)))),
\t\tclaudeJson: yield* readJsonIdentityFile("claude", path.join(homeDirectory, ".claude.json"), decodeClaudeJson).pipe(skipOnError)
\t};
});`;

const TELEMETRY_IDENTITY_ANCHOR = `const getTelemetryIdentityForHome = fn("getTelemetryIdentityForHome")(function* (homeDirectory) {
\tconst { codexTokens, claudeJson } = yield* readProviderLogins(homeDirectory);
\tconst installId = yield* upsertAnonymousId.pipe(map(hashTelemetryId), catch_((error) => logTelemetryIdentityError(error).pipe(as(null))));
\tconst providerId = orElse(map$1(codexTokens, (tokens) => tokens.account_id), () => flatMap$1(claudeJson, (json) => fromUndefinedOr(json.userID)));
\treturn {
\t\tdistinctId: isSome(providerId) ? hashTelemetryId(providerId.value) : installId,
\t\tinstallId
\t};
});`;

const SERVER_OWNERS_ANCHOR = `const getServerOwnersForHome = fn("getServerOwnersForHome")(function* (homeDirectory) {
\tconst connectUser = yield* (yield* ServerSecretStore).get(CLOUD_LINKED_USER_ID).pipe(map(map$1((bytes) => new TextDecoder().decode(bytes))), catch_((cause) => logWarning$1("Failed to read the linked T3 Connect account for telemetry", { errorTag: cause._tag }).pipe(as(none$1()))));
\tconst { codexTokens, claudeJson } = yield* readProviderLogins(homeDirectory);
\treturn [
\t\t["connect", connectUser],
\t\t["openai", flatMap$1(codexTokens, (tokens) => flatMap$1(fromUndefinedOr(tokens.id_token), openAiUserId))],
\t\t["claude", flatMap$1(claudeJson, (json) => fromUndefinedOr(json.oauthAccount?.accountUuid))]
\t].flatMap(([source, value]) => isSome(value) && value.value.trim() !== "" ? [{
\t\tsource,
\t\townerId: hashTelemetryId(value.value)
\t}] : []);
});`;

const TELEMETRY_DEFAULT_ANCHOR = `enabled: Boolean$2("T3CODE_TELEMETRY_ENABLED").pipe(withDefault(true)),`;
const TELEMETRY_SERVICE_START = `const make$32 = gen$1(function* () {\n\tconst telemetryConfig = yield* TelemetryEnvConfig;`;
const TELEMETRY_SERVICE_END = `\nconst layer$49 = effect(AnalyticsService, make$32);`;

function stripSourceMap(source) {
  return source.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "");
}

function replaceUnique(source, target, replacement, label) {
  const first = source.indexOf(target);
  assert(first >= 0 && first === source.lastIndexOf(target), `Could not uniquely locate ${label}`);
  return source.slice(0, first) + replacement + source.slice(first + target.length);
}

function apply(source) {
  let patched = replaceUnique(
    source,
    READ_PROVIDER_LOGINS_ANCHOR,
    `const readProviderLogins = fn("TelemetryIdentity.readProviderLogins")(function* () {
\treturn {
\t\tcodexTokens: none$1(),
\t\tclaudeJson: none$1()
\t};
});`,
    "readProviderLogins in runtimeLayer"
  );

  patched = replaceUnique(
    patched,
    TELEMETRY_IDENTITY_ANCHOR,
    `const getTelemetryIdentityForHome = fn("getTelemetryIdentityForHome")(function* () {
\treturn {
\t\tdistinctId: null,
\t\tinstallId: null
\t};
});`,
    "getTelemetryIdentityForHome in runtimeLayer"
  );

  patched = replaceUnique(
    patched,
    SERVER_OWNERS_ANCHOR,
    `const getServerOwnersForHome = fn("getServerOwnersForHome")(function* () {
\treturn [];
});`,
    "getServerOwnersForHome in runtimeLayer"
  );

  patched = replaceUnique(
    patched,
    TELEMETRY_DEFAULT_ANCHOR,
    `enabled: Boolean$2("T3CODE_TELEMETRY_ENABLED").pipe(withDefault(false)),`,
    "TelemetryEnvConfig default in runtimeLayer"
  );

  const startIdx = patched.indexOf(TELEMETRY_SERVICE_START);
  assert(
    startIdx >= 0 && startIdx === patched.lastIndexOf(TELEMETRY_SERVICE_START),
    "Could not uniquely locate AnalyticsService make$32 start in runtimeLayer"
  );
  const endIdx = patched.indexOf(TELEMETRY_SERVICE_END, startIdx);
  assert(
    endIdx > startIdx && endIdx === patched.lastIndexOf(TELEMETRY_SERVICE_END),
    "Could not uniquely locate AnalyticsService layer$49 end in runtimeLayer"
  );

  assert(!/\bexport\b/.test(patched.slice(startIdx, endIdx)), "Unexpected export inside AnalyticsService slice");

  const noopService = `const make$32 = gen$1(function* () {
\t/* ${MARKER} */
\treturn AnalyticsService.of({
\t\trecord: () => void_,
\t\tflush: void_,
\t\trecordOwners: () => void_
\t});
});`;

  return stripSourceMap(patched.slice(0, startIdx) + noopService + patched.slice(endIdx));
}

const RELAY_ANCHOR = `const isRelayTracingEnabled = (env) => all$4({
\t...sdkFlags,
\ttelemetry: flag("T3CODE_TELEMETRY_ENABLED", T3CODE_TRUE, T3CODE_FALSE, String)
}).pipe(map$6(({ telemetry, t3, spec }) => telemetry.value !== false && !(t3.value ?? spec.value ?? false)), provide$2(layer$86(fromEnvRecord(env))), orDie, runSync);`;

const RELAY_MARKER = "T3_NO_TELEMETRY_RELAY_V1";
const relayPatch = {
  id: "no-telemetry-relay",
  name: "禁用 Relay OTLP 遥测追踪",
  marker: RELAY_MARKER,
  legacyMarkers: [],
  targetRegex: /^apps\/server\/dist\/ManagedEndpointRuntime-[\w-]+\.mjs$/,
  originalHash: "dd47b52c1b26f8c6cedbdcc092098d3c9cfece2fd4371318fd3c91d34ed94598",
  apply(source) {
    return stripSourceMap(replaceUnique(
      source,
      RELAY_ANCHOR,
      `/* ${RELAY_MARKER} */
const isRelayTracingEnabled = () => false;`,
      "isRelayTracingEnabled in ManagedEndpointRuntime"
    ));
  },
};

const CLIENT_OTLP_ANCHOR = `function CE(e,t,n){if(e===null)return Co(hE,lr());let r=uE({url:e.tracesUrl,headers:{Authorization:\`Bearer \${e.tracesToken}\`,"X-Axiom-Dataset":e.tracesDataset},resource:{serviceName:t.serviceName,serviceVersion:t.serviceVersion,attributes:{"service.namespace":\`t3code\`,"service.instance.id":t.serviceInstanceId,"service.runtime":t.runtime,"t3code.component":t.component??\`relay-client\`,"t3code.client.surface":t.client,...t.attributes}}}).pipe(wc(cE));return Kl(hE,ll.pipe(K(xE),K(e=>n?.isEnabled?SE(e,n.isEnabled):e),ln)).pipe(wc(r))}`;

const CLIENT_MARKER = "T3_NO_TELEMETRY_CLIENT_V1";
const clientPatch = {
  id: "no-telemetry-client",
  name: "禁用客户端 Axiom OTLP 追踪导出",
  marker: CLIENT_MARKER,
  legacyMarkers: [],
  targetRegex: /^apps\/server\/dist\/client\/assets\/utils-CfAhq9cy\.js$/,
  originalHash: "8486f641e99c4e08dbc043379960470ea72e221fc119c1f8c19b743a9904ac6f",
  apply(source) {
    return stripSourceMap(replaceUnique(
      source,
      CLIENT_OTLP_ANCHOR,
      `function CE(){/* ${CLIENT_MARKER} */return Co(hE,lr())}`,
      "Axiom OTLP exporter CE in client utils"
    ));
  },
};

const UI_PRIVACY_ANCHOR = `d=h===void 0?n(\`How we handle your data, including the anonymous usage data T3 Code collects.\`):n(\`How we handle your data. {telemetryOff}\`,{telemetryOff:h})`;

const UI_MARKER = "T3_NO_TELEMETRY_UI_V2";
const uiPatch = {
  id: "no-telemetry-ui",
  name: "设置页显示遥测已彻底禁用提示",
  marker: UI_MARKER,
  legacyMarkers: ["T3_NO_TELEMETRY_UI_V1"],
  targetRegex: /^apps\/server\/dist\/client\/assets\/SettingsPanels-[\w-]+\.js$/,
  originalHash: "f0d21b0b766caaf90a6e4b319a83ae5b4dc5143e90d3132c37ec6becbc9cb615",
  apply(source) {
    return stripSourceMap(replaceUnique(
      source,
      UI_PRIVACY_ANCHOR,
      `/* ${UI_MARKER} */d=(()=>{let t3Zh=/[\\u4e00-\\u9fff]/.test(n(\`How we handle your data. {telemetryOff}\`,{telemetryOff:\`\`}))||(typeof document!=="undefined"&&/^zh/i.test(document.documentElement?.lang||(typeof navigator!=="undefined"?navigator.language:"")||""));return n(\`How we handle your data. {telemetryOff}\`,{telemetryOff:t3Zh?"遥测、跨工具账号读取与链路追踪已由 t3code-enhancer 彻底禁用。":"Telemetry, identity file reads, and trace exports are disabled by t3code-enhancer."})})()`,
      "SettingsPanels privacy description"
    ));
  },
};

module.exports = {
  id: ID,
  name: "彻底禁用遥测（禁读 .claude.json / .codex/auth.json 与 PostHog / Axiom 上报）",
  marker: MARKER,
  legacyMarkers: [],
  targetRegex: TARGET_REGEX,
  originalHash: ORIGINAL_HASH,
  apply,
  relayPatch,
  clientPatch,
  uiPatch,
};

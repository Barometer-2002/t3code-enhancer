"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RUNTIME_DIR = path.join(__dirname, "runtime");
const moduleCache = new Map();
const sourceCache = new Map();

function readRuntimeSource(name) {
  if (sourceCache.has(name)) return sourceCache.get(name);
  const src = fs.readFileSync(path.join(RUNTIME_DIR, `${name}.mjs`), "utf8");
  sourceCache.set(name, src);
  return src;
}

function compileExecutable(name) {
  const filePath = path.join(RUNTIME_DIR, `${name}.mjs`);
  const src = readRuntimeSource(name);
  if (/^\s*import\s/m.test(src)) {
    throw new Error(`${name}.mjs must stay import-free to be shared with patches`);
  }
  const exportNames = [
    ...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var)\s+([\w$]+)/gm),
  ].map((m) => m[1]);
  return { filePath, src, exportNames };
}

function mountRuntime(source, ctx, name, imports, bridge) {
  const runtime = readRuntimeSource(name);
  ctx.recordInjectedCode(bridge);
  if (!ctx.entry) {
    const inline = runtime.replace(/^export /gm, "");
    ctx.recordInjectedCode(inline);
    return `${source}\n${inline}\n${bridge}\n`;
  }
  const { specifier } = ctx.addRuntimeAsset(name, runtime);
  return `import { ${imports.join(", ")} } from "${specifier}";\n${source}\n${bridge}\n`;
}

// Evaluate in the current Node realm when no custom globals are needed so Array/Set prototypes stay native.
function loadRuntimeExports(name) {
  if (!moduleCache.has(name)) {
    const { filePath, src, exportNames } = compileExecutable(name);
    const exportsObj = vm.runInThisContext(
      `(function() {\n${src.replace(/^export\s+/gm, "")}\nreturn { ${exportNames.join(", ")} };\n})()`,
      { filename: filePath }
    );
    moduleCache.set(name, exportsObj);
  }
  return moduleCache.get(name);
}

module.exports = {
  mountRuntime,
  loadRuntimeExports,
};

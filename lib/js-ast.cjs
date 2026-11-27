"use strict";

/**
 * Zero-dependency ES2022 JS/ESM lexical & structural analyzer for Rolldown/Vite/esbuild bundles.
 * Provides:
 * - Accurate tokenization (strings, nested template literals, comments, regex vs division)
 * - Balanced bracket/brace/paren traversal
 * - ESM import & export parsing
 * - Top-level declaration collection
 * - Static free-identifier scope checking (used as an automated build gate)
 * - Function boundary detection, destructured parameter extraction, and React Compiler memo slot allocation
 */

const assert = require("node:assert/strict");

const KEYWORDS = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "import", "in", "instanceof", "let",
  "new", "null", "return", "static", "super", "switch", "this", "throw",
  "true", "try", "typeof", "var", "void", "while", "with", "yield", "of", "as", "from", "async",
]);

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "throw", "case", "in", "instanceof", "typeof", "void", "delete",
  "new", "else", "do", "await", "yield", "of",
]);

const REGEX_PRECEDING_PUNCT = new Set([
  "(", "[", "{", ",", ";", ":", "?", "=", "+=", "-=", "*=", "/=", "%=", "**=",
  "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??=", "=>",
  "!", "~", "+", "-", "*", "/", "%", "**", "<", ">", "<=", ">=", "==", "!=",
  "===", "!==", "&", "|", "^", "&&", "||", "??", "?", "...",
]);

const STANDARD_GLOBALS = new Set([
  // ECMAScript built-ins
  "undefined", "NaN", "Infinity", "globalThis", "Object", "Function", "Boolean",
  "Symbol", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError",
  "TypeError", "URIError", "AggregateError", "Number", "BigInt", "Math", "Date",
  "String", "RegExp", "Array", "Int8Array", "Uint8Array", "Uint8ClampedArray",
  "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array",
  "Float64Array", "BigInt64Array", "BigUint64Array", "Map", "Set", "WeakMap",
  "WeakSet", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics", "JSON",
  "Promise", "Reflect", "Proxy", "Intl", "WeakRef", "FinalizationRegistry",
  "isFinite", "isNaN", "parseFloat", "parseInt", "decodeURI", "decodeURIComponent",
  "encodeURI", "encodeURIComponent", "escape", "unescape", "eval", "arguments",
  // Browser / Electron / Node common globals
  "window", "document", "navigator", "location", "history", "localStorage",
  "sessionStorage", "console", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
  "performance", "crypto", "URL", "URLSearchParams", "Event", "CustomEvent",
  "EventTarget", "Element", "HTMLElement", "Node", "NodeList", "DOMRect",
  "ResizeObserver", "IntersectionObserver", "MutationObserver", "WheelEvent",
  "KeyboardEvent", "MouseEvent", "PointerEvent", "FocusEvent", "ClipboardEvent",
  "AbortController", "AbortSignal", "Headers", "Request", "Response", "fetch",
  "FormData", "Blob", "File", "FileReader", "TextEncoder", "TextDecoder",
  "CSS", "getComputedStyle", "matchMedia", "structuredClone", "atob", "btoa",
  "process", "Buffer", "require", "module", "exports", "__dirname", "__filename",
  "global", "setImmediate", "clearImmediate", "MessageChannel", "BroadcastChannel",
]);

function isIdentStart(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c >= 128;
}

function isIdentPart(ch) {
  const c = ch.charCodeAt(0);
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) ||
    c === 95 ||
    c === 36 ||
    c >= 128
  );
}

/**
 * Tokenize JS/ESM source into an array of tokens:
 * { type: "ident"|"string"|"template"|"number"|"regex"|"punct", value, start, end }
 * Template literal expressions (`foo ${expr} bar`) are tokenized recursively with
 * "template" chunks and real tokens inside `${...}`.
 */
function tokenize(source) {
  const tokens = [];
  const len = source.length;
  let i = 0;
  // Stack of brace depths for active template literal `${...}` interpolations
  const templateBraceStack = [];

  function canStartRegex() {
    if (tokens.length === 0) return true;
    const prev = tokens[tokens.length - 1];
    if (prev.type === "ident") return REGEX_PRECEDING_KEYWORDS.has(prev.value);
    if (prev.type === "punct") {
      if (prev.value === ")" || prev.value === "]" || prev.value === "++" || prev.value === "--") {
        // After `if (...) /re/` or `while (...) /re/`, regex can start; conservative check:
        if (prev.value === ")") {
          // Scan backward to matching "(" and inspect token before it
          let depth = 0;
          for (let k = tokens.length - 1; k >= 0; k--) {
            const tv = tokens[k].value;
            if (tokens[k].type === "punct" && tv === ")") depth++;
            else if (tokens[k].type === "punct" && tv === "(") {
              depth--;
              if (depth === 0) {
                const before = tokens[k - 1];
                return Boolean(before && before.type === "ident" && (before.value === "if" || before.value === "while" || before.value === "for" || before.value === "with"));
              }
            }
          }
        }
        return false;
      }
      if (prev.value === "}") return true;
      return REGEX_PRECEDING_PUNCT.has(prev.value);
    }
    return false;
  }

  function scanTemplateChunk(startPos) {
    // Assumes we are right after opening ` or right after closing } of ${...}
    let pos = startPos;
    while (pos < len) {
      const c = source[pos];
      if (c === "\\") {
        pos += 2;
        continue;
      }
      if (c === "`") {
        tokens.push({ type: "template", value: source.slice(startPos - 1, pos + 1), start: startPos - 1, end: pos + 1 });
        return pos + 1;
      }
      if (c === "$" && source[pos + 1] === "{") {
        tokens.push({ type: "template", value: source.slice(startPos - 1, pos + 2), start: startPos - 1, end: pos + 2 });
        templateBraceStack.push(0);
        return pos + 2;
      }
      pos++;
    }
    tokens.push({ type: "template", value: source.slice(startPos - 1, len), start: startPos - 1, end: len });
    return len;
  }

  while (i < len) {
    const ch = source[i];
    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v" || ch === "\uFEFF") {
      i++;
      continue;
    }
    // Single-line comment
    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < len && source[i] !== "\n" && source[i] !== "\r") i++;
      continue;
    }
    // Block comment
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < len && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // String literal
    if (ch === "'" || ch === '"') {
      const start = i;
      const quote = ch;
      i++;
      while (i < len) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      tokens.push({ type: "string", value: source.slice(start, i), start, end: i });
      continue;
    }
    // Template literal
    if (ch === "`") {
      i = scanTemplateChunk(i + 1);
      continue;
    }
    // Regex literal
    if (ch === "/" && canStartRegex()) {
      const start = i;
      i++;
      let inClass = false;
      while (i < len) {
        const c = source[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          i++;
          while (i < len && isIdentPart(source[i])) i++;
          break;
        } else if (c === "\n" || c === "\r") {
          break;
        }
        i++;
      }
      tokens.push({ type: "regex", value: source.slice(start, i), start, end: i });
      continue;
    }
    // Numbers
    if ((ch >= "0" && ch <= "9") || (ch === "." && source[i + 1] >= "0" && source[i + 1] <= "9")) {
      const start = i;
      if (ch === "0" && (source[i + 1] === "x" || source[i + 1] === "X" || source[i + 1] === "b" || source[i + 1] === "B" || source[i + 1] === "o" || source[i + 1] === "O")) {
        i += 2;
        while (i < len && /[0-9a-fA-F_]/.test(source[i])) i++;
      } else {
        while (i < len && /[0-9_]/.test(source[i])) i++;
        if (source[i] === ".") {
          i++;
          while (i < len && /[0-9_]/.test(source[i])) i++;
        }
        if (source[i] === "e" || source[i] === "E") {
          i++;
          if (source[i] === "+" || source[i] === "-") i++;
          while (i < len && /[0-9_]/.test(source[i])) i++;
        }
      }
      if (source[i] === "n") i++;
      tokens.push({ type: "number", value: source.slice(start, i), start, end: i });
      continue;
    }
    // Identifier / keyword
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < len && isIdentPart(source[i])) i++;
      tokens.push({ type: "ident", value: source.slice(start, i), start, end: i });
      continue;
    }
    // Braces interacting with template interpolations
    if (ch === "{") {
      if (templateBraceStack.length > 0) {
        templateBraceStack[templateBraceStack.length - 1]++;
      }
      tokens.push({ type: "punct", value: "{", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === "}") {
      if (templateBraceStack.length > 0) {
        if (templateBraceStack[templateBraceStack.length - 1] === 0) {
          templateBraceStack.pop();
          i = scanTemplateChunk(i + 1);
          continue;
        }
        templateBraceStack[templateBraceStack.length - 1]--;
      }
      tokens.push({ type: "punct", value: "}", start: i, end: i + 1 });
      i++;
      continue;
    }
    // Multi-char punctuators (longest first)
    const s4 = source.slice(i, i + 4);
    if (s4 === ">>>=") {
      tokens.push({ type: "punct", value: s4, start: i, end: i + 4 });
      i += 4;
      continue;
    }
    const s3 = source.slice(i, i + 3);
    if (s3 === "===" || s3 === "!==" || s3 === ">>>" || s3 === "..." || s3 === "**=" || s3 === "<<=" || s3 === ">>=" || s3 === "&&=" || s3 === "||=" || s3 === "??=") {
      tokens.push({ type: "punct", value: s3, start: i, end: i + 3 });
      i += 3;
      continue;
    }
    const s2 = source.slice(i, i + 2);
    if (
      s2 === "=>" || s2 === "?." || s2 === "??" || s2 === "&&" || s2 === "||" ||
      s2 === "==" || s2 === "!=" || s2 === "<=" || s2 === ">=" || s2 === "++" ||
      s2 === "--" || s2 === "<<" || s2 === ">>" || s2 === "**" || s2 === "+=" ||
      s2 === "-=" || s2 === "*=" || s2 === "/=" || s2 === "%=" || s2 === "&=" ||
      s2 === "|=" || s2 === "^="
    ) {
      // Disambiguate `?.` followed by digit (ternary `a?.5:1`)
      if (s2 === "?." && source[i + 2] >= "0" && source[i + 2] <= "9") {
        tokens.push({ type: "punct", value: "?", start: i, end: i + 1 });
        i++;
        continue;
      }
      tokens.push({ type: "punct", value: s2, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    tokens.push({ type: "punct", value: ch, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

/**
 * Unquote a JS string token value.
 */
function unquote(strTok) {
  if (!strTok || strTok.length < 2) return "";
  const q = strTok[0];
  if (q === '"') {
    try { return JSON.parse(strTok); } catch { return strTok.slice(1, -1); }
  }
  return strTok.slice(1, -1).replace(/\\(.)/g, "$1");
}

/**
 * Find matching closing delimiter index in token array starting at openIdx (`{`, `(`, `[`).
 */
function findMatchingToken(tokens, openIdx) {
  const open = tokens[openIdx]?.value;
  const close = open === "{" ? "}" : open === "(" ? ")" : open === "[" ? "]" : null;
  if (!close) return -1;
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].type === "punct") {
      if (tokens[i].value === open) depth++;
      else if (tokens[i].value === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

/**
 * Find matching closing delimiter character offset in raw source starting at `openOffset`.
 */
function findMatchingChar(source, openOffset) {
  const open = source[openOffset];
  const close = open === "{" ? "}" : open === "(" ? ")" : open === "[" ? "]" : null;
  if (!close) return -1;
  const subTokens = tokenize(source.slice(openOffset));
  const matchIdx = findMatchingToken(subTokens, 0);
  return matchIdx >= 0 ? openOffset + subTokens[matchIdx].start : -1;
}

/**
 * Parse all top-level ESM `import` declarations from source or tokens.
 * Returns array of:
 * { specifier, start, end, specifiers: [{ imported, local, kind: "named"|"default"|"namespace" }] }
 */
function parseImports(sourceOrTokens) {
  const tokens = Array.isArray(sourceOrTokens) ? sourceOrTokens : tokenize(sourceOrTokens);
  const imports = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punct") {
      if (t.value === "{" || t.value === "(" || t.value === "[") depth++;
      else if (t.value === "}" || t.value === ")" || t.value === "]") depth--;
      continue;
    }
    if (depth !== 0 || t.type !== "ident" || t.value !== "import") continue;
    // Skip dynamic import(...) or import.meta
    const next = tokens[i + 1];
    if (!next || (next.type === "punct" && (next.value === "(" || next.value === "."))) continue;
    const start = t.start;
    const specs = [];
    let j = i + 1;
    if (tokens[j]?.type === "string") {
      // Side-effect import "foo"
      const specifier = unquote(tokens[j].value);
      let end = tokens[j].end;
      if (tokens[j + 1]?.type === "punct" && tokens[j + 1].value === ";") {
        end = tokens[j + 1].end;
        j++;
      }
      imports.push({ specifier, start, end, specifiers: specs });
      i = j;
      continue;
    }
    // Parse default / namespace / named specifiers until `from`
    while (j < tokens.length && !(tokens[j].type === "ident" && tokens[j].value === "from")) {
      const cur = tokens[j];
      if (cur.type === "punct" && cur.value === "{") {
        const closeBrace = findMatchingToken(tokens, j);
        if (closeBrace < 0) break;
        let k = j + 1;
        while (k < closeBrace) {
          if (tokens[k].type === "punct" && tokens[k].value === ",") {
            k++;
            continue;
          }
          const impTok = tokens[k];
          const imported = impTok.type === "string" ? unquote(impTok.value) : impTok.value;
          let local = imported;
          if (tokens[k + 1]?.type === "ident" && tokens[k + 1].value === "as" && tokens[k + 2]) {
            local = tokens[k + 2].value;
            k += 3;
          } else {
            k++;
          }
          specs.push({ imported, local, kind: "named" });
        }
        j = closeBrace + 1;
      } else if (cur.type === "punct" && cur.value === "*") {
        if (tokens[j + 1]?.value === "as" && tokens[j + 2]) {
          specs.push({ imported: "*", local: tokens[j + 2].value, kind: "namespace" });
          j += 3;
        } else {
          j++;
        }
      } else if (cur.type === "ident" && cur.value !== ",") {
        specs.push({ imported: "default", local: cur.value, kind: "default" });
        j++;
      } else {
        j++;
      }
    }
    if (tokens[j]?.type === "ident" && tokens[j].value === "from" && tokens[j + 1]?.type === "string") {
      const specifier = unquote(tokens[j + 1].value);
      let end = tokens[j + 1].end;
      if (tokens[j + 2]?.type === "punct" && tokens[j + 2].value === ";") {
        end = tokens[j + 2].end;
        j += 2;
      } else {
        j += 1;
      }
      imports.push({ specifier, start, end, specifiers: specs });
      i = j;
    }
  }
  return imports;
}

/**
 * Parse all top-level ESM `export` declarations.
 * Returns array of { local, exported, from? }.
 */
function parseExports(sourceOrTokens) {
  const tokens = Array.isArray(sourceOrTokens) ? sourceOrTokens : tokenize(sourceOrTokens);
  const exports = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punct") {
      if (t.value === "{" || t.value === "(" || t.value === "[") depth++;
      else if (t.value === "}" || t.value === ")" || t.value === "]") depth--;
      continue;
    }
    if (depth !== 0 || t.type !== "ident" || t.value !== "export") continue;
    const next = tokens[i + 1];
    if (!next) continue;
    if (next.type === "punct" && next.value === "*") {
      // `export * from "..."` or `export * as ns from "..."`
      if (tokens[i + 2]?.type === "ident" && tokens[i + 2].value === "as" && tokens[i + 3]?.type === "ident" &&
          tokens[i + 4]?.type === "ident" && tokens[i + 4].value === "from" && tokens[i + 5]?.type === "string") {
        exports.push({ local: "*", exported: tokens[i + 3].value, from: unquote(tokens[i + 5].value) });
        i += 5;
      } else if (tokens[i + 2]?.type === "ident" && tokens[i + 2].value === "from" && tokens[i + 3]?.type === "string") {
        exports.push({ local: "*", exported: "*", from: unquote(tokens[i + 3].value) });
        i += 3;
      }
      continue;
    }
    if (next.type === "punct" && next.value === "{") {
      const closeBrace = findMatchingToken(tokens, i + 1);
      if (closeBrace < 0) continue;
      let fromSpec = null;
      if (tokens[closeBrace + 1]?.type === "ident" && tokens[closeBrace + 1].value === "from" && tokens[closeBrace + 2]?.type === "string") {
        fromSpec = unquote(tokens[closeBrace + 2].value);
      }
      let k = i + 2;
      while (k < closeBrace) {
        if (tokens[k].type === "punct" && tokens[k].value === ",") {
          k++;
          continue;
        }
        const local = tokens[k].type === "string" ? unquote(tokens[k].value) : tokens[k].value;
        let exported = local;
        if (tokens[k + 1]?.type === "ident" && tokens[k + 1].value === "as" && tokens[k + 2]) {
          exported = tokens[k + 2].type === "string" ? unquote(tokens[k + 2].value) : tokens[k + 2].value;
          k += 3;
        } else {
          k++;
        }
        exports.push({ local, exported, from: fromSpec });
      }
      i = closeBrace;
    } else if (next.type === "ident" && next.value === "default") {
      const nameTok = tokens[i + 2];
      let local = "default";
      if (nameTok?.type === "ident" && (nameTok.value === "function" || nameTok.value === "class")) {
        let j = i + 3;
        if (tokens[j]?.type === "punct" && tokens[j].value === "*") j++;
        if (tokens[j]?.type === "ident") local = tokens[j].value;
      } else if (nameTok?.type === "ident" && nameTok.value === "async" && tokens[i + 3]?.type === "ident" && tokens[i + 3].value === "function") {
        let j = i + 4;
        if (tokens[j]?.type === "punct" && tokens[j].value === "*") j++;
        if (tokens[j]?.type === "ident") local = tokens[j].value;
      } else if (nameTok?.type === "ident" && !KEYWORDS.has(nameTok.value)) {
        local = nameTok.value;
      }
      exports.push({ local, exported: "default", from: null });
    } else if (next.type === "ident" && next.value === "async" && tokens[i + 2]?.type === "ident" && tokens[i + 2].value === "function") {
      let j = i + 3;
      if (tokens[j]?.type === "punct" && tokens[j].value === "*") j++;
      if (tokens[j]?.type === "ident" && !KEYWORDS.has(tokens[j].value)) {
        exports.push({ local: tokens[j].value, exported: tokens[j].value, from: null });
      }
    } else if (next.type === "ident" && next.value === "function") {
      let j = i + 2;
      if (tokens[j]?.type === "punct" && tokens[j].value === "*") j++;
      if (tokens[j]?.type === "ident" && !KEYWORDS.has(tokens[j].value)) {
        exports.push({ local: tokens[j].value, exported: tokens[j].value, from: null });
      }
    } else if (next.type === "ident" && next.value === "class") {
      if (tokens[i + 2]?.type === "ident" && !KEYWORDS.has(tokens[i + 2].value)) {
        exports.push({ local: tokens[i + 2].value, exported: tokens[i + 2].value, from: null });
      }
    } else if (next.type === "ident" && (next.value === "var" || next.value === "let" || next.value === "const")) {
      let j = i + 2;
      const declNames = new Set();
      while (j < tokens.length) {
        j = collectPatternBindings(tokens, j, declNames);
        j = skipInitializer(tokens, j, tokens.length, { stopOnTopLevelAsi: true });
        if (tokens[j]?.type === "punct" && tokens[j].value === ",") {
          j++;
          continue;
        }
        i = tokens[j]?.type === "punct" && tokens[j].value === ";" ? j : j - 1;
        break;
      }
      for (const name of declNames) {
        exports.push({ local: name, exported: name, from: null });
      }
    }
  }
  return exports;
}

const TOP_LEVEL_DECL_KW = new Set(["function", "var", "let", "const", "class", "export", "import"]);

/**
 * Advance past an optional `= initializer` starting at token `idx`, stopping before
 * the terminating delimiter at bracket depth 0 (never past `endIdx`).
 */
function skipInitializer(tokens, idx, endIdx = tokens.length, opts = {}) {
  if (tokens[idx]?.type !== "punct" || tokens[idx].value !== "=") return idx;
  let j = idx + 1;
  let d = 0;
  while (j < endIdx) {
    const cur = tokens[j];
    if (cur.type === "punct") {
      const v = cur.value;
      if (v === "{" || v === "(" || v === "[") d++;
      else if (v === "}" || v === ")" || v === "]") {
        if (opts.stopOnCloseAtZero && d === 0) break;
        d--;
        if (!opts.allowNegativeDepth && d < 0) break;
      } else if (d === 0 && (v === "," || (!opts.commaOnly && v === ";"))) {
        break;
      }
    } else if (d === 0 && cur.type === "ident") {
      if (opts.stopOnInOf && (cur.value === "in" || cur.value === "of")) break;
      if (opts.stopOnTopLevelAsi && TOP_LEVEL_DECL_KW.has(cur.value)) {
        const prev = tokens[j - 1];
        if (prev && (prev.type !== "punct" || prev.value === "}" || prev.value === ")" || prev.value === "]")) break;
      }
    }
    j++;
  }
  return j;
}

function findStatementEndWithTokens(source, startCharIdx, cachedTokens) {
  const tokens = cachedTokens || tokenize(source);
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

/**
 * Collect binding names from a JS binding pattern starting at `idx`:
 * identifier, `{ a, b: c = expr, ...rest }`, `[x, y = expr, ...rest]`.
 * Returns next token index after the pattern.
 */
function collectPatternBindings(tokens, idx, outSet) {
  const tok = tokens[idx];
  if (!tok) return idx;
  if (tok.type === "ident") {
    if (!KEYWORDS.has(tok.value)) outSet.add(tok.value);
    return idx + 1;
  }
  if (tok.type === "punct" && tok.value === "{") {
    const close = findMatchingToken(tokens, idx);
    if (close < 0) return idx + 1;
    let j = idx + 1;
    while (j < close) {
      if (tokens[j].type === "punct" && tokens[j].value === ",") { j++; continue; }
      if (tokens[j].type === "punct" && tokens[j].value === "...") {
        j = collectPatternBindings(tokens, j + 1, outSet);
        continue;
      }
      // Property key: either `key: pattern` or shorthand `key` or `key = default`
      if (tokens[j].type === "punct" && tokens[j].value === "[") {
        const cb = findMatchingToken(tokens, j);
        j = cb >= 0 ? cb + 1 : j + 1;
      } else {
        const keyTok = tokens[j];
        if (tokens[j + 1]?.type === "punct" && tokens[j + 1].value === ":") {
          j = collectPatternBindings(tokens, j + 2, outSet);
        } else {
          if (keyTok.type === "ident" && !KEYWORDS.has(keyTok.value)) outSet.add(keyTok.value);
          j++;
        }
      }
      j = skipInitializer(tokens, j, close, { commaOnly: true, allowNegativeDepth: true });
    }
    return close + 1;
  }
  if (tok.type === "punct" && tok.value === "[") {
    const close = findMatchingToken(tokens, idx);
    if (close < 0) return idx + 1;
    let j = idx + 1;
    while (j < close) {
      if (tokens[j].type === "punct" && tokens[j].value === ",") { j++; continue; }
      if (tokens[j].type === "punct" && tokens[j].value === "...") { j++; }
      j = collectPatternBindings(tokens, j, outSet);
      j = skipInitializer(tokens, j, close, { commaOnly: true, allowNegativeDepth: true });
    }
    return close + 1;
  }
  return idx + 1;
}

/**
 * Collect all top-level declared identifier names in a JS/ESM module
 * (imports, function/class declarations, var/let/const declarators including comma lists & destructuring).
 */
function collectTopLevelBindings(sourceOrTokens) {
  const tokens = Array.isArray(sourceOrTokens) ? sourceOrTokens : tokenize(sourceOrTokens);
  const bindings = new Set();

  for (const imp of parseImports(tokens)) {
    for (const s of imp.specifiers) bindings.add(s.local);
  }

  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punct") {
      if (t.value === "{" || t.value === "(" || t.value === "[") depth++;
      else if (t.value === "}" || t.value === ")" || t.value === "]") depth--;
      continue;
    }
    if (depth !== 0 || t.type !== "ident") continue;

    if (t.value === "function") {
      let j = i + 1;
      if (tokens[j]?.type === "punct" && tokens[j].value === "*") j++;
      if (tokens[j]?.type === "ident" && !KEYWORDS.has(tokens[j].value)) {
        bindings.add(tokens[j].value);
      }
    } else if (t.value === "class") {
      if (tokens[i + 1]?.type === "ident" && !KEYWORDS.has(tokens[i + 1].value)) {
        bindings.add(tokens[i + 1].value);
      }
    } else if (t.value === "var" || t.value === "let" || t.value === "const") {
      let j = i + 1;
      while (j < tokens.length) {
        j = collectPatternBindings(tokens, j, bindings);
        j = skipInitializer(tokens, j, tokens.length, { stopOnTopLevelAsi: true });
        if (tokens[j]?.type === "punct" && tokens[j].value === ",") {
          j++;
          continue;
        }
        i = tokens[j]?.type === "punct" && tokens[j].value === ";" ? j : j - 1;
        break;
      }
    }
  }
  return bindings;
}

function markPatternSkipTokens(tokens, idx, limit, skipIndices) {
  const tok = tokens[idx];
  if (!tok || idx >= limit) return idx;
  if (tok.type === "ident") {
    skipIndices.add(idx);
    return idx + 1;
  }
  if (tok.type === "punct" && tok.value === "{") {
    const close = findMatchingToken(tokens, idx);
    if (close < 0 || close >= limit) return idx + 1;
    let j = idx + 1;
    while (j < close) {
      if (tokens[j].type === "punct" && tokens[j].value === ",") { j++; continue; }
      if (tokens[j].type === "punct" && tokens[j].value === "...") {
        j = markPatternSkipTokens(tokens, j + 1, close, skipIndices);
        j = skipInitializer(tokens, j, close, { commaOnly: true, allowNegativeDepth: true });
        continue;
      }
      if (tokens[j].type === "punct" && tokens[j].value === "[") {
        const cb = findMatchingToken(tokens, j);
        j = cb >= 0 ? cb + 1 : j + 1;
        if (tokens[j]?.type === "punct" && tokens[j].value === ":") {
          j = markPatternSkipTokens(tokens, j + 1, close, skipIndices);
        }
      } else if (tokens[j + 1]?.type === "punct" && tokens[j + 1].value === ":") {
        skipIndices.add(j);
        j = markPatternSkipTokens(tokens, j + 2, close, skipIndices);
      } else {
        skipIndices.add(j);
        j++;
      }
      j = skipInitializer(tokens, j, close, { commaOnly: true, allowNegativeDepth: true });
    }
    return close + 1;
  }
  if (tok.type === "punct" && tok.value === "[") {
    const close = findMatchingToken(tokens, idx);
    if (close < 0 || close >= limit) return idx + 1;
    let j = idx + 1;
    while (j < close) {
      if (tokens[j].type === "punct" && tokens[j].value === ",") { j++; continue; }
      if (tokens[j].type === "punct" && tokens[j].value === "...") j++;
      j = markPatternSkipTokens(tokens, j, close, skipIndices);
      j = skipInitializer(tokens, j, close, { commaOnly: true, allowNegativeDepth: true });
    }
    return close + 1;
  }
  return idx + 1;
}

function findStatementEndIdx(tokens, idx, limit) {
  let depth = 0;
  for (let i = idx; i < limit; i++) {
    const t = tokens[i];
    if (t.type === "punct") {
      if (t.value === "(" || t.value === "[" || t.value === "{") depth++;
      else if (t.value === ")" || t.value === "]" || t.value === "}") {
        if (depth === 0) return i;
        depth--;
      } else if (t.value === ";" && depth === 0) return i;
    }
  }
  return limit - 1;
}

function buildMatchMap(tokens) {
  const matchMap = new Int32Array(tokens.length).fill(-1);
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "punct") continue;
    const v = t.value;
    if (v === "(" || v === "{" || v === "[" || v === "${") {
      stack.push({ idx: i, close: v === "(" ? ")" : v === "[" ? "]" : "}" });
    } else if (v === ")" || v === "}" || v === "]") {
      if (stack.length > 0 && stack[stack.length - 1].close === v) {
        const open = stack.pop().idx;
        matchMap[open] = i;
        matchMap[i] = open;
      }
    }
  }
  return matchMap;
}

function findArrowBodyEndIdx(tokens, bodyStart, limit, matchMap) {
  if (tokens[bodyStart]?.type === "punct" && tokens[bodyStart].value === "{") {
    const close = matchMap[bodyStart];
    return close >= bodyStart && close < limit ? close : limit - 1;
  }
  let depth = 0;
  for (let i = bodyStart; i < limit; i++) {
    const t = tokens[i];
    if (t.type === "punct") {
      if (t.value === "(" || t.value === "[" || t.value === "{") depth++;
      else if (t.value === ")" || t.value === "]" || t.value === "}") {
        if (depth === 0) return i - 1;
        depth--;
      } else if ((t.value === "," || t.value === ";") && depth === 0) {
        return i - 1;
      }
    }
  }
  return limit - 1;
}

function findForStatementEndIdx(tokens, openParen, limit, matchMap) {
  const closeParen = matchMap[openParen];
  if (closeParen < 0 || closeParen >= limit) return limit - 1;
  const bodyStart = closeParen + 1;
  if (tokens[bodyStart]?.type === "punct" && tokens[bodyStart].value === "{") {
    const closeBrace = matchMap[bodyStart];
    return closeBrace >= bodyStart && closeBrace < limit ? closeBrace : limit - 1;
  }
  return findStatementEndIdx(tokens, bodyStart, limit);
}

function isFunctionExprPosition(tokens, fnIdx, scopeStart) {
  if (fnIdx <= scopeStart) return false;
  const prev = tokens[fnIdx - 1];
  if (!prev) return false;
  if (prev.type === "ident" && prev.value === "async") {
    return isFunctionExprPosition(tokens, fnIdx - 1, scopeStart);
  }
  if (prev.type === "ident") {
    return REGEX_PRECEDING_KEYWORDS.has(prev.value);
  }
  if (prev.type === "punct") {
    return !["}", ";"].includes(prev.value);
  }
  return false;
}

function isMethodShorthand(tokens, i, limit, matchMap) {
  const t = tokens[i];
  const prev = tokens[i - 1];
  const next = tokens[i + 1];
  if (!t || t.type !== "ident" || KEYWORDS.has(t.value)) return null;
  if (prev?.type === "punct" && (prev.value === "." || prev.value === "?.")) return null;
  if (!next || next.type !== "punct" || next.value !== "(") return null;
  const cp = matchMap[i + 1];
  if (cp < 0 || cp + 1 >= limit) return null;
  if (tokens[cp + 1]?.type !== "punct" || tokens[cp + 1].value !== "{") return null;
  const bodyClose = matchMap[cp + 1];
  if (bodyClose < 0 || bodyClose >= limit) return null;
  const okPrev =
    !prev ||
    (prev.type === "punct" && (prev.value === "{" || prev.value === "," || prev.value === ";" || prev.value === "}")) ||
    (prev.type === "ident" && (prev.value === "get" || prev.value === "set" || prev.value === "async" || prev.value === "static"));
  return okPrev ? { openParen: i + 1, closeParen: cp, bodyOpen: cp + 1, bodyClose } : null;
}

function isIdentRefSkipped(tokens, i, scopeStart, matchMap) {
  const prev = i > scopeStart ? tokens[i - 1] : null;
  const next = tokens[i + 1];
  if (prev?.type === "punct" && (prev.value === "." || prev.value === "?.")) return true;
  if (next?.type === "punct" && next.value === ":") {
    if (prev?.type === "punct" && (prev.value === "{" || prev.value === "," || prev.value === ";" || prev.value === "}")) {
      return true;
    }
    if (!prev) return true;
  }
  const name = tokens[i].value;
  if ((name === "get" || name === "set" || name === "async" || name === "static")
    && (next?.type === "ident" || next?.type === "string" || (next?.type === "punct" && (next.value === "[" || next.value === "*")))
    && (!prev || (prev.type === "punct" && (prev.value === "{" || prev.value === "," || prev.value === ";" || prev.value === "}")))) {
    return true;
  }
  if (next?.type === "punct" && next.value === "(") {
    const cp = matchMap[i + 1];
    if (cp > i + 1 && tokens[cp + 1]?.type === "punct" && tokens[cp + 1].value === "{") {
      if (prev && ((prev.type === "punct" && (prev.value === "{" || prev.value === "," || prev.value === ";" || prev.value === "}")) || (prev.type === "ident" && (prev.value === "get" || prev.value === "set" || prev.value === "async" || prev.value === "static")))) {
        return true;
      }
    }
  }
  if (prev?.type === "ident" && prev.value === "as") return true;
  if (next?.type === "ident" && next.value === "as") return true;
  if (prev?.type === "ident" && (prev.value === "break" || prev.value === "continue")) return true;
  if (prev?.type === "ident" && prev.value === "typeof") return true;
  return false;
}

/**
 * Find undeclared free identifier references inside a JS snippet (such as injected patch code)
 * relative to `outerBindings` (e.g. target module's top-level bindings) + standard globals,
 * enforcing lexical block and function scope isolation (no cross-function declaration leakage).
 */
function findUndeclaredIdentifiers(snippet, outerBindings, extraAllowed = []) {
  const tokens = tokenize(snippet);
  const matchMap = buildMatchMap(tokens);
  const rootNames = new Set([...STANDARD_GLOBALS, ...outerBindings, ...extraAllowed]);
  const rootScope = { names: rootNames, hoist: null, parent: null };
  const undeclared = new Set();
  const skipBindingTokens = new Set();

  function hasInScope(scope, name) {
    for (let s = scope; s; s = s.parent) {
      if (s.names?.has(name) || s.hoist?.has(name)) return true;
    }
    return false;
  }

  function analyzeBlock(start, end, parentScope, extraFuncHoist = null) {
    if (start >= end) return;
    const blockDecls = new Set();
    const funcDecls = extraFuncHoist || new Set();
    let braceDepth = 0;

    // Pass 1: collect bindings scoped to THIS block (plus hoisted var/function into funcDecls without descending into nested functions/classes)
    for (let i = start; i < end; i++) {
      const t = tokens[i];
      if (t.type === "punct") {
        if (t.value === "(") {
          const cp = matchMap[i];
          if (cp > i && cp < end && tokens[cp + 1]?.type === "punct" && tokens[cp + 1].value === "=>") {
            i = findArrowBodyEndIdx(tokens, cp + 2, end, matchMap);
            continue;
          }
        }
        if (t.value === "{" || t.value === "(" || t.value === "[") braceDepth++;
        else if (t.value === "}" || t.value === ")" || t.value === "]") braceDepth = Math.max(0, braceDepth - 1);
        continue;
      }
      if (t.type !== "ident") continue;

      if (tokens[i + 1]?.type === "punct" && tokens[i + 1].value === "=>" && tokens[i - 1]?.value !== "." && tokens[i - 1]?.value !== "?.") {
        i = findArrowBodyEndIdx(tokens, i + 2, end, matchMap);
        continue;
      }

      if (t.value === "function") {
        const isExpr = isFunctionExprPosition(tokens, i, start);
        let j = i + 1;
        if (tokens[j]?.type === "punct" && tokens[j].value === "*") j++;
        if (tokens[j]?.type === "ident" && !KEYWORDS.has(tokens[j].value)) {
          if (!isExpr && braceDepth === 0) funcDecls.add(tokens[j].value);
          j++;
        }
        if (tokens[j]?.type === "punct" && tokens[j].value === "(") {
          const cp = matchMap[j];
          if (cp > j && tokens[cp + 1]?.type === "punct" && tokens[cp + 1].value === "{") {
            const cb = matchMap[cp + 1];
            if (cb > cp + 1 && cb < end) {
              i = cb;
              continue;
            }
          }
        }
      } else if (t.value === "class") {
        if (braceDepth === 0 && !isFunctionExprPosition(tokens, i, start) && tokens[i + 1]?.type === "ident" && !KEYWORDS.has(tokens[i + 1].value)) {
          blockDecls.add(tokens[i + 1].value);
        }
        let j = i + 1;
        while (j < end && !(tokens[j].type === "punct" && tokens[j].value === "{")) j++;
        if (j < end) {
          const cb = matchMap[j];
          if (cb >= j && cb < end) {
            i = cb;
            continue;
          }
        }
      } else if (t.value === "var") {
        let j = i + 1;
        while (j < end) {
          const before = j;
          j = collectPatternBindings(tokens, j, funcDecls);
          markPatternSkipTokens(tokens, before, end, skipBindingTokens);
          j = skipInitializer(tokens, j, end, { stopOnCloseAtZero: true, stopOnInOf: true });
          if (tokens[j]?.type === "punct" && tokens[j].value === ",") { j++; continue; }
          break;
        }
      } else if ((t.value === "let" || t.value === "const") && braceDepth === 0) {
        const prevTok = tokens[i - 1];
        const inForHeader = prevTok?.type === "punct" && prevTok.value === "(" && tokens[i - 2]?.type === "ident" && tokens[i - 2].value === "for";
        if (!inForHeader) {
          let j = i + 1;
          while (j < end) {
            const before = j;
            j = collectPatternBindings(tokens, j, blockDecls);
            markPatternSkipTokens(tokens, before, end, skipBindingTokens);
            j = skipInitializer(tokens, j, end, { stopOnCloseAtZero: true, stopOnInOf: true });
            if (tokens[j]?.type === "punct" && tokens[j].value === ",") { j++; continue; }
            break;
          }
        }
      } else if (t.value === "for" && braceDepth === 0 && tokens[i + 1]?.type === "punct" && tokens[i + 1].value === "(") {
        const endFor = findForStatementEndIdx(tokens, i + 1, end, matchMap);
        if (endFor > i) i = endFor;
      } else if (t.value === "catch" && braceDepth === 0) {
        let j = i + 1;
        if (tokens[j]?.type === "punct" && tokens[j].value === "(") {
          const cp = matchMap[j];
          if (cp > j) j = cp + 1;
        }
        if (tokens[j]?.type === "punct" && tokens[j].value === "{") {
          const cb = matchMap[j];
          if (cb >= j && cb < end) i = cb;
        }
      } else {
        const m = isMethodShorthand(tokens, i, end, matchMap);
        if (m) {
          i = m.bodyClose;
          continue;
        }
      }
    }

    const thisScope = (blockDecls.size > 0 || (!extraFuncHoist && funcDecls.size > 0))
      ? { names: blockDecls, hoist: extraFuncHoist ? null : funcDecls, parent: parentScope }
      : parentScope;

    // Pass 2: walk THIS block's tokens, descending with isolated scopes into functions/arrows/loops/blocks
    for (let i = start; i < end; i++) {
      const t = tokens[i];

      if (t.type === "ident" && t.value === "function") {
        let j = i + 1;
        if (tokens[j]?.type === "punct" && tokens[j].value === "*") j++;
        let fnSelfName = null;
        if (tokens[j]?.type === "ident" && !KEYWORDS.has(tokens[j].value)) {
          fnSelfName = tokens[j].value;
          j++;
        }
        if (tokens[j]?.type === "punct" && tokens[j].value === "(") {
          const cp = matchMap[j];
          if (cp > j && tokens[cp + 1]?.type === "punct" && tokens[cp + 1].value === "{") {
            const cb = matchMap[cp + 1];
            if (cb > cp + 1 && cb < end) {
              const fnParams = new Set();
              if (fnSelfName) fnParams.add(fnSelfName);
              collectParamList(tokens, j + 1, cp, fnParams);
              markPatternSkipTokens(tokens, j + 1, cp, skipBindingTokens);
              const fnHoist = new Set();
              const fnScope = { names: fnParams, hoist: fnHoist, parent: thisScope };
              analyzeBlock(j + 1, cp, fnScope, fnHoist);
              analyzeBlock(cp + 2, cb, fnScope, fnHoist);
              i = cb;
              continue;
            }
          }
        }
      }

      if (t.type === "ident" && tokens[i + 1]?.type === "punct" && tokens[i + 1].value === "=>" && tokens[i - 1]?.value !== "." && tokens[i - 1]?.value !== "?.") {
        const bodyStart = i + 2;
        const bodyEnd = findArrowBodyEndIdx(tokens, bodyStart, end, matchMap);
        const arrowHoist = new Set();
        const arrowParams = KEYWORDS.has(t.value) ? null : new Set([t.value]);
        const arrowScope = { names: arrowParams, hoist: arrowHoist, parent: thisScope };
        if (tokens[bodyStart]?.type === "punct" && tokens[bodyStart].value === "{") {
          analyzeBlock(bodyStart + 1, bodyEnd, arrowScope, arrowHoist);
        } else {
          analyzeBlock(bodyStart, bodyEnd + 1, arrowScope, arrowHoist);
        }
        i = bodyEnd;
        continue;
      }

      if (t.type === "punct" && t.value === "(") {
        const cp = matchMap[i];
        if (cp > i && cp < end && tokens[cp + 1]?.type === "punct" && tokens[cp + 1].value === "=>") {
          const fnParams = new Set();
          collectParamList(tokens, i + 1, cp, fnParams);
          let p = i + 1;
          while (p < cp) {
            if (tokens[p].type === "punct" && tokens[p].value === ",") { p++; continue; }
            if (tokens[p].type === "punct" && tokens[p].value === "...") p++;
            p = markPatternSkipTokens(tokens, p, cp, skipBindingTokens);
            p = skipInitializer(tokens, p, cp, { commaOnly: true, allowNegativeDepth: true });
          }
          const arrowHoist = new Set();
          const arrowScope = { names: fnParams, hoist: arrowHoist, parent: thisScope };
          analyzeBlock(i + 1, cp, arrowScope, arrowHoist);
          const bodyStart = cp + 2;
          const bodyEnd = findArrowBodyEndIdx(tokens, bodyStart, end, matchMap);
          if (tokens[bodyStart]?.type === "punct" && tokens[bodyStart].value === "{") {
            analyzeBlock(bodyStart + 1, bodyEnd, arrowScope, arrowHoist);
          } else {
            analyzeBlock(bodyStart, bodyEnd + 1, arrowScope, arrowHoist);
          }
          i = bodyEnd;
          continue;
        }
      }

      const method = isMethodShorthand(tokens, i, end, matchMap);
      if (method) {
        const fnParams = new Set();
        collectParamList(tokens, method.openParen + 1, method.closeParen, fnParams);
        let p = method.openParen + 1;
        while (p < method.closeParen) {
          if (tokens[p].type === "punct" && tokens[p].value === ",") { p++; continue; }
          if (tokens[p].type === "punct" && tokens[p].value === "...") p++;
          p = markPatternSkipTokens(tokens, p, method.closeParen, skipBindingTokens);
          p = skipInitializer(tokens, p, method.closeParen, { commaOnly: true, allowNegativeDepth: true });
        }
        const mHoist = new Set();
        const mScope = { names: fnParams, hoist: mHoist, parent: thisScope };
        analyzeBlock(method.openParen + 1, method.closeParen, mScope, mHoist);
        analyzeBlock(method.bodyOpen + 1, method.bodyClose, mScope, mHoist);
        i = method.bodyClose;
        continue;
      }

      if (t.type === "ident" && t.value === "for" && tokens[i + 1]?.type === "punct" && tokens[i + 1].value === "(") {
        const cp = matchMap[i + 1];
        const endFor = findForStatementEndIdx(tokens, i + 1, end, matchMap);
        if (cp > i + 1 && endFor >= cp) {
          const loopBindings = new Set();
          if (tokens[i + 2]?.type === "ident" && (tokens[i + 2].value === "let" || tokens[i + 2].value === "const" || tokens[i + 2].value === "var")) {
            let j = i + 3;
            while (j < cp) {
              const before = j;
              j = collectPatternBindings(tokens, j, tokens[i + 2].value === "var" ? funcDecls : loopBindings);
              markPatternSkipTokens(tokens, before, cp, skipBindingTokens);
              j = skipInitializer(tokens, j, cp, { stopOnCloseAtZero: true, stopOnInOf: true });
              if (tokens[j]?.type === "punct" && tokens[j].value === ",") { j++; continue; }
              break;
            }
          }
          const loopScope = loopBindings.size > 0 ? { names: loopBindings, hoist: null, parent: thisScope } : thisScope;
          analyzeBlock(i + 2, cp, loopScope, funcDecls);
          if (tokens[cp + 1]?.type === "punct" && tokens[cp + 1].value === "{") {
            analyzeBlock(cp + 2, endFor, loopScope, funcDecls);
          } else {
            analyzeBlock(cp + 1, endFor + 1, loopScope, funcDecls);
          }
          i = endFor;
          continue;
        }
      }

      if (t.type === "ident" && t.value === "catch") {
        let j = i + 1;
        const catchBindings = new Set();
        if (tokens[j]?.type === "punct" && tokens[j].value === "(") {
          const cp = matchMap[j];
          if (cp > j) {
            collectPatternBindings(tokens, j + 1, catchBindings);
            markPatternSkipTokens(tokens, j + 1, cp, skipBindingTokens);
            j = cp + 1;
          }
        }
        if (tokens[j]?.type === "punct" && tokens[j].value === "{") {
          const cb = matchMap[j];
          if (cb >= j && cb < end) {
            const catchScope = catchBindings.size > 0 ? { names: catchBindings, hoist: null, parent: thisScope } : thisScope;
            analyzeBlock(j + 1, cb, catchScope, funcDecls);
            i = cb;
            continue;
          }
        }
      }

      if (t.type === "ident" && t.value === "import") {
        while (i + 1 < end && !(tokens[i].type === "punct" && tokens[i].value === ";") && !(tokens[i].type === "ident" && tokens[i].value === "from")) {
          i++;
        }
        if (tokens[i]?.type === "ident" && tokens[i].value === "from") i++;
        continue;
      }

      if (t.type === "punct" && t.value === "{") {
        const cb = matchMap[i];
        if (cb >= i && cb < end) {
          analyzeBlock(i + 1, cb, thisScope, funcDecls);
          i = cb;
          continue;
        }
      }

      if (t.type !== "ident" || skipBindingTokens.has(i)) continue;
      const name = t.value;
      if (KEYWORDS.has(name) || hasInScope(thisScope, name)) continue;
      if (isIdentRefSkipped(tokens, i, start, matchMap)) continue;
      undeclared.add(name);
    }
  }

  analyzeBlock(0, tokens.length, rootScope, null);
  return [...undeclared];
}

function collectParamList(tokens, startIdx, endIdx, outSet) {
  let j = startIdx;
  while (j < endIdx) {
    if (tokens[j].type === "punct" && tokens[j].value === ",") { j++; continue; }
    if (tokens[j].type === "punct" && tokens[j].value === "...") { j++; }
    j = collectPatternBindings(tokens, j, outSet);
    j = skipInitializer(tokens, j, endIdx, { commaOnly: true, allowNegativeDepth: true });
  }
}

/**
 * Find all top-level `function name(...) { ... }` declarations in source.
 * Returns array of { name, start, end, bodyStart, bodyEnd, paramsStart, paramsEnd }.
 */
function findTopLevelFunctions(source, cachedTokens) {
  const tokens = cachedTokens || tokenize(source);
  const fns = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punct") {
      if (t.value === "{" || t.value === "(" || t.value === "[") depth++;
      else if (t.value === "}" || t.value === ")" || t.value === "]") depth--;
      continue;
    }
    if (depth !== 0 || t.type !== "ident" || t.value !== "function") continue;
    let j = i + 1;
    if (tokens[j]?.type === "punct" && tokens[j].value === "*") j++;
    const nameTok = tokens[j];
    if (!nameTok || nameTok.type !== "ident") continue;
    const openParen = j + 1;
    if (tokens[openParen]?.type !== "punct" || tokens[openParen].value !== "(") continue;
    const closeParen = findMatchingToken(tokens, openParen);
    if (closeParen < 0) continue;
    const openBrace = closeParen + 1;
    if (tokens[openBrace]?.type !== "punct" || tokens[openBrace].value !== "{") continue;
    const closeBrace = findMatchingToken(tokens, openBrace);
    if (closeBrace < 0) continue;
    fns.push({
      name: nameTok.value,
      start: t.start,
      end: tokens[closeBrace].end,
      paramsStart: tokens[openParen].start,
      paramsEnd: tokens[closeParen].end,
      bodyStart: tokens[openBrace].start,
      bodyEnd: tokens[closeBrace].end,
    });
    i = closeBrace;
  }
  return fns;
}

/**
 * Find a single top-level function matching `predicate(fnInfo, fnSource)`.
 * Throws if 0 or >1 match (fail-closed).
 */
function findUniqueFunction(source, predicate, label, cachedTokens) {
  const fns = findTopLevelFunctions(source, cachedTokens);
  const matches = [];
  for (const fn of fns) {
    const fnSource = source.slice(fn.start, fn.end);
    if (predicate(fn, fnSource)) matches.push({ ...fn, source: fnSource });
  }
  assert.equal(matches.length, 1, `Could not uniquely locate function ${label} (found ${matches.length})`);
  return matches[0];
}

/**
 * Find the innermost `function ...(...) { ... }` (declaration or expression, including memo-wrapped)
 * containing `charPos`.
 */
function findEnclosingFunction(source, charPos, cachedTokens) {
  const tokens = cachedTokens || tokenize(source);
  let best = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.start > charPos) break;
    if (t.type !== "ident" || t.value !== "function") continue;
    let j = i + 1;
    if (tokens[j]?.type === "punct" && tokens[j].value === "*") j++;
    let name = null;
    if (tokens[j]?.type === "ident") {
      name = tokens[j].value;
      j++;
    }
    if (tokens[j]?.type !== "punct" || tokens[j].value !== "(") continue;
    const closeParen = findMatchingToken(tokens, j);
    if (closeParen < 0) continue;
    const openBrace = closeParen + 1;
    if (tokens[openBrace]?.type !== "punct" || tokens[openBrace].value !== "{") continue;
    const closeBrace = findMatchingToken(tokens, openBrace);
    if (closeBrace < 0) continue;
    const start = t.start;
    const end = tokens[closeBrace].end;
    if (start <= charPos && charPos <= end) {
      if (!best || (end - start) < (best.end - best.start)) {
        best = {
          name,
          start,
          end,
          paramsStart: tokens[j].start,
          paramsEnd: tokens[closeParen].end,
          bodyStart: tokens[openBrace].start,
          bodyEnd: tokens[closeBrace].end,
          source: source.slice(start, end),
        };
      }
    }
  }
  return best;
}

/**
 * Dynamically allocate fresh React Compiler memo slots in a function source containing
 * `let t=(0,Q.c)(N)` (with any local cache variable name and compiler import name).
 * Returns `{ source, cacheVar, startSlot, slots, oldCount, newCount }`.
 */
function allocateMemoSlots(fnSource, count) {
  const m = fnSource.match(/\blet\s+([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\((\d+)\)/);
  assert(m, "Could not locate React Compiler memo cache initialization `(0,X.c)(N)`");
  const cacheVar = m[1];
  const compilerVar = m[2];
  const oldCount = Number(m[3]);
  const newCount = oldCount + count;
  const slots = Array.from({ length: count }, (_, idx) => oldCount + idx);
  const updated = fnSource.slice(0, m.index) +
    `let ${cacheVar}=(0,${compilerVar}.c)(${newCount})` +
    fnSource.slice(m.index + m[0].length);
  return { source: updated, cacheVar, compilerVar, startSlot: oldCount, slots, oldCount, newCount };
}

/**
 * Return the exact source snippet of a top-level declaration (`function name(...) { ... }`,
 * `class name ... { ... }`, or `var/let/const ... name = <expr>`) in `source`.
 */
function getTopLevelDeclSource(source, name, cachedTokens) {
  const tokens = cachedTokens || tokenize(source);
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punct") {
      if (t.value === "{" || t.value === "(" || t.value === "[") depth++;
      else if (t.value === "}" || t.value === ")" || t.value === "]") depth--;
      continue;
    }
    if (depth !== 0 || t.type !== "ident") continue;
    if (t.value === "function") {
      let j = i + 1;
      if (tokens[j]?.type === "punct" && tokens[j].value === "*") j++;
      if (tokens[j]?.type === "ident" && tokens[j].value === name) {
        const op = j + 1;
        const cp = tokens[op]?.value === "(" ? findMatchingToken(tokens, op) : -1;
        const ob = cp > op && tokens[cp + 1]?.value === "{" ? cp + 1 : -1;
        const cb = ob > cp ? findMatchingToken(tokens, ob) : -1;
        if (cb > ob) return source.slice(t.start, tokens[cb].end);
      }
    } else if (t.value === "class" && tokens[i + 1]?.type === "ident" && tokens[i + 1].value === name) {
      let j = i + 2;
      while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].value === "{")) j++;
      const cb = j < tokens.length ? findMatchingToken(tokens, j) : -1;
      if (cb > j) return source.slice(t.start, tokens[cb].end);
    } else if (t.value === "var" || t.value === "let" || t.value === "const") {
      let j = i + 1;
      while (j < tokens.length) {
        const declStart = tokens[j]?.start;
        const matched = tokens[j]?.type === "ident" && tokens[j].value === name;
        const tmp = new Set();
        j = collectPatternBindings(tokens, j, tmp);
        j = skipInitializer(tokens, j, tokens.length, { stopOnCloseAtZero: true, stopOnTopLevelAsi: true });
        const declEnd = tokens[j - 1]?.end ?? declStart;
        if (matched || tmp.has(name)) {
          return source.slice(declStart, declEnd);
        }
        if (tokens[j]?.type === "punct" && tokens[j].value === ",") {
          j++;
          continue;
        }
        break;
      }
    }
  }
  return "";
}

/**
 * Build a Map<name, sourceSnippet> for every top-level declaration in `source` in a single pass.
 * Keeps the first declaration for each name to match `getTopLevelDeclSource()`.
 */
function indexTopLevelDecls(source, cachedTokens) {
  const tokens = cachedTokens || tokenize(source);
  const map = new Map();
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punct") {
      if (t.value === "{" || t.value === "(" || t.value === "[") depth++;
      else if (t.value === "}" || t.value === ")" || t.value === "]") depth--;
      continue;
    }
    if (depth !== 0 || t.type !== "ident") continue;
    if (t.value === "function") {
      let j = i + 1;
      if (tokens[j]?.type === "punct" && tokens[j].value === "*") j++;
      if (tokens[j]?.type === "ident") {
        const name = tokens[j].value;
        const op = j + 1;
        const cp = tokens[op]?.value === "(" ? findMatchingToken(tokens, op) : -1;
        const ob = cp > op && tokens[cp + 1]?.value === "{" ? cp + 1 : -1;
        const cb = ob > cp ? findMatchingToken(tokens, ob) : -1;
        if (cb > ob) {
          if (!map.has(name)) map.set(name, source.slice(t.start, tokens[cb].end));
          i = cb;
        }
      }
    } else if (t.value === "class" && tokens[i + 1]?.type === "ident") {
      const name = tokens[i + 1].value;
      let j = i + 2;
      while (j < tokens.length && !(tokens[j].type === "punct" && tokens[j].value === "{")) j++;
      const cb = j < tokens.length ? findMatchingToken(tokens, j) : -1;
      if (cb > j) {
        if (!map.has(name)) map.set(name, source.slice(t.start, tokens[cb].end));
        i = cb;
      }
    } else if (t.value === "var" || t.value === "let" || t.value === "const") {
      let j = i + 1;
      while (j < tokens.length) {
        const declStart = tokens[j]?.start;
        const tmp = new Set();
        if (tokens[j]?.type === "ident") tmp.add(tokens[j].value);
        j = collectPatternBindings(tokens, j, tmp);
        j = skipInitializer(tokens, j, tokens.length, { stopOnCloseAtZero: true, stopOnTopLevelAsi: true });
        const declEnd = tokens[j - 1]?.end ?? declStart;
        if (tmp.size > 0 && declStart !== undefined && declEnd !== undefined) {
          const snippet = source.slice(declStart, declEnd);
          for (const binding of tmp) {
            if (!map.has(binding)) map.set(binding, snippet);
          }
        }
        if (tokens[j]?.type === "punct" && tokens[j].value === ",") {
          j++;
          continue;
        }
        break;
      }
      i = Math.max(i, j - 1);
    }
  }
  return map;
}

module.exports = {
  KEYWORDS,
  STANDARD_GLOBALS,
  tokenize,
  unquote,
  findMatchingToken,
  findMatchingChar,
  findStatementEndWithTokens,
  parseImports,
  parseExports,
  collectTopLevelBindings,
  findUndeclaredIdentifiers,
  findTopLevelFunctions,
  findUniqueFunction,
  findEnclosingFunction,
  allocateMemoSlots,
  getTopLevelDeclSource,
  indexTopLevelDecls,
};

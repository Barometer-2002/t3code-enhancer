"use strict";

const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { getArchiveTargetPaths } = require("../lib/engine.cjs");

const repo = path.join(__dirname, "..");
const archive = getArchiveTargetPaths()[0].source;
const electron = process.env.T3E_ELECTRON || path.join(path.dirname(archive), "..", "T3 Code (Beta).exe");
const chrome = process.env.T3E_CHROME || path.join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe");

async function availablePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function until(label, test) {
  const end = Date.now() + 30000;
  do {
    if (await test()) return;
    await delay(120);
  } while (Date.now() < end);
  throw new Error("Timed out: " + label);
}

// Chrome's debugging pipe carries NUL-delimited UTF-8 JSON on descriptors 3/4.
function connect(browser, errors) {
  let serial = 0, buffer = Buffer.alloc(0);
  const pending = new Map();
  browser.stdio[4].on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(0)) >= 0) {
      const message = JSON.parse(buffer.toString("utf8", 0, end));
      buffer = buffer.subarray(end + 1);
      pending.get(message.id)?.(message);
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.className || message.params.exceptionDetails.text);
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args[0]?.value || "console.error");
    }
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Chrome timeout: " + method)); }, 15000);
    pending.set(id, message => {
      clearTimeout(timeout);
      pending.delete(id);
      if (message.error) reject(new Error(method + ": " + message.error.message));
      else resolve(message.result);
    });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}

async function run() {
  for (const file of [electron, chrome, archive]) assert(fs.existsSync(file), "Missing " + file);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3e-e2e-"));
  const processes = [];
  function launch(exe, args, options) {
    const child = spawn(exe, args, { windowsHide: true, ...options });
    processes.push(child);
    return child;
  }
  try {
    const copy = path.join(root, "server.asar");
    const built = execFileSync(process.execPath, [path.join(repo, "cli.cjs"), "build", copy, "--asar", archive, "--preset", "full"], { encoding: "utf8" });
    console.log("Built isolated T3 Code", JSON.parse(built).appVersion);
    if (fs.existsSync(archive + ".unpacked")) fs.cpSync(archive + ".unpacked", copy + ".unpacked", { recursive: true });
    const home = path.join(root, "home");
    const themes = path.join(home, "userdata", "themes");
    const project = path.join(root, "project");
    fs.mkdirSync(themes, { recursive: true });
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "sample-e2e.txt"), "hello t3code-enhancer\n");
    fs.copyFileSync(path.join(repo, "themes", "chatgpt-app.json"), path.join(themes, "chatgpt-app.json"));
    fs.writeFileSync(path.join(themes, "..", "environment-id"), randomUUID() + "\n");
    const port = await availablePort();
    const origin = "http://127.0.0.1:" + port;
    const bin = path.join(copy, "apps/server/dist/bin.mjs");
    // Start with the OS essentials. A developer shell can carry real provider
    // tokens, gateway endpoints and a T3 parent session in its environment.
    const env = {};
    for (const key of ["SystemRoot", "ComSpec", "WINDIR", "TEMP", "TMP", "LANG"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { PATH: path.join(process.env.SystemRoot, "System32"), USERPROFILE: home, HOME: home,
      LOCALAPPDATA: path.join(home, "local"), APPDATA: path.join(home, "roaming"),
      CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      ELECTRON_RUN_AS_NODE: "1", T3CODE_HOME: home, T3CODE_HOST: "127.0.0.1", T3CODE_PORT: String(port),
      T3CODE_NO_BROWSER: "1", T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "1", T3CODE_TELEMETRY_ENABLED: "false", T3CODE_OTEL_SDK_DISABLED: "true" });
    const server = launch(electron, [bin, "--base-dir", home, "--host", "127.0.0.1", "--port", String(port)], { cwd: project, env, stdio: ["ignore","ignore","pipe"] });
    let stderr = "";
    server.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
    await until("isolated server", async () => {
      assert.equal(server.exitCode, null, "Isolated server exited: " + stderr.replace(/https?:\/\/\S+/g, "[URL]"));
      return fetch(origin, { signal: AbortSignal.timeout(1200) }).then(r => r.ok, () => false);
    });
    const pairing = execFileSync(electron, [bin, "pair", "--base-dir", home], { cwd: project, env, encoding: "utf8", timeout: 20000 });
    const url = pairing.match(/http:\/\/(?:localhost|127\.0\.0\.1):\d+\/\S+/g)?.find(s => /pair|token/i.test(s));
    assert(url && Number(new URL(url).port) === port, "Missing isolated pairing URL");
    const browser = launch(chrome, ["--headless=new", "--lang=en-US", "--disable-gpu", "--no-first-run", "--disable-background-networking",
      "--remote-debugging-pipe", "--user-data-dir=" + path.join(root, "chrome"), "about:blank"], { stdio: ["ignore","ignore","ignore","pipe","pipe"] });
    const errors = [];
    const send = connect(browser, errors);
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, args) => send(method, args, sessionId);
    const evaluate = async expression => {
      const result = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await page("Runtime.enable");
    await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page("Page.navigate", { url });
    await until("sidebar", () => evaluate("!!document.querySelector('.t3e-new-chat-btn')"));
    await evaluate("document.querySelector('.t3e-new-chat-btn').click()");
    await until("new chat", () => evaluate("!!document.querySelector('.t3e-nc-hero-icon')"));
    await checkWorkspace(evaluate, page);
    assert.deepEqual(errors, [], "Browser errors: " + errors.join(", "));
  } finally {
    for (const child of processes.reverse()) {
      if (child.exitCode !== null || child.signalCode) continue;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}

async function checkWorkspace(evaluate, page) {
  const ids = [null, "t3-chat", "grove", "ocean", "ember", "iris", "chatgpt-app"];
  const rect = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().toJSON()`);
  async function click(selector) {
    const box = await rect(selector);
    assert(box?.width && box.height, "Missing button " + selector);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    assert(await evaluate(`document.elementFromPoint(${point.x},${point.y})?.closest(${JSON.stringify(selector)}) != null`), "Covered button " + selector);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    }
  }
  async function theme(id, mode) {
    await evaluate(`(() => {
      localStorage.removeItem("t3code:theme-halves:v1");
      localStorage.setItem("t3code:theme", ${JSON.stringify(id || mode)});
      localStorage.setItem("t3code:theme-appearance-mode", ${JSON.stringify(mode)});
      window.dispatchEvent(new StorageEvent("storage", {key:"t3code:theme"}));
    })()`);
    await until("theme " + id + " " + mode, () => evaluate(`(document.documentElement.dataset.themeId || null) === ${JSON.stringify(id)} && document.documentElement.classList.contains("dark") === ${mode === "dark"}`));
  }
  async function clearance(selector, label) {
    const box = await rect(selector);
    const viewportWidth = await evaluate("innerWidth");
    assert(box?.width > 0 && box.height > 0 && box.left >= -1 && box.right <= viewportWidth + 1 &&
      (box.top >= 33 || box.right <= viewportWidth - 144 + 1),
      label + " toolbar overlaps simulated title buttons: " + JSON.stringify(box));
  }
  // Chromium renders the web branch. Supply the two layout hooks Electron adds
  // to its document and headers, including headers mounted after a panel opens.
  await evaluate(`(() => {
    const root = document.documentElement;
    root.classList.add("wco");
    root.style.setProperty("--workspace-native-controls-inset", "144px");
    const markHeaders = () => document.querySelectorAll("[data-chat-header],[data-right-panel-tabbar]").forEach(h => h.classList.add("drag-region"));
    markHeaders();
    new MutationObserver(markHeaders).observe(root, {subtree:true,childList:true});
  })()`);
  const chat = "[data-chat-header] .t3e-chat-toolbar";
  const panel = "[data-right-panel-tabbar] .t3e-chat-toolbar";
  async function dismissProviderWarning() {
    const dismiss = '[aria-label="Dismiss Codex provider warning"]';
    if ((await rect(dismiss))?.width) await click(dismiss);
  }
  async function capture(name, { dismissBanner = true } = {}) {
    if (!process.env.T3E_SCREENSHOTS) return;
    if (dismissBanner) await dismissProviderWarning();
    await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 300 });
    fs.mkdirSync(process.env.T3E_SCREENSHOTS, { recursive: true });
    const { data } = await page("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(process.env.T3E_SCREENSHOTS, name + ".png"), Buffer.from(data, "base64"));
  }
  async function matrix(layout) {
    for (const id of ids) for (const mode of ["light", "dark"]) {
      await theme(id, mode);
      const label = [layout, id || "default", mode].join("-");
      if (layout === "single") {
        const icon = await rect(".t3e-nc-hero-icon");
        assert(icon?.width > 0 && icon.width <= 64 && icon.width === icon.height, label + " hero size");
        const search = await rect(".t3e-sb-search-box");
        const actions = await rect(".t3e-sb-actions");
        assert(search?.width && actions?.width && search.right <= actions.left + 1 && actions.top < search.bottom && search.top < actions.bottom, label + " sidebar row");
        const button = await rect(".t3e-new-chat-btn");
        assert(button?.height >= 20 && button.height <= 48, label + " sidebar button");
        const tray = await rect(".t3e-nc-tray");
        const host = await rect('[data-slot="composer-host"]');
        assert(
          tray && host && Math.abs(tray.bottom - host.top) <= 1.5,
          label + " new-chat tray must sit flush on composer top without bleeding behind glass: " + JSON.stringify({ trayBottom: tray?.bottom, hostTop: host?.top })
        );
      } else {
        const pill = await rect('.t3e-new-tab-pill[data-active-tab="true"]');
        const cards = await evaluate("Array.from(document.querySelectorAll('.t3e-launcher-card')).slice(0,2).map(b=>b.getBoundingClientRect().toJSON())");
        assert(pill?.height >= 20 && pill.height <= 40 && cards.length === 2 && Math.abs(cards[0].top - cards[1].top) < 2 && cards[0].right <= cards[1].left + 1, label + " launcher layout");
      }
      await clearance(layout === "single" ? chat : panel, label);
      const badIcons = await evaluate(`Array.from(document.querySelectorAll('svg[class*="t3e-"], [class^="t3e-"] svg'))
        .filter(svg => { const r = svg.getBoundingClientRect(); return r.width > 64 || r.height > 64; })
        .map(svg => svg.getAttribute("class"))`);
      assert.deepEqual(badIcons, [], label + " oversized icons");
      if (id === "ocean" && mode === "dark" || id === "chatgpt-app" && mode === "light") await capture(label);
    }
    console.log(layout + ": 14 theme/appearance combinations passed");
  }
  await matrix("single");
  // Regression #9: clicking '+' attachment menu and permissions button on /draft must open cleanly with zero runtime errors
  await dismissProviderWarning();
  await theme("chatgpt-app", "light");
  await click(".t3e-plus-btn");
  await until("plus menu panel", () => evaluate("!!document.querySelector('.t3e-plus-panel')"));
  await until("plus menu settled", () => evaluate(`(() => {
    const p = document.querySelector('[data-slot="popover-popup"]:has(.t3e-plus-panel)');
    return !!p && parseFloat(getComputedStyle(p).opacity) >= 0.99;
  })()`));
  await capture("composer-plus-menu-chatgpt-app-light", { dismissBanner: false });
  await page("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until("plus menu closed", () => evaluate("!document.querySelector('.t3e-plus-panel')"));
  await click(".t3e-perm-btn");
  await until("permissions popover", () => evaluate("!!document.querySelector('.t3e-perm-card')"));
  await page("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until("permissions popover closed", () => evaluate("!document.querySelector('.t3e-perm-card')"));
  // Also verify '+' menu in Ocean dark translucent theme (no glass bleed / contrast issues)
  await dismissProviderWarning();
  await theme("ocean", "dark");
  await click(".t3e-plus-btn");
  await until("ocean dark plus menu panel", () => evaluate("!!document.querySelector('.t3e-plus-panel')"));
  await until("ocean dark plus menu settled", () => evaluate(`(() => {
    const p = document.querySelector('[data-slot="popover-popup"]:has(.t3e-plus-panel)');
    return !!p && parseFloat(getComputedStyle(p).opacity) >= 0.99;
  })()`));
  await capture("composer-plus-menu-ocean-dark", { dismissBanner: false });
  await page("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until("ocean dark plus menu closed", () => evaluate("!document.querySelector('.t3e-plus-panel')"));
  console.log("Composer '+' menu and permissions popover passed");
  await theme("ocean", "dark");
  await click('[aria-label="Toggle right panel"]');
  await until("right panel", () => evaluate("!!document.querySelector('[data-right-panel-tabbar]')"));
  if (!await rect(".t3e-launcher-grid")) await click(".t3e-new-tab-add");
  await until("launcher", () => evaluate("!!document.querySelector('.t3e-launcher-card')"));
  await matrix("split");
  // Regression: FilePreviewPanel breadcrumb pill must be left-aligned (not centered with empty left gap)
  await theme("chatgpt-app", "light");
  const filesCardInfo = await evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll(".t3e-launcher-card")).map((el) => ({
      kbd: el.querySelector(".t3e-launcher-card-kbd")?.textContent?.trim() || "",
      label: el.querySelector(".t3e-launcher-card-label")?.textContent?.trim() || "",
      disabled: !!el.disabled,
    }));
    const card = Array.from(document.querySelectorAll(".t3e-launcher-card"))
      .find((el) => el.querySelector(".t3e-launcher-card-kbd")?.textContent?.trim() === "F");
    if (card && !card.disabled) card.click();
    return { found: !!card, disabled: !!card?.disabled, cards };
  })()`);
  assert(filesCardInfo.found && !filesCardInfo.disabled, "Missing/disabled Files launcher card: " + JSON.stringify(filesCardInfo));
  await until("file browser panel", () => evaluate("!!document.querySelector('[data-file-browser-panel]') || !!document.querySelector('[data-file-breadcrumbs]')"));
  const findSampleBox = () => evaluate(`(() => {
    const walk = (root) => {
      const hit = root.querySelector('[role="treeitem"][data-item-path*="sample-e2e.txt"]');
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          const inner = walk(el.shadowRoot);
          if (inner) return inner;
        }
      }
      return null;
    };
    const host = document.querySelector("[data-file-browser-panel]") || document;
    const item = walk(host);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  })()`);
  if (!await evaluate("!!document.querySelector('[data-file-breadcrumbs]')")) {
    let pt = null;
    await until("file tree item", async () => { pt = await findSampleBox(); return !!pt; });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page("Input.dispatchMouseEvent", { type, ...pt, button: "left", clickCount: 1 });
    }
  }
  await until("file preview breadcrumbs", () => evaluate("!!document.querySelector('[data-file-breadcrumbs]')"));
  const crumbAlign = await evaluate(`(() => {
    const sub = document.querySelector("[data-surface-subheader]:has([data-file-breadcrumbs])")?.getBoundingClientRect();
    const crumb = document.querySelector("[data-file-breadcrumbs]")?.getBoundingClientRect();
    if (!sub || !crumb) return null;
    return { subLeft: sub.left, crumbLeft: crumb.left, gapLeft: crumb.left - sub.left, crumbRight: crumb.right, subRight: sub.right };
  })()`);
  assert(crumbAlign && crumbAlign.gapLeft >= 0 && crumbAlign.gapLeft <= 24, "File breadcrumbs must stay left-aligned: " + JSON.stringify(crumbAlign));
  await capture("file-breadcrumbs-chatgpt-app-light");
  console.log("File preview breadcrumb left-alignment passed (left gap: " + Math.round(crumbAlign.gapLeft) + "px)");
  await theme("ocean", "dark");
  await click("[data-t3e-panel-actions] [data-t3e-swap-btn]");
  await until("swapped", () => evaluate("!!document.querySelector('[data-t3e-workspace][data-t3e-swap=true]')"));
  await clearance(chat, "swapped");
  await click('[data-t3e-panel-actions] [aria-label="Maximize panel"]');
  await until("maximized panel with floating chat", () => evaluate("!!document.querySelector('[data-preview-panel-maximized=true]') && !!document.querySelector('[data-t3e-chat-floating=true]')"));
  await clearance(panel, "maximized panel");
  await click('.t3e-chat-float-btn');
  await until("minimized chat", () => evaluate("!!document.querySelector('[data-t3e-chat-minimized=true] .t3e-chat-pill')"));
  await clearance(panel, "minimized chat");
  await click('.t3e-chat-pill');
  await until("restored floating chat", () => evaluate("!!document.querySelector('[data-t3e-chat-floating=true]:not([data-t3e-chat-minimized])')"));
  await capture("floating-ocean-dark");
  await click('[data-t3e-panel-actions] [aria-label="Toggle right panel"]');
  await until("closed panel", () => evaluate("!document.querySelector('[data-right-panel-tabbar]')"));
  await page("Emulation.setDeviceMetricsOverride", { width: 720, height: 800, deviceScaleFactor: 1, mobile: false });
  await until("720px viewport", () => evaluate("innerWidth === 720"));
  for (const id of ["ocean", "chatgpt-app"]) {
    await theme(id, "light");
    await clearance(chat, "narrow " + id);
  }
  await capture("narrow-chatgpt-app-light");
  console.log("Swapped, maximized, floating, minimized, restored and narrow layouts passed");
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });

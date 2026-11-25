"use strict";

const assert = require("node:assert/strict");
const readline = require("node:readline/promises");

const PACKS = [
  {
    id: "theme",
    name: "ChatGPT 外观主题",
    summary: "ChatGPT / Codex 明暗双模主题、图标物理线宽与排版统一（支持 --official 官方稳定层）",
    includeTheme: true,
    patchIds: [],
  },
  {
    id: "privacy",
    name: "隐私与去遥测",
    summary: "屏蔽 PostHog 上报、禁读 .claude.json/.codex/auth.json、切断 Axiom OTLP 追踪",
    includeTheme: false,
    patchIds: ["no-telemetry", "no-telemetry-relay", "no-telemetry-client", "no-telemetry-ui"],
  },
  {
    id: "composer",
    name: "输出框与额度圈",
    summary: "+ 附加菜单、常驻权限、合一模型/思考深度滑块、5h/7d 双层额度圈与上下文统计浮层",
    includeTheme: false,
    patchIds: ["usage-rings"],
  },
  {
    id: "chat",
    name: "聊天分级与 Diff 优化",
    summary: "收起上级联动折叠、同文件折叠去重、对话内编辑 Diff 预览与侧栏跳转、屏蔽 Diff 慢请求弹窗、文件侧栏三段分层浏览",
    includeTheme: false,
    patchIds: ["timeline-collapse", "timeline-collapse-summary", "inline-file-diff", "inline-file-diff-side-reveal", "inline-file-diff-quiet-review-toast", "files-changes-explorer"],
  },
  {
    id: "workspace",
    name: "整体界面与小窗交互",
    summary: "侧栏搜索与新聊天、新建对话吸底布局、工作区小窗模式、左右主侧交换、主对话小窗/胶囊与后台系统托盘",
    includeTheme: false,
    patchIds: [
      "sidebar-new-chat",
      "new-chat-layout",
      "workspace-floating-panels",
      "workspace-floating-tab-bar",
      "workspace-floating-preview-toolbar",
      "workspace-floating-preview-responsive",
      "desktop-tray",
    ],
  },
];

const PACK_BY_ID = new Map(PACKS.map((p) => [p.id, p]));

const PRESETS = [
  {
    id: "full",
    name: "完整强化版（推荐）",
    summary: "全部 5 大功能：主题 + 去遥测 + 输入框/额度圈 + 聊天分级/Diff + 整体布局/小窗主侧交换",
    packs: ["theme", "privacy", "composer", "chat", "workspace"],
  },
  {
    id: "chat-lite",
    name: "轻量对话增强版",
    summary: "主题 + 去遥测 + 输入框/额度圈 + 聊天分级/Diff（保留原版整体布局与分栏）",
    packs: ["theme", "privacy", "composer", "chat"],
  },
  {
    id: "clean",
    name: "主题 + 去遥测纯净版",
    summary: "仅 ChatGPT 外观主题 + 彻底去遥测（零前端交互改动）",
    packs: ["theme", "privacy"],
  },
  {
    id: "privacy-only",
    name: "纯去遥测版",
    summary: "100% 保留官方原版界面与外观，仅彻底禁用全部遥测与身份读取",
    packs: ["privacy"],
  },
  {
    id: "theme-only",
    name: "纯主题版",
    summary: "仅安装 ChatGPT App 外观主题（无需关闭 T3 Code）",
    packs: ["theme"],
  },
];

const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

function selectPatchesFromList(allPatches, flags = new Set()) {
  const floatingIds = new Set([
    "workspace-floating-panels",
    "workspace-floating-tab-bar",
    "workspace-floating-preview-toolbar",
    "workspace-floating-preview-responsive",
  ]);
  const timelineIds = new Set(["timeline-collapse", "timeline-collapse-summary"]);
  const diffIds = new Set(["inline-file-diff", "inline-file-diff-side-reveal", "inline-file-diff-quiet-review-toast"]);
  const privacyIds = new Set(["no-telemetry", "no-telemetry-relay", "no-telemetry-client", "no-telemetry-ui"]);
  const enabled = (patch) => !flags.has(`--no-${patch.id}`);
  const timelineEnabled = allPatches.filter((p) => timelineIds.has(p.id)).every(enabled);
  const floatingEnabled = allPatches.filter((p) => floatingIds.has(p.id)).every(enabled);
  const diffEnabled = allPatches.filter((p) => diffIds.has(p.id)).every(enabled);
  const privacyEnabled = allPatches.filter((p) => privacyIds.has(p.id)).every(enabled);
  return allPatches.filter((patch) => (
    floatingIds.has(patch.id)
      ? floatingEnabled
      : timelineIds.has(patch.id)
        ? timelineEnabled
      : diffIds.has(patch.id)
        ? diffEnabled
        : privacyIds.has(patch.id)
          ? privacyEnabled
          : enabled(patch)
  ));
}

function resolveInstallPlan(allPatches, options = {}) {
  const {
    preset = null,
    packs = null,
    flags = new Set(),
  } = options;

  const themeOnlyFlag = flags.has("--theme-only");
  const patchOnlyFlag = flags.has("--patch-only");
  const officialOnly = flags.has("--official");

  assert(!(themeOnlyFlag && patchOnlyFlag), "--theme-only 与 --patch-only 不能同时使用");
  assert(!(preset && packs), "--preset 与 --packs 不能同时使用");
  assert(!(themeOnlyFlag && packs), "--theme-only 与 --packs 不能同时使用");
  assert(
    !(themeOnlyFlag && preset && preset.trim().toLowerCase() !== "theme-only"),
    "--theme-only 不能与非 theme-only 预设同时使用"
  );
  assert(
    !(patchOnlyFlag && preset && preset.trim().toLowerCase() === "theme-only"),
    "--patch-only 不能与 theme-only 预设同时使用"
  );

  let selectedPackIds;
  let normalizedPresetId = null;
  if (packs) {
    assert(packs.length > 0, "--packs 至少需要指定一个模块：" + PACKS.map((p) => p.id).join(", "));
    selectedPackIds = [];
    for (const raw of packs) {
      const id = raw.trim().toLowerCase();
      assert(PACK_BY_ID.has(id), `未知功能模块 "${raw}"，可选：${PACKS.map((p) => p.id).join(", ")}`);
      if (!selectedPackIds.includes(id)) selectedPackIds.push(id);
    }
  } else if (preset) {
    const p = PRESET_BY_ID.get(preset.trim().toLowerCase());
    assert(p, `未知版本预设 "${preset}"，可选：${PRESETS.map((x) => x.id).join(", ")}`);
    normalizedPresetId = p.id;
    selectedPackIds = [...p.packs];
  } else if (themeOnlyFlag) {
    normalizedPresetId = "theme-only";
    selectedPackIds = ["theme"];
  } else {
    normalizedPresetId = "full";
    selectedPackIds = [...PRESET_BY_ID.get("full").packs];
  }

  let includeTheme = selectedPackIds.includes("theme") && !patchOnlyFlag;
  if (themeOnlyFlag) {
    selectedPackIds = ["theme"];
    includeTheme = true;
  }

  const allowedPatchIds = new Set(
    selectedPackIds.flatMap((id) => PACK_BY_ID.get(id).patchIds)
  );
  const candidatePatches = allPatches.filter((p) => allowedPatchIds.has(p.id));
  const selectedPatches = selectPatchesFromList(candidatePatches, flags);
  const packIds = patchOnlyFlag ? selectedPackIds.filter((id) => id !== "theme") : selectedPackIds;
  const patchOnly = !includeTheme;
  const themeOnly = includeTheme && selectedPatches.length === 0;
  const telemetryDisabled = selectedPatches.some((p) => p.id === "no-telemetry");
  const layer3PatchIds = new Set(["composer", "chat", "workspace"].flatMap((id) => PACK_BY_ID.get(id).patchIds));
  const needsLayer3Theme = selectedPatches.some((p) => layer3PatchIds.has(p.id));

  assert(includeTheme || selectedPatches.length > 0, "未选择任何主题或前端补丁模块。");

  return {
    presetId: normalizedPresetId || (packs ? "custom" : themeOnlyFlag ? "theme-only" : "full"),
    packIds,
    includeTheme,
    officialOnly,
    patchOnly,
    themeOnly,
    telemetryDisabled,
    needsLayer3Warning: includeTheme && officialOnly && needsLayer3Theme,
    selectedPatches,
  };
}

function consumePackFlags(argv) {
  const remaining = [];
  let preset = null;
  let packs = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--preset") {
      assert(i + 1 < argv.length && argv[i + 1].trim() && !argv[i + 1].startsWith("-"), "请为 --preset 提供预设名");
      preset = argv[++i];
    } else if (arg.startsWith("--preset=")) {
      preset = arg.slice("--preset=".length);
      assert(preset.trim(), "请为 --preset= 提供预设名");
    } else if (arg === "--packs") {
      assert(i + 1 < argv.length && argv[i + 1].trim() && !argv[i + 1].startsWith("-"), "请为 --packs 提供逗号分隔模块名");
      packs = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
      assert(packs.length > 0, "请为 --packs 提供至少一个模块名");
    } else if (arg.startsWith("--packs=")) {
      packs = arg.slice("--packs=".length).split(",").map((s) => s.trim()).filter(Boolean);
      assert(packs.length > 0, "请为 --packs= 提供至少一个模块名");
    } else {
      remaining.push(arg);
    }
  }
  return { remaining, preset, packs };
}

function parsePlatformArgs(argv) {
  const { remaining, preset, packs } = consumePackFlags(argv);
  const positional = [];
  const flags = new Set();
  for (const arg of remaining) {
    if (arg === "-h") flags.add("--help");
    else if (arg.startsWith("--")) flags.add(arg);
    else positional.push(arg);
  }
  return {
    command: positional[0] || null,
    input: positional[1],
    extra: positional.slice(2),
    flags,
    preset,
    packs,
  };
}

async function promptInteractiveAction(options = {}) {
  const patchOnly = Boolean(options.patchOnly);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { action: "install", preset: "full", packs: null, officialOnly: false, sharedData: Boolean(options.defaultSharedData) };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("请选择要执行的操作或安装版本：\n");
    PRESETS.forEach((p, idx) => {
      const disabledNote = patchOnly && p.id === "theme-only" ? "（--patch-only 下不可用）" : "";
      console.log(`  [${idx + 1}] ${p.name}${disabledNote}`);
      console.log(`      ${p.summary}`);
    });
    console.log("  [6] 自定义自由搭配功能模块（多选）");
    console.log("  [7] 修复当前安装（repair：修复损坏文件、补全备份或同步主题）");
    console.log("  [8] 完整卸载还原（uninstall：逐字节恢复官方原版并清理增强）");
    console.log("  [0] 退出\n");

    const choice = (await rl.question("请输入编号 [默认 1]: ")).trim() || "1";
    if (choice === "0") return { action: "cancel" };
    if (choice === "7") return { action: "repair" };
    if (choice === "8") return { action: "uninstall" };

    let preset = null;
    let packs = null;
    if (choice === "6") {
      console.log("\n可选功能模块（输入编号组合，逗号或空格分隔，如 1,2,3）：");
      PACKS.forEach((pack, idx) => {
        console.log(`  [${idx + 1}] ${pack.id.padEnd(10)} ${pack.name} - ${pack.summary}`);
      });
      const raw = (await rl.question("\n请输入模块编号 [默认全部 1,2,3,4,5]: ")).trim() || "1,2,3,4,5";
      const indices = raw.split(/[\s,，]+/).filter(Boolean);
      const picked = [];
      for (const tok of indices) {
        const n = Number(tok);
        if (Number.isInteger(n) && n >= 1 && n <= PACKS.length) {
          const id = PACKS[n - 1].id;
          if (!picked.includes(id)) picked.push(id);
        } else if (PACK_BY_ID.has(tok.toLowerCase())) {
          const id = tok.toLowerCase();
          if (!picked.includes(id)) picked.push(id);
        } else {
          throw new Error(`无法识别的模块选择："${tok}"`);
        }
      }
      assert(picked.length > 0, "未选择任何功能模块。");
      packs = picked;
    } else {
      const idx = Number(choice);
      assert(Number.isInteger(idx) && idx >= 1 && idx <= PRESETS.length, `无效选项："${choice}"`);
      preset = PRESETS[idx - 1].id;
    }

    let officialOnly = Boolean(options.defaultOfficialOnly);
    const includesTheme = !patchOnly && (packs ? packs.includes("theme") : PRESET_BY_ID.get(preset).packs.includes("theme"));
    const includesFrontPatches = (packs ? packs.some((id) => ["composer", "chat", "workspace", "privacy"].includes(id)) : !["clean", "theme-only"].includes(preset));
    const isThemeOnlyPick = !patchOnly && (preset === "theme-only" || (Array.isArray(packs) && packs.length === 1 && packs[0] === "theme"));
    if (includesTheme && !includesFrontPatches) {
      const ans = (await rl.question("主题是否仅安装 Layer 1 官方稳定层（--official）？[y/N]: ")).trim().toLowerCase();
      if (ans) officialOnly = ans === "y" || ans === "yes";
    }

    let sharedData = Boolean(options.defaultSharedData);
    if (options.askSharedData && !isThemeOnlyPick) {
      const ans = (await rl.question("是否与官方版共用 ~/.t3 会话数据（--shared-data，默认使用独立配置）？[y/N]: ")).trim().toLowerCase();
      if (ans) sharedData = ans === "y" || ans === "yes";
    }

    let inputPath = null;
    if (options.promptInputLabel && !isThemeOnlyPick) {
      const rawInput = (await rl.question(options.promptInputLabel)).trim();
      if (rawInput) inputPath = rawInput.replace(/^["']|["']$/g, "");
    }

    return { action: "install", preset, packs, officialOnly, sharedData, inputPath };
  } finally {
    rl.close();
  }
}

module.exports = {
  PACKS,
  PACK_BY_ID,
  PRESETS,
  PRESET_BY_ID,
  selectPatchesFromList,
  resolveInstallPlan,
  consumePackFlags,
  parsePlatformArgs,
  promptInteractiveAction,
};

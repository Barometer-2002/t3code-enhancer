# 隐私与安全说明

> [项目首页](../README.md) · [安装教程](../使用教程.md) · [功能详解](FEATURES.md) · **隐私与安全** · [CLI 参考](CLI_REFERENCE.md) · [常见问题](TROUBLESHOOTING.md)

用直白、透明的方式回答三个核心问题：它改了什么、去遥测拦了什么、如何保证可审计且随时可还原。

### 三条基本承诺

- **完全本地运行，零外部依赖** — 只使用 Node.js 内置模块，无第三方 npm 包，也不连接任何外部服务器。
- **不碰核心数据与 AI 能力** — 不改写你的对话历史、项目源码、模型 API 通信协议或 Agent 执行引擎。
- **随时一键回到原版** — 首次改动前自动保存同版本原版备份，运行 `uninstall` 即可逐字节还原。

## 1. 修改范围与按需选择

不同模块的作用范围清晰隔离，你可以按自己的偏好自由搭配：

| 选择的组合 | 实际改动范围 | 适用偏好 |
| --- | --- | --- |
| **只装主题**（`--preset theme-only`） | 仅写入官方主题文件与外观设置 | 完全不动客户端程序包，无需重启 T3 Code |
| **纯主题 + 纯前端体验**（`--packs theme,composer,chat`） | 仅本地静态页面资源与主题 | 只改界面展示与交互，不碰服务端和桌面主进程 |
| **开启隐私去遥测**（`privacy`） | 额外修改本地遥测开关与桌面端域名拦截 | 关闭上报、停止读取本机其他工具账号文件 |
| **开启系统托盘 / macOS 独立版** | 额外修改桌面主进程窗口与配置入口 | 支持托盘最小化唤醒与独立副本运行 |

## 2. 去遥测具体做了哪些防护

<sub>对应模块：<code>privacy</code>（只想保留 100% 官方界面、单纯去遥测请运行 <code>node cli.cjs install --preset privacy-only</code>）</sub>

`privacy` 模块并非只改一个环境变量，而是从服务端到桌面壳层做了 **5 层全闭环防护**（源码见 [lib/patches/no-telemetry.cjs](../lib/patches/no-telemetry.cjs)）：

1. **停止生成匿名追踪标识** — 服务端 `getTelemetryIdentity` 直接返回空值，不再生成与保存设备/安装 ID。
2. **停止跨工具读取本机账号文件** — 服务端 `getServerOwners` 返回空列表，不再扫描读取 `~/.claude.json` 与 `~/.codex/auth.json`。
3. **清空服务端与 Relay 上报** — 默认关闭 `T3CODE_TELEMETRY_ENABLED`，将 PostHog 上报服务置为空操作，并关闭 Relay OTLP 链路追踪。
4. **关闭前端追踪导出并明示状态** — 移除前端 Axiom OTLP 导出逻辑，在「设置 → 关于」直观标明已由 `t3code-enhancer` 禁用。
5. **桌面主进程网络层兜底拦截** — 启动即锁定 `T3CODE_TELEMETRY_ENABLED=false` 与 `T3CODE_OTEL_SDK_DISABLED=true`，并在默认会话网络层取消发往以下域名的请求：
   - `posthog.com`（含子域） · `ingest.t3.codes` · `axiom.co`（含子域） · `clerk-telemetry.com`（含子域）

> [!NOTE]
> **边界说明**：桌面端网络拦截挂载在 Electron 默认会话（`session.defaultSession`）上，非默认自定义 session 分区不在此拦截范围内（前 4 层代码级关闭依然生效）。Windows 默认安装自动覆盖 `server.asar` 与 `app.asar` 双档；若手动用 `--asar` 只指定单档，终端会明确提示跳过的跨档补丁。

<details>
<summary>技术审计表：5 层去遥测对应的目标文件与补丁 ID</summary>

| 层级 | 补丁 ID | 目标文件 | 处理方式 |
| --- | --- | --- | --- |
| 服务端核心 | `no-telemetry` | `apps/server/dist/runtimeLayer-*.mjs` | 置空 `getTelemetryIdentity`、`getServerOwners`、`readProviderLogins`；默认值改 `false`；`AnalyticsService` 改空操作 |
| 服务端 Relay | `no-telemetry-relay` | `apps/server/dist/WorkflowStore-*.mjs` | `isRelayTracingEnabled` 固定返回 `false` |
| 前端 Client | `no-telemetry-client` | `apps/server/dist/client/assets/utils-*.js` | 置空含 `X-Axiom-Dataset` / `tracesToken` 的导出函数 |
| 前端设置 UI | `no-telemetry-ui` | `apps/server/dist/client/assets/SettingsPanels-*.js` | 更新设置页隐私说明提示（中英自适应） |
| 桌面主进程 | `no-telemetry-desktop` | `apps/desktop/dist-electron/main.cjs` | 注入关闭环境变量 + `session.defaultSession.webRequest.onBeforeRequest` 取消上述 4 组域名请求 |

</details>

## 3. 代码可审计与无损还原机制

- **复杂前端代码全部明文外置** — 6 块前端交互源码全部存放在 [lib/runtime/](../lib/runtime/)，无压缩无混淆，可直接逐行审计；打包后按内容哈希命名并校验完整性。
- **宁可中止、绝不写坏包** — 遇到 T3 Code 新版本时依次执行定位、语法检查、作用域检查与模块链接检查；任一项不通过即安全中止，绝不写入半成品。
- **同版本备份与失败自动回滚** — 首次改动留存 `.before-t3code-enhancer` 原版备份（严格核对版本号，绝不用旧备份覆盖新版）；写入带目录互斥锁与临时快照，异常自动回滚；macOS 始终在独立副本上重建并完成重签名。

<details>
<summary>进阶查阅：6 个外置运行时清单与两级兼容门禁细节</summary>

- **6 个零混淆外置运行时**：`usage-rings-ui.mjs`、`timeline-ui.mjs`、`inline-diff-ui.mjs`、`files-explorer-ui.mjs`、`floating-panels-ui.mjs`、`tab-bar-ui.mjs`（构建后按 `t3e-<name>-<sha8>.js` 写入 ASAR，由 `inspectArchive()` 逐字节校验 SHA-256）。
- **两级兼容判断**：
  - **Tier 1（`verified`）** — 原版文件 SHA-256 精确命中基线。
  - **Tier 2（`auto-adapted`）** — 按语义指纹定位后，依次通过 `apply()` → `node --check` 语法校验 → AST 自由变量作用域检查 → 基于最终产物的 ESM 链接闭环校验。
- 完整构建与事务流程图见开发者文档 [架构蓝图](ARCHITECTURE.md)。

</details>

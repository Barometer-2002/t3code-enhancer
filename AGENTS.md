# t3code-enhancer 开发者指南与初始化约束

本文件面向 **AI Agent（作为项目初始化约束）** 与 **人类开发者**，沉淀硬性红线、隐蔽机制与真实踩坑经验；完整的系统分层拓扑、19+1 补丁映射表、四条核心流程图与接手开发路径见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**，用户使用说明见 [README.md](README.md) 与 [使用教程.md](使用教程.md)。

---

## 1. 硬性边界与开发约束

- **零外部依赖**：仅使用 Node.js `>= 20` 内置模块，严禁引入 `dependencies` 或打包器依赖。
- **修改范围红线**：所有功能仅通过本地 ASAR 静态重打包、外置零混淆 ESM 运行时与主题 JSON 生效；**禁止改动 AI Agent 核心执行引擎、模型通信协议与用户会话/工作区数据结构**。
- **三端归档形态差异（切忌按平台硬编码）**：
  - **Windows**：双档分离（`server.asar` 含 17 项服务端/前端补丁，`app.asar` 含 2 项桌面主进程补丁），默认由 `getArchiveTargetPaths()` 自动成对处理；显式 `--asar` 单档只改目标文件并提示跳过的跨端补丁。
  - **Linux（AppImage / `.deb`）与 macOS**：单档合并 `app.asar`（同时含 `apps/server/*` 与 `apps/desktop/*`）。必须始终用 `applicablePatchesForArchive()` 按归档内容过滤补丁。
  - **macOS 禁止原地改包**：`assertSafeAsarTargets()` 硬拦截对 `.app/Contents/Resources/*.asar` 的直接 `--asar` 写入（否则破坏代码签名与 `ElectronAsarIntegrity`）；必须经 `macos.cjs` / `--app` 在独立副本上重建并重签名。
- **Windows 运行锁与测试隔离**：运行中的 T3 Code（含当前承载 Agent 的宿主进程）会锁定生产目录的 `server.asar` / `app.asar`。开发与测试严禁直接覆盖正在运行的生产 ASAR；本机生效需先彻底退出 T3 Code 后执行 `node cli.cjs repair`。
- **版本单一真相与发版约束**：工具版本号以 `package.json` 为唯一真相源，由 `lib/version.cjs` 强校验为 `MAJOR.MINOR.PATCH` 或 `MAJOR.MINOR.PATCH-(alpha|beta|preview|rc).<N>`，与 T3 Code 基线版本 `T3_BASELINE_VERSION`（`0.1.13`，向后兼容 `0.1.12`）解耦。**T3 Code 常规小版本适配（仅刷新基线哈希与少量定位锚点，不改模块架构）与日常缺陷修复统一递增 `PATCH`（如 `0.2.1`），功能重构或架构级大改版再递增 `MINOR`；已公开发布的 tag 与 ZIP 禁止原地覆写**。
- **行尾规范**：`install.sh` 必须保持 `LF`，`*.cmd` 必须保持 `CRLF`（`.gitattributes` 约束，单测 `3.7` 强制校验）。

---

## 2. 核心架构与隐蔽设计机制

### 2.1 外置零混淆运行时（`lib/runtime/*.mjs` + `lib/runtime-loader.cjs`）

复杂 UI 与交互禁止直接塞进补丁字符串，统一拆至 `lib/runtime/*.mjs`：

- **必须零 `import`**：`compileExecutable()` / `loadRuntimeExports()` 会在 Node VM 中直接加载运行时以供单元测试与复用；若文件出现顶层 `import` 会直接报错。所有宿主依赖一律通过 `createXxxRuntime(host)` 工厂参数注入。
- **双模式挂载（`mountRuntime`）**：
  - 真实 ASAR 构建（`ctx.entry` 存在）：自动写入同目录内容哈希资产 `t3e-<name>-<sha8>.js`，在宿主 chunk 顶部注入 ESM `import`，尾部追加桥接代码 `bridge`。
  - 纯字符串单测（无 `ctx.entry`）：自动剥离 `export` 后内联，保证单测与打包行为一致。
- **双处登记联动**：
  1. 新增或重命名 `lib/runtime/*.mjs` 必须在 `lib/engine.cjs` 的 `PATCH_RUNTIME_NAMES` 登记，否则 `inspectArchive()` 不会校验外置资产 SHA-256（被篡改或缺失时会漏报）。
  2. 修改 `createUsageRingsRuntime(host)` 的解构字段时，`tests/verify.cjs` 会解析源码解构清单并断言生成的 `bridge` 绑定了每一个**无默认值**的 `host` key。

### 2.2 两级兼容与 fail-closed 构建门禁（`lib/engine.cjs` + `lib/resolver.cjs` + `lib/js-ast.cjs`）

- **Tier 1 (`verified`)**：目标文件原始 SHA-256 命中 `patch.originalHash`。
- **Tier 2 (`auto-adapted`)**：未知新版 T3 Code 哈希时，按 `patch.targetSpec` 语义指纹唯一定位，再通过四道门禁：
  1. `apply()` 成功执行；
  2. `validateScriptSyntax()`（`node --check`）验证宿主替换产物及全部外置资产语法；
  3. `verifyInjectedScope()`（静态 AST 自由标识符门禁）校验所有经 `ctx.recordInjectedCode()` 登记的代码片段不存在未声明变量；
  4. **ESM 链接闭环校验**：以**最终替换后的产物集合**（非旧基线）校验每条相对 `import`（含 `default`、`export *` 递归转发、多变量声明导出）均能在目标模块命中。
- **跨版本安全原则**：
  - 所有正式补丁都必须提供 `targetSpec`（Suite 17 的 `hashOnlyPatchIds` 断言禁止纯 hash 钉死的补丁）。
  - `resolvePristineBaseline()` 严格核对当前 ASAR 与备份的 `package.json` `version` 一致，绝不允许旧版本备份覆盖更新后的 T3 Code。

### 2.3 跨 chunk 语义解析与 React Compiler 槽位分配

T3 Code 前端由 Rolldown + React Compiler 构建，混淆名（如 `Cs`、`ve`、`hW`）与缓存槽位下标（`t[1220]`）跨版本必变：

- **禁止硬编码短混淆名**：优先通过 `ctx.resolveImportedAlias()` / `ctx.ensureChunkImport()` 检查目标 chunk 导出的源码声明特征（`decl(local)`）完成解析，或用 `findUniqueFunction()` / `findEnclosingFunction()` 定位函数再做局部结构匹配；固定导出别名仅能作为无 ASAR 单测的兜底回退。
- **React Compiler 缓存数组 `(0,Q.c)(N)`**：向宿主组件内追加需要 memo 的值时，**禁止硬写 `t[xxx]` 固定下标**，必须通过 `ctx.allocateMemoSlots()` 扩展槽位容量并获取安全槽位索引。
- **同文件多补丁叠加**：多个补丁按 `ALL_PATCHES` 注册顺序串联作用于同一 chunk（如 `usage-rings` + `new-chat-layout` + `workspace-floating-panels` 共改 `ThreadRouteView-*.js`）。补丁间存在条件协作时必须用 `ctx.isEnabled(patchId)` 判断（例如 `new-chat-layout` 在未装 `usage-rings` 时需保留原版右侧权限入口）。

### 2.4 构建元数据与无参修复（`t3e-build-meta.json` + `.t3code-enhancer-plan.json`）

- 每次 `buildPatchedArchive()` 都会在 ASAR 根写入 `t3e-build-meta.json`（记录 `enhancerVersion`、`appVersion`、`compatTier`、`modules` 与序列化后的 `plan`），同时 `cmdInstall` / `cmdRepair` 会在用户数据目录同步事务化持久化 `.t3code-enhancer-plan.json`（卸载时清理）。
- 裸跑 `repair` 时，`inferRepairPlanOptions()` 优先读取存活归档中的 `plan`（精确保留 `--packs`、`--no-desktop-tray`、`--official` 等细粒度排除项）；即使 Windows 下 `app.asar` 损坏，仍能从存活的 `server.asar` 恢复原方案；若官方原生覆盖升级清除了全部归档补丁，则自动回退读取 `.t3code-enhancer-plan.json`，绝不误退化为 `theme-only`。
- `matchesSelectedPatches()` 会额外检查**同文件是否残留未选中的补丁**，避免用户缩减模块组合时因已选模块均已安装而误跳过重建。

---

## 3. 真实踩坑经验（修改前必读）

### 坑 1：`ThreadRouteView` 的 `q` 来自 `quietThreadAtom`，会剥离流式文本并抑制重渲染
- **现象**：在 `ThreadRouteView` 读取 `q?.turnItems` 计算流式输出速度时，所有 `reasoning` 和 `assistant_message` 的 `text` 与 `updatedAt` 都是 `undefined`，且流式期间组件根本不重渲染。
- **根因**：`entities` 中的 `quietThreadAtom(ref)` 专门做了两件事——剥离流式项的 `text`/`updatedAt`（`U_` 变换），并通过等价函数屏蔽文本变化触发的更新。
- **正确做法**：**绝不能把 `ThreadRouteView` 主视图改成订阅 `threadAtom`**（会导致 ~80 KB 对话页 20 fps 全量重渲染）。应在独立轻量子 Provider（如 `T3RingsCtxProvider`）内通过 `atomRegistry.subscribe(threadAtoms.threadAtom(threadRef), cb, { immediate: true })` 单独订阅未剥离投影，按 `1000 ms` 统计间隔（`T3_SPEED_STAT_INTERVAL_MS`）只更新隔离 Context（`T3LiveSpeedCtx`），利用透传 `children` 引用避免宿主子树重渲染；按需弹层通过 `atomRegistry.get(...)` 读取未剥离快照。

### 坑 2：`useI18n` 与 `useFormatMessage` 不是同一个 Hook
- 宿主 `utils-*.js` 同时导出两个国际化函数：
  - `useI18n`：解码带 `$_source` 的编码消息 `M(...)`（供 `formatDuration` / `formatTimestamp` / `paceLabels` 回调）；
  - `useFormatMessage`：格式化纯 ICU 模板（如 `"Resets in {duration}"`）。
- 两者绑反会在 UI 中露出 `:eyJ...` base64 尾串或抛错；语义解析必须用 `$_source` 与 `ICU && !$_source` 严格区分。

### 坑 3：宿主资产目录存在同名短前缀 chunk 碰撞
- `apps/server/dist/client/assets/` 中存在多个共享前缀的文件（如多个 `runtime-*.js`、含 stub 的 `utils-*.js` 与 `runtimeLayer-*.mjs`）。
- 无论是编写 `targetSpec` 还是临时排查脚本，**都不能只用前缀正则匹配**，必须配合 `includes` 唯一特征串或完整路径过滤。

### 坑 4：前端投影中的时间字段是 `Effect.DateTime.Utc` 对象，直接 `Date.parse()` 必返 `NaN`
- **现象**：`最近轮次平均输出速度` 始终显示 `—`，`本轮耗时` 整段消失，流式项的 `startedAt`/`updatedAt` 区间全部为空。
- **根因**：T3 Code 客户端经 `Schema.DateTimeUtc` 解码后的时间字段是 `Effect.DateTime.Utc` 实例（含 `.epochMilliseconds`，其 `.toString()` 返回 `"DateTime.Utc(2026-...)"`），调用 `Date.parse(obj)` 必然返回 `NaN`。
- **正确做法**：所有时间字段解析一律使用 `t3ParseTimestamp(v)`（优先读 `.epochMilliseconds` / `.epochMillis` / `.getTime()` / `.toJSON()`，最后回退 `Date.parse(str)`）；单测必须包含模拟 `DateTime.Utc` 对象的回归用例。
- 输出速度统计面向的是**模型本身解码速度（活跃输出总 Token ÷ 合并后的活跃输出总时长，剔除 TTFT 与工具等待）**，按 1 秒统计间隔平稳收敛，不在工具停顿期归零闪烁；切换 `threadRef` 时须用 `threadKey` 标记输出并在清理函数里退订旧 atom、清零状态。

### 坑 5：`tests/verify.cjs` 中轻量 React Mock 的 `useRef` 不跨渲染持久
- `tests/verify.cjs` 的无 DOM React mock 里，`useState` 会按 slot 跨 render 持久存储，而 `useRef` 每次返回新对象 `({ current: init })`。
- 需要跨帧保活且要在单测沙箱中验证的控制器/状态对象（如速度采样器 `speedCtrl`），建议用 `useState(() => ({ ... }))` 持有，既符合 React 规范又能让单测与真实环境完全一致。

### 坑 6：`themes/chatgpt-app.json` 三层边界与用户主题保真
- 主题 CSS 严格依赖 `/* === LAYER 1:` 与 `/* === LAYER 2:` 两个边界注释：`--official` 通过截断 `LAYER 2` 提取纯官方样式层，删改注释会导致官方层提取失效。
- 主题是否归属本工具托管由 `lib/theme-manager.cjs` 中的 `.t3code-enhancer-theme-state` 元数据与 `KNOWN_HISTORICAL_THEME_HASHES` SHA-256 白名单共同判定，**禁止退回靠一两个 CSS 变量名的弱匹配**，以免误覆写或误删用户自制主题。

### 坑 7：服务端 `no-telemetry` 替换必须按语句边界切分
- 替换 `runtimeLayer` 中的 `getTelemetryIdentity`、`getServerOwners`、`AnalyticsService` `make$NN` 声明时，必须用 `findStatementEndWithTokens()` / `findMatchingChar()` 精准界定语句与括号范围，**禁止跨行贪婪匹配到后续 `effect(AnalyticsService, ...)`**，否则新版在中间插入的兄弟声明会被一并删除。

### 坑 8：补丁版本标记与联动分组遗漏
- **每次修改任一补丁的注入结构**，必须递增其 `MARKER`（如 `V31 → V32`）并将旧 `MARKER` 加入 `LEGACY_MARKERS`；否则已装旧版的机器运行 `status` / `repair` 不会触发升级，且历史脏包识别失效。
- 新增子补丁必须同步登记到：
  1. `lib/engine.cjs` 的 `ALL_PATCHES`（以及 `PATCH_RUNTIME_NAMES`，若带外置运行时）；
  2. `lib/packs.cjs` 的 `PACKS` 与 `PATCH_GROUPS`（联动补丁禁用其一会自动禁用整组）。

---

## 4. 测试分层与修改检查清单

### 测试命令分工

| 命令 | 覆盖范围 | 典型耗时 | 使用时机 |
| --- | --- | --- | --- |
| `npm run test:unit` | 纯逻辑单测（Suite 1 ~ 3.7，无需安装 T3 Code） | `< 1s` | 改纯算法/CLI 解析/主题校验时快速迭代 |
| `npm test` | 真实 `0.1.13`（兼容 `0.1.12`）双端全量构建 + 19 补丁/6 外置运行时 + 全部 UI/交互/安全/去遥测/托盘校验（Suite 1 ~ 16） | `~30s` | **每次改动后的默认必跑门禁** |
| `npm run test:full` | 追加 Suite 17（v0.1.99 跨版本变异压测）与 Suite 18（Linux/macOS 合并单档 + Windows 双端事务回滚矩阵，已采用 `createSlimAsar` 精简真实内容夹具） | `~5min` | 改 `engine`/`resolver`/`asar`/跨端安装事务，或发版打 ZIP 前必跑 |

### 提交前自检 Checklist

> 完整的 PR 自动拉取/试配、提交前门禁与发版打包流程见 **[docs/MAINTAINER_WORKFLOW.md](docs/MAINTAINER_WORKFLOW.md)**。

1. 运行 `npm run preflight`（或仅快速静态门禁 `npm run preflight -- --skip-tests`），自动校验 `git diff --check`、零外部依赖、行尾规范、`MARKER`/`LEGACY_MARKERS`、外置运行时零 `import` 与文档版本对齐。
2. 补丁结构变更已同步递增 `MARKER` + 更新 `LEGACY_MARKERS`；外置 `lib/runtime/*.mjs` 保持零 `import` 并登记到 `PATCH_RUNTIME_NAMES`。
3. 至少通过 `npm run test:unit` 与 `npm test`；如改动构建引擎、事务/回滚、跨平台脚本或发版前，补跑 `npm run preflight -- --full --e2e`。
4. 发版统一使用 `npm run release:pack`（解压验包 + SHA-256）与 `npm run release:publish`（防覆写 tag + 默认 Draft Release）；如需更新本机正在运行的 T3 Code 验证实机效果：提醒用户先彻底关闭 T3 Code（含托盘图标），再运行 `node cli.cjs repair`。

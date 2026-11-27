# 维护者自动化流水线与发版指南

本文档沉淀 `t3code-enhancer` 的五段式维护工作流：**自动拉取（社区 PR / 上游新版）→ 隔离 Worktree 试配 → 提交审查与测试 → 提交前门禁 → Review 修复与发版**。

整套流程采用**双层混合架构**：
- **GitHub Actions（[ci.yml](../.github/workflows/ci.yml)）**：对所有 PR 与 `main` / `v*` push 运行只读、跨平台（Ubuntu / macOS / Windows）的 `preflight --ci`、`verify --unit` 与发行包干跑验包；
- **本机 T3 Code Agent + 零依赖脚本（`scripts/*.cjs`）**：承接需要本机真实 T3 Code ASAR 与浏览器的深度试配、全量回归测试、审查导览交付与防呆发版。

---

## 一、常用命令速查

| 命令 | 用途 | 适用阶段 |
| :--- | :--- | :--- |
| `npm run preflight -- --skip-tests` | 秒级静态门禁（依赖/登记/Marker/行尾/文档/Git diff） | 每次提交前快速自检 |
| `npm run preflight -- --ci` | CI 门禁（静态检查 + `verify --unit`） | 无本机 T3 Code 时 / GitHub Actions |
| `npm run preflight` | 标准门禁（静态检查 + `test:unit` + `test`） | PR 试配与合入前默认门禁 |
| `npm run preflight -- --full --e2e` | 最高级别门禁（静态检查 + Suite 1~18 + 隔离浏览器 E2E） | 改引擎/跨端事务/布局，或发版前 |
| `npm run release:pack -- --out /tmp/test.zip --skip-clean-check` | 干跑试打包 + 解压后单元测试验包（不写入 `dist/`） | 开发中验证打包完整性 |
| `npm run release:pack -- --write-notes` | 生成正式 `dist/t3code-enhancer-v<ver>.zip`、验包并生成发版说明模板 | 发版准备 |
| `npm run release:pack -- --update-notes` | 重新打包并仅刷新既有 `dist/release-v<ver>.md` 中的文件名与 SHA-256 | 修订后重打未发布版本的包 |
| `npm run release:publish` | 发版前干跑校验（只检查、打印计划命令，不执行推送与打标） | 正式发版前演练 |
| `npm run release:publish -- --execute` | 推送 `main`、创建并推送 `v<ver>` tag、创建 GitHub **Draft** Release | 确认无误后执行发版 |

> **安全边界**：`release:publish` 默认加 `--draft`（草稿），且强拦截本地/远端已存在的同名 tag，杜绝原地覆写已公开版本。预览版（`-alpha.N` / `-beta.N` / `-preview.N` / `-rc.N`）会自动附带 `--prerelease`。

---

## 二、五段式标准流水线（SOP）

### 阶段 1：自动 PR 拉取与上游巡检（T3 Code 定时任务）

在 T3 Code 中使用 `/schedule` 创建定时任务（例如每 2 小时或每日一次），复用以下提示词模板。

#### 模板 A：社区 PR 自动拉取与隔离试配（推荐）

```text
巡检仓库 Barometer-2002/t3code-enhancer 的开放 PR（使用 pull_request_list，仅看 state=open）：
1. 跳过 Draft PR、带 wip/do-not-merge 标签的 PR，以及已存在对应未合并 integrate/pr-<N>-* 集成 PR 且源 PR headSha 未更新的项。
2. 【安全硬闸门】对外部 Fork PR，在运行任何本地命令或测试之前，先完整阅读其 diff（pull_request_read include=["body","diff","comments"]）：
   - 确认无恶意 shell/Node 副作用、无读取 ~/.codex / ~/.claude / 环境变量凭据、无未授权网络外联、未引入外部 npm 依赖。
   - 若存在高风险或越界修改，直接汇报拦截原因并停止，禁止执行 PR 代码。
3. 审计通过后，不要修改主工作区 main；通过隔离 worktree 创建分支 integrate/pr-<N>-<slug>（基于 origin/main），合入源 PR 并保留原作者署名（commit 或 Co-authored-by）。
4. 对照 AGENTS.md 检查并完成试配：
   - 补丁注入结构有变化时递增 MARKER 并更新 LEGACY_MARKERS；
   - 外置 lib/runtime/*.mjs 零顶层 import 且登记到 PATCH_RUNTIME_NAMES；
   - 新增补丁同步登记 ALL_PATCHES / PACKS / PATCH_GROUPS；
   - 兼顾 Windows 双档与 Linux/macOS 合并单档；
   - 绝不覆盖正在运行的本机生产 ASAR。
5. 运行验证：
   - 必跑：npm run preflight
   - 改引擎/跨平台/安装事务时补跑：npm run preflight -- --full
   - 改前端 UI/主题/布局时补跑：npm run test:e2e
6. 推送 integrate/pr-<N>-<slug>，调用 pull_request_create 创建 Draft 集成 PR（说明与原 PR 的差异及试配点），调用 write_pull_request_guides 生成代码导览，并调用 watch_pull_request 监听后续 Review 意见。
7. 输出结构化审查报告交给我：改动摘要、试配修复清单、各套件测试结果、待我人工确认的边界项。严禁自动合并 main。
```

#### 模板 B：上游 `pingdotgg/t3code` 新版本自动巡检

```text
检查上游仓库 pingdotgg/t3code 的最新 Release 版本，并与当前 lib/version.cjs 中的 T3_BASELINE_VERSION（以及本机已安装的 T3 Code 版本）对比：
1. 若无更新版本，简短汇报当前版本已对齐即可结束。
2. 若发现上游新版且本机已有对应安装包：
   - 先运行只读探测（node cli.cjs status），记录哪些补丁降级为 auto-adapted 或定位失败，以及上游 Release Notes 中与主题/遥测/额度/布局相关的变更；
   - 在隔离 worktree 创建分支 feat/t3code-<newVersion>，刷新基线哈希与必要语义锚点，更新 T3_BASELINE_VERSION 与文档说明（不改模块架构时按 PATCH 递增版本号规划，先不打 tag）；
   - 运行 npm run preflight -- --full --e2e 验证通过后，推送 Draft PR 并生成 PR Review Guide 交给我审查和测试，严禁自动合入或覆盖本机运行中的生产 ASAR。
3. 若上游已发版但本机尚未升级客户端，整理上游变更影响评估与待办清单汇报给我即可。
```

---

### 阶段 2：隔离 Worktree 试配规范

- **绝不污染主工作区 `main`**：所有社区 PR 集成与上游版本试配都在独立 worktree 进行（如 `integrate/pr-9-fix-tray` 或 `feat/t3code-0.1.14`）。
- **绝不触碰运行中的生产 ASAR**：Windows 上测试统一通过 `tests/verify.cjs`（临时副本构建）与 `tests/e2e-real.cjs`（临时 `server.asar` + 脱敏环境变量 + 无头 Chrome）完成。
- **单分支收敛**：若社区 PR 本身干净且基于最新 `main`，可直接在该 PR 分支上审查合入；若需要解决冲突、补齐 `MARKER`/单测/三端兼容，则统一沉淀在 `integrate/pr-<N>-<slug>` 集成 PR 中，保留原作者 commit 或 `Co-authored-by`。

---

### 阶段 3：提交给你审查与测试（人工卡点 1）

每次提交给你审查的集成 PR，应包含以下 4 项交付物：
1. **GitHub Draft PR + T3 Code Review Guide**：通过 `write_pull_request_guides` 生成导览，按模块走查 diff；
2. **试配差异摘要**：明确列出原 PR 做了什么、维护者试配额外修了什么；
3. **测试矩阵证据**：`preflight` / `test:unit` / `test` / `test:full` / `test:e2e` 的实跑通过结论与未覆盖的真机边界（如 macOS/Linux 实机桌面托盘）；
4. **PR 监听接续**：已开启 `watch_pull_request`——你在 GitHub PR 上发表行内 Review 意见或 Request Changes 后，对应线程自动唤醒修复、重跑门禁并回复评论。

---

### 阶段 4：提交前准备（Pre-commit / Pre-merge 硬门禁）

合并进 `main` 之前，必须跑通 `npm run preflight`（重大改动加 `--full --e2e`）：
- **零依赖检查**：`package.json` 无外部依赖，版本号符合 `lib/version.cjs` 规范；
- **注册表闭环**：`ALL_PATCHES`、`PACKS`、`PATCH_GROUPS`、`PATCH_RUNTIME_NAMES`、`lib/runtime/*.mjs` 全部对齐，外置运行时零顶层 `import`；
- **Marker 连续性**：每个补丁 `T3_*_V<N>` 的 `legacyMarkers` 必须连续包含 `V1..V(N-1)`；若改动了补丁或外置运行时但未递增 `MARKER`，脚本会自动发出告警（可用 `--strict-markers` 升级为硬阻断）；
- **跨端卫生检查**：`install.sh` 保持 LF + `100755`、`*.cmd` 保持 CRLF + `chcp 65001`、其余代码/文档保持 LF、`themes/chatgpt-app.json` 三层注释完整；
- **Git 与文档一致性**：`git diff --check` 无残渣，`README.md`、`使用教程.md`、`AGENTS.md` 与当前版本号/基线一致。

---

### 阶段 5：Review 修复与发版（人工卡点 2）

所有审查意见修复并合入 `main` 后，按以下固定顺序发版：

1. **确定新版本号并更新文档**（遵守 [AGENTS.md](../AGENTS.md) 策略）：
   - 常规小版本适配（仅刷新基线哈希/少量锚点）或缺陷修复：递增 **`PATCH`**（如 `0.2.0` → `0.2.1`）；
   - 功能重构或架构级大改版：递增 **`MINOR`**（如 `0.2.x` → `0.3.0`）；
   - 公测预览版：使用 `-preview.<N>` 后缀（如 `0.2.1-preview.1`）。
   - 同步更新 `package.json`、`README.md`、`使用教程.md`（及涉及基线变动时的 `AGENTS.md` / `docs/`）。
2. **发版前全量门禁**：
   ```bash
   npm run preflight -- --full --e2e --strict-clean
   ```
   （若刚改完文档版本号尚未提交，先提交 `Release vX.Y.Z` commit，再跑 `--strict-clean`。）
3. **打包与解压验包**：
   ```bash
   npm run release:pack -- --write-notes
   ```
   - 生成 `dist/t3code-enhancer-vX.Y.Z.zip`（自动保留 `install.sh` 的 Unix `0755` 权限与 UTF-8 文件名）；
   - 自动解压到临时目录运行 `tests/verify.cjs --unit` 验证发行包自洽；
   - 自动生成 `dist/release-vX.Y.Z.md`（若已存在则加 `--update-notes` 仅刷新文件名与 SHA-256），补全其中的更新日志并清理 `TODO:` 占位符。
4. **干跑演练与创建 Draft Release**：
   ```bash
   npm run release:publish
   npm run release:publish -- --execute
   ```
   - 校验分支、工作区干净、本地与远端无重名 tag、发版说明内 SHA-256 与 ZIP 一致；
   - 推送 `main` 与 annotated tag `vX.Y.Z`，在 GitHub 创建 **Draft Release**（预览版自动带 `--prerelease`）；
   - **人工卡点**：在 GitHub Release 网页最后核对一遍附件、SHA-256 与正文，点击 **Publish release**。
5. **本机实机更新验证**：
   - 彻底退出正在运行的 T3 Code（包含右下角系统托盘图标）；
   - 运行 `node cli.cjs repair`（或解压新 ZIP 双击 `repair.cmd`），重新启动 T3 Code 确认生效。

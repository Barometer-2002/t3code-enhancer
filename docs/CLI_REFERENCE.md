# CLI 命令参考

> [项目首页](../README.md) · [安装教程](../使用教程.md) · [功能详解](FEATURES.md) · [隐私与安全](PRIVACY_AND_SECURITY.md) · **CLI 参考** · [常见问题](TROUBLESHOOTING.md)

面向进阶用户与脚本自动化的速查手册。日常使用直接双击 `install.cmd` 或运行 `./install.sh` 即可，无需记忆以下参数。

## 入口与子命令

统一入口为 `node cli.cjs <子命令> [选项]`（Windows 另有 `.cmd` 快捷脚本，Linux / macOS 另有 `./install.sh`、`linux.cjs` 与 `macos.cjs`）。

| 子命令 | 别名 / 标志 | 作用 |
| --- | --- | --- |
| `install` | `--install` | 按预设或模块组合安装 / 升级 |
| `status` | `--status`（无参默认） | 查看主题、备份、运行状态、兼容层级与全模块状态 |
| `repair` | `--repair` | 清理残留临时文件、校验备份并按上次选定方案重建 |
| `uninstall` | `restore` / `--uninstall` | 逐字节还原纯净原版并清理/恢复主题 |
| `build <out.asar>` | `--build` | 在副本上试构建并输出 JSON 报告（不改动当前安装） |
| `version` | `--version` / `-v` | 查看当前工具版本号与目标基线版本 |
| `help` | `--help` / `-h` | 打印命令行帮助 |

## 模块与预设选项

| 参数 | 取值 | 适用命令 | 说明 |
| --- | --- | --- | --- |
| `--interactive` | — | `install` | 打开交互式选择菜单 |
| `--preset <id>` | `full` \| `chat-lite` \| `clean` \| `privacy-only` \| `theme-only` | `install` / `repair` / `build` | 选用预设方案（与 `--packs` 互斥） |
| `--packs <a,b,c>` | `theme`, `privacy`, `composer`, `chat`, `workspace` | `install` / `repair` / `build` | 自由搭配模块（与 `--preset`、`--theme-only` 互斥） |
| `--official` | — | `install` / `repair` | 主题仅装 Layer 1 官方稳定层（适合配合 `theme-only` / `clean`） |
| `--theme-only` | — | `install` / `repair` / `uninstall` | 仅操作主题，不动客户端包（无需退出 T3 Code） |
| `--patch-only` | — | `install` / `repair` | 仅操作代码补丁，不动主题配置 |
| `--no-<patch-id>` | 任意补丁 ID（如 `--no-desktop-tray`） | `install` / `repair` / `build` | 排除指定原子补丁 |

### 预设包含矩阵

| 预设 | `theme` | `privacy` | `composer` | `chat` | `workspace` |
| --- | :---: | :---: | :---: | :---: | :---: |
| `full`（默认） | ✅ | ✅ | ✅ | ✅ | ✅ |
| `chat-lite` | ✅ | ✅ | ✅ | ✅ | — |
| `clean` | ✅ | ✅ | — | — | — |
| `privacy-only` | — | ✅ | — | — | — |
| `theme-only` | ✅ | — | — | — | — |

<details>
<summary>查看 <code>--no-&lt;patch-id&gt;</code> 联动禁用组规则</summary>

以下 4 组补丁存在强依赖，排除组内任意一项会自动排除整组；其余 5 项（`usage-rings`、`files-changes-explorer`、`sidebar-new-chat`、`new-chat-layout`、`desktop-tray`）支持直接单项排除：

- **`PRIVACY`** — `no-telemetry`、`no-telemetry-relay`、`no-telemetry-client`、`no-telemetry-ui`、`no-telemetry-desktop`
- **`TIMELINE`** — `timeline-collapse`、`timeline-collapse-summary`
- **`DIFF`** — `inline-file-diff`、`inline-file-diff-side-reveal`、`inline-file-diff-quiet-review-toast`
- **`FLOATING`** — `workspace-floating-panels`、`workspace-floating-tab-bar`、`workspace-floating-preview-toolbar`、`workspace-floating-preview-responsive`

</details>

## 平台与卸载选项

| 参数 | 适用范围 | 说明 |
| --- | --- | --- |
| `--asar <path>` | Windows / Linux 解包版 | 显式指定单个 `server.asar` 或 `app.asar`（禁用于 macOS `.app` 原地修改） |
| `--appimage <path>` | Linux | 指定官方 `T3-Code-x86_64.AppImage` 路径 |
| `--app <path>` | macOS | 指定官方 `T3 Code (Beta).app` 路径（默认 `/Applications/T3 Code (Beta).app`） |
| `--shared-data` | Linux / macOS | 与官方版共用 `~/.t3` 数据目录，并把共用设置切到 ChatGPT App 主题（卸载时恢复原主题；两者勿同时运行） |
| `--keep-theme` | `uninstall` | 卸载补丁时保留 `chatgpt-app` 主题 |
| `--purge-backup` | `uninstall` | 还原原版后一并删除 `.before-t3code-enhancer` 备份 |
| `--purge-profile` | Linux / macOS `uninstall` | 一并清理独立配置目录 |

### 环境变量

- **`T3CODE_ASAR`** — 等价于 `--asar <path>`
- **`T3CODE_PORT`** — Linux AppImage 独立配置模式下的服务端口（默认 `3774`）

## 常用命令直接复制

```bash
node cli.cjs install --interactive                    # 交互式选单
node cli.cjs install --preset full --no-desktop-tray  # 完整版，但关闭最小化到托盘
node cli.cjs install --packs theme,composer,chat      # 仅主题与纯前端交互
node cli.cjs install --preset privacy-only            # 仅 5 层去遥测，保留官方界面
node cli.cjs install --preset theme-only --official   # 仅装官方稳定主题层（无需重启）
node cli.cjs build /tmp/t3-check.asar                 # 无副作用试构建检查兼容性
node cli.cjs repair                                   # 自动延续原方案修复
node cli.cjs uninstall --purge-backup                 # 彻底还原原版并清理备份
```

## 本地测试命令（开发者）

| 命令 | 耗时 | 说明 |
| --- | --- | --- |
| `npm run test:unit` | `< 1s` | 纯逻辑与三端 CLI 单测，无需安装 T3 Code |
| `npm test`（可加 `-- <server.asar>`） | `~30s` | 基于真实 `0.1.12` 构建与全部 UI / 去遥测 / 托盘回归 |
| `npm run test:full` | `~5min` | 追加 `v0.1.99` 跨版本变异压测与三端事务回滚矩阵 |

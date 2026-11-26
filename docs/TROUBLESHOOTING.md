# 常见问题与排查

> [项目首页](../README.md) · [安装教程](../使用教程.md) · [功能详解](FEATURES.md) · [隐私与安全](PRIVACY_AND_SECURITY.md) · [CLI 参考](CLI_REFERENCE.md) · **常见问题**

按日常可能遇到的现象归类，每条先给直接解决办法，再附简明原因。

## 安装与托盘相关

### 提示「请先关闭所有 T3 Code 窗口」，但我明明关掉了？
右键系统右下角托盘区（或 macOS 菜单栏）中的 T3 Code 图标，点 **「退出 T3 Code」**，再重新运行命令即可。

<sub>原因：开启后台系统托盘后，点击窗口右上角 <code>×</code> 只是藏到后台，主进程仍在运行并占用文件锁。</sub>

### 不想要「点 × 最小化到托盘」，想点一下就直接退出？
任选一种即可：
- **免重装即时切换** — 右键托盘图标 → 取消勾选 **「关闭窗口时最小化到托盘」**，立即生效且重启后记住。
- **安装时直接排除** — 运行 `node cli.cjs install --preset full --no-desktop-tray`。

### 提示「已有 ASAR 维护命令持锁」怎么办？
确认没有其他正在运行的安装/修复终端后，删掉报错里列出的那个**空锁目录**（如 `.t3code-enhancer-asar.lock`），再跑一次 `node cli.cjs repair` 即可恢复。

<sub>原因：上次维护命令被强制关闭或意外中断时，可能遗留了空锁目录。</sub>

## 统计与显示相关

### 底栏的 `tok/s` 速度怎么算的？为什么工具调用时数字不会归零？
底栏右侧展示的是**模型实际吐字的平均解码速度**（如 `3.5% · 61.7 tok/s`）：
- 仅统计思考、正文与计划的活跃输出耗时，剔除了首字等待（TTFT）与工具执行等待；
- 流式期间按每秒平稳更新，工具停顿期保持当前均值不闪烁归零，轮次结束后保留本轮平均速度。

### 为什么悬停统计卡里「累计令牌」或「缓存命中率」有时显示 `—`？
**这是正常现象**。部分后端或协议（如 Antigravity ACP 的 `usage_update`）只上报当前上下文占用和上限，不上报输入/输出/缓存细分字段。为避免把“当前上下文大小”错算成“累计消耗”，缺少细分字段的指标会如实显示 `—`；仅部分回合有明细时，悬停可查看覆盖范围。

### 用了 `--official` 后提示「部分功能补丁视觉样式可能不完整」？
`--official` 会仅保留官方白名单样式（Layer 1），若同时装了 `composer` / `chat` / `workspace` 等新增组件，会缺少配套样式。纯官方层建议搭配 `--preset theme-only` 或 `--preset clean`。

## 客户端更新与平台相关

### T3 Code 官方更新后还能继续用吗？
先运行 `node cli.cjs status`（Windows 双击 `status.cmd`）看兼容状态：
- **`已验证 (verified)`** — 完全匹配，直接重新安装即可。
- **`跨版本自动适配 (auto-adapted)`** — 新版结构已被自动识别并通过静态检查，可放心重装（也可先用 `node cli.cjs build /tmp/test.asar` 试构建）。
- **`不兼容 (incompatible)`** — 上游改动较大，程序会自动中止以保护客户端；此时可先运行 `node cli.cjs install --theme-only` 继续使用主题，等待适配更新。

### Windows 下用 `--asar` 只指定 `server.asar` 提示跳过桌面补丁？
Windows 官方安装分 `server.asar`（界面与服务）和 `app.asar`（桌面主进程）两档。直接执行 `node cli.cjs install`（不加 `--asar`）会自动成对处理；仅手动指定单档时会跳过跨档补丁，去掉 `--asar` 再运行一次即可补齐。

### Linux AppImage 端口被占用，或者想和官方版共用数据？
- **改端口** — 启动前指定 `T3CODE_PORT=3775 "${XDG_DATA_HOME:-$HOME/.local/share}/t3code-enhancer/launch.sh"`（默认 `3774`）。
- **共用数据** — 安装时加 `--shared-data` 即可共用 `~/.t3`（注意不要同时打开官方版与增强版）。

### macOS 为什么不能用 `--asar` 原地改包？
macOS 的 `.app` 有严格的代码签名与完整性校验，原地改包会导致应用无法启动。请始终通过 `./install.sh install --app "/Applications/T3 Code (Beta).app"` 在独立副本上重建并自动重签名。

## 问题反馈模板

遇到异常或愿意协助测试 **macOS 真机表现**，欢迎到 [GitHub Issues](https://github.com/Barometer-2002/t3code-enhancer/issues) 留言，附上以下 3 项即可最快定位：

1. **系统与版本** — 如 Windows 11 / Ubuntu 24.04 / macOS 15 + T3 Code `0.1.12` + `node cli.cjs --version` 输出
2. **当前状态** — 粘贴 `node cli.cjs status` 的完整输出
3. **具体现象** — 做了哪一步、报错文案或截图

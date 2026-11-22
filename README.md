# t3code-enhancer

T3 Code（Windows 桌面版）一体化视觉与交互强化脚本项目，提供**一键安装、状态检测、完整卸载还原**能力。

适用于 Windows 桌面版 T3 Code 0.1.11。界面补丁会校验本机安装包中的目标文件，具体兼容性以 `status.cmd` 的结果为准。

从 [GitHub Releases](https://github.com/Barometer-2002/t3code-enhancer/releases/latest) 下载安装 ZIP。安装、卸载和界面截图见 [使用教程](使用教程.md)。

## 包含模块

1. **ChatGPT / Codex 一体化主题（`themes/chatgpt-app.json`）**
   - 明暗双模统一设计 Token（`768px` 主阅读栏 / `296px` 右侧面板 / `10px` 根圆角 / 4 级墨色与字号阶梯）。
   - 全局 `vector-effect: non-scaling-stroke`（`1.35px` 固定物理线宽）+ 分区锁定图标尺寸，彻底消除图标发虚与粗细不一。
   - 主对话区 `0px → 7px → 22px` 左轴对齐、侧栏统一 `10px` 基准线、无顶栏硬线、丝滑鼠标悬停交互。
2. **多层级折叠联动补丁（`lib/patches/timeline-collapse.cjs`）**
   - 收起上级菜单（回合折叠 / 尝试折叠 / 工具组折叠）时，自动清空该分支下所有下级展开状态，同级其他回合不受影响。
3. **加号多功能菜单、思考深度滑块/Harness 快切 & 悬停双浮层卡（`lib/patches/usage-rings.cjs`）**
   - **底部输入框 `+` 多功能菜单**：将原回形针附件按钮升级为 ChatGPT 风格 `32×32px` 圆形 `+` 按钮（`17px` 图标，带常驻/悬停/按压分阶圆底纹），点击展开分组菜单（`添加`：文件和图片 / `@` 引用工作区文件 / `$` 技能与扩展；`模式与命令`：`/btw` 侧边对话 / 压缩上下文 / 新建干净上下文 / `/` 全部斜杠命令），菜单图标统一锁定 `15px` / `1.35px` 线宽。
   - **完全替换原生三栏模型面板（ChatGPT 双面板一体设计）**：
     - **模型 & Harness 按钮（`[ 图标 模型名 ]`）**：点击展开 ChatGPT 风格 `288px`「选择模型」卡片——顶部为严格过滤后的**仅已开启可用 Harness 2 列网格**（默认展示 4 个，超出可点「展开 +N / 收起」）、中段为简洁单列模型列表（多模型自动出现搜索框）、底部集成 T3 原生访问权限切换与「思考深度 ›」直达入口。
     - **独立思考深度按钮（`[ ▂▄▆ High ]`）**：不再与模型按钮重复显示，点击展开纯正 ChatGPT 风格推理强度滑块卡片（`⚡` 快速模式开关、`↺` 恢复默认、点击/拖拽/键盘吸附的靛蓝分段滑块、以及模型名直达入口），两张面板设计语言完全统一且一键互通。
   - **底部双胶囊（悬停直接展开 + 同款 `8px` 圆角灰底纹响应）**：
     - 左下角 `◎ 84%` 额度双环：**实时联动当前选中模型**（多模型独立额度池下自动匹配如 `Gemini` / `Gemini 4 Argon` / `Claude & GPT (shared)`，低额文字与圆环同步变橙/红），悬停展开「**用量**」卡片（当前模型额度行标有「当前」徽标 + 5h/7d 各自独立换行重置倒计时 + 「查看完整用量 →」跳转）。
     - 右下角 `19% · 204k ◔` 上下文直显（支持费用自动拼接）：悬停展开「**上下文与统计**」卡片（上下文进度条与自动压缩刻度线、会话费用/缓存命中/回合与步骤统计、本轮耗时与输入输出、Token 细分统计）。
   - **右侧详情面板**：自动配对同一模型的 `5h` / `7d` 窗口为双层同心圆环（外环 7d 陶土橙、内环 5h 翡翠绿，低额度自动变警告橙/红），统一 `px-2.5` 左对齐，上下文圆环悬停同步展开「上下文与统计」浮层。
   - **自动激活与还原**：`install.cmd` 会自动在 `settings.json` 中激活 `chatgpt-app` 主题，`uninstall.cmd` 会同步还原默认主题与纯净原版 `server.asar`。

## 使用方法

### 方式一：双击一键脚本（推荐）
- **查看状态**：双击 `status.cmd`
- **一键安装**：先关闭所有 T3 Code 窗口 → 双击 `install.cmd` → 重新打开 T3 Code
- **一键卸载**：先关闭所有 T3 Code 窗口 → 双击 `uninstall.cmd` → 重新打开 T3 Code

### 方式二：命令行
```powershell
node cli.cjs status                  # 查看安装状态与备份完整性
node cli.cjs install                 # 安装全部模块（主题 + 两项前端补丁）
node cli.cjs install --theme-only    # 仅更新主题（无需退出 T3 Code）
node cli.cjs uninstall               # 完整卸载并逐字节还原原版 server.asar
node cli.cjs uninstall --keep-theme  # 仅卸载前端补丁，保留主题
node tests/verify.cjs                # 运行自动化单元测试与 ASAR 试构建校验
```

## 安全保障
- 安装前自动备份纯净原版为 `server.asar.before-t3code-enhancer`（若此前已安装过旧版 `patch-timeline-collapse.cjs`，会自动继承其纯净原版备份，绝不覆盖原版）。
- 写入前自动进行 ESM 语法检查、SHA-256 块完整性重算、以及所有未修改文件的逐字节一致性校验。
- T3 Code 后续版本更新覆盖 `server.asar` 时，可先运行 `node cli.cjs status` 确认兼容性。

## 许可与致谢

本项目是独立的 T3 Code 增强工具，采用 [MIT 许可](LICENSE)。

- 补丁定位使用了 [T3 Code](https://github.com/pingdotgg/t3code) 的部分代码片段。 [T3 Code 许可](licenses/T3-Code.txt)
- 部分面板图标来自 [Lucide](https://github.com/lucide-icons/lucide) 及 Feather。 [Lucide 与 Feather 许可](licenses/Lucide.txt)

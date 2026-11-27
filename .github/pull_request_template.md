## 改动摘要 / Summary

- 解决的问题或新增的能力：
- 涉及模块（`theme` / `privacy` / `composer` / `chat` / `workspace` / `infra`）：
- 若为社区 PR 集成或关联 Issue（如 `Closes #123`）：

## 架构与红线自检 / Checklist

- [ ] 零外部依赖（`package.json` 无 `dependencies` / `devDependencies`）
- [ ] 修改了补丁注入结构时，已递增 `MARKER` 并将旧值加入 `LEGACY_MARKERS`
- [ ] 外置运行时 `lib/runtime/*.mjs` 保持零顶层 `import`，且同步登记在 `PATCH_RUNTIME_NAMES`
- [ ] 兼容 Windows 双档（`server.asar` + `app.asar`）与 Linux/macOS 合并单档（`app.asar`）
- [ ] 保持 `install.sh` 为 LF + `100755`、`*.cmd` 为 CRLF

## 验证结果 / Verification

- [ ] `npm run preflight -- --ci`
- [ ] `npm test`（Suite 1 ~ 16，注明 T3 Code 基线版本：）
- [ ] `npm run test:full`（Suite 17 ~ 18，改引擎/跨端事务或发版前必选）
- [ ] `npm run test:e2e`（改前端 UI/主题/布局时推荐）
- 尚未实机验证的平台或边界说明：

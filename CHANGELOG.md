# Changelog

## 0.1.0 — 2026-11-11

- 首个独立仓库版本。
- 包名/插件 id：`@local/gloss`（原名 `@local/reading-notes`）。
- 批注块首尾标记由「阅读批注」改为「批注」；旧草稿里的旧标记块不会被解析。
- 选区锚定优先取选区起点：修复「从消息末尾拖选到消息外时轮次号丢失」。
- `install.mjs` 支持从旧名 `@local/reading-notes` 迁移（清 dependency / symlink / patch 段）。
- 离线验证：18 项纯函数单测 + 6 项冒烟测试通过。

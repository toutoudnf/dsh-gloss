# gloss

> **gloss** /ɡlɒs/ n. 夹注——为解释某段文字而加的短注。
>
> A [DSH](https://github.com/deepseek-ai/deepseek-harness) client plugin: gloss passages while reading a long
> answer, let the notes accumulate in the composer draft, then send them all in one message. The model replies
> point by point, quoting each passage you marked.

`gloss` 把「读完长回答 → 记住想问什么 → 再打一大段字」变成：
**选中一段 → 写一句 → 继续读 → 读完全部按一次 Enter 提交**。

## 状态

- **P0 / MVP**，个人日常使用中。
- 在 **DSH Desktop 0.2.1-rc.5（Electron 44.7.0）** 上验证；依赖 DSH 的半公开客户端契约，升级后可能需要回归（见[兼容性与风险](#兼容性与风险)）。
- 端到端真实链路已验证过一次：两条夹注 → 自动累计 → 同一条用户消息提交 → 模型按编号回应（2026-11-11）。
- 改名后的构建（`@local/gloss`）还需页面手测一轮；本仓库代码 = 改名后的代码。
- 无网络请求、无遥测；批注在提交前只存在于本地输入框草稿 / localStorage。

## 功能

- **划词即批注**：选中助手回答里的任意文字 → 选区旁出现「＋ 批注」→ 写问题 / 想法 / 只标记。
- **自动累积**：每条夹注自动写进输入框草稿里一个带标记的批注块；继续读、继续加，块持续累积。
- **一次提交**：读完按一次 Enter，块作为**一条普通用户消息**发出；模型看到的是「编号 + 轮次 + 引用原文 + 批注」。
- **托盘**：输入框下方「✎ 批注 N 条」，可展开、跳回原文轮次、编辑、删除、清空、切换自动同步。
- **不打断阅读**：保存后不抢焦点、不滚动（写入走 DSH 草稿接口，不聚焦输入框）。
- **防破坏守卫**：草稿里有 `/` 命令、`@` 文件引用、正在发送时，不自动改写草稿，转为「待同步」。
- **可恢复**：草稿就是唯一事实源；刷新、切会话、发送失败恢复后，托盘都会从草稿重新解析出来。

## 安装

前置：DSH Desktop（已装并至少启动过一次），Node.js 18+。

```bash
git clone git@github.com:toutoudnf/dsh-gloss.git
cd dsh-gloss
node install.mjs
```

- `install.mjs` 会把本目录以 `link:` 形式装进当前 profile（默认 `~/.dsh/profiles/desktop`），
  往 `node_modules` 建 symlink，并在 profile 的 `cordis.patch.yml` 追加一行带标记的 `insert`。
- 写入前会把 profile 的 `package.json` / `cordis.patch.yml` 备份到 `.backup/`。
- 换 profile：设置 `DSH_PROFILE_DIR=/path/to/profile`。
- **装完刷新 DSH 页面**。之后改 `client.js` 需要在 profile patch 里制造一次真实内容变化才会触发 Host 热重载，再刷新页面。

另一条官方安装路径是让 DSH agent 用 `plugin_manager` 的 `install_bundle`（需审批）；本插件**未验证**该路径。

## 用法

1. 选中助手长回答里的一段文字，点「＋ 批注」。
2. 选类型（问题 / 想法 / 标记），写一句，`⌘/Ctrl+Enter` 保存。
3. 继续读、继续加。每条都会进输入框草稿，托盘显示数量。
4. 读完后按 Enter 一次性提交。生成的消息示例：

```
====== 批注（DSH 自动收集，请按编号逐条回应）======
1) 位置：第2轮回答
   类型：问题
   引用：厂商口径称补贴率为 12%
   批注：这里的数字是官方口径还是第三方转述？
2) 位置：第5轮回答
   类型：想法
   引用：可以按「投入-产出-验证」展开
   批注：想看看能不能套到我们自己的方案里
====== 批注结束 ======
```

块外你自己打的字不会被插件改动；发送时一起发出。引用空白折叠并截断到 800 字，单条批注上限 4000 字，
整批上限 20 条。多行内容用「   |」续行编码，解析时还原换行。

## 怎么实现的（一句话版）

纯 **Client 插件**（Host 半只有空 `apply()`）：`shell.overlay` 负责选区和输入浮层，
`conversation.composer.dock` 负责托盘并调用 DSH 的 `inputActions.setDraft()` 写草稿。
**设计取舍**：草稿里的批注块是唯一事实源，托盘只是 `parseBlock(draft)` 的视图——
DSH 自己会持久化草稿、发送成功即进历史、发送失败自动恢复，所以不需要第二份状态。

细节（槽位、块格式、选区锚定、守卫、失败矩阵）见 [docs/architecture.md](docs/architecture.md)。

## 兼容性与风险

| 依赖 | 说明 | 失效时 |
|---|---|---|
| `inputActions`（`setDraft` / `submit`） | 会话作用域 slot 的「标准 prop」，DSH 客户端非正式 API | 托盘提示不可写，降级为「复制批注块」手动粘贴 |
| `[data-chat-turn]` DOM 属性 | 聊天行上的轮次号，用于「第 N 轮」与跳转 | 降级为「只按引用原文定位」，不影响批注保存 |
| `shell.overlay` 槽位 | root 作用域的覆盖层，用于选区浮标 | 备用方案：把浮层挂到 `conversation.input.overlay` |

DSH 版本升级后请先跑一遍「安装后验证」清单。

## 已知限制

- **真实页面行为**仍需在每个 DSH 版本上手测：`setDraft` 是否滚动/抢焦点、浮层定位。
- **`setDraft` 是整段纯文本重写**：草稿里有 `@` 文件引用 chip 或斜杠命令时会拒绝自动写入（宁可暂存也不破坏草稿）。
- **多窗口/多标签同会话**：草稿各自一份，不保证同步。
- **手动改坏批注块**：托盘进入「手改模式」（只读 + 复制），不再自动覆盖。
- **旧标记不兼容**：本插件早期用「阅读批注」作为块首标记，改名后改为「批注」；旧草稿里的块会被当普通文本，手动删掉即可。
- **UI 文案目前只有中文**：`locale/{zh,en}.json` 只覆盖插件管理页标题/描述。
- **尚未实现**：每轮「批注 N」角标、正文持久高亮、快捷键、右侧栏面板、导出。

## 开发

没有第三方运行时依赖；React 从 DSH 的浏览器模块表拿。仓库自带两套离线测试：

```bash
npm run check       # 语法检查（client.js / index.js / install.mjs / uninstall.mjs / tests）
npm test            # 纯函数单测：块格式/解析/合并/排序/上限/完整流程
node test-smoke.mjs # 冒烟：ModuleLoader 载入 → factory → apply 注册 → 组件渲染（极简 React 替身）
```

CI：`.github/workflows/check.yml` 在 push/PR 上跑同样的检查（无需安装依赖）。

目录：

```
client.js              # 全部插件逻辑（纯函数区 + 选区浮层 + 批注托盘 + 样式）
index.js               # Host 半：空 apply() + 心跳
package.json           # DSH 插件清单（dsh.bundle.patch / dsh.client）
cordis.patch.yml       # bundle 自带的启用 patch
install.mjs            # 装进 profile（含旧名 @local/reading-notes 残留清理）
uninstall.mjs          # 卸载
locale/{zh,en}.json    # 插件管理页标题/描述
docs/architecture.md   # 设计说明
```

## 卸载

```bash
node uninstall.mjs
```

撤掉 profile 里的 dependency / symlink / patch 段，并清掉旧名残留；不删 `.backup/`。
浏览器端数据：批注块在草稿里（随会话走）；localStorage 里只有
`dsh.gloss.backup.v1.<sessionId>`（误删恢复备份）和 `dsh.gloss.auto-sync.v1`（开关）。

## License

[MIT](LICENSE)

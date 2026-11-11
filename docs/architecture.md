# gloss 设计说明

> 本文说明 `gloss` 的实现取舍，便于维护与适配新的 DSH 版本。验证基线：DSH Desktop 0.2.1-rc.5（Electron 44.7.0）。

## 1. 形态：纯 Client 插件

DSH 的浏览器插件由「已启用的 Loader 条目」扫描 `package.json` 的 `dsh.client` 后下发。
所以 `gloss` 有一条 Host 行，但 Host 半只有空的 `apply()`（外加写 `.host-loaded.log` 心跳）；
全部逻辑在 `client.js`，通过 `window.__ModuleLoader__.load({ id, factory })` 注册，React 从模块表取。

不 import 任何 `@deepseek-ai/dsh-client-ui-*` 包；样式只使用宿主主题 token（`--dsw-alias-*`），
随插件 `apply` 注入并随卸载清理。

## 2. 三个挂载点

| 挂载点 | 作用域 | 职责 |
|---|---|---|
| `shell.overlay` | root | 监听选区、渲染「＋ 批注」浮标与批注输入浮层（视口级 fixed 定位） |
| `conversation.composer.dock` | session | 批注托盘；持有 `inputActions` / `useInput`，负责把批注写进草稿 |
| `sidebar.right.tab.document.actions` | session | 只在文件预览头部渲染一个隐藏标记（`data-gloss-file-path`），把 Host 绝对路径暴露给选区逻辑；不显示 UI |
| `conversation.chat.turnTail`（roadmap） | session | 每轮尾部的「批注 N」角标 |

为什么浮标不放在 composer 的 dock 里：dock 在输入卡片内部，可能有 overflow/clip；`shell.overlay`
是 DSH 用来覆盖整个框架的层。

## 3. 唯一事实源：输入框草稿里的批注块

块格式（v1）：

```
====== 批注（DSH 自动收集，请按编号逐条回应）======
1) 位置：第2轮回答
   类型：问题
   引用：原文……
   批注：我的问题
2) 位置：文件 调研/2026-10-15-xxx.md
   章节：已知限制
   类型：问题
   引用：文件里的原文……
   批注：对这段文件内容的想法
====== 批注结束 ======
```

- `位置` 有两种形态：`第N轮回答`（聊天）与 `文件 <相对路径>`（文件预览）；`章节` 是文件批注的可选字段。

- 块外是用户自己打的字，插件只替换块内。
- `引用` 空白折叠 + 单行化 + 800 字截断；`批注` 上限 4000 字；整批 20 条。
- 多行内容用 `   |` 续行，避免和 `类型/引用/批注` 字段名冲突。
- 解析失败（用户手改）→ 托盘进入「手改模式」，停止自动改写。

**为什么以草稿为事实源**：

1. DSH 自己按会话持久化草稿，刷新/切会话自动恢复；
2. 用户按 Enter 后，块就是会话历史里的 user message，不需要插件再写一遍；
3. 发送失败时 DSH 会恢复草稿，块跟着回来，托盘用 `parseBlock(draft)` 即可恢复；
4. 只有一份状态，不会出现「托盘 3 条、草稿 2 条」的双写不一致。

localStorage 只存**误删恢复备份**（`dsh.gloss.backup.v1.<sessionId>`）和自动同步开关。
备份清理用 `phase` 启发式：观察到 `submitting/adjudicating` 时清；手动清空草稿时保留并提供「恢复」入口。

## 4. 选区锚定

选区变化去抖 120ms，过滤条件：

- 非折叠、文字非空；
- 落在 `[data-slot="conversation.chat.flow"]`（兜底 `[data-conversation-scroll]`）内；
- 不在 `input` / `textarea` / `[contenteditable=true]` / 插件自身 UI 内。

锚点元素**优先取选区起点**（其次终点、最后公共祖先）。原因：用户从消息末尾向下拖到消息外时，
公共祖先会落到 flow 容器（没有 `[data-chat-turn]`），轮次号会丢；起点在消息内则仍能拿到正确轮次。

轮次号取自最近的 `[data-chat-turn]`，类型取自 `[data-chat-flow-kind]`；取不到就降级为
「只按引用原文定位」，不阻塞批注保存。

**文件预览分支**：选区起点（其次终点、公共祖先）落在 `[data-textpreview-body]` / `[data-document-markdown]`
内时判定为文件批注，优先于聊天 flow。路径来自预览头部 `sidebar.right.tab.document.actions` 槽位里的
隐藏标记（owner prop `absolutePath`），会话来自右栏根的 `data-sidebar-right-session`，再用会话 cwd
换成工作区相对路径；章节取选区起点之前最近的 h1~h6。任何一项取不到都只降级。

## 5. 写入草稿的守卫

`setDraft()` 是**整段纯文本重写**，因此只在安全时机调用：

| 条件 | 行为 |
|---|---|
| `phase === 'plain'` 且无 `claim` | 允许 |
| 有斜杠命令 chip / `claimed` / `submitting` / `adjudicating` | 拒绝，条目留在 pending 队列，托盘显示「待同步」 |
| 草稿里有 `@` 文件引用 chip（`occurrences` 非空） | 拒绝（避免丢引用），提示先清空引用 |
| 焦点在 composer 的 contenteditable 里 | 暂缓，避免抢光标 |

overlay 是 root 作用域，拿不到 `inputActions`，所以它只把批注写进模块级 pending 队列；
由 session 作用域的托盘消费队列并写草稿。

## 6. 提交与模型体验

提交就是 DSH 原生的 Enter 发送（发送中按用户设置 queue/steer），插件不拦截发送。
草稿清空 → 块消失 → 托盘自然为空。块首行带指令，模型按编号逐条回应；
每个条目自带引用原文 + 轮次号，模型不需要回看上下文就能定位。

## 7. 兼容性与失败矩阵

| 依赖 | 失效表现 | 降级 |
|---|---|---|
| `inputActions` 标准 prop | 无法写入草稿 | 托盘提供「复制批注块」手动粘贴 |
| `[data-chat-turn]` | 轮次号/跳转不可用 | 只按引用原文定位 |
| `shell.overlay` | 浮标无处挂 | 可改挂 `conversation.input.overlay` |
| `[data-textpreview-body]` / `[data-document-markdown]` | 认不出文件预览选区 | 文件批注不出现，聊天批注不受影响 |
| `sidebar.right.tab.document.actions` | 文件路径拿不到 | 位置降级为「文件（路径未知）」，批注仍可保存 |
| 多窗口同会话 | 后写覆盖前写 | 不支持，文档明示 |
| 发送/清空时序 | 可能残留「恢复上次批注」提示 | 用户点「忽略」 |

## 8. Roadmap

- P1：每轮「批注 N」角标、跳转临时高亮、CSS Custom Highlight 持久高亮、快捷键、类型标签。
- P1.5：文件批注的源码行号（需要接管 Markdown 渲染器或在 Host 侧比对原文，代价较高，暂不做）。
- P2：右侧栏批注清单面板、导出 Markdown/JSON、跨会话汇总。
- P3：把块解析与选区锚定抽成可复用模块，或向上游提通用能力建议。

## 9. 证据基线

实现时对照的 DSH 客户端包（聊天批注 0.2.1-rc.5；文件批注 0.2.2-rc.1）：

- `@deepseek-ai/dsh-client-ui-conversation/lib/client.js`：`inputActions` 实现、`uiSession.provide` 标准 prop、
  输入快照（`draft` / `phase` / `occurrences`）、`conversation.composer.dock` 声明。
- `@deepseek-ai/dsh-client-ui-chat/lib/client.js`：聊天行 `data-chat-turn` / `data-chat-flow-kind`、
  `conversation.chat.turnTail` 渲染、`shell.overlay` 注册示例。
- `@deepseek-ai/dsh-client-ui-layout/README.zh.md`：`shell.overlay` 覆盖整个框架。
- `@deepseek-ai/dsh-experimental-client-ui-voice-input/lib/client.js`：真实插件使用 `inputActions.insertText` 的范例。
- `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js`：`data-textpreview-body` /
  `data-document-markdown` 正文容器、`sidebar.right.tab.document.actions` 的 owner prop `absolutePath`。
- `@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js`：`data-sidebar-right-session` / `data-sidebar-right-tab`。
- `@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js`：插件消费 `sidebar.right.tab.document.actions` 的官方范例。

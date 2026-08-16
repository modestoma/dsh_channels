# dsh-channels · 飞书渠道插件 可行性验证与设计（v1）

> 状态：可行性验证完成 ✅ —— 需求清单 14 项，14 项均可基于飞书官方 SDK（`@larksuiteoapi/node-sdk` 1.73.0）与 DSH 现有扩展点实现。
> 验证方式：官方 Node SDK 1.73.0 npm 包类型定义 + 官方文档原文 + 社区先例（nanobot、dsh-im-feishu）。

## 1. 结论

| # | 需求点 | 结论 | 支撑 |
|---|--------|------|------|
| 1 | 一个 dsh 实例对应一个飞书机器人 | ✅ | 插件读取单组 appId/appSecret 凭据，启动一个 WSClient 长连接 |
| 2 | 私聊 | ✅ | `im.message.receive_v1` 事件 `chat_type = "p2p"` |
| 3 | 群聊 @ 机器人 | ✅ | 事件 `mentions[]` 含被 @ 成员，比对机器人 open_id |
| 4 | 话题群 @ 机器人 | ✅ | 话题群消息事件自带 `thread_id`，@ 判定同 #3 |
| 5 | 收到消息立刻回 “Typing” 表情 | ✅ | `im.v1.message.reaction.create`，官方内置表情 `emoji_type: "Typing"`（官方表情文案说明文档收录，非自定义表情） |
| 6 | 立刻基于该条消息创建话题 | ✅ | `im.v1.message.reply` + `reply_in_thread: true`（官方文档明示“以话题方式进行回复（即创建话题）”）；响应返回 `thread_id` |
| 7 | 私聊也能创建话题 | ⚠️ 大概率 ✅ | `reply_in_thread` 文档未限制 chat_type；飞书客户端支持单聊话题。**需真机验证**，失败则降级为“单聊整体即话题”（见 §7 风险 R1） |
| 8 | 基于话题创建 session，话题内后续消息延续该 session（无需再 @） | ✅ | 事件携带 `thread_id`；插件维护 `thread_id → sessionId` 映射，`thread_id` 命中即路由到既有 agent（`agent.followup()`） |
| 9 | 私聊：用户 × 机器人 = 一个工作区 | ✅ | DSH 工作区=磁盘目录：`<data>/p2p/<open_id>/`，`ctx.workspaceRegistry.create(path, title)` |
| 10 | 群聊：用户 × 群 = 一个工作区（同群不同用户互不影响） | ✅ | `<data>/groups/<chat_id>/<open_id>/`，session 以 `meta.cwd` 落盘归属该工作区 |
| 11 | 流式卡片（card schema 2.0），500ms 刷新 | ✅ | `msg_type: "interactive"` 卡片 2.0 JSON；`im.v1.message.patch` 整体替换卡片。单条消息更新限频 **5 QPS**（官方文档），2 QPS（500ms）安全 |
| 12 | 折叠面板：带边框、默认折叠、标题三态、右侧箭头随折叠翻转 | ✅ | 卡片 2.0 原生组件 `collapsible_panel`：`border`、`expanded: false`、`header.title`、`icon` + `icon_expanded_angle: 180`（展开时箭头旋转向上） |
| 13 | 正文富文本 | ✅ | 卡片 2.0 `markdown` 组件（lark markdown 子集） |
| 14 | session 信息两行小字 | ✅ | `note` 组件 + `img` 图标；数据来自 DSH：session id、usage（input/output/cacheRead/cacheWrite）、`ctx.tokenMeter` 上下文压力、模型/推理强度 |
| 15 | 流式结束：移除 Typing、改回 DONE 表情 | ✅ | `im.v1.message.reaction.delete`（用 create 返回的 reaction_id）+ create `emoji_type: "DONE"`（官方内置表情） |

**结论：第一版可以实现，全部使用飞书官方 SDK，无需任何非官方接口或 hack。**

## 2. 飞书侧事实依据（验证过的官方文档原文）

- 表情：官方[表情文案说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/emojis-introduce) 收录 `Typing` 与 `DONE` 两个内置表情，`emoji_type` 直接填 `"Typing"` / `"DONE"`，**无需上传自定义表情**。
- 创建话题：官方[话题概述](https://open.feishu.cn/document/im-v1/message/thread-introduction) 场景表原文——“以话题的方式进行回复（即创建话题）：调用回复消息接口时，填写参数 `reply_in_thread: true`”。
- 话题延续：回复[回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply) 接口文档——“如果要回复的消息已经是话题形式的消息，则默认以话题形式进行回复”，即对话题内消息 reply 会自动留在原话题。
- 事件：`im.message.receive_v1` 的 `message` 含 `message_id/root_id/parent_id/chat_id/thread_id/chat_type/content/mentions`（SDK 1.73.0 类型定义）。
- 卡片更新：[更新已发送的消息卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch) ——“单条消息更新频控为 5 QPS”，应用级 1000 次/分钟、50 次/秒；卡片消息体上限 **30 KB**。
- 卡片 2.0 折叠面板：[collapsible_panel](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/containers/collapsible-panel) —— 原生支持 `expanded`、`border`、`header.icon`、`icon_expanded_angle`（展开时图标旋转角度）。
- 发送限频：向同一用户 / 同一群发送消息均为 5 QPS（回复消息接口文档）。
- 权限：`im:message.p2p_msg:readonly`（读用户私聊消息）、接收群聊中 @ 机器人消息事件、`im:message`、`im:message.reactions:write_only`、`im:message:update`（卡片更新）。

## 3. 总体架构

```
飞书客户端 ──(WS 长连接, 免公网)──► @larksuiteoapi/node-sdk WSClient
                                        │
                                        ▼
                        ┌───────────────────────────────┐
                        │  dsh-channels (本仓库)    │
                        │                               │
                        │  事件路由器                     │
                        │   ├─ 过滤机器人自己的消息        │
                        │   ├─ 解析 text/post 内容        │
                        │   ├─ @ 判定 (mentions)          │
                        │   └─ thread_id → 会话路由器     │
                        │                               │
                        │  FeishuSessionManager          │
                        │   ├─ storageDomain 持久化:      │
                        │   │    thread_id → sessionId   │
                        │   │    workspaceKey 注册表      │
                        │   ├─ 懒恢复: ctx.agents.resume │
                        │   └─ 新建: ctx.agents.create   │
                        │       (meta.cwd → 工作区目录)   │
                        │                               │
                        │  CardStreamingRenderer         │
                        │   ├─ 订阅 session/event         │
                        │   │    (assistant/chunk:        │
                        │   │     文本 + reasoning 增量)  │
                        │   ├─ 500ms 节流 → patch 卡片    │
                        │   └─ whenIdle → 终态 + DONE     │
                        │                               │
                        │  ReactionController            │
                        │   └─ Typing 添加/移除、DONE 添加 │
                        └───────────────┬───────────────┘
                                        │ ctx.agents / ctx.workspaceRegistry
                                        │ ctx.tokenMeter / ctx.storageDomain
                                        ▼
                              DSH Host（agent-loop + LLM + persistence）
```

### 3.1 关键映射与状态

| 概念 | 映射 | 存储 |
|------|------|------|
| 工作区（私聊） | `(bot, open_id)` → 目录 `<data>/p2p/<open_id>/` | `ctx.workspaceRegistry` + 磁盘 |
| 工作区（群聊） | `(bot, chat_id, open_id)` → 目录 `<data>/groups/<chat_id>/<open_id>/` | 同上 |
| session | `thread_id` → DSH `sessionId`（每话题一个） | 插件 `storageDomain` 域 `channels_routes` |
| 会话延续 | 事件 `thread_id` 命中映射 → `agent.followup()` | — |

### 3.2 消息处理流程

**首次触发（私聊任意消息 / 群聊 @ 消息）：**

1. 收到事件 → 异步 `reaction.create("Typing")`（非阻塞，记录 reaction_id）。
2. 确定工作区目录（不存在则 mkdir + `workspaceRegistry.create`）。
3. 通过 `im.message.reply(message_id, { reply_in_thread: true, msg_type: "interactive", content: 卡片初始 JSON })` 创建话题并发出卡片第一帧（折叠面板标题“推理中”），拿到 `thread_id` + `message_id`。
4. `ctx.agents.create({ sessionId: <uuid>, meta: { cwd: 工作区目录 }, agentOptions: { provider, model, maxTokens }, setup: 安装 effort 等 })`；`setup` 中注入首个 user 消息（`seed` 或创建后 `followup`）。
5. 持久化 `thread_id → sessionId` 映射。

**话题内续聊（无需 @）：**

1. 事件带 `thread_id` 且映射命中 → `agent.followup(user message)`（排队进 next-turn 队列）。
2. 若 agent 已因重启消失 → `ctx.agents.resume({ resumeSessionId })` 懒恢复后 followup。

**话题群（话题形式群）：** 事件必带 `thread_id`；未映射的话题上收到 @ 消息 → 建 session；已有映射 → 直接续聊。机器人不在话题群内“创建”话题（话题由成员在客户端创建），只在话题内回复。

**流式渲染：**

- 订阅 `session/event`，按 `(sessionId, turn)` 聚合：`assistant/chunk` 里 `text-delta` → 正文，`reasoning-delta` → 折叠面板内容。
- **活动状态行**：`tool/call`（含 subagent 的 description、workflow 的 meta.name）与 `tool-workflow/run-start / agent-start / agent-end / run-end`（workflow 进度：完成数/总数、阶段、活动成员、结束原因）折叠为一条小字状态行（正文上方），并在无正文输出的等待期以 `statusRefreshMs`（默认 5s）慢心跳刷新“已运行 Ns”计时——进入 subagent / workflow 时卡片不再静默等待。
- 500ms 节流器（仅内容变化时 patch），拼接卡片 2.0 JSON 全量 `im.v1.message.patch`。
- 折叠面板标题三态：首个 reasoning 增量前“推理中”；推理结束、正文开始后“回复中”；`agent.whenIdle()` 后“回复结束”。
- 终态：`reaction.delete(Typing)` → `reaction.create("DONE")`。

### 3.3 卡片 JSON（卡片 JSON 2.0 结构）

> 整卡采用**当前 2.0 结构**：声明 `schema: "2.0"`，组件统一放在 `body.elements` 下。2.0 是富文本（标题/引用/表格/代码块）和流式能力的第一等结构，官方 Lark 机器人扩展现行实现同款。注意两点踩坑史：
> - `schema: "2.0"` 与顶层 `elements` 混用会被拒（`230099 / 200621: unknown property, property: elements`）——2.0 的组件必须在 `body` 里；
> - 折叠面板 header 的 `icon` 只支持 `standard_icon`（图标库 token）或 `custom_icon`，`tag: "img"` 非法（面板会被客户端丢弃）；此处用内置 `down-small-ccm_outlined` 下箭头，无需上传图片。

```jsonc
{
  "schema": "2.0",
  "config": { "width_mode": "fill" },
  "body": {
    "elements": [
      { // 第一段：推理折叠面板
        "tag": "collapsible_panel",
        "expanded": false,
        "border": { "color": "grey", "corner_radius": "8px" },
        "header": {
          "title": { "tag": "plain_text", "content": "推理中" }, // 推理中|回复中|回复结束
          "icon": { "tag": "standard_icon", "token": "down-small-ccm_outlined" }, // 折叠向下
          "icon_position": "right",
          "icon_expanded_angle": 180 // 展开时旋转 180° → 箭头向上
        },
        "elements": [ { "tag": "markdown", "content": "<推理内容>" } ]
      },
      { "tag": "hr" },
      { // 第二段：回复正文（富文本 markdown，2.0 全语法）
        "tag": "markdown", "content": "<正文>"
      },
      { "tag": "hr" },
      { // 第三段：session 信息，两行小字（2.0 无 note 组件 → markdown + notation 字号）
        "tag": "markdown",
        "text_size": "notation",
        "content": "🔑 om_session_xxxx · ⬆ input token 12,345 · ⬇ output token 678"
      },
      { "tag": "markdown", "text_size": "notation",
        "content": "🧠 模型 deepseek-v4-pro(max) · ⚡ 缓存命中 87.3% · 📊 上下文 24.1k/128k" }
    ]
  }
}
```

- 第一行：`session id · input token · output token`（session 累计；可配置为按本轮回复合计）。
- 第二行：`模型 model(effort) · 缓存命中 cacheRead/(cacheRead+input) · 上下文 pressureTokens/contextWindow`。
- 单卡片 JSON 目标 ≤ 28 KB（飞书上限 30 KB，留 2 KB 冗余给切分后 token 数字增长）；正文超长时**自动分段投放**——在段落/标题/代码块边界切分，**每张卡最多 5 个表格**（飞书硬限制 230099/11310，表格绝不从中间切断），续片以「回复分段 n」卡片跟进同一话题，全文无丢失；续卡被拒收时自动降级为纯文本消息；推理不跨卡，按首卡剩余预算截断且面板内表格省略（正文优先）。

## 4. DSH 侧集成点（全部为公开扩展点）

| 用途 | API |
|------|-----|
| 建 session + agent | `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup })` |
| 恢复 session | `ctx.agents.resume({ resumeSessionId, setup })` |
| 续聊入队 | `agent.followup(message)`（next-turn FIFO，自动唤醒驱动） |
| 流式增量 | 订阅 `session/event`，`assistant/chunk`（`StreamChunk` 含 `text-delta` / `reasoning-delta`），`assistant/message` 锚点含 usage |
| token / 缓存 / 上下文 | usage：`{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }`；上下文：`ctx.tokenMeter.measure(session)` + `ctx.llm.resolveModelInfo().context` |
| 工作区 | `ctx.workspaceRegistry.create(path, title)`（目录存在才可注册） |
| 插件自身状态 | `ctx.storageDomain`（defineDomain + sqlite/json 后端） |
| 加载方式 | 用户 cordis.yml 增加 `- name: '/path/to/plugin/src/index.ts'`（教程 07 确认本地文件路径加载，支持 HMR） |

依赖宿主已配置：`dsh-agent-loop`、`dsh-llm-deepseek`、`dsh-session-persistence-*`、`dsh-storage-*`、`dsh-token-meter`（推荐）、`dsh-workspace`。

## 5. 风险与不确定点

| # | 风险 | 等级 | 对策 |
|---|------|------|------|
| R1 | 私聊 `reply_in_thread` 是否生效未经文档明示 | 中 | 真机验证；失败自动降级：私聊整体视为“话题”，续聊继续同一 session（行为退化为常规 DM 机器人），不阻塞主流程 |
| R2 | patch 全量替换卡片：用户手动展开折叠面板后，下一次 patch（500ms 内）会把它重新折叠 | 低（体验） | v1 接受：流式期间保持默认折叠；流式结束后不再 patch，用户可自由展开。备选：CardKit 2.1 局部更新（需评估申请门槛），列入 v2 |
| R3 | 卡片 30 KB 上限 / 单卡表格数量上限（230099/11310） | 低 | 单卡预算 28 KB（2 KB 冗余）；正文超长按干净断点分段投放（每卡 ≤ 5 表，表格不断裂，全文保留）；续卡被拒降级纯文本；推理按剩余预算截断 |
| R4 | 消息/表情/更新的 5 QPS 限频 | 低 | patch 2 QPS 天然安全；多个并发 session 时加全局节流与 429 退避重试（错误码 230020） |
| R5 | 机器人收不到自己发的消息（需过滤） | 低 | 事件 `sender.sender_type` / open_id 过滤 |
| R6 | 用户撤回触发消息 | 低 | reaction 调用失败静默容忍（错误码 231002 等），不阻断流程 |
| R7 | 话题群中机器人回复方式 | 低 | 对话题内消息 reply 默认即话题回复（官方文档确认），无需 reply_in_thread |

## 6. 实施计划

| 里程碑 | 内容 | 产出 |
|--------|------|------|
| M0 脚手架 | pnpm workspace、`src/index.ts` 插件骨架（apply(ctx) + Config schema）、类型声明合并 | 可加载的空插件 |
| M1 飞书接入 | WSClient 长连接、事件订阅、文本/post 解析、@ 判定、凭据配置（`ctx.credentials` 凭据库引用，不落明文） | 能收消息并回文本 |
| M2 话题与路由 | Typing/DONE reaction、reply_in_thread 建话题、storageDomain 路由表、懒恢复、工作区目录创建 | 私聊/群聊/话题群三通道贯通 |
| M3 流式卡片 | 卡片 2.0 渲染器、session/event 订阅、500ms 节流 patch、折叠面板三态、session 信息两行 | 完整流式体验 |
| M4 联调加固 | 真机自建应用全流程验证（含 R1 私聊话题）、限频/退避/异常兜底、README + 配置文档 | 可交付 v1 |

## 7. 仓库结构（计划）

```
dsh_channels/
├── docs/feasibility-and-design.md   # 本文档
├── src/
│   ├── index.ts                     # 插件入口 apply(ctx)
│   ├── config.ts                    # 配置 schema（appId/appSecret 为凭据引用名，经 ctx.credentials 解析）
│   ├── feishu/client.ts             # WSClient 生命周期
│   ├── feishu/events.ts             # 事件路由/过滤/@ 判定
│   ├── feishu/reactions.ts          # Typing/DONE 控制器
│   ├── feishu/threads.ts            # reply_in_thread 建话题/回复
│   ├── feishu/card.ts               # 卡片 2.0 JSON 渲染器（折叠面板/正文/信息行）
│   ├── core/workspace.ts            # (chat,user) → 工作区目录
│   ├── core/sessions.ts             # thread_id → sessionId 路由 + 懒恢复
│   └── core/streamer.ts             # session/event 聚合 + 500ms 节流 patch
├── tests/                           # 以 stub 官方 SDK 的单元测试
└── package.json                     # 依赖 @larksuiteoapi/node-sdk + DSH peer 包
```

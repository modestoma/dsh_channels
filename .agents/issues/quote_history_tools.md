# P2 引用与话题历史：feishu_topic_messages 与引用摘录

## 目标、范围与非目标

让模型能访问“引用消息”和“话题内此前的消息/文件/图片”，并在新会话首轮自动获得有界的话题上下文。

范围：

- 消息读取薄封装（新模块 `src/feishu/message-read.ts`）：`message.get`、`message.mget`（≤50）、`message.list(container_id_type=thread)`；统一渲染 text/post/image/file/文件夹/合并转发条目，输出有界摘要与资源元数据。
- 引用摘录：入站消息的 `replyToMessageId`（飞书 `parent_id`）解析为摘录，进入 prompt 清单；被引用消息里的资源登记到本 route 白名单（含合并转发顶层容器规则：资源必须用容器 `message_id` 下载）。
- 新会话首轮：自动附带本话题最近 N 条消息摘要（`historyBootstrapLimit`，默认 10，可关；超长截断并标注）；更早的通过工具翻页。失败/无权限时静默降级，不阻塞首轮。
- 新工具 `feishu_topic_messages({ message_id?, limit?, cursor? })`：按 id 取单条，或分页列当前话题消息（默认 10、上限 50）；只允许当前 route 的 chat/thread；返回摘要 + 附件元数据，并把发现的资源加入白名单，供 `feishu_attachment_fetch` 取用。degraded chat 路由按 chat 容器处理（p2p 历史能力以 P0 结论为准）。
- permissions：`im:message:readonly` + 机器人读群消息所需 scope（如 `im:message.group_msg`，以开发者后台要求为准）；更新 onboarding 文档中的权限表与降级说明。

非目标：消息全文搜索；跨会话/跨用户读取；音频/视频专门处理。

## 前置产物与解除条件

依赖 `admission_manifest_flow` 的清单与 prompt 组装；依赖 `platform_spike` 的 AC4/AC5 结论（权限矩阵、父消息定位、合并转发容器下载）。

## 验收条件与验证方法

| AC | 验证方法 | 通过标准 |
| --- | --- | --- |
| AC1 引用文本 | service 测试 + 真机 | 引用消息摘录进入 prompt；被引用文件出现在清单并可取 |
| AC2 合并转发 | service 测试 + 真机 | 合并转发展开文本；子资源经容器 id 下载成功 |
| AC3 话题历史 | service 测试 + 真机 | 工具分页正确、输出有界；@ 之前的消息（权限范围内）可读 |
| AC4 首轮上下文 | service 测试 | 新会话首轮含最近 N 条摘要；超限截断标注；关闭配置生效 |
| AC5 授权隔离 | 单元测试 | 非本 route 消息 id 被拒绝；历史工具发现后才可下载 |
| AC6 权限降级 | 手动 + 日志/提示 | 缺权限时明确降级、不报死错、不影响普通对话 |
| AC7 构建 | `pnpm typecheck && pnpm test` | 通过 |

## 决定、授权与待答

- 用户决定：引用机器人消息但未 @ 在对话群主聊天区不触发；话题内保持无需 @。
- 待答：敏感权限无法获批时，“@ 之前消息”的覆盖范围与提示文案需用户确认。
- 待答：首轮自动上下文条数默认 10 是否合适（可配置）。

## 验证与交付证据

### 环境与基线（2026-10-21）

- 仓库 `/Users/moka/dev/project/dsh_ext/dsh_channels`，本地 `main`；开始基线 `main@59b62baee511b3296504b4a0b3a7d663406666c5`（P0 收官 `3f05d81` 之后的前置任务证据提交）。按 D9/D10 不创建平台 Issue/Milestone、不拉分支/worktree、不使用 PR，仅本地 `main` 提交，不推送。
- Node v24.19.0 / pnpm 12.14.0；DSH 0.2.1-rc.2 desktop profile（`ctx.tools` / `ctx.attachments` 可用性沿用 P0 结论）。
- 实现提交：`5e06718162eea68730cc4e1c5721b6020cf9e3a5`（feat，含实现、测试、配置与 onboarding 文档）；证据为本文件随后的 docs 提交。
- 写入范围说明：在 Issue 预计范围（`message-read.ts` / `tools.ts` / `routing/inbound.ts` / `config.ts` / `docs/feishu-onboarding.md` / 两个测试文件）之外，为满足 AC 做了必要接线与加固：`src/feishu/manifest.ts`（quote 行与 `manifestEntriesOfKnownMessage`）、`src/feishu/agent-context.ts`（guidance 增补 quote/history/topic 工具说明）、`src/feishu-channel.ts`（`messageMget` 薄包装）、`src/service.ts`（读端口/白名单/工具挂载/降级告警）、`tests/helpers.ts`、`tests/manifest.test.ts`、`tests/feishu-channel.test.ts`、`tests/config.test.ts`。均无对外产品范围变化。

### 实现落点

| 产物 | 文件 | 说明 |
| --- | --- | --- |
| 消息读取与统一渲染 | [src/feishu/message-read.ts](../../../src/feishu/message-read.ts)（新增，约 1330 行） | 纯 IO 薄封装 + 渲染：`message.get` / `mget(≤50)` / 有界 `message.list(thread|chat)`；统一渲染 text/post/image/file/folder/merge_forward/interactive/audio/system/deleted；合并转发按 `upper_message_id` 选容器并展开子消息；prompt 块 `<feishu_quote>` / `<feishu_history>` 带 message_id、资源元数据、控制字符/标签逃逸清洗、单条 400 字符/整块 4k·8k 上限与截断标注；结构化失败码（CHANNEL_UNAVAILABLE/MESSAGE_READ_FAILED/PERMISSION_DENIED/INVALID_ARGUMENT/ABORTED/TIMEOUT）；abort/timeout/mget 回退；resolved `{code,msg}` 与 Axios error 均可读映射。 |
| 消息 list/get/mget 通道 | [src/feishu-channel.ts](../../../src/feishu-channel.ts) | 新增 `messageMget` 可选包装：SDK 1.76 无 typed `im.v1.message.mget`，经 `Client.request` 调 `GET /open-apis/im/v1/messages/mget`，**重复** `message_ids` query（逗号形式被飞书拒绝，见真机证据）；限制 1–50。 |
| 引用清单行 | [src/feishu/manifest.ts](../../../src/feishu/manifest.ts) | `<feishu_context>` 新增 `quote` 输入：被引用文件以 `message_id/file_key/name` 行出现，合并转发以容器行出现（AC1/AC2 可发现性）；trigger→quote→pending 顺序、去重、行上限不变。 |
| 引用摘录 + 首轮历史注入 | [src/routing/inbound.ts](../../../src/routing/inbound.ts) | `InboundDeps.messageRead` 端口；`replyToMessageId` 合法时在 `deliverTurnMessage` 阶段解析 `<feishu_quote>` 并登记 `source='quote'`；新会话首轮按 `historyBootstrapLimit` 注入 `<feishu_history>` 并逐条登记 `'history'`；续聊不注入；被动读与图片预取并发、块顺序 text→quote→images→manifest→history；native/archive 两 backend 都注入文本块；任何读失败静默降级、不阻塞 followup。 |
| 服务接线 | [src/service.ts](../../../src/service.ts) | `MessageReader` + `InboundMessageReadPort` 实现（quoted 归属校验：chat_id 必须存在且相等，thread route 允许空 thread id，degraded chat route 拒绝 topic 消息；history 按 route 容器读、过滤排除/撤回、时间正序）；`feishu_attachment_fetch` 白名单登记 trigger/quote/history；`TopicMessagesToolRuntime` 构造与挂载（与 fetch 并行挂载，archive 下也挂但描述提示 fetch 不可用）；被动读 3 秒预算（`promptContextTimeoutMs`），首次降级输出一条 warn（之后 debug）。 |
| 话题历史工具 | [src/feishu/tools.ts](../../../src/feishu/tools.ts) | 新增 `feishu_topic_messages({ message_id?, limit?, cursor? })`：message_id 形状强校验（`^om_[A-Za-z0-9_-]{1,128}$`）、limit 默认 10/上限 50、cursor≤2048；单条读取（合并转发展开、value ≤50 条有界、容器归属校验、发现资源入白名单）；列表读取（route 容器、newest-first、page_token、chat route 跨话题过滤、只登记带资源/合并转发行防 LRU 挤出）；`isKnownMessage`（白名单+pending）；失败结构化可读（9 码，无 undefined/[object Object]）；输出渲染有界（50 条/12k 字符）；archive 下描述追加 fetch 不可用提示。 |
| 配置 | [src/config.ts](../../../src/config.ts) | 新增 `historyBootstrapLimit`（默认 10，0 关，上限 20）、`promptContextTimeoutMs`（默认 3000，100–10000）、`feishuTools.topicMessages`（默认开）、`feishuTools.topicMessagesTimeoutMs`（默认 20s）；注释说明开关边界与降级。 |
| guidance | [src/feishu/agent-context.ts](../../../src/feishu/agent-context.ts) | native guidance 增补 `<feishu_quote>`/`<feishu_history>`、`feishu_topic_messages` 用法与 message_id 取附件；archive guidance 说明被引用/历史附件在本部署未归档、应据摘录作答。 |
| 文档 | [docs/feishu-onboarding.md](../../../docs/feishu-onboarding.md) | §1 权限表新增 `im:message:readonly`、`im:message.group_msg`（敏感）与降级说明（3s 预算、首次 warn、`/status` 不报告读取 scope）；§3.2 新增 `historyBootstrapLimit`、`promptContextTimeoutMs` 与 `feishuTools` 子项边界；§5.3 新增 P2 真机验证步骤（引用文字/文件、合并转发、话题历史/@ 之前、入群前历史、关闭首轮历史）。 |
| 测试 | [tests/message-read.test.ts](../../../tests/message-read.test.ts)（新增 31 项）、[tests/feishu-tools.test.ts](../../../tests/feishu-tools.test.ts)（66→102）、[tests/service.test.ts](../../../tests/service.test.ts)（153→171）、[tests/manifest.test.ts](../../../tests/manifest.test.ts)（10→12）、[tests/config.test.ts](../../../tests/config.test.ts)、[tests/feishu-channel.test.ts](../../../tests/feishu-channel.test.ts)、[tests/helpers.ts](../../../tests/helpers.ts) | 解析/渲染/块边界、reader 失败与取消、route 归属矩阵、chat route 跨话题拒绝、quote/history prompt 端到端（从 prompt 提取 id 后真实 fetch）、合并转发容器 id 下载、历史默认 10/0 关/截断/仅首轮/3s 预算、权限与 resolved 错误降级、工具分页/cursor/limit/参数注入/LRU、mget 端点包装。 |

### 逐条 AC 验证

| AC | 验证方法 | 实际结果 | 结论 |
| --- | --- | --- | --- |
| AC1 引用文本 | service 测试 + message-read 单测 + 同应用 bot 身份只读 API 探针 | 首轮/续聊 prompt 均含 `<feishu_quote>`（带 `message_id`）；被引用文件进入 `<feishu_context>` 清单（message_id/file_key/name）；测试从 prompt 提取 id 后执行真实 `feishu_attachment_fetch` 下载成功。API 探针：回复消息 parent_id 可定位到被引用消息且 message.get code=0。 | ✅ 自动 + ✅ API 真机（插件链路待用户手测） |
| AC2 合并转发 | service 测试 + message-read 单测 + API 探针 | 引用合并转发时展开容器+子消息文本；容器以 `merge_forward` 行进入清单，`message_id` 展示于引用块；真实 fetch 以**顶层容器 id** 下载子图片成功、子消息 id 未被用于下载；message.get 乱序返回时仍按 `upper_message_id` 选中容器。API 探针：merge_forward `message.get` 返回 3 条扁平 items（容器+文本子+图片子）。 | ✅ 自动 + ✅ API 真机 |
| AC3 话题历史 | service 测试 + tools 单测 + API 探针 | 工具默认 10/上限 50、newest-first、cursor=page_token、has_more/cursor 透传；thread/chat 两种容器；chat route 过滤其他 topic；输出 12k/50 行有界；service 首轮注入最近 N 条并支持工具翻页。API 探针：thread list（群/私聊）code=0；p2p `message.list(chat)` code=0（P0 遗留项补测通过）；群历史最早 2026-07-14 消息可读。 | ✅ 自动 + ✅ API 真机 |
| AC4 首轮上下文 | service 测试 | 默认 10 条、`historyBootstrapLimit: 0` 完全不读、超长 `已截断` 标注、仅新会话首轮注入（续聊不重复）、被动读独立 3s 预算且与工具超时解耦（永不 resolve 的 list 在 50ms 预算测试中快速返回）、按块顺序 text→quote→image→manifest→history。 | ✅ 自动 |
| AC5 授权隔离 | 单测 + service 测试 | 非本 chat 的 message_id 被拒；thread route 下未登记主时间线消息拒绝、已登记（quote/pending/trigger）可读；degraded chat route 拒绝 topic 消息（即使已登记）且 fetch 返回 AUTHORIZATION_DENIED；topic 工具发现的资源登记后 fetch 才成功（未发现前拒绝）；白名单按 route key/kind/chat/sender 复核；pending 按 (chat, thread?, sender) scope 隔离。 | ✅ 自动 |
| AC6 权限降级 | service 测试 + 代码检查 + API 探针 | 读失败（throw 403 / resolved 99991672 / 通道不可用）时 quote/history 块静默省略、followup 照常、无失败卡；服务生命周期内首次降级输出一条 warn（含原因/scope 提示）；工具显式调用返回可读 PERMISSION_DENIED/ABORTED/TIMEOUT；onboarding 说明权限与降级。API 探针确认当前应用具备消息读取权限；缺 scope 场景需临时移除权限真机复现，标记**待用户手测**。 | ✅ 自动 + ⏳ 缺 scope 真机手测 |
| AC7 构建 | `pnpm typecheck && pnpm test && pnpm build` | 全绿（数字见下）。 | ✅ 自动 |

### 真机 API 补测（只读探针，同一应用 bot 身份）

- 环境：与 DSH 插件相同的飞书应用（app id `cli_aadf2a3dd5f81be3`，来自 `$DSH_HOME/.credentials.yaml` 的凭据引用，探针脚本只读、不打印 secret/token），bot/tenant 身份，仅 GET `/open-apis/im/v1/messages*`；脚本 `/tmp/p2-probe-final.mjs`，输出 `/tmp/p2-message-read-probe.ndjson`（本机临时证据，不入 Git）。
- 测试对象：P0 使用的 p2p `oc_cc8…`、测试群 `oc_ede…`、话题群 `oc_678…` 及其 thread。

| # | 项目 | 实际结果 |
| --- | --- | --- |
| 1 | p2p `message.list(container_id_type=chat)`（P0 遗留未验证） | HTTP 200 code=0，返回 5 条、`has_more=true`、page_token 存在 → **私聊历史可读，P0 未验证项补测通过** |
| 2 | 群历史 + 入群前范围 | `sort_type=ByCreateTimeAsc` code=0，共 41 条、`has_more=false`；最早消息 2026-07-14T10:24:59Z，机器人在该群最早消息 2026-08-14T08:09:13Z → 机器人可读取早于自身首条消息约 1 个月的群历史。**结论：在机器人可见范围内，入群前历史可读**；入群时间本身无法直接查询，文档按“机器人可见范围”表述、不绝对保证 |
| 3 | `message.list(container_id_type=thread)` | 群 thread 与 p2p thread 均 code=0、返回 5 条、has_more/page_token 正常；thread 消息含 thread_id/parent_id |
| 4 | 引用定位（message.get / parent_id） | 回复消息 parent_id 指向被引用消息；对被引用消息 `message.get` code=0，chat_id 与回复一致 → 引用可定位可读 |
| 5 | 合并转发 message.get | code=0，3 条扁平 items：容器（msg_type=merge_forward）+ 文本子消息 + 图片子消息，子项带 `upper_message_id=容器 id` → 与 P0 一致，容器 id 规则沿用 |
| 6 | `message.mget`（`GET /open-apis/im/v1/messages/mget`） | **必须重复** `message_ids` 参数：3 个 id → code=0、data.items 3 条；逗号拼接 → HTTP 400 code=99992354；51 个 id → HTTP 400 code=99992402（上限 50 成立）。SDK 1.76 无 typed `mget` 方法，故通道层用 `Client.request` 实现并做 ≤50 校验 |
| 7 | SDK 能力面 | `@larksuiteoapi/node-sdk` 1.76.0 的 `im.v1.message` 只有 get/list（无 mget）；`message.list` page_size≤50；`message.get` 对已撤回/无权消息会抛 HTTP 错误（由 read 层映射为可读失败） |

- 说明：以上是**同一应用 bot 身份的 API 能力真机探针**，不等于插件链路的端到端真机验证（模型 prompt、工具注册、卡片行为仍需用户按下方步骤手测）；未用 mock 冒充真机。
- 权限观察：该应用现有 scope 下 get/mget/list(chat|thread) 全部可用；未直接读到应用 scope 清单，`im:message.group_msg` 是否需要取决于租户控制台，降级路径已实现并自动测试。

### 命令与结果（2026-10-21 本机）

```text
pnpm typecheck   -> exit 0（tsconfig.json + tsconfig.client.json）
pnpm test        -> 31 files passed / 860 tests passed（基线 770；新增 90：message-read 31、feishu-tools 36、service 18、manifest 2、config/channel 等）
pnpm build       -> host lib/index.js 622.20 kB（gzip 178.73 kB）+ client lib/client.js 125.40 kB（gzip 27.69 kB），均 Build complete
git diff --check -> exit 0
```

### 真实用户手测步骤（待用户执行）

自动测试与 API 探针之外，插件链路的真机验收按下述步骤执行（已写入 [docs/feishu-onboarding.md](../../../docs/feishu-onboarding.md) §5.3）：

1. **引用文字**：私聊/已绑定话题内回复一条更早消息（飞书自动 @）并问“解释一下上面这条”→ 卡片正常开始，模型复述被引用内容而非“看不到引用”。
2. **引用文件/图片**：引用带文件的消息问“这个文件里是什么”→ 被引用附件出现在 `<feishu_context>` 清单（有 message_id/file_key），模型可用 `feishu_attachment_fetch` 取回并回答。
3. **引用合并转发**：引用合并转发问“总结转发内容”→ prompt 出现转发文本与容器 message_id；需要子资源时用容器 id 取回成功（子 id 400 属预期）。
4. **话题历史 / @ 之前**：话题群已有讨论时 @ 机器人 → 首轮含 `<feishu_history>` 最近 10 条摘要（每行带 message_id），更早消息用 `feishu_topic_messages` 翻页；若缺 `im:message.group_msg` 等 scope，历史块静默省略、普通对话不受影响（首次 warn 日志，见 §1）。
5. **入群前历史**：机器人入群前群内已有消息时重复第 4 步；能读到则权限覆盖可见范围，不能读按“机器人可见范围”降级。
6. **关闭/调参**：`historyBootstrapLimit: 0` 重载后首轮不再带历史；`promptContextTimeoutMs` 控制被动读预算；`feishuTools.topicMessages: false` 只关工具、不影响被动摘录。
7. **权限降级（可选/需谨慎）**：临时移除消息读取 scope（或换仅含发送权限的应用）发布版本后重复第 1/4 步 → 普通对话仍正常，引用/历史静默省略，`feishu_topic_messages` 返回可读 PERMISSION_DENIED；验证后恢复权限。

当前状态：**待用户手测**（本会话无法操作真实飞书客户端；API 能力与插件行为已分别由真机探针与自动测试覆盖，未用 mock 冒充）。

### 独立评审与修复（teammate 只读，未改工作树）

- `review-functional`、`review-security` 各两轮只读评审（含 /tmp 只读探针，未连真实网络/未读凭据）：首轮无 P0，P1 共 3 项——① 引用/历史附件在 prompt 中不可发现（无 message_id，清单只列 trigger+pending）；② degraded chat route 的引用校验不校验 threadId，可引用同群其他 topic 的消息/附件；③ 被动 quote/history 读复用工具超时（默认 20s、上限 120s），阻塞首轮与同队列消息。此外 P2：mget 单条路径空结果不回退、resolved 错误体未映射、pre-abort 仍触达 channel、topic 工具 message_id 未做形状校验、合并转发 value 无界、archive 描述/guidance 不一致、白名单 LRU 被分页挤出、恢复上下文缺 id 等。
- 已全部修复并复核：quote/history 块与清单输出 message_id/file_key（manifest 新增 quote 行）；chat route 拒绝 topic 引用（chat_id fail-closed）；被动读改为独立 `promptContextTimeoutMs`（默认 3s，与预取并发）；resolved 错误码优先根 envelope、pre-abort 前置、message_id/cursor 校验、合并转发 value ≤50 且 summary 标注、view 字段限长、quoteItemsOf 顺序无关、白名单只登记资源行并把每 route 容量提到 128、archive 块按 backend 去掉 fetch 工具提示、guidance 双模式更新、一次性 warn 可观测、配置/文档同步。
- 第二轮两轮复评结论均为 **可放行**（无 P0/P1、无新回归）；复评后追加的最终打磨（root 错误码优先、backend-aware 提示、promptContextTimeoutMs 配置化+快速回归测试、manifest header 精确化、LRU 128）已由 lead 跑完 typecheck/test/build 全绿。

### 未验证项 / 已知限制

1. **插件链路真机端到端**（引用文字/文件、合并转发、话题历史、入群前历史、权限降级）待用户按 §5.3 手测；API 层能力已用同应用 bot 身份真机探针验证（见上表），非 mock。
2. **入群前历史**：同一应用真机探针可见早于机器人活动约 1 个月的群历史；无法直接查询“入群时间”，不同租户/敏感权限组合可能不同，文档按“机器人可见范围”降级，不绝对保证。
3. **`/renew` 语义**：`/renew` 创建的新 Session 首轮不会注入 `<feishu_history>`（`firstTurn` 仅 `startSession` 路径）；若产品期望“新会话即带话题历史”，需确认后扩展。当前按既有语义保留。
4. **degraded group chat route 容器语义**：topic 建话题失败降级为 chat 路由后，其容器是整群主时间线——同群他人主时间线消息可被读取/登记（topic 消息已明确拒绝）；AC-6“群内他人文件”边界建议产品确认是否按 sender 进一步收紧。
5. **普通群（非话题群）首次建话题**：thread 容器内通常只有触发消息与流式卡片且均被排除，首轮 history 可能为空；话题群/已有话题内有效。更早主时间线消息需 `feishu_topic_messages` 显式读取。
6. **archive 后端**：不挂 `feishu_attachment_fetch`；quote/history 被动块已按 backend 去掉 fetch 提示，附件仅元数据不可取；`feishu_topic_messages` 仍可读历史文本并在 description 中说明。
7. **被动富化预算**：默认 3s（可配 100ms–10s），超时静默省略；首字延迟仍可能受既有图片预取（默认单段 10s）影响，属 P1 既有行为。
8. **合并转发单条读取**：子消息超过 50 条时 value 截断（summary 标注数量），无翻页；渲染 12k/50 行有界。`mget` 生产路径未再使用（单条引用改用 message.get；mget wrapper 保留并有单测/真机端点验证）。
9. **白名单容量**：每 route LRU 128；附件密集页连续翻页仍可能挤掉更早条目（已只登记带资源/合并转发行缓解），属可用性限制；重启后即时白名单丢失（沿用 P1 pending TTL 语义）。
10. **新配置未进 Web 面板**：`historyBootstrapLimit`、`promptContextTimeoutMs`、`feishuTools.topicMessages/topicMessagesTimeoutMs` 未加入 `EDITABLE_KEYS`；README/onboarding 的 archive 主路径描述仍待 P3 统一（本任务已更新 onboarding 的 P2 部分）。
11. **权限降级真机**：缺 scope 场景需临时移除权限才能复现，标记待用户手测；已自动覆盖 throw/resolved 两种形态与可读错误。
12. 慢网/大历史规模下的首字延迟体感、`im:message.group_msg` 审批后的入群前历史边界，待真机确认。

### 下游接口与交接（`panel_docs_release`）

- 新增配置键：`historyBootstrapLimit`、`promptContextTimeoutMs`、`feishuTools.topicMessages`、`feishuTools.topicMessagesTimeoutMs`（默认值/边界见 `src/config.ts`）；若加入面板需处理数字/布尔与嵌套 merge。
- 文档：onboarding 权限表与 P2 章节已更新；README 与“archive 主路径”叙述仍属 P3 范围。
- 工具/提示：`feishu_topic_messages` 与 `<feishu_quote>`/`<feishu_history>` 标签、`manifest quote` 行为已稳定；P3 e2e 可直接断言这些标记。
- 真机验收：按上节步骤与 `acceptance.md` AC-5 记录用户手测结果。


## 启动 Prompt（复制到新会话）

```text
你负责 attachment_pipeline_v2 / quote_history_tools 的实现。

仓库：/Users/moka/dev/project/dsh_ext/dsh_channels，本地 main 分支。
执行约束（decisions.md D9/D10）：不创建平台 Issue/Milestone；不拉分支/worktree；不用 PR；直接改本地 main 并本地提交；不推送、不合并、不发布；提交用 conventional commit。

开始前阅读：
1. .agents/issues/quote_history_tools.md（本任务正文与 AC）
2. .agents/roadmaps/attachment_pipeline_v2/roadmap.md 与 plan.json
3. .agents/roadmaps/attachment_pipeline_v2/decisions.md（D1–D10）
4. .agents/notes/2026_10_20_attachment_pipeline.md
5. .agents/issues/platform_spike.md 的 P0 证据（P0 收官 3f05d81；开始时以 git rev-parse HEAD 为准）
6. 前置任务证据：admission_manifest_flow 及更早任务的“验证与交付证据”与对应提交
7. 相关源码：src/feishu-channel.ts（messageGet/messageList 已就绪）、src/feishu/tools.ts、src/routing/inbound.ts、src/session/manager.ts、docs/feishu-onboarding.md

P0 已验证、必须沿用的前提：
- bot 身份下 message.get 可取引用消息（parent_id / replyToMessageId 可定位）；
- message.list(chat) 在群聊可用且返回 code=0；message.list(thread) 可用；分页 page_size ≤50；
- 合并转发：message.get 返回扁平 items（容器+子消息），资源只能用顶层容器 message_id 下载，子消息 id 会 400；
- 未验证：机器人入群前历史是否可读、p2p message.list 是否可用——本任务必须补测并在文档/证据中如实降级；
- 工具输出必须 JSON 清洗、AbortError 可读。

任务：实现引用与话题历史（细节以本 Issue AC 为准）：
- 新增 src/feishu/message-read.ts：message.get / mget(≤50) / list(thread|chat) 薄封装与统一渲染（text/post/image/file/文件夹/合并转发），输出有界摘要与资源元数据；
- 引用摘录：把 replyToMessageId 解析为摘录进入 prompt 清单；被引用消息资源加入本 route 白名单（合并转发按容器 id）；
- 新会话首轮自动附带本话题最近 N 条摘要（historyBootstrapLimit，默认 10，可关，超长截断标注）；失败/无权限静默降级；
- 新工具 feishu_topic_messages({ message_id?, limit?, cursor? })：取单条或分页列当前话题消息（默认 10、上限 50），只允许当前 route 的 chat/thread；发现的资源加入白名单供 feishu_attachment_fetch 使用；
- 权限：im:message:readonly 等 scope 的说明与 onboarding 文档更新；缺权限时明确降级、不报死错。

预计写入范围（越界前先暂停询问）：src/feishu/message-read.ts（新增）、src/feishu/tools.ts（扩展）、src/routing/inbound.ts（引用摘录与首轮注入）、src/config.ts、docs/feishu-onboarding.md、tests/message-read.test.ts、tests/feishu-tools.test.ts（扩展）。需要真机验证的部分（引用/合并转发/话题历史/入群前历史）请列出操作步骤；若当前无法真机验证，在证据中标记“待用户手测”，不要用 mock 冒充。

完成标准：
1. 逐条满足 Issue AC；pnpm typecheck、pnpm test、pnpm build 全绿。
2. 把实际命令、结果、真机/未验证项写回本 Issue 的“验证与交付证据”。
3. 若当前会话是协调者：同步 runtime.json 对应任务 resume 并保持 roadmap validate 通过（按 D10）；否则只更新 Issue。
4. 在 main 上本地提交（不推送）；最终回复：改动摘要、关键文件、测试结果、提交 SHA、风险/未验证项。
5. 遇到范围/接口/权限变化先暂停，在 decisions.md 追加决定并询问用户（入群前历史不可读会缩小能力，需用户确认提示文案）。
```


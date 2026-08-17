# 飞书斜杠命令实施任务与验收计划

> 状态：实施中（SC-01 至 SC-03 已完成）
> 范围：仅修改 `dsh_channels` 插件；不修改 DeepSeek Harness
> 目标：在飞书消息进入模型之前识别并执行人类命令，命令输入和直接结果不进入模型上下文

## 1. 交付范围

本轮交付以下命令：

| 命令 | 行为 |
|---|---|
| `/health` | 显示 Harness 组合状态和飞书 WebSocket 通道状态；允许在尚未绑定 Session 的私聊或群聊中使用 |
| `/status` | 显示当前 Session 的模型、推理强度、token、上下文、缓存、LLM/工具耗时和吞吐指标 |
| `/work-dir` | 显示当前 Session 绑定的工作区绝对路径 |
| `/compact` | 调用 Harness 已注册的原生 `/compact`，显示压缩前后上下文占用和文本条形图 |
| `/renew` | 在当前飞书话题中创建并绑定新 Session，复用原工作区，保留旧 Session |
| `/history` | 显示当前话题绑定过的历史 Session；默认展示最近 20 条并标记当前项 |
| `/export` | 将当前 Session 的逻辑日志导出为 gzip 压缩的 JSONL 文件并发送到当前话题 |

明确排除：

- 不提供 `/model list`、`/model <name>`、`/effort list` 或 `/effort <name>`。
- `/status` 只读取并显示模型和推理强度，不改变 Session 配置。
- 不修改 Harness，不新增 Host 服务或修改 Web UI。
- `/export` 不追求 Web 导出 ZIP 的完整语义：不递归包含子代理 Session，不收集附件，不复制持久化后端的原始物理文件。
- 不将斜杠命令作为普通用户消息传给模型，也不让未知命令退化为模型输入。

## 2. 统一行为约定

### 2.1 命令识别与执行

1. 消息仍先经过现有 message-id 去重门，确保命令副作用不会因飞书重投而重复执行。
2. 仅当去除消息首尾空白后的内容以 `/` 开头时进入命令平面；命令名沿用 Harness 的小写字母、数字、`_`、`-` 语法。
3. `/health` 可以在无路由的话题、私聊或群聊中执行；其余命令必须先解析到当前话题的 `RouteRecord`。
4. 有 Session 的命令通过 `ctx.commands.execute(agent, line, signal)` 执行，以保留 Harness 的 `command/run`、`command/done` 生命周期记录。
5. Harness 未注册的命令返回明确错误和当前支持的命令列表，不调用 `agent.followup()`。
6. 命令结果使用独立、非流式的飞书结果卡；命令执行期间沿用 Typing → DONE 表态，但不创建模型 turn。
7. 同一路由上的普通消息、`/compact`、`/renew` 和 `/export` 必须串行准入，避免路由切换、压缩和普通 turn 互相穿插。

### 2.2 身份与信息边界

- `/health` 只显示脱敏的整体状态，不显示凭据引用值、错误堆栈、插件配置或文件路径。
- 其余命令仅允许 `msg.senderId === route.senderOpenId` 的话题所有者执行。
- 非所有者执行 Session 命令时返回“无权操作此会话”，不恢复 Agent、不读取 Session 日志、不产生命令生命周期事件。
- `/status` 的工具事件只显示工具名称、状态和耗时，不显示调用参数或工具结果正文。
- `/export` 含完整逻辑日志，可能包含工作区路径、用户输入和工具输出；只能发送给当前路由所有者所在的原话题。
- 错误卡使用稳定、可操作的说明，不直接回显未知异常对象、原始 SDK 响应或敏感配置。

### 2.3 修改型命令的准入

- `/compact` 沿用 Harness 原生命令的 idle/busy 判定。
- `/renew` 仅在旧 Agent 为 `idle` 且 next-turn/next-step inbox 均为空时执行；否则保持原绑定不变并返回明确错误。
- `/renew` 创建新 Session 和提交新路由期间，当前路由保持互斥；提交失败时销毁未发布或未绑定的新 Agent，旧路由继续有效。
- `/renew` 的 `command/done` 仍写入旧 Session。只有 `ctx.commands.execute()` 完成后，插件才可释放自己持有的旧 Agent handle；释放 live Agent 不得删除其持久化 Session。
- `/export` 的命令 handler 只确认“导出已请求”。插件在 `ctx.commands.execute()` 返回、`command/done` 已写入后生成并发送文件，使导出内容包含本次命令生命周期。

## 3. 指标口径

`/status` 使用 Session 完整事件日志计算，压缩只改变模型可见表面，不删除历史统计：

| 字段 | 口径 |
|---|---|
| 模型、推理强度 | 最新 `request/header.config`；没有请求记录时显示“尚未产生模型请求” |
| 输入/输出 token | 所有 `assistant/message.usage` 的 Session 累计值 |
| 上下文 | `ctx.tokenMeter.measure(session).totalTokens` / 当前模型 `contextWindow` |
| 上下文百分比 | `contextTokens / contextWindow × 100%`；未知窗口时不显示百分比 |
| 缓存命中率 | 最近一次 provider usage 的 `cacheRead / (cacheRead + uncachedInput)`，与现有流式卡片口径一致 |
| LLM 时间 | 所有完成消息的 `step/start → assistant/message` 时间之和 |
| 工具时间 | 按 call id 匹配的 `tool/call → tool/result` 时间之和 |
| 工具事件 | 累计调用数、当前未完成工具、最近 5 次工具名称/结果/耗时 |
| 平均首 token | `ttftMs / ttftSteps`；没有产生 token 的 step 不进入分母 |
| 平均生成速度 | `decodeTokens / decodeMs × 1000`；只统计同时具备首 token、完成时间和 output usage 的 step |

`/compact` 在执行原生命令前后各调用一次 token meter，并使用相同的上下文窗口展示：

```text
压缩前  ████████░░  78%  99,840 / 128,000
压缩后  ███░░░░░░░  31%  39,680 / 128,000
释放    60,160 tokens
```

条形图固定为 10 格，并始终伴随精确 token 数和百分比；上下文窗口未知时只显示 token 数。没有可压缩历史时，前后值保持一致并显示 Harness 原生命令结果。

## 4. 持久化设计

现有 `RouteRecord.sessionId` 继续表示当前绑定，不另建第二套路由表。为支持 `/renew` 和 `/history`，在同一记录中增加可选历史字段：

```ts
sessionHistory?: Array<{
  sessionId: string
  createdAt: number
}>
```

兼容和写入规则：

1. 旧记录没有 `sessionHistory` 时，在内存中规范化为 `[{ sessionId: record.sessionId, createdAt: record.createdAt }]`。
2. 新建路由从第一个 Session 起写入历史数组。
3. `/renew` 成功创建新 Session 后，用一次 `routes.put()` 同时写入新的 `sessionId` 和追加后的 `sessionHistory`，避免两个表之间出现提交裂缝。
4. 同一个 `sessionId` 不重复追加；数组按创建时间升序，当前项始终等于 `RouteRecord.sessionId`。
5. 路由 TTL GC 仍只删除插件路由记录；其历史 Session 和工作区由 Harness 持久化层拥有，不随路由 GC 删除。
6. 存储域 version 保持现值；新增字段为可选字段，旧介质可直接读取。

## 5. 任务依赖

```text
SC-01 命令 Host 类型桥与组合依赖
  └─ SC-02 命令准入、授权、串行和结果卡
      ├─ SC-03 /health
      ├─ SC-04 /status
      ├─ SC-05 /work-dir
      ├─ SC-06 /compact
      ├─ SC-07 /renew 与历史持久化
      │   └─ SC-08 /history
      └─ SC-09 /export
          └─ SC-10 故障恢复与完整自动化验证
              └─ SC-11 文档、真机验收与交付检查
```

任务按上述依赖串行交付；每个任务完成时都必须保持已有普通消息、流式卡片、HITL 审批和重启修复测试通过。

## 6. 实施任务

### SC-01：补齐命令与诊断 Host 类型桥

**依赖**：无。

**状态**：已完成（2026-08-17）。

**工作内容**：

- 在插件 `inject` 中声明 `commands`，确保消息接收前 Harness 命令服务已经可用。
- 在 `src/dsh-types.ts` 增加插件实际消费的最小类型：命令 list/find/execute、Agent options/context、Session event `time`、step end、工具结果 call id、Cordis registry/fiber 状态。
- 扩展 `FeishuChannel` 最小接口，暴露 WebSocket connection status 和文件发送能力；适配官方 SDK 的 `getConnectionStatus()` 与 `{ file: { source, fileName } }`。
- 不引入 Harness 运行时包依赖，继续使用当前结构化 Host 类型桥。

**交付物**：Host 类型、SDK 适配接口及 stub 更新。

**验收条件**：

- `pnpm typecheck` 通过。
- SDK stub 能分别返回 connected、reconnecting、failed 状态并接收文件 Buffer。
- 插件在缺少 `commands` 的组合中保持 PENDING，而不是接收消息后才失败。

### SC-02：建立统一命令准入与结果呈现

**依赖**：SC-01。

**状态**：已完成（2026-08-17）。

**工作内容**：

- 在普通消息路由到 `continueSession()` / `startSession()` 之前增加 slash admission。
- 保留现有 message-id 去重顺序，保证命令至多处理一次。
- 实现无 Session `/health` 快速路径，以及有 Session 的 `ctx.commands.execute()` 路径。
- 增加路由所有者校验和每路由异步操作串行器。
- 在 Agent setup 中注册 channel-scoped 的 `health`、`status`、`work-dir`、`renew`、`history`、`export`；复用全局 `compact`，不重复注册同名命令。
- 增加统一成功、输入错误、未知命令、未绑定 Session、无权限、busy 和内部错误结果卡。
- 命令输入、错误和结果不进入 `agent.followup()`，结果卡不接入 `TurnStreamer`。

**交付物**：命令解析/调度模块、结果卡纯函数、Service 接入和单元测试。

**验收条件**：

- 已知命令产生且只产生一对 `command/run` / `command/done`；无 Session `/health` 不伪造 Session 日志。
- 未知 `/foo` 明确报错，Session 中没有 user/message 或 model turn。
- 同一 message id 重投不重复压缩、renew、导出或发送结果卡。
- 群话题中的非所有者不能执行任何 Session 命令。
- 普通非 slash 文本仍沿用原消息路径。

### SC-03：实现 `/health`

**依赖**：SC-02。

**状态**：已完成（2026-08-17）。

**工作内容**：

- 汇总 Harness fiber 状态数量：active、pending、loading、failed、unloading；不展示配置和失败堆栈。
- 检查本插件依赖的 agents、commands、workspace、storage、credentials、llm、token-meter 服务是否可用。
- 展示飞书 connection state、最近连接时间、下次重连时间、重连次数和机器人 open_id 的脱敏尾部。
- 展示插件 started 状态、持久化路由数量、live Agent 数和 in-flight turn 数。
- 将整体结论归一为 healthy、degraded、unhealthy：连接重试或存在 pending 为 degraded，连接 failed 或关键依赖不可用为 unhealthy。

**交付物**：健康快照折叠器、健康卡和状态映射测试。

**验收条件**：

- 私聊首条消息直接发送 `/health` 时不创建工作区或 Session。
- connected/reconnecting/failed 三种状态显示正确且不泄漏凭据、完整 open_id 或内部错误堆栈。
- Harness 有 pending/failed fiber 时不会仍显示全绿 healthy。

### SC-04：实现 `/status`

**依赖**：SC-02。

**工作内容**：

- 扩展现有 `src/stats.ts`，在一个纯 fold 中累计 token、LLM/tool 时间、TTFT、decode、工具调用和最近事件。
- 读取最新 request header 展示模型和推理强度，只读不修改。
- 复用 token meter 和 model info 获取当前上下文占用及窗口。
- 渲染指标卡；缺失 usage、token meter、model info 或时间样本时显示“暂无数据”，不显示 `NaN`、`Infinity` 或伪造的 0%。
- 最近工具事件最多 5 条，不渲染 arguments、message content 或 error cause。

**交付物**：完整 Session 状态 fold、状态卡及事件序列测试。

**验收条件**：

- live 和重启后 resume 的同一日志得到相同统计。
- 多 step、多工具、失败/取消 step、未完成工具和无 usage 情况均有测试。
- 平均 TTFT 和 token/s 使用本文件第 3 节口径。
- `/status` 自身不增加模型 token；新增的命令生命周期事件不改变统计。

### SC-05：实现 `/work-dir`

**依赖**：SC-02。

**工作内容**：

- 优先读取 `agent.session.header.cwd`，并与 `RouteRecord.workspacePath` 对照。
- 两者一致时显示绝对路径；不一致时返回明确诊断并记录脱敏警告，不猜测其中一个是正确值。
- 无 cwd 或路径不可用时返回可操作错误。

**交付物**：工作区命令 handler、结果卡和一致性测试。

**验收条件**：

- 私聊、群聊用户隔离路径显示正确。
- 路由与 header 不一致时不静默返回错误目录。
- 非路由所有者无法读取路径。

### SC-06：实现 `/compact` 前后对比

**依赖**：SC-02、SC-04 的上下文测量函数。

**工作内容**：

- 执行前捕获 context tokens/window。
- 确认当前 Agent 能解析到 Harness 全局 `compact` 命令；缺失时明确提示部署未挂载手动压缩能力。
- 调用 `ctx.commands.execute(agent, '/compact', signal)`，完整保留 Harness busy、无历史、摘要失败和持久化失败语义。
- 命令完成后重新测量上下文，计算释放 token 和前后百分比，渲染两条 10 格文本条形图。
- 失败时显示原始上下文仍保持不变；不在插件内实现第二套 compaction。

**交付物**：compact adapter、对比卡和命令结果映射测试。

**验收条件**：

- 成功、无可压缩内容、busy、取消和 backend error 均有稳定结果。
- 成功结果同时显示精确 token 数和条形图。
- `/compact` 不产生普通用户消息或模型对话 turn；仅 compaction 自身允许发起辅助摘要请求。

### SC-07：实现 `/renew` 与话题 Session 历史

**依赖**：SC-02。

**工作内容**：

- 给 `RouteRecord` 增加可选 `sessionHistory`，实现旧记录规范化、去重和 schema 测试。
- `/renew` 校验 owner、Agent idle 和 inbox empty，复用原 workspace path、agent options 与 preset composition 创建新 Agent。
- 在一个 route `put` 中原子切换 `sessionId` 并追加历史；workspace registry 附加新 Session。
- 新 Agent 创建或路由提交失败时回滚新 handle，保持旧记录和旧 Agent 可用。
- 命令执行完成后再释放插件拥有的旧 Agent handle；借用的外部 Agent handle 保持 no-op dispose。
- 结果卡显示旧/新 Session ID 和复用的工作区，不删除或覆盖旧 Session 日志。

**交付物**：历史 schema、renew transaction、回滚/恢复测试。

**验收条件**：

- renew 后同一话题的下一条普通消息只进入新 Session。
- 旧 Session 仍可由 Harness persistence inspect/resume，日志未删除。
- 重启后路由仍指向新 Session，历史数组完整。
- 新 Agent 创建失败、route put 失败、结果卡发送失败三种路径均不会把话题置于无可用 Session 状态。
- 与正在运行的 turn 或已排队 inbox 冲突时明确拒绝，不启动新 Session。

### SC-08：实现 `/history`

**依赖**：SC-07。

**工作内容**：

- 从当前 RouteRecord 规范化历史，不扫描整个 Harness Session 仓库猜测话题归属。
- 按创建时间倒序显示总数、当前 Session 标记、创建时间和完整 Session ID。
- 默认展示最近 20 条；超过部分显示“另有 N 条未展示”，暂不增加分页语法。
- 对旧记录自动显示其当前 Session 作为唯一历史项。

**交付物**：历史查询/渲染函数和兼容测试。

**验收条件**：

- 连续 renew 后历史顺序、总数和当前标记正确。
- 重启前后输出一致。
- `/history` 不恢复历史 Agent、不加载历史 Session 完整日志。
- 非所有者不能枚举 Session ID。

### SC-09：实现 `/export`

**依赖**：SC-02。

**工作内容**：

- 注册 channel-scoped `export` 命令，只接受无参数形式。
- 在 `ctx.commands.execute()` 返回后，对当前不可变 Session 快照生成逻辑 JSONL：第一行是带格式版本的 export manifest 和 Session header，后续每行是一个原始逻辑 SessionEvent。
- 使用 Node gzip 在内存中压缩，文件名为 `dsh-session-<sessionId>.logical.jsonl.gz`，通过飞书 SDK 文件消息回复到原话题。
- manifest 明确标记 `logical: true`、导出时间、插件版本，以及“不含 descendants/attachments/raw artifact”。
- 序列化或文件发送失败时发送独立错误卡；不把失败包装成已成功交付。

**交付物**：逻辑日志序列化器、gzip/file sender、格式测试和安全测试。

**验收条件**：

- 解压文件后逐行 JSON 可解析，header、seq、time、type 和 data 保持不变。
- 文件包含本次 `/export` 的 `command/run` 和 `command/done`。
- 文件仅发送一次且只发送到当前话题。
- 非所有者、未知参数、gzip 失败和飞书 upload/send 失败均有明确结果。
- README/文件 manifest 不把该格式描述为 Harness 原始物理日志或 Web ZIP。

### SC-10：并发、重启与回归自动化验证

**依赖**：SC-03 至 SC-09。

**工作内容**：

- 增加同路由命令与普通消息并发、重复 message id、shutdown/command race 测试。
- 增加 renew 路由提交与重启恢复、compact busy、export post-command 快照测试。
- 验证 command result card 不进入 `TurnStreamer`，不污染现有 in-flight 修复表。
- 回归私聊、普通群、话题群路由、流式分段卡、HITL、去重、GC 和 shutdown。

**交付物**：Service/commands/stats/domain/cards 的完整自动化用例。

**验收条件**：

- `pnpm typecheck` 通过。
- `pnpm test` 通过。
- `git diff --check` 通过。
- 测试不存在真实飞书凭据、真实网络或真实 LLM 依赖。

### SC-11：用户文档与真机验收

**依赖**：SC-10。

**工作内容**：

- 更新 README 的功能、目录结构、行为/降级和安全说明。
- 更新 `docs/feishu-onboarding.md`，加入命令联调步骤、预期卡面和故障排查。
- 更新 `docs/persistence.md`，记录 `sessionHistory` 的所有权、兼容读取、renew 提交和 GC 语义。
- 按下一节执行真机验收，并在本文档的记录栏填写日期、环境和结论。

**交付物**：用户文档、持久化文档、真机验收记录。

**验收条件**：

- 文档中的命令列表与实际注册表一致。
- 所有相对链接可解析，Markdown 无死链。
- 真机验收没有把命令输入发送给模型，没有出现跨用户 Session 信息泄漏。

## 7. 真机验收记录

> 实施完成前保持“未执行”；不得用 stub/单元测试结果代替真机结论。

| 编号 | 场景 | 操作与预期 | 状态 | 日期/证据 |
|---|---|---|---|---|
| MV-01 | 无 Session 健康检查 | 私聊首条发送 `/health`；返回健康卡，不创建 Session | 未执行 | — |
| MV-02 | 已绑定健康检查 | 话题内 `/health`；显示 Harness 与飞书连接状态 | 未执行 | — |
| MV-03 | Session 状态 | 完成含工具调用的 turn 后 `/status`；模型、effort、token、上下文、耗时和工具事件正确 | 未执行 | — |
| MV-04 | 工作区 | 私聊和群聊分别 `/work-dir`；路径符合用户隔离规则 | 未执行 | — |
| MV-05 | 压缩成功 | 构造可压缩历史后 `/compact`；显示前后数值和条形图 | 未执行 | — |
| MV-06 | 压缩 busy | turn 运行中发送 `/compact`；明确拒绝且不破坏当前回复 | 未执行 | — |
| MV-07 | Renew | idle 话题执行 `/renew`；下一条消息进入新 Session，工作区不变 | 未执行 | — |
| MV-08 | History | 至少 renew 两次后 `/history`；顺序、总数和当前标记正确 | 未执行 | — |
| MV-09 | 重启恢复 | renew 后重启插件；`/history` 和当前绑定保持不变 | 未执行 | — |
| MV-10 | Export | `/export`；收到 gzip 文件，解压后包含本次命令生命周期 | 未执行 | — |
| MV-11 | 未知命令 | 发送 `/foo`；返回支持列表，模型没有收到该文本 | 未执行 | — |
| MV-12 | 跨用户拒绝 | 群话题内由另一用户执行 `/status`、`/work-dir`、`/history`、`/export`；全部拒绝 | 未执行 | — |
| MV-13 | 飞书重投 | 重放同一 message id 的 `/renew` 或 `/export`；副作用只发生一次 | 未执行 | — |
| MV-14 | 通道重连 | WebSocket reconnecting/reconnected 期间检查 `/health`；状态转换准确 | 未执行 | — |

## 8. 完成交付标准

只有同时满足以下条件，斜杠命令功能才算完成：

- 七个命令全部符合第 1 节行为，排除项没有被重新引入。
- 所有 Session 命令都执行 owner 校验；日志、路径和 Session ID 不泄漏给其他群成员。
- 命令输入与直接结果不进入模型上下文，未知命令也不退化为普通 prompt。
- `/renew` 在失败和重启场景中不丢旧 Session，不产生无路由话题。
- `/export` 格式和能力边界描述准确，文件包含本次命令生命周期。
- 自动化检查全部通过，真机验收 MV-01 至 MV-14 全部记录为通过。
- 本轮实现仅修改 `dsh_channels`；若发现必须修改 Harness 的阻塞项，应停止扩大范围并重新评审，而不是隐式跨仓库修改。

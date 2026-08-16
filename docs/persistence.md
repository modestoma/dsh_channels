# 持久化现状与缺口

本文档记录 dsh-channels 的持久化盘点（2026-08 整理）与缺口修复进度。总体分层：

| 层 | 负责方 | 落点 |
|---|---|---|
| 会话本体（事件日志 + header） | 宿主 `dsh-session-persistence` | `$DSH_HOME/sessions/<workspace>/<sessionId>/session.jsonl.zstd` |
| 插件自有状态 | 插件 → `ctx.storageDomain` | 域 `channels_routes`，JSON 后端为 `$DSH_HOME/storages/channels_routes.json` |
| 工作区 | 磁盘目录 + 宿主 registry | `<baseDir>/p2p|groups/...`，注册表 `$DSH_HOME/storages/workspace.json` |

## 一、已持久化的内容

1. **路由表**（`src/domain.ts` 域 `channels_routes`，`routes` 表）：键为 `thread_id` 或降级键 `chat:p2p|group:<chatId>:<openId>`，值为 `RouteRecord`（sessionId / chatId / chatType / senderOpenId / workspacePath / cardMessageId / createdAt / lastActivityAt）。`cardMessageId` 每 turn 更新；`lastActivityAt` 已落盘但**暂无消费方**（见缺口 3）。
2. **会话本体与事件日志**：宿主代持。插件消费的 `assistant/chunk`、`tool/call`、`tool-workflow/run-*`、`subagent/descriptor` 等全部在持久化日志里，因此 `src/stats.ts` 的 token/缓存统计不单独存，`foldAll()` 重放日志，重启后继续累计。`meta.cwd`、`agentPreset` 随 header 落盘。
3. **工作区**：目录确定性生成、幂等 mkdir；宿主 `workspace.json` 持久化 path/title/sessionIds。
4. **凭据**：密钥存宿主 `$DSH_HOME/.credentials.yaml`，插件只持引用名。

## 二、内存态（有意不持久化）

- `TurnStreamer` 全部 in-flight 状态（正文/推理 buffer、段卡列表、phase、活动 fold 等）——**缺口 1 处理对象**
- live agent 注册表、`routeCache`、`pendingResume`、`contextWindows` 缓存、`botOpenId`——缓存/懒恢复性质，重启重建

## 三、缺口清单

| # | 缺口 | 影响 | 状态 |
|---|---|---|---|
| 1 | in-flight turn 快照：重启后卡片/表情无法修复 | 重启（含插件热更新）发生在回复中途时，飞书端卡片永远停在「推理中/回复中」，Typing 表情残留、DONE 永不补 | ✅ 已修复（见下文） |
| 2 | 消息幂等去重：WS 重连/重投会重复处理同一 message id | 同一条用户消息可能触发两次 followup 或重复建 session | ✅ 已修复（见下文） |
| 3 | 路由表 GC：记录永不删除 | 话题被删除后死记录无限增长；`lastActivityAt` 已备好待用 | ✅ 已修复（见下文） |
| 4 | 段卡 message id 持久化 | 重启后无法引用/修复旧续卡（已随缺口 1 一并解决） | ✅ 已修复（随缺口 1） |
| 5 | 路由并发窗口：同话题并发首消息会重复建 session | 两 session 两路由，后写覆盖 | ✅ 已修复（见下文） |

缺口 5 修复前的可见症状（测试实证）：话题第二条消息在首条消息的 `persistRoute` 落盘**之前**到达时，群聊无 @ 的消息会被静默丢弃；有 @ 的消息则会重复建 session、路由后写覆盖前写、先建立的 session 沦为孤儿。

明确**不需要**持久化的：统计类数据（日志重放）、`contextWindows`（惰性缓存）、工作区↔会话映射（宿主 registry 已持久化）。

---

# 缺口 1：in-flight turn 快照与重启修复（已实现）

## 问题

一条 turn 的全部「修复凭据」都是内存态：trigger 消息 id、Typing reaction id、所有段卡 message id、turn 号、phase。重启发生在 turn 中途时，这些信息全部丢失，飞书端的流式卡片成为僵尸卡。

## 方案

在 `channels_routes` 域**新增 `inflight` 表**（加法操作，域 `version` 保持 `1` —— 宿主语义：介质版本与 spec 版本不一致会 `version-mismatch` 拒绝打开，因此**不能** bump；spec 里新增的表在介质上不存在时按空表加载）。

**键**：主卡（每 turn 第一张卡）的 message id —— 每 turn 唯一且 attach 时已知，避免并发 turn 互相覆盖。

**值** `InflightSnapshot`：

```ts
{
  key: string                    // = 主卡 message id
  sessionId: string
  chatId: string                 // 修复操作（表情/卡片 patch）的目标会话
  triggerMessageId: string       // Typing/DONE 表情锚点（用户触发消息）
  reactionId?: string            // Typing 表情的 reaction id（add 失败时缺省）
  cards: Array<{ messageId: string; mode: 'card' | 'text' }>  // 段卡列表，[0] = 主卡
  startedAt: number              // 附加时间（未来 TTL 清理可用）
  attempts: number               // 修复重试计数（上限 2，防永久重试循环）
}
```

## 生命周期

1. **写入**（`service.ts`，`startSession` / `continueSession`）：回复卡发出、Typing 结果就绪后**先写快照、再写路由**（快照优先：崩溃窗口更偏安全侧——最多产生孤儿快照，修复无害）。
2. **段卡更新**（`streamer.ts`）：续卡发送成功、message id 解析后经新钩子 `onSegmentDelivered(mainCardMessageId, index, messageId, mode)` 上报；服务端通过 `table.update()`（宿主原子 read-modify-write）合并进快照。
3. **清除**（`streamer.ts` `finalize`）：turn 结束即经 `onTurnFinalized(sessionId, turn, mainCardMessageId)` 删除快照。会话创建失败路径（卡片已落「会话创建失败」终态）同样主动清除。
4. **修复**（`service.ts` `start()`，长连接建立后后台执行 `repairInflight()`）：
   - 对每条快照：所有 `mode: 'card'` 的卡 patch 为终态中断卡（主卡带折叠面板，续卡带分段头，正文为「⚠️ 服务已重启，本次回复中断，请重新发送消息。」）；移除 Typing、补 DONE（表情操作 best-effort）。
   - 成功后删除快照；失败则 `attempts + 1`，达到 2 次后删除（一次性修复 + 有限重试，防止对无法接受 patch 的介质无限重试）。

## 已知取舍（v1）

- 修复卡**全量替换**原卡：中断前已流出的部分正文会被替换掉（本地没有旧正文副本，patch 是全量语义）。
- 残余竞态窗口：`finalize` 同步删快照，而最终 patch 的 HTTP 请求尚未落定；若恰在此微秒级窗口崩溃，卡片可能被再次 patch 成中断卡（幂等无害）。
- `text` 降级段卡内容已完整送达，修复时跳过（不 patch）。
- 修复不依赖 session 恢复（不读 token 统计），中断卡不带虚假的 token 行。

## 涉及文件

- `src/domain.ts` — `inflight` 表 schema / 句柄
- `src/service.ts` — 快照写入/更新/清除、`repairInflight()` 启动修复
- `src/streamer.ts` — 钩子扩展：`onTurnFinalized` 携带主卡 id、新增 `onSegmentDelivered`
- `src/cards.ts` — `buildInterruptionCard()` 终态中断卡
- `tests/` — 快照生命周期与启动修复用例

---

# 缺口 5：会话建立串行化（已实现）

## 问题

`handleMessage` 全链路异步：两条首消息几乎同时到达同一 (chat, user) 时，两条都会在路由未落盘时走 `startSession` —— 重复建 session、建话题、路由后写覆盖，先建立的 session 沦为孤儿；若第二条在话题内且无 @，则被静默丢弃（无路由、无 mention）。

## 方案

**内存方案**（不需要持久化；路由一旦落盘，后续消息自然走路由表）：

- `FeishuService` 新增 `establishing: Map<chatKey, Promise<RouteRecord>>` —— 会话建立的 in-flight 注册表。
- `startSession` 拆为两层：
  - 包装层：**同步**计算 chat 级键（任何网络操作之前即可确定），注册建立 promise；settle 后移除条目。
  - `establishSession`：原建立流程，返回 `RouteRecord`（路由落盘后才 resolve）。
- `handleMessage` 路由顺序扩展一步：thread 路由 → chat 路由 → **在途建立**。命中在途建立时 `await` 它，然后按串行语义重路由：
  - 建立的记录是 `thread` 且本消息的 `threadId === record.key` → 话题内竞态消息 → `continueSession` 同一 session（这正是原来被丢弃/分叉的场景）；
  - 建立的记录是 `chat`（降级模式）→ 同 chat 消息 → `continueSession`；
  - 其余（本消息不在该话题内）→ 落回 `startSession` 自己的新 session（与串行到达等价）；
  - 建立失败 → 落回自己的 `startSession`（首条消息的失败已由它自己的卡片呈现）。

## 语义保证

- 每个 (chat, user) 同时至多一个建立流程；等待者拿到 settle 后的记录再决定续聊或另起，**路由写入不再有并发窗口**。
- 不改变任何既有路由语义：话题内免 @、降级 chat 路由优先、群聊 @ 要求、新消息开新话题全部保持串行等价。

## 已知取舍（v1）

- 建立期间到达的、不在该新话题内的消息会**等待**到建立完成才处理（而非立即建自己的 session）——毫秒级延迟，换来路由表无竞争。
- 条目是内存态：跨实例无需共享（另一实例的并发首消息由路由表落盘后的正常路径接管，极端情况下双实例同时建 session 的窗口不在本方案范围内）。

## 涉及文件

- `src/service.ts` — `establishing` 注册表、`startSession`/`establishSession` 拆分、`handleMessage` 在途建立分支
- `tests/service.test.ts` — 4 个并发用例（话题内竞态续聊、降级并发、建立失败回落、旁路消息另起 session）

---

# 缺口 3：路由表 GC（已实现）

## 问题

`routes` 表只增不减：话题被用户删除后，其 `thread_id` 永远不会再次出现，死记录无限增长；`lastActivityAt` 早就落盘但无人消费。in-flight 快照同样存在老化残留（跨多轮重启的僵尸快照）。

## 方案

- **配置** `routeTtlMs`（默认 `DEFAULT_ROUTE_TTL_MS` = 30 天，`0` = 关闭）：超过该时长无活动的路由记录视为死记录。
- **清扫时机**：启动时一次（长连接建立后，与中断修复同批后台任务）+ 每 6 小时一次的周期清扫（`GC_SWEEP_INTERVAL_MS`，unref 不阻塞进程退出，shutdown 时清除定时器）。
- **清扫内容**（`gcExpiredEntries()`）：
  - `routes` 表：`lastActivityAt < cutoff` 的记录删除，并同步清 `routeCache`（内存缓存与持久层不偏离）；
  - `inflight` 表：`startedAt < cutoff` 的僵尸快照**静默删除**——不 patch 卡片（给陈年老卡打"服务已重启"补丁反而惊扰用户）；
  - 单键删除失败只 warn 跳过，不中断整体清扫。
- **与中断修复的分工**：`repairInflight()` 在 TTL 开启时跳过超龄快照（GC 的职责），两轮后台任务无论执行顺序如何都收敛一致；TTL 关闭时修复逻辑不变（照常修复全部快照）。
- **边界**：只删插件自己的路由条目，宿主侧的 session / 工作区不动；被 GC 的话题后来再有消息，等同未知话题 → 新建 session，语义与"新消息开新话题"一致。

## 语义保证

- 活跃话题（每 turn 都会刷新 `lastActivityAt`）永远不会被误删。
- 删除是持久的（先落盘后清内存缓存），与并发写入安全（`entries()` 快照 + 只删超龄键）。

## 已知取舍（v1）

- 未监听飞书侧"群解散/话题删除"事件做主动清理（TTL 兜底，事件清理列为后续可选优化）。
- 跨实例共享同一介质时，各实例各自清扫同一套记录——幂等无害。

## 涉及文件

- `src/config.ts` — `routeTtlMs` 配置项 + `DEFAULT_ROUTE_TTL_MS`
- `src/service.ts` — `gcExpiredEntries()`、启动/周期清扫接线、`repairInflight` 超龄跳过
- `tests/service.test.ts` — GC 用例（启动清扫、僵尸快照静默删除、0 关闭、GC 后话题重建 session）
- `tests/config.test.ts` — `routeTtlMs` 默认值 / 0 / 负值校验

---

# 缺口 2：消息幂等去重（已实现）

## 问题

飞书 WS 长连接在重连时会重投未 ack 的事件：同一条 `im.message.receive_v1`（同 message id）会被处理两次——命中路由 → 重复 `followup` + 重复回复卡；首消息 → 重复建 session（缺口 5 的门闸会让第二条重复等待后再续聊，同样产生重复 turn）。飞书 message id 全局唯一，天然是幂等键。

## 方案

**双层守卫**：

1. **进程内同步守卫** `accepted: Map<messageId, acceptedAt>`：`handleMessage` 入口**同步**登记，堵住"持久化查了未写"的窗口（同进程内同 id 的两次投递，第二次在第一次的 `put` 落盘前到达也会命中内存守卫）；持久化记录落盘后即移除内存条目，只有 put 失败时才滞留到 GC 清扫。
2. **持久化记录**：域新增 `processed` 表（键 = Feishu message id，值 `{ key, processedAt }`），**在任何副作用之前** `await put` 落盘——同一时刻最多一份投递进入副作用阶段（每 message id 至多一次语义）；崩溃窗口收窄到"接受之前"，接受后重启重投也会被持久化记录挡下。

- **放置位置**：机器人自回、非 p2p/group、空内容、dmMode 过滤之后、路由决策之前；群聊无 @ 被丢弃的消息同样记录（重投时同样丢弃，行为一致）。
- **记录失败**：只 warn 不阻塞（内存守卫仍覆盖本进程；失败只略增崩溃窗口）。
- **清扫**：`processed` 记录与内存滞留条目由 GC 清扫**无条件**清理（`PROCESSED_RETENTION_MS` = 24 h——重投窗口是分钟级，24 h 是 100× 以上余量），与 `routeTtlMs` 是否开启无关；启动时 + 每 6 h 周期。

## 语义保证

- 每条 message id 至多被处理一次：同进程并发投递（内存守卫）、跨重启重投（持久化记录）都只会看到零副作用。
- 至多一次的代价：接受后、副作用完成前崩溃 → 该消息丢失——但中断修复卡本身提示"请重新发送消息"，用户可自然重发（新 message id 正常处理）。

## 已知取舍（v1）

- 群聊无 @ 丢弃的消息也被记录（存储噪音可忽略，换取单点实现与全路径一致性）。
- 不依赖飞书 SDK 的 ack 机制（黑盒），以"先记录、后处理"自实现幂等。

## 涉及文件

- `src/domain.ts` — `processed` 表 schema / `ProcessedTable` 句柄
- `src/service.ts` — `accepted` 内存守卫、`handleMessage` 幂等门、`gcExpiredEntries` 无条件清扫 processed
- `tests/service.test.ts` — 4 个用例（首消息重投、续聊重投、跨重启重投、processed 记录 GC）

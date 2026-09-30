# dsh-channels 对照 DSH 0.2.0-rc.2 的评估与改进建议

> 评估日期：2026-09-30
> 评估基线：DSH **0.2.0-rc.2**（本机安装版本；源码 checkout `/tmp/dsh-0.2.0-rc.2`，tag `dsh-v0.2.0-rc.2`）
> 对照版本：插件最后提交 2026-08-31（`ace8220`），针对的是 2026-08-28 之前的 DSH 快照
> 插件基线：`pnpm typecheck` 通过；`pnpm test` 240/240 通过（但测试用 stub 自带 `session.events`，因此没有覆盖下文的破坏性变更）
>
> 所有 DSH 侧结论都带 `packages/...:行号` 证据；"未验证"字样表示未实测。

---

## 0. 结论摘要

**评估结论（改动前）：当前插件在最新 DSH 上不可用**，不是"可以更优雅"，而是两个已生效的破坏性变更直接打断主链路。P0 与选定的高价值项已在本次实施中修复，落地清单与验证见 §7。

> **实施状态更新（2026-09-30）**：§1 的两个 P0、`/stop`、结构化提问应答、宿主投影统计、`displayReason`、effect 标签均已落地；typecheck 通过、263/263 测试通过。推迟项与理由见 §7.2。

| 级别 | 问题 | 症状 | 位置 |
|---|---|---|---|
| **P0-A** | `Session.events` 已被删除（DSH 2026-08-28，含所有 ≥0.1.3-alpha.1 的 tag） | 每条消息在建立会话/续聊时 `attach()` 抛 `TypeError: session.events is not iterable`，用户只看到「处理失败」文本 + 永远「推理中」的僵尸卡 + 残留 Typing 表情 | 插件 9 处，见 §1.1 |
| **P0-B** | `assistant/chunk` 持久化事件已不再产生（DSH 2026-09-02，BREAKING `f99b06eaed`） | 即使修好 P0-A，卡片正文/推理区也永远为空：文本增量改由**瞬时**事件 `agent/assistant-stream` 投递 | `src/streamer.ts:389` |
| **P1-A** | 同步读取整段会话日志已被官方**废止**（`snapshotEvents`/`eventAt` 全部 `@deprecated`） | 现在能跑（实现仍保留内存日志），但方向相反；应改为投影 + 分页读取 | `src/stats.ts:245` 等 |
| **P1-B** | 插件 `Config` 未使用 cordis schema 约定 | 配置错误只能在 `apply()` 里运行时抛，loader 无法提前报错；settings UI 拿不到 schema | `src/config.ts` / `src/index.ts:69` |
| **P1-C** | 0.2.0 的插件兼容性闸门只看 `@deepseek-ai/dsh*` peerDependencies；插件一个都没声明 | 装到不兼容的 runtime 上会被静默加载（当前正是如此） | `package.json:41-48` |
| **能力缺口** | 未应答 `user-questions/request` | 模型调用 `ask_user_question` 时，非 Web 的飞书会话直接 `NO_PROVIDER` 失败 | §3.1 |
| **能力缺口** | 没有中断手段 | 飞书侧无法停止跑飞的 turn，只能等它结束 | §3.5 |

**可以显著变"更优"的地方**（0.2.0 已经提供一等公民 API，插件在手工重造）：

1. **统计/占用**：`ctx.sessionProjections` 的 `sessionStats` / `tokenUsage` / `contextPressure` 已由宿主维护，插件 `src/stats.ts`（322 行）的大部分折叠可以删除 → §3.2
2. **推理强度/模型切换**：`installModelSelection(agentCtx, ref)` 是官方入口（ACP 同款），比 `agent/request` prepend 包装更完整（含 prompt 变量与切换通知） → §3.3
3. **历史查询**：`ctx.sessionQuery` 提供分页、只读、live 优先的读取，替代 `/history` 自建历史 → §3.4
4. **结构化提问**：`user-questions/request` 瀑布，和现有审批应答器同一形状 → §3.1

**结论**：插件的整体架构（`session/event` 观察 + `approval/request` 瀑布 + `ctx.effect` 全量 teardown + 卡片/话题/工作区模型）在 0.2.0 下依然成立，**不需要推倒重来**；但必须先完成 §1 的迁移，再按 §3 逐项收编宿主能力。

---

## 1. P0：两个已生效的破坏性变更

### 1.1 P0-A — `Session.events` 已删除

**DSH 事实**：`Session` 上的同步整段日志 getter `get events()` 在提交 `5660f44d29`（2026-08-28，"perf(session): separate indexed and snapshot log reads"）中被删除，替换为三个同步读取器；`dsh-v0.1.3-alpha.1`（2026-09-04）及之后所有 tag 都不再有 `events`。

- 删除证据：`git -C <dsh> show 5660f44d29 -- packages/core/session/src/index.ts`（`-  get events(): readonly SessionEvent[]`）
- 现存接口：`packages/core/session/src/index.ts:641` `eventAt(seq)`、`:647` `snapshotEvents(fromSeq, toSeqExclusive)`、`:660` `ownEvents()`
- 二次废止：`.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md:15` —— 三者全部 `@deprecated`，**禁止新增调用**（仓库有 lint 强制），方向是 session projection + 显式分页读取

**插件事实**（9 处，全部在真实 `Session` 上执行）：

| 文件:行 | 用途 | 触发时机 |
|---|---|---|
| `src/streamer.ts:285` | `foldAll(session.events)` 首次 attach 播种统计 | 每建/续会话 |
| `src/service.ts:729` | `/effort` 后 `controller.sync(session.events)` | 命令 |
| `src/service.ts:743` | `/status` 的 `foldAll(session.events)` | 命令 |
| `src/service.ts:1337` | 借用外部 live agent 时 `sync` | 冷恢复 |
| `src/service.ts:1351` | `requireReasoningEffort` 每次同步 | 每轮 |
| `src/service.ts:1418` | `effectiveAgentPreset` 折叠 `agent-preset/selected` | `/renew` |
| `src/service.ts:1795` | 卡片上下文窗口，`session.events.filter(request/header)` | 每次 patch（有 try/catch 兜底） |
| `src/stats.ts:293` | `/compact` 前测量 | 命令 |
| `src/session-export.ts:97` | `/export` 序列化全量事件 | 命令 |

类型桥同样声明了它：`src/dsh-types.ts:99` `readonly events: readonly SessionEvent[]`。

**失败路径**：`establishSession()` 先发首帧卡，再同步调用 `streamer.attach()`；`attach` 内 `foldAll(session.events)` 对 `undefined` 执行 `for...of` 抛 `TypeError`。异常沿 `handleMessage` 的 catch 走到 `channel.send(..., { text: 'dsh-channels 处理失败：...' })`（`src/service.ts:330-337`），于是飞书侧变成：一条报错文本 + 一张停留在「推理中」的卡 + 未清除的 Typing 表情。

**最小迁移**（改完即恢复可用，未触及废止语义）：

```ts
// src/dsh-types.ts：不再声明 events，改为读取器
export interface Session {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly firstLiveSeq: number
  /** 兼容读取整段日志；0.2.0 起官方推荐投影/分页，见 docs/review-dsh-0.2.0.md §2.1 */
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[]
}
// 调用点：session.events → session.snapshotEvents()
```

**更好迁移**（推荐，和 §2.1 合并做）：把「整段折叠」拆成"增量投影"——插件本来就在 `ctx.on('session/event')` 上收流，只需为已路由 session 维护增量状态，attach 时用 `ctx.sessionQuery.readSession(id)` 或投影状态播种，而不是在内存里逐事件重放。

**验收**：新增一个用真实 `Session` 形状（无 `events`、有 `snapshotEvents`）的失败用例，先红后绿；`grep -rn "\.events" src/` 归零。

### 1.2 P0-B — `assistant/chunk` 不再产生，流式增量改走 `agent/assistant-stream`

**DSH 事实**：提交 `f99b06eaed`（2026-09-02，"feat(session)!: embed assistant streams in format v2"，`!` = breaking）之后，模型流增量不再作为持久化 `assistant/chunk` 事件写入会话日志；`assistant/chunk` 现在只出现在 v0/v1 会话格式迁移代码里（`packages/session/session-format-*/src/*.ts`），生产侧没有任何 emitter。0.1.7-rc.1 的 `assistant/chunk` 也只作为"历史坏数据"出现（`packages/core/agent-loop/tests/loop.spec.ts:107` 断言不再产生）。

替代路径是**瞬时**的 Agent 作用域事件：

```
packages/core/agent/src/runtime-types.ts:128   export type AssistantStreamFrame =
  | { type:'start'; attemptId; revision; turn; step }
  | { type:'chunk'; attemptId; revision; index; time; chunk: StreamChunk }
  | { type:'end';   attemptId; revision; index; outcome:
        { kind:'committed'; eventType:'assistant/message'|'assistant/attempt'; seq } |
        { kind:'abandoned' } }
packages/core/agent/src/runtime-types.ts:363   'agent/assistant-stream'(this: Scoped<Agent>, { agent, frame }): void
```

`StreamChunk` 词表不变（`packages/llm/llm/src/types.ts:452-464`：`text-delta` / `reasoning-delta` 带 `.text`；`tool-call-delta` 新增必填 `id`），因此 `src/streamer.ts:392-409` 的处理逻辑几乎可以原样复用。

**插件事实**：整个卡片正文/推理区只依赖 `assistant/chunk`：

- `src/streamer.ts:389-411`：`case 'assistant/chunk'` → `data.chunk.type` 的 `text-delta` / `reasoning-delta`
- `src/dsh-types.ts:110-113`：`AssistantChunkEvent` 形状
- 备用信息源 `assistant/message` 只被用来取 `usage`（`src/streamer.ts:412-423`），没有用它携带的正文

**症状**：修好 P0-A 后，卡片正文/推理区恒为空，phase 永远停在 `thinking`，直到 `turn/end` 才翻成「回复结束」。

**迁移方案**（两个方向都要做）：

1. **实时增量**：订阅 `agent/assistant-stream`。宿主根上下文的未打标 listener 会收到所有 Agent 作用域事件（`packages/core/scope/src/index.ts:176`：`tag === undefined → true`），所以：
   ```ts
   ctx.on('agent/assistant-stream', ({ agent, frame }) => {
     if (frame.type !== 'chunk') return
     this.streamer?.onStreamChunk(agent.session, frame.turn, frame.step, frame.chunk)
   })
   ```
   语义差异必须处理：`frame.type === 'end' && frame.outcome.kind === 'abandoned'` 表示这次 attempt 的文本**不会进入模型可见历史**（`packages/core/session/src/types.ts:340-347`：只有 committed 才落 `assistant/message`/`assistant/attempt`）。当前实现在这种情况下会把已流出但被丢弃的文本留在卡上——需要按 `attemptId` 回滚该 attempt 的增量。
2. **落定文本**：`assistant/message` 现在带 `stream: AssistantStreamRecord[]`（`packages/llm/llm/src/assistant-stream.ts:20`，`text-chunks` / `reasoning-chunks` 的紧凑记录）。用它可以：中途取消的 turn 照常落正文；**重启修复时把已落定的正文补回卡上**（当前 README「已知取舍」里"本地没有副本、只能整卡替换为中断提示"的限制，在这条路径下可以放宽——前提是 `assistant/message` 已落盘）。

**验收**：用真实 frame 形状的事件序列驱动 `TurnStreamer`，断言 `text-delta` 进正文、`reasoning-delta` 进折叠区、`abandoned` 回滚、`committed` 保留。

---

## 2. P1：语义漂移与设计债

### 2.1 同步读取整段日志已被官方废止

`.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md:15,23-25`：

- `eventAt` / `snapshotEvents` / `ownEvents` 全部 `@deprecated`，**新代码禁止调用**（仓库内 lint 强制，测试文件有豁免）；
- 正确方向：**设计持久化事件字段 + Session 投影**，resume 时重建、之后从新事件增量维护；历史内容按需用**显式异步分页**读取。

插件的折叠面（`stats.ts` 的 `foldAll`、`streamer.attach` 播种、`effectiveAgentPreset`、`/export`）都属于"同步重放整段历史"。这不是马上会炸，但与官方存储演进方向相反，且每次 resume 都要全量重放。

**更好实现**：把 §1.1 的"最小迁移"直接升级为投影化——`foldAll` 只保留"从事件流增量维护"的 `foldEvent` 部分，播种交给 §3.2 的宿主投影或一次 `ctx.sessionQuery` 分页读取。

### 2.2 插件 Config 没有用 cordis schema

**约定**（`docs/cordis-tutorial/05-config.md:22-34`，范例 `packages/webhook/webhook-github/src/index.ts:17-33`）：

```ts
export interface Config { ... }
export const Config: Schema<Config> = Schema.object({ ... })   // @deepseek-ai/schemastery
export function apply(ctx: Context, config: Config) { ... }     // 进来时已校验+填默认
```

宿主在 `apply` 之前校验配置，非法配置**在加载阶段**就以 `ValidationError` 失败；共享的 settings UI 也能拿到 schema。凭据引用字段用 `z.string().role('credential-ref')` 标注，settings 界面会渲染凭据选择器而不是明文输入框。

**插件现状**：`src/config.ts:35-119` 手工 zod（`zod@^4.4.3`，版本本身和 DSH 一致）+ `resolveConfig()`，`src/index.ts:69-70` 的 `apply(ctx, config?: unknown)` 自己解析。后果：配置错误只在启动时才抛（且因为 start 是异步的，错误被吞进 `console.error`），schema 对 settings UI 不可见，"明文密钥"只靠正则挡。

**建议**：导出 schemastery 的 `Config`（保留现有 `resolveConfig` 作为 `apply` 内的兜底断言），`appId`/`appSecret` 加 `.role('credential-ref')`。注意 `zod` 仍要留着——storage domain 的 record schema 官方就是 zod。

### 2.3 插件兼容性闸门形同虚设

0.2.0 新增了插件兼容性准入：**只看 `peerDependencies` 里键名等于 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的项**（`packages/boot/app-boot/src/plugin-compatibility.ts:68,75,77`，`includePrerelease: true`）。不含 dsh peer → 永远不检查。

- 安装期：`dsh plugin add` 预检不通过会**整体拒绝安装**（`packages/boot/plugin-manager/src/operations.ts:333-351`）；
- 启动期：不兼容的 bundle 会被**跳过**并在 `skippedBundles` 里给出具名原因，不致命；
- 豁免：`dsh plugin allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`。

**插件现状**：`package.json:41-48` 只声明了 `@deepseek-ai/cordis@^4.0.1`——不属于上述命名空间，等于放弃了这道闸门。插件又是**零运行时 DSH import、纯结构化桥接**（`src/dsh-types.ts:1-21`），宿主一旦改签名不会有任何编译或安装期提示，正是 §1 两个 P0 能静默潜伏的原因。

**建议**：把实际依赖的服务包加进 `peerDependencies` **和** `devDependencies`（官方发布指南：`docs/user/develop/basic/publish.md:103`），至少覆盖 `inject` 列表：`@deepseek-ai/dsh-agent`、`dsh-commands`、`dsh-workspace`、`dsh-storage-domain`、`dsh-credentials`、`dsh-llm`、`dsh-token-meter`；范围对齐目标 runtime（如 `^0.2.0-rc.2`）。这样装错版本会在安装期被拒、启动期被具名跳过，而不是运行时抛 `TypeError`。

### 2.4 其他字段级漂移

| 插件假设 | 0.2.0 事实 | 影响 |
|---|---|---|
| `assistant/message.data.sourceEventSeqs`（`src/dsh-types.ts:122`） | 已移除；新增必填 `stream: AssistantStreamRecord[]`、可选 `interrupted`（`packages/core/session/src/types.ts:340-347`） | 类型桥过时；正文重建应改用 `stream` |
| `TurnEndReason` 联合 | 新增 `'forked'`（`packages/core/session/src/types.ts:207-231`）；`error: { kind:'error'; error: LlmFailure }` 仍在 | `src/streamer.ts:1009` 的 `kind==='error'` 分支仍成立 |
| `tool/call.arguments` 为原始 JSON 字符串 | 未变（`packages/core/session/src/types.ts:362`） | 无 |
| `request/header.header.config.provider/model/reasoningEffort` | 未变（`packages/core/session/src/types.ts:388-396`） | 无 |
| `agent.options` / `agent.status` / `agent.inbox` / `agents.get(id)` | 未变（`packages/core/agent/src/runtime-types.ts:166,170,172`；`packages/core/agent/src/index.ts:566`） | 无 |
| `ctx.agentPresets` 服务名与 `resolve/mount` | 未变（`packages/preset/agent-preset-registry/src/index.ts:64,180,257`） | 无 |
| `ctx.credentials.resolve` → `{value, source}` | 未变（`packages/credentials/credentials-local/src/index.ts:609-617`） | 无 |
| `storageDomain.open(spec)` 的表 `get/put/update/delete/entries`、`global.get/set`、`close` | 未变（`packages/storage/storage-domain/src/index.ts:103`） | 无 |
| `commands.register/find/execute`、`CommandDescriptor.input.hint` | 未变（`packages/interaction/commands/src/index.ts:285,328,361`；`src/types.ts:57-66`） | `execute` 第三参已更名 `CommandSubmitAttachment[]`，插件传 `[]`，无影响 |

---

## 3. 可用的更优实现（0.2.0 提供的一等能力）

### 3.1 应答 `user-questions/request`（最有价值的新能力）

DSH 有独立的"结构化提问"瀑布（`AskUserQuestion` 工具）：

- 服务：`ctx.userQuestions`（`packages/interaction/user-questions/src/index.ts:85`）
- 事件：`'user-questions/request'`，形状与审批完全相同：`(this: Scoped<Agent>, request, next) => Promise<AskUserQuestionAnswer>`（`packages/interaction/user-questions/src/types.ts:157-161`）
- 无应答者时 fail-closed：`NO_PROVIDER`（`packages/interaction/user-questions/src/index.ts:318-321`）
- **当前唯一内置应答者是浏览器客户端**（`packages/client/ui-user-questions/src/client/index.ts:400`，经 `packages/api/remotes/src/remote-events.ts:47` 转发）

也就是说：只要没有 Web 页面在线，飞书用户触发的 `ask_user_question` 必然失败。插件的审批应答器（`src/approvals.ts:105`）已经把这套"路由判定 → 发卡 → 点击回填 → 超时/撤回 fail-closed"的机制做全了，扩展成第二个瀑布只需同一套骨架：`AskUserQuestionItem.options[]` 渲染成按钮（含 `intent.kind === 'plan-review'` 时用 `detail` 展示计划），自定义文本用一条回复消息回收。

这是"一个飞书实例 = 一个机器人"产品形态下最明显的功能缺口。

### 3.2 用宿主投影替换 `src/stats.ts` 的手工折叠

DSH 已经把会话统计做成投影单元，由宿主维护、随 `session/event` 增量更新，读取是同步 O(1)：

| 投影 key | 内容 | 提供方 | 是否在 web profile |
|---|---|---|---|
| `sessionStats` | turns/steps/llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens | `packages/session/session-stats/src/projection.ts:114` | 是（`packages/bundle/web-app/cordis.patch.yml:102-103`） |
| `tokenUsage` | 每 session token 总量 + 最后一次 usage | `packages/llm/token-meter/src/usage-projection.ts:118` | 是（`base:338-339`） |
| `contextPressure` | contextWindow / pressureTokens / surfaceTokens | `packages/llm/token-meter/src/usage-projection.ts:174` | 是 |

读取入口：`ctx.sessionProjections`（`packages/session/session-projection/src/index.ts:208`），`stateOf(session, key)` / `onChanged(listener)`（`docs/subsystems/session-projection.md:205-244`）。

**收益**：`src/stats.ts`（322 行）里 `foldAll` 的计时/计数部分、`src/service.ts:1795` 的 `request/header` 扫描、`src/session-commands.ts` 的 `/status` 统计都可以改为读投影；同时天然满足 §2.1 的"不要同步重放整段日志"。注意 `tokenMeter.measure(session)`（`src/service.ts:1788`）本身就是官方 API，保留。

### 3.3 用 `installModelSelection` 替换手写的 effort 覆盖

插件现在的做法（`src/reasoning-effort.ts:79-83`）是自己在 `agent/request` 上挂 `prepend` 瀑布，只覆写 `reasoningEffort`；Session 覆盖值靠折叠 `command/run` / `command/done` 事件恢复（`:53-70`）。

DSH 的官方入口是 `installModelSelection(agentCtx, selectionRef)`（`packages/core/agent/src/model-selection.ts:81`，从 `@deepseek-ai/dsh-agent` 导出；ACP 就是这么用的：`packages/acp/acp/src/model-control.ts:5,52`），它一次性解决：

- prompt 装配变量（`provider`/`model` 进入 system prompt）；
- **按 step 快照的原子选择**（`selection.assembled`），避免 prompt 与实际请求配置分裂；
- 模型切换时自动追加一条持久化 `model-selection` 通知（`modelSwitchNotice`，`:36-52`）；
- 同一 ref 同时支持 effort 与 model 两个维度。

**建议**：把 `ReasoningEffortController` 换成 `ModelSelectionRef` + `installModelSelection`，`/effort` 直接改 ref；若还想支持 `/model`，同一 ref 即可。这样能删掉 `reasoning-effort.ts` 里一大半代码，并获得官方的事件一致性保证。

### 3.4 用 `ctx.sessionQuery` 替换自建会话历史

`ctx.sessionQuery`（`packages/session-query/session-query/src/index.ts:106`，base bundle 已挂 sqlite 后端 `packages/bundle/base/cordis.patch.yml:149-150`）提供：`listSessions` / `readSession` / `listEvents` / `readSurface` / `readEvent` / `filterEvents` / `readTitleSnapshots` / `searchSessions`，live 优先、返回 detached clone。

插件 `/history` 现在只显示自己 `RouteRecord.sessionHistory` 里记的 sessionId 列表（`src/session-commands.ts:184-187`），信息量远小于宿主能力；`/export` 则在 `src/session-export.ts` 里自己发明了一套"逻辑日志"格式，并且依赖 `session.events`（P0-A）。

**建议**：`inject: ['sessionQuery']`；`/history` 用 `listEvents`/`readTitleSnapshots` 渲染真实事件摘要；`/export` 用 `readSession(id)` + `readSurface(id)` 生成规范化快照（宿主没有 Host 侧导出 API——`dsh-session-log-export` 只产出浏览器 ZIP 下载，所以"把文件传到飞书"这一段必须保留自建，但**数据来源**应该换成官方读取器）。

### 3.5 增加中断能力（`/stop`）

`Agent.cancel(cause, options?)` 是公开 API（`packages/core/agent/src/runtime-types.ts:183`；ACP 的 `session/cancel` 就是直接调用它，`packages/acp/acp/src/index.ts:367`）。插件目前没有任何取消入口，飞书用户遇到跑飞的 turn 只能等。

**建议**：加 `SUPPORTED_COMMAND_NAMES` 里的 `stop`，经 `routeOperations` 串行后调用 `live.agent.cancel({ kind: 'user' })`（cause 取官方 `AgentCancelCause` 的合法值），并让 `turn/end.aborted` 走现有失败终态卡路径。注意与 `RouteOperationQueue` 的交互：`cancel` 是同步的，不需要排在该队列后面太久，但要在 `withCommandReaction` 里给出即时反馈。

### 3.6 可选：让用户切换权限预设（安全敏感）

`ctx.permissionPresets`（`packages/interaction/permission-presets/src/index.ts:208`，base bundle `:251` 已挂）把 sandbox 模式与审批策略打包成命名预设，Web 端有 UI。理论上飞书侧可以加 `/permissions`。

**但这是安全决策**：插件的 `approvalTimeoutMs` fail-closed、非发起人不可点击、话题内免 @ 等设计都是为了在不可信 IM 环境里收紧权限。若要做，建议只暴露"收紧"方向，或要求显式配置开关，默认关闭。本文把它列为**可选**，不作为建议。

### 3.7 小改进（低成本）

| 项 | 现状 | 建议 | 证据 |
|---|---|---|---|
| 审批卡展示文本 | 只渲染 `req.reason` | 0.2.0 新增只用于展示的 `displayReason?: { en, [locale] }`（zh 可直接用），优先于 `reason`，不影响审计 | `packages/interaction/user-approval/src/types.ts:73` |
| `ctx.effect` 标签 | `ctx.effect(cb)` 无标签 | `ctx.effect(cb, 'dsh-channels')`，诊断输出 `getEffects()` 时可读；官方适配器都带标签 | cordis `lib/types/fiber.d.ts:157-159`；范例 `packages/webhook/webhook-github/src/index.ts:58-61` |
| 会话标题 | 无 | `ctx.sessionTitle.rename(session, ...)` 可把飞书话题名写回会话标题（Web 列表可见） | `docs/subsystems/session-title.md:158-183` |
| 凭据缓存 | 启动时解析一次，长期持有明文于内存 | 官方要求"每次操作重新解析、不跨操作缓存"，以支持轮换 | `docs/subsystems/credentials.md:145-152`（未逐行复核） |

---

## 4. 仍然合理、不需要改的部分

评估中确认这些设计在当前 DSH 下依然正确，改动它们没有收益：

- **没有通用 IM/渠道抽象可替代**：全树没有 `ctx.channel` / messaging 服务；`webhook` 是"单向、每次新 Session、fire-and-forget"，没有回信通道；ACP/SDK 各自拉起独立 runtime/profile，无法与运行中的 web profile 共享会话。所以"长连接 + 卡片 2.0 + 话题路由 + 工作区映射"必须自建。
- **审批应答机制正确**：`approval/request` 仍是 `Scoped<Agent>` 瀑布，根上下文未打标 listener 能收到全部请求（`packages/core/scope/src/index.ts:176`），`prepend: true` 抢在 Web 转发器之前是成立的；`dispose()` 撤回在途问题也符合宿主语义（宿主默认 `'unavailable'` fail-closed）。
- **`session/event` 仍是官方推荐的观察口**（`docs/architecture.md:157`），没有更新的 Host 侧流式 API。
- **生命周期/teardown 写得很好**：单个 `ctx.effect` 拥有 start 与有序 async teardown（`src/index.ts:74-83`、`src/service.ts:377-417`），符合"多个 async disposer 并发执行、有序拆除要放同一个 disposer"的指引。
- **`storageDomain` 用法正确**：spec 是纯数据 + zod（与宿主同版本 zod ^4.4.3），由 caller 关闭。
- **七项 `inject` 全部有效**（`src/index.ts:57`），`commands` 在 base bundle 中已挂。
- 话题串行化、消息去重、重启修复快照、TTL 墓碑、分段卡降级等产品级细节，在当前 DSH API 下没有更优替代，属于合理自建。

---

## 5. 建议实施顺序

| 步骤 | 内容 | 验收 |
|---|---|---|
| 1 | **P0-A**：`Session.events` → `snapshotEvents()`（最小迁移） | 新增真实 Session 形状（无 `events`）的失败用例先红后绿；`grep -rn "\.events" src/` 归零；typecheck + 240 测试全绿 |
| 2 | **P0-B**：`assistant/chunk` → `agent/assistant-stream`，处理 `abandoned` 回滚与 `committed` 落定 | 用真实 frame 形状驱动 streamer 的单测；真机发一条消息看到正文流式 |
| 3 | **P1-C**：声明 `@deepseek-ai/dsh*` peerDependencies/devDependencies | `dsh plugin --profile web add link:...` 预检通过；故意改范围能看到具名拒绝 |
| 4 | **P1-A + 3.2**：`foldAll` 投影化，读 `sessionStats`/`tokenUsage`/`contextPressure` | 删除同步整段重放；`/status`、上下文行数值与 Web UI 一致 |
| 5 | **3.3**：`installModelSelection` 替换 effort 包装 | `/effort` 行为不变；模型切换时日志出现持久化切换通知 |
| 6 | **3.1**：`user-questions/request` 应答器 | 飞书会话里 `ask_user_question` 能出按钮并回填 |
| 7 | **3.4 + 3.5**：`/history` 走 `sessionQuery`、新增 `/stop` | 命令卡渲染真实事件；`/stop` 后卡片进入 aborted 终态 |
| 8 | **P1-B + 3.7**：schemastery `Config`、`displayReason`、effect 标签 | settings UI 能渲染 schema；凭据字段显示为引用选择器 |

---

## 6. 证据与复现方法

**版本基线**

```bash
# 本机安装版本（Electron app.asar）
strings "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" | grep -m1 '"version"'
# → 0.2.0-rc.2（@deepseek-ai/cordis 4.0.4）

# 拉取对应源码（沙箱内只读原 checkout，故 clone 到 /tmp）
git clone --depth 1 --branch dsh-v0.2.0-rc.2 https://github.com/deepseek-ai/deepseek-harness.git /tmp/dsh-0.2.0-rc.2
git -C /tmp/dsh-0.2.0-rc.2 fetch --depth 1 origin tag dsh-v0.1.7-rc.1   # 用于 diff
```

**两个 P0 的判定命令**

```bash
# P0-A：0.2.0 的 Session 类没有 events，只有已标注 @deprecated 的读取器
grep -n "eventAt(seq\|snapshotEvents(\|ownEvents(" /tmp/dsh-0.2.0-rc.2/packages/core/session/src/index.ts
# 删除该 getter 的提交：
git -C /Users/moka/dev/project/open_source/deepseek-harness show 5660f44d29 -- packages/core/session/src/index.ts | grep "^-.*get events"

# P0-B：生产代码里没有 assistant/chunk，只有 v0/v1 迁移代码
grep -rn "assistant/chunk" /tmp/dsh-0.2.0-rc.2/packages --include=*.ts | grep -v migration
# 现行瞬时流事件：
grep -n "agent/assistant-stream" /tmp/dsh-0.2.0-rc.2/packages/core/agent/src/runtime-types.ts
```

**插件侧复现（静态）**

```bash
cd /Users/moka/dev/project/dsh_ext/dsh_channels
grep -rn "\.events" src/            # 9 处 P0-A
grep -rn "assistant/chunk" src/     # P0-B
pnpm typecheck && pnpm test         # 均通过——说明现有测试没有覆盖真实 Session 形状
```

**运行时探针**（确认 `session.events` 在缺失时是硬失败而非静默）

```js
const session = { id:'s1', header:{}, snapshotEvents:()=>[], eventAt:()=>undefined, seq:0 }
for (const e of session.events) {}   // TypeError: session.events is not iterable
```

**DSH 侧关键证据索引**

| 主题 | 位置 |
|---|---|
| 同步日志读取废止 | `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md:15` |
| 流帧定义 | `packages/core/agent/src/runtime-types.ts:128,363` |
| 持久化流记录 | `packages/llm/llm/src/assistant-stream.ts:20` |
| `StreamChunk` 词表 | `packages/llm/llm/src/types.ts:452-464` |
| Session 投影 | `packages/session/session-projection/src/index.ts:208`；`docs/subsystems/session-projection.md:205-244` |
| `sessionStats` / `tokenUsage` / `contextPressure` | `packages/session/session-stats/src/projection.ts:114`；`packages/llm/token-meter/src/usage-projection.ts:118,174` |
| 模型选择 | `packages/core/agent/src/model-selection.ts:81`；ACP 用法 `packages/acp/acp/src/model-control.ts:5,52` |
| 历史查询 | `packages/session-query/session-query/src/index.ts:106` |
| 结构化提问 | `packages/interaction/user-questions/src/index.ts:85,318-321`；`src/types.ts:157-161` |
| 取消 | `packages/core/agent/src/runtime-types.ts:183` |
| 插件兼容性闸门 | `packages/boot/app-boot/src/plugin-compatibility.ts:68,75,77` |
| 插件 Config 约定 | `docs/cordis-tutorial/05-config.md:22-34`；`packages/webhook/webhook-github/src/index.ts:17-33` |
| `displayReason` | `packages/interaction/user-approval/src/types.ts:73` |
| 作用域分发（未打标 listener 收全部） | `packages/core/scope/src/index.ts:176` |
| bundle 装配 | `packages/bundle/base/cordis.patch.yml:149-150,251,338-339`；`packages/bundle/web-app/cordis.patch.yml:27,102-103` |

---

## 7. 实施状态（2026-09-30）

本次已按 §5 的顺序落地 P0 与用户选定的高价值项；`pnpm typecheck` 通过，`pnpm test` **263/263 通过**（新增 23 个用例）。

### 7.1 已实现

| 项 | 落地内容 | 关键位置 | 测试 |
|---|---|---|---|
| **P0-A** `Session.events` → `snapshotEvents()` | 类型桥改为范围读取器 + 可选 `requestHeader()`；9 处调用点全部迁移 | `src/dsh-types.ts`、`src/service.ts`、`src/streamer.ts`、`src/stats.ts`、`src/session-export.ts` | 测试 Session 桩改为真实形状（只有 `snapshotEvents()`，不再有 `events` 属性） |
| **P0-B** `agent/assistant-stream` | 新增 `onAssistantFrame()` 处理 `start`/`chunk`/`end`；`abandoned` 尝试按快照回滚正文与推理（含分段尾卡截断），`committed` 保留；根上下文注册瞬时流监听 | `src/streamer.ts`、`src/service.ts` | `TurnStreamer live assistant frames`：文本/推理入卡、abandoned 回滚、committed 保留 |
| **结构化提问** | 新 `QuestionAnswerer`（`user-questions/request`，`prepend`），问答卡（单选点击即答；多选勾选 + 提交）；非发起人无效并提示；超时/取消/关机 fail-closed；无可选项问题明确报错 | `src/questions.ts`、`src/cards.ts`、`src/service.ts`、`src/config.ts`（`questionTimeoutMs`） | `tests/questions.test.ts` 8 例 + service 端到端 4 例 |
| **宿主投影统计** | 卡片 token/缓存/上下文窗口优先读 `sessionStats`/`tokenUsage`/`contextPressure`；`/status` 用 `foldSessionStats` 叠加投影时间与 token；`measureContext` 优先投影窗口；全部带日志折叠回退 | `src/stats.ts`、`src/service.ts`、`src/streamer.ts` | `stats.test.ts` 投影映射/叠加/窗口优先 3 例 + service 卡片投影 1 例 |
| **`/stop`** | 频道面命令：直接 `agent.cancel({ kind: 'user' })`，不冷恢复 Session，无运行回合时明确提示 | `src/commands.ts`、`src/service.ts` | service 2 例 |
| **`displayReason`** | 审批卡优先渲染本地化展示文本（zh → en → 审计 `reason`） | `src/dsh-types.ts`、`src/approvals.ts` | `approvals.test.ts` 1 例 |
| **effect 标签** | `ctx.effect(cb, 'dsh-channels')`，诊断输出可读 | `src/index.ts` | — |
| **附带修复** | `tool/result` 失败判定改为 message 级 `isError`（原先查找的 `tool-result` content block 在 DSH 中并不存在）；TTFT 改为从 `assistant/message.stream` 推导并在有投影时以投影为准 | `src/stats.ts` | `stats.test.ts` 既有用例更新 |

### 7.2 明确推迟（附理由）

| 项 | 原因 |
|---|---|
| **3.3 `installModelSelection`** | 该 API 要求 `ModelSelection` 携带确定的 `provider`/`model`，而本插件的 `provider`/`model` 配置可省略（交给部署默认）。改用它会引入 `@deepseek-ai/dsh-agent` 运行时依赖，并把"部署默认路由"钉死为会话级选择，属于需要真机验证的行为变更；当前 effort-only 的 `agent/request` 包装在 0.2.0 下语义正确。建议在真正需要 `/model` 切换时一并迁移。 |
| **P1-B Config schemastery** | 需要新增 `@deepseek-ai/schemastery` 依赖；现有 zod 校验（与宿主同版本）行为正确，只是错误暴露时机偏晚。 |
| **P1-C `@deepseek-ai/dsh*` peerDependencies** | 需确认这些包在目标 registry 可解析并同时进入 `devDependencies`，否则会破坏 `link:` 安装与本地 `pnpm install`。建议随插件发版一并处理。 |
| **3.4 `/history`、`/export` 改走 `ctx.sessionQuery`** | 本次已让 `/status` 走投影；`/history` 仍读路由内历史，`/export` 仍自建逻辑日志。迁移到 `sessionQuery` 属于读取路径重构，不影响当前正确性。 |
| **整段日志折叠的彻底投影化** | `attach()` 仍用一次 `snapshotEvents()` 播种增量折叠（官方允许存量逻辑暂缓迁移）；卡片热路径已优先投影，整段读取只发生在会话 attach 与显式命令。 |

### 7.3 回归验证

```bash
cd /Users/moka/dev/project/dsh_ext/dsh_channels
node_modules/.bin/tsc --noEmit   # 0 错误
node_modules/.bin/vitest run     # 16 files, 263 tests passed
grep -rn "session\.events" src/                  # 无输出（调用点已全部迁移）
grep -rn "assistant/chunk" src/                  # 仅剩解释性注释
```

新增覆盖：`tests/questions.test.ts`（8）、service 端到端 4（提问接线、问答卡 owner-gated、关机撤回、投影卡片）+ `/stop` 2 + assistant-stream 驱动 1、`streamer.test.ts` 帧处理 3、`stats.test.ts` 投影 3、`approvals.test.ts` displayReason 1。测试 Session 桩已改为 DSH 0.2.0 的真实形状（无 `events` 属性），因此 P0-A 若回归会直接失败。

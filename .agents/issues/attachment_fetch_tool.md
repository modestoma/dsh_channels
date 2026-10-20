# P1 附件获取工具：feishu_attachment_fetch

## 目标、范围与非目标

实现模型工具 `feishu_attachment_fetch`：按消息 id（可指定 file_key）从当前飞书会话取回图片/文件，图片返回 `ImageBlock`，文件流式写入 DSH 原生附件库并返回 `FileBlock`（退化时返回句柄文本 + 只读路径）。

范围：

- 工具定义使用本地窄类型手写（不引入 DSH 运行时依赖；参数用 zod 校验），支持 `presentCall`/`presentResult` 以便卡片展示“下载附件 xxx”。
- 每 route 维护“已知消息/资源”白名单（LRU 上限）：来自触发消息、引用消息、静默登记、历史工具结果；工具只允许下载白名单内的 `message_id`/`file_key`，防止提示注入请求任意消息。合并转发登记为顶层容器消息，子资源按容器 id 下载。
- 挂载：在 preset `setup` 之后 `agentCtx.inject(['tools'])` 注册；`tools`/`attachments` 任一缺失时 no-op 并记录一次告警；borrow 的 live agent 也做一次 best-effort 补挂（竞态防护）。
- 限制：单次资源数（默认 10）、单次总字节（默认 100 MiB）、`timeoutMs`（默认 120s，可配）；下载遵守 `exec.signal`，中途取消不留下半文件。
- 失败：逐资源返回结构化错误（过期/权限/超限/文件夹不支持），不中断整次调用；全部失败返回可读原因。
- 功能开关：`feishuTools.attachmentFetch`（默认开）。

非目标：不实现消息历史/引用读取工具（见 `quote_history_tools`）；不改准入流程（见 `admission_manifest_flow`）。

## 前置产物与解除条件

依赖 `native_attachment_store` 的图片/文件入库接口，`pending_attachment_registry` 的登记查询接口；依赖 `platform_spike` 的工具注册与 `FileBlock` 下发结论。

## 验收条件与验证方法

| AC | 验证方法 | 通过标准 |
| --- | --- | --- |
| AC1 工具注册 | 单元测试 + 手动 | 仅当 tools/attachments 可用时注册；卡片展示工具行；重启恢复后可调用 |
| AC2 白名单授权 | 单元测试 | 非本 route 消息/未登记 file_key/跨话题 id 一律拒绝；合法 id 通过 |
| AC3 图片结果 | 单元测试（stub 下载 + attachments） | 返回 `ImageBlock` + 文本元数据；文本模型降级为占位说明 |
| AC4 文件结果 | 单元测试 | 流式入库返回 `FileBlock`（或退化路径文本 + 校验信息）；内容一致性断言 |
| AC5 限制与取消 | 单元测试（假时钟/信号） | 超资源数/字节/超时拒绝并说明；取消后临时对象可清理 |
| AC6 合并转发 | 单元测试 | 用容器 message_id + 子 file_key 下载成功；子消息 id 作为下载 id 时给出明确错误 |
| AC7 构建 | `pnpm typecheck` | 通过 |

## 决定、授权与待答

- 用户决定：文件懒取、图片预取；不预下载；工具漏调通过工具与 prompt 优化收敛。
- 待答：工具结果 `FileBlock` 若不被支持，采用句柄文本退化（默认方案）。
- 待答：是否给成功下载的源消息补 DONE 表情（体验项，P3 决定）。

## 验证与交付证据

### 环境与基线（2026-10-21）

- 仓库 `/Users/moka/dev/project/dsh_ext/dsh_channels`，本地 `main`；开始基线 `main@4c7e7f4a8fb98ce60c94297a489a2c3590dd6c7e`（P0 收官 `3f05d81` 之后的前置任务证据提交）。按 D9/D10 不创建平台 Issue/Milestone、不拉分支/worktree、不使用 PR，仅本地 `main` 提交，不推送。
- Node v24.19.0 / pnpm 12.14.0；DSH 0.2.1-rc.2 desktop profile（`include:storage-json`；`ctx.tools` / `ctx.attachments` 可用性沿用 P0 结论）。
- 实现提交：`6127882be312a14e7dd46347840a75f3edd8ca7e`（feat，含实现与 66 项测试）；证据提交为随后追加的 docs 提交（SHA 记录在 `runtime.json` resume 与本文件 Git 历史）。
- 写入范围说明：除 Issue 预计范围外，`src/service.ts` 增加约 40 行必要接线（构造 `AttachmentFetchToolRuntime`、注入 `SessionManager.mountTools`、暴露窄登记方法 `noteKnownAttachmentMessage`、route 退休/关闭时回收白名单）；未改准入/prompt 主链路（非目标保持）。

### 实现落点

| 产物 | 文件 | 说明 |
| --- | --- | --- |
| 工具定义 + 白名单 | [src/feishu/tools.ts](../../../src/feishu/tools.ts)（新增，约 1570 行） | 本地窄类型手写 `ToolDefinition`（不 import DSH 运行时包）；zod 参数校验 + 手写 JSON Schema；`presentCall`/`presentResult`；`RouteAttachmentWhitelist`（每 route LRU 64）；图片/文件下载、`FileBlock` + 句柄文本兜底、合并转发展开、限制/超时/取消、逐资源结构化失败、lossless JSON、非 Error 抛值可读化 |
| 挂载 | [src/session/manager.ts](../../../src/session/manager.ts) | `SessionManagerDeps.mountTools`；`presetComposition` 在 `presets.mount` + 命令挂载后调用；create/resume/renew 全部传 `sessionId`；borrow live agent 做一次 best-effort 补挂（WeakSet 去重） |
| 服务接线 | [src/service.ts](../../../src/service.ts) | 构造 `AttachmentFetchToolRuntime`（channel/pending/routeOfSession/config/warn）；`noteKnownAttachmentMessage(record, message, source)` 窄接口给 admission/quote；route GC/清理/关闭回收白名单；record GC 中 `pruneRoutes` 兜底 inbound-TTL 退休路径 |
| 配置 | [src/config.ts](../../../src/config.ts) | `feishuTools.attachmentFetch`（默认开）、`attachmentFetchMaxResources`（默认 10）、`attachmentFetchMaxBytes`（默认 100 MiB）、`attachmentFetchTimeoutMs`（默认 120s，可配 1s–600s） |
| 测试 | [tests/feishu-tools.test.ts](../../../tests/feishu-tools.test.ts)（新增 66 项）；[tests/service.test.ts](../../../tests/service.test.ts) 仅补 `makeConfig` 新字段 | AC1–AC6 覆盖 + 负向/边界/取消/挂起/服务重载 |

### 逐条 AC 验证

| AC | 验证方法 | 实际结果 | 结论 |
| --- | --- | --- | --- |
| AC1 工具注册 | 单元测试 + manager 集成测试 | 仅在 `inject(['tools','attachments'])` 回调内且两服务可解析时 `tools.register`；在 preset `mount` 之后注册（manager 测试断言 `['preset','tools']` 顺序与 sessionId 传递）；resume 挂载、borrow 补挂各一次；缺 tools/attachments、injection reject、真实 cordis「依赖缺失 settle 但不回调」均 no-op + 单次告警；服务 2s 内不可用不阻塞建会话（后续会话 250ms fast-fail），晚到服务仍会补注册；宿主服务 unload/reload 后同一 callback ctx 重跑会重新 `register`（回归测试）；功能开关关闭不注入/不注册 | ✅ 自动；⏳ 真机卡片工具行/手动待 admission 接线后验证 |
| AC2 白名单授权 | 单元测试 | 白名单按 route.key + kind/chat/chatType/sender 精确匹配；消息先白名单、再 durable pending registry（scope 绑定）；跨 chat/thread/sender、过期 pending、未登记 message_id 一律 `AUTHORIZATION_DENIED` 且不触达 channel；`file_key` 必须属于该消息已解析资源集，否则 `UNKNOWN_FILE_KEY`；topic route 可读同 chat+同 sender 的 chat 主时间线 pending 行（AC-4 回退）；子消息 id 未登记时明确拒绝；`pending.consume` 仅“至少一个资源成功”后执行且与 signal 竞速 | ✅ 单测；端到端写入方待 admission 接线（见下） |
| AC3 图片结果 | 单元测试（stub 下载 + attachments） | 返回 `ImageBlock` + 文本元数据（name/bytes/尺寸/media type/只读路径）+ 文本模型占位说明；不支持格式 `UNSUPPORTED_IMAGE_TYPE`、超宿主 `maxImageBytes` `IMAGE_TOO_LARGE`、超总预算 `BYTES_LIMIT`；失败不产生 attachment | ✅ |
| AC4 文件结果 | 单元测试 | 流式交给 `saveFileStream`（新增“源未结束 store 已拿到首块”测试），返回 `FileBlock` + 句柄文本（name/bytes/sha256 前缀/只读路径）；内容一致性断言（存储字节 == 下载字节）；宿主不映射路径时文本兜底 “cannot access a readable path”；执行期附件服务卸载返回结构化 `ATTACHMENT_SERVICE_UNMOUNTED` | ✅ |
| AC5 限制与取消 | 单元测试（假时钟/信号） | 资源数超限在下载前拒绝；总字节预算流中执行（等于上限通过、超 1 字节拒绝、多资源累计、图片预算）；`timeoutMs` 到点中止并把剩余资源标记 TIMEOUT；预取消不下载；下载中取消映射 ABORTED、fake store 不提交且记录 abort；`pending.consume` 挂起也不会拖住超时后的返回；逐资源失败不中断整体 | ✅ 自动；取消不下传 HTTP 层为已知限制 |
| AC6 合并转发 | 单元测试 | 合并转发资源始终用顶层容器 message_id 下载；子消息 id 作为下载 id 被明确拒绝；post 子消息的 `content` 行内 img/file/media、顶层 `files[]`、已知 locale 包裹、`is_folder` 均可发现；非标准嵌套 `files` 不被采纳；folder 结构化 `FOLDER_UNSUPPORTED`；展开后超资源上限整体拒绝 | ✅ |
| AC7 构建 | `pnpm typecheck` / `pnpm test` / `pnpm build` | 全部通过（见下） | ✅ |

### 命令与结果（2026-10-21 本机）

```text
pnpm typecheck   -> exit 0（tsconfig.json + tsconfig.client.json）
pnpm test        -> 28 files passed / 722 tests passed（新增 tests/feishu-tools.test.ts 66 项；基线 656）
pnpm build       -> host lib/index.js 503.00 kB（gzip 145.62 kB）+ client lib/client.js 125.40 kB，均 Build complete
git diff --check -> exit 0
node -e import('./lib/index.js') -> bundle loads（133 exports）
```

### 真实宿主契约校验（离线，不触碰运行中 profile）

从本机 DSH 0.2.1-rc.2 安装包（app.asar）解出 `@deepseek-ai/dsh-tools`，直接校验本工具定义：

```text
assertSupportedJsonSchema(ATTACHMENT_FETCH_PARAMETERS)  -> 通过
assertSupportedJsonSchema(ATTACHMENT_FETCH_OUTPUT_SCHEMA) -> 通过（output schema 是 register 期硬校验）
validateJsonSchemaValue(parameters, {message_id, file_key}) -> []
validateJsonSchemaValue(output, 示例 value) -> []
render(value) -> text,image blocks
```

结论：手写窄类型定义与真实宿主注册/投影契约一致；参数 schema 只做模型投影（宿主不重验参数），zod 是权威参数闸门。

### 独立评审与修复

- teammate `attachment-reviewer` 两轮只读评审（未写文件/未提交）：首轮无 P0；提出 P1-1 post `files[]`/locale/folder 解析缺口、P1-2 交接面与误导注释，另有取消 HTTP 层、consume 时机、错误截断/转义等 P2。修复后增量复审 **可放行**（独立探针复验 post/consume/mount/非 Error 描述），确认最终快照 `tools.ts ef5e5887…` / `tests d7f91c0e…`（66 项）。
- teammate `attachment-security-reviewer` 两轮只读评审（未写文件/未提交）：首轮无 P0；P1-1 `pending.consume` await 未被超时覆盖（可挂死回合）、P1-2 非 Error 抛值 `[object Object]`、P1-3 真实 cordis 缺失依赖 settle 不回调导致无告警；P2 含 callback-ctx 去重回归、对象整序列化泄漏、post 任意嵌套 `files` 采纳面、presenter/render 防御等。修复后增量复审发现 P1-1（按 callback-ctx 去重会吞掉宿主服务重载后的重注册）回归；删除该判重并补重载回归测试后，最终复审确认 **P1 闭环、无新增阻塞、可放行**（快照 `tools.ts ef5e5887…` / `tests d7f91c0e…` / `service.ts 8964356a…`）。
- 已修复清单（不逐条展开）：post/locale/files/folder；consume-after-success 且 cancellable race；非 Error 抛值字段白名单（code/status/…）+ 控制字符清洗 + 截断；真实 cordis settle-without-callback 告警；mount 外层去重 + 宿主服务重载重注册；UNKNOWN_FILE_KEY 列表截断；presenter/render null/畸形防御；route 退休/GC/shutdown 白名单回收 + `pruneRoutes`；死字段/误导注释清理。
- 未采纳/记录项：取消不下传飞书 HTTP 层、content-addressed 孤儿窗口、白名单不重放历史、`acceptAttachments=false` 重新启用后 live agent 不补挂、失败 mount 尝试缓存一次、`noteKnownAttachmentMessage`/service GC 接线无 service 级测试——均记录在下方已知限制或交给 admission 接线后补验。

### 下游接口约定（给 `admission_manifest_flow` / `quote_history_tools`）

1. **触发消息授权**（二选一或并用）：
   - 推荐：admission 在通过准入后调用 `PendingAttachmentStore.registerMessage(msg, { admitted: true })`；工具按 route scope 查询，成功后 consume，durable 记录跨重启仍可重试。
   - 即时授权：`FeishuService.noteKnownAttachmentMessage(routeRecord, { messageId, kind, resources }, 'trigger')`。**route 必须由已持久化的 `RouteRecord` 构造**（与 `routeOfSession` 同源），不能按 `msg.threadId` 手拼：topic 首条触发消息的白名单必须是 thread route，否则工具查不到。
2. **引用消息**：`quote_history_tools` 用同一窄接口（source `'quote'`）登记经 `messageGet` 校验的 `parent_id` 及其资源；**只能用可信事件字段**，不得登记模型输出/未校验字符串。
3. **containerMessageId**：只有可信登记（pending 记录或 admission/quote 登记）可填，表示合并转发子资源必须经顶层容器 id 下载；工具绝不从模型参数取下载 id。
4. **接线点**：admission 需要把登记回调注入 `InboundDeps`；其 plan 资源未列 `src/service.ts`，但实际需在该文件加一处 port（本次已提供 service 方法与 runtime），协调者已在 `runtime.json` resume 记录该交接项。
5. 工具自带单次资源数/字节/超时/取消/逐资源失败，调用方无需重复处理；工具在无授权时 fail-closed 返回可读拒绝，不会抛异常中断回合。

### 未验证项 / 已知限制

1. **真机/手动未做**：本会话文件沙箱为 workspace-write，未修改 `~/.dsh` 触发 HMR/profile 重组合，故未做真实 profile 重载冒烟；AC1 的“卡片展示工具行、重启恢复后可调用”与 AC2/3/4/6 真机项待 `admission_manifest_flow` 接线后由用户手测（接线前工具对所有消息 fail-closed 拒绝）。
2. **端到端可用性依赖 admission**：主链路仍走旧 archive，白名单/pending 暂无生产写入方；本任务只交付工具、白名单与窄接口（与 roadmap 依赖顺序一致）。
3. **`inject(['tools','attachments'])` 组合真机未验证**：P0 仅验证 `['tools']`。缺失服务时 mount 最多等待 2s（后续会话 250ms fast-fail）并单次告警，不阻塞建会话；真实 cordis “依赖缺失 settle 但不回调”路径已用宿主 cordis 包离线探针 + 单测覆盖；晚到服务可补注册。
4. **取消不下传飞书 HTTP 层**：`FeishuChannel.downloadResource` 无 signal 参数；工具在消费端按 chunk / await 竞速并及时返回、不提交半文件；宿主 `saveFileStream` staging→原子发布/清理已从本机安装包源码核验。但（a）已发出的 Range 请求/Node 流可能滞留到自身超时/GC；（b）staging 完成到发布之间 abort 会留下无引用、不自动回收的 content-addressed 完整对象（孤儿窗口）——不宣称“取消后零残留”。
5. **白名单进程内、不重放 Session 历史**：重启后旧消息授权丢失；durable pending registry（TTL 内）覆盖已登记消息，admission/manifest 每轮重新登记当前消息；route 退休/GC/关闭已接 forget/clear/prune。
6. **开关不动态摘除已注册会话**：`acceptAttachments=false` 时新会话不挂载；之后面板重新启用，已存在 live agent 不会补挂（新会话/`/renew` 后正常）。失败 mount 尝试按 agent 作用域缓存一次，不自动重试。
7. **面板/文档未暴露 `feishuTools.*`**：嵌套配置在 Web overlay 是浅合并；`panel_docs_release` 若把子键加入 `EDITABLE_KEYS` 需先实现嵌套 merge，否则部分覆盖会让 `attachmentFetchMaxBytes`/`attachmentFetchTimeoutMs` 变 `undefined`（预算静默失效/立即超时）。
8. **`attachmentStore: 'archive'` 与工具**：工具只看宿主 attachments 服务是否挂载，不看配置；显式 archive 但原生服务已挂载时仍会注册并写原生库。admission/panel 需确认产品语义。
9. **messageGet 形状**：基于 P0 结论与飞书文档；真实多语言/特殊元素形状未真机覆盖，未知形态 fail-closed（不会误下载非标准嵌套资源）。
10. **AC5“取消后临时对象可清理”**：由 fake store + 宿主源码核验间接证明，非真实 profile 端到端。


## 启动 Prompt（复制到新会话）

```text
你负责 attachment_pipeline_v2 / attachment_fetch_tool 的实现。

仓库：/Users/moka/dev/project/dsh_ext/dsh_channels，本地 main 分支。
执行约束（decisions.md D9/D10）：不创建平台 Issue/Milestone；不拉分支/worktree；不用 PR；直接改本地 main 并本地提交；不推送、不合并、不发布；提交用 conventional commit。

开始前阅读：
1. .agents/issues/attachment_fetch_tool.md（本任务正文与 AC）
2. .agents/roadmaps/attachment_pipeline_v2/roadmap.md 与 plan.json
3. .agents/roadmaps/attachment_pipeline_v2/decisions.md（D1–D10）
4. .agents/notes/2026_10_20_attachment_pipeline.md
5. .agents/issues/platform_spike.md 的 P0 证据（P0 收官 3f05d81；开始时以 git rev-parse HEAD 为准）
6. 前置任务证据：native_attachment_store、pending_attachment_registry 的“验证与交付证据”与对应提交
7. 相关源码：src/feishu-channel.ts（messageGet/messageList 已就绪）、src/host/agent.ts（tool 运行时类型）、src/session/manager.ts、src/routing/inbound.ts 的会话建立逻辑

P0 已验证、必须沿用的前提与教训：
- 工具注册路径：agent setup 后 agentCtx.inject(['tools']) 注册成功，模型可实际调用；
- 工具结果可以同时携带 text 与 ImageBlock；FileBlock 内容块可下发，但保留文本路径兜底；
- 合并转发资源必须用顶层容器 message_id 下载；子消息 id 会 400；
- 工具输出必须做 JSON 清洗（不能含 undefined，否则 DSH 报 value is not lossless JSON）；
- AbortError / 用户取消必须映射成可读错误（不能是 [object Object]）；
- 大文件下载约 41–44s（980MB），需要 timeoutMs 与 exec.signal 取消。

任务：实现 feishu_attachment_fetch 工具（细节以本 Issue AC 为准）：
- 本地窄类型手写定义（不 import DSH 运行时包），zod 校验参数；presentCall/presentResult 便于卡片展示；
- 每 route 维护“已知消息/资源”白名单（触发消息、引用、静默登记、历史工具结果），只允许白名单内 message_id/file_key；合并转发按容器 id 下载子资源；
- 在 preset setup 后注册；tools/attachments 缺失时 no-op + 告警；borrow 的 live agent 做一次 best-effort 补挂；功能开关 feishuTools.attachmentFetch；
- 限制：单次资源数、单次总字节、timeoutMs、取消后不留半文件；失败逐资源结构化返回。

预计写入范围（越界前先暂停询问）：src/feishu/tools.ts（新增）、src/host/agent.ts（如需补类型）、src/session/manager.ts（挂载接入）、src/config.ts（开关）、tests/feishu-tools.test.ts。本任务不接 prompt 清单与准入流程（admission_manifest_flow 负责）。

完成标准：
1. 逐条满足 Issue AC；pnpm typecheck、pnpm test、pnpm build 全绿。
2. 把实际命令、结果、未验证项写回本 Issue 的“验证与交付证据”。
3. 若当前会话是协调者：同步 runtime.json 对应任务 resume 并保持 roadmap validate 通过（按 D10）；否则只更新 Issue。
4. 在 main 上本地提交（不推送）；最终回复：改动摘要、关键文件、测试结果、提交 SHA、风险/未验证项。
5. 遇到范围/接口变化先暂停，在 decisions.md 追加决定并询问用户。
```


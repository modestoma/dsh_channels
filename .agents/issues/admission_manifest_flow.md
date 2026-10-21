# P1 准入重构：立即建会话 + 清单进 prompt + 图片预取 + 文件懒取

## 目标、范围与非目标

把入站主链路从“下载完再开模型回合”改为“会话/话题/卡片零等待 + 清单 + 图片预取 + 文件懒取”：

- 删除 [inbound.ts](../../src/routing/inbound.ts) 在路由决策前同步下载附件的路径；触发消息先完成建会话、话题绑定、卡片第一帧、路由持久化、工具挂载，再拼 prompt。
- prompt 组装（新模块 `src/feishu/manifest.ts`）：稳定 `<feishu_context>` 块，只列**未加载**的附件元数据（`message_id` / `file_key` / 类型 / 文件名）与“用 `feishu_attachment_fetch` 获取”的提示；对已预取的图片不列“未加载”。无清单内容时不产生 token。
- 纯附件消息（私聊仅附件；群未 @；已绑定话题内的纯附件消息）：通过准入后只做静默登记，不下载、不建会话、不回复、不加表情。
- 图片预取：触发消息中的图片在 route 建立后、`followup` 前取回并写入 `ctx.attachments`，以 `ImageBlock` 进入首轮消息；预取有单图/总字节上限与短超时，失败/超限自动降级为清单 + 工具。`prefetchImages` 可关闭。
- `followup` 使用组装后的多块内容（文本 + 图片块 + 清单文本块）。
- 更新 [agent-context.ts](../../src/feishu/agent-context.ts) guidance：附件在 DSH 原生库；文件默认未加载，用工具取；只读副本修改前复制；不要主动枚举其他附件。
- 保留 `attachmentStore: 'archive'` 降级路径：无 `ctx.attachments` 或显式配置时，仍按旧行为下载到话题 `attachments/`，保证 headless/旧部署可用。
- 旧 `_staging` 目录的遗留文件：建会话时保留一次性迁入（兼容升级），新流程不再写入 staging。

非目标：引用消息摘录与话题历史工具（`quote_history_tools`）；面板与文档（`panel_docs_release`）；后台预取。

## 前置产物与解除条件

依赖 `attachment_fetch_tool` 的工具与白名单可用（此时清单里的文件确实能被取到）；依赖 `native_attachment_store` 的图片入库与 `pending_attachment_registry` 的登记查询。

## 验收条件与验证方法

| AC | 验证方法 | 通过标准 |
| --- | --- | --- |
| AC1 零等待 | service 测试（阻塞下载桩）+ 手动 | 下载未完成时卡片/会话已建立；`followup` 不等待文件字节 |
| AC2 清单正确 | 单元测试 | 触发附件/待登记附件出现在清单；已预取图片不出现；无附件时无清单块 |
| AC3 纯附件静默 | service 测试 | 不建 Agent、不发送、不加表情、不下载；登记可查 |
| AC4 图片预取 | 单元测试 + 手动 | 首轮消息含 ImageBlock；预取失败/超限降级为清单，不阻塞会话 |
| AC5 文件懒取 | service 测试 | 未调用工具不下载；调用后能读到内容；清单驱动成功 |
| AC6 话题/群行 | service 测试 | 私聊/对话群/话题群三类触发与未触发行为符合 Roadmap 矩阵 |
| AC7 archive 降级 | service 测试 | 配置 archive 或缺服务时行为与旧版一致 |
| AC8 构建 | `pnpm typecheck && pnpm test` | 通过 |

## 决定、授权与待答

- 用户决定：立即建会话；清单进 prompt；图片预取；文件懒取；不接受预下载兜底。
- 待答：图片预取是否默认开启（当前默认开，可配置关）；文本模型路由下的图片降级提示文案。

## 验证与交付证据

### 环境与基线（2026-10-21）

- 仓库 `/Users/moka/dev/project/dsh_ext/dsh_channels`，本地 `main`；开始基线 `main@b21c5c2b54015264fc5396f580c04c5e4e017fbb`（P0 收官 `3f05d81` 之后的前置任务证据提交）。按 D9/D10 不创建平台 Issue/Milestone、不拉分支/worktree、不使用 PR，仅本地 `main` 提交，不推送。
- Node v24.19.0 / pnpm 12.14.0；DSH 0.2.1-rc.2 desktop profile（`include:storage-json`；`ctx.tools` / `ctx.attachments` 可用性沿用 P0 结论）。
- 实现提交：`8cf9c81d5502dbfb6b2d6010c10ef32abd6b2c75`（feat，含实现与测试）；证据为本文件随后的 docs 提交。
- 写入范围说明：除 Issue 预计范围外，为满足 AC 做了必要接线/新增，均记录在下方“实现落点”：`src/service.ts`（约 70 行：`InboundAttachmentStore` 构造、inbound 新 deps、`noteKnownAttachments`、prefetch 策略、有效后端判定、按后端门控工具挂载）、`src/session/manager.ts`（guidance 按 effective backend 选择）、`src/feishu/native-attachments.ts`（宿主级 `resolveAttachmentService` 窄化、`effectiveAttachmentMode`）、`tests/helpers.ts`（fake attachments/tools/宿主服务），以及新增 `tests/manifest.test.ts`、`tests/inbound-image-prefetch.test.ts`、`tests/config.test.ts` 的 prefetch 配置边界用例（原计划未列测试文件；新模块/纯函数需要聚焦单测）。`src/workspaces.ts` 未改：`_staging` 仅保留既有一次性迁入逻辑，新 native 流程不写 staging，无需调整。

### 实现落点

| 产物 | 文件 | 说明 |
| --- | --- | --- |
| 入站主链路 | [src/routing/inbound.ts](../../../src/routing/inbound.ts) | effective backend 分流：archive/缺服务/工具关闭 → 旧同步落盘；native → 不下载任何字节即分类。纯附件/群未 @/话题内纯附件 → 准入后只 `PendingAttachmentStore.registerMessage`，不回复/不建会话/不加表情/不下载；触发消息建会话/话题/首帧卡片/持久化路由/挂载工具后组装 prompt；图片在 `routes.put` 后、`followup` 前预取（单图/总字节上限 + 整段短超时，失败降级清单）；followup 为 `[文本, ImageBlock…, <feishu_context>]` 多块；首回合投递闸门（`firstDeliveries`）保证同话题后续消息等待首轮 followup，避免预取窗口内乱序；触发消息用已持久化 `RouteRecord` 登记 fetch 白名单；问答拦截消耗附件时补静默登记。 |
| 清单块 | [src/feishu/manifest.ts](../../../src/feishu/manifest.ts)（新增） | 纯函数、稳定 `<feishu_context>`：固定头尾 + 每行 `- message_id=… file_key=… type=… name="…"`；只列未加载附件（已预取图片按 fileKey 排除）；trigger 在前、pending 按 store 顺序，`(message_id,file_key)` 去重、consumed 跳过、merge_forward 只出容器行；无内容返回 `''`（零 token）；id 白名单 + name 对 C0/C1/Cf/Zl/Zp 与 `<>` 做 `\uXXXX` 转义；`MANIFEST_MAX_ROWS=50` 硬上限 + omitted 行。 |
| Agent guidance | [src/feishu/agent-context.ts](../../../src/feishu/agent-context.ts) | 双模式：native（原生库、触发图片已可见、文件默认未加载、`<feishu_context>`、按需 `feishu_attachment_fetch`、只读副本修改前复制、不主动枚举/只访问本会话）与 archive（旧文案逐字保留 + 会话目录绝对路径）。section 名与 order(950) 不变。 |
| 分类 + 预取 | [src/feishu/inbound-attachments.ts](../../../src/feishu/inbound-attachments.ts) | 新增 `inboundAttachmentState`（不下载的 hasPayload/resources/text/attachmentOnly 分类，与 archive/native 既有判定一致）与 `prefetchImageAttachments`（依赖注入、顺序下载、单图上限超限只跳过该图、总预算耗尽停止后续、整段 deadline、超时保留已成功块、结构化失败、非 Error 可读、无悬挂 timer、绝不抛异常）。既有 `AttachmentIntake` 行为未改。 |
| 有效后端 | [src/feishu/native-attachments.ts](../../../src/feishu/native-attachments.ts) | `resolveAttachmentService` 接受宿主级窄上下文（直接属性 + `ctx.get` 双路径）；`effectiveAttachmentMode(configured, service, attachmentFetchToolEnabled, attachmentsEnabled)`：显式 archive、缺宿主服务、fetch 工具关闭或附件关闭 → archive（保证旧语义可读/惰性）；否则 native。`InboundAttachmentStore` 文档说明 native 主链路不调用 `store()`、forwarded-record 文本降级仅 archive 部署。 |
| 服务接线 | [src/service.ts](../../../src/service.ts) | 构造 `InboundAttachmentStore`（`mode` 用 effective backend）、`nativeAttachmentService`（宿主级解析，native 配置缺服务时一次性 warn）、inbound 新 deps、`noteKnownAttachments`、prefetch 策略；`mountTools` 只在 native effective backend 挂 fetch 工具。 |
| guidance 接线 | [src/session/manager.ts](../../../src/session/manager.ts) | `mountGuidance` 按 effective backend 传 native/archive 模式与目录；`acceptAttachments=false` 时不挂附件 guidance（旧的 archive 文案会错误声称文件已归档）。 |
| 配置 | [src/config.ts](../../../src/config.ts) | 新增 `prefetchImages`（默认开）、`prefetchImageMaxBytes`（默认 20 MiB）、`prefetchTotalMaxBytes`（默认 50 MiB）、`prefetchTimeoutMs`（默认 10 s，100 ms–120 s）；更新 `acceptAttachments` / `attachmentStore` / `feishuTools.attachmentFetch` 文档说明。 |
| 测试 | [tests/service.test.ts](../../../tests/service.test.ts)、[tests/manifest.test.ts](../../../tests/manifest.test.ts)（新增）、[tests/inbound-image-prefetch.test.ts](../../../tests/inbound-image-prefetch.test.ts)（新增）、[tests/inbound-attachments.test.ts](../../../tests/inbound-attachments.test.ts)、[tests/config.test.ts](../../../tests/config.test.ts)、[tests/helpers.ts](../../../tests/helpers.ts) | service 新增 15 项 AC 场景（阻塞预取零等待、顺序闸门、纯附件静默 ×3、清单、预取降级矩阵、懒取工具执行、工具关闭 archive 落点、foreign/denied 负向、archive 降级）；manifest 10 项；prefetch 21 项；guidance 双模式；配置边界。fake attachments/tools/宿主服务按真实接口形状提供。 |

### 逐条 AC 验证

| AC | 验证方法 | 实际结果 | 结论 |
| --- | --- | --- | --- |
| AC1 零等待 | service 测试（阻塞下载桩）+ 代码顺序检查 + 独立只读探针 | `establishSession` 顺序：Typing → 首帧卡片/话题 → workspace/repair → createSession（preset setup 内挂工具）→ routes.put → streamer.attach → 预取图片（有界）→ followup；文件字节从不进准入路径。service 测试用可控 gate 断言“卡片/会话/路由已建立而 followup 尚未调用”，释放后首轮含 text+ImageBlock；archive 分支仍在会话前同步下载（旧语义）。新增顺序闸门测试：预取阻塞时同话题第二条消息等待，释放后 followup 顺序为 first→second。 | ✅ 自动 |
| AC2 清单正确 | manifest 单测 + service 测试 + 探针 | 触发附件（文件/未预取图片/merge_forward 容器）与 pending 记录进入清单；已预取图片不出现；无附件/无 pending 时 followup 仅单 text 块（零清单 token）；行格式/去重/consumed/顺序/零 token/恶意元数据转义/50 行上限均有断言；service 断言 p2p 静默附件在下一轮清单出现、预取成功图片不入清单。 | ✅ 自动 |
| AC3 纯附件静默 | service 测试 + 负向测试 + 探针 | 私聊纯附件、群未 @ 文件、已绑定话题内纯附件：准入后仅 pending 登记（可查 domain 表），无 Agent/无发送/无表情/无下载/无路由；`acceptAttachments=false` 纯附件完全惰性且不登记；外来 sender 在他人话题的纯附件/图文混合不登记、不回复（processed 屏障 + settle）；guarded 模式被拒发送者附件不登记（等拒绝通知为屏障）；foreign/denied 行为另经独立探针强 settle 复验。 | ✅ 自动 |
| AC4 图片预取 | 单测 21 项 + service 测试 + 探针 | route 建立后、followup 前预取；成功时首轮第 2 块为 ImageBlock（顺序=消息顺序）；单图/总字节上限；整段短超时（stall 场景 100 ms 配置下回合照跑）；saveImage 失败/单图超限/超时/关闭开关/超总预算均降级为清单且不阻塞会话；单图超限只跳过该图继续后续；底层 stream 不可取消已在注释记录；`prefetchImageAttachments` 永不抛、外层再兜底。 | ✅ 自动（真机手动项见未验证） |
| AC5 文件懒取 | service 测试（执行真实工具定义）+ 探针 | 未调用工具前 `channel.downloadResource` 零调用；followup 含 message_id/file_key/文件名清单；service 测试直接执行真实 `feishu_attachment_fetch` 定义，断言下载、原生库入库字节一致、渲染含 FileBlock/text；触发消息授权在 route put 之后用持久化 RouteRecord 登记（非按 msg.threadId 手拼）；续聊/重启 pending 授权另有前置任务测试与独立探针。 | ✅ 自动 |
| AC6 话题/群行 | service 测试三类会话 | p2p：附件+文字触发、纯附件静默；对话群：@ 触发、未 @ 纯附件静默登记、未 @ 文件后续 @ 后可从清单引用；话题群：首条 @ 建话题、话题内纯附件静默、话题内无 @ 文字续聊正常且清单含静默附件；D3“引用但未 @ 不触发”未引入隐式寻址。 | ✅ 自动 |
| AC7 archive 降级 | service 测试 + 探针 | 显式 `attachmentStore: 'archive'`（即使宿主 native 服务已挂载）→ 旧同步下载到 `_staging`/话题 `attachments/`、占位符剥离、纯文本 prompt、无清单、失败通知与 Typing/DONE/No 表情保持旧语义、不挂 fetch 工具；native 配置但宿主无 attachments 服务 → 同旧行为 + 一次性 warn；`feishuTools.attachmentFetch=false` → 同样整体回退 archive（guidance/工具/落点一致，字节实际落到工作区且 native 库零写入；该断言经“回退 mode 行→测试红”变异验证）；`acceptAttachments=false` → archive/inert（无下载、纯附件不建会话/不回复/不登记、不挂 guidance/工具）；native 主链路不写 `_staging`（探针）；旧 `_staging` 仅保留一次性迁入。 | ✅ 自动 |
| AC8 构建 | `pnpm typecheck && pnpm test && pnpm build` | 全绿（数字见下）。 | ✅ 自动 |

### 三类会话行为矩阵（AC6/AC3）

| 场景 | 私聊 p2p | 对话群（未 @） | 对话群（@） | 已绑定话题（无 @） |
| --- | --- | --- | --- | --- |
| 纯附件消息 | 静默登记，不建会话/不回复/不下载 | 静默登记（后续 @ 建话题可引用） | 静默登记（纯附件不触发） | 静默登记（话题 scope） |
| 文字+附件 | 立即建会话+卡片，图片预取/文件清单 | 不触发、静默登记（旧行为同样不触发） | 立即建会话+卡片 | 续聊：建卡片，图片预取/文件清单，不新建会话 |
| 纯文字 | 建会话 | 不触发 | 建会话 | 续聊 |

### 命令与结果（2026-10-21 本机）

```text
pnpm typecheck   -> exit 0（tsconfig.json + tsconfig.client.json）
pnpm test        -> 30 files passed / 770 tests passed（基线 722；新增 manifest 10 + prefetch 21 + service 15 + guidance 1 + config 1，另既有附件/工具回归全绿）
pnpm build       -> host lib/index.js 547.88 kB（gzip 157.87 kB）+ client lib/client.js 125.40 kB（gzip 27.69 kB），均 Build complete
git diff --check -> exit 0
```

### 独立评审与修复（teammate 只读，未改工作树）

- `review-functional` 两轮只读评审 + `review-security` 两轮只读评审（/tmp 独立探针共 24 + 22 项，全部只读）：无 P0。首轮 P1：① 首回合预取窗口内同话题消息乱序（探针实测 second-before-first）；② 工具关闭/宿主缺 tools 时清单与 guidance 仍宣称 fetch 可用；③ manifest 文件名未转义 Unicode 行/段分隔符与 `<>`；④ AC3 安全负向分支缺提交内测试；⑤ 真机 native 激活未验证（转手动验收）；⑥ merge_forward 转写在 native 主链路不落盘（转 P2 交接）。另有单图超限中止后续、archive 模式挂无用工具、`clear()` 不释放 gate、tool-off 回退落点等 P2。
- 已修复并复核：首回合投递闸门（put 前开 gate、finally 关、step1/step2 等待 queued turn，service 测试锁定顺序）；effective backend 统一含 `attachmentFetchToolEnabled` + `attachmentsEnabled` 并贯穿 inbound/manager/mountTools/`InboundAttachmentStore.mode`（工具关闭时真正旧同步落盘，测试断言 workspace 文件存在且 native 零写入，变异验证有效）；manifest 转义升级 + 50 行上限 + untrusted-data header；单图超限改为只跳过该图；`clear()` 释放 gate；补 foreign/denied 负向与 config 边界测试。第二轮增量复核发现的 P3 也一并处理：宿主缺服务的一次性回退告警改为在 `nativeAttachmentService` 恢复（facade 传入 effective backend 后旧告警分支不可达）；`acceptAttachments=false` 时不再挂 archive guidance（旧文案与实际 inert 行为不符）。
- 修复后两轮增量复核均确认变更正确、无新问题，最终结论 **可放行**；独立探针复验 tool-off 三种回退组合、gate 超时/degraded 路由保序、merge-forward 清单、问答附件登记、native 不写 staging 等行为。
- 宿主级 `ctx.get('attachments')` 解析风险：另用仓库 devDep 的真实 cordis 4.0.5 做临时探针（已删除，无仓库残留）：sibling plugin `ctx.provide('attachments', store)` 后，另一 plugin scope 激活后 `ctx.get('attachments') === store`、`resolveAttachmentService(ctx) === store`、dynamic `ctx.inject(['attachments'])` 回调内直接属性/解析均成功；结合 P0 真机 `agentCtx.inject(['tools','attachments'])` 成功，风险降为低（失败模式为静默回退 archive，不崩不丢附件）；真机 smoke 仍列为手动验收项。

### 下游接口与交接

- `quote_history_tools`：触发消息登记走 `FeishuService.noteKnownAttachmentMessage(record, input, 'trigger')`（本任务已接）；引用消息用同一接口传 `'quote'`，**route 必须来自持久化 RouteRecord**。pending registry 的 `get`/`consume` 需传 route scope（`{chatId, threadId: kind==='thread'?key:undefined, senderOpenId}`），清单已支持 pending `merge_forward` 容器行。native 主链路的合并转发（含转写文本）不再写工作区：子资源由 fetch 工具按顶层容器 id 取；转写文本读取由本任务明确交给 `quote_history_tools`（P2），届时可考虑为 archive 部署重新评估 fetch 工具挂载（本任务为对齐清单/guidance 已让 archive 不挂工具）。
- `panel_docs_release`：新配置键 `prefetchImages` / `prefetchImageMaxBytes` / `prefetchTotalMaxBytes` / `prefetchTimeoutMs` 未加入 `EDITABLE_KEYS`；若加入需处理数字/布尔字段与嵌套 merge；README/onboarding 仍描述 archive 主路径（本任务未改，属 P3）。
- 生效规则（供面板/文档引用）：`attachmentStore: 'native'` 且宿主挂载 `ctx.attachments` 且 `feishuTools.attachmentFetch=true` → native 懒取；显式 archive、宿主缺服务、或 fetch 工具关闭 → 旧同步落盘；`acceptAttachments=false` → 附件消息惰性（纯附件不回复，混合消息保留剥离占位符后的文本）。

### 未验证项 / 已知限制

1. **真机手动验收未执行**（AC1/AC4 的手动项；本机仅跑自动测试与只读探针）：需在 desktop profile 验证 native 激活（`ctx.get('attachments')` 解析、日志无 `attachment-service-unmounted`）、图片首轮 ImageBlock、文件清单+工具懒取、纯附件静默、archive 降级、重启回放（从历史读回图片/文件路径）。提交后由用户执行并回填。
2. **宿主级服务解析**：cordis 4.0.5 真实探针与 P0 证据支持，但宿主 app.asar 内 cordis 版本/组合若不同（极端 isolate 场景）可能解析失败 → 静默回退 archive（v2 不生效但不崩、不丢附件）；真机 smoke 为最终确认。
3. **图片预取等待窗口**：默认单段 10 s（可配 100 ms–120 s）；预取期间卡片已可见但 followup 延后（设计）；底层飞书下载流无法在传输层取消，超时后 in-flight `saveImage` 无法召回，可能留下无引用原生对象（沿用工具任务已知限制）。
4. **触发消息白名单进程内**：重启后旧触发消息的即时授权丢失；静默登记走 durable pending（TTL 7 天）可跨重启授权（前置任务测试 + 探针）。Session 历史中的清单文本仍可提示模型，但 fetch 需重新登记/在 TTL 内。
5. **merge_forward 转写文本**：native 主链路只登记容器元数据（清单行 `type=merge_forward`），转写文本不再落盘；子资源可由工具按容器 id 取。转写读取明确交接 `quote_history_tools`（P2）。这是相对前置任务 `native_attachment_store` 已知限制 #4（native 仍写 forwarded-record 文本）的行为收紧，按本 Issue“新流程不再写 staging”与 P2 范围取舍。
6. **fetch 工具不可用的部署**：工具关闭已整体回退 archive；宿主缺 `tools` 服务但 attachments 已挂载的极端组合下，native manifest/guidance 仍可能宣称工具可用而挂载仅告警（真实 DSH web profile 有 tools 服务，风险低），建议真机 smoke 覆盖并后续在 panel/docs 提示或按挂载结果动态选 guidance。
7. **guidance/工具挂载与 inbound 判定时机**：guidance 在会话创建/恢复时挂、工具在建会话时挂，而 inbound 每条消息判定；运行中热改 `feishuTools.attachmentFetch` 且未重载插件时可能出现短暂错配（正常改配置会重载并在 resume 重挂）。命令面（如 `/renew` 的 busy 检查）不经过首回合投递闸门；新会话预取窗口内的命令竞态仅为推断，未真机复现，也建议后续用同一闸门加固。
8. **manifest 长度与图片张数**：行数硬上限 50；但单条触发消息的图片预取未对齐宿主 `imageLimits.maxImagesPerMessage`（大量小图时首轮 ImageBlock 数可能触达宿主策略；宿主对 followup 内容的强制行为未真机验证）。
9. **静默登记限速**：授权用户可用多话题制造 scope（每 scope cap 10，JSON 后端逐条整文件重写）；本任务未加全局限速（沿用前置任务已知限制）。
10. **`<file .../>` 占位符剥离对文件名含 `>` 的鲁棒性**：既有正则 `/<file[^>]*\/>/` 在恶意/特殊文件名下可能无法剥离，导致纯附件消息被当作文本触发（owned scope 内，非跨用户；HEAD archive 路径同样弱点，未在本任务扩大）。
11. **升级连续性**：旧 archive 部署 `topics/*/attachments/` 的历史附件切换到 native 后 guidance 不再指向该目录；Session 历史仍可用路径读取，但新会话不会枚举旧文件。属 D6 迁移语义，P3 文档说明。
12. 面板/README/onboarding 未更新（panel_docs_release）；`src/workspaces.ts` 未改（不需要）。


## 启动 Prompt（复制到新会话）

```text
你负责 attachment_pipeline_v2 / admission_manifest_flow 的实现。

仓库：/Users/moka/dev/project/dsh_ext/dsh_channels，本地 main 分支。
执行约束（decisions.md D9/D10）：不创建平台 Issue/Milestone；不拉分支/worktree；不用 PR；直接改本地 main 并本地提交；不推送、不合并、不发布；提交用 conventional commit。

开始前阅读：
1. .agents/issues/admission_manifest_flow.md（本任务正文与 AC）
2. .agents/roadmaps/attachment_pipeline_v2/roadmap.md 与 plan.json
3. .agents/roadmaps/attachment_pipeline_v2/decisions.md（D1–D10）
4. .agents/notes/2026_10_20_attachment_pipeline.md
5. .agents/issues/platform_spike.md 的 P0 证据（P0 收官 3f05d81；开始时以 git rev-parse HEAD 为准）
6. 前置任务证据：attachment_fetch_tool、native_attachment_store、pending_attachment_registry 的“验证与交付证据”与对应提交
7. 相关源码：src/routing/inbound.ts、src/feishu/agent-context.ts、src/feishu/inbound-attachments.ts、src/session/manager.ts、src/workspaces.ts 与 service/inbound 测试

P0 已验证、必须沿用的前提：
- 会话/卡片可以先建立，模型回合不必等待附件字节；
- 通道模型 deepseek-flash 支持图片输入，图片预取为 ImageBlock 可行；
- 纯附件消息不回复、不建会话、不下载；未 @ 群事件会投递，静默登记可覆盖群聊；
- 文件由工具懒取；FileBlock + 文本路径双兜底；合并转发资源按容器 id 下载；
- 工具输出 JSON 清洗、AbortError 可读（P0 教训）；被取消回合会在历史里留下失败工具结果。

任务：把入站主链路改为“立即建会话 + 清单进 prompt + 图片预取 + 文件懒取”（细节以本 Issue AC 为准）：
- 删除路由决策前同步下载附件的路径；触发消息先建会话/绑话题/首帧卡片/持久化路由/挂载工具，再拼 prompt；
- 新增 src/feishu/manifest.ts：稳定 <feishu_context> 块，只列“未加载”的附件元数据（message_id / file_key / 类型 / 文件名），无内容时不产生 token；
- 纯附件消息：过准入后只静默登记，不下载、不建会话、不回复、不加表情；
- 图片预取：route 建立后、followup 前预取，超时/超限/失败降级为清单；prefetchImages 可关；
- followup 使用多块内容（文本 + 图片块 + 清单文本块）；
- 更新 agent-context.ts guidance：原生库、文件默认未加载、用工具取、只读副本修改前复制、不要主动枚举其他附件；
- 保留 attachmentStore: 'archive' 旧行为降级；旧 _staging 只保留一次性迁入，新流程不再写 staging。

预计写入范围（越界前先暂停询问）：src/routing/inbound.ts、src/feishu/manifest.ts（新增）、src/feishu/agent-context.ts、src/feishu/inbound-attachments.ts、src/workspaces.ts、src/config.ts、tests/service.test.ts、tests/inbound-attachments.test.ts。本任务不做引用摘录/话题历史工具（quote_history_tools 负责），不做面板与文档（panel_docs_release 负责）。

完成标准：
1. 逐条满足 Issue AC；pnpm typecheck、pnpm test、pnpm build 全绿。
2. 把实际命令、结果、未验证项写回本 Issue 的“验证与交付证据”（至少覆盖三类会话的零等待/纯附件静默/图片预取/文件懒取/archive 降级）。
3. 若当前会话是协调者：同步 runtime.json 对应任务 resume 并保持 roadmap validate 通过（按 D10）；否则只更新 Issue。
4. 在 main 上本地提交（不推送）；最终回复：改动摘要、关键文件、测试结果、提交 SHA、风险/未验证项。
5. 遇到范围/接口变化先暂停，在 decisions.md 追加决定并询问用户。
```


# 飞书附件管线 v2：立即建会话 + 清单/摘录 + 图片预取 + 文件懒取

本 Roadmap 的身份、版本、基线与任务依赖见 `plan.json`；所有 Issue 正文统一在仓库 `.agents/issues/`，由计划引用。执行和平台快照见协调者 checkout 中的 `runtime.json`。

## 最终目标与用户体验

飞书渠道（私聊 / 对话群 / 话题群）收到消息时，**会话、话题、流式卡片零等待**：不再等附件下载完才开始模型回合。触发消息的图片自动预取为原生图片内容，模型可直接看见；文件默认不下载，prompt 用结构化清单声明“附件未加载”，模型需要时通过 `feishu_attachment_fetch` 按消息 id 懒取；引用消息、话题内更早的消息/文件通过引用摘录与 `feishu_topic_messages` 获取。所有入站附件（图片与文件）统一存入 DSH 原生附件库：不可变、去重、读取校验、可随 Session 回放，插件不再承担入站附件清理，清理不会破坏历史。

核心体验：

- 大文件/慢网络不再阻塞话题队列；用户立刻看到卡片开始工作。
- 只说“看下这个文件”时，模型先取文件再回答，不会凭空猜测。
- 引用文件、引用合并转发、回到话题里 @ 之前的消息，都能按需读到。
- 纯附件消息保持安静（不回复、不建会话），但后续消息可以引用它。

## 范围与非目标

**范围**

- 入站决策：立即建会话 + 图片预取 + 文件懒取 + 纯附件静默登记 + 清单/引用摘录进 prompt。
- 存储：图片与文件统一走 `ctx.attachments`（DSH 原生附件库）；无该服务的部署保留 archive 降级。
- 工具：`feishu_attachment_fetch`、`feishu_topic_messages`；每 route 资源白名单与授权。
- 引用与历史：引用消息摘录、合并转发容器资源、首轮话题最近 N 条摘要。
- 配置面板、README/onboarding/设计文档、清理语义调整、回归与验收。

**非目标**

- 后台预取/预下载（用户已明确不做；大文件只按需取）。
- 独立附件 GC / 原生附件库清理（DSH 语义为永不自动删除；磁盘增长用户已接受）。
- 跨会话、跨用户、跨机器文件访问；音频/视频专门处理；消息全文搜索。
- 发布应用版本、创建远端 Issue/Milestone、合并或部署（需另行授权）。

## 技术栈与约束

- 运行环境：DSH 0.2.1-rc.2（web profile 默认组合含 `dsh-attachment-local`、`dsh-tools`、`dsh-llm`）；插件通过 `ctx` 窄接口访问宿主服务，不新增宿主内部运行时依赖。
- 飞书：官方 SDK `@larksuiteoapi/node-sdk`；bot 身份；消息读取与资源下载受应用 scope 限制（`im:message:readonly`、读群消息的敏感 scope 等），以 P0 真机结论为准。
- 附件语义：`ImageBlock` 原生进模型；`FileBlock` 以句柄文本 + 只读路径交给模型，修改前需复制到工作区；工具结果若不支持 `FileBlock` 则退化句柄文本。
- 仓库现状：现有附件实现见 [inbound-attachments.ts](../../../src/feishu/inbound-attachments.ts)，准入见 [inbound.ts](../../../src/routing/inbound.ts)，长期取舍见 [2026_10_20_attachment_pipeline.md](../../notes/2026_10_20_attachment_pipeline.md)。
- 执行方式（用户 2026-10-20 授权）：不创建平台 Issue/Milestone，不为单个任务拉分支或 worktree，全部改动直接提交在本地 `main` 分支；任务证据以 `.agents/issues/`、`runtime.json` 与 main 提交 SHA 为准，不使用 PR；远端推送、合并、发布仍未授权。
- 开发闸门：`pnpm typecheck`、`pnpm test`、`pnpm build`；新增能力必须覆盖失败与降级路径。

## 阶段成果

| 阶段 | 任务 | 可验证成果 |
| --- | --- | --- |
| P0 | `platform_spike` | tools/原生附件/只读路径/回放/飞书读取权限/合并转发的 Go-NoGo 结论与权限矩阵 |
| P1 | `native_attachment_store`、`pending_attachment_registry`、`attachment_fetch_tool`、`admission_manifest_flow` | 三类会话的立即建会话、图片预取、文件懒取、静默登记、清单 prompt 与 archive 降级全部可用 |
| P2 | `quote_history_tools` | 引用文本/文件/合并转发可读；话题历史工具可用；首轮自动带最近 N 条 |
| P3 | `panel_docs_release` | 配置面板、文档、清理语义、e2e 与验收材料齐备 |

依赖与写入范围以 `plan.json` 为准；阶段顺序不代表可以跳过依赖。

## 整体验收标准

| AC | 用户操作与期望结果 | 验证分类 |
| --- | --- | --- |
| AC-1 零等待 | 发“说明文字 + 大文件”后立刻看到卡片开始流式工作，不等下载完成 | 自动（断言 followup 先于下载完成）+ 用户手测 |
| AC-2 图片原生可见 | 发一张截图问“这是什么”，模型无需工具即可描述图片内容 | 自动（首轮消息含 ImageBlock）+ 用户手测 |
| AC-3 文件懒取 | 发文件说“看下这个文件”，模型调用工具取回后正确回答；未提及文件时不下载 | 自动（下载调用次数断言）+ 用户手测 |
| AC-4 纯附件静默 | 私聊只发文件 / 群未 @ 发文件：无回复、无下载、无表情；随后发文字可引用该文件 | 自动（无 Agent/无发送/登记存在）+ 用户手测 |
| AC-5 引用与历史 | 引用文件/合并转发能读到；在已有话题 @ 后可读 @ 之前的消息（权限允许范围） | 自动（摘录/工具）+ 用户手测真机 |
| AC-6 隔离与授权 | 群内他人文件、其他话题文件、未登记消息 id 一律不可获取 | 自动（负向测试） |
| AC-7 存储与回放 | 入站图片/文件只进 DSH 原生库；话题工作区不再产生入站附件；重启后从历史仍可读；清理不影响附件 | 自动（落点断言）+ 用户手测重启 |
| AC-8 降级与文档 | 缺原生附件/工具服务或飞书权限时优雅降级；面板可配；README/onboarding/设计文档与实现一致 | 自动（降级测试/设置测试）+ 用户评审 |

验收通过需对应 `plan.json` 当前 revision 与 main 上的交付提交 SHA（本 Roadmap 不使用 PR）；自动检查与用户实际操作分别记录在 `acceptance.md`。

## 当前假设与 P0 结论（2026-10-20）

P0 验证已完成（含干净构建重启后的历史回放），证据见 [platform_spike.md](../../issues/platform_spike.md)；结论 **Go**，不改变范围与 revision。

- A1 ✅ `ctx.tools` / `ctx.attachments` 在 channel 作用域可用：7 个会话挂载成功，模型实际调用工具。
- A2 ✅ 工具结果可下发 `ImageBlock`（模型直接描述测试图）；`FileBlock` 内容块可下发并保留文本路径兜底。
- A3 ✅ `fileHostPath` 只读路径可被 channel 会话的 `bash` 读取，内容校验一致。
- A4 ✅ bot 身份可 `message.get` / `message.list(chat|thread)`；合并转发资源必须用顶层容器 id 下载。
- A5 ✅ 未 @ 的群消息事件会投递到机器人（静默登记在群聊可覆盖）。
- A6 ✅ 重启回放：干净构建后冷恢复同一话题，模型从历史重新读取原附件路径并准确描述 P0-42；探针已不可调用（`unknown tool`）。

**未决问题**

- Q1 入群前历史与敏感权限范围：群/话题历史在现有权限下已可读；入群前历史待 P2 前补测，若不可读则按“机器人可见范围”提示。
- Q2 文本模型路由下图片预取：通道模型支持 image；其它模型仍需 P1 在预取前检查模态并降级为清单。
- Q3 工具成功下载后给源消息补 DONE 表情：默认不做。
- Q4 旧 `_staging` 一次性迁入停止窗口：P3 决定。

## 评审与执行授权

内容批准与执行授权记录在 `decisions.md`。revision 1（2026-10-20 本会话确认并要求落盘）获批；同日用户授权执行方式：**不创建平台 Issue/Milestone、不为单个任务拉分支或 worktree、全部改动直接提交在本地 `main` 分支**。该授权不包含远端推送、PR/MR、合并、发布或部署；平台对象保持为空。详细的流程偏离与交付证据约定见 `decisions.md` D9。

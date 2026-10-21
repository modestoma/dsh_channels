# attachment_pipeline_v2 决定与影响分析

本文件由协调者维护本次变化、影响与批准。Git 保留历史；采纳需求变化时更新 Roadmap revision 和实际受影响任务的 revision。值得长期复用的用户抉择保存到项目 `.agents/notes/`，本文件只引用完整论证。

## D1 采用附件管线 v2 总体方案

- 决定标识、时间与用户确认来源：D1，2026-10-20，本会话用户明确确认“采用‘立即建会话 + 清单/摘录进 prompt + 图片预取 + 文件懒取’的方案”。
- 用户原意，性质为疑问 / 提案 / 明确决定：明确决定。原意是让插件更好用，接受把“下载完毕后再开始会话”改为按需获取。
- 本次变化摘要；长期选择的 Note 链接：Roadmap 初始内容与全部任务；完整取舍见 [2026_10_20_attachment_pipeline.md](../../notes/2026_10_20_attachment_pipeline.md)。
- 受影响的目标与任务（含未开始、活动、已完成及传递下游）：全部任务（初始计划）。
- 暂停、继续、返工和验证安排：无在途执行；验证按 roadmap.md 整体 AC 与各 Issue AC。
- 对应 revision、批准范围与理由：revision 1；内容批准；理由见用户原话与 Note。

## D2 仅附件消息采用静默登记

- 决定标识、时间与用户确认来源：D2，2026-10-20，本会话用户明确“仅附件消息 采用静默登记方案”。
- 用户原意，性质为疑问 / 提案 / 明确决定：明确决定。
- 本次变化摘要：只登记元数据（message_id / 资源描述 / 会话与发送者），不下载、不回复、不建会话、不加表情；后续触发消息的清单可引用。
- 受影响的目标与任务：`pending_attachment_registry`、`admission_manifest_flow`、`attachment_fetch_tool`、`panel_docs_release`。
- 暂停、继续、返工和验证安排：无；验证见 AC-4。
- 对应 revision、批准范围与理由：revision 1；用户理由（沉默附件仍可被后续引用）。

## D3 引用机器人消息但未 @ 不触发

- 决定标识、时间与用户确认来源：D3，2026-10-20，本会话用户说明“点击回复默认 @ 被回复消息的发送方，手动删除 @ 即不需要机器人回复”。
- 用户原意，性质为疑问 / 提案 / 明确决定：明确决定（对话群主聊天区）。
- 本次变化摘要：不实现“引用机器人消息 = 隐式寻址”；已绑定话题 / 话题群内保持“无需 @ 续聊”的既有规则。
- 受影响的目标与任务：`admission_manifest_flow`、`quote_history_tools`。
- 暂停、继续、返工和验证安排：无；引用能力仅对已触发消息生效。
- 对应 revision、批准范围与理由：revision 1；用户使用习惯。

## D4 模型漏调工具：优化工具与 prompt，不预下载

- 决定标识、时间与用户确认来源：D4，2026-10-20，本会话用户“优化工具、优化 prompt、清单明确写未加载，不采用预下载的方式”。
- 用户原意，性质为疑问 / 提案 / 明确决定：明确决定。
- 本次变化摘要：文件一律懒取；不提供预下载兜底；用清单措辞、工具描述和测试用例收敛漏调风险。
- 受影响的目标与任务：`attachment_fetch_tool`、`admission_manifest_flow`、`panel_docs_release`。
- 暂停、继续、返工和验证安排：无。
- 对应 revision、批准范围与理由：revision 1。

## D5 大文件：懒取 + 上限 + 超时/取消

- 决定标识、时间与用户确认来源：D5，2026-10-20，本会话用户“按照你的建议来”。
- 用户原意，性质为疑问 / 提案 / 明确决定：明确决定。
- 本次变化摘要：工具内流式写入、单次资源数/字节上限、`timeoutMs`、`exec.signal` 取消；不做后台预取。
- 受影响的目标与任务：`attachment_fetch_tool`、`native_attachment_store`、`panel_docs_release`。
- 暂停、继续、返工和验证安排：无。
- 对应 revision、批准范围与理由：revision 1。

## D6 存储：图片与文件统一走 DSH 原生附件库

- 决定标识、时间与用户确认来源：D6，2026-10-20，本会话用户确认“文件和图片都走 DSH 原生附件库会比较好”“不再需要清理机制，清理后相当于 session 记录被破坏”。
- 用户原意，性质为疑问 / 提案 / 明确决定：明确决定（替代此前“文件落话题 attachments/”的临时方案）。
- 本次变化摘要：图片 `ImageBlock`、文件 `FileBlock`（退化句柄文本）均来自 `ctx.attachments`；插件不再写入话题 `attachments/` 作为主路径；不提供入站附件清理；工作区清理仅留给 Agent 产物与旧版目录；接受原生库磁盘无自动回收。
- 受影响的目标与任务：`native_attachment_store`、`attachment_fetch_tool`、`admission_manifest_flow`、`panel_docs_release`（清理语义与文档）。
- 暂停、继续、返工和验证安排：验证需覆盖只读副本复制到工作区的流程与重启回放。
- 对应 revision、批准范围与理由：revision 1；理由（不可变、校验读、去重、清理不破坏历史）。

## D7 借用 live agent 的工具补挂

- 决定标识、时间与用户确认来源：D7，2026-10-20，本会话用户“我理解不会存在这个需求”。
- 用户原意，性质为疑问 / 提案 / 明确决定：用户不认为需要该路径；非功能需求。
- 本次变化摘要：不把 borrow 场景列为验收目标；实现仍保留低成本 best-effort 工具补挂作为宿主重启/Web UI 竞态防护。若实现成本超出预期可移除并记录。
- 受影响的目标与任务：`attachment_fetch_tool`。
- 暂停、继续、返工和验证安排：无。
- 对应 revision、批准范围与理由：revision 1；工程防护，不扩大产品范围。

## D8 大纲落盘到本 Roadmap

- 决定标识、时间与用户确认来源：D8，2026-10-20，本会话用户“先将大纲落地到 .agents/roadmap 中吧”。
- 用户原意，性质为疑问 / 提案 / 明确决定：明确决定（记录与内容批准，不含执行授权）。
- 本次变化摘要：初始化 `.agents/roadmaps/attachment_pipeline_v2/`，创建共享 Issue 文件与 Note；`approved_revision=1`、`approval_ref` 指向本会话确认。
- 受影响的目标与任务：全部任务（初始 revision 1）。
- 暂停、继续、返工和验证安排：无执行启动；等待用户确认后进入 P0。
- 对应 revision、批准范围与理由：revision 1；批准范围为需求内容；理由：用户要求落盘并对齐后续开发。

## D9 执行方式：不建平台对象、不拉分支、直接在 main 开发

- 决定标识、时间与用户确认来源：D9，2026-10-20，本会话用户明确“不创建平台 issue/milestone、每个 issue 不单独拉分支，直接在 main 分支进行”。
- 用户原意，性质为疑问 / 提案 / 明确决定：明确决定（执行授权与流程偏离）。
- 本次变化摘要：偏离 roadmap-workflow 默认的“平台 Issue/Milestone + 每任务分支/worktree + PR”流程。任务仍以 `.agents/issues/*.md`、`plan.json`、`runtime.json` 为准；执行者直接在本地 `main` 提交，交付证据为 main 提交 SHA + Issue 文档证据；不创建 PR；`issue_url`/`issue_number`/`pr_url` 保持 null；任务完成状态与证据仍按各 Issue 的 AC 记录。
- 受影响的目标与任务：全部任务（执行方式与交付证据约定）；不改变任何任务的需求、AC 或 revision。
- 暂停、继续、返工和验证安排：无在途执行；仍按 `plan.json` 依赖顺序串行（`max_parallel=1`），每任务完成后保存 `runtime.json` 快照并在 Issue 文档追加证据。
- 对应 revision、批准范围与理由：revision 1；批准范围为本地 main 上的执行与本地提交；理由：用户希望简化流程，不需要平台协作与分支隔离。

## D10 P0 验证结论与执行记录

- 决定标识、时间与用户确认来源：D10，2026-10-20，P0 真机验证完成后由协调者记录；用户在会话中确认“都跑完了”，并提供了 1GB 飞书文件。
- 用户原意，性质为疑问 / 提案 / 明确决定：事实记录与执行调整（非需求变化）。
- 本次变化摘要：P0 全部 Go —— 工具注册（7 个会话）、图片 ImageBlock（模型直接描述测试图）、FileBlock/只读路径/大文件流式/取消、飞书 `message.get`/`list(chat|thread)`/合并转发容器规则、未 @ 群消息事件投递、干净构建重启后的历史回放均通过；通道模型 `deepseek-flash` 声明并实测支持图片输入。被 `/stop` 取消的回合会在历史里留下失败工具结果（探针显示 `[object Object]`），P1 工具需可读化错误。探针自身缺陷（输出 JSON 清洗、AbortError 文案、inject ctx 捕获）仅影响探针，已移除探针；保留 channel `messageGet`/`messageList` 包装与 channel tool 运行时类型作为 P1 交付物。
- 受影响的目标与任务：`platform_spike` 完成（含干净构建重启后的历史回放：模型从冷恢复会话重新读取原附件路径并准确描述 P0-42，`p0_probe` 已 `unknown tool`）；P1 可直接开始，无范围或 revision 变化。
- 暂停、继续、返工和验证安排：无暂停；重启回放纳入 P0 收官；入群前历史与 p2p `message.list` 纳入 P2 补测。
- 平台对象缺失时的运行记录约定：roadmap-workflow schema 要求 running/merged 任务有已发布 issue_url/PR；本项目按 D9 不创建平台对象，因此 `runtime.json` 无法表达 running/merged。执行状态以任务 `resume` 记录，交付证据以 main 提交 SHA + Issue 证据 + 本条决定为准；`validate` 保持通过，不伪造平台字段。
- 对应 revision、批准范围与理由：revision 1；无需求变化，不提升任何任务 revision。

## D11 P2 真机补测结论与执行记录

- 决定标识、时间与用户确认来源：D11，2026-10-21，quote_history_tools 执行会话由协调者记录；执行方式沿用 D9/D10 的用户授权（本地 `main`、无平台对象、不推送/合并/发布）。
- 用户原意，性质为疑问 / 提案 / 明确决定：事实记录与执行取舍（非需求变化）；无新增用户确认事项。
- 本次变化摘要：
  - **P0 遗留补测（同一应用 bot 身份、只读 REST 探针）**：p2p `message.list(chat)` 可用（code=0、分页正常）；群历史可读且返回早于机器人首条消息约 1 个月的消息（入群前历史在机器人可见范围内可读，不绝对保证；入群时间无法直接查询）；`message.list(thread)` 群/私聊均可用；引用消息 `parent_id→message.get` 可定位；`merge_forward` 的 `message.get` 返回容器+子消息扁平 items（容器在前、子项带 `upper_message_id`）；`mget` 端点必须**重复** `message_ids` query（逗号拼接 400/99992354），上限 50（51 个 400/99992402），SDK 1.76 无 typed `mget`，通道层用 `Client.request` 包装。
  - **实现取舍**：引用/历史附件通过 `<feishu_context>` 的 quote 行与摘录行上的 `message_id` 同时“可发现+可取”；被动读使用独立 `promptContextTimeoutMs`（默认 3s）并与图片预取并发，不复用工具超时；degraded chat route 拒绝 topic 消息的引用/读取（安全加固）；每 route 白名单容量 128，topic 列表只登记带资源/合并转发行以免 LRU 挤出；archive 后端被动块不提示 fetch 工具。
  - **验证**：自动测试 typecheck/test（31 files / 860 tests）/build 全绿；真机 API 探针已记录在 Issue 证据；插件链路真机验收列为**待用户手测**（已给操作步骤，未用 mock 冒充）。两位独立只读评审两轮后均放行（无 P0/P1）。
  - **真机冒烟（2026-10-21，用户手动操作 + lead 判读）**：通过临时注释触发 desktop profile HMR 重载新 bundle（验证后 profile 按备份逐字节恢复）。7 步实测通过：新工具注册（tools 21 个）；引用文字（`<feishu_quote>`+message_id，模型复述原文）；纯附件静默 + 静默登记懒取（49B 文件 sha256 校验）；引用文件（quote 块+manifest 行，fetch 取回）；引用合并转发（子消息展开、容器 id 取子文件、未用子 id）；话题群首轮历史（A/B/C 含 @ 之前消息）；工具分页 cursor 与续聊不重复注入历史。**真机发现 1 个 P1 缺陷并修复（提交 `7964c643960c570090620b6034ac6f4d5119d03d`）**：工具列表渲染文本未输出 cursor token，模型以消息 id 当 cursor → 多次 invalid page_token 后绕路（翻 lib、直连 OpenAPI、一次 300s grep 超时），表现为回复极慢；修复为渲染 `- 下一页 cursor: <token>` 并补单测，热重载后复测一次通过。**安全观察**：绕路中模型读取 `~/.dsh/.credentials.yaml` 并把 App Secret 写入本地会话日志（未进飞书聊天）；已加 guidance 禁止读取/打印凭据与直连 OpenAPI，并建议用户轮换 secret、宿主层限制 channel 会话读取 `$DSH_HOME`（host 侧风险，非插件功能缺陷）。用户决定跳过 `historyBootstrapLimit: 0`、权限缺失降级、非本 route 负向的真机复测（自动测试覆盖）。
- 受影响的目标与任务：`quote_history_tools`（完成；revision 1 不变）、`panel_docs_release`（新配置键、README/面板与文档交接）。
- 暂停、继续、返工和验证安排：无暂停；两处产品待确认项记录在 Issue“未验证项/已知限制”：① `/renew` 后新 Session 首轮是否注入话题历史；② degraded group chat route 的“容器=整群主时间线”是否需按 sender 进一步收紧。
- 对应 revision、批准范围与理由：revision 1 不变；无需求范围变化。入群前历史在可见范围内可读，未缩小能力，故无需用户重新确认提示文案；缺权限仍静默降级并输出一次性 warn，onboarding 已说明。
- 影响分析：无下游 revision 提升。`runtime.json` 中本任务按 D10 以 planned+resume 记录完成状态，`roadmap validate` 保持通过；平台对象仍为空。

## 批准与执行授权

- 内容批准：revision 1（2026-10-20，本会话用户逐项确认并要求落盘）；`plan.json` 的 `approved_revision=1`，`approval_ref` 引用本会话与 Note。
- 执行授权（2026-10-20，D9）：允许在本地 `main` 分支直接实施并提交；**不创建**平台 Issue/Milestone，**不创建**每任务分支/worktree，**不使用** PR。该授权**不包含**远端推送、PR/MR、合并、发布或部署；需要时另行确认。
- 交付证据约定：任务完成以 main 上的提交 SHA + Issue 文档证据 + `runtime.json` 快照记录；`issue_url`/`issue_number`/`pr_url` 保持 null；整体验收按 `acceptance.md` 的 AC 与用户确认，不以平台状态推断。
- 平台同步：无。`runtime.json` 中 milestone 为 null，`projection_pending=false`，不创建平台对象。

## 影响分析

- 全局 revision 1 为初始版本，全部任务 revision 1，无下游传递复核。
- P0 已完成真机验证（无平台对象）；P1 可在 main 直接开始，依赖 `platform_spike` 已满足。
- 后续任何实质范围变化（例如入群前历史不可读导致历史能力缩减）需提升受影响任务 revision，并在此追加决定。

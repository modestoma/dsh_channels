# dsh-channels

DeepSeek Harness（DSH）飞书渠道插件：**一个 dsh 实例对应一个飞书机器人**，用户只需与飞书机器人对话即可使用 dsh。

- 对话入口：私聊、群聊 @ 机器人、话题群 @ 机器人
- 收到触发消息：立刻加 **“Typing”** 表情 → 以话题形式回复（**创建话题**）→ 绑定 DSH session → 卡片 2.0 **流式回复** → 成功时更新为 **“DONE”**，失败时更新为 **“No”**
- 话题内后续消息**无需再 @**，自动延续该 session
- 工作区归属：**每用户一个工作区**（私聊 = 用户；群聊 = 群 × 用户，同群不同用户互不影响）；每个话题在工作区内拥有独立工作目录（默认 `topics/<话题 id>/`，Git 仓库工作区可自动改用 worktree），因此话题之间的文件互不干扰，而工作区数量只随用户增长
- **入站附件（v2，零等待）**：收到消息时**会话、话题、流式卡片立即建立，不等附件下载**。触发消息中的图片自动预取为首轮原生 `ImageBlock`，模型直接可见；文件默认不下载，prompt 用 `<feishu_context>` 清单声明“附件未加载”，模型需要时调用 `feishu_attachment_fetch` 按 `message_id` 懒取；引用消息与话题历史以 `<feishu_quote>` / `<feishu_history>` 摘录，更早的消息用 `feishu_topic_messages` 翻页（发现的资源同时获得 fetch 授权）。**只发附件、不带说明的消息完全静默**：不回复、不建会话、不下载、不加表情，本地也不留任何状态；要让模型看到它，请引用那条消息再提问（多个文件可合并转发后引用），话题内的附件也可由模型用 `feishu_topic_messages` 读到。所有入站图片/文件统一存入 **DSH 原生附件库**（不可变、内容寻址去重、读取校验、随 Session 回放；插件不承担入站附件清理）。显式 `attachmentStore: 'archive'`、宿主未挂载原生附件服务或关闭 fetch 工具时退回旧版工作区 `attachments/` 落盘。完整设计见 [docs/attachment-pipeline-v2.md](docs/attachment-pipeline-v2.md)。
- **把生成的文件发给用户**：模型在话题工作目录里生成图片、报告、表格等文件后，可调用 `feishu_send_file` 直接发回当前话题/会话（可识别图片 ≤10 MB 以图片消息发送，其余以文件消息发送，文件上限 30 MB）。只能发送**当前话题工作目录内**的普通文件（`..` 与符号链接都按真实路径校验，不能读到其他话题或系统文件）；需开通 `im:resource` 权限，缺失时工具返回可读的 `PERMISSION_DENIED`，回合不受影响。开关：`feishuTools.sendFile`（默认开）
- **知识库读写**：开启 `feishuTools.wikiRead` / `feishuTools.wikiWrite`（默认都关）并在 `wikiRoots` 里配置知识空间链接 `https://<租户>.feishu.cn/wiki/space/<space_id>` 或节点链接 `https://<租户>.feishu.cn/wiki/<node_token>` 后，模型可用 `feishu_wiki_list` 浏览、`feishu_wiki_read` 读取飞书文档（Markdown，或带 block id 的飞书文档 XML，支持目录/章节/区间/关键词局部读取）、`feishu_wiki_create` 在范围内新建飞书文档、电子表格或多维表格（新节点也可作为子目录继续往下建）、`feishu_wiki_edit` 修改**本应用创建的**文档（追加、在块后插入、替换/删除块、文本替换、整篇重写；必须带上读取时的 `revision_id`，文档被他人改过会被拒绝）。电子表格用 `feishu_wiki_sheet_read` 按子表和 A1 范围读成 CSV（每行带 `[row=N]` 真实行号），`feishu_wiki_sheet_edit` 向**本应用创建的**表格写入单元格值或公式、在数据末尾追加行（追加位置会越过空行找到真正的最后一行，目标单元格非空时失败、不会覆盖；同样校验 `revision_id`；不改样式、图表和行列结构）。多维表格用 `feishu_wiki_base_read` 列数据表、读字段和记录（支持筛选、排序、关键词搜索、分页），`feishu_wiki_base_edit` 增改删记录：**本应用创建的**多维表格可增改删，其他多维表格**只能新增记录**（不改表和字段结构）。所有调用都用应用身份，并且：只有**管理员或知识库白名单**（`/auth wiki add @用户`）里的人发起的话题能用；`wikiRoots` 之外一律拒绝；打开某个文档或表格、每次新建、每次修改都会在话题里弹出**授权卡**，只有话题发起人能点（读取授权在本话题内对该文档持续有效，`/renew` 或重启后重新询问），超时（`approvalTimeoutMs`）自动拒绝；浏览目录不弹卡。需开通 `wiki:wiki`、`docx:document`、`sheets:spreadsheet`、`bitable:app`（只读可用 `wiki:wiki:readonly` / `docx:document:readonly` / `sheets:spreadsheet:readonly` / `bitable:app:readonly`），且应用要是目标知识空间的成员（可把包含机器人的群加为空间成员/管理员）
- **HITL 审批**：当模型请求需要授权的动作（如 bash 沙箱升级 `sandbox_permissions`）时，插件监听主机 `approval/request` 事件，在同一话题里**新发一张独立审批决策卡**：卡上直接显示将执行的命令（或工具参数）和提权目标，提供 ✅ 允许 / ❌ 拒绝 / ♾️ 本话题不再询问 三个按钮；也可以在话题里直接回复「允许」「拒绝」「全部允许」，回复其他内容视为拒绝并作为下一条指令。等待期间流式主卡显示「⏳ 等待你审批」。超时（`approvalTimeoutMs`，默认 5 分钟）自动拒绝（fail-closed），非会话发起人点击或回复无效
- **结构化提问**：模型调用 `ask_user_question` 时，插件监听主机 `user-questions/request` 瀑布并发一张问答卡（每个问题一组选项按钮，多选先勾选再「提交本题选择」），答案回填给模型；主机自带的应答者只有 Web 客户端，没有本插件时纯飞书会话会以 `NO_PROVIDER` 失败。超时（`questionTimeoutMs`，默认 5 分钟）或回合取消时本轮提问失败（fail-closed）；没有可选项的问题直接提示用文字作答，**阻塞期间普通文本回复即作为该问题的自由文本答案**（同时支持多选后的自定义文本）
- **准入与授权（默认开启）**：**管理员不受白名单限制**（私聊、任意群聊——包括尚未授权的群——都能直接发起会话）；其他人私聊只收到一条固定提示（`/userid` 例外），群聊需要「群已授权 + 用户在全局白名单」两层同时命中。机器人被拉进群后私聊管理员发**群信息卡**（未授权群附授权按钮，用于放行白名单用户）；已授权群里未授权用户 @ 会触发用户授权卡。授权入口：飞书 `/auth` 命令、授权卡、Web 设置面板；管理员 user_id 在面板配置（私聊 `/userid` 获取），**留空时自动使用飞书应用所有者**
- 全部基于飞书官方 SDK [`@larksuiteoapi/node-sdk`](https://www.npmjs.com/package/@larksuiteoapi/node-sdk)（WebSocket 长连接，免公网）
- **Web 设置面板**：Web/桌面端 **设置 → 飞书渠道**，顶部状态头 + 6 个标签页（连接 / 会话与行为 / 模型 / 工作区 / 访问授权 / 高级）；凭据不完整时插件不连接、面板显示三步引导，填写保存后自动连接（保存写入本机覆盖文件，部分字段需重连生效）；详见下文「Web 设置面板」章节

设计与可行性论证见 [docs/feasibility-and-design.md](docs/feasibility-and-design.md)；工作区粒度与会话隔离的取舍见 [docs/workspace-isolation-design.md](docs/workspace-isolation-design.md)；入站附件管线（存储 / 清单 / 工具 / 引用与历史 / 降级 / 隐私边界）见 [docs/attachment-pipeline-v2.md](docs/attachment-pipeline-v2.md)。

## 斜杠命令

- `/help`：列出当前支持的斜杠命令，无需绑定 Session；私聊和普通群聊中直接回复、不创建话题，话题群或已有话题内则回复在该话题中
- `/userid`：仅在私聊中直接回复**发送者自己的** user_id，无需绑定 Session，也不创建话题；**任何私聊用户都可以用**（准入配置/授权引导用，不消耗 token）
- `/groupid`：仅在群聊中直接回复当前群组 ID，无需绑定 Session，也不创建话题；普通群聊遵循 `requireMention`，话题内无需重复 @
- `/health`：显示 Harness 与飞书通道健康状态，无需绑定 Session；回复方式同 `/help`（直接回复，话题内回在话题中）
- `/status`：显示当前 Session 状态与性能指标
- `/workspace`：显示当前 Session 工作目录
- `/effort`：查看当前 Session 推理强度；当前模型声明了可选档位时，回复卡附档位按钮，点一下即切换；`/effort <档位-id>` 切换，`/effort reset` 恢复配置默认
- `/model`：查看当前模型与该 provider 的可用模型，回复卡附模型按钮，点一下即切换；`/model <模型-id>`（沿用当前 provider）、`/model <provider>/<model>` 切换，`/model reset` 恢复部署默认
- `/compact`：调用 Harness 原生命令压缩当前 Session 上下文
- `/renew`：在当前话题创建并绑定新 Session
- `/stop`：中断当前正在运行的回合（不冷恢复 Session；排队中的后续消息保留并接着运行；没有运行中的回合时明确提示）。流式卡片上的「⏹ 停止」按钮效果相同
- `/permissions`：查看当前 Session 的权限预设（沙箱 + 审批策略）与可选清单；仅在 `allowPermissionSwitch: true` 时支持 `/permissions <name>` 切换，此时回复卡附预设按钮
- `/auth`：**仅管理员**。`/auth status` 查看准入状态；`/auth allow` / `/auth revoke` 在群内授权/撤销当前群；`/auth user add @用户` / `/auth user remove @用户`（也可直接写 `user_id`）管理全局用户白名单，@ 时自动取被 @ 成员的 user_id、忽略对机器人的 @；`/auth wiki add @用户` / `/auth wiki remove @用户` 管理知识库白名单（与对话白名单相互独立，管理员始终可用）；`/auth list` 列出白名单与待处理申请。即使群尚未授权，管理员也能在群内用 `/auth`（这是“通过对话授权群”的入口）
- `/history`：显示当前话题的 Session 历史（含 `ctx.sessionQuery` 折叠出的会话标题与 live 标记）
- `/export`：导出当前 Session 的逻辑日志

选择卡的选项单列排列；按钮等同于在该卡下输入对应命令（如点「deepseek-v4-pro」= `/model deepseek-v4-pro`），走同样的准入、归属与校验，执行结果原地替换该选择卡（更新失败时才另发一张结果卡）；只有话题发起人点击、且卡片仍在原聊天里时才生效，话题换绑 Session 后旧卡上的按钮失效。按钮最多显示 12 个，其余可直接输入命令。

`/new` 是 `/renew` 的别名。`/help` 由命令注册表按分组生成，新增命令只需在注册表里加一行。

**飞书原生斜杠指令面板**（可选，`slashCommandPanel: true` 开启，默认关闭；部分企业不允许应用添加斜杠指令）：开启后每次连上飞书，插件在后台调用 `application/v7/app_slash_commands` 把命令注册表同步到飞书原生面板，用户在聊天框输入 `/` 即可直接选择命令（飞书客户端有约 5 分钟缓存）。同步是全量对齐且幂等：缺的创建、描述变了的原地更新、注册表里已没有的或重复的删除（别名不单独列出），注册表不变时再次连接不产生任何写操作；超时（30 秒）或断开后不再发起新的写操作。需要可选权限 `application:app_slash_command:read`（读取现有命令）与 `application:app_slash_command:write`（增删改），两项只在开启时列入权限自检。关闭时插件不读写面板。同步失败只影响面板列表，直接输入命令照常可用；失败原因显示在 Web 设置「连接」页并打印一条 warn。

## 流式卡片

卡片 2.0，按**过程 → 正文 → 停止按钮 → 页脚**组织，默认 500ms 刷新（`refreshMs` 可调）：

1. **过程**（推理折叠面板 + 活动状态两行）：
   - **推理折叠面板**（`collapsible_panel`）：带边框、默认折叠，右侧箭头随折叠状态翻转（折叠向下、展开向上，`icon_expanded_angle: 180`）。有推理内容时，面板标题沿成功链路 **推理中 → 回复中 → 回复结束** 切换，失败终态为 **回复失败**，被停止的终态为 **已停止**；**推理中阶段始终渲染**（兼作阶段指示灯与占位），**回复中 / 回复结束 / 回复失败阶段仅当存在推理内容时渲染**——无推理的完成/失败回合不会留下空面板
   - **活动状态两行**（小字，**只在当前正在流式输出的那张卡上渲染**，已冻结的续卡/主卡不再重复；**互相独立、互不顶替**），让卡片在“模型不吐字”的阶段（工具执行、subagent、workflow）**不再静默**——按 `statusRefreshMs`（默认 5s）慢节奏刷新计时：
     - **状态行**（委托进度）：`tool-workflow/run-start / agent-start / agent-end / run-end`（工作流进度：完成数/总数、阶段、活动成员）→ run 结束转为 `🧵 工作流 xxx 结束（完成）` 并**保留到最终卡片**（后续工具调用、正文输出都不会顶掉它）；**子代理进度**（跨会话映射）：子代理是独立 session（`header.parentSession` 指向主会话），其 `subagent/descriptor`（label）、`tool/call`（当前工具）被折叠为 `🤖 子代理执行中：检索实现方案 (read) · 已运行 45s`，并行子代理显示计数，完成后在最终卡片汇总为 `🤖 子代理完成：a、b`。**只显示状态，不显示输出**——子代理正文是父模型的中间产物，绝不进卡片正文
     - **工具行**（父会话当前工具调用）：`tool/call` → `🔧 调用工具：bash · 已运行 Ns`（subagent 工具显示其 description、workflow 工具显示 meta.name），`tool/result` 返回即清除，**回合结束后收起**（完成态只保留结算状态行：工作流结论 / 子代理完成摘要）
     - 两者可同屏：如 `🧵 工作流 xxx 结束（完成）` + `🔧 调用工具：bash`
2. **正文**：富文本 markdown；超长正文**自动分段投放**——单卡片预算用满后按干净断点（段落 / 标题 / 代码块边界）切分，且**每张卡最多 5 个表格**（飞书硬限制，错误 11310）；断点会避开代码围栏与表格，**单个表格/代码块小于单卡预算时不会被从中间切断**（单块本身超过单卡预算时只能硬切，内容仍不丢失）。续片以「📄 回复分段 n」卡片跟进同一话题，**全文无丢失**；续卡被飞书拒收时自动降级为纯文本消息（内容仍送达）。**续卡只留正文**：`📄 回复分段 n` → 可选活动行（仅当它是当前活动卡）→ 正文，无面板、无页脚、无分割线
3. **停止按钮**：回合进行中，当前正在流式输出的那张卡（主卡或最新续卡）正文下方显示「⏹ 停止」，效果同 `/stop`。首帧不带按钮；排在后面的消息的卡片在轮到它运行时才出现按钮。只有话题发起人在原聊天里点击才生效，点击后按钮变为不可点的「正在停止…」；其他人点击只会在按钮下加一行「仅发起该会话的用户可停止」。回合结束后按钮移除；经 `/stop` 或按钮停止的回合面板标题为 **已停止**，主卡页脚上方显示「⏹ 已按请求停止本轮回复」。
4. **结算页脚**（分割线 + 两行小字）：**只在主卡、且只在回合结束（`done` / `stopped` / `error`）后渲染一次**——首帧、流式中、续卡都没有，因此不会出现 0/— 的空统计。
   - 第一行：`🧠 模型 {model}({effort}) · 🔑 会话 {sessionId} · ⏱ 推理 {推理时长}`。推理时长为**本轮所有推理阶段的累计墙钟时间**（每个 step 从首个推理增量开始，到该 step 输出结束——首个正文增量或 step 结束——为止；工具执行时间不计入；回合在推理中结束时计到 turn 结束），无推理时为 `—`
   - 第二行：`📊 上下文 {tokens}/{window} ({占比}) · 📩 输入 {n} · 📨 输出 {n} · ⚡ 缓存命中 {pct}`。占比 = 上下文 tokens / 窗口（<10% 保留一位小数，≥10% 取整）；没有窗口时只显示 tokens
   - 输入/输出为 session 累计口径；模型、推理强度、缓存命中按**当前轮次**，本轮在请求头产生前失败时模型/缓存命中显示 `—`、推理强度省略，不会沿用上一轮

## Web 设置面板（设置 → 飞书渠道）

包内含可选的浏览器半区（`lib/client.js`，DSH client module）：在 Web/桌面端 **设置** 导航注册「飞书渠道」分区。宿主没有 `webServer` 服务（headless profile）时不加载面板，飞书通道本身不受影响。

**连接时机**：启用插件时**不会无条件连接飞书**。插件启动先读取 profile 配置与 Web 覆盖，再检查 `appId` / `appSecret` 两个凭据引用能否解析出值：

- **凭据完整** → 建立飞书长连接（重启 DSH、重新加载插件时同样先检查再连接）。
- **凭据不完整** → 插件正常加载、**不建连接**、不报错，面板显示「待配置」与三步引导；在「连接」标签页填好两项凭据并保存后自动连接。
- **连接失败**（凭据错误、网络等）→ 记录在面板状态卡，插件保持加载；修好凭据或网络后点「重试」。

**面板结构**：顶部固定连接状态头（阶段徽标：待配置 / 未连接 / 连接中 / 已连接 / 连接失败、一句话摘要、刷新按钮），下方按标签页分区：

| 标签页 | 内容 |
| --- | --- |
| 连接 | 连接状态与连接信息（长连接状态、Bot open_id、运行时长、话题路由 / 活动会话 / 在途回复）、权限自检、斜杠指令面板同步结果、未配置时的三步引导、飞书应用凭据、最近一次连接失败原因、需重连的待生效提醒 |
| 会话与行为 | 「行为」：私聊模式、普通群 @ 要求、话题兜底、首次私聊引导、原生斜杠指令面板同步、权限切换；「内容与附件」：附件接收、存储后端、图片预取与上限、首轮历史；「模型工具」：`feishu_attachment_fetch` / `feishu_topic_messages` / `feishu_send_file` / 知识库工具开关与上限、`wikiRoots`、被动读取预算 |
| 模型 | 模型服务商、模型 id、推理档位、Agent 预设（宿主目录驱动的级联下拉） |
| 工作区 | 工作区根目录（可点「选择目录…」调用系统目录选择框）；话题目录隔离方式（`topicIsolation`）在 profile 配置中设置 |
| 访问授权 | 管理员 user_id、准入模式、申请有效期；已授权群 / 用户白名单与待处理申请 |
| 高级 | 流式刷新 / 状态行 / SDK 日志级别、部署级只读参数、Web 覆盖文件路径与「清除 Web 覆盖」 |

**入站附件与模型工具（v2）**：「会话与行为」标签页新增两组可编辑字段，与 profile 配置同名、写入同一 Web 覆盖文件（`$DSH_HOME/dsh-channels/settings.json`）：

- **内容与附件**：附件接收（`acceptAttachments`）、入站附件存储后端（`attachmentStore`：DSH 原生附件库 / 工作区 `attachments/`）、触发消息图片预取（`prefetchImages`）及单图 / 总量 / 整段超时上限（`prefetchImageMaxBytes` / `prefetchTotalMaxBytes` / `prefetchTimeoutMs`）、首轮话题历史条数（`historyBootstrapLimit`）。
- **模型工具**：`feishu_attachment_fetch` 开关与单次资源数 / 字节预算 / 超时（`feishuTools.attachmentFetch*`）、`feishu_topic_messages` 开关与超时（`feishuTools.topicMessages*`）、`feishu_send_file` 开关（`feishuTools.sendFile`）、知识库读/写开关（`feishuTools.wikiRead` / `feishuTools.wikiWrite`）与知识库范围 `wikiRoots`（每条链接一个输入框，逐条校验）、被动引用/历史读取预算（`promptContextTimeoutMs`）。

`feishuTools.*` 是嵌套配置：面板只把改动过的子键写进覆盖层，其余子键保持原值（Web 覆盖或 profile 配置），不会因部分保存变成未定义。字段默认值、边界与降级规则见下文配置示例和 [docs/attachment-pipeline-v2.md](docs/attachment-pipeline-v2.md)。

**连接状态**：阶段徽标（待配置 / 未连接 / 连接中 / 已连接 / 连接失败）、飞书长连接状态、Bot open_id 尾号、运行时长、话题路由数 / 活动会话 / 在途回复、最近一次连接失败原因；每 5 秒自动刷新，也可手动刷新或**重启飞书连接**（会断开当前长连接并中断进行中的回复）。徽标不是健康时会额外显示「健康判定」原因——健康等级由宿主**所有 Cordis fiber** 折叠而来，因此「降级」也可能来自其它插件入口仍在等待依赖/加载（与飞书通道无关），原因行会列出对应插件名；「连接失败」只针对飞书连接本身，插件入口保持加载。

**飞书应用凭据**：在「连接 → 飞书应用凭据」卡片里填写 **App ID / App Secret** 并保存，值经宿主 `ctx.credentials` 写入 DSH 凭据库（默认 `$DSH_HOME/.credentials.yaml` 的 `refs:` 段，仍遵循凭据层的解析优先级），面板只显示「已配置 / 未配置」与来源，**永不回显已存值**。两项齐全且通道未运行时保存后自动建立连接；已连接时保存只提示重连；只填了一项时保存成功但**不会连接**（状态保持「待配置」），补齐另一项后自动连接。已存值可以单独「移除已存值」；卡片下方显示的是凭据**引用名**（profile 配置里的 `appId` / `appSecret`），换引用名仍需改 profile 配置。「会话与行为」页底部的「日志分析接口令牌」卡片用同样方式写入令牌，保存或移除后下一次接口请求即生效，不会重连飞书。

**统一保存**：除连接类操作外，可编辑字段共用一个草稿；每个表单标签页底部是「保存更改 / 放弃更改」，只提交改动过的字段，标注「需重连」的项在下次连接时生效；保存后「连接」标签页顶部横幅列出待生效项并提供一键重连。

**模型选择器**：模型与推理在面板里是**独立的「模型」标签页**：宿主 LLM 服务可用时，`provider` / `model` / `reasoningEffort` 与 `agentPreset` 渲染为**下拉选择**而不是手填：provider 来自 `ctx.llm.listProviders()`，model 来自所选 provider 的 `listModels()`，推理档位来自 `resolveModelInfo(provider, model).reasoning.efforts`，Agent 预设来自 `agentPresets.list()`。每个选择器的首项是「留空 = 部署默认 / 适配器默认 / roster 默认」，有部署默认模型（`agentDefaultModel`）或 roster 默认预设时会在标签里带上具体值。选择按依赖级联：先选 provider 才会加载 model，选了 model 才会加载推理档位；宿主暂时无法枚举的项（服务未挂载、适配器查询失败/超时）自动退回原来的自由文本框，已保存但当前列表里没有的值会作为「当前配置，不在宿主机列表中」选项保留，不会在打开面板时被静默改掉。级联查询走只读的 `GET /dsh-channels/catalog?provider=…&model=…`（Host 侧短 TTL 缓存，单次查询 4 秒上限）。`provider` 与 `model` 在宿主侧是一条完整的请求路由，因此面板保存时要求**两者同时设置或同时留空**，不允许只选一半。

`baseDir` 是**模型/工具产生文件的落点**（入站附件默认进 DSH 原生附件库、不落这里；仅 archive 后端才写话题目录）：**每个用户拥有一个独立工作区**（私聊 `<baseDir>/p2p/<user_id>/`，群聊 `<baseDir>/groups/<chat_id>/<user_id>/`，同一群里不同用户互不影响；旧版本的「用户 × 聊天」共享工作区正好复用为这个新工作区）。每个话题在工作区内拥有独立工作目录 `<工作区>/topics/<话题 id>/`（无话题的降级会话用 session id），所以话题之间的文件互不干扰，而工作区数量只随用户增长。面板里只接受**绝对路径**（`~` 开头按家目录展开，拒绝文件系统根目录），保存时会创建并校验该目录，不可用时当场报错，不会等到飞书里提示「会话创建失败」。已有 Session / 目录不会被迁移，因此切到新目录后旧话题继续用旧目录（话题内 `/renew` 也一样），只有之后新开的会话使用新目录。

**可视化选择工作区根目录**：输入框旁的「选择目录…」按钮会调用**宿主机的系统目录选择框**（macOS 的 NSOpenPanel / Windows 的文件夹对话框），选中后把绝对路径填进草稿，仍需点「保存更改」才落盘。该能力转发自宿主可选的 `ctx.directoryPicker` 服务：桌面端/本机 GUI 会话（native 后端）提供按钮；headless、远程或 SSH 会话没有可服务的显示会话（browse 后端），面板不显示按钮、保留手写输入，插件在缺少该服务的旧宿主上照常加载。选择框打开期间请求保持挂起；取消是正常结果，不会报错。

**访问授权**：「访问授权」标签页集中管理准入：管理员 user_id（私聊 `/userid` 获取）、准入模式、授权申请有效期；「已授权群」「已授权用户」列表支持增删（群 ID 可从入群群信息卡或 `/groupid` 获得，用户 user_id 可用 `/userid` 查看）；「待处理申请」可一键授权/忽略。白名单只约束非管理员：管理员在任何私聊/群聊都直接放行。管理员留空时自动使用飞书应用所有者（连接时通过「获取应用信息」接口查询），标签页会显示“已自动使用应用所有者”；`guarded` 且既未配置管理员、也查不到应用所有者时，标签页顶部会红字提示“当前会拒绝所有对话”并附上查询失败原因。授权白名单与申请记录保存在插件 `storageDomain`（`channels_routes_v2` 域），重启后保留；未建立飞书连接时白名单尚未加载，标签页会提示「连接建立后加载授权列表」并禁用写操作。

**配置层级**：`configSchema` 默认值 < profile `cordis.patch.yml` 的 `config` < Web 面板覆盖。面板只把可编辑字段写入 `$DSH_HOME/dsh-channels/settings.json`；「高级 → 清除 Web 覆盖」删除该文件并回落到 profile 配置。`baseDir` 可在「工作区」标签页编辑（绝对路径；只影响之后新建的会话）；超时、路由 TTL 等仍只读展示。凭据**值**在「连接 → 飞书应用凭据」编辑，凭据**引用名**（`appId` / `appSecret` 配置项）仍由 profile 配置决定。已移除的目录清理配置 `workspaceRetention` / `workspaceRetentionAuto` 与覆盖文件路径配置 `settingsFile` 若仍留在 profile 或覆盖文件中会被静默忽略，面板下次保存时从覆盖文件中去掉。

**为什么落在插件自己的文件而不是 profile 的 `cordis.patch.yml`？** DSH 提供官方 `ctx.configEditor.edit()`，可以安全写 profile patch（完整 Config 校验、保留注释与 `!!js`、原子替换、失败回滚、与 HMR 串行）；但它是「完整配置编辑」通道——本插件的 Config 是 zod，没有 schemastery `.volatile()` 标记，普通字段写入会触发 Loader 重载插件，等于每次保存都断开并重连飞书；而且该服务只在有 `profileContext` 的启动器（桌面端 / `dsh web`）存在。`$DSH_HOME/<plugin>/` 是 DSH 插件保存运行时数据的惯例（如 dsh-pet 的 `$DSH_HOME/dsh-pet/`），因此面板偏好写入 `$DSH_HOME/dsh-channels/settings.json`：保存即生效（需重连字段除外）、可一键清除回退、不依赖 `profileContext`；profile 的 `cordis.patch.yml` 继续作为部署级基础配置层。若将来要求「所有配置统一进 profile」，迁移路径是改用 `ctx.configEditor.edit()` 并接受保存触发插件重载。

**安全边界**：面板路由与其他本机 DSH 路由一样**不带鉴权**；写操作（PUT / DELETE / POST）额外校验 `Origin` 与 `Host` 同源，拒绝跨站页面改写配置或凭据。**授权白名单与待处理申请同样面板可写，因此“本机访问面板 = 可授权”**；不要把 DSH Web 服务绑定到不可信网络。凭据值只走写路径、响应永不回显，也不会写进 Web 覆盖文件。`baseDir` 可写意味着同源页面能改变模型文件的落点（面板已拒绝文件系统根目录）。

**构建**：DSH 只加载已构建的浏览器 bundle，改了 `src/client/` 或 `src/settings/contract.ts` 后需要重新构建并重启应用：

```bash
pnpm build            # 产出 lib/index.js（Host 入口）与 lib/client.js（浏览器半区）
pnpm verify:host      # 以纯 ESM 导入 Host bundle，检查 Cordis 插件面
pnpm verify:client    # 用 __ModuleLoader__ shim 做 loader 冒烟
```

## 发布

版本号由 semantic-release 按 Conventional Commits 计算，**只在手动触发时发布**；推送到 `main` / `dev` 只跑检查，可以先累积多笔提交。

| 分支 | 版本 | npm dist-tag |
| --- | --- | --- |
| `main` | 正式版，如 `0.5.0` | `latest` |
| `dev` | 预发布版，如 `0.5.0-beta.1` | `beta` |

在 GitHub Actions 的 `pipeline` workflow 点击 **Run workflow**，选择 `main` 或 `dev`：`dry_run` 默认勾选，只预览下一个版本号；取消勾选才真正发布 npm 包、打 tag 并创建 GitHub Release。安装 beta 版用 `@modesto_ma/dsh-channels@beta`。

## 目录结构

```
src/
├── index.ts               # 插件入口 apply(ctx)：effect + 导出 barrel
├── config.ts              # 配置 schema 与凭据引用校验
├── service.ts             # FeishuService 门面：生命周期、事件接线、入站与命令编排
├── access/                # 准入与授权：纯策略、持久化白名单、授权卡、申请生命周期
├── dsh-types.ts           # 宿主类型桥 barrel → src/host/
├── host/                  # DSH 表面（纯类型，无运行时依赖）
│   ├── core.ts            #   身份 / LLM 消息与流 / Session 日志与事件
│   ├── agent.ts           #   Agent、注册表、agent preset
│   ├── attachments.ts     #   ctx.attachments 窄类型：Image/File 引用、内容块、错误码
│   ├── commands.ts        #   ctx.commands 表面
│   ├── interaction.ts     #   approval/request + user-questions/request
│   └── services.ts        #   工作区 / 存储域 / 凭据 / token / llm / 投影 / HostContext
├── cards.ts               # 卡片 barrel → src/cards/
├── cards/                 # 卡片 2.0 JSON 渲染
│   ├── primitives.ts      #   信封、markdown、折叠面板、按钮、分栏等原语
│   ├── streaming.ts       #   流式回复卡构成（面板/活动行/正文/停止按钮/结算页脚）、分段、字节/表格预算
│   ├── picker.ts          #   /model、/effort、/permissions 选择卡与按钮回传解析
│   ├── onboarding.ts      #   私聊首次触达引导卡
│   ├── analyze.ts         #   日志分析占位卡、结果卡首行、失败卡
│   ├── approval.ts        #   审批决策卡
│   └── question.ts        #   结构化问答卡
├── approvals.ts           # 审批 barrel → src/interactions/
├── questions.ts           # 问答 barrel → src/interactions/
├── interactions/          # HITL 交互
│   ├── pending.ts         #   待决卡共享生命周期（登记/送达/门禁/超时/settle-once）
│   ├── approvals.ts       #   审批应答器
│   └── questions.ts       #   结构化提问应答器
├── session/               # 会话侧基础设施
│   ├── routes.ts          #   路由存储 + TTL 墓碑
│   ├── repair.ts          #   inflight 快照 + 重启修复
│   ├── manager.ts         #   live Agent、冷恢复、preset、/renew 事务
│   ├── isolation.ts       #   话题工作目录编排：workingDirectory 切换 / Git worktree + 降级
│   └── request-policy.ts  #   会话级 provider/model/reasoningEffort 覆盖（/model、/effort）
├── feishu/
│   ├── delivery.ts        # 出站投递：首帧话题卡、结果卡、分段降级、表情生命周期
│   ├── native-attachments.ts  # 原生附件存储/降级：saveImage/saveFileStream、生效后端选择
│   ├── inbound-attachments.ts # 入站附件：不下载分类、图片预取、旧版工作区存档（archive）
│   ├── manifest.ts        # <feishu_context> 清单：只列未加载附件、去重、转义、行上限
│   ├── message-read.ts    # 消息读取：get/mget/list、引用摘录、首轮历史、统一渲染
│   ├── slash-commands.ts  # 连接后把命令注册表幂等同步到飞书原生斜杠指令面板
│   ├── tools.ts           # feishu_attachment_fetch / feishu_topic_messages 与每 route 白名单
│   ├── send-file.ts       # feishu_send_file：把话题工作目录内的图片/文件发回当前会话
│   ├── wiki/              # 知识库工具：links（wikiRoots 链接解析）、api（wiki/docx/docs_ai 接口）、sheet-api / base-api（电子表格、多维表格接口）、scope（范围判定）、consent（授权卡）、shared（失败码与公共步骤）、tools / sheet-tools / base-tools、a1（A1 范围）
│   └── agent-context.ts   # agent 作用域 system prompt：native/archive 双模式附件指引
├── routing/
│   └── inbound.ts         # 入站路由：去重、准入、路由决策树、建/续会话、首触引导
├── commands.ts            # 斜杠命令解析、agent 作用域注册与结果卡
├── commands/registry.ts   # 命令注册表：词表 / 准入规则 / 分组 help 的单一事实来源
├── session-commands.ts    # /status /workspace /renew /history /compact 渲染
├── stats.ts               # 宿主投影优先的 token / 缓存 / 上下文折叠
├── domain.ts              # storageDomain 域声明与路由记录 schema
├── health.ts              # 健康快照与卡片
├── session-export.ts      # 逻辑日志导出
├── feishu-channel.ts      # 官方 SDK Channel 适配（可注入 stub）
├── client/                # 浏览器半区：设置 →「飞书渠道」页面（构建到 lib/client.js）
│   ├── index.ts           #   client 插件入口：settings.section 注册 + 样式
│   ├── panel/             #   页面外壳 + 六个标签页
│   │   ├── index.tsx      #     加载 / 5s 状态轮询 / 全局草稿 / catalog 级联 / 顶部状态头 / Tab
│   │   ├── shared.tsx     #     字段渲染原语、保存栏、阶段徽标、草稿校验
│   │   ├── connection-tab.tsx #   连接：三步引导 / 连接信息 / 待生效提醒 / 凭据卡
│   │   ├── credentials-card.tsx  #  App ID / App Secret 编辑（不回显）
│   │   ├── analyze-token-card.tsx #  日志分析接口令牌编辑（不回显，不触发重连）
│   │   ├── sessions-tab.tsx / model-tab.tsx / workspace-tab.tsx / access-tab.tsx / advanced-tab.tsx
│   │   └── access-card.tsx
│   ├── catalog.ts         #   选择器目录折叠：Host 字段 + 实时目录 → 表单字段
│   ├── api.ts             #   同源 /dsh-channels/* 请求封装
│   └── styles.ts          #   语义 token 样式（注入一次）
├── settings/              # Web 设置面板 Host 半区
│   ├── contract.ts        #   双端共享 wire 类型 / 字段清单 / 路由常量
│   ├── overlay.ts         #   settings.json 读写、校验、合并
│   ├── catalog.ts         #   宿主选择目录：provider/model/推理档位/preset
│   ├── directory-picker.ts #  系统目录选择框适配（ctx.directoryPicker native 后端）
│   ├── surface.ts         #   状态 / 面板视图模型 + 保存 / 清除 / 重连 / 选目录
│   └── routes.ts          #   HTTP 路由 + 同源写保护
└── workspaces.ts          # 用户工作区 / 话题目录 / 旧版 _staging 路径解析
```

`lib/index.js` 与 `lib/client.js` 是构建产物（`pnpm build`）：前者是安装后 profile 直接加载的 Host 入口（普通 ESM，不依赖 TypeScript 运行时转换），后者是设置面板的浏览器 bundle。`scripts/verify-host-loader.mjs` / `scripts/verify-client-loader.mjs` 分别做冒烟。

## 接入 DSH

插件安装进 dsh 的 **profile**（`$DSH_HOME/profiles/<name>/`，未设置 `DSH_HOME` 时默认 `~/.dsh`），web 界面即 `web` profile。已在真实 dsh 上实测通过的完整流程见 [docs/feishu-onboarding.md](docs/feishu-onboarding.md)（含飞书控制台配置、逐通道联调清单与故障排查），这里给出最小步骤：

安装已发布的 npm 版本（推荐）：

```bash
# 在 deepseek-harness 仓库内：把 npm 包安装进 web profile
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add @modesto_ma/dsh-channels
```

本地 checkout 开发时：

```bash
pnpm build
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add link:/path/to/dsh_channels
```

npm 发行包已包含构建产物：Host 入口是 `lib/index.js`（profile 直接以 ESM 加载，不经过 TypeScript strip；`package.json` 的 `main` 指向它），设置面板是 `lib/client.js`。本地 `link:` 安装前仍必须先执行 `pnpm build`。安装或修改后重启 dsh（桌面端重启应用，`dsh web` 重启服务并刷新页面）。DSH 只加载已构建产物，直接改 `src/` 不会生效；没有 web 载体的 profile 不注册面板，飞书通道照常运行。

包内的 `cordis.patch.yml` 会自动把 `@modesto_ma/dsh-channels` 加入 profile 的 bundle 列表，并提供稳定 `id: dsh-channels` 的 Loader 行；profile 可在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中按该 id 提供实例配置（不提供时使用默认凭据引用名）：

`appId` / `appSecret` 也各自有默认引用名 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：凭据库使用这两个名字时，bundle 行即使暂时没有 `config` 也能完成 Loader 校验并启动 Host 半侧，从而先打开设置面板补全凭据；使用自定义引用名时再按需覆盖。

```yaml
- id: dsh-channels
  config:
    appId: 'FEISHU_APP_ID'              # 凭据引用名（非密钥本身），经 ctx.credentials 解析
    appSecret: 'FEISHU_APP_SECRET'
    baseDir: './channels-data'          # 工作区根目录（按 私聊用户 / 群×用户 组织；可在 Web 面板覆盖，面板要求绝对路径）
    provider: 'deepseek-official'       # 可选：省略则用部署默认
    model: 'deepseek-v4-flash'          # 可选
    reasoningEffort: 'high'             # 可选：模型声明的精确档位 id；省略则用适配器/provider 默认
    agentPreset: 'standard'             # 可选：省略则挂 roster 默认 preset（web profile 下工具只在 preset 里）
    refreshMs: 500                      # 卡片刷新频率
    statusRefreshMs: 5000               # 活动状态行保活间隔（工具/子代理/工作流等待期的计时刷新）
    requireMention: true                # 普通群需 @ 机器人
    dmMode: 'open'
    threadFallback: 'degrade'           # 话题被拒时降级为会话级路由
    topicIsolation: 'auto'              # 话题目录隔离：auto（Git 仓库用 worktree，否则子目录）/ subdir / worktree
    routeTtlMs: 2592000000              # 话题路由 30 天无活动即过期；后续消息明确拒绝，不新建 Session（0 = 关闭）
    approvalTimeoutMs: 300000           # HITL 审批决策卡等待时长（默认 5 分钟；超时自动拒绝）
    questionTimeoutMs: 300000           # ask_user_question 问答卡等待时长（默认 5 分钟；超时本轮提问失败）
    acceptAttachments: true             # 接收飞书图片/文件/合并转发记录（native 下图片预取、文件懒取、纯附件静默不回复；false 时附件消息完全惰性）
    attachmentStore: 'native'           # 入站附件存储后端：native（DSH 原生附件库，默认）/ archive（旧版工作区 attachments/）
    prefetchImages: true                # 触发消息图片预取为首轮 ImageBlock（native 生效；关闭后图片也需工具懒取）
    prefetchImageMaxBytes: 20971520     # 单张预取图片上限（20 MiB）
    prefetchTotalMaxBytes: 52428800     # 单次触发消息预取总字节预算（50 MiB）
    prefetchTimeoutMs: 10000            # 图片预取整段超时（10 s；到期保留已取回图片，其余降级清单）
    historyBootstrapLimit: 10           # 新 Session 首轮附带本话题最近 N 条消息摘要（0 关闭，上限 20）
    promptContextTimeoutMs: 3000        # 被动引用摘录 / 首轮历史的整段读取预算（3 s；超时静默省略）
    feishuTools:                        # 模型工具（Web 面板按子键合并，不会把未改子键写空）
      attachmentFetch: true             # feishu_attachment_fetch：按需懒取已知消息的图片/文件（关闭即整体回退 archive）
      attachmentFetchMaxResources: 10   # 单次最多取回资源数（1–50）
      attachmentFetchMaxBytes: 104857600 # 单次总字节预算（100 MiB；文件流式计量）
      attachmentFetchTimeoutMs: 120000  # 单次工具调用整段超时（120 s）
      topicMessages: true               # feishu_topic_messages：读取引用消息 / 话题历史并授权其附件
      topicMessagesTimeoutMs: 20000     # 单次话题读取整段超时（20 s；被动摘录用独立 3 s 预算）
      sendFile: true                    # feishu_send_file：把话题工作目录内生成的图片/文件发给用户（需 im:resource）
      wikiRead: false                   # feishu_wiki_list / feishu_wiki_read / feishu_wiki_sheet_read / feishu_wiki_base_read：浏览 wikiRoots 内的知识库，读取文档、电子表格、多维表格
      wikiWrite: false                  # feishu_wiki_create / feishu_wiki_edit / feishu_wiki_sheet_edit / feishu_wiki_base_edit：新建文档/表格，修改本应用创建的文档和表格，向多维表格写记录
    wikiRoots:                          # 知识库范围（空 = 不挂载知识库工具；最多 20 条）
      - 'https://mi.feishu.cn/wiki/space/7xxxxxxxxxxxxxxxxx'   # 整个知识空间
      - 'https://mi.feishu.cn/wiki/AbCdEfGhIjKlMn'             # 某个节点及其下所有子节点
    welcomeOnboarding: true             # 私聊首次触达发一张引导卡（按 chat 持久化去重）
    slashCommandPanel: false            # 连接时把命令同步到飞书原生 / 面板（需 app_slash_command 读写权限；改后需重连）
    allowPermissionSwitch: false        # 是否允许 /permissions <name> 从飞书侧切换权限预设（安全敏感）
    accessMode: 'guarded'               # 准入模式：guarded（默认，仅管理员+白名单）| open（旧行为，不安全）
    adminUserId: 'a1b2c3d4'            # 管理员 user_id（可留空，留空时自动使用应用所有者；都没有时 guarded 下拒绝所有对话；面板可改）
    authRequestTtlDays: 7               # 入群/用户授权申请卡有效期（天，1–30）
    analyzeListen: '0.0.0.0:3090'       # 日志平台分析接口的独立监听地址（不填 = 关闭；改后需重连）
    analyzeToken: 'DSH_CHANNELS_ANALYZE_TOKEN' # 分析接口 Bearer 令牌的凭据引用名（值在面板填写或写进 .credentials.yaml）
    loggerLevel: 'info'
```

`reasoningEffort` 是每个 Session 的初始/重置默认值，并在新建、恢复或借用 Agent 的作用域内以 `prepend` 外层覆盖 `agent/request`，因此胜过已存在的模型选择与 provider 默认；借用外部 Agent 时，插件关闭只移除这条频道策略，不销毁外部 Agent。话题所有者可用 `/effort <档位-id>` 覆盖当前 Session，`/effort` 查看生效来源，`/effort reset` 恢复该配置值（未配置时恢复模型适配器/provider 默认）。成功选择由 Session 自带的 `command/run` / `command/done` 日志恢复，重启后仍生效；新建 Session 不继承旧 Session 的覆盖。

推理档位是适配器拥有的不透明 id（常见如 `off`、`low`、`high`、`max`），命令不会猜测或预校验 provider 的能力；不受支持的值会在下一次模型请求前被 Harness 拒绝，并按失败终态显示错误。

从旧版手写 Loader 行迁移时，删除原来的 `insert` / `id: channels` 条目；不要让旧行与 bundle 提供的 `id: dsh-channels` 同时存在，否则会启动两个插件实例。

**凭据**放在 `$DSH_HOME/.credentials.yaml`（dsh 受管凭据库，热加载，与 `DEEPSEEK_API_KEY` 同库）：

```yaml
FEISHU_APP_ID: cli_xxxxxxxx
FEISHU_APP_SECRET: xxxxxxxx
```

也可以不手改文件：安装并在 Web 面板里打开 **设置 → 飞书渠道**，在「飞书应用凭据」卡片填入 App ID / App Secret 保存即可（值同样写进该凭据库）。

文件必须仅属主可读（dsh 强制校验，否则拒绝启动）：`chmod 600 $DSH_HOME/.credentials.yaml`。解析优先级：进程环境变量 > `.credentials.yaml` > `<cwd>/.env` > `$DSH_HOME/.env`（由 `dsh-credentials-local` 提供，热加载）。配置里只写引用名，明文密钥会被 schema 拒绝。改动凭据后：Web 面板保存会即时写入，未连接时自动建立连接、已连接时提示重连；手改 `.credentials.yaml` 由凭据层热加载，但正在运行的连接不会自动使用新值，需在面板点「重启飞书连接」。

验证组合（不启动服务）：`DSH_HOME=$DSH_HOME pnpm dsh web --dump-config | grep dsh-channels`

启动成功标志（控制台）：`[dsh-channels] feishu long connection established, bot open_id: ou_xxx`；凭据不完整时不会连接，日志会提示缺少的凭据引用（如 `飞书应用凭据未配置完整（缺少 FEISHU_APP_SECRET…）`），打开 Web **设置 → 飞书渠道 → 连接** 补齐即可。

宿主 profile 已内置所需服务（agent-loop、llm-deepseek、session 持久化、storage-domain、workspace、working-directory）；web profile 默认组合还包含 DSH 原生附件库 `dsh-attachment-local` 与 `dsh-tools`（`ctx.attachments` / `ctx.tools`）。缺少原生附件库时入站附件自动回退 archive 后端（见「行为与降级」）。推荐确认 `dsh-token-meter` 已启用（卡片上下文占用显示）。Git worktree 隔离模式额外依赖可选的 `@deepseek-ai/dsh-experimental-worktree` 实验插件，缺失时自动回退为普通话题子目录。

**工具与 agent preset（web profile）**：web profile 把 bash/fs/todo 等工具行全部标为 `disabled: true`，工具只存在于 agent preset 里，且 `agents.create()` 不会自动应用 preset——插件因此在创建/恢复会话时通过 `setup` 回调挂载 preset（默认 `standard`，可用 `agentPreset` 指定更精简的 preset，如只含 bash/fs 的自定义项），并把 preset id 记录进会话头。附件管线的两个模型工具在 preset `setup` 之后挂载：`feishu_attachment_fetch` 仅 native 后端挂载（`inject(['tools','attachments'])`），`feishu_topic_messages` 两个后端都挂载；宿主缺 `tools` / `attachments` 服务时工具 no-op + 一次性告警，不阻塞会话（详见 [docs/attachment-pipeline-v2.md](docs/attachment-pipeline-v2.md)）。若机器人回复把 `<tool_calls>…` 当纯文本吐出，即该会话没挂上 preset；修好后再看会话的 `request/header` 应带 `tools` 字段、日志出现 `tool/call` 事件。无 preset roster 的部署（如 headless）不做此步骤，工具本就位于宿主层。

## 飞书侧准备

1. [飞书开放平台](https://open.feishu.cn/app) 创建**企业自建应用**，开启**机器人**能力。
2. 权限（至少）：
   - `im:message`（获取与发送单聊、群组消息；附件资源下载 `messageResource.get` 也走消息资源接口，具体 scope 以控制台该接口要求为准）
   - `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息）
   - `contact:user.employee_id:readonly`（获取用户 user ID，**必需**）：插件用 `user_id` 识别用户（准入、话题归属、工作区目录）。未开通时事件不带 `user_id`，所有用户消息都会被丢弃并打印 warn；外部联系人/跨租户用户没有本租户 `user_id`，同样无法使用
   - `im:message:readonly`（读取消息内容：引用摘录、话题历史、`feishu_topic_messages`）
   - `im:message.group_msg`（读取群组消息，**敏感权限**，需企业管理员审批）：读取群/话题历史（含机器人入群前的可见历史）。未开通时引用/历史块静默省略、普通对话不受影响，按“机器人可见范围”降级
   - 事件：**接收消息 im.message.receive_v1**（含“接收群聊中 @ 机器人消息”）
   - 事件：**机器人进群 im.chat.member.bot.added_v1**（入群后私聊管理员发群信息卡）；对应的群信息读取权限（如 `im:chat:readonly`，以控制台要求为准）
   - 私聊需要能主动给管理员发消息（`im:message` 已覆盖；管理员需在应用可用范围内）
   - 「获取应用信息」权限（**可选**，如 `admin:app.info:readonly` / `application:application:self_manage`，以控制台要求为准）：未配置 `adminUserId` 时，插件在每次连接时调用 `application/v6/applications/:app_id` 查询应用所有者并让其成为管理员；调不通（企业内不便申请该权限等）时日志与面板会给出飞书返回的错误码，并提示在「访问授权」手动填写管理员 user_id，填写后不再依赖它
   - 回调：**卡片回传交互 card.action.trigger**（流式卡停止按钮、`/model` 等选择卡、HITL 审批 / `ask_user_question` 问答按钮的回传事件，同样走长连接）
   - `im:resource`（获取与上传图片或文件资源，**可选**；`im:resource:upload` 亦可）：`feishu_send_file` 上传图片/文件后发给用户。未开通时该工具返回可读的 `PERMISSION_DENIED`；关闭 `feishuTools.sendFile` 后自检不再检查此项
   - `wiki:wiki`、`docx:document`、`sheets:spreadsheet`、`bitable:app`（**可选**，仅开启知识库工具时需要；只读可用 `wiki:wiki:readonly` / `docx:document:readonly` / `sheets:spreadsheet:readonly` / `bitable:app:readonly`，也接受新版细分权限 `sheets:spreadsheet:read` / `sheets:spreadsheet:write_only` / `base:record:read` / `base:record:create` / `base:record:update` / `base:record:delete`）：浏览知识库节点，读取/新建/修改飞书文档、电子表格、多维表格。应用还必须是目标知识空间的成员，否则调用返回 `NO_ACCESS`
   - `im:message.reactions:write_only`（发送、删除消息表情回复）
   - `im:message:update`（更新卡片）

   > 消息读取权限缺失时不会报死错：引用摘录与首轮话题历史静默省略（插件生命周期内首次降级输出一条 warn，之后 debug 级），显式调用 `feishu_topic_messages` 返回可读的 `PERMISSION_DENIED`。附件下载仍依赖 `im:message` 一类的消息资源权限；下载被拒时工具与 archive 路径都会返回可读原因。
   > **连接后权限自检**：每次连上飞书后，插件调用 `application/v6/scopes` 读取应用的租户权限授予状态，与上面的清单对比（私聊关闭时不检查 `im:message.p2p_msg:readonly`，`requireMention: false` 时 `im:message.group_msg` 升为必需；`feishuTools.sendFile` 关闭时不检查 `im:resource`；知识库工具未挂载时不检查 `wiki:wiki` / `docx:document` / `sheets:spreadsheet` / `bitable:app`；未配置管理员且应用所有者查询被飞书拒绝时追加可选项「获取应用信息」）。缺失项在 Web 设置「连接」页以红字列出（标注必需/可选与用途，每项附开发者后台权限页深链，另有一键打开全部缺失项的链接），并在日志打印一条 warn；读取失败时显示飞书返回的原因。自检只做提示，不阻断连接；开通权限后需发布新版本并重新连接才会刷新。
3. 事件订阅方式选**长连接**（WebSocket，免公网）。
4. 发布版本并把用户加入可用范围；将机器人拉入测试群。

## 工作区与会话隔离

工作区（DSH workspace registry 中的「项目」）按**人**建立，只在首次需要时创建；每个话题在工作区内拥有独立的**实际工作目录**：

| 场景 | 工作区目录（header cwd） | 每个话题的工作目录（实际 cwd） |
|---|---|---|
| 私聊 | `<baseDir>/p2p/<user_id>/` | `<工作区>/topics/<话题 id>/` |
| 群聊 | `<baseDir>/groups/<chat_id>/<user_id>/` | 同上 |
| 日志平台分析 | `<baseDir>/analyze/<应用>/<错误码>/` | 同上 |

- 群聊必须是「群 × 用户」：同一个人在不同群之间不共享文件，避免 A 群会话把 B 群内容带出来。
- 会话创建时以工作区为 header cwd（保证 GUI 里归属该项目、沙箱边界稳定），随后通过 `ctx.workingDirectory` 把实际工作目录切到话题目录；冷恢复会从 Session 日志还原该目录。因此话题之间的文件互不干扰，而工作区数量只随用户增长。
- `topicIsolation` 控制隔离形式：`auto`（默认）在用户工作区是 Git 仓库（含 `.git`）时给每个话题建一个 `feishu-<话题>` 分支 + worktree（适合多个话题并发改同一个代码仓库），否则用普通子目录；`subdir` 一律子目录；`worktree` 一律尝试 worktree，失败告警并回退子目录。
- 隔离强度：这是**默认工作目录层面**的隔离（bash / fs / 终端都从话题目录出发），不是防恶意的硬沙箱——沙箱写边界仍是用户工作区。若需要硬边界，可把话题目录直接作为 Session cwd，但会话会失去工作区归属（GUI 显示为未分组）。
- **入站附件（v2）**：native 后端下图片/文件存入 DSH 原生附件库，**不写入话题目录**，因此工作区与话题目录只承载 Agent 产物；仅显式 `archive` 后端（或宿主缺原生附件服务）才写当前话题目录的 `attachments/`，话题建立前先暂存 `<baseDir>/_staging/...`。v2 主路径不再写 `_staging`；旧版遗留的暂存文件仅保留一次性迁入，按 D12 在 v2 发布后的下一个 minor 版本移除。`/renew` 复用同一话题目录。
- **插件不删除任何工作区或话题目录**。需要回收磁盘时手动删除不再需要的话题目录即可：该话题下次对话时会重建一个空目录继续使用（worktree 模式下改建新的 worktree 分支）。手动删除 worktree checkout 后，可在仓库里 `git worktree prune` / `git branch -D` 回收 Git 记录。
- 旧版本「一个话题一个工作区」（`<baseDir>/topics/...`）不会自动迁移：旧话题继续用原目录；旧版「用户 × 聊天」共享工作区正好作为新的用户工作区复用。
- 设计取舍与约束详见 [docs/workspace-isolation-design.md](docs/workspace-isolation-design.md)。

## 日志平台分析接口

日志平台调用插件的分析接口：插件在指定群里发一张占位卡，把平台给的 prompt 原样交给一个新 Session（prompt 开头的斜杠命令由 DSH 展开成对应 skill），分析结束后**一次性**把结果写回这张占位卡（不流式）。群里通过准入的成员都可以在该话题内追问。插件只负责接收 prompt 和开会话：日志包地址写在 prompt 里，下载、解压、超时都由日志分析 skill 自己处理（Session 的沙箱需要能访问日志存储地址）。

**开启**：配置 `analyzeListen`（如 `0.0.0.0:3090`，面板「行为」页可改，需重连），并在同一页的「日志分析接口令牌」卡片填写访问令牌（建议 32 位以上随机串；写入 DSH 凭据库的 `DSH_CHANNELS_ANALYZE_TOKEN`，也可直接写进 `$DSH_HOME/.credentials.yaml`，引用名可用 `analyzeToken` 修改）。接口跑在独立端口上，与 DSH Web 端口无关；令牌每次请求都重新解析，轮换后下一次请求生效；令牌缺失时所有请求返回 503。端口绑定失败不影响飞书连接，健康等级降为「降级」，面板「健康判定」与 `/health` 卡片会显示失败原因。

**请求**：

```http
POST /dsh-channels/analyze
Authorization: Bearer <令牌>
Idempotency-Key: <平台生成的唯一值，1-200 个可见 ASCII 字符>
Content-Type: application/json

{
  "requesterUserId": "a1b2c3d4",
  "app": "camera",
  "errorCode": "E1001",
  "chatId": "oc_xxx",
  "prompt": "/log-analyze https://logs.example.com/1.zip https://logs.example.com/2.zip 请分析这些日志"
}
```

- `requesterUserId`：平台发起人的飞书 user_id，占位卡与结果卡 @ 此人；路由记录里也以此人作为发起人。
- `app` / `errorCode`：只允许 `A-Z a-z 0-9 . _ -`（1–128 字符），决定工作区 `<baseDir>/analyze/<app>/<errorCode>/`；同一应用同一错误码的所有分析都在这个工作区里，每次分析各有一个话题目录。
- `chatId`：目标群，必须是已授权群（`/auth group add` 或面板「访问与授权」），机器人需在群内；`accessMode: open` 时不校验。
- `prompt`：1–100000 字符，原样作为首条用户消息，插件不追加任何内容。
- 只接受以上 5 个字段，多余字段返回 400。

**响应**：校验通过、占位卡发出后立即返回 `202`：

```json
{ "ok": true, "chatId": "oc_xxx", "messageId": "om_xxx" }
```

`messageId` 是占位卡的消息 id，分析话题挂在它下面。同步错误都带中文 `error`：`401` 令牌无效、`400` 参数或 `Idempotency-Key` 不合法、`403` 目标群未授权、`409` 同一个 `Idempotency-Key` 已被内容不同的请求使用、`413` 请求体超过 1 MiB、`415` 不是 JSON、`502` 占位卡发送失败（如机器人不在群里）、`503` 飞书未连接或未配置令牌。

**去重**：同一个 `Idempotency-Key` 再次请求（包括并发重试）原样返回第一次的结果，不会再发卡、再分析。记录永久保存在 `channels_routes_v2` 域的 `analyze_requests` 表。占位卡发出后的失败（话题创建、Session 创建）不会回滚这条记录：占位卡会被替换成「日志分析未能开始」失败卡并写明原因，需要重试时请换一个新的 `Idempotency-Key`。

**群里看到的**：先是占位卡「@发起人 正在分析 X 应用的 Y 问题」，紧接着话题内一条提示（同时用来创建话题）；分析结束后占位卡原地变成结果卡（首行保留发起人、应用、错误码），并加上 DONE / No 表情。分析过程中出现的审批卡、提问卡发在话题内。

**追问与权限**：分析话题的路由是**群内共享**的（路由记录 `shared: true`）：群里任何通过准入的成员（管理员，或该群已授权且本人在用户白名单）都可以在话题内直接回复追问（无需 @），也可以点停止按钮、回答审批卡与提问卡、在话题里执行会话命令；未授权的人仍被静默忽略。追问的回复照常流式输出。话题之间互不读取，和普通话题一样。分析结果 markdown 怎么回传给平台由日志分析插件自己负责，本插件不参与。

## 行为与降级

- **入站附件（v2：零等待 + 清单 + 图片预取 + 文件懒取）**：收到触发消息时先建会话 / 话题 / 卡片第一帧并持久化路由，**不在建立前下载任何附件字节**。随后组装的 prompt 依次为：说明文字 → `<feishu_quote>` 引用摘录 → 预取成功的 `ImageBlock` → `<feishu_context>` 未加载附件清单 → （首轮）`<feishu_history>` 话题历史；空块不产生 token。触发消息中的图片在路由建立后、`followup` 前**预取**进首轮（单图 `prefetchImageMaxBytes`、总量 `prefetchTotalMaxBytes`、整段 `prefetchTimeoutMs`，失败/超限/超时降级为清单项）；文件**默认不下载**，清单只给 `message_id / file_key / 类型 / 文件名`，模型需要时调用 `feishu_attachment_fetch` 懒取（图片回 `ImageBlock`，文件流式入库 + `FileBlock` + 只读路径兜底）。富文本（post）消息 `files[]` 里 SDK 归一化会丢的文件也会被恢复并进入清单/预取。**只发附件、不带说明的消息完全静默**：不回复、不建会话、不下载、不加表情，本地不写任何记录。插件不扫描历史去找这类消息：用户需要引用那条消息再提问（多个文件先合并转发再引用），被引用消息的附件进入清单与 fetch 白名单；话题内的附件也可由模型调用 `feishu_topic_messages` 读到并获得授权。
- **引用与话题历史**：触发消息的 `parent_id` 解析为 `<feishu_quote>` 摘录（单条 ≤400 字符、整块 ≤4k，合并转发展开子消息并标注容器 id），被引用消息的附件同时进入清单与 fetch 白名单；新 Session 首轮自动带最近 `historyBootstrapLimit` 条（默认 10、上限 20、0 关闭）的 `<feishu_history>`（单条 ≤400 字符、整块 ≤8k，排除触发消息与卡片）。更早的消息用 `feishu_topic_messages` 按 `limit`（默认 10、上限 50）与 `cursor` 翻页；读到的消息与附件即获得 fetch 授权。被动读取使用独立的 `promptContextTimeoutMs`（默认 3 s）预算，缺权限/超时/失败时对应块静默省略，回合照常运行（首次降级一条 warn）。
- **入站附件存储后端与降级矩阵**：`attachmentStore: 'native'`（默认）且宿主挂载 `ctx.attachments`、`feishuTools.attachmentFetch=true`、`acceptAttachments=true` 时走 native 懒取；以下任一条件成立即整体回退旧版 archive（同步下载到工作区 `attachments/`、纯文本 prompt、无清单、不挂 fetch 工具）：显式 `attachmentStore: 'archive'`；宿主未挂载原生附件库（一次性 warn）；`feishuTools.attachmentFetch=false`（文件无法懒取）。`acceptAttachments=false` 时走 archive 的惰性分支：附件消息完全不保存、不触发、不列入清单，混合消息只保留剥离占位符后的文字。`feishu_topic_messages` 两个后端都挂载（archive 下描述会标注附件不可取）。archive 保留旧实现细节：文件流式落盘且文件名前缀 `YYYYMMDD-HHmmss-`，合并转发记录写 `*-forwarded-record.txt`，成功加 `DONE`、失败加 `No` 并回一条纯文字失败提示，>100 MB 文件先探测大小再按 32 MiB `Range` 分块下载；该路径会在会话建立前下载，属于降级而非默认体验。
- **附件与目录保留**：DSH 原生附件库**永不自动清理，插件也不提供清理入口**（D6；磁盘增长用户已接受）。插件同样不删除工作区、话题目录、`_staging` 与 Session 日志；archive 后端的 `attachments/` 副本位于话题目录，随运维手动删除目录一起删除。v2 主路径不再写 `_staging`，仅对旧版遗留文件做一次性迁入（成功时一条 warn），按 D12 在 v2 发布后的下一个 minor 版本移除。切换到 native 后，历史话题里的旧 archive 附件目录不会被新会话枚举，但 Session 历史仍可按原路径读取。
- **三类会话行为矩阵（v2）**：

  | 场景 | 私聊 | 对话群（未 @） | 对话群（@） | 已绑定话题（无 @） |
  | --- | --- | --- | --- | --- |
  | 纯附件消息 | 静默（不建会话/不回复/不下载；下一轮列入清单） | 静默（后续 @ 建话题时列入清单） | 静默（纯附件不触发） | 静默（下一轮续聊时列入清单） |
  | 文字 + 附件 | 建会话；图片预取 / 文件清单 | 不触发；后续 @ 建话题时列入清单 | 建会话；图片预取 / 文件清单 | 续聊；图片预取 / 文件清单 |
  | 纯文字 | 建会话 | 不触发 | 建会话 | 续聊同一 Session |
- **DSH 0.2.0 兼容**：会话日志读取改用 `Session.snapshotEvents()`（整段 `Session.events` getter 已被 DSH 删除）；正文/推理增量改用瞬时事件 `agent/assistant-stream`（持久化 `assistant/chunk` 已不再产生，改为把流内嵌进 `assistant/message.stream`），并处理 `abandoned` 尝试的文本回滚；卡片 token / 缓存命中 / 上下文窗口优先读宿主 `sessionProjections`（`sessionStats` / `tokenUsage` / `contextPressure`），未挂载时回退到本地增量折叠 + `llm.resolveModelInfo`。完整评估、证据与实施状态见 [docs/review-dsh-0.2.0.md](docs/review-dsh-0.2.0.md)。
- **话题创建**：通过回复消息接口 `reply_in_thread: true`（官方文档明示的“以话题方式回复（即创建话题）”）。响应后经 `im.v1.message.get` 取回 `thread_id` 写入路由表。
- **话题延续**：`im.message.receive_v1` 事件自带 `thread_id`，命中路由表即 `agent.followup()`，无需 @。同一 (chat, user) 的**并发首消息会被串行化**：后到的消息等待在途的会话建立完成，再按串行语义续聊同一 session 或另起新话题——不会重复建 session、覆盖路由，也不会落入“无路由、无 @”的丢弃窗口。
- **降级（`threadFallback: 'degrade'`）**：私聊或群聊拒绝话题回复（如 230071）时，自动改为普通回复，路由键退化为 `chat:p2p:<chat_id>:<user_id>` / `chat:group:<chat_id>:<user_id>`（会话级延续）；`strict` 则直接失败。
- **重启恢复**：路由表持久化在 `storageDomain`；消息到达时 `ctx.agents.resume()` 懒恢复 session。若会话已被其他 owner 恢复为 live（如 Web UI 打开过该会话、并发冷恢复竞态），插件**借用**该 live agent 直接 `followup()`，不再报 "cannot prepare session … while it is live"。借用的 agent 不归插件 dispose；shutdown 与在途 resume 竞态时，刚发布的 agent 会被立即 dispose 以避免泄漏进下一实例的 live 注册表。
- **重启修复（流式中断）**：每条正在流式的 turn 会把自己的修复凭据（trigger 消息、Typing reaction id、全部段卡 id）写入 `channels_routes_v2` 域的 `inflight` 表（键 = 主卡 message id，turn 结束即删）。重启后长连接一建立，插件就把上一实例留下的中途卡片 patch 成「⚠️ 服务已重启，本次回复中断，请重新发送消息。」终态并补 DONE 表情；patch 失败重试一次（上限 2 次）后放弃。持久化盘点与缺口清单见 [docs/persistence.md](docs/persistence.md)。
- **消息去重（WS 重投幂等）**：飞书长连接重连会重投未 ack 的事件；每条消息在任何副作用之前先落一条 `processed` 记录（键 = message id，飞书全局唯一），重投消息被直接丢弃——同进程靠内存守卫、跨重启靠持久化记录，每条消息至多处理一次。记录保留 24 小时后由 GC 清扫。
- **路由表 GC 与过期话题拒绝**：超过 `routeTtlMs`（默认 30 天）无活动的真实话题路由会先写入最小持久化墓碑，再删除活动路由；此后该话题中的普通消息和 Session 命令会收到「话题已过期」提示，插件不会恢复旧 Session，也不会在可见历史仍属于旧 Session 的话题里新建 Session（`/help`、`/userid`、`/groupid`、`/health` 仍可用）。墓碑跨重启保留，仅含 thread/chat/owner/工作区路径/会话目录/最后活动时间；旧 DSH Session、日志与话题目录都不删除。降级的 chat-scoped 路由没有独立话题边界，仍直接清理。陈年 in-flight 快照同时在启动时及每 6 小时清扫。`routeTtlMs: 0` 关闭后续路由过期处理，已产生的墓碑仍保持拒绝语义。
- **准入与授权**：`accessMode: 'guarded'`（默认）下，入站先过频道准入：**管理员不受任何白名单限制**，私聊/任意群聊（含未授权群）都可直接开会话；**非管理员**私聊回固定提示（`/userid` 例外），群聊要求 **群在白名单** 且 **user_id 在全局用户白名单**，两者缺一不可。未授权消息不建 Session、不建话题目录、不落附件、不调模型；群里静默、私聊回固定文案。机器人被拉进任意群时（订阅 `im.chat.member.bot.added_v1`），插件私聊管理员发群信息卡（群名/`chat_id`/成员数/邀请人），未授权群附「授权本群 / 忽略」按钮；已授权群里未授权用户 @ 机器人时，管理员会收到用户授权申请卡（含昵称/user_id）。授权状态持久化在 `channels_routes_v2` 域的 `access_groups` / `access_users` / `access_requests` 表，撤销立即生效。管理员 user_id 在 Web 面板配置，留空时为飞书应用所有者（连接时查询，需可选的「获取应用信息」权限；查询失败则 fail closed，手动填写管理员即可）；`/auth` 命令、授权卡、面板三种入口等价。
- **HITL 审批**：插件以 `prepend: true` 注册为宿主 `approval/request` 瀑布的应答者——本频道路由的 session 的审批请求**优先于** Web 网关的通用应答（其面板对飞书用户不可见），非本频道的请求原样 `next()` 交给其他应答者。审批卡是**独立消息**（锚定到该 session 最新流式卡、同话题），绝不嵌入流式卡（其全量替换 patch 会冲掉按钮）。宿主请求不带工具参数，插件在 `session/event` 中按会话记录**当前回合**的 `tool/call`（回合结束即清空，不回读历史），按 `callId` 取出命令显示在卡上（超过 600 字截断并注明）。决策仅在会话发起人操作时生效：允许 → `allowed-once`；本话题不再询问 → `allowed-once`，并在内存里记下「工具名 + 提权目标」，该 session 之后的同类请求直接 `allowed-once`、不再发卡，同 session 里其他被覆盖的待审批卡一并允许（`/renew` 换 session 或重启后失效，提升到 `danger-full-access` 时按钮标红）；拒绝 → `rejected`；文字回复中「允许 / 同意 / 好 / y」等、「拒绝 / 不行 / n」等、「全部允许」等关键词作用于该 session 最新一张待审批卡，其他文字把该 session 所有待审批卡按 `rejected` 结算后照常作为下一条消息交给 Agent；超时 → `rejected`（fail-closed，卡面显示「已超时」）、请求被撤回（abort）→ `cancelled`、卡片发送失败 → `unavailable`（fail-closed）；每次决策后卡片更新为终态（注明按钮 / 文字回复 / 不再询问 / 被新消息取代）并移除按钮。审批记录（`approval/asked`/`decided`）由宿主会话日志负责，插件不做持久化——重启后遗留问题随 turn 消亡，与 Web 网关一致。需要飞书应用订阅 **card.action.trigger** 回调（见「飞书侧准备」）；启动日志 `HITL 审批应答已就绪` 表示生效，`主机未挂载 approval 服务` 表示该部署未启用 HITL。
- **终态与表情**：成功轮的面板标题变为「回复结束」（无推理内容时不渲染面板），并把 `Typing` 换成 `DONE`；`turn/end.kind = error` 时面板标题为「回复失败」（同样仅当有推理内容），错误只在正文出现一次（`❌ **本轮运行失败**` + 结构化错误消息与错误码），并把 `Typing` 换成 `No`。模型/推理强度/本轮缓存样本不会继承上一轮。
- **限频**：卡片更新单条消息 5 QPS、应用级 1000 次/分钟；500ms（2 QPS）默认安全，`refreshMs` 下限 200ms；活动状态行的保活心跳默认 5s（`statusRefreshMs` 下限 1s），远低于限频。
- **卡片体积**：预算常量收敛为三个——`CARD_TARGET_BYTES`（28 KB，分段目标）、`CARD_MAX_BYTES`（30 KB，飞书硬上限，仅作 `buildCard` 的绝对兜底）、`REASONING_MAX_BYTES`（5 KB，推理面板内容窗口）；**不再有面板预留**（原 5.5 KB 的 `CARD_PANEL_RESERVE_BYTES` 已删除），分段改为按整卡真实渲染测量：主卡探测面板最大窗口 + 完成态页脚，续卡无面板/页脚、可用满 28 KB（约 27.8 K ASCII 字符，100 KB ASCII 正文约 4 张卡）。正文超长自动分段为多张续卡，断点统一避开代码围栏与表格（段落/标题/行断点；单个代码块/表格小于单卡预算时整体换卡，超过单卡预算时只能硬切、内容不丢；每卡 ≤ 5 个表格，全文保留）。推理面板超出 5 KB 时保留头部并追加「…（内容过长，已截断）」（可见窗口约 4.96 K ASCII 字 / 1.65 K 中文字 / 1.24 K emoji），面板内表格省略；窗口长度与正文长短无关，不占用也不被正文挤占。
- **续卡降级**：分段卡片发送被飞书拒绝（如表格数量超限 230099/11310）时，自动改发纯文本消息；卡片更新失败按指数退避重试，不刷屏报错。

## 已知取舍

- **v2 附件（图片预取的等待窗口）**：卡片、话题与会话先建立，但首轮 `followup` 会等图片预取（默认整段 ≤10 s，`prefetchTimeoutMs` 可调）；这是“首轮图片直接可见”与首字延迟之间的取舍，慢网下可调小或关闭 `prefetchImages`。不做后台预取/预下载。
- **v2 附件（文件懒取依赖模型调用）**：文件默认不在 prompt 里，模型必须主动调用 `feishu_attachment_fetch`；插件用清单“未加载”措辞、工具描述与 guidance 收敛漏调风险，但不做预下载兜底（决定 D4）。
- **v2 附件（授权白名单进程内）**：每 route 的已知消息 LRU 上限 128，进程重启后白名单清空；本人在本话题（会话级路由为聊天主线）发的消息由 fetch 工具回读飞书校验后仍可授权；话题之间不互通；他人的引用/历史消息需要重新出现在引用或历史中才可取。附件密集翻页仍可能挤掉更早条目。
- **v2 附件（清理与保留）**：DSH 原生附件库不可自动清理、插件不提供清理入口，磁盘随使用增长；插件也不删除工作区与话题目录，需要时由运维手动删除。旧 `_staging` 仅一次性迁入兼容（成功时 warn），按 D12 在 v2 发布后的下一个 minor 版本移除。
- **v2 附件（未触发的附件需要引用）**：只发附件、不带文字的消息不登记、也不在下一轮自动列出；“先发文件、再单独提问”而不引用时模型看不到该文件。私聊与普通群需要引用那条消息（多个文件可合并转发后引用）；话题内模型还可以用 `feishu_topic_messages` 读到。首次私聊引导卡写明了这一用法。
- **v2 附件（权限降级）**：缺 `im:message:readonly` / `im:message.group_msg` 时引用摘录与首轮历史静默省略（首次一条 warn），显式调用 `feishu_topic_messages` 返回可读 `PERMISSION_DENIED`；普通对话不受影响。入群前历史只保证“机器人可见范围”。
- **v2 附件（升级连续性）**：旧 archive 部署切到 native 后，历史话题里已有的 `attachments/` 不会被新会话枚举；Session 历史仍可按原路径读取，旧目录可手动删除。
- **`/renew` 的会话语义**：同一话题内新建 Session 沿用话题目录、复用附件；但新 Session 首轮不注入 `<feishu_history>`（仅 `startSession` 路径注入首轮历史，当前语义保留，若产品期望“新会话即带话题历史”需另行确认）。
- **degraded 群会话的读取容器**：话题创建失败降级为 chat 路由后，其容器是整群主时间线——同群他人主时间线消息可被读取/登记（topic 消息已明确拒绝）；是否按 sender 进一步收紧待产品确认。
- **合并转发读取有界**：单条读取子消息超过 50 条时截断（summary 标注数量）、无翻页；工具输出渲染上限 50 行 / 12k 字符。
- patch 为全量替换：流式期间用户手动展开折叠面板会被下一次刷新收起；流式结束后不再刷新，可自由展开。
- 超长正文拆成多张卡片（分段投放）：推理内容不跨卡片，始终留在首卡；超出 5 KB 的部分被截断（只保留开头），不追加投放。
- 活动状态行只在当前正在流式输出的那张卡上渲染：若最后一张续卡被飞书拒收、降级为纯文本（无法再 patch），结算状态行（工作流结论 / 子代理完成摘要）不会显示；主卡结算页脚不受影响。
- 子代理只显示状态（label / 当前工具 / 计时 / 并行计数），不显示其输出正文；后台子代理（`run_in_background`）在父 turn 结束后不再继续显示进度（卡片随父 turn 收尾）。
- 私聊 `reply_in_thread` 已随 P1 真机验证可用（私聊话题正常建立与续聊）；若个别租户拒绝，按 `threadFallback: degrade` 退化为会话级路由。
- 会话的 agent 常驻内存，不做空闲回收（重启后按需懒恢复）。
- 重启修复会**全量替换**中断的卡片：旧进程里已流出的部分正文随之消失（本地没有副本，patch 是全量语义）；修复是一次性 + 一次重试，不再无限重试。
- 路由 GC 是 TTL 兜底：未监听飞书“群解散/话题删除”事件做主动清理；真实话题过期后写入持久化墓碑，用户回来会收到明确拒绝，不会在旧话题中误建新 Session。
- 消息去重是**至多一次**语义：接受后、副作用完成前崩溃的极小窗口内，重投消息会被丢弃——中断修复卡提示“请重新发送消息”，用户重发即可（新 message id 正常处理）。
- 插件启用时**不会无条件连接飞书**：只有两项凭据都能解析时才建连，凭据不完整时插件照常加载、面板显示「待配置」引导；连接失败只影响连接本身，插件入口保持加载。
- Web 面板编辑的是当前凭据**引用名**背后的值（profile 配置 `appId` / `appSecret` 指向的 ref）；更换引用名仍需编辑 profile 配置并重启 DSH。凭据提供方只读时面板会禁用输入并提示。
- Web 面板的模型字段优先渲染为宿主目录驱动的下拉（provider → model → 推理档位）；宿主没有 LLM 服务或目录查询失败时退回自由文本，手填错误仍会在下一次模型请求时由 Host 报错；「重启飞书连接」会中断进行中的回复。
- 持久化盘点与全部缺口状态见 [docs/persistence.md](docs/persistence.md)。

## 开发

```bash
pnpm install --store-dir ./.pnpm-store   # 受限环境；正常环境直接 pnpm install
pnpm typecheck        # Host（tsconfig.json）+ Client（tsconfig.client.json）两套
pnpm test
pnpm build            # → lib/index.js（Host）+ lib/client.js（浏览器半区）
pnpm verify:host      # Host bundle 以纯 ESM 导入加载
pnpm verify:client    # client loader 冒烟
pnpm check            # 以上全部
```

测试以 stub 替换官方 SDK 与 DSH 宿主服务，无需真实凭据。附件管线相关测试：`tests/native-attachments.test.ts`（存储层与 archive 降级）、`tests/feishu-tools.test.ts`（两个工具的白名单 / 上限 / 取消）、`tests/manifest.test.ts`（清单格式与转义）、`tests/inbound-image-prefetch.test.ts`（预取降级）、`tests/message-read.test.ts`（引用 / 历史读取）；接入链路由 `tests/service.test.ts` / `tests/inbound-attachments.test.ts` 覆盖。`tests/settings.test.ts` 覆盖：覆盖层 schema/层级、面板视图模型、连接阶段（待配置/未连接/已连接/失败）、凭据保存按就绪度连接、HTTP 路由（含同源写保护）、`apply()` 的 webServer 接线、模型选择器的宿主目录与降级行为；`tests/client-catalog.test.ts` 覆盖浏览器半区的目录折叠（含依赖项解禁回归）；以及 `FeishuService` 的覆盖加载 / 热更新 / 重启 / 连接失败记录 / 监听器释放。

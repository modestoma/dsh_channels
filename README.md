# dsh-channels

DeepSeek Harness（DSH）飞书渠道插件：**一个 dsh 实例对应一个飞书机器人**，用户只需与飞书机器人对话即可使用 dsh。

- 对话入口：私聊、群聊 @ 机器人、话题群 @ 机器人
- 收到触发消息：立刻加 **“Typing”** 表情 → 以话题形式回复（**创建话题**）→ 绑定 DSH session → 卡片 2.0 **流式回复** → 结束移除 “Typing”、更新为 **“DONE”**
- 话题内后续消息**无需再 @**，自动延续该 session
- 工作区归属：私聊一人一工作区；群里**每个用户各自一个工作区**（同群不同用户互不影响）
- 全部基于飞书官方 SDK [`@larksuiteoapi/node-sdk`](https://www.npmjs.com/package/@larksuiteoapi/node-sdk)（WebSocket 长连接，免公网）

设计与可行性论证见 [docs/feasibility-and-design.md](docs/feasibility-and-design.md)。

## 流式卡片

卡片 2.0，三段式，默认 500ms 刷新（`refreshMs` 可调）：

1. **推理折叠面板**（`collapsible_panel`）：带边框、默认折叠；标题三态 **推理中 → 回复中 → 回复结束**；右侧箭头随折叠状态翻转（折叠向下、展开向上，`icon_expanded_angle: 180`）
2. **活动状态两行**（小字，仅在存在临时活动时渲染，**互相独立、互不顶替**），让卡片在“模型不吐字”的阶段（工具执行、subagent、workflow）**不再静默**——按 `statusRefreshMs`（默认 5s）慢节奏刷新计时；正文开始输出后随活动结束收起：
   - **状态行**（委托进度）：`tool-workflow/run-start / agent-start / agent-end / run-end`（工作流进度：完成数/总数、阶段、活动成员）→ run 结束转为 `🧵 工作流 xxx 结束（完成）` 并**一直保留到整轮回复结束**（后续工具调用、正文输出都不会顶掉它）；**子代理进度**（跨会话映射）：子代理是独立 session（`header.parentSession` 指向主会话），其 `subagent/descriptor`（label）、`tool/call`（当前工具）、`turn/end`（结束移除）被折叠为 `🤖 子代理执行中：检索实现方案 (read) · 已运行 45s`，并行子代理显示计数。**只显示状态，不显示输出**——子代理正文是父模型的中间产物，绝不进卡片正文
   - **工具行**（父会话当前工具调用）：`tool/call` → `🔧 调用工具：bash · 已运行 Ns`（subagent 工具显示其 description、workflow 工具显示 meta.name），`tool/result` 返回即清除
   - 两者可同屏：如 `🧵 工作流 xxx 结束（完成）` + `🔧 调用工具：bash`
3. **回复正文**：富文本 markdown；超长正文**自动分段投放**——单卡片预算用满后按干净断点（段落 / 标题 / 代码块边界）切分，且**每张卡最多 5 个表格**（飞书硬限制，错误 11310），表格绝不会被从中间切断；续片以「📄 回复分段 n」卡片跟进同一话题，**全文无丢失**；续卡被飞书拒收时自动降级为纯文本消息（内容仍送达）
4. **session 信息**（两行小字）：
   - `🔑 {session id} · ⬆ input token {input} · ⬇ output token {output}`（session 累计口径）
   - `🧠 模型 {model}({effort}) · ⚡ 缓存命中 {cache} · 📊 上下文 {tokens}/{window}`

## 目录结构

```
src/
├── index.ts           # 插件入口 apply(ctx)
├── config.ts          # 配置 schema 与 env: 凭据解析
├── dsh-types.ts       # DSH 宿主表面的最小类型桥（无运行时依赖）
├── feishu-channel.ts  # 官方 SDK Channel 模块适配（可注入 stub）
├── service.ts         # 路由 / 工作区 / session 编排
├── streamer.ts        # session/event → 卡片快照，500ms 节流 patch
├── cards.ts           # 卡片 2.0 JSON 纯函数渲染
├── stats.ts           # session 累计 token / 缓存命中 / 上下文折叠
├── domain.ts          # storageDomain 路由表（thread_id → sessionId）
└── workspaces.ts      # (chat, user) → 工作区目录
```

## 接入 DSH

插件安装进 dsh 的 **profile**（`$DSH_HOME/profiles/<name>/`，未设置 `DSH_HOME` 时默认 `~/.dsh`），web 界面即 `web` profile。已在真实 dsh 上实测通过的完整流程见 [docs/feishu-onboarding.md](docs/feishu-onboarding.md)（含飞书控制台配置、逐通道联调清单与故障排查），这里给出最小步骤：

```bash
# 在 deepseek-harness 仓库内：把本地插件装进 web profile（幂等，可重复执行以更新）
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add dsh-channels@file:/path/to/dsh_channels
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加（新条目用 `insert:` 列表）：

```yaml
- insert:
    - id: channels
      name: 'dsh-channels'
      config:
        appId: 'FEISHU_APP_ID'              # 凭据引用名（非密钥本身），经 ctx.credentials 解析
        appSecret: 'FEISHU_APP_SECRET'
        baseDir: './channels-data'          # 工作区根目录（按 私聊/群聊/用户 组织）
        provider: 'deepseek-official'       # 可选：省略则用部署默认
        model: 'deepseek-v4-flash'          # 可选
        agentPreset: 'standard'             # 可选：省略则挂 roster 默认 preset（web profile 下工具只在 preset 里）
        refreshMs: 500                      # 卡片刷新频率
        statusRefreshMs: 5000               # 活动状态行保活间隔（工具/子代理/工作流等待期的计时刷新）
        requireMention: true                # 普通群需 @ 机器人
        dmMode: 'open'
        threadFallback: 'degrade'           # 话题被拒时降级为会话级路由
        loggerLevel: 'info'
```

**凭据**放在 `$DSH_HOME/.credentials.yaml`（dsh 受管凭据库，热加载，与 `DEEPSEEK_API_KEY` 同库）：

```yaml
FEISHU_APP_ID: cli_xxxxxxxx
FEISHU_APP_SECRET: xxxxxxxx
```

文件必须仅属主可读（dsh 强制校验，否则拒绝启动）：`chmod 600 $DSH_HOME/.credentials.yaml`。解析优先级：进程环境变量 > `.credentials.yaml` > `<cwd>/.env` > `$DSH_HOME/.env`（由 `dsh-credentials-local` 提供，热加载）。配置里只写引用名，明文密钥会被 schema 拒绝。凭据改动后重启 dsh 生效。

验证组合（不启动服务）：`DSH_HOME=$DSH_HOME pnpm dsh web --dump-config | grep dsh-channels`

启动成功标志（控制台）：`[dsh-channels] feishu long connection established, bot open_id: ou_xxx`

宿主 profile 已内置所需服务（agent-loop、llm-deepseek、session 持久化、storage-domain、workspace）；推荐确认 `dsh-token-meter` 已启用（卡片上下文占用显示）。

**工具与 agent preset（web profile）**：web profile 把 bash/fs/todo 等工具行全部标为 `disabled: true`，工具只存在于 agent preset 里，且 `agents.create()` 不会自动应用 preset——插件因此在创建/恢复会话时通过 `setup` 回调挂载 preset（默认 `standard`，可用 `agentPreset` 指定更精简的 preset，如只含 bash/fs 的自定义项），并把 preset id 记录进会话头。若机器人回复把 `<tool_calls>…` 当纯文本吐出，即该会话没挂上 preset；修好后再看会话的 `request/header` 应带 `tools` 字段、日志出现 `tool/call` 事件。无 preset roster 的部署（如 headless）不做此步骤，工具本就位于宿主层。

## 飞书侧准备

1. [飞书开放平台](https://open.feishu.cn/app) 创建**企业自建应用**，开启**机器人**能力。
2. 权限（至少）：
   - `im:message`（获取与发送单聊、群组消息）
   - `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息）
   - 事件：**接收消息 im.message.receive_v1**（含“接收群聊中 @ 机器人消息”）
   - `im:message.reactions:write_only`（发送、删除消息表情回复）
   - `im:message:update`（更新卡片）
3. 事件订阅方式选**长连接**（WebSocket，免公网）。
4. 发布版本并把用户加入可用范围；将机器人拉入测试群。

## 行为与降级

- **话题创建**：通过回复消息接口 `reply_in_thread: true`（官方文档明示的“以话题方式回复（即创建话题）”）。响应后经 `im.v1.message.get` 取回 `thread_id` 写入路由表。
- **话题延续**：`im.message.receive_v1` 事件自带 `thread_id`，命中路由表即 `agent.followup()`，无需 @。
- **降级（`threadFallback: 'degrade'`）**：私聊或群聊拒绝话题回复（如 230071）时，自动改为普通回复，路由键退化为 `chat:p2p:<chat_id>:<open_id>` / `chat:group:<chat_id>:<open_id>`（会话级延续）；`strict` 则直接失败。
- **重启恢复**：路由表持久化在 `storageDomain`；消息到达时 `ctx.agents.resume()` 懒恢复 session。若会话已被其他 owner 恢复为 live（如 Web UI 打开过该会话、并发冷恢复竞态），插件**借用**该 live agent 直接 `followup()`，不再报 "cannot prepare session … while it is live"。借用的 agent 不归插件 dispose；shutdown 与在途 resume 竞态时，刚发布的 agent 会被立即 dispose 以避免泄漏进下一实例的 live 注册表。
- **表情**：`Typing` 与 `DONE` 均为飞书**官方内置**表态表情（emoji_type 即 `"Typing"`/`"DONE"`），无需上传自定义表情。
- **限频**：卡片更新单条消息 5 QPS、应用级 1000 次/分钟；500ms（2 QPS）默认安全，`refreshMs` 下限 200ms；活动状态行的保活心跳默认 5s（`statusRefreshMs` 下限 1s），远低于限频。
- **卡片体积**：单卡片 JSON 目标 ≤ 28 KB（飞书上限 30 KB，留 2 KB 冗余）；正文超长自动分段为多张续卡（按段落/标题/代码块边界切分，每卡 ≤ 5 个表格，全文保留），推理内容按剩余预算截断（正文优先）。
- **续卡降级**：分段卡片发送被飞书拒绝（如表格数量超限 230099/11310）时，自动改发纯文本消息；卡片更新失败按指数退避重试，不刷屏报错。

## 已知取舍（v1）

- patch 为全量替换：流式期间用户手动展开折叠面板会被下一次刷新收起；流式结束后不再刷新，可自由展开。
- 超长正文拆成多张卡片（分段投放）：推理内容不跨卡片，始终留在首卡并按剩余预算截断。
- 子代理只显示状态（label / 当前工具 / 计时 / 并行计数），不显示其输出正文；后台子代理（`run_in_background`）在父 turn 结束后不再继续显示进度（卡片随父 turn 收尾）。
- 私聊 `reply_in_thread` 需真机验证（文档未明示限制，失败走降级路径，见上文）。
- 会话的 agent 常驻内存，不做空闲回收（重启后按需懒恢复）。

## 开发

```bash
pnpm install --store-dir ./.pnpm-store   # 受限环境；正常环境直接 pnpm install
pnpm typecheck
pnpm test
```

测试以 stub 替换官方 SDK 与 DSH 宿主服务，无需真实凭据。

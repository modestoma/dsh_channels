# dsh-channels · 真机联调手册

本文档指导你**手动安装** dsh-channels 插件到本机 dsh，配置飞书机器人，并逐项验证私聊/群聊/话题群三条通道的流式卡片体验。基础安装、连接与三通道流式体验均已在本机 dsh checkout（web profile）上实测通过；§5.4 中标注「待手测」的附件管线项尚需在真实环境确认（自动测试覆盖的项已单独注明）。

> 约定：下文用 `$HARNESS` 表示你的 deepseek-harness 仓库目录，`$PLUGIN` 表示本仓库目录（dsh_channels）。

## 0. 前置条件

- dsh 仓库可运行（`cd $HARNESS && pnpm dsh --help` 正常）
- 飞书企业账号 + 开发者后台访问权限
- 一个飞书测试群（用于群聊 / 话题群验证）

## 1. 飞书开放平台配置

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，创建**企业自建应用**，名称随意（如 dsh-channels）。
2. 进入应用 → **添加应用能力** → 开启 **机器人**。
3. **权限管理**，开通以下权限（发布版本时生效）：
   | 权限 | 用途 |
   |------|------|
   | `im:message`（获取与发送单聊、群组消息） | 收发消息、回复话题、下载消息内图片/文件资源（`messageResource.get`，具体 scope 以控制台该接口要求为准） |
   | `im:message:readonly`（读取单聊、群组消息内容） | 引用摘录、话题历史、`feishu_topic_messages` 的消息读取（message.get / mget / list），以及附件资源定位与合并转发子资源读取 |
   | `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息） | 私聊通道 |
   | `im:message.group_msg`（读取群组中所有消息，**敏感权限**） | 读取群/话题中机器人入群前或未 @ 机器人的历史消息；控制台要求时申请并由企业管理员审批，未开通时按“机器人可见范围”降级 |
   | `im:message.reactions:write_only`（发送、删除消息表情回复） | Typing / DONE / No 表态 |
   | `im:message:update`（更新消息卡片） | 流式卡片刷新（patch） |
   | `im:chat:readonly` 一类（获取群信息） | 入群通知卡展示群名/成员数（具体 scope 以控制台要求为准） |

   > 卡片更新接口本身支持 `im:message` 一项即可，但建议把 `im:message:update` 也加上，避免组合差异。
   >
   > **入站附件（v2）的权限**：图片/文件下载与合并转发容器子资源读取走消息资源接口，随消息收发/读取 scope（`im:message`，必要时 `im:message:readonly`；以控制台该接口的要求为准）。缺下载权限时不会静默丢文件：`feishu_attachment_fetch` 逐资源返回可读失败（如 `DOWNLOAD_FAILED` / 403 文案），archive 后端则加 `No` 表情并回一条纯文字失败提示。**native 主路径（默认）不新增附件专用权限**——下载仍走上面的消息资源 scope，存入 DSH 原生附件库后由宿主管理。
   >
   > **引用与话题历史（P2）的权限降级**：`feishu_topic_messages`、引用摘录、新会话首轮话题历史都依赖消息读取 scope。若权限未随版本发布或 `im:message.group_msg` 审批未通过，普通对话**不受影响**：引用/历史块静默省略，模型仍会正常回答；显式调用 `feishu_topic_messages` 时返回可读的 `PERMISSION_DENIED`（缺失 `im:message:readonly` 一类权限），不会报死错。被动引用/历史读取使用 **默认 3 秒**的短预算（`promptContextTimeoutMs`，不复用工具超时），首次降级会输出一条 **warn** 级日志（含原因与 scope 提示，之后同类降级仅 debug 级；`/status` 不报告读取 scope 状态）。控制台若提示“读取群消息需要敏感权限”，先申请并审批 `im:message.group_msg` 后再验证入群前历史。
4. **事件与回调** → 事件订阅方式选择 **使用长连接接收事件**（WebSocket，免公网 IP）。
   - 添加事件：**接收消息 im.message.receive_v1**（勾选“接收群聊中 @ 机器人消息”）。
   - 添加事件：**机器人进群 im.chat.member.bot.added_v1**（机器人被拉进群后私聊管理员发群信息卡；未订阅时退化为“群里第一次未授权 @ 时补发”）。
   - 添加回调：**卡片回传交互 card.action.trigger**（HITL 审批、授权卡的按钮回传，同样走长连接）。
5. **凭证与基础信息** 页复制 `App ID` 与 `App Secret`。
6. **版本管理与发布** → 创建版本（权限与事件配置随版本生效）→ 发布。
7. **可用范围**：把自己（和测试同事）加入可用范围。
8. 建一个测试群，把机器人拉进群；如需验证话题群，另建一个“话题群”（创建群时选话题模式），同样拉入机器人。

## 2. 安装插件到 dsh

dsh 的插件装在 **profile** 里（`$DSH_HOME/profiles/<name>/`，`$DSH_HOME` 未设置时默认 `~/.dsh`）。web 界面使用 `web` profile，首次启动自动初始化。安装命令把 pnpm 转发到 profile 目录执行：

安装已发布的 npm 版本（推荐）：

```bash
cd $HARNESS
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add @modesto_ma/dsh-channels
```

本地 checkout 开发时：

```bash
cd $HARNESS
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add "link:$PLUGIN"
```

说明：

- npm 安装直接使用包内已构建的 `lib/index.js` 与 `lib/client.js`；`link:` 则把本地插件 checkout 链接进 profile，安装前需在插件仓库执行 `pnpm build`。
- 本包声明了 `dsh.bundle`；安装成功后，`dsh plugin` 会自动把 `@modesto_ma/dsh-channels` 加入 profile 的 bundle 列表，并由包内 `cordis.patch.yml` 提供稳定 `id: dsh-channels` 的 Loader 行。
- pnpm 可能输出 `[WARN] Issues with peer dependencies`（`@deepseek-ai/cordis` 由 dsh 统一提供，属预期）与 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: protobufjs`——**安装实际已成功**，`dsh plugin` 的非零退出码可忽略；想消除告警可在 profile 目录的 `pnpm-workspace.yaml` 加 `onlyBuiltDependencies: [protobufjs]`。
- **改了插件代码后**：运行检查并重启 dsh 即可，不必重复安装；只有 `package.json`、bundle patch 或依赖关系发生变化时才重新执行 `add`。

验证安装与组合（不启动服务）：

```bash
cd $HARNESS
DSH_HOME=$DSH_HOME pnpm dsh web --dump-config | grep -A 9 "dsh-channels"
# 安装完成后即应看到包内 bundle 提供的 Loader 行
```

## 3. 配置插件

### 3.1 凭据写入 dsh 凭据库

插件配置里只填**凭据引用名**，密钥本身放在 dsh 的受管凭据库 `$DSH_HOME/.credentials.yaml`（与 `DEEPSEEK_API_KEY` 同一文件，热加载，`DEEPSEEK_API_KEY` 就在里面）：

```yaml
# $DSH_HOME/.credentials.yaml
FEISHU_APP_ID: cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**权限必须是 600**（dsh 会强制校验，文件可被他人读取时直接拒绝启动）：

```bash
chmod 600 $DSH_HOME/.credentials.yaml
```

解析优先级（由 `dsh-credentials-local` 提供，热加载）：进程环境变量 > `.credentials.yaml` > 启动目录 `.env` > `$DSH_HOME/.env`。不想用凭据库时，直接导出环境变量也能生效。凭据改动后不必重启 dsh：面板保存会即时写入并自动连接/提示重连；手改 `.credentials.yaml` 由凭据层热加载，但运行中的连接不会自动换用新值，需在面板点「重启飞书连接」。

**连接时机**：启用插件时不会无条件连接飞书。插件加载后先检查 `appId` / `appSecret` 两个凭据引用是否都能解析：都就绪才建立长连接；缺任意一项时插件照常加载（设置面板可用），状态为「待配置」且不连接；连接失败只记录在面板里，插件入口保持加载。因此可以「先装插件 → 在面板里填凭据 → 自动连接」，也可以在装插件前就把凭据写进凭据库。

### 3.2 写补丁层

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`。包内 bundle 已插入 Loader 行，这里仅按稳定 id 覆盖该实例的完整配置：

```yaml
# 用户补丁层：只配置 bundle 已提供的 dsh-channels 行
- id: dsh-channels
  config:
    appId: 'FEISHU_APP_ID'              # 凭据引用名（密钥在 .credentials.yaml）
    appSecret: 'FEISHU_APP_SECRET'
    baseDir: './channels-data'          # 工作区根目录（相对路径按 dsh 进程 cwd 解析；可在 Web 面板覆盖为绝对路径）
    provider: 'deepseek-official'       # 可选，省略用部署默认
    model: 'deepseek-v4-flash'          # 可选
    reasoningEffort: 'high'             # 可选，精确模型声明的档位 id
    refreshMs: 500                      # 卡片刷新间隔（下限 200ms）
    requireMention: true                # 普通群需 @ 机器人
    dmMode: 'open'                      # 私聊通道开关
    threadFallback: 'degrade'           # 话题被拒时降级为会话级路由
    topicIsolation: 'auto'              # 话题目录隔离：auto（Git 仓库用 worktree，否则子目录）/ subdir / worktree
    acceptAttachments: true             # 接收飞书附件：native 下图片预取、文件懒取、纯附件静默不回复
    attachmentStore: 'native'           # 入站附件后端：native（DSH 原生附件库）/ archive（旧版工作区 attachments/）
    prefetchImages: true                # 触发消息图片预取为首轮 ImageBlock
    prefetchImageMaxBytes: 20971520     # 单张预取图片上限（20 MiB）
    prefetchTotalMaxBytes: 52428800     # 单次预取总字节预算（50 MiB）
    prefetchTimeoutMs: 10000            # 图片预取整段超时（10 s）
    historyBootstrapLimit: 10           # 新会话首轮话题历史条数（0 关闭，上限 20）
    promptContextTimeoutMs: 3000        # 被动引用/历史读取预算（3 s）
    feishuTools:                        # 模型工具（Web 面板按子键合并，不写空未改子键）
      attachmentFetch: true             # feishu_attachment_fetch：按需懒取已知消息的图片/文件
      attachmentFetchMaxResources: 10   # 单次最多取回资源数（1–50）
      attachmentFetchMaxBytes: 104857600 # 单次总字节预算（100 MiB）
      attachmentFetchTimeoutMs: 120000  # 单次调用整段超时（120 s）
      topicMessages: true               # feishu_topic_messages：读取引用/话题历史并授权附件
      topicMessagesTimeoutMs: 20000     # 单次话题读取整段超时（20 s）
    approvalTimeoutMs: 300000           # HITL 审批决策卡等待时长（默认 5 分钟）
    accessMode: 'guarded'               # 准入模式：guarded（默认）| open（旧行为，不安全）
    adminOpenId: 'ou_xxx'               # 管理员 open_id（可留空，留空时 guarded 下拒绝一切对话）
    authRequestTtlDays: 7               # 入群/用户授权申请卡有效期（天）
    loggerLevel: 'info'
```

从旧版配置迁移时，删除原来的 `insert` / `id: channels` 条目；不要同时保留旧行和 `id: dsh-channels`，否则同一机器人会建立两个长连接并重复处理消息。

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `appId` / `appSecret` | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 凭据引用名（shell 标识符），经 `ctx.credentials` 解析；仅当凭据库使用其它变量名时才需要覆盖。明文密钥会被拒绝 |
| `baseDir` | `./channels-data` | 工作区目录树根：每个用户一个工作区（私聊 `p2p/<open_id>/`，群聊 `groups/<chat_id>/<open_id>/`），每个话题的工作目录为 `<工作区>/topics/<话题>/`（模型/工具产生文件的落点）；Web 面板可覆盖，只接受绝对路径，`~` 展开，保存时创建并校验目录，只影响之后新建的会话 |
| `provider` / `model` | 部署默认 | 新建 session 的路由；省略时继承部署默认 |
| `reasoningEffort` | 适配器/provider 默认 | Session 初始/重置推理档位；可在话题内用 `/effort` 覆盖 |
| `maxTokens` | 适配器默认 | 每次模型请求输出上限 |
| `refreshMs` | `500` | 流式卡片刷新频率（200–10000） |
| `dmMode` | `open` | 私聊开关 |
| `requireMention` | `true` | 普通群是否需要 @ 机器人（话题内续聊不受影响） |
| `threadFallback` | `degrade` | 话题回复被拒时：`degrade` 降级为会话级延续 / `strict` 直接失败 |
| `topicIsolation` | `auto` | 话题工作目录形式：`auto`（工作区含 `.git` 时用 Git worktree，否则普通子目录）/ `subdir` / `worktree`（失败回退子目录） |
| `approvalTimeoutMs` | `300000` | HITL 审批决策卡等待时长（10s–1h）；超时自动拒绝 |
| `accessMode` | `guarded` | 准入模式：`guarded` 仅管理员+白名单；`open` 保留旧行为（任何可用范围用户可对话，不安全） |
| `adminOpenId` | 未设置 | 唯一管理员 open_id（`ou_` 开头）；留空 + guarded = 拒绝一切对话（`/userid` 引导仍可用）。面板可改 |
| `authRequestTtlDays` | `7` | 入群/用户授权申请卡有效期（1–30 天） |
| `acceptAttachments` | `true` | 接收飞书图片/文件/合并转发记录。native 下触发消息图片预取、文件懒取、纯附件静默不回复（引用该消息再提问时列入清单）；`false` 时附件消息完全惰性（不保存、不触发、不列入清单） |
| `attachmentStore` | `native` | 入站附件后端：`native`（DSH 原生附件库，默认；不可变、内容寻址去重、随 Session 回放、不自动清理）/ `archive`（旧版下载到话题工作区 `attachments/`，会阻塞会话建立） |
| `prefetchImages` | `true` | native 下把触发消息图片预取为首轮 `ImageBlock`；失败/超限/超时降级为清单懒取项。关闭后图片也需 `feishu_attachment_fetch` |
| `prefetchImageMaxBytes` | `20971520` | 单张预取图片字节上限（20 MiB，1 B–200 MiB） |
| `prefetchTotalMaxBytes` | `52428800` | 一次触发消息预取的总字节预算（50 MiB，1 B–1 GiB）；用尽后剩余图片降级清单 |
| `prefetchTimeoutMs` | `10000` | 图片预取整段超时（100–120000 ms）；到期保留已取回图片、其余降级清单。注意配置键是 `prefetchTimeoutMs`（早期 Issue 草稿写作 `prefetchImageTimeoutMs`） |
| `historyBootstrapLimit` | `10` | 新会话首轮自动附带本话题最近 N 条消息摘要（0 关闭，上限 20；失败静默降级）；更早的消息用 `feishu_topic_messages` 翻页 |
| `promptContextTimeoutMs` | `3000` | 被动引用/首轮历史读取的整段预算（100–10000 ms）；超时即省略对应块、回合照跑。模型主动调用工具的读取超时另由 `feishuTools.topicMessagesTimeoutMs` 控制 |
| `feishuTools.attachmentFetch` | `true` | 是否挂载 `feishu_attachment_fetch`；关闭后文件无法懒取，插件**整体回退 archive 后端** |
| `feishuTools.attachmentFetchMaxResources` | `10` | 单次工具调用最多取回的附件数（1–50）；超出返回可读原因，可按 `file_key` 拆分重试 |
| `feishuTools.attachmentFetchMaxBytes` | `104857600` | 单次工具调用的总下载字节预算（100 MiB，1 B–1 GiB）；文件流式写入、不整文件缓冲 |
| `feishuTools.attachmentFetchTimeoutMs` | `120000` | 单次 `feishu_attachment_fetch` 整段超时（1000–600000 ms）；到期取消并逐项报告 |
| `feishuTools.topicMessages` | `true` | 是否挂载 `feishu_topic_messages`；只影响模型工具，被动引用/历史摘录仍生效 |
| `feishuTools.topicMessagesTimeoutMs` | `20000` | 单次 `feishu_topic_messages` 整段超时（1000–120000 ms） |
| `loggerLevel` | `info` | 官方 SDK 日志级别 |

> **面板与配置位置**：v2 附件配置已加入 Web 面板「设置 → 飞书渠道 → 会话与行为」：`acceptAttachments` / `attachmentStore` / `prefetch*` / `historyBootstrapLimit` 在「内容与附件」组，`feishuTools.*` 与 `promptContextTimeoutMs` 在「模型工具」组；保存写入同一 Web 覆盖文件，`feishuTools.*` 按子键合并（不会把未修改子键写空）。直接写 profile 补丁层同样生效，面板覆盖优先。其中 `feishuTools.topicMessages=false` 只关闭模型工具，被动的引用/历史 prompt 摘录仍生效；要完全关闭首轮历史请设 `historyBootstrapLimit: 0`。archive 后端下 `feishu_attachment_fetch` 不挂载，`feishu_topic_messages` 仍可读取历史文本，但工具描述会提示附件不可取。

### 3.3 初始化管理员与授权（默认准入）

插件默认 `accessMode: 'guarded'`：**没有配置管理员时，所有对话都会被拒绝**（这是 fail-closed 的安全默认值）。初始化顺序：

1. 启动 dsh 后在飞书**私聊机器人**发送 `/userid`（未配置管理员时任何私聊用户都可以用，只回固定文本，不建会话）→ 复制返回的 `ou_...`；
2. 打开 Web **设置 → 飞书渠道 → 访问授权**，把 `ou_...` 填进「管理员 open_id」并保存（立即生效）；也可以直接写 profile 的 `adminOpenId`；
3. 现在管理员私聊机器人即可正常对话。**其他用户私聊会收到一条固定提示**（“非管理员禁用私聊功能哦…”），不会建会话；
4. **给群授权**（三种入口任选；目的是放行**非管理员**，管理员本人在任何群都能直接对话）：
   - 机器人被拉进群 → 管理员私聊收到**群信息卡**（群名/`chat_id`/成员数/邀请人）→ 点「授权本群」；
   - 管理员在群里发 `/auth allow` → 回执「已授权本群」；`/auth revoke` 撤销；
   - Web 面板「访问与授权 → 已授权群」手动添加 `chat_id`（可用 `/groupid` 查看）；
5. **给用户授权**（三种入口任选）：
   - 已授权群里未授权用户 @ 机器人 → 管理员收到**用户授权申请卡**（含昵称/open_id）→ 点「授权用户」；
   - 管理员发 `/auth user add ou_xxx`；`/auth user remove ou_xxx` 撤销；
   - Web 面板「访问与授权 → 已授权用户」手动添加 open_id（用户可用 `/userid` 查看）；
6. 授权/撤销**立即生效**；白名单与待处理申请持久化在插件 `channels_routes` 域，重启不丢。`/auth list` 可随时查看白名单与待处理申请。

> 说明：**管理员不受白名单限制**——机器人被拉进新群后，管理员可以直接 @ 机器人开会话，不需要先授权该群；授权群/用户只影响**非管理员**。管理员在任意群里都可以使用 `/auth`、`/groupid` 等命令。

验证组合无误：

```bash
cd $HARNESS
DSH_HOME=$DSH_HOME pnpm dsh web --dump-config | grep -B 1 -A 10 "name: dsh-channels"
```

## 4. 启动与日志判读

```bash
cd $HARNESS
DSH_HOME=$DSH_HOME pnpm dsh web        # 默认 http://127.0.0.1:3080
```

**连接成功**（终端会打出）：

```
[dsh-channels] feishu long connection established, bot open_id: ou_xxxxxxxx
[dsh-channels] HITL 审批应答已就绪（决策卡片超时 300000 ms）
[dsh-channels] 准入=guarded，管理员已配置
```

> 准入相关控制台输出：`准入=open`（不安全，仅调试）、`准入=guarded，管理员已配置`、`准入=guarded 但未配置管理员 open_id：所有对话都会被拒绝…`（此时按 §3.3 配置管理员即可）。

> 第二行只在宿主挂载了 `approval` 服务时出现；若显示 `主机未挂载 approval 服务，HITL 审批应答关闭`，说明该部署未启用 HITL（`approval/request` 事件永远不会派发），并非插件故障。

**附件管线启动告警**（只影响附件，不影响对话）：

| 日志 | 含义 |
|------|------|
| `attachmentStore=native 但宿主未挂载 ctx.attachments，入站附件回退话题 attachments/ 工作区落盘` | 宿主没有 DSH 原生附件库：入站附件按旧 archive 行为处理；如需 native 请确认 web profile 启用 `dsh-attachment-local` |
| `feishu_attachment_fetch 未挂载：宿主 tools/attachments 服务不可用（会话继续）` | 缺 `tools` 或 `attachments` 服务：该工具不注册，会话照常建立 |
| `feishu_topic_messages 未挂载：宿主 tools 服务不可用（会话继续）` | 缺 `tools` 服务：话题读取工具不注册 |
| `adopted N legacy staged attachment(s) into …; the one-time _staging migration is deprecated and will be removed after one release cycle` | 旧版 `_staging` 遗留文件被一次性迁入话题目录；按 D12，该兼容路径在 v2 发布后的下一个 minor 版本移除，可据此清理旧数据 |

**未配置凭据（不是启动失败）**：日志会提示 `飞书应用凭据未配置完整（缺少 FEISHU_APP_…）`，插件照常加载但**不连接**；打开 Web **设置 → 飞书渠道 → 连接**，按三步引导填写 App ID / App Secret 并保存后自动连接。

**常见连接失败**（插件保持加载，面板「连接」标签页显示原因，可重试）：

| 输出 | 原因 |
|------|------|
| `could not resolve bot identity via /open-apis/bot/v3/info` | App ID/Secret 错误，或未开启机器人能力 |
| `permission_denied` / `invalid tenant access token` | 同上，先核对凭证再查权限 |
| `credential "FEISHU_APP_ID" is not configured` | 连接时解析不到凭据（例如刚手改了凭据库但面板状态尚未刷新，或环境变量缺失），见 §3.1；面板保存后会自动重连 |
| `is readable beyond its owner (mode 644)` | `.credentials.yaml` 权限过宽，`chmod 600` 后重启 |
| `dsh: plugin tree failed to load … dsh-channels` | 插件本身加载失败（多为 `name:` 拼写或未安装），看后续 cause |
| 无任何 `dsh-channels` 输出 | 插件未装载：检查 `--dump-config` 是否含条目、补丁层是否用了 `insert:` 格式 |

> 说明：插件内部其余日志走 dsh 的 cordis logger，web 组合下部分早期日志可能只进缓冲不落终端；**生命周期日志**（连接成功 / 连接失败 / 凭据未配置）额外直接输出到控制台，联调时以它们为准。

## 5. 三通道联调清单

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 1 | 私聊 | 给机器人发一条消息 | 消息下立刻出现 **Typing** 表情 → 以话题形式回复卡片（**推理中** 折叠面板；无推理内容的回合结算后面板省略）→ 正文流式输出（500ms 刷新，面板变 **回复中**）→ 成功变 **回复结束**、Typing 变 **DONE**；**完成后主卡底部出现分割线与两行元数据**（第一行：模型/会话/推理时长；第二行：上下文占比/输入输出 token/缓存命中），首帧与流式中没有这两行 |
| 1a | 错误推理强度 | 配置该模型不支持的 `reasoningEffort` 后发消息 | 卡片进入 **回复失败** 终态（有推理内容时面板标题为「回复失败」，否则不渲染面板），正文显示 Harness 返回的错误消息和错误码（如 `UNSUPPORTED_REASONING_EFFORT`），Typing 变 **No**；模型/推理强度/缓存不沿用上一轮 |
| 1b | Session 推理强度切换 | 话题内依次执行 `/effort`、`/effort tiny`、发普通消息、重启后续聊、`/effort reset` | 首次显示配置来源；切换后下一轮请求使用 `tiny`，重启恢复后仍保持；reset 后恢复配置值。若模型不支持 `tiny`，下一轮按 1a 失败，不会静默回退 |
| 2 | 私聊续聊 | 在刚建的话题里直接再发消息（**不 @**） | 继续同一 session：完成后主卡结算页脚第一行的 session id 不变，input/output token 累计增长 |
| 3 | 群聊 @ | 在普通群 @ 机器人发消息 | 同 #1；该消息成为新话题根 |
| 4 | 群聊话题内 | 在上一步的话题里直接发消息（不 @） | 延续该 session，不再要求 @ |
| 5 | 同群第二个用户 | 换另一个人 @ 机器人 | 新话题 + 新 session；dsh 工作区列表中出现**该用户的独立工作区**（`groups/<chat_id>/<用户 open_id>/`），会话实际工作在它自己的 `topics/<话题>/` 下，与原用户的话题目录互不可见 |
| 6 | 话题群 | 在话题群某话题中 @ 机器人 | 机器人直接在该话题内回复卡片（不新建话题） |
| 7 | 折叠面板 | 点面板标题 | 展开推理内容，右侧箭头翻转向上；再点收起 |
| 8 | 重启恢复 | 重启 dsh 后在旧话题里发消息 | 机器人懒恢复原 session，token 统计继续累计 |
| 9 | 降级路径 | 在关闭话题功能的群里 @ 机器人 | 正常回复（普通回复气泡），后续 @ 延续同一 session |
| 10 | HITL 审批 | 让模型执行需要审批的动作（如提示沙箱升级：`bash` 被沙箱拒绝后带 `sandbox_permissions` 重试） | 同一话题内出现独立的「⚠️ 需要你的审批」卡片（✅ 允许 / ❌ 拒绝）；点允许后卡片变「✅ 已允许执行」且动作继续，点拒绝变「❌ 已拒绝」；不点则到时（默认 5 分钟）变「⏱ 已超时未处理，自动拒绝」 |
| 11 | 管理员初始化（准入） | 未配置 `adminOpenId` 时私聊 `/userid`，把 open_id 填入面板保存 | 未配置时 `/userid` 也只回固定文本、不建会话；保存后面板显示管理员已配置，管理员私聊正常对话 |
| 12 | 非管理员私聊 | 用另一个飞书账号私聊机器人 | 只收到一条固定提示（“非管理员禁用私聊功能哦…”）；不建话题/会话、不产生模型调用；该账号发 `/userid` 仍可拿到自己的 ID |
| 13 | 入群通知 | 把机器人拉进一个新群 | 管理员私聊收到群信息卡（群名/`chat_id`/成员数/邀请人），未授权群带「授权本群 / 忽略」按钮；群里没有任何机器人消息 |
| 14 | 管理员直通（免群授权） | 刚被拉进未授权群时，管理员直接 @ 机器人发消息 | 正常开会话（管理员不受白名单限制）；不授权该群也不影响管理员使用 |
| 14a | 群授权与群内准入 | 管理员点「授权本群」（或在群内发 `/auth allow`）；未授权用户 @；管理员 `/auth user add <open_id>` 后该用户再 @ | 授权前非管理员 @ 无响应（管理员除外）；授权后白名单用户可分别开会话；未授权用户 @ 不建会话且管理员收到用户授权卡；授权该用户后可正常开会话 |
| 15 | 撤销与持久化 | `/auth revoke`（群内）/ `/auth user remove <open_id>`；重启 dsh 后再试 | 撤销后对应主体立即无法开启对话；重启后已授权群/用户仍有效（持久化） |
| 16 | 话题越权防护 | 授权群里用户 A 创建话题后，用户 B 在 A 的话题里发普通消息/附件/回答提问 | B 的消息被静默丢弃，不会进入 A 的 Session、不会写入 A 的话题目录；A 自己发言正常 |

### 5.0 HITL 审批验证点（重点）

1. **卡片形态**：审批卡是流式卡之外**新发的独立消息**，锚定在最新流式卡下、同一话题内；流式卡本身不带按钮。
2. **按钮回传**：待审批时允许/拒绝按钮在同一行等宽排列；点击后卡片立即更新为终态并移除两个按钮。若点击无反应，先核对 §1 第 4 步是否已订阅 **card.action.trigger** 回调并**重新发布版本**（回调订阅随版本生效）。
3. **归属校验**：群里非发起人点击审批卡：卡片出现「ℹ️ 仅发起该会话的用户可操作此卡片」提示，动作不生效。
4. **超时**：`approvalTimeoutMs` 内不点 → 卡片变「已超时」，动作被自动拒绝（fail-closed），模型收到拒绝结果后会换路径继续。
5. **多会话并行**：不同话题的审批互不串扰（每张卡只结算自己的问题）。

### 5.1 私聊话题验证点（重点）

飞书官方文档没有明示 `reply_in_thread` 对**私聊**的约束。联调时在私聊里观察第 1 步：消息是否真的聚合成“话题”形态（话题气泡）。若飞书拒绝话题回复，插件按 `threadFallback: 'degrade'` 自动改为普通回复，此时私聊内所有消息延续同一个 session（等价于“私聊整体即话题”），功能不受阻。若你希望私聊必须话题形态，把 `threadFallback` 设为 `strict` 并反馈错误码。

### 5.2 验证工作区与话题目录

打开 dsh Web GUI → 工作区列表，应看到**每人一个**项目：

```
飞书私聊 · ou_xxx          （对应 <baseDir>/p2p/ou_xxx/）
飞书群聊 · oc_yyy · ou_xxx （对应 <baseDir>/groups/oc_yyy/ou_xxx/）
```

每个新话题在该工作区内创建独立的话题工作目录 `<工作区>/topics/<话题 id>/`，会话列表仍归属该项目；同一话题内 `/renew` 复用同一话题目录。也可在飞书里用 `/workspace` 查看当前会话的实际工作目录。

**附件落点（v2）**：默认 `attachmentStore: 'native'` 下入站图片/文件存入 **DSH 原生附件库**（`$DSH_HOME/attachments/v1` 一类宿主目录，由宿主管理），**话题目录下不会出现 `attachments/`**；只有显式 archive 后端或宿主缺原生附件库时才会看到 `<工作区>/topics/<话题>/attachments/`。v2 主路径也不再写 `<baseDir>/_staging/`：该目录只保留旧版遗留文件的一次性迁入（成功时一条 warn），按 D12 在 v2 发布后的下一个 minor 版本移除。插件不会自动删除工作区或话题目录。

### 5.3 引用与话题历史（P2）验证点

需要真机操作；自动测试已覆盖 prompt 组装与工具行为，但飞书侧权限/历史范围仍需人工确认。

1. **引用文字**：在私聊或已绑定话题内，长按一条更早的机器人/用户消息 → 回复（飞书会自动 @ 被回复消息的发送方）→ 发送“解释一下上面这条”。预期：卡片正常开始；模型能复述被引用消息的内容（引用摘录已进 prompt），而不是回答“看不到引用”。
2. **引用文件/图片**：先发一条带文件（或图片）的消息，再引用它问“这个文件里是什么”。预期：引用消息的附件会出现在 `<feishu_context>` 清单（`message_id` / `file_key` 为被引用消息），模型用 `feishu_attachment_fetch` 取回后回答；若模型未调用工具，可要求它“用 feishu_attachment_fetch 取一下清单里被引用那条消息的附件”。
3. **引用合并转发**：把几条消息合并转发到聊天里，然后引用该合并转发问“总结一下转发内容”。预期：prompt 中出现被引用的转发文本，且容器 `message_id` 同时出现在引用块与清单；模型需要子资源时用**顶层容器 message_id** 调用 `feishu_attachment_fetch` 成功（子消息 id 会 400，属预期）。
4. **话题历史 / @ 之前**：在已有讨论的话题群里，先让其他成员（或自己）在话题内发几条消息，再 @ 机器人提问。预期：新会话首轮 prompt 含最近的 `<feishu_history>` 摘要（默认最近 10 条，每行带 `message_id`，附件可按该 id 懒取）；更早的消息用 `feishu_topic_messages` 翻页查看。若缺 `im:message.group_msg` 等权限，历史块会静默省略但普通对话不受影响——首次降级有一条 warn 日志（含义见 §1 权限说明），按 §1 申请权限后重新发布版本。
5. **入群前历史**：机器人入群前该群已有消息时，重复第 4 步；若能看到入群前的消息，说明当前应用权限覆盖了机器人可见范围，否则按“机器人可见范围”降级（文档已注明，不保证入群前历史）。
6. **关闭首轮历史**：把 `historyBootstrapLimit` 设为 `0` 并重载插件，新建会话确认首轮不再附带 `<feishu_history>`；`feishu_topic_messages` 仍可显式读取。

### 5.4 附件管线 v2（P3）真机验证清单

> 自动测试已覆盖以下行为（见 [docs/attachment-pipeline-v2.md](attachment-pipeline-v2.md) §12.1），但**插件链路与飞书权限/历史范围仍需真机确认**。表中「状态」一列区分：**已真机** = 对应 Issue 已记录的真实设备结果；**待手测** = 尚无插件链路真机记录（自动测试覆盖）；**API 已验** = 同应用 bot 身份只读 API 探针已验，但插件端到端待手测。执行后把结论写回 `.agents/roadmaps/attachment_pipeline_v2/acceptance.md`，未通过项如实记录，不要用 mock 结果冒充。

**准备**：`pnpm build` 后用新构建启动（或 HMR 重载插件）；准备好 p2p、普通群、话题群各一个，聊天里发一个 ≥100 MB 的大文件附件（飞书允许范围内）；确认 `attachmentStore: 'native'`、`feishuTools.attachmentFetch/topicMessages` 为默认开启。

| # | 场景 | 操作 | 预期 | 状态 |
| --- | --- | --- | --- | --- |
| A1 | 私聊·文本 | 私聊发送一条普通文字 | Typing → 卡片**立即**出现并流式回复；会话/话题正常建立 | ✅ 已真机（P1/P2） |
| A2 | 私聊·图片 | 发一张截图 + “这是什么” | 卡片先出现；首轮含 `ImageBlock`，模型不调用 fetch 即可描述（可能另用 `read_image`）；首轮清单不列该已预取图片；原生库对象数 +1、话题目录无 `attachments/` | ✅ 已真机（P1 步骤 2） |
| A3 | 私聊·文件懒取 | 发 “看下这个文件” + 一个文件（如 48 MB zip） | 卡片先出现；首轮只有清单行（`message_id/file_key/name`），**下载发生在回合开始之后**；模型调 `feishu_attachment_fetch` 后结果为 `[text, file]` + 只读路径；文件字节进原生库、话题目录无 `attachments/`、无 `_staging` | ✅ 已真机（P1 步骤 3） |
| A4 | 私聊·纯附件静默 | 只发一张图片（不带文字），然后再发一条文件（不带文字） | 无回复、无表情、无新话题/会话、无下载；本地不写记录，原生库对象数与工作区文件不变 | ✅ 已真机（P1 步骤 1 图片；P2 步骤 3a 文件） |
| A5 | 私聊·静默引用 | 在 A4 之后引用刚才的文件消息发文字：“这个文件叫什么/内容是什么” | 清单列出被引用的文件；模型 fetch 取回后正确回答。不引用直接问时清单里没有该文件（预期） | ⏳ 待手测（2026-10-21 改为只靠引用，需重测） |
| A6 | 私聊·引用文件 | 引用一条带文件的消息，问文件内容 | prompt 出现 `<feishu_quote>`（含 message_id），清单出现 quote 行；模型 fetch 成功 | ✅ 已真机（P2 步骤 3c） |
| A7 | 私聊·引用合并转发 | 合并转发两条消息（含一个文件），引用它问“总结/取其中文件” | quote 块展开子消息并标“合并转发，共 N 条”；清单为容器行；fetch 用**顶层容器 message_id** 成功（子消息 id 会 400，属预期） | ✅ 已真机（P2 步骤 4） |
| A8 | 私聊·大文件 | 发 ≥100 MB（如有 1 GB 级更好）文件 + “看下这个文件” | 卡片立即出现、不等待；清单先列文件；模型调 fetch 后流式入库，超过 `attachmentFetchTimeoutMs` 时返回可读超时，不阻塞后续对话 | ⏳ 待手测（P0 已验 980 MB 下载/取消，admission 链路未验；自动测试覆盖超时/取消） |
| A9 | 私聊·下载失败 | 引用/登记一条已被撤回或过期（资源不可用）的附件消息，让模型 fetch | 工具逐资源返回可读失败（如 `DOWNLOAD_FAILED` / 资源过期说明），不出现 `[object Object]`，回合正常结束 | ⏳ 待手测（自动测试覆盖失败路径） |
| B1 | 对话群·@ 触发 | 普通群 @ 机器人发图片 + 文字 | 新话题 + 卡片；图片预取进首轮；话题内后续无 @ 消息续聊同一 Session | ✅ 已真机（P1 步骤 5） |
| B2 | 对话群·未 @ 附件 | 同一群内不 @ 只发一张图片 / 只发一个文件，随后 @ 机器人问“我刚才发的文件” | 未 @ 时完全静默（无回复/表情/会话/下载），群 scope pending 新增行；随后 @ 建话题的首轮清单可列出并懒取该文件 | ✅ 已真机（P1 步骤 6 群未 @ 图片静默）；⏳ 文件与跨 scope 引用部分待手测（自动测试覆盖） |
| B3 | 对话群·引用文件 | @ 机器人并引用群里的一条文件消息 | quote 摘录 + 清单 quote 行 + fetch 成功（权限范围内） | ⏳ 待手测（私聊同源已真机；自动测试覆盖） |
| C1 | 话题群·@ 图片/文件 | 在话题群的话题内 @ 机器人发图片 + 文件 | 在该话题内回复卡片（不新建话题）；图片进首轮/文件进清单 | ⏳ 待手测（普通群 @ 建话题与话题群历史已真机；话题群图片/文件组合自动测试覆盖） |
| C2 | 话题群·纯附件静默 | 已绑定话题内不 @ 只发文件 | 完全静默；thread scope 登记；该话题后续触发消息的清单可列出 | ⏳ 待手测（群未 @ 静默已真机；话题内纯附件由自动测试覆盖，未单独真机） |
| C3 | 话题群·历史 | 话题内先发 A/B/C（不 @），再 @ 机器人提问 | 新 Session 首轮含 `<feishu_history>` A/B/C（带 message_id）；`feishu_topic_messages` 可翻页，续聊轮不重复注入历史；工具渲染含 `- 下一页 cursor:` | ✅ 已真机（P2 步骤 5/6R） |
| C4 | 话题群·入群前历史 | 选择一个入群前就有消息的群，重复 C3 | 能看到机器人可见范围内早于入群的消息；看不到时属权限/可见范围限制，历史块静默省略（不报错） | ⏳ 待手测（API 探针显示可见早约 1 个月历史，但“入群时间”不可查询、不同租户可能不同） |
| D1 | archive 降级 | 面板把存储后端改为 `archive`（或临时把 `feishuTools.attachmentFetch` 设为 `false`），发图片/文件 | 旧行为：图片/文件下载到话题 `attachments/`（或 `_staging/` 后迁入），纯附件消息加 `DONE` 表情、不触发模型；不挂 fetch 工具；清单不出现 | ✅ 已真机（P1 步骤 7 显式 archive）；⏳ `attachmentFetch=false` 组合待手测（自动测试覆盖） |
| D2 | 缺原生附件库 | 在无 `ctx.attachments` 的部署（如 headless/旧宿主）启动并发附件 | 自动回退 archive 旧行为；日志一条 warn：`attachmentStore=native 但宿主未挂载 ctx.attachments…`；不崩溃 | ⏳ 待手测（自动测试覆盖） |
| D3 | 关闭预取 | 面板关闭 `prefetchImages` 后重启/重载，新会话发图片 + 文字 | 快速出现卡片，首轮**无** ImageBlock；图片出现在清单，模型用 `feishu_attachment_fetch` 取回后回答 | ⏳ 待手测（自动测试覆盖） |
| D4 | 关闭附件接收 | 面板关闭 `acceptAttachments` 后发纯附件 / 文件+文字 | 纯附件：无回复/无登记/无下载；文件+文字：只以文字触发，附件不保存不登记 | ⏳ 待手测（自动测试覆盖） |
| E1 | 权限缺失·读取 | 临时移除 `im:message:readonly`（或让 `im:message.group_msg` 未审批）后发布版本，发引用消息/在群内 @ | 普通对话正常；引用/历史块静默省略；首次降级一条 warn；显式 `feishu_topic_messages` 返回可读 `PERMISSION_DENIED`；恢复权限并重发版本后恢复 | ⏳ 待手测（用户已决定跳过；自动测试覆盖 throw/resolved 两种降级） |
| E2 | 权限缺失·下载 | 临时移除消息资源读取相关 scope，让模型 fetch 一个文件 | 工具逐资源返回可读失败（403/权限说明），回合不崩；archive 下则加 `No` 并回纯文字失败提示 | ⏳ 待手测（自动测试覆盖） |
| F1 | 面板配置 | 在 Web 「会话与行为」依次修改存储后端、预取开关/上限、登记 TTL/容量、两个工具开关与上限并保存，新建会话验证生效 | 面板读写与帮助文案正确；嵌套 `feishuTools.*` 只改被改子键；旧值不丢；保存后入站行为即时按新配置判定、工具挂载对新会话生效；非法值被拒 | ⏳ 待手测 + 自动测试（settings 覆盖） |

**记录要求**：每个「待手测」项执行后，在 `acceptance.md` 对应 AC 下写「操作 / 实际结果 / 结论 / 环境（构建 SHA、profile、日期）」；失败的项保留原文与日志摘录，修复后复测再更新。`historyBootstrapLimit: 0`、非本 route 负向、`acceptAttachments=false` 等用户已决定跳过真机的项，标注「自动测试覆盖，用户决定跳过真机」，不要写成已验证。

## 6. 常见问题排查

| 现象 | 排查 |
|------|------|
| 私聊无响应 | 用户是否在应用**可用范围**内；权限 `im:message.p2p_msg:readonly` 是否随版本发布；若返回的是“非管理员禁用私聊功能哦”，说明准入生效（把该用户加入白名单或让管理员对话） |
| 私聊提示“机器人尚未配置管理员” | `accessMode: 'guarded'` 且未配置 `adminOpenId`：按 §3.3 在面板填写管理员 open_id |
| 机器人被拉进群但管理员没收到群信息卡 | 是否订阅 **im.chat.member.bot.added_v1** 事件并重新发布版本；群信息读取权限是否已开通（`getChatInfo` 失败只会缺群名，不影响卡片本体） |
| 群内 @ 机器人无响应（登录台无 access 报错） | 管理员不受白名单限制，可直接对话；**非管理员**需要该群已授权且自己在用户白名单里。可用 `/auth status`（管理员）或 Web 面板「访问授权」标签页确认 |
| `/auth` 无反应 | `/auth` 仅管理员可用；非管理员在群里会被静默忽略、私聊会收到固定提示 |
| 群聊 @ 无响应 | 事件订阅是否勾选“接收群聊中 @ 机器人消息”；机器人是否在群内且未被群主禁言 |
| 模型说看不到刚发的文件 / 文件没有自动出现 | 属 v2 设计：文件默认不加载，只在 `<feishu_context>` 清单里声明；模型需调用 `feishu_attachment_fetch`。可明确要求“用 feishu_attachment_fetch 取清单里 message_id=… 的附件”；若工具没注册，检查启动日志 `feishu_attachment_fetch 未挂载` 与宿主 `tools`/`attachments` 服务 |
| 只发附件（不带文字）机器人毫无反应 | native 后端下的**预期行为**：纯附件消息静默，不回复、不建会话、不下载；随后引用这条附件消息发文字提问，附件即列入清单；不引用时模型看不到它。若引用后仍没有，检查消息读取权限（群聊需 `im:message.group_msg`）。archive 后端下会看到 `DONE` 表情且附件落到话题目录 |
| 模型没有调用 feishu_attachment_fetch | 检查 `<feishu_context>` 清单是否出现在 prompt（有未加载附件时才有）；确认工具开关 `feishuTools.attachmentFetch` 与 native 后端；必要时在消息里点明“用附件工具取一下”。漏调风险由清单措辞 / 工具描述 / guidance 收敛，没有预下载兜底（决定 D4） |
| 引用或话题历史内容缺失 | 缺消息读取 scope（`im:message:readonly` / 敏感的 `im:message.group_msg`）：引用/历史块静默省略、普通对话不受影响；启动后首次降级有一条 warn，之后 debug 级。按 §1 申请权限并重新发布版本；显式调用 `feishu_topic_messages` 会返回可读 `PERMISSION_DENIED` |
| `feishu_attachment_fetch` 超时 / 报字节超限 | 大文件受 `feishuTools.attachmentFetchTimeoutMs`（默认 120 s）与 `attachmentFetchMaxBytes`（默认 100 MiB）限制：可调大上限/超时，或用 `file_key` 分批取；资源过期/被撤回时逐资源返回可读失败，可直接重试或让用户重发 |
| 升级到 v2 后在旧话题里“找不到以前的附件” | 旧 archive 部署的附件仍在旧话题 `attachments/`，但新会话不再枚举该目录；Session 历史里的只读路径仍可读。需要长期保留请勿手动删除该话题目录，或从历史消息重新发送/引用 |
| 话题目录里出现 `attachments/` | 当前生效的是 archive 后端：检查 `attachmentStore`（是否显式设为 `archive`）、宿主是否挂载 `ctx.attachments`、`feishuTools.attachmentFetch` 是否为 `false`。native 后端不会写话题 `attachments/` |
| 有 Typing 但无卡片 | 权限 `im:message` / `im:message:update`；卡片 2.0 需要较新的飞书客户端（升级客户端后重试） |
| 卡片正文只到某长度 | 旧版行为；新版单卡目标 28 KB（`CARD_TARGET_BYTES`，飞书上限 30 KB 留 2 KB 冗余），超长正文自动分段为多张续卡（「📄 回复分段 n」，每卡 ≤ 5 个表格，断点避开代码围栏与表格），续卡无面板/页脚、可用满 28 KB，全文保留；推理面板独立 5 KB 上限，超出的推理只保留开头并追加「已截断」提示 |
| 报错 230099 / `ErrCode: 11310 card table number over limit` | 飞书单卡表格数量超限（真机验证上限 5 个）；新版已按“每卡最多 5 个表格”自动切分，不再触发；历史版本请重装插件并重启 dsh |
| 流式期间手动展开面板又被收起 | v1 已知取舍：patch 是全量替换卡片，500ms 内的下一次刷新会重置折叠状态；流式结束后可自由展开 |
| 错误码 `230013` | 用户不在可用范围 / 被禁用 |
| 错误码 `230071` | 该群不支持话题回复 → 自动降级路径（见 §5.1） |
| 错误码 `230099`（`parse card json err` / `unknown property, property: elements`） | 卡片结构混用：2.0 声明下把组件放在顶层 `elements`（应在 `body.elements`）。新版插件已改为规范 2.0 结构：重装插件并重启 dsh |
| 折叠面板不显示 / 正文不是富文本 | 无推理内容的回合结算后省略面板属**正常行为**；若旧版插件连推理内容也不显示，是旧卡片的两个已知问题（`icon.tag: "img"` 非法、1.0 结构 markdown 语法受限），新版插件已切 2.0 结构 + 内置 `standard_icon` 箭头：重装插件并重启 dsh |
| 审批卡不出现 | 确认该部署启用了 HITL：启动日志应有「HITL 审批应答已就绪」；若显示「主机未挂载 approval 服务」则该部署不会派发审批请求；另外确认当前会话的审批策略不是 `never`（`/permission danger-full-access` 会关闭审批） |
| 审批卡点击无反应 | 未订阅 **card.action.trigger** 回调（或订阅后未重新发布版本），见 §1 第 4 步；按 §5.0 重新核对 |
| 错误码 `231001` / `231002` | 表态表情失败：表情名（`Typing`/`DONE`/`No`）必须一字不差；机器人需在会话内 |

## 7. 改代码 → 生效的循环

```bash
# 1) 修改 $PLUGIN 源码后：
cd $PLUGIN && pnpm typecheck && pnpm test
# 2) link 安装无需重装，直接重启：
cd $HARNESS
DSH_HOME=$DSH_HOME pnpm dsh web
```

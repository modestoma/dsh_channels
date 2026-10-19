# dsh-channels · 真机联调手册

本文档指导你**手动安装** dsh-channels 插件到本机 dsh，配置飞书机器人，并逐项验证私聊/群聊/话题群三条通道的流式卡片体验。所有步骤均已在本机 dsh checkout（web profile）上实测通过。

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
   | `im:message`（获取与发送单聊、群组消息） | 收发消息、回复话题 |
   | `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息） | 私聊通道 |
   | `im:message.reactions:write_only`（发送、删除消息表情回复） | Typing / DONE / No 表态 |
   | `im:message:update`（更新消息卡片） | 流式卡片刷新（patch） |
   | `im:chat:readonly` 一类（获取群信息） | 入群通知卡展示群名/成员数（具体 scope 以控制台要求为准） |

   > 卡片更新接口本身支持 `im:message` 一项即可，但建议把 `im:message:update` 也加上，避免组合差异。
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

解析优先级（由 `dsh-credentials-local` 提供，热加载）：进程环境变量 > `.credentials.yaml` > 启动目录 `.env` > `$DSH_HOME/.env`。不想用凭据库时，直接导出环境变量也能生效。凭据改动后重启 dsh 生效。

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
    approvalTimeoutMs: 300000           # HITL 审批决策卡等待时长（默认 5 分钟）
    accessMode: 'guarded'               # 准入模式：guarded（默认）| open（旧行为，不安全）
    adminOpenId: 'ou_xxx'               # 管理员 open_id（可留空，留空时 guarded 下拒绝一切对话）
    authRequestTtlDays: 7               # 入群/用户授权申请卡有效期（天）
    loggerLevel: 'info'
```

从旧版配置迁移时，删除原来的 `insert` / `id: channels` 条目；不要同时保留旧行和 `id: dsh-channels`，否则同一机器人会建立两个长连接并重复处理消息。

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `appId` / `appSecret` | 必填 | 凭据引用名（shell 标识符），经 `ctx.credentials` 解析；明文密钥会被拒绝 |
| `baseDir` | `./channels-data` | 工作区目录树根：每个话题一个独立工作区，`topics/p2p/<open_id>/<topic>/`、`topics/groups/<chat_id>/<open_id>/<topic>/`（模型/工具产生文件的落点）；Web 面板可覆盖，只接受绝对路径，`~` 展开，保存时创建并校验目录，只影响之后新建的话题 |
| `provider` / `model` | 部署默认 | 新建 session 的路由；省略时继承部署默认 |
| `reasoningEffort` | 适配器/provider 默认 | Session 初始/重置推理档位；可在话题内用 `/effort` 覆盖 |
| `maxTokens` | 适配器默认 | 每次模型请求输出上限 |
| `refreshMs` | `500` | 流式卡片刷新频率（200–10000） |
| `dmMode` | `open` | 私聊开关 |
| `requireMention` | `true` | 普通群是否需要 @ 机器人（话题内续聊不受影响） |
| `threadFallback` | `degrade` | 话题回复被拒时：`degrade` 降级为会话级延续 / `strict` 直接失败 |
| `approvalTimeoutMs` | `300000` | HITL 审批决策卡等待时长（10s–1h）；超时自动拒绝 |
| `accessMode` | `guarded` | 准入模式：`guarded` 仅管理员+白名单；`open` 保留旧行为（任何可用范围用户可对话，不安全） |
| `adminOpenId` | 未设置 | 唯一管理员 open_id（`ou_` 开头）；留空 + guarded = 拒绝一切对话（`/userid` 引导仍可用）。面板可改 |
| `authRequestTtlDays` | `7` | 入群/用户授权申请卡有效期（1–30 天） |
| `loggerLevel` | `info` | 官方 SDK 日志级别 |

### 3.3 初始化管理员与授权（默认准入）

插件默认 `accessMode: 'guarded'`：**没有配置管理员时，所有对话都会被拒绝**（这是 fail-closed 的安全默认值）。初始化顺序：

1. 启动 dsh 后在飞书**私聊机器人**发送 `/userid`（未配置管理员时任何私聊用户都可以用，只回固定文本，不建会话）→ 复制返回的 `ou_...`；
2. 打开 Web **设置 → 飞书渠道 → 常用配置**，把 `ou_...` 填进「管理员 open_id」并保存（立即生效）；也可以直接写 profile 的 `adminOpenId`；
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

**常见启动失败**：

| 输出 | 原因 |
|------|------|
| `could not resolve bot identity via /open-apis/bot/v3/info` | App ID/Secret 错误，或未开启机器人能力 |
| `permission_denied` / `invalid tenant access token` | 同上，先核对凭证再查权限 |
| `credential "FEISHU_APP_ID" is not configured` | `.credentials.yaml` 缺对应条目（或环境变量未导出），见 §3.1 |
| `is readable beyond its owner (mode 644)` | `.credentials.yaml` 权限过宽，`chmod 600` 后重启 |
| `dsh: plugin tree failed to load … dsh-channels` | 插件本身加载失败（多为 `name:` 拼写或未安装），看后续 cause |
| 无任何 `dsh-channels` 输出 | 插件未装载：检查 `--dump-config` 是否含条目、补丁层是否用了 `insert:` 格式 |

> 说明：插件内部其余日志走 dsh 的 cordis logger，web 组合下部分早期日志可能只进缓冲不落终端；上面两条**生命周期日志**（连接成功 / 启动失败）额外直接输出到控制台，联调时以它们为准。

## 5. 三通道联调清单

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 1 | 私聊 | 给机器人发一条消息 | 消息下立刻出现 **Typing** 表情 → 以话题形式回复卡片（**推理中** 折叠面板）→ 正文流式输出（500ms 刷新，面板变 **回复中**）→ 成功变 **回复结束**、Typing 变 **DONE**；卡片底部两行 session 信息 |
| 1a | 错误推理强度 | 配置该模型不支持的 `reasoningEffort` 后发消息 | 卡片变 **回复失败**，显示 Harness 返回的错误消息和错误码（如 `UNSUPPORTED_REASONING_EFFORT`），Typing 变 **No**；模型/推理强度/缓存不沿用上一轮 |
| 1b | Session 推理强度切换 | 话题内依次执行 `/effort`、`/effort tiny`、发普通消息、重启后续聊、`/effort reset` | 首次显示配置来源；切换后下一轮请求使用 `tiny`，重启恢复后仍保持；reset 后恢复配置值。若模型不支持 `tiny`，下一轮按 1a 失败，不会静默回退 |
| 2 | 私聊续聊 | 在刚建的话题里直接再发消息（**不 @**） | 继续同一 session：卡片底部 session id 不变，input/output token 累计增长 |
| 3 | 群聊 @ | 在普通群 @ 机器人发消息 | 同 #1；该消息成为新话题根 |
| 4 | 群聊话题内 | 在上一步的话题里直接发消息（不 @） | 延续该 session，不再要求 @ |
| 5 | 同群第二个用户 | 换另一个人 @ 机器人 | 新话题 + 新 session；dsh 工作区列表中出现**独立的第二个工作区**（`topics/groups/<chat_id>/<用户 open_id>/<topic>/`），与原用户的话题工作区互不可见 |
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
| 16 | 话题越权防护 | 授权群里用户 A 创建话题后，用户 B 在 A 的话题里发普通消息/附件/回答提问 | B 的消息被静默丢弃，不会进入 A 的 Session、不会写入 A 的工作区；A 自己发言正常 |

### 5.0 HITL 审批验证点（重点）

1. **卡片形态**：审批卡是流式卡之外**新发的独立消息**，锚定在最新流式卡下、同一话题内；流式卡本身不带按钮。
2. **按钮回传**：待审批时允许/拒绝按钮在同一行等宽排列；点击后卡片立即更新为终态并移除两个按钮。若点击无反应，先核对 §1 第 4 步是否已订阅 **card.action.trigger** 回调并**重新发布版本**（回调订阅随版本生效）。
3. **归属校验**：群里非发起人点击审批卡：卡片出现「ℹ️ 仅发起该会话的用户可操作此卡片」提示，动作不生效。
4. **超时**：`approvalTimeoutMs` 内不点 → 卡片变「已超时」，动作被自动拒绝（fail-closed），模型收到拒绝结果后会换路径继续。
5. **多会话并行**：不同话题的审批互不串扰（每张卡只结算自己的问题）。

### 5.1 私聊话题验证点（重点）

飞书官方文档没有明示 `reply_in_thread` 对**私聊**的约束。联调时在私聊里观察第 1 步：消息是否真的聚合成“话题”形态（话题气泡）。若飞书拒绝话题回复，插件按 `threadFallback: 'degrade'` 自动改为普通回复，此时私聊内所有消息延续同一个 session（等价于“私聊整体即话题”），功能不受阻。若你希望私聊必须话题形态，把 `threadFallback` 设为 `strict` 并反馈错误码。

### 5.2 验证工作区归属

打开 dsh Web GUI → 工作区列表，应看到：

```
飞书私聊 · ou_xxx · omt_xxx          （对应 <baseDir>/topics/p2p/ou_xxx/omt_xxx/）
飞书群聊 · oc_yyy · ou_xxx · omt_xxx （对应 <baseDir>/topics/groups/oc_yyy/ou_xxx/omt_xxx/）
```

每个新话题会创建新的工作区目录；同一话题内 `/renew` 仍复用该工作区。

## 6. 常见问题排查

| 现象 | 排查 |
|------|------|
| 私聊无响应 | 用户是否在应用**可用范围**内；权限 `im:message.p2p_msg:readonly` 是否随版本发布；若返回的是“非管理员禁用私聊功能哦”，说明准入生效（把该用户加入白名单或让管理员对话） |
| 私聊提示“机器人尚未配置管理员” | `accessMode: 'guarded'` 且未配置 `adminOpenId`：按 §3.3 在面板填写管理员 open_id |
| 机器人被拉进群但管理员没收到群信息卡 | 是否订阅 **im.chat.member.bot.added_v1** 事件并重新发布版本；群信息读取权限是否已开通（`getChatInfo` 失败只会缺群名，不影响卡片本体） |
| 群内 @ 机器人无响应（登录台无 access 报错） | 管理员不受白名单限制，可直接对话；**非管理员**需要该群已授权且自己在用户白名单里。可用 `/auth status`（管理员）或 Web 面板「访问与授权」确认 |
| `/auth` 无反应 | `/auth` 仅管理员可用；非管理员在群里会被静默忽略、私聊会收到固定提示 |
| 群聊 @ 无响应 | 事件订阅是否勾选“接收群聊中 @ 机器人消息”；机器人是否在群内且未被群主禁言 |
| 有 Typing 但无卡片 | 权限 `im:message` / `im:message:update`；卡片 2.0 需要较新的飞书客户端（升级客户端后重试） |
| 卡片正文只到某长度 | 旧版行为；新版单卡预算 28 KB（30 KB 上限留 2 KB 冗余），超长正文自动分段为多张续卡（「回复分段 n」，每卡 ≤ 5 个表格），全文保留；推理面板独立 5 KB 上限，超出的推理只保留开头并追加「已截断」提示 |
| 报错 230099 / `ErrCode: 11310 card table number over limit` | 飞书单卡表格数量超限（真机验证上限 5 个）；新版已按“每卡最多 5 个表格”自动切分，不再触发；历史版本请重装插件并重启 dsh |
| 流式期间手动展开面板又被收起 | v1 已知取舍：patch 是全量替换卡片，500ms 内的下一次刷新会重置折叠状态；流式结束后可自由展开 |
| 错误码 `230013` | 用户不在可用范围 / 被禁用 |
| 错误码 `230071` | 该群不支持话题回复 → 自动降级路径（见 §5.1） |
| 错误码 `230099`（`parse card json err` / `unknown property, property: elements`） | 卡片结构混用：2.0 声明下把组件放在顶层 `elements`（应在 `body.elements`）。新版插件已改为规范 2.0 结构：重装插件并重启 dsh |
| 折叠面板不显示 / 正文不是富文本 | 旧版卡片的两个已知问题（`icon.tag: "img"` 非法、1.0 结构 markdown 语法受限），新版插件已切 2.0 结构 + 内置 `standard_icon` 箭头：重装插件并重启 dsh |
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

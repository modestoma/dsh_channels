# dsh-channels 准入与授权（Access Control）设计

> 状态：已实现（P1 + 入群群信息卡/用户授权卡；P3 增强项仍待做）。
>
> 用户标识已从 open_id 改为 `user_id`：下文的 open_id / `ou_...` / `adminOpenId` 现在分别对应 `user_id` / `adminUserId`，存储域改为 `channels_routes_v2`，旧数据不迁移（见 README「飞书侧准备」的 `contact:user.employee_id:readonly` 权限）。
> 目标：唯一管理员（Web 面板配置 open_id）**不受白名单限制**，在任意私聊/群聊（含未授权群）都能直接发起会话；**非管理员**需要「群已授权 + 用户在白名单」两层同时命中。机器人可以被拉进任意群，但非管理员未授权时不做任何回复、不产生任何会话。

## 0. 一句话方案

新增一层**频道准入（admission）**：所有飞书入站在做任何副作用之前，先过 `AccessController.admit(msg)`。

- **管理员（唯一）**：`adminOpenId`，在 Web 设置面板配置（私聊机器人发 `/userid` 获取）。
- **群授权**：管理员显式把某个 `chat_id` 加入白名单（对话命令 / 授权卡 / 设置面板三种入口）。
- **用户授权**：管理员显式把某个 `open_id` 加入白名单（对话命令 / 授权卡 / 设置面板三种入口）。
- **放行规则**：
  - **管理员不受白名单限制**：私聊、任意群聊（包括尚未授权的群）都能直接发起/延续会话；
  - 私聊：非管理员只回一条固定提示（不调模型、不建会话）：`非管理员禁用私聊功能哦～如需使用请在管理员授权的群里 @ 我`；`/userid` 例外，任何人都能用它查看自己的 open_id；
  - 群聊：非管理员需要 **群 ∈ 群白名单 且 open_id ∈ 用户白名单**，两者缺一不可。
- **入群通知**：机器人被拉进任意群后，私聊给管理员发该群的群名 / `chat_id` / 成员数等信息；未授权的群同时附「授权本群 / 忽略」按钮。
- 默认策略 **fail-closed**：没有命中 → 不调模型、不建 Session、不建工作区、不落附件，最多一条固定文案（默认完全静默）。
- 授权状态**持久化、可撤销、立即生效**。

## 1. 先把“权限”拆成两层

| 层 | 回答的问题 | 当前实现 | 本次是否改动 |
|---|---|---|---|
| **A. 准入/授权** | 谁、在哪个群能触发机器人 | **基本缺失**（见 §2） | ✅ 本文档的主体 |
| **B. 会话权限预设** | 已建立的会话跑在什么沙箱、审批策略下 | `/permissions` 只读；`allowPermissionSwitch` 默认 false；HITL 审批 `approval/request` 与 `ask_user_question` 应答者，决策卡仅发起人可点、超时 fail-closed（`src/interactions/pending.ts:90`、`src/service.ts:1035`、`README.md:10`） | ❌ 不动，继续作为纵深防御 |

本文档只改 A。B 里的“只有会话发起人能点审批卡”是**会话内**所有权，不是**准入**。

## 2. 现状：准入几乎没有

### 2.1 外层：飞书平台

- 应用**可用范围**（开放平台 → 版本管理）：唯一真正的粗粒度 ACL。
- 机器人能力 + 群成员关系：把机器人拉进群不需要插件同意。

### 2.2 SDK 层：`src/feishu-channel.ts:94-109`

```ts
this.channel = createLarkChannel({
  // ...
  policy: {
    requireMention: false,      // 插件自己管 mention
    dmMode: options.dmMode === 'open' ? 'open' : 'disabled',
    respondToMentionAll: false,
  },
})
```

SDK 支持 `groupAllowlist` / `dmMode: 'allowlist'` + `dmAllowlist`，但插件**一个都没传**；`dmMode: 'pair'` 在 SDK 里是空实现。准入完全没被利用。

### 2.3 插件入口：`src/routing/inbound.ts:130-240` 的 `handle()`

现有的“准入”只有四条：

1. 忽略机器人自己发的消息、非 `p2p`/`group`、空内容（`:131-135`）；
2. 私聊 `dmMode === 'disabled'` 时丢弃（`:137`）；
3. 群聊**新建会话**需要 @ 机器人（`requireMention`，默认 true，`:237`）；
4. 已绑定话题/降级路由里续聊**不需要 @**（`:196-216`）。

**没有任何发送者白名单、管理员校验、群授权校验。** 只要用户在应用可用范围内：

- 私聊机器人 → 立刻建 Session、建工作区；
- 在群里 @ 机器人 → 立刻建 Session、建工作区；
- 群里其他成员各自拿到自己的 workspace 和 route（`chatRouteKey` 含 `senderOpenId`，`src/domain.ts:306-310`）。

### 2.4 已有的“所有权”是会话内所有权，不是准入

| 机制 | 位置 | 拦住了什么 | 拦不住什么 |
|---|---|---|---|
| `RouteRecord.senderOpenId` + slash 命令校验 | `src/service.ts:915,925` | 非 route owner 不能执行 `/status`、`/model` 等命令 | 不能阻止陌生人开**自己的**新会话 |
| 审批/提问卡片 owner gate | `src/interactions/pending.ts:90-104` | 非发起人点卡片无效 | 与“能否开启对话”无关 |
| `chatRouteKey` 带 sender | `src/domain.ts:306-310` | 两个用户共享同一个降级路由 | 话题路由（thread route）**不带 sender 校验** |
| workspace 按 user × chat | `src/workspaces.ts` | 用户之间文件目录隔离 | 陌生人照样能建自己的目录、浪费磁盘 |

### 2.5 需要顺手补掉的越权缺口（重要）

现在的 `handle()` 在命中**话题路由**后（`:196-205`）直接 `continueSession()`，**不校验 `msg.senderId === record.senderOpenId`**；同样的问题在：

- `archiveAttachments()`（`:250-274`）：只看 `threadId`，陌生人把附件发进别人的话题会被写进**别人的工作区**；
- `tryAnswerPendingQuestion()`（`:281-292`）：只看 route 的 `sessionId`，陌生人可以替别人的 `ask_user_question` 交文字答案；
- `continueSession()`（`:415`）：没有 sender 校验，群里任何成员在机器人话题里回复一句，都会被当成**话题所有者**的输入进入模型（上下文注入 / 越权使用工具）。

独立审计还补充了三个同源缺口，都应在 P1/P2 顺手处理：

- **route-free / 未知 slash 在 owner 门之前就有副作用**：`/help` 会建话题发卡、`/health` 会泄露路由数、live Agent 数、bot open_id 尾号；非法命令名也会回输入错误卡（`src/service.ts:868-882`、`:942-994`）。
- **HITL 审批卡在群话题内对群成员可见**：审批卡携带工具名、reason、sessionId（`src/cards/approval.ts:62-90`），流式卡结算后的页脚第一行仍带完整 session id、在群里可见（`buildModelLine`，`src/cards/streaming.ts:291-295`）。新模型下群内只有管理员和已授权用户，属“已授权成员可见”的可接受范围，后续可改私聊投递。
- **错误回显未脱敏**：入站异常会原样回 `dsh-channels 处理失败：<error>`（`src/service.ts:754-761`），可能带本地路径/Session 信息。

### 2.6 身份发现能力已经有了

`/userid`（私聊返回自己的 open_id，`src/service.ts:975`）和 `/groupid`（群聊返回 chat_id，`:980`）是 route-free 命令，不需要 Session。`/userid` 对新准入下的**任何私聊发送者**放行（只回自己的 open_id，不调模型），是管理员/用户获取 open_id 的引导入口；`/groupid` 仅管理员可用。

## 3. 目标模型

### 3.1 术语与规则

- **管理员（admin）**：唯一，配置项 `adminOpenId`（open_id，`ou_` 开头）。在 Web 设置面板填写；私聊机器人发 `/userid` 可获取。管理员身份是白名单的根，**不能通过飞书对话修改**（防止在 IM 里提权）。
- **群白名单**：一组 Feishu `chat_id`（`oc_...`）。管理员授权后，**非管理员**才能在该群开启访问。
- **用户白名单**：一组 Feishu `open_id`（`ou_...`）。管理员授权后，该用户才能在已授权的群里与机器人交互。
- **放行规则**：
  - **管理员（admin）不受任何白名单限制**：私聊、任意群聊（包括尚未授权的群）都可以直接发起/延续会话；群/用户白名单只约束非管理员。
  - `p2p` 非管理员：拒绝，回一条固定提示（见 §5.3），不建会话、不推申请卡。`/userid` 例外：任何私聊发送者都可用它查看自己的 open_id。
  - `group` 非管理员：`chat_id ∈ 群白名单` **且** `open_id ∈ 用户白名单` → 允许；否则拒绝（未授权群静默并可触发群授权申请；已授权群但人不在白名单时静默并可触发用户授权申请）。
- **话题所有权**（独立于准入，见 §5.6）：只有话题发起人能续写该话题。

### 3.2 决策矩阵

`p2p`：

| 发送者 | 结果 |
|---|---|
| 管理员 | 允许 |
| 用户白名单 | 拒绝 + 固定提示（私聊只开给管理员；授权用户只在群里用） |
| 其他人 | 拒绝 + 固定提示（不建会话、不推申请卡） |
| 任何人发 `/userid` | 放行，只回自己的 open_id（固定文本，无模型调用） |

`group`：

| 群白名单 | 发送者 | 结果 |
|---|---|---|
| 不在 | 管理员 | **允许**（管理员不受白名单限制） |
| 不在 | 非管理员 | 拒绝；入群时已私聊管理员发群信息/授权卡，首次未授权访问时补发 |
| 在 | 管理员 | 允许 |
| 在 | 用户白名单 | 允许 |
| 在 | 其他人 | 拒绝；可给管理员发“用户授权申请卡” |

### 3.3 默认值（建议）

| 配置 | 默认 | 说明 |
|---|---|---|
| `accessMode` | `guarded` | `open` 仅用于调试/兼容旧行为，标注“不安全” |
| `adminOpenId` | 未设置 | 为空 + guarded = 拒绝一切对话（`/userid` 仍可用，并提示尚未配置管理员），面板与启动日志显著告警 |
| `authRequestTtlMs` | 7 天 | 申请卡/申请记录有效期 |
| `auditRetention` | 200 条 | 面板展示的最近授权审计条数（P3） |

> 以下都是**固定行为，不提供开关**：
> - 入群通知（群信息卡）与“已授权群内未授权用户”的用户授权申请：前者是管理员知情权，后者是“通过对话授权用户”的入口；
> - 非管理员私聊的固定提示（不调模型）；
> - `/userid` 对所有私聊发送者开放（只回自己的 ID，不消耗 token）；
> - 群内未授权访问保持静默。

### 3.4 原则

1. **Default deny / fail closed**：判定异常、存储失败、管理员未配置，一律拒绝。
2. **未授权零副作用**：不 `agents.resume/create`、不 `ensureWorkspace`、不落附件、不写 route、不调模型；最多一条固定文案。
3. **白名单只约束非管理员**：群授权与用户授权是两道门（缺一不可），管理员始终直通。
4. **授权可撤销且立即生效**：每次消息判定读当前内存态，不做长期缓存。
5. **身份只认 open_id**：消息 `senderId`、卡片 `operator.openId`；不使用昵称/邮箱/user_id 作为授权依据。
6. **准入与会话所有权正交**：两者都过才放行；补掉 §2.5 的话题续写缺口。
7. **不依赖 SDK 静态 policy**：SDK 白名单在插件之前丢事件、无法动态授权；继续让 SDK 保持宽松，准入放插件层。

## 4. 数据与配置

### 4.1 配置（`src/config.ts`）：只有“身份 + 行为”

白名单不放在 config，而是放进持久化访问表（§4.2），因为授权是运行时动态状态：

```ts
// 准入（安全敏感：默认收紧）
accessMode: z.enum(['open', 'guarded']).default('guarded'),
/**
 * 管理员 open_id（唯一）。open_id 形如 ou_xxx，私聊机器人发 /userid 获取。
 * 留空 + guarded = 拒绝一切对话（只放行首次引导 /userid）。
 */
adminOpenId: z.string().regex(/^ou_[A-Za-z0-9_-]+$/, '必须是 open_id（ou_ 开头）；用 /userid 获取')
  .optional(),
// 私聊只开给管理员（adminOpenId）：非管理员私聊回固定提示 + /userid 例外。
// 入群通知、用户授权申请是无开关的固定行为。
authRequestTtlMs: z.number().int().min(60_000).max(30 * 86_400_000).default(7 * 86_400_000),
```

- 所有字段都有默认值，旧 profile 配置不改也能加载。
- 都存进 Web overlay（`EDITABLE_KEYS` + `parseOverlay` 逐字段 zod 校验），**保存即生效**（`src/service.ts:376-389` 的 `replaceConfig` 原地变更，不进 `RESTART_KEYS`）。
- 面板里 `adminOpenId` 用一个普通 text 字段（不需要新的 FieldKind）；`accessMode` 用现有 select 控件。

### 4.2 动态授权状态（`src/domain.ts` 的 `feishuDomain`）

新增三张表（**保持 `version: 1`**，原因见下）：

```ts
export const accessGroupSchema = z.object({
  chatId: z.string().min(1),        // oc_xxx（表 key）
  name: z.string().optional(),      // 群名，来自 botAdded/getChatInfo 或面板手填
  source: z.enum(['command', 'card', 'panel']),
  addedBy: z.string().min(1),       // 管理员 open_id
  addedAt: z.number().int().nonnegative(),
})

export const accessUserSchema = z.object({
  openId: z.string().min(1),        // ou_xxx（表 key）
  name: z.string().optional(),
  source: z.enum(['command', 'card', 'panel']),
  addedBy: z.string().min(1),
  addedAt: z.number().int().nonnegative(),
})

export const authRequestSchema = z.object({
  token: z.string(),                // 卡片按钮携带的不透明 token（表 key）
  kind: z.enum(['group', 'user']),
  targetId: z.string(),             // chat_id / open_id
  chatId: z.string().optional(),    // 申请发生在哪个群
  groupName: z.string().optional(),
  requesterOpenId: z.string().optional(),
  requesterName: z.string().optional(),
  messageId: z.string().optional(), // 管理员私聊里那张卡的消息 id
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  createdAt: z.number(),
  expiresAt: z.number(),
})
```

| 表 | 用途 | key |
|---|---|---|
| `access_groups` | 已授权的群 | `chat_id` |
| `access_users` | 已授权的用户 | `open_id` |
| `auth_requests` | 授权申请（含已结算记录，做审计与防重） | token |
| `access_audit`（P3 可选） | 最近授权/撤销记录 | `<ts>-<uuid>` |

**注意：不要把 `feishuDomain.version` 从 1 升到 2。** 已验证宿主 `@deepseek-ai/dsh-storage-json` 的 `single` 布局（本插件未声明 `layout`，默认 single）打开时要求**存档版本与 spec 版本严格相等**，版本不符直接 `version-mismatch` 失败；`compatibleVersions` 只对 `per-record` 布局生效。**新增表不升版本是兼容的**：旧存档里没有的表按空表打开（降级时新表数据会被忽略）。

- 授权表在 `start()` 打开 domain 后加载进内存 `Set`，写操作“先写 domain 再更新内存”（domain 的写链保证顺序），判定只读内存。
- 待处理申请的 `messageId` 持久化，**重启后管理员仍可点旧卡片**；过期由现有 6 小时 GC 定时器顺带清扫，或启动时扫一次。
- 面板与飞书对话共用同一套 store 方法，不产生两份状态。

## 5. 判定与执行点

### 5.1 新增模块

```
src/access/
├── policy.ts        # 纯函数：decide(msg, snapshot) → AccessDecision（可穷举单测）
├── store.ts         # access_groups / access_users / auth_requests 读写 + 内存缓存
├── controller.ts    # 入站准入、命令准入、申请触发、撤销、审计
├── requests.ts      # 申请生命周期：去重/限流/发管理员 DM 卡/结算/过期（P1 入群卡、P2 用户卡）
├── cards.ts         # 群信息/授权卡、用户授权卡、结果卡（复用 cards/primitives.ts）
└── index.ts
```

判定骨架（`policy.ts` 纯函数，输入 = 消息类型/发送者/chat_id + 白名单快照 + config）：

```
admit(msg):
  accessMode === 'open'                                  → allow(open)
  sender === adminOpenId                                 → allow(admin)   # 任意私聊/群聊，含未授权群
  p2p:
      otherwise                                          → deny + 固定提示（不产生申请卡）
  group:
      !groups.has(chatId)                                → deny(need group) + ensureGroupRequest
      users.has(sender)                                  → allow(authorized-user)
      otherwise                                          → deny(need user) + ensureUserRequest
```

判定顺序：**管理员直通；非管理员先群后用户**，两层缺一不可。

`AccessController` 注入 `FeishuService`，`InboundRouter` 只依赖窄接口：

```ts
export interface AccessPort {
  /** 在 dedupe 之后、任何副作用之前调用。false = 已拒绝并处理完提示/申请。 */
  admit(msg: NormalizedMessage): Promise<boolean>
  /** 命令面准入：bootstrap / 管理员 / 普通命令。 */
  admitCommand(msg: NormalizedMessage, spec: ChannelCommandSpec): Promise<boolean>
  /** 话题续写所有权校验。 */
  ownsRoute(msg: NormalizedMessage, record: RouteRecord): boolean
}
```

### 5.2 `InboundRouter.handle` 的新顺序

```
bot 回显过滤 / chatType / 空内容 / dmMode
→ 去重记录（未授权消息也记录，避免重投反复处理）
→ slash？→ handleSlashMessage 内部走 admitCommand（§5.4）后 return
→ access.admit(msg)（非 slash 消息；拒绝/申请 → 处理提示后 return）
→ TTL 过期话题处理 + 过期墓碑
→ 附件归档（先过 ownsRoute）
→ 待答问题（先过 ownsRoute）
→ 话题路由续写（ownsRoute）
→ 降级 chat 路由
→ mention 门禁
→ 新建会话
```

要点：

- 准入必须在 **`archiveAttachments` 之前**——否则未授权附件已经落盘。
- 去重记录放在准入之前：未授权消息也消耗 message id。
- **只有“对机器人说的”消息才触发申请/提示**：`p2p`、群里 `mentionedBot`、或命中已有话题路由。普通群里没 @ 的闲聊即使未授权也直接静默丢弃，不建申请。
- `continueSession()` / `establishSession()` 里再断言一次 sender（防御性）。

### 5.3 私聊：只开给管理员，但给固定提示

- 管理员私聊：永远放行（不受群白名单影响）。
- 其他任何人私聊：**拒绝，但回一条固定提示**，例如：
  > 非管理员禁用私聊功能哦～如需使用，请在管理员授权的群里 @ 我；或联系管理员把你的 open_id 加入白名单。
  - 固定文案、不调模型、不建 Session、不落附件、不发 `/help`、不给管理员推申请卡；
  - 同一用户 10s 内最多回一条（防刷 API，不消耗 token）；
  - 管理员未配置时文案换成引导：「机器人尚未配置管理员；发送 /userid 可查看你的 open_id，交给部署者配置后即可启用。」
- **`/userid` 例外**：任何私聊发送者都可以用 `/userid` 查看自己的 open_id（只回自己的 ID，固定文本）。这既是管理员首次配置的入口，也是普通用户把自己的 ID 发给管理员的途径。
- 用户授权因此只在群里发生：未授权用户必须在已授权群里 @ 机器人，才会触发“用户授权申请卡”给管理员。

### 5.4 命令面（`src/service.ts:864` `handleSlashMessage`）

| 命令 | 未授权时 |
|---|---|
| `/userid`（私聊） | **任何私聊发送者都放行**：只回发送者自己的 open_id，固定文本、无模型、无存储副作用（其它私聊消息按 §5.3 回固定提示） |
| `/groupid`（群聊） | 管理员放行（含未授权群，固定文本，用于面板录入群）；其他人一律不回复 |
| `/auth` | 仅管理员；管理员在任何群（含未授权群）都能用（这是“通过对话授权群”的入口） |
| 其他所有命令（含 `/help`、`/health`） | 必须先通过 `admit`；否则拒绝（默认静默，`once` 时固定文案） |

实现位置：`handleSlashMessage` 里 `commandSpec()` 解析之后、任何 `commandCard`/`commandRoute`/`agents` 之前调用 `access.admitCommand`。两个边界：

- 非管理员的**非法命令名/未知命令**必须在发任何卡之前拦掉——当前这两条分支会建话题发卡（`src/service.ts:868-882`、`:942-994`）。
- `/health` 会泄露路由/Agent 计数与 bot open_id 尾号，未授权一律拒绝。

### 5.5 `/auth` 命令（admin-only，channelPlane）

在 `src/commands/registry.ts` 增加一条（自动获得 `/help` 展示与准入规则）：

```ts
{
  name: 'auth', group: '会话', description: '查看/管理访问授权，可 @ 成员授权（仅管理员）',
  usage: '[status|allow|revoke|list|user add <@用户|user_id>|user remove <@用户|user_id>]',
  channelPlane: true, agentScoped: false,
}
```

| 用法 | 场景 | 行为 |
|---|---|---|
| `/auth` / `/auth status` | 任意 | 显示：当前是否管理员、本群/本私聊是否已授权、白名单数量 |
| `/auth allow` | 群聊（管理员） | 把**当前群**加入群白名单，回执“已授权本群” |
| `/auth revoke` | 群聊（管理员） | 把当前群移出白名单，立即生效 |
| `/auth user add <@用户\|user_id>` | 私聊/群聊（管理员） | 加入用户白名单；`@成员` 取 mention 里的 user_id，忽略对机器人的 @，没有 user_id 的外部用户被拒绝 |
| `/auth user remove <open_id>` | 同上 | 移出用户白名单 |
| `/auth wiki add <@用户\|user_id>` / `/auth wiki remove <@用户\|user_id>` | 同上 | 加入/移出知识库白名单（`access_wiki_users` 表）：只决定该用户发起的话题能否使用知识库工具，不授予对话权限；管理员始终可用 |
| `/auth list` | 任意（管理员） | 列出群白名单、用户白名单与待处理申请 |

- 非管理员发 `/auth` 一律拒绝（先校验管理员身份，再解析子命令）。
- 回复用现有 `delivery.commandCard`（固定文本，不调模型）。
- 所有变更写审计日志（`ctx.logger.info`）。

### 5.6 话题所有权补洞

- `handle()` 的话题路由分支：`if (!access.ownsRoute(msg, record)) { rejectForeignThread; return }`
  - `ownsRoute` 同时校验 `record.senderOpenId === msg.senderId` **和** `record.chatId === msg.chatId`（防跨群 id 碰撞），再叠加准入判定。
  - 默认静默；`unauthorizedReply: 'once'` 时回“此话题属于其他成员，请 @ 我开启新话题”。
- `archiveAttachments()`、`tryAnswerPendingQuestion()`、`continueSession()` 同样校验 `msg.senderId === record.senderOpenId`。
- `tryAnswerPendingQuestion` 需把回答者身份传进 `QuestionAnswerer.submitText`（`src/interactions/questions.ts:240-253`），与 pending entry 的 `route.senderOpenId` 比对。
- **不依赖 accessMode**：即使 `accessMode: 'open'` 也修，因为这是跨用户上下文注入。

### 5.7 卡片回调接线

`src/service.ts:741-744` 的 `channel.onCardAction(...)` 当前只分发给 approval 和 question 两个 answerer，追加 `access.onCardAction(event)`：

- 按钮 `value = { token, action: 'allow' | 'deny' }`；
- `operator.openId` 必须 === `adminOpenId`，否则首次点给“仅管理员可操作”提示（不改状态、不重复提示）；
- 结算后 patch 卡片为终态（已授权/已忽略/已过期），请求表更新 status；
- 幂等：同一 token 只能结算一次，重放/旧卡点击 patch 到终态即可。

### 5.8 入群事件（必做，无开关）

扩展 `src/feishu-channel.ts` 的窄接口（保持可 stub）：

```ts
onBotAdded(handler: (event: BotAddedEvent) => void | Promise<void>): () => void
getChatInfo(chatId: string): Promise<ChatInfo>   // 群名、群主、成员数（授权卡展示）
```

SDK 的 `LarkChannel` 已内置 `EventMap['botAdded']`（`im.chat.member.bot.added_v1`）与 `getChatInfo()`，wrapper 只需透传。机器人被拉进任意群后，**私聊给管理员发一张“群信息”卡**：

- 内容：群名（`getChatInfo().name`，权限不足/失败时省略）、`chat_id`、成员数、群主、邀请人（`botAdded.operator`）、加入时间；
- 群**未授权**：卡片附「授权本群 / 忽略」按钮——这就是“通过对话授权群”的入口；
- 群**已授权**：只发信息卡并标注“该群已授权”，不重复授权；
- 管理员未配置：只记申请（面板可见），启动日志提示；配置管理员后可在面板处理；
- **即使管理员自己拉机器人进群，也不自动授权**（符合“只有我授权才开启”）。

私聊投递失败（例如管理员尚未与机器人建立会话、权限不足）时降级为面板「待处理申请」，不向群里发任何消息。

飞书侧需要订阅 `im.chat.member.bot.added_v1`，`getChatInfo` 需要群信息读取权限（`im:chat:readonly` 一类，以控制台为准）。**未订阅事件时拿不到“入群”时机**，只能退化为“第一次未授权 @ 时补发群信息/授权卡”；`getChatInfo` 失败时卡片仍会带上 `chat_id` 等可获取字段。

### 5.9 申请生命周期

- 申请来源只有两种：**入群通知**与**已授权群内未授权用户 @**；私聊不产生任何申请卡。
- 每个目标同时最多 1 条 pending；同一目标被拒后 24h 内不重复推卡；管理员收卡全局限流（如 10 条/小时）；pending 总量上限（如 200）。
- 申请卡持久化 token → 重启后点击仍能结算；过期后点卡 patch 为“已过期”。
- 结算动作（允许/拒绝）与面板“待处理申请”列表共用同一个 `resolve` 函数。

## 6. 授权交互流程

### 场景 A：首次配置（管理员）

1. 装好插件、配好凭据、重启；启动日志：
   `[dsh-channels] 准入=guarded，管理员未配置：所有对话将被拒绝；私聊机器人发送 /userid 获取 open_id`
2. 在飞书私聊机器人发 `/userid`（任何私聊发送者都可用，只回固定文本、不建会话）→ 拿到 `ou_xxx`；
3. Web 面板「飞书渠道 → 访问授权 → 管理员 open_id」填入 `ou_xxx` 保存（立即生效）；
4. 面板状态显示管理员已配置；管理员私聊可正常对话。

### 场景 B：给非管理员开启群的访问（三种入口）

> 管理员本人在任何群里都能直接对话，不需要先授权群；授权群的目的是**让白名单用户也能在该群对话**。

1. **对话命令**：管理员在群里发 `/auth allow` → 群加入白名单 + 群内回执；
2. **入群通知卡**：机器人被拉进群 → 管理员私聊收到群信息卡（群名 / chat_id / 成员数 / 邀请人）→ 未授权时点「授权本群」；
3. **设置面板**：管理员从群内 `/groupid` 拿到 chat_id，在 Access 卡片里添加；或从「待处理申请」列表一键授权。

### 场景 C：给用户授权（三种入口）

1. **对话命令**：管理员发 `/auth user add ou_xxx`（私聊或群聊均可）；
2. **授权卡**：已授权群里，未授权用户 @ 机器人 → 管理员私聊收到“用户授权申请卡”（显示昵称/open_id/所在群）→ 点「授权用户」；
3. **设置面板**：面板「已授权用户」输入 open_id 添加，或从「待处理申请」列表一键授权。

> 用户白名单是**全局**的：一个用户被授权后，可在所有已授权群里使用；**私聊仍只开给管理员**，与用户白名单无关。如果以后需要“逐群授权用户”，在 `access_users` 表加 `chatId` 字段即可扩展，不破坏现有数据。

### 场景 D：未授权访问

- 未授权群里非管理员 @ 机器人：不建会话、不回复；管理员收到群信息/授权卡（入群时已发，或首次触发时补发）；
- 已授权群里未授权用户 @ 机器人：不建会话、不回复；管理员收到用户授权申请卡（同一用户有冷却去重）；
- 未授权用户私聊：回固定提示“非管理员禁用私聊功能哦”（见 §5.3），不建会话、不推卡。
- 机器人被拉进**已授权**群：管理员仍会收到群信息卡，但标注“已授权”、不带授权按钮。

### 场景 E：撤销 / 收权

- 群：管理员群内 `/auth revoke`，或面板「已授权群」移除；
- 用户：`/auth user remove ou_xxx`，或面板「已授权用户」移除；
- 立即生效：下一次消息就按新状态判定；已存在的 Session/话题不删除，但该主体再发消息会被拒绝。

## 7. Web 面板

### 7.1 访问授权新增字段（`access` 组）

| key | kind | 说明 |
|---|---|---|
| `adminOpenId` | text | 管理员 open_id（`ou_` 开头）；帮助文案“私聊机器人发 `/userid` 获取；不是 user_id/邮箱” |
| `accessMode` | select | `guarded`（默认）/ `open`（不安全，仅调试） |
| `authRequestTtlDays` | number（天） | 授权卡有效期 |

> 私聊只开给管理员（非管理员回固定提示）、`/userid` 对所有私聊开放、入群通知与用户授权申请都是固定行为：这些都不提供开关。

无需新增 FieldKind（白名单不在通用表单里，由 Access 卡片管理）。

### 7.2 新卡片「访问与授权」

数据来自新接口（读 GET；写操作复用 `isSameOriginRequest`）：

- `GET /dsh-channels/access`
  ```ts
  {
    mode: 'open' | 'guarded',
    admin: { openId?: string, configured: boolean },
    groups: Array<{ chatId, name?, source, addedAt }>,
    users: Array<{ openId, name?, source, addedAt }>,
    requests: Array<{ token, kind: 'group'|'user', targetId, name?, chatId?, groupName?, requester?, createdAt, expiresAt }>,
    recentAudit: Array<{ at, action, kind, targetId, actor }>,   // P3
  }
  ```
- `POST /dsh-channels/access/groups` `{ chatId, name? }`
- `DELETE /dsh-channels/access/groups` `{ chatId }`
- `POST /dsh-channels/access/users` `{ openId, name? }`
- `DELETE /dsh-channels/access/users` `{ openId }`
- `POST /dsh-channels/access/requests` `{ token, decision: 'allow' | 'deny' }`（与飞书卡片走同一结算函数）

UI：

- 顶部警示条：`guarded` 且管理员未配置时红字提示“当前会拒绝所有对话，请先配置管理员 open_id”；
- 「管理员」行：显示当前 open_id / 未配置（编辑在上方准入表单里）；
- 「已授权群」列表：群名（未知时显示 chat_id）、来源、时间 + 移除；输入框可手填 chat_id 添加；
- 「已授权用户」列表：昵称（未知时显示 open_id）+ 移除；输入框可手填 open_id 添加；
- 「待处理申请」列表：群申请 / 用户申请，各带「授权」「忽略」；
- 引导文案：怎么拿 open_id（`/userid`）、怎么拿 chat_id（`/groupid`）、三种授权入口。

## 8. 安全细节

- **群内静默默认**：未授权不回复，避免扫群探测；私聊对非管理员只回固定提示（不建会话、不推申请卡）。
- **防骚扰/防刷**：每目标最多 1 条 pending；被拒后 24h 冷却；管理员收卡全局限流；pending 上限；超限最旧过期。
- **不泄露内部信息**：未授权提示固定文案；健康卡不暴露管理员 open_id；申请卡只发管理员私聊，不发群。
- **token 不可伪造**：按钮只带不透明 token，服务端查表；不把 `chat_id + action` 拼进 value。
- **管理员身份**：只用 `operator.openId`/`senderId` 精确匹配 `adminOpenId`；不通过对话修改管理员。
- **撤销即时**：判定每次读内存 Set（写穿 domain 后更新），不做 TTL 缓存。
- **审计**：授权/撤销/拒绝全部 `ctx.logger.info`（P3 落审计表并在面板展示）。
- **Web 面板残余风险**：面板本身仍无鉴权（`README.md:88` 已声明），只有同源写保护；把白名单管理放面板意味着**本机访问 = 可授权**。若需要更强边界，后续单独给面板加 token/回环限制。
- **飞书侧外层**：建议应用可用范围只保留必要人员；准入是第二层，不替代平台 ACL。
- **群解散/机器人被移出**：SDK `EventMap` 没有 bot removed 事件；短期靠面板撤销兜底，P3 再评估直接订阅 `im.chat.member.bot.deleted_v1`。
- **其它机器人/应用发送者**：`guarded` 下它们不是管理员/未授权用户，会被准入挡掉。
- **错误脱敏**：入站异常兜底文案不要原样拼 `String(error)`，去掉本地绝对路径与 session/token 片段。

## 9. 兼容性与迁移

- **行为变化**：升级后 `accessMode` 默认 `guarded`；未配置 `adminOpenId` 的部署会“静默不响应”（fail closed）。发布说明与启动日志必须显著提示，并提供：
  - 启动日志 `console.warn`；
  - Web 面板红条；
  - `/userid`、`/groupid` 仍可用（引导配置）。
- 想保持旧行为：显式设 `accessMode: 'open'`。
- `feishuDomain.version` 保持 1（原因见 §4.2）；新增表对旧存档兼容。
- 现有 service 测试大量用 `ou_owner`/`ou_alice` 造消息；需要在 `tests/service.test.ts` 的 `makeConfig()` 默认加 `accessMode: 'open'`（或把测试发送者设为管理员），新增准入测试单独覆盖 `guarded`。
- 文档更新：`README.md`（功能、配置样例、行为与降级、飞书侧准备）、`docs/feishu-onboarding.md`（授权事件/权限、首次配置管理员步骤）。

## 10. 实施分期

### P1：面板可用的核心准入

- [x] config 字段 + zod 校验 + overlay 支持（`config.ts`、`settings/contract.ts`、`settings/surface.ts`）
- [x] `src/access/policy.ts` 纯函数决策 + 单测（矩阵穷举：管理员/用户/群三层组合）
- [x] `src/access/store.ts` + `src/domain.ts` 三张新表（version 1）
- [x] `InboundRouter` 接入 `access.admit`；话题/附件/问答/续写的 sender + chatId 校验
- [x] 命令面准入：`/userid`、`/groupid` bootstrap 放行；`/auth` 管理员专用；其他命令（含非法/未知命令）先判准入再发卡
- [x] `/auth` 核心子命令：`status` / `allow` / `revoke` / `list` / `user add|remove`
- [x] Web 面板：「访问授权」标签页加 `adminOpenId`/准入模式；白名单卡片（群/用户增删，自动授权仍无开关）；`/dsh-channels/access*` 路由（同源写保护）
- [x] 入群事件接线（wrapper `onBotAdded` + `getChatInfo`）：管理员私聊收群信息卡，未授权群附「授权本群 / 忽略」按钮
- [x] 管理员引导：启动日志、`/userid` 文案、面板未配置警示
- [x] 错误兜底文案脱敏
- [x] 测试：未授权私聊/群聊/话题注入/附件/命令（含未知命令）/问答；管理员与白名单放行；面板 API 同源与校验；撤销即时生效

**验收**：面板配置管理员后，只有管理员能私聊；管理员在任意群（含未授权群）都能直接对话；非管理员需要“群已授权 + 用户在白名单”才能对话；非授权主体不产生任何模型调用/Session/工作区/附件写入；话题注入被拒；撤权立即生效。机器人被拉进新群 → 管理员私聊收到群信息卡（群名/chat_id/成员数/邀请人），点「授权本群」后白名单用户可在该群对话。

### P2：飞书内授权闭环（卡片 + 申请）

- [x] `src/access/requests.ts` + `cards.ts`：用户授权卡（入群群信息卡已在 P1）、结算/过期/重启后可点
- [x] 已授权群内未授权用户 @ → 懒触发用户授权申请（去重 + 冷却 + 限流）
- [x] 面板「待处理申请」列表 + 结算 API（与卡片共用结算函数）
- [x] 测试：卡片管理员 gate、允许/忽略结算、幂等、过期、重启后点卡、限流

**验收**：已授权群里未授权用户 @ → 管理员收到用户授权卡（含昵称/open_id/所在群）；点「授权」后该用户下一次消息即可用；不点则静默；用户卡与入群卡共用结算逻辑，重启后旧卡仍可点、过期卡显示已过期。

### P3：增强

- [ ] 审计表 + 面板最近记录
- [x] `/auth user add @成员`（用 mention 里的 user_id）
- [ ] 逐群用户授权（`access_users.chatId` 可选作用域）
- [ ] bot removed / 群解散的授权回收（评估直接订阅原始事件）
- [ ] health/status 暴露 `accessMode`、`adminConfigured`、pending 数
- [ ] HITL 审批卡私聊化 / 附件大小类型上限
- [ ] 管理员自己拉群时可选自动授权

## 11. 备选方案

- **只用飞书应用可用范围**：无法表达“机器人可以在群里、但只有管理员和授权用户能对话”，不满足需求。
- **只用 SDK 静态白名单**（`dmMode: 'allowlist'` + `dmAllowlist` / `groupAllowlist`）：静态、群粒度只有整群、在插件前丢事件、无法发授权申请；且用户授权与群授权的“与”关系无法表达。只适合兜底。
- **静态配置白名单**（把群/用户列表放进 profile config，不做面板/对话管理）：改动最小，但与你要求的“对话 + 面板授权”不符，且每次改配置要动文件。
- **本文档方案（插件级准入 + 持久化白名单 + 对话/面板双入口）**：满足全部要求；代价是 `src/access/` 模块、三张 domain 表和一张面板卡片。

## 12. 实施状态与已知缺口

**已实现（P1 + P2）**：管理员 open_id 面板配置、**管理员不受白名单限制（任意私聊/群聊均可直接发起会话）**、非管理员需要群白名单 + 全局用户白名单（两层 AND）、私聊仅管理员（非管理员固定提示、`/userid` 对所有私聊开放）、`/auth` 命令（status/allow/revoke/list/user add|remove）、入群群信息卡（未授权附「授权本群/忽略」）、已授权群内未授权用户的用户授权申请卡、设置面板「访问与授权」卡片与 `/dsh-channels/access*` 接口、话题/附件/问答/续写的 sender+chatId 校验、撤销立即生效。测试：`tests/access-policy.test.ts`、`access-store.test.ts`、`access-runtime.test.ts`、`access-inbound.test.ts`。

**已知缺口（P3 / 后续）**：
- 管理员收卡全局限流（10/h）与 pending 总量上限未实现（当前只有每目标 pending 去重 + 拒绝后 24h 冷却）；
- 管理员未配置时收到入群事件只记日志，不落申请记录（面板看不到）；
- 面板结算的 grant `source` 记为 `card`（与飞书卡片共用结算函数），若要区分来源可加参数；
- 授权申请过期目前只在启动时清扫一次；运行中依赖结算时判断；
- 逐群用户授权、bot removed 自动回收、审计表与面板最近记录等按 §10 P3 处理。

# dsh-channels 准入与授权（Access Control）设计

> 状态：已实现。用户一律以飞书 `user_id` 标识（见 README「飞书侧准备」的 `contact:user.employee_id:readonly` 权限）。

## A. 用户表与权限开关

### A.1 规则

- **管理员**是用户表里 `admin` 为 true 的用户，拥有全部权限，其他开关对他不起作用；可以有多个，只能在 Web 设置面板设置，飞书 `/auth` 不能授予或移除。用户表里没有管理员时 `guarded` 拒绝所有对话。授权申请卡发给每位管理员，任一位处理后其他卡片同步更新。
- **用户表**（`access_users`）每人一条记录，四个独立开关：

| 开关 | `/auth set` 名称 | 面板标签 | 作用 | 新用户默认 |
|---|---|---|---|---|
| `chat` | `chat` | 对话 | 可以私聊，也可以在任何群里 @ 机器人；关闭等于停用，其他开关一并失效 | 开 |
| `wikiRead` | `wiki-read` | 读知识库 | 该用户的私聊话题可以用知识库读取类工具 | 关 |
| `wikiWrite` | `wiki-write` | 写知识库 | 该用户的私聊话题可以用知识库新建、修改类工具（不依赖 `wikiRead`） | 关 |
| `codeWrite` | `code` | 改代码 | 该用户的私聊话题可以做代码改动类写操作（`access/authorize` 的 `code-write` 和 `codeWriteTools`） | 关 |

- 开关之间没有隐含关系，只有 `chat` 关闭会让其他开关失效（记录和开关值保留）。
- 准入只看发送者：私聊和群聊同一规则，没有群白名单。对话准入打开的人自己把机器人拉进的群里也能直接用。
- **群权限**（`group_permissions` 表，`src/access/store.ts`）：群话题的三个工具开关 `wikiRead` / `wikiWrite` / `codeWrite` 属于群而不属于人，群里首次开话题时自动登记（全关），只能在设置面板「群权限」修改或移除。工具判权看**会话所在位置**（`AccessController.mayUseOnRoute`）：私聊路由看本人的开关（管理员直通），群里的路由（话题和降级的会话级路由都算）看群记录（没有记录等于全关）。
- **群话题归群**（`isGroupRoute`：路由的 `chatType` 是 `group`）：群里通过准入的成员都能续写、点卡、执行会话命令；`senderUserId` 只记开话题的人，`lastSpeakerUserId` 记最近发言人。排在运行中回合后面的消息送入会话前再查一次准入，对话权限已关闭的发送者收到「你的对话权限已被关闭」提示，消息不进会话。
- `accessMode: open` 只放开对话准入；知识库和代码改动开关仍然按用户表判断（不在表里的人没有这两类权限）。
- 实现：纯策略 `src/access/policy.ts`（`AccessSnapshot.users` 是 `chat` 打开的 user_id 集合），持久化 `src/access/store.ts`（`allows(userId, permission)` = 记录存在且 `chat` 打开且该开关打开），入口 `AccessController.mayUse(userId, permission)` = 管理员或 `store.allows`。

### A.2 授权入口

| 入口 | 操作 |
|---|---|
| 飞书 `/auth`（仅管理员） | `status`、`list`、`add <@用户\|user_id>`（加入并打开 `chat`；已在表里只重新打开 `chat`）、`remove …`、`set <chat\|wiki-read\|wiki-write\|code> <on\|off> …`（人必须已在表里） |
| 用户授权申请卡 | 不在表里的人在群里 @ 机器人，或把机器人拉进群时发给管理员；「授权用户」= 加入并只打开 `chat`。同一人有未处理申请或刚被忽略时不重复发 |
| Web 面板「访问授权」 | 添加、移除、逐个切换四个开关（`POST /api/dsh-channels.setAccessPermission`） |

被拉进群时，邀请人是管理员或对话准入打开的用户，管理员只收到一张没有按钮的群信息卡。

### A.3 代码改动闸门（`src/access/code-write.ts`）

- 插件在宿主 `tools/pre-execute` 瀑布注册监听；工具名在 `codeWriteTools` 里、且调用方 Session 属于飞书路由时按路由所在位置检查（`mayUseOnRoute(route, 'codeWrite')`），否则直接交给下一个监听。
- **归属**：Session 本身有路由，或沿 `parentSession` 追溯到有路由的 Session（子代理、嵌套子代理）。每次调用都记下 Session 到路由根的对应关系。
- **发言人**（只用于提交尾注和作者，不参与判权）：`agent/inbox/claimed` 认领的那条用户消息在来源里写明的飞书用户。插件的每条飞书提示都由调用方自己的进程内 Peer 经 DSH `session/prompt` 提交，DSH 写下 `source: { kind: 'user', rpcId, principal }`：私聊 `{ kind: 'feishu-user', userId }`，群聊 `{ kind: 'feishu-group', chatId, userId }`（共享话题里的追问、启动话题的首条提示、恢复按钮的点击人都写各自的 user_id），见 `src/access/principal.ts`。来源是消息的一部分，随会话日志持久保存；在途快照存请求 id、调用方和内容，重放时以同一调用方重新提交，插件不在内存里另记消息与发送者的对应。没有 `principal` 的消息（Host 所有者、斜杠命令展开、子代理结果、后台任务、定时任务）沿用上一位；`principal` 不是合法飞书用户或群时发言人不明；从未认领过时按路由记录的 `lastSpeakerUserId`，再按开话题的人。
- 路由所在位置没有 `codeWrite` 时返回 `deny`：私聊写明用户和开通方式，群话题写明到「群权限」打开；模型据此转告用户。检查在工具自身审批之前，不受工具审批模式影响。
- 只拦列出的工具，不拦本地文件编辑与 shell。状态只在内存里，关闭时清空。
- 写操作先问权限：其他插件在写之前发 `access/authorize` 事件（`session`、`level`、`action`、`summary`；类型同样在 `src/host/core.ts` 自行声明），插件把会话顺着 `parentSession` 解析到所属话题后按位置回答：`code-write` / `wiki-read` / `wiki-write` 看本人或群的对应开关，`admin` 只给私聊里的管理员，群会话和未知级别一律拒绝；非飞书会话不回答。拒绝以中文原因抛出，发问方不再问用户。
- 发言人写进提交：插件监听 dsh-repo 的 `repo/commit-trailers` 事件（事件类型在本插件 `src/host/core.ts` 里自行声明，不依赖 dsh-repo 的包），对飞书会话及其子代理（已见过调用的，或经 `parentSession` 找到所属话题的）追加 `Feishu-User: 名字 <user_id>`；群话题先追加 `Feishu-Chat: 群名 <chat_id>`，提交由令牌账号署名，不设作者。名字取通讯录，其次用户表，去掉 `<` `>`、空白和控制字符合并为一个空格、最多 80 个字符；读不到名字时只写 user_id。
- 私聊的发言人也可以是提交作者：用户表记录有可选的 `gitEmail`，只能由管理员在设置面板填写（`/api/dsh-channels.setAccessGitEmail`，去掉首尾空白，必须是一个不含空白、`<`、`>` 的 `local@domain`，最长 254 个字符，空值清除）。发言人有 `gitEmail` 时，监听者在追加尾注之外调用事件的 `setAuthor(名字, gitEmail)`，名字同尾注，读不到时用 user_id；提交者仍是 dsh-repo 的令牌账号。用户不能自己登记邮箱，避免以同事的名义提交。事件没有 `setAuthor`（旧版 dsh-repo）时只加尾注。
- `codeWriteTools` 默认为空：写操作的插件经 `access/authorize` 发问，由上面同一套规则回答；只有不发问的第三方工具才需要按名字列进来。

### A.4 存储

- `access_users`（user_id → 管理员标记、四个开关、可选 `gitEmail`）、`access_requests`（token → 申请与发给各管理员的卡片 `messageIds`）、`group_permissions`（chat_id → 三个开关），都在 `dsh_channels` 域。
- 断连补偿读取的群在域全局值 `knownGroups`（机器人入群时记录，最多 500 个）。

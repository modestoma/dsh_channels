# P1 静默登记：仅附件消息与未触发消息的元数据登记

## 目标、范围与非目标

实现“静默登记”：对不触发模型回合的入站消息（私聊仅附件；群聊未 @；已绑定话题内的纯附件消息等），只记录附件的元数据，不下载、不回复、不加表情；供后续触发消息的 prompt 清单与工具取用。

范围：

- `channels_routes` 域新增 `pending_attachments` 表（schema 版本按宿主能力处理；无法增表时退化为进程内 TTL 存储并记录限制）。
- 记录字段：`scopeKey`（`chat / thread? / sender` 组合）、`messageId`、`chatId`、`chatType`、`threadId?`、`senderOpenId`、`receivedAt`、`kind`（image/file/post/merge_forward）、`resources[]`（type/fileKey/fileName/containerMessageId?）、`textExcerpt?`、`consumed?`。
- 查询：按会话/话题/发送者取最近 N 条；清单只展示最近 5 条；工具取用后标记 consumed 并停止出现在清单。
- 隔离：只按本发送者在本次会话/话题内的消息登记；群内他人消息不进入你的清单；未通过准入的消息不登记。
- 清理：TTL（默认 7 天）+ 每 scope 上限（默认 10 条），由现有周期 GC 清扫；`acceptAttachments=false` 时不登记。
- 提供窄 API 给准入层（注册）与工具/清单层（查询/消费）；本任务不接准入调用点（由 `admission_manifest_flow` 接）。

非目标：不下载资源；不发送任何飞书消息；不改 prompt 内容本身。

## 前置产物与解除条件

依赖 `platform_spike` 的 AC4/AC5 结论（未 @ 群消息事件是否投递、合并转发容器识别），以确定登记覆盖面与字段。

## 验收条件与验证方法

| AC | 验证方法 | 通过标准 |
| --- | --- | --- |
| AC1 域表与读写 | 单元测试 + `roadmap` 无关的 `pnpm test` | 新增/查询/消费/TTL 正确；旧数据不受影响 |
| AC2 隔离 | 单元测试 | 同群不同发送者、不同话题互不可见；未准入不登记 |
| AC3 上限与清理 | 单元测试（假时钟） | 超上限淘汰最旧；TTL 到期清理；GC 幂等 |
| AC4 无副作用 | 单元测试 | 登记路径不调用下载、不发送消息、不加表情 |
| AC5 降级 | 单元测试 | 域不支持时走内存 TTL；`acceptAttachments=false` 直接 no-op |
| AC6 构建 | `pnpm typecheck` | 通过 |

## 决定、授权与待答

- 用户决定：仅附件消息采用静默登记；不下载、不回复。
- 待答：群聊未 @ 消息若事件无法投递，登记覆盖面下降——P0 结论后确认是否要求“发文件时 @”。

## 验证与交付证据

### 环境与基线（2026-10-21）

- 仓库 `/Users/moka/dev/project/dsh_ext/dsh_channels`，本地 `main`；开始基线 `main@5769f5c14f793679df16e7d887aebdf2c336a68b`。按 D9/D10 不创建平台 Issue/Milestone、不拉分支/worktree、不使用 PR，仅在本地 `main` 提交，不推送。
- Node v24.19.0 / pnpm 12.14.0；DSH 0.2.1-rc.2 desktop profile（`include:storage-json` 为当前 kv 后端）。
- 实现提交：`6b95165c1d2731b8ecd417792dc7d384d968edeb`（feat，含实现与测试）；`ab483162a81114a377030a012314f60300807417`（docs，仅注释澄清，无行为变化）。
- 本任务按 Issue 范围**不接 inbound 调用点**：登记 API 已就绪，实际入站调用由 `admission_manifest_flow` 接线。

### 实现落点

| 产物 | 文件 | 说明 |
| --- | --- | --- |
| 域表与记录 schema | [src/domain.ts](../../../src/domain.ts) | `pending_attachment` 的 kind/resource/record schema、`pending_attachments` 表（域仍 `version: 1`）、`PendingAttachmentsTable` 与可选 handle 字段 |
| 静默登记注册表 | [src/feishu/pending-attachments.ts](../../../src/feishu/pending-attachments.ts)（新增） | `PendingAttachmentStore`：`registerMessage`（需显式准入、`acceptAttachments` 开关）、`list`（最近 5 条窗口）、`get`/`consume`（scope 绑定白名单）、`prune`（TTL+上限）、内存 TTL 降级；候选提取 `pendingAttachmentCandidate`/scope key helper |
| 配置 | [src/config.ts](../../../src/config.ts) | `pendingAttachmentTtlMs`（默认 7 天，0 关闭 TTL）、`pendingAttachmentLimit`（默认 10/scope） |
| 周期 GC 接线 | [src/service.ts](../../../src/service.ts) | 打开域表（取表失败可缺省→内存降级）、构造注册表、在既有 `gcExpiredEntries` 中无条件 `prune`（`routeTtlMs=0` 时也执行） |
| 测试 | [tests/pending-attachments.test.ts](../../../tests/pending-attachments.test.ts)（新增） | 33 项覆盖 AC1–AC5、域增表兼容、config 边界与 service 启动 GC；[tests/service.test.ts](../../../tests/service.test.ts) 仅在 `makeConfig` 补两个必填默认值 |

### 逐条 AC 验证

| AC | 验证方法 | 实际结果 | 结论 |
| --- | --- | --- | --- |
| AC1 域表与读写 | 单元测试 + `pnpm test` | 新增/查询/消费/TTL 均有真断言（6 项 core）；重复投递按 message id 幂等不重写；TTL 恰好到期即过期，到期后同 id 可重新登记；`get` 对已消费行仍可查（白名单重试）；record schema 严格校验 | ✅ |
| AC2 隔离 | 单元测试 | 同群不同发送者、不同话题、同话题不同 chat 互不可见；thread route 额外可见「同 chat + 同 sender 的 chat 主时间线行」（群未 @ 发文件→之后 @ 建话题仍可引用的 AC-4 场景），其他 sender/topic/chat 一律拒绝；`get`/`consume` 均要求 route scope，已知 message id 无法越权（含跨 chat 负向与 consume 不触发 update 断言）；未准入、非附件消息、`acceptAttachments=false` 零写入 | ✅ |
| AC3 上限与清理 | 单元测试（假时钟） | 超上限淘汰最旧（先 put 后淘汰；固定时钟并列时**不淘汰刚写入的记录**）；TTL 到期清理；`prune` 两次调用幂等；GC 按 scope 兜底收敛超限；单条删除失败不中断；`routeTtlMs=0` 时 service 启动 sweep 仍清理 pending（service 级测试） | ✅ |
| AC4 无副作用 | 单元测试（结构性） | 注册表依赖仅注入表/开关/TTL/上限/时钟/warn，无 channel、无 fs、无附件库引用；登记仅写一条 metadata（无 update/delete、无 base64/字节），失败仅 warn 不抛 | ✅（本任务无 inbound 调用点，真机入站静默行为待接线验证） |
| AC5 降级 | 单元测试 | 域表缺失时 `mode()=memory`，TTL/cap/consume/prune 语义与持久表同测，降级限制只告警一次；`acceptAttachments=false` 直接 no-op；写失败返回 `storage-error` 且不淘汰旧行；畸形记录返回 `invalid-message` 不污染域。**内存降级的 service 级路径当前不可达**：`storageDomain` 是 inject 必需服务，domain 整体打不开时启动直接失败；只有「domain open 成功但宿主拒绝该新增表」才会走到降级，属防御性实现 | ✅（store 级）/⏳（service 级路径不可达，见未验证项） |
| AC6 构建 | `pnpm typecheck` / `pnpm test` / `pnpm build` | 全部通过（见下） | ✅ |

### 命令与结果（2026-10-21 本机）

```text
pnpm typecheck   -> exit 0（tsconfig.json + tsconfig.client.json）
pnpm test        -> 27 files passed / 656 tests passed（新增 tests/pending-attachments.test.ts 33 项；基线 623）
pnpm build       -> host lib/index.js 437.00 kB（gzip 126.45 kB）+ client lib/client.js 125.40 kB，均 Build complete
git diff --check -> exit 0
```

（评审过程中间轮次为 649/655 项，最终以 656 为准；注释修正提交 `ab48316` 后已重跑 typecheck/test(656)/build 确认无行为变化。）

### storageDomain 增表兼容结论（含实测）

**结论：宿主支持在同一 domain 版本内新增表，不需要版本升级或迁移，旧数据不受影响。** 依据：

1. `dsh-storage-domain@0.1.1-rc.2` 的 `DomainFacility.open()` 用 `snapshot.tables[table] ?? {}` 初始化每个声明表（`lib/index.js` open 流程），缺少的声明表按空表处理；
2. `dsh-storage-json@0.1.1-rc.2` 的 `parse()` 只遍历 **descriptor 的声明表**，存档中缺少的声明表创建为空 Map，且要求存档 `unit.version` 严格等于 descriptor version（`version-mismatch` 拒绝）；
3. `serialize()` 只写当前声明的 `state.tables`，因此新表在首次 domain 写入时落盘，`unit.version` 仍保持 1。

实测方法：用已安装宿主包 `JsonStorageBackend` 对**真实存储文件副本**（`~/.dsh/storages/channels_routes.json`；`unit={"name":"channels_routes","version":1}`，7 表，routes 21 条）做只读/临时目录实验，不触碰线上文件：

```text
[stored] unit={"name":"channels_routes","version":1} tables=routes,inflight,processed,expired_routes,access_groups,access_users,access_requests routes=21
[open +added table] routes=21 pending=0 oldTables=...,pending_attachments
[reopen] pending=om_compat_probe routes=21 unit.version=1
[old build write] tables=routes,inflight,processed,expired_routes,access_groups,access_users,access_requests
[version bump] rejected: version-mismatch
```

- 现插件（8 表 descriptor）打开真实 v1 存档成功：routes 21 条原样、pending 空表、`global` 保留；写入 pending 后重新打开可读，旧表数据完好，version 仍 1。
- **降级限制**：旧 build（7 表 descriptor）打开新存档可读（多余表被忽略），但其下一次写入会按自己的声明序列化，**丢掉 `pending_attachments` 表**（含 TTL 内记录）。插件版本原地替换，且 pending 记录本身 7 天 TTL，丢失可接受；已写入代码注释。
- 若未来对既有表做破坏性 schema 变更，必须升版本 + 迁移；本任务不需要。
- 局限：上述结论只对当前 profile 的 **JSON 后端**成立；当前宿主未安装其他 kv 后端，未验证。

### 独立评审与修复

- teammate `pending-registry-reviewer` 做两轮只读评审（未写文件/未提交）。
- 首轮：无 blocker；必修项 M1「`get`/`consume` 未带 scope，工具层白名单授权契约不成立」，另提 m1 先淘汰后写、m2 写前 schema 校验、m3 folder 标记、m4 `[rich text message]` 占位、m5 降级边界措辞、m6 config 测试、m9 群聊 chat/thread 合并查询契约等。
- 已修复：`get`/`consume` 必传 route scope 并统一 `recordInScope`；chat-scope 回退语义内建（thread route 可见同 chat+sender 的 chat 行，支撑 AC-4）并补负向测试；先 put 成功后淘汰；写前 `pendingAttachmentRecordSchema.safeParse`（返回 `invalid-message`）；resource 增加 `folder?`；forwarded/占位文本不再当 caption；config 边界测试；注释与降级措辞对齐。
- 第二轮：确认 M1 与回退语义无新隔离漏洞；发现修复 m1 时引入「同 `receivedAt` 时可能淘汰刚写入记录」的回归（真实模块探针复现），要求修复 + 回归测试 + 写回证据。
- 已修复：`evictOverCap(..., keepKey)` 排除刚写入记录，候选按「老→新」删 excess；新增固定时钟、`limit=1`、注册顺序与 id 排序相反的回归测试；其余 minor（import 合并、注释、limit 计算、告警细节）一并处理。
- 第三轮只读复核：**放行，无必修项**。用真实模块探针复核 eviction `keepKey` 修复（固定时钟、cap=1/2/3、id 倒序连续注册、delete 失败、thread 联合可见 + limit），确认新记录始终在库、超限收敛与 clamp 符合设计；同时确认负向断言、隔离语义、typecheck/test(656)/build 与提交内容一致。非阻塞观察：两处注释措辞（已在 `ab48316` 修正并重跑 gates）、`prune` 并列 `receivedAt` 的淘汰顺序（见未验证项 11）、并发登记 best-effort（既有行为）。

### 下游接口约定（给 `attachment_fetch_tool` / `admission_manifest_flow`）

- 登记：准入通过后调用 `registerMessage(msg, { admitted: true })`；`acceptAttachments=false` 时注册表本身也会 no-op。
- 清单：`list(routeScope)`，默认返回最近 5 条未消费记录；thread route 已内置 chat 主时间线回退，**不需要下游自己合并两个 scope**；chat 主时间线查询不会看到 topic 行。
- 白名单：`get(routeScope, messageId)` / `consume(routeScope, messageId)` 必须传 route scope（由 route 记录构造：`{ chatId, threadId: kind==='thread' ? route.key : undefined, senderOpenId }`）；只按 message id 查询不提供。
- `consumed` 按 message id 全局标记：同 sender/同 chat 内任一 route 消费后，其他 route 的清单也不再展示（设计取舍，供 AC-4 跨 topic 引用时去重）；记录仍可按 id 查询以支持重试。
- 合并转发记录：`resources=[]`、`messageId` 为顶层容器 id（P0 容器规则），子资源由 fetch 工具按容器 id 取；`folder=true` 表示飞书文件夹，fetch 工具应返回结构化“不支持下载”。
- 配置面：`pendingAttachmentTtlMs` / `pendingAttachmentLimit`（Web 面板/文档由 `panel_docs_release` 暴露，本任务未改 `src/settings`）。

### 未验证项 / 已知限制

1. **真机入站静默登记未触发**：本任务明确不接 inbound 调用点，无真实飞书纯附件消息登记样本；AC-4 真机行为转 `admission_manifest_flow` 接线后验证。AC4 的「不下载/不发消息/不加表情」由依赖结构 + 单测保证。
2. **真实 profile HMR 重载冒烟未做**：本会话文件沙箱为 workspace-write，未改工作区外的 `~/.dsh/profiles/desktop/cordis.patch.yml` 触发 recomposition；宿主增表兼容性改用「真实存储文件副本 + 已安装宿主包」实测（上节）。插件启动后真实域打开 + 飞书连接时的 pending 表行为待接线后自然验证。
3. **内存降级的 service 级路径不可达**：`storageDomain` 缺失时 `start()` 直接失败，不会走到注册表降级；降级只覆盖「domain 打开成功但宿主拒绝新增表」的防御场景，仅 store 级单测。若未来宿主允许部分 storageDomain，需补 service 级测试。
4. **周期 6h GC 分支未单独测试**：启动 sweep 与周期 sweep 调用同一 `gcExpiredEntries`；测试验证启动 sweep（含 `routeTtlMs=0`），未用假定时器验证 6h 触发。
5. **其他 kv 后端未验证**：宿主当前只安装 JSON 后端；若部署换后端，需复核其缺表/版本语义。
6. **降级到旧插件版本会丢 `pending_attachments` 表**：JSON 后端按当前声明序列化；TTL 内记录会丢失（见上节限制）。
7. **上限/淘汰为 best-effort 非原子**：并发登记同一 scope 可能短暂超过上限（或各淘汰一条），由下一次 `prune` 收敛；单进程串行入站下风险低。
8. **JSON 后端逐条删除 = 逐条整文件重写**：一次大 TTL sweep 可能触发多次原子写；当前数据量（每 scope≤10、scope 数=群×用户）预计很小，未压测；无批量删除 API。
9. **Web 面板/设置契约未暴露新配置**：`pendingAttachmentTtlMs`/`pendingAttachmentLimit` 未加入 `EDITABLE_KEYS`，属 `panel_docs_release` 范围。
10. **`containerMessageId?` 字段已入 schema 但本任务不写入**：留给后续引用/合并转发子资源登记；当前 merged-forward 以记录自身 messageId 为容器。
11. **`prune` 并列 `receivedAt` 的淘汰顺序**：scope 超限（删除失败/并发登记/配置调低）时 `prune` 按 `receivedAt` 升序 + `messageId` 字典序删最旧；多条时间戳完全相等时字典序可能删到较新的一条。仅发生在超限收敛路径，当前无实际影响（已由第三轮评审确认为已知边界）。
12. **并发登记 best-effort**：`keepKey` 只保护本调用写入的记录；两个同 scope 并发登记在极端交错下仍可能互相淘汰旧行（单进程串行入站下风险低，`prune` 最终收敛）。

## 启动 Prompt（复制到新会话）

```text
你负责 attachment_pipeline_v2 / pending_attachment_registry 的实现。

仓库：/Users/moka/dev/project/dsh_ext/dsh_channels，本地 main 分支。
执行约束（decisions.md D9/D10）：不创建平台 Issue/Milestone；不拉分支/worktree；不用 PR；直接改本地 main 并本地提交；不推送、不合并、不发布；提交用 conventional commit。

开始前阅读：
1. .agents/issues/pending_attachment_registry.md（本任务正文与 AC）
2. .agents/roadmaps/attachment_pipeline_v2/roadmap.md 与 plan.json
3. .agents/roadmaps/attachment_pipeline_v2/decisions.md（D1–D10）
4. .agents/notes/2026_10_20_attachment_pipeline.md
5. .agents/issues/platform_spike.md 的 P0 证据（P0 收官 3f05d81；开始时以 git rev-parse HEAD 为准）
6. 相关源码：src/domain.ts、src/cleanup.ts、src/config.ts、src/service.ts 与现有 domain/cleanup 测试

P0 已验证、必须沿用的前提：
- 未 @ 的群消息事件会投递到机器人 → 静默登记可覆盖群聊；
- 合并转发需要用顶层容器 message_id 登记/下载，子消息 id 会失败；
- 纯附件消息在现行产品规则下不回复、不建会话、不下载。

任务：实现静默登记（细节以本 Issue AC 为准）：
- channels_routes 域新增 pending_attachments 表（记录 scopeKey / messageId / chatId / chatType / threadId? / senderOpenId / receivedAt / kind / resources[]（含 containerMessageId?）/ textExcerpt? / consumed?）；
- 查询/消费/TTL（默认 7 天）/每 scope 上限（默认 10，清单只展示最近 5）；
- 按 (chat, thread?, sender) 隔离；未通过准入不登记；acceptAttachments=false 时 no-op；
- 接入现有周期 GC；提供窄 API 给后续准入层与工具，但本任务不接 inbound 调用点。

预计写入范围（越界前先暂停询问）：src/domain.ts、src/feishu/pending-attachments.ts（新增）、src/cleanup.ts、src/config.ts、src/service.ts（仅 GC 调度接口时）、tests/pending-attachments.test.ts。注意确认 storageDomain 增加表的兼容方式；若宿主不支持增表，按 Issue 的“内存 TTL 降级”实现并记录限制。

完成标准：
1. 逐条满足 Issue AC；pnpm typecheck、pnpm test、pnpm build 全绿。
2. 把实际命令、结果、未验证项写回本 Issue 的“验证与交付证据”（含 storageDomain 增表结论）。
3. 若当前会话是协调者：同步 runtime.json 对应任务 resume 并保持 roadmap validate 通过（按 D10）；否则只更新 Issue。
4. 在 main 上本地提交（不推送）；最终回复：改动摘要、关键文件、测试结果、提交 SHA、风险/未验证项。
5. 遇到范围/接口变化先暂停，在 decisions.md 追加决定并询问用户。
```


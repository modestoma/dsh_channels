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

待执行。

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


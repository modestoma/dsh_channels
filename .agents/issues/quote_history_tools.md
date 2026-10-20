# P2 引用与话题历史：feishu_topic_messages 与引用摘录

## 目标、范围与非目标

让模型能访问“引用消息”和“话题内此前的消息/文件/图片”，并在新会话首轮自动获得有界的话题上下文。

范围：

- 消息读取薄封装（新模块 `src/feishu/message-read.ts`）：`message.get`、`message.mget`（≤50）、`message.list(container_id_type=thread)`；统一渲染 text/post/image/file/文件夹/合并转发条目，输出有界摘要与资源元数据。
- 引用摘录：入站消息的 `replyToMessageId`（飞书 `parent_id`）解析为摘录，进入 prompt 清单；被引用消息里的资源登记到本 route 白名单（含合并转发顶层容器规则：资源必须用容器 `message_id` 下载）。
- 新会话首轮：自动附带本话题最近 N 条消息摘要（`historyBootstrapLimit`，默认 10，可关；超长截断并标注）；更早的通过工具翻页。失败/无权限时静默降级，不阻塞首轮。
- 新工具 `feishu_topic_messages({ message_id?, limit?, cursor? })`：按 id 取单条，或分页列当前话题消息（默认 10、上限 50）；只允许当前 route 的 chat/thread；返回摘要 + 附件元数据，并把发现的资源加入白名单，供 `feishu_attachment_fetch` 取用。degraded chat 路由按 chat 容器处理（p2p 历史能力以 P0 结论为准）。
- permissions：`im:message:readonly` + 机器人读群消息所需 scope（如 `im:message.group_msg`，以开发者后台要求为准）；更新 onboarding 文档中的权限表与降级说明。

非目标：消息全文搜索；跨会话/跨用户读取；音频/视频专门处理。

## 前置产物与解除条件

依赖 `admission_manifest_flow` 的清单与 prompt 组装；依赖 `platform_spike` 的 AC4/AC5 结论（权限矩阵、父消息定位、合并转发容器下载）。

## 验收条件与验证方法

| AC | 验证方法 | 通过标准 |
| --- | --- | --- |
| AC1 引用文本 | service 测试 + 真机 | 引用消息摘录进入 prompt；被引用文件出现在清单并可取 |
| AC2 合并转发 | service 测试 + 真机 | 合并转发展开文本；子资源经容器 id 下载成功 |
| AC3 话题历史 | service 测试 + 真机 | 工具分页正确、输出有界；@ 之前的消息（权限范围内）可读 |
| AC4 首轮上下文 | service 测试 | 新会话首轮含最近 N 条摘要；超限截断标注；关闭配置生效 |
| AC5 授权隔离 | 单元测试 | 非本 route 消息 id 被拒绝；历史工具发现后才可下载 |
| AC6 权限降级 | 手动 + 日志/提示 | 缺权限时明确降级、不报死错、不影响普通对话 |
| AC7 构建 | `pnpm typecheck && pnpm test` | 通过 |

## 决定、授权与待答

- 用户决定：引用机器人消息但未 @ 在对话群主聊天区不触发；话题内保持无需 @。
- 待答：敏感权限无法获批时，“@ 之前消息”的覆盖范围与提示文案需用户确认。
- 待答：首轮自动上下文条数默认 10 是否合适（可配置）。

## 验证与交付证据

待执行。

## 启动 Prompt（复制到新会话）

```text
你负责 attachment_pipeline_v2 / quote_history_tools 的实现。

仓库：/Users/moka/dev/project/dsh_ext/dsh_channels，本地 main 分支。
执行约束（decisions.md D9/D10）：不创建平台 Issue/Milestone；不拉分支/worktree；不用 PR；直接改本地 main 并本地提交；不推送、不合并、不发布；提交用 conventional commit。

开始前阅读：
1. .agents/issues/quote_history_tools.md（本任务正文与 AC）
2. .agents/roadmaps/attachment_pipeline_v2/roadmap.md 与 plan.json
3. .agents/roadmaps/attachment_pipeline_v2/decisions.md（D1–D10）
4. .agents/notes/2026_10_20_attachment_pipeline.md
5. .agents/issues/platform_spike.md 的 P0 证据（P0 收官 3f05d81；开始时以 git rev-parse HEAD 为准）
6. 前置任务证据：admission_manifest_flow 及更早任务的“验证与交付证据”与对应提交
7. 相关源码：src/feishu-channel.ts（messageGet/messageList 已就绪）、src/feishu/tools.ts、src/routing/inbound.ts、src/session/manager.ts、docs/feishu-onboarding.md

P0 已验证、必须沿用的前提：
- bot 身份下 message.get 可取引用消息（parent_id / replyToMessageId 可定位）；
- message.list(chat) 在群聊可用且返回 code=0；message.list(thread) 可用；分页 page_size ≤50；
- 合并转发：message.get 返回扁平 items（容器+子消息），资源只能用顶层容器 message_id 下载，子消息 id 会 400；
- 未验证：机器人入群前历史是否可读、p2p message.list 是否可用——本任务必须补测并在文档/证据中如实降级；
- 工具输出必须 JSON 清洗、AbortError 可读。

任务：实现引用与话题历史（细节以本 Issue AC 为准）：
- 新增 src/feishu/message-read.ts：message.get / mget(≤50) / list(thread|chat) 薄封装与统一渲染（text/post/image/file/文件夹/合并转发），输出有界摘要与资源元数据；
- 引用摘录：把 replyToMessageId 解析为摘录进入 prompt 清单；被引用消息资源加入本 route 白名单（合并转发按容器 id）；
- 新会话首轮自动附带本话题最近 N 条摘要（historyBootstrapLimit，默认 10，可关，超长截断标注）；失败/无权限静默降级；
- 新工具 feishu_topic_messages({ message_id?, limit?, cursor? })：取单条或分页列当前话题消息（默认 10、上限 50），只允许当前 route 的 chat/thread；发现的资源加入白名单供 feishu_attachment_fetch 使用；
- 权限：im:message:readonly 等 scope 的说明与 onboarding 文档更新；缺权限时明确降级、不报死错。

预计写入范围（越界前先暂停询问）：src/feishu/message-read.ts（新增）、src/feishu/tools.ts（扩展）、src/routing/inbound.ts（引用摘录与首轮注入）、src/config.ts、docs/feishu-onboarding.md、tests/message-read.test.ts、tests/feishu-tools.test.ts（扩展）。需要真机验证的部分（引用/合并转发/话题历史/入群前历史）请列出操作步骤；若当前无法真机验证，在证据中标记“待用户手测”，不要用 mock 冒充。

完成标准：
1. 逐条满足 Issue AC；pnpm typecheck、pnpm test、pnpm build 全绿。
2. 把实际命令、结果、真机/未验证项写回本 Issue 的“验证与交付证据”。
3. 若当前会话是协调者：同步 runtime.json 对应任务 resume 并保持 roadmap validate 通过（按 D10）；否则只更新 Issue。
4. 在 main 上本地提交（不推送）；最终回复：改动摘要、关键文件、测试结果、提交 SHA、风险/未验证项。
5. 遇到范围/接口/权限变化先暂停，在 decisions.md 追加决定并询问用户（入群前历史不可读会缩小能力，需用户确认提示文案）。
```


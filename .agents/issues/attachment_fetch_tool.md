# P1 附件获取工具：feishu_attachment_fetch

## 目标、范围与非目标

实现模型工具 `feishu_attachment_fetch`：按消息 id（可指定 file_key）从当前飞书会话取回图片/文件，图片返回 `ImageBlock`，文件流式写入 DSH 原生附件库并返回 `FileBlock`（退化时返回句柄文本 + 只读路径）。

范围：

- 工具定义使用本地窄类型手写（不引入 DSH 运行时依赖；参数用 zod 校验），支持 `presentCall`/`presentResult` 以便卡片展示“下载附件 xxx”。
- 每 route 维护“已知消息/资源”白名单（LRU 上限）：来自触发消息、引用消息、静默登记、历史工具结果；工具只允许下载白名单内的 `message_id`/`file_key`，防止提示注入请求任意消息。合并转发登记为顶层容器消息，子资源按容器 id 下载。
- 挂载：在 preset `setup` 之后 `agentCtx.inject(['tools'])` 注册；`tools`/`attachments` 任一缺失时 no-op 并记录一次告警；borrow 的 live agent 也做一次 best-effort 补挂（竞态防护）。
- 限制：单次资源数（默认 10）、单次总字节（默认 100 MiB）、`timeoutMs`（默认 120s，可配）；下载遵守 `exec.signal`，中途取消不留下半文件。
- 失败：逐资源返回结构化错误（过期/权限/超限/文件夹不支持），不中断整次调用；全部失败返回可读原因。
- 功能开关：`feishuTools.attachmentFetch`（默认开）。

非目标：不实现消息历史/引用读取工具（见 `quote_history_tools`）；不改准入流程（见 `admission_manifest_flow`）。

## 前置产物与解除条件

依赖 `native_attachment_store` 的图片/文件入库接口，`pending_attachment_registry` 的登记查询接口；依赖 `platform_spike` 的工具注册与 `FileBlock` 下发结论。

## 验收条件与验证方法

| AC | 验证方法 | 通过标准 |
| --- | --- | --- |
| AC1 工具注册 | 单元测试 + 手动 | 仅当 tools/attachments 可用时注册；卡片展示工具行；重启恢复后可调用 |
| AC2 白名单授权 | 单元测试 | 非本 route 消息/未登记 file_key/跨话题 id 一律拒绝；合法 id 通过 |
| AC3 图片结果 | 单元测试（stub 下载 + attachments） | 返回 `ImageBlock` + 文本元数据；文本模型降级为占位说明 |
| AC4 文件结果 | 单元测试 | 流式入库返回 `FileBlock`（或退化路径文本 + 校验信息）；内容一致性断言 |
| AC5 限制与取消 | 单元测试（假时钟/信号） | 超资源数/字节/超时拒绝并说明；取消后临时对象可清理 |
| AC6 合并转发 | 单元测试 | 用容器 message_id + 子 file_key 下载成功；子消息 id 作为下载 id 时给出明确错误 |
| AC7 构建 | `pnpm typecheck` | 通过 |

## 决定、授权与待答

- 用户决定：文件懒取、图片预取；不预下载；工具漏调通过工具与 prompt 优化收敛。
- 待答：工具结果 `FileBlock` 若不被支持，采用句柄文本退化（默认方案）。
- 待答：是否给成功下载的源消息补 DONE 表情（体验项，P3 决定）。

## 验证与交付证据

待执行。

## 启动 Prompt（复制到新会话）

```text
你负责 attachment_pipeline_v2 / attachment_fetch_tool 的实现。

仓库：/Users/moka/dev/project/dsh_ext/dsh_channels，本地 main 分支。
执行约束（decisions.md D9/D10）：不创建平台 Issue/Milestone；不拉分支/worktree；不用 PR；直接改本地 main 并本地提交；不推送、不合并、不发布；提交用 conventional commit。

开始前阅读：
1. .agents/issues/attachment_fetch_tool.md（本任务正文与 AC）
2. .agents/roadmaps/attachment_pipeline_v2/roadmap.md 与 plan.json
3. .agents/roadmaps/attachment_pipeline_v2/decisions.md（D1–D10）
4. .agents/notes/2026_10_20_attachment_pipeline.md
5. .agents/issues/platform_spike.md 的 P0 证据（P0 收官 3f05d81；开始时以 git rev-parse HEAD 为准）
6. 前置任务证据：native_attachment_store、pending_attachment_registry 的“验证与交付证据”与对应提交
7. 相关源码：src/feishu-channel.ts（messageGet/messageList 已就绪）、src/host/agent.ts（tool 运行时类型）、src/session/manager.ts、src/routing/inbound.ts 的会话建立逻辑

P0 已验证、必须沿用的前提与教训：
- 工具注册路径：agent setup 后 agentCtx.inject(['tools']) 注册成功，模型可实际调用；
- 工具结果可以同时携带 text 与 ImageBlock；FileBlock 内容块可下发，但保留文本路径兜底；
- 合并转发资源必须用顶层容器 message_id 下载；子消息 id 会 400；
- 工具输出必须做 JSON 清洗（不能含 undefined，否则 DSH 报 value is not lossless JSON）；
- AbortError / 用户取消必须映射成可读错误（不能是 [object Object]）；
- 大文件下载约 41–44s（980MB），需要 timeoutMs 与 exec.signal 取消。

任务：实现 feishu_attachment_fetch 工具（细节以本 Issue AC 为准）：
- 本地窄类型手写定义（不 import DSH 运行时包），zod 校验参数；presentCall/presentResult 便于卡片展示；
- 每 route 维护“已知消息/资源”白名单（触发消息、引用、静默登记、历史工具结果），只允许白名单内 message_id/file_key；合并转发按容器 id 下载子资源；
- 在 preset setup 后注册；tools/attachments 缺失时 no-op + 告警；borrow 的 live agent 做一次 best-effort 补挂；功能开关 feishuTools.attachmentFetch；
- 限制：单次资源数、单次总字节、timeoutMs、取消后不留半文件；失败逐资源结构化返回。

预计写入范围（越界前先暂停询问）：src/feishu/tools.ts（新增）、src/host/agent.ts（如需补类型）、src/session/manager.ts（挂载接入）、src/config.ts（开关）、tests/feishu-tools.test.ts。本任务不接 prompt 清单与准入流程（admission_manifest_flow 负责）。

完成标准：
1. 逐条满足 Issue AC；pnpm typecheck、pnpm test、pnpm build 全绿。
2. 把实际命令、结果、未验证项写回本 Issue 的“验证与交付证据”。
3. 若当前会话是协调者：同步 runtime.json 对应任务 resume 并保持 roadmap validate 通过（按 D10）；否则只更新 Issue。
4. 在 main 上本地提交（不推送）；最终回复：改动摘要、关键文件、测试结果、提交 SHA、风险/未验证项。
5. 遇到范围/接口变化先暂停，在 decisions.md 追加决定并询问用户。
```


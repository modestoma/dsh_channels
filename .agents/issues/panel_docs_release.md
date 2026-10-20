# P3 配置面板、文档与验收准备

## 目标、范围与非目标

收口新管线的可配置面、文档、回归与整体验收证据，确保可交付但不自动发布。

范围：

- 配置与面板：`attachmentStore`、`prefetchImages`、`prefetchImageTimeoutMs`、`pendingAttachmentTtlMs`/`pendingAttachmentLimit`、`attachmentFetch*`（资源数/字节/超时）、`feishuTools.attachmentFetch`/`feishuTools.topicMessages`、`historyBootstrapLimit`；同步 [config.ts](../../src/config.ts)、[settings/contract.ts](../../src/settings/contract.ts)、[settings/surface.ts](../../src/settings/surface.ts) 与帮助文案。
- 清理与保留：确认入站附件不再占用话题目录；清理面板帮助文案改为“只清理工作区与 Agent 产物，不影响 Session 附件”；pending 元数据 TTL 清理接入既有周期 GC；旧 `_staging` 一次性迁入在完成一个版本周期后移除。
- 文档：README 行为/配置/权限章节重写；`docs/feishu-onboarding.md` 权限表与验证步骤；新增设计文档记录 v2 管线（存储、清单、工具、降级、隐私边界）。
- 回归与验收：更新/新增测试直至全绿；执行 e2e 手测清单（私聊/对话群/话题群 × 文本/图片/文件/纯附件/引用/历史 × 大文件/失败/权限缺失）；把结果写入 `acceptance.md`；`pnpm check` 通过。
- 发布边界：不发布应用版本、不合并远端分支、不创建平台 Milestone/Issue（除非另行授权）。

非目标：新功能扩展；性能压测；DSH 上游附件 GC。

## 前置产物与解除条件

依赖 `quote_history_tools` 交付；依赖全部 P1/P2 任务在目标分支可验证。

## 验收条件与验证方法

| AC | 验证方法 | 通过标准 |
| --- | --- | --- |
| AC1 配置生效 | settings 测试 + 手动面板 | 面板读写、校验、帮助文案正确；旧配置兼容 |
| AC2 清理语义 | 单元测试 + 手动 | 清理不触碰原生附件；帮助文案准确；pending TTL 正常 |
| AC3 文档完整 | 评审 | README/onboarding/设计文档与实现一致，权限与降级写清 |
| AC4 回归全绿 | `pnpm typecheck && pnpm test && pnpm build` | 通过；新增附件/工具测试覆盖失败路径 |
| AC5 e2e 清单 | 手动逐项 | 决策矩阵全部通过；未验证真实环境项如实记录 |
| AC6 验收材料 | `acceptance.md` | 每条整体 AC 有实现入口、证据、未验证项 |

## 决定、授权与待答

- 用户决定：暂不提供附件清理机制（DSH 原生库不自动删除）；工作区清理仅保留给产物/旧目录。
- 待答：DONE 表情等体验细节是否纳入本期（默认仅工具行展示）。

## 验证与交付证据

待执行。

## 启动 Prompt（复制到新会话）

```text
你负责 attachment_pipeline_v2 / panel_docs_release 的实现与整体验收准备。

仓库：/Users/moka/dev/project/dsh_ext/dsh_channels，本地 main 分支。
执行约束（decisions.md D9/D10）：不创建平台 Issue/Milestone；不拉分支/worktree；不用 PR；直接改本地 main 并本地提交；不推送、不合并、不发布；提交用 conventional commit。

开始前阅读：
1. .agents/issues/panel_docs_release.md（本任务正文与 AC）
2. .agents/roadmaps/attachment_pipeline_v2/roadmap.md 与 plan.json、decisions.md（D1–D10）
3. .agents/notes/2026_10_20_attachment_pipeline.md
4. 所有前置 Issue 的“验证与交付证据”与对应提交（platform_spike / native_attachment_store / pending_attachment_registry / attachment_fetch_tool / admission_manifest_flow / quote_history_tools）
5. 相关源码：src/config.ts、src/settings/contract.ts、src/settings/surface.ts、src/cleanup.ts、src/workspaces.ts、README.md、docs/feishu-onboarding.md

前置状态与必须沿用的结论：
- P0：ctx.attachments 可用；图片 ImageBlock 可下发；FileBlock + 文本路径双兜底；大文件流式 RSS 受控；message.get/list 与合并转发容器规则可用；未 @ 群事件可投递；重启回放通过。
- 存储：图片与文件都进 DSH 原生附件库；DSH 原生库不自动清理，插件不再承担入站附件清理；工作区清理只保留给 Agent 产物与旧版目录。
- 取消/中断错误必须可读（P0 的 [object Object] 教训）；工具输出必须 JSON 清洗。

任务：收口配置面板、文档、清理语义与验收（细节以本 Issue AC 为准）：
- 配置与面板：attachmentStore、prefetchImages、prefetchImageTimeoutMs、pendingAttachmentTtlMs/Limit、attachmentFetch*、feishuTools.attachmentFetch/topicMessages、historyBootstrapLimit；同步 config/contract/surface 与帮助文案；
- 清理与保留：确认入站附件不再占用话题目录；清理面板文案改为“只清理工作区与 Agent 产物，不影响 Session 附件”；pending TTL 接入既有 GC；旧 _staging 一次性迁入的移除窗口在本任务定案；
- 文档：README 行为/配置/权限章节；docs/feishu-onboarding.md 权限与验证步骤；新增 v2 管线设计文档（存储、清单、工具、降级、隐私边界）；
- 回归与验收：补测试至全绿；执行 e2e 手测清单（私聊/对话群/话题群 × 文本/图片/文件/纯附件/引用/历史 × 大文件/失败/权限缺失）；把整体 AC 证据写入 .agents/roadmaps/attachment_pipeline_v2/acceptance.md；pnpm check 通过；
- 发布边界：不发布应用版本、不推送/合并、不创建平台对象（除非用户另行授权）。

预计写入范围（越界前先暂停询问）：src/settings/、src/config.ts、README.md、docs/、src/cleanup.ts、src/workspaces.ts、tests/（settings/config/cleanup 相关）、.agents/roadmaps/attachment_pipeline_v2/acceptance.md。

完成标准：
1. 逐条满足 Issue AC；pnpm check（typecheck + test + build + verify:host + verify:client）全绿。
2. 把实际命令、结果、e2e 手测结论、未验证项写回本 Issue 证据与 acceptance.md；整体验收需用户确认后再进入 awaiting_acceptance。
3. 若当前会话是协调者：同步 runtime.json 对应任务 resume 并保持 roadmap validate 通过（按 D10）；否则只更新 Issue 与 acceptance。
4. 在 main 上本地提交（不推送）；最终回复：改动摘要、文档入口、验证结果、提交 SHA、风险/未验证项、用户验收事项。
5. 不扩大功能范围；发现需求变化先暂停，在 decisions.md 追加决定并询问用户。
```


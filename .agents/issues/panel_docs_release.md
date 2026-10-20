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

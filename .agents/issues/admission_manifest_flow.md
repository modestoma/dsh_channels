# P1 准入重构：立即建会话 + 清单进 prompt + 图片预取 + 文件懒取

## 目标、范围与非目标

把入站主链路从“下载完再开模型回合”改为“会话/话题/卡片零等待 + 清单 + 图片预取 + 文件懒取”：

- 删除 [inbound.ts](../../src/routing/inbound.ts) 在路由决策前同步下载附件的路径；触发消息先完成建会话、话题绑定、卡片第一帧、路由持久化、工具挂载，再拼 prompt。
- prompt 组装（新模块 `src/feishu/manifest.ts`）：稳定 `<feishu_context>` 块，只列**未加载**的附件元数据（`message_id` / `file_key` / 类型 / 文件名）与“用 `feishu_attachment_fetch` 获取”的提示；对已预取的图片不列“未加载”。无清单内容时不产生 token。
- 纯附件消息（私聊仅附件；群未 @；已绑定话题内的纯附件消息）：通过准入后只做静默登记，不下载、不建会话、不回复、不加表情。
- 图片预取：触发消息中的图片在 route 建立后、`followup` 前取回并写入 `ctx.attachments`，以 `ImageBlock` 进入首轮消息；预取有单图/总字节上限与短超时，失败/超限自动降级为清单 + 工具。`prefetchImages` 可关闭。
- `followup` 使用组装后的多块内容（文本 + 图片块 + 清单文本块）。
- 更新 [agent-context.ts](../../src/feishu/agent-context.ts) guidance：附件在 DSH 原生库；文件默认未加载，用工具取；只读副本修改前复制；不要主动枚举其他附件。
- 保留 `attachmentStore: 'archive'` 降级路径：无 `ctx.attachments` 或显式配置时，仍按旧行为下载到话题 `attachments/`，保证 headless/旧部署可用。
- 旧 `_staging` 目录的遗留文件：建会话时保留一次性迁入（兼容升级），新流程不再写入 staging。

非目标：引用消息摘录与话题历史工具（`quote_history_tools`）；面板与文档（`panel_docs_release`）；后台预取。

## 前置产物与解除条件

依赖 `attachment_fetch_tool` 的工具与白名单可用（此时清单里的文件确实能被取到）；依赖 `native_attachment_store` 的图片入库与 `pending_attachment_registry` 的登记查询。

## 验收条件与验证方法

| AC | 验证方法 | 通过标准 |
| --- | --- | --- |
| AC1 零等待 | service 测试（阻塞下载桩）+ 手动 | 下载未完成时卡片/会话已建立；`followup` 不等待文件字节 |
| AC2 清单正确 | 单元测试 | 触发附件/待登记附件出现在清单；已预取图片不出现；无附件时无清单块 |
| AC3 纯附件静默 | service 测试 | 不建 Agent、不发送、不加表情、不下载；登记可查 |
| AC4 图片预取 | 单元测试 + 手动 | 首轮消息含 ImageBlock；预取失败/超限降级为清单，不阻塞会话 |
| AC5 文件懒取 | service 测试 | 未调用工具不下载；调用后能读到内容；清单驱动成功 |
| AC6 话题/群行 | service 测试 | 私聊/对话群/话题群三类触发与未触发行为符合 Roadmap 矩阵 |
| AC7 archive 降级 | service 测试 | 配置 archive 或缺服务时行为与旧版一致 |
| AC8 构建 | `pnpm typecheck && pnpm test` | 通过 |

## 决定、授权与待答

- 用户决定：立即建会话；清单进 prompt；图片预取；文件懒取；不接受预下载兜底。
- 待答：图片预取是否默认开启（当前默认开，可配置关）；文本模型路由下的图片降级提示文案。

## 验证与交付证据

待执行。

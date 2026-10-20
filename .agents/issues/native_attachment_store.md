# P1 原生附件存储接入：图片与文件统一走 DSH 附件库

## 目标、范围与非目标

把插件自己的附件落盘实现替换为 DSH 原生附件能力，为后续“立即建会话 + 文件懒取”提供存储层：

- 新增宿主桥接窄类型（`ctx.attachments` 的最小面：`saveImage`、`saveFileStream`、`fileHostPath`、`imageHostPath`、`admitPromptContent`、限额字段），不引入宿主内部运行时依赖；服务缺失时保持可降级。
- 图片：飞书 `image` 资源 → `saveImage` → `ImageBlock`（供预取使用）；解码/规范化失败时返回结构化原因。
- 文件：飞书 `file` 资源（含 `post` 的 `files[]`）→ `saveFileStream` 流式写入原生库；返回 `FileAttachmentRef`；提供“句柄文本 + 只读路径”的退化格式化（当工具结果不能下发 `FileBlock` 时使用）。
- 保留 `archive` 降级模式：`ctx.attachments` 不可用的部署仍写话题 `attachments/`（复用现有 `AttachmentIntake`），由 `attachmentStore: 'native' | 'archive'` 配置选择，默认 `native`。
- 删除“入站附件写入工作区”的主路径依赖（实际调用点由 `admission_manifest_flow` 任务移除；本任务只保证两条通路都可用）。

非目标：不改变准入/routing 决策；不实现工具；不动 README/面板文档。

## 前置产物与解除条件

依赖 `platform_spike` 的 AC2/AC3 结论：`ctx.attachments` 在真实 profile 可用、图片可预取、文件只读路径可被 `read`/`bash` 读取、工具结果 `FileBlock` 支持情况。若结论为不可用，本任务降级为“只接入 archive 模式并记录阻塞”。

## 验收条件与验证方法

| AC | 验证方法 | 通过标准 |
| --- | --- | --- |
| AC1 服务桥接 | 单元测试 + typecheck | 窄类型与运行时代码不 import DSH 包；缺服务时返回明确“未挂载”状态 |
| AC2 图片入库 | 单元测试（stub attachments） | 字节 → `ImageBlock` 形状正确；超限/损坏返回结构化错误 |
| AC3 文件流式入库 | 单元测试（大字节源） | 不整体缓冲；`FileAttachmentRef` 含 name/bytes；取消信号生效 |
| AC4 只读路径可读 | 手动（沿用 P0 环境） | `read`/`bash` 能读 `fileHostPath`；校验读失败时错误可感知 |
| AC5 archive 降级 | 单元测试 + 手动关服务 | 缺 `ctx.attachments` 时回退工作区落盘，配置切换生效 |
| AC6 构建 | `pnpm typecheck` | 通过 |

## 决定、授权与待答

- 用户决定：图片与文件均走 DSH 原生附件库；插件不再承担入站附件清理。
- 待答：是否将 `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-attachment` 作为 peerDependency；本任务先按“零运行时依赖 + 本地窄类型”实现，P0 结论再定。

## 验证与交付证据

待执行。

## 启动 Prompt（复制到新会话）

```text
你负责 attachment_pipeline_v2 / native_attachment_store 的实现。

仓库：/Users/moka/dev/project/dsh_ext/dsh_channels，本地 main 分支。
执行约束（decisions.md D9/D10）：不创建平台 Issue/Milestone；不拉分支/worktree；不用 PR；直接改本地 main 并本地提交；不推送、不合并、不发布；提交用 conventional commit。

开始前阅读：
1. .agents/issues/native_attachment_store.md（本任务正文与 AC）
2. .agents/roadmaps/attachment_pipeline_v2/roadmap.md 与 plan.json
3. .agents/roadmaps/attachment_pipeline_v2/decisions.md（D1–D10）
4. .agents/notes/2026_10_20_attachment_pipeline.md
5. .agents/issues/platform_spike.md 的 P0 证据（P0 收官提交 3f05d81；开始时以 git rev-parse HEAD 为准）
6. 相关源码：src/feishu/inbound-attachments.ts、src/feishu-channel.ts、src/host/、src/config.ts 与现有测试

P0 已验证、必须沿用的前提：
- channel 会话里 ctx.attachments 可用（saveImage / saveFileStream / fileHostPath / imageHostPath 均存在）；
- 图片 saveImage 后可作为 ImageBlock 下发；通道模型 deepseek-flash 声明并实测支持图片输入；
- 文件 saveFileStream 流式入库（980MB 文件峰值 RSS 约 451MB）；FileBlock 内容块可下发，句柄路径可由 bash 读取；
- 不引入 DSH 包的运行时依赖，宿主桥接只用本地窄类型。

任务：实现附件存储层（细节以本 Issue AC 为准）：
- 新增 ctx.attachments 的最小窄类型与访问封装；服务缺失时返回明确的“未挂载”状态；
- 图片：saveImage → ImageBlock 形状；解码/规范化失败返回结构化错误；
- 文件：saveFileStream 流式写入，返回 FileAttachmentRef；同时提供“句柄文本 + 只读路径”格式化，作为 FileBlock 不可用时的兜底；
- archive 降级：attachmentStore: 'native' | 'archive'（默认 native），archive 复用现有 AttachmentIntake 写话题 attachments/；
- 本任务不接准入调用点、不实现工具、不改 prompt 组装；这些由后续任务负责。

预计写入范围（越界前先暂停询问）：src/host/（窄类型）、src/feishu/native-attachments.ts（新增）、src/feishu/inbound-attachments.ts（仅复用/抽取下载流，不改现有语义）、src/config.ts、tests/native-attachments.test.ts。

完成标准：
1. 逐条满足 Issue AC；pnpm typecheck、pnpm test、pnpm build 全绿。
2. 把实际命令、结果、未验证项写回本 Issue 的“验证与交付证据”。
3. 若当前会话是协调者：同步 .agents/roadmaps/attachment_pipeline_v2/runtime.json 对应任务的 resume，并保持 roadmap validate 通过（无平台对象时按 D10 用 planned+resume）；否则只更新 Issue，交协调者收口。
4. 在 main 上本地提交（不推送）；最终回复：改动摘要、关键文件、测试结果、提交 SHA、风险/未验证项。
5. 遇到需求/接口变化先暂停，在 decisions.md 追加决定并询问用户，不自行扩大范围。
```


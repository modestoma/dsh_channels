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

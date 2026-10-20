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

### 环境与基线（2026-10-20）

- 仓库 `/Users/moka/dev/project/dsh_ext/dsh_channels`，本地 `main`；开始基线 `main@81cb44b15818e9d3609874d6047f3f7010113031`。按 D9/D10 不创建平台 Issue/Milestone、不拉分支/worktree、不使用 PR，本地提交不推送。
- Node v24.19.0 / pnpm 12.14.0；DSH 0.2.1-rc.2。
- 契约来源：`@deepseek-ai/dsh-attachment`/`dsh-llm` 的 0.2.1-rc.2 类型（`saveImage`/`saveFileStream`/`fileHostPath`/`imageHostPath`/`admitPromptContent`/`imageLimits`/`AttachmentErrorCode`/`ImageBlock`/`FileBlock`/`fileHandleText`）核对后手写本地窄类型；未新增任何 DSH 依赖或 `@deepseek-ai/*` 运行时 import（自动测试守护）。
- 实现提交：`5b38252c013bbec03df344135b23e2a1ae7ed332`（feat，含实现与测试）。

### 实现落点

| 产物 | 文件 | 说明 |
| --- | --- | --- |
| 宿主桥接窄类型 | [src/host/attachments.ts](../../../src/host/attachments.ts)（新增） | `AttachmentStore`（saveImage/saveFileStream/fileHostPath/imageHostPath/admitPromptContent/imageLimits/isAttachmentError?）、`ImageAttachmentRef`/`FileAttachmentRef`、`ImageBlock`/`FileBlock`、`AttachmentErrorCode`；纯类型 + 少量本地常量，无 DSH import |
| Agent 作用域接口 | [src/host/agent.ts](../../../src/host/agent.ts)、[src/host/index.ts](../../../src/host/index.ts) | `ctx.attachments?: AttachmentStore`、`ctx.get?()`；barrel 导出 |
| 原生存储层 | [src/feishu/native-attachments.ts](../../../src/feishu/native-attachments.ts)（新增） | 服务发现/未挂载状态、`NativeAttachmentStore`（图片/文件/句柄文本/只读路径/取消）、`InboundAttachmentStore`（native/archive 选择与降级） |
| 配置开关 | [src/config.ts](../../../src/config.ts) | `attachmentStore: 'native' \| 'archive'`，默认 `native`；`ATTACHMENT_STORE_MODES`/`AttachmentStoreMode` |
| 复用导出 | [src/feishu/inbound-attachments.ts](../../../src/feishu/inbound-attachments.ts) | 仅将 `EMPTY_POST_PLACEHOLDER` 改为导出，供原生路径复用同一 attachment-only 判定；现有语义未改 |
| 测试 | [tests/native-attachments.test.ts](../../../tests/native-attachments.test.ts)（新增） | 47 个用例覆盖 AC1–AC3、AC5、失败/取消/降级路径；[tests/service.test.ts](../../../tests/service.test.ts) 仅在 `makeConfig` 补必填字段 `attachmentStore: 'native'` |

### 逐条 AC 验证

| AC | 验证方法 | 实际结果 | 结论 |
| --- | --- | --- | --- |
| AC1 服务桥接 | 单元测试 + typecheck | 窄类型与运行时代码无 `@deepseek-ai` import（测试读取源码与 package.json 断言）；`resolveAttachmentService` 先试 `ctx.attachments` 再试 `ctx.get('attachments')`，cordis 未 inject 时属性读取抛错被吞掉并返回结构化 `ATTACHMENT_SERVICE_UNMOUNTED`（固定 reason「宿主未挂载原生附件库（ctx.attachments 不可用）」）；部分实现的服务对象被 `isAttachmentStore` 拒收；9 个单元用例通过（`tests/native-attachments.test.ts` AC1 describe） | ✅ |
| AC2 图片入库 | 单元测试（stub attachments） | `saveImage` 嗅探 PNG/JPEG/WebP/GIF，声明类型与字节不一致→`IMAGE_TYPE_MISMATCH`；无法识别→`UNSUPPORTED_IMAGE_TYPE`；超 `imageLimits.maxImageBytes`→`IMAGE_TOO_LARGE`（不调用宿主）；宿主 `INVALID_IMAGE` 等错误码映射为可读中文；成功返回 `{type:'image',attachment}` 形状；畸形 limits 不抛异常；9 个用例通过 | ✅ |
| AC3 文件流式入库 | 单元测试（大字节源） | 源 `AsyncIterable` 原样转发、逐 chunk 取消守卫、`signal` 透传宿主；16×1 MiB 源 `maxOutstanding ≤ 1`（不整体缓冲）；`FileAttachmentRef` 含 name（sanitize 后）/bytes；取消→`ABORTED`（预取消不调用宿主）；`fileHostPath` 抛错时 `readPathError` + 无路径兜底文案可感知；句柄文本为确定性 name/bytes/sha256:前缀/只读路径；8 个用例通过 | ✅ |
| AC4 只读路径可读 | 手动（沿用 P0 环境） | 本层：`fileReadPath`/`storedFile.readPathError`/`formatFileHandle` 无路径降级均有单测；真机 `read`/`bash` 未在本任务重跑（当前无运行时调用点），继承 P0 证据 [platform_spike.md](platform_spike.md) AC3（`bash` 读取 `fileHostPath` 成功：`-r--------`，sha256 与 attachmentId 一致） | ⏳ 部分（继承 P0，真机复验转 admission 接线后） |
| AC5 archive 降级 | 单元测试 + 手动关服务 | 配置默认 native、接受 archive、拒绝非法值；`planAttachmentStorage` 三态；facade：native 模式不写话题 `attachments/`、archive 模式复用 `AttachmentIntake` 写工作区、缺服务时回退 archive（一次性 warning + `fallback: attachment-service-unmounted`）、显式 archive 优先于已挂载服务；`acceptAttachments=false` 剥离占位符且纯附件消息 `text=''/attachmentOnly=true`（不起回合）；文件夹/下载失败/超限逐资源失败不中断；`merge_forward` 文本记录仍走 archive（`fallback: forwarded-record`）；共 17 个用例通过 | ⏳ 层内满足；运行时消费者未接（本任务范围），"手动关服务"真机项转 admission |
| AC6 构建 | `pnpm typecheck` / `pnpm test` / `pnpm build` | 全部通过（见下） | ✅ |

### 命令与结果（2026-10-20 本机）

```text
pnpm typecheck   -> exit 0（tsconfig.json + tsconfig.client.json）
pnpm test        -> 26 files passed / 623 tests passed（新增 tests/native-attachments.test.ts 47 个；P0 基线 576）
pnpm build       -> host lib/index.js 419.66 kB + client lib/client.js 125.40 kB，均 Build complete
git diff --check -> exit 0
```

### 独立评审与修复

- teammate `ac-reviewer` 在提交前对工作树做两轮只读评审（未写文件/未提交）：首轮结论「无 P0，有条件放行」，发现 P1-1 与 7 个 P2；修复后复核「P1-1 解除，可放行」并确认 45 个新增测试与 typecheck 通过。
- 已修复：P1-1 `acceptAttachments=false` 分支未剥离占位符、attachment-only 未判 inert（新增 `remainingPromptText` 共享判定 + 测试）；P2 服务快照/live lookup 一致性（`store()` 单次快照、`NativeAttachmentStore` 内部 live getter）；`imageLimits` 畸形防御；非 Error 抛值不再输出 `[object Object]` 并截断超长错误；文件流中途失败仅在命中飞书 400/403 文案时重标 `DOWNLOAD_FAILED`，真实存储故障保留原 code。
- 已记录不修项（见下方未验证项/已知差异）：native 模式回执表情、面板/文档、merge_forward 原生记录。
- 复核后追加的 2 个用例（非下载存储故障不误标、超长错误截断）纳入最终 47 个用例。

### 批次 A 真机加载/回归冒烟（2026-10-21 00:07–00:15，本机 desktop profile）

目的：让真实 profile 加载本任务的新构建，确认默认 `attachmentStore=native` 未改变现有 archive 行为。
AC4/AC5 的真机项仍待 `admission_manifest_flow` 接线后验证，本批次不覆盖新存储主路径。

- **环境**：DSH 0.2.1-rc.2 desktop profile，插件 `link:` 指向本仓库；`pnpm build` 产物为 HEAD `717e98a` 工作树。
- **免重启重载**：在 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `- id: dsh-channels` 下追加 `attachmentStore: native`（与默认等价；备份 `/tmp/dsh-cordis.patch.backup.yml`），触发 HMR profile recomposition。
  - 证据：00:07:20 插件条目被 HMR 替换，飞书长连接重建——旧连接 `59835→198.18.36.45` 关闭，新连接 `61040→198.18.37.178`（`open.feishu.cn`）与 `61041→198.18.36.45` 建立；
  - `plugin_manager` 复核 `include:dsh-channels`（`@modesto_ma/dsh-channels`）= enabled + `fiberPhase: active`，无 failed 状态。
- **真实消息回归**（用户手工在 p2p 测试会话发送；2026-10-21 00:11 / 00:12）：
  - 图片消息：新会话 `5624ae8c-c7ff-4184-bd08-2fbbb0433a79`，归档 `<workspace>/topics/omt_19b21a55244f1bad/attachments/20261020-161110-image.jpg`（8192×4608 JPEG，sha256 `fbd0d85c83a4206259e08c7edb75b0eca8a014acd26a187ff431ad6330b1836c`）；进入模型的 prompt 文本为「看下这张图片里是什么？」（附件占位符已剥离，旧 archive 语义不变）；该会话 13 条 assistant 消息 / 16 次 tool call / 0 错误事件。
  - 文件消息：新会话 `40dd5e1c-f5c4-4dfb-988e-638f6f9fdde7`，归档 `<workspace>/topics/omt_19b21a3f9ecf1ba0/attachments/20261020-161241-dsh-session-session-7531c78c-….zip`（`unzip -l` 校验为有效 zip）；prompt 文本「看下这个文件」；47 条 assistant 消息 / 46 次 tool call / 0 错误事件。
- **原生库落点**：`~/.dsh/attachments/v1` 对象文件 61 → 69；新增 8 个 JPEG 均可追溯为 channel agent 回合内 `read_image`/工具结果的图片投影（例如 216228 字节对象为所发图片的 2730×1536 请求版本，见该会话 `tool/result` 事件），**不是**入站附件存储路径写入（本任务无运行时消费者）；入站图片/文件只落在话题 `attachments/`。
- **结论**：批次 A 通过——新构建在真实 profile 正常加载，默认 native 配置不改变旧 archive 行为。AC4/AC5 真机项保持不变，待接线验证。

### 未验证项 / 已知差异

1. **AC4 真机手动**未在本任务重跑：本任务明确不接准入调用点、无 `fileHostPath` 产物可供真机读取；沿用 P0 Go 证据，待 `admission_manifest_flow` 接线后复验 `read`/`bash`。
2. **AC5 手动关服务**未真机执行：`attachmentStore`/`InboundAttachmentStore` 尚无运行时消费者（`src/routing/inbound.ts` 仍直连 `AttachmentIntake.archive`，由 `admission_manifest_flow` 替换）；配置切换与降级目前在存储层单测生效。
3. native 模式不再添加 DONE/No 回执表情：纯附件消息按 D2 保持静默；文本+附件混合消息的回执行为由 `admission_manifest_flow` 显式决定。
4. `merge_forward` 的文本记录在 native 模式仍写话题 `attachments/`（`fallback: forwarded-record`）：DSH 原生库无对应文本记录形态，计划由 `quote_history_tools` 统一处理。
5. Web 设置面板尚未暴露 `attachmentStore`（面板/文档属 `panel_docs_release` 范围）。
6. 已做批次 A 真机加载/旧行为回归冒烟（见上），但新存储层主路径（`saveImage`/`saveFileStream`/`fileHostPath` 的实际入站调用）仍未在真实 profile 执行过（本任务无调用点）。
7. 会话中 mid-message 卸载（服务在单条消息处理中消失）按资源返回结构化未挂载失败，但无专门测试（评审建议后续补一条）。


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


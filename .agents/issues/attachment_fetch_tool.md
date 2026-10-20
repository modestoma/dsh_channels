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

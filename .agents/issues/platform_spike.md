# P0 技术验证：DSH 工具/原生附件与飞书消息读取

## 目标、范围与非目标

在动 P1 生产代码前，用最小原型在真实 profile 与真实飞书测试群验证本方案的五个关键前提，避免方向性返工。

范围：

1. **工具注册**：channel 插件在 agent `setup`（preset 挂载之后）通过 `agentCtx.inject(['tools'])` 注册模型工具；工具调用在流式卡片显示工具行；重启后仍可用。
2. **原生图片**：插件把飞书图片写入 `ctx.attachments`（`saveImage` / `admitPromptContent`），图片以 `ImageBlock` 进入首轮 `UserMessage`，模型能直接描述图片；重启回放后仍可见。
3. **原生文件**：工具内 `saveFileStream` 把飞书文件流式写入 DSH 原生附件库；返回 `FileBlock`（或退化为句柄文本 + 只读路径）；`read` / `bash` 能在 channel 会话沙箱里读取 `fileHostPath` 映射出的只读路径；几百 MB 文件不爆内存、可取消。
4. **飞书消息读取**：bot 身份下 `message.get`、`message.mget`、`message.list(container_id_type=thread)` 可用；机器人入群前的历史消息能否读取；未 @ 的群消息事件是否投递到机器人。
5. **引用与合并转发**：回复消息事件里的 `parent_id`（SDK `replyToMessageId`）能定位被引用消息；合并转发资源必须用顶层容器 `message_id` 下载（子消息 id 会报 234003）验证成立。

非目标：不实现 P1 生产代码；不创建平台 Issue / Milestone；不发布应用版本。

## 前置产物与解除条件

无前置任务。基线 `main@f9837d51b8556d3beddea8c066f4fccd370cec16`。原型代码只允许放在 `scripts/` 或临时 worktree，不进入运行时路径；如果修改生产文件，验证后必须还原或明确列入后续任务。

## 验收条件与验证方法

| AC | 验证方法（自动 / 手动） | 通过标准 |
| --- | --- | --- |
| AC1 工具注册可用 | 手动：真实 profile 启动 + 临时 demo 工具 | 模型收到工具 schema，调用后卡片显示工具行；重启后仍可调用 |
| AC2 图片原生可见 | 手动：飞书发图触发，模型不看工具即可描述 | 首轮请求包含 ImageBlock；重启回放图片仍可见 |
| AC3 文件块与只读路径 | 手动：工具取文件后用 `read`/`bash` 读路径 | 读取成功且内容校验一致；大文件流式写入不爆内存 |
| AC4 飞书读取权限 | 手动：测试群 + 测试机器人逐项调用 | 形成权限 / 事件投递矩阵：可用 / 需审批 / 不可用 |
| AC5 引用与合并转发 | 手动：引用文件、引用合并消息 | 能定位 `parent_id`；能用顶层容器 id 下载子资源 |
| AC6 结论可执行 | 证据写入本文件 | 每项结论含命令、返回摘要、环境；对 P1 的 Go/No-Go 与降级方案明确 |

## 决定、授权与待答

- 用户已确认方案方向（2026-10-20）；本任务只做验证，不改变产品范围。
- P0 结论：**全部 Go**，证据见下方“验证与交付证据”。飞书群历史/话题历史在现有应用权限下可读；入群前历史待 P2 前补测。
- FileBlock：工具结果层可携带 `{type:'file', attachment}` 内容块；模型可见句柄文本未能与文本路径兜底隔离验证，P1 采用“FileBlock + 文本路径”双保险。
- 探针自身缺陷已记录（输出 JSON 清洗、AbortError 文案、inject ctx 捕获），仅影响探针，不影响产品结论；临时探针已移除。

## 验证与交付证据

### 环境与基线（2026-10-20）

- DSH 0.2.1-rc.2 desktop profile；插件以 `link:` 指向本仓库，`pnpm build` 后重载生效；模型 `deepseek-official/deepseek-flash`。
- 测试对象：p2p、普通群、话题群（chat id 前缀 `oc_cc8…` / `oc_ede…` / `oc_678…`）。
- 证据：`~/.dsh/dsh-channels/p0-probe.ndjson`（47 行）、通道会话日志（zstd JSONL）、`~/.dsh/attachments/v1` 对象；均为本机临时运行证据，不入 Git。
- 清理：临时 probe、夹具与 inbound 钩子已移除；`pnpm typecheck`、`pnpm test`（576 passed）、`pnpm build` 全绿。

### 逐项结果

| AC | 方法 | 实际证据 | 结论 |
| --- | --- | --- | --- |
| AC1 工具注册可用 | 真实 channel 会话 + probe 工具调用 | 7 个 channel 会话 `mount ok=true`；模型在 p2p/群/话题中实际调用 `p0_probe`；卡片工具行可见。注：probe 的 `env.tools.injected=false` 是探针闭包 bug（未把 inject ctx 传回 execute），mount 记录与真实调用证明注册成功 | ✅ Go |
| AC2 图片原生可见 | `p0_probe image` + 让模型描述 | `modelInfo.inputModalities=[text,image]`；工具结果同时含 text 与 `{type:'image',attachment}`；模型下一轮准确描述“红圆 / 绿色方块 / 蓝色矩形 / 文字 P0-42”，未调用 `read_image`；附件对象落库并可回读 | ✅ Go |
| AC3 文件块与只读路径 | 流式生成 / Feishu 大文件 / bash 读取 / 取消 | 64MiB `saveFileStream` 0.087s，RSS 324→325MB；8MiB `file_block` 结果含 FileBlock 内容块；`bash` 读取只读路径成功（`-r--------`，内容 sha256 与 attachmentId 一致）；飞书 980,644,948 字节 zip 两次流式入库（40.98s / 44.05s，RSS 峰值 447/451MB），字节一致；1GiB slow 流在 `/stop` 后记录 `file_aborted`（53,215,305 bytes / 1.98s）。探针曾因返回值含 `undefined` 报 `value is not lossless JSON`（仅探针 bug，保存已完成；修复=输出 JSON 清洗） | ✅ Go（P1 用 FileBlock + 文本路径双保险） |
| AC4 飞书读取权限 | bot 身份调用 message API | `message.get` 引用消息 `code=0`；`message.list(chat)` `code=0`、20 条、`has_more=true`；`message.list(thread)` `code=0`、7 条；`merge_forward` 的 `message.get` 返回 3 条（容器 + 文本子消息 + 图片子消息）；容器 id 下载首块 13,546B 成功，子消息 id 下载返回 400。入群前历史未测 | ✅ Go（入群前历史留 P2 补测） |
| AC5 引用与合并转发 | 引用消息 / 合并转发 / 话题列表 | 引用消息经 `replyToMessageId` 定位并可读；合并转发资源仅容器 id 可取；话题 thread 列表可读 | ✅ Go |
| AC6 结论可执行 | 汇总判定 | 群内未 @ 文本“P0 未 @ 事件测试”出现在入站日志（`mentionedBot=false`）→ 未 @ 群消息事件可投递；话题群消息事件带 `thread_id` | ✅ Go |

### 对 P1 的输入

- P1 采用“立即建会话 + 清单 + 图片预取 + 文件懒取”，无需等待下载；通道模型声明并实测支持图片输入，图片预取成立。
- 工具输出必须做 JSON 清洗（无 `undefined`）；`AbortError` 映射为可读文本；每个 action 都落证据。
- 大文件流式 RSS 受控（980MB 文件峰值约 451MB），但 Feishu 下载约 41–44s，工具需有超时/取消与可读失败说明。
- 待补：入群前历史、p2p `message.list`、清理 probe 后的重启回放（第二次重启窗口）。
- 交付沉淀：channel `messageGet` / `messageList` 包装与 channel tool 运行时类型保留给 P1；main 提交 SHA 见 git log 与 runtime 快照。

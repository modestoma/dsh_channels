# 重构计划与进度

> 目标：让 dsh-channels **更条理**（分层清晰、单一职责）、**更优雅**（去重、统一抽象、单一事实来源）、**更可用**（模型/权限/图片/历史等能力补齐）。
> 约束：对外行为与公开 API 保持不变；每个阶段结束跑 `tsc --noEmit` + 全量 `vitest`，保持 576 个测试全绿作为安全网。

## 目标结构

```
src/
  index.ts / config.ts / service.ts        # 入口、配置、门面编排
  host/                                    # DSH 宿主类型桥（按域拆分）
  cards/                                   # 卡片 2.0 渲染（原语 + 各表面）
  interactions/                            # HITL：共享待决生命周期 + 审批 + 问答
  session/                                 # 路由存储、重启修复、会话管理、请求策略
  routing/                                 # 入站去重 / 准入 / 路由决策树
  feishu/                                  # 通道适配 + 出站投递 + 入站图片
  commands/                                # 命令注册表与分派
```

## 阶段进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1a | `dsh-types.ts`(824) → `host/{core,agent,commands,interaction,services}` + barrel | ✅ |
| 1b | `cards.ts`(792) → `cards/{primitives,streaming,approval,question}` + barrel；9 处卡片骨架收敛为原语 | ✅ |
| 2 | `interactions/pending.ts`：审批/问答共享待决卡生命周期（送达竞态、owner 门禁、超时、settle-once、撤回），两应答器各减约 40% 重复 | ✅ |
| 3a | `session/routes.ts`：RouteStore（缓存、TTL 墓碑、按会话查找） | ✅ |
| 3b | `session/repair.ts`：InflightRepair（快照、分段修正、启动修复） | ✅ |
| 3c | `feishu/delivery.ts`：CardDelivery（首帧话题卡、结果卡、分段降级、命令表情生命周期） | ✅ |
| 4 | `session/manager.ts`：live agent 借用/冷恢复、preset 组合、`/renew` 事务、推理强度挂载 | ✅ |
| 5 | `commands/registry.ts` + 注册表驱动分派：命令词表/准入/`/help` 单一事实来源；`/new` 别名 | ✅ |
| 6 | `routing/inbound.ts`：入站去重、准入、路由决策树、建/续会话、首触引导从门面拆出 | ✅ |
| 7 | `cards/streaming.ts` 构成收敛与预算/切分收敛：渲染复用 `cards/primitives.ts` 的 `card/markdown/note/foldPanel`（`buildOnboardingCard` 拆到 `cards/onboarding.ts`）；预算常量 4 → 3（删除 `CARD_PANEL_RESERVE_BYTES`）；分段按整卡真实渲染测量、续卡可用满 28 KB；切分统一避让代码围栏与表格；卡片构成收敛为「面板 → 活动行 → 正文 → 分割线 + 两行结算页脚」三层（页脚第一行：模型/会话/推理时长，第二行：上下文占比/输入输出/缓存命中）；新增 golden 结构测试 | ✅ |

行数变化：`src/service.ts` **1902 → 1381**；宿主类型 1 文件 → 5 模块；卡片 1 文件 → 4 模块 + 原语；新增共享交互基类、命令注册表、会话管理器、路由存储、重启修复、投递层。测试 240 → **274**（阶段 1–6 结束时；当前 576 个测试）。

## 可用性增强（已完成）

| 功能 | 状态 | 备注 |
|---|---|---|
| `/permissions` 权限预设 | ✅ | 默认只读展示；`allowPermissionSwitch: true` 才允许切换 |
| `/status` 增强 | ✅ | 权限预设、工作区、插件运行时长、live Agent / 路由数 |
| `/help` 分组 | ✅ | 由命令注册表派生，含 usage 提示 |
| `/new` 别名 | ✅ | 解析到 `/renew`，命令行按规范名执行 |
| 首触引导卡 | ✅ | 私聊首次触达一张，`welcomedChats` 持久化去重，`welcomeOnboarding` 可关 |
| 问答卡自由文本回答 | ✅ | 无选项问题直接开放答题；阻塞期间普通文本回复即答案（`custom`） |
| `/model` 查看与切换 | ✅ | `session/request-policy.ts` 统一 provider/model/effort；`ctx.llm.listModels` 校验；经 `command/run` 持久化 |
| 附件输入 | ✅ | v2：入站图片/文件默认进 DSH 原生附件库；触发消息图片预取、文件由 `feishu_attachment_fetch` 懒取、纯附件静默登记；`archive` 降级保留旧行为（`feishu/inbound-attachments.ts` 落工作区 `attachments/`，合并转发记录转存 `.txt`）；详见 [attachment-pipeline-v2.md](attachment-pipeline-v2.md) |
| 目录清理 | ✅ | `cleanup.ts` 纯策略 + 设置面板卡片：`workspaceRetention`（off/7/30/90/180 天）+ 手动/每日清理，只清理工作区与 Agent 产物（过期话题目录/旧版话题工作区）并把路由退休为墓碑，用户工作区、Session 日志与原生附件库保留 |

## 验证基线

```bash
cd /Users/moka/dev/project/dsh_ext/dsh_channels
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run     # 25 files, 576 tests
```

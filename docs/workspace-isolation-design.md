# 工作区粒度与会话隔离设计

> 状态：已确认并实现（v1）。目标：工作区数量随「人」增长而不是随「话题」增长，同时话题之间不互相踩文件。
>
> 附件说明：入站图片/文件只存入 **DSH 原生附件库**（不写入话题目录）；详见 [attachment-pipeline-v2.md](attachment-pipeline-v2.md)。旧版本写下的 `<话题目录>/attachments/` 与 `<baseDir>/_staging/` 不再被插件读写。

## 1. 问题

旧模型（`一个话题 = 一个 DSH 工作区`）把两个独立维度绑在了一起：

- **项目维度**：`ctx.workspaceRegistry` 是持久化项目列表，GUI 侧边栏一个分区一项，随话题无上限增长；
- **隔离维度**：模型工具产生的文件必须按话题隔开。

DSH 本身允许这两个维度解耦，见下。

## 2. DSH 的三个关键事实

1. **工作区归属只认不可变的 `SessionHeader.cwd`**：`Workspace.attachSession()` 校验 header.cwd 与工作区路径（realpath 后）完全相等；GUI 分组、重启 bootstrap 同理。
2. **实际工作目录可变**：`ctx.workingDirectory.set(agent, dir)` 写 `working-directory/change` 事件、持久化、冷恢复后还原；`bash`、`fs`、`terminal` 工具都从 `workingDirectory` 取 cwd。因此会话可以「归属 A 工作区、实际在 B 目录干活」。DSH 官方 Git worktree 也是靠这个机制保留原项目归属。
3. **沙箱写边界 = 不可变 header.cwd**，不随工作目录切换。因此本设计提供的是**行为层隔离**（工具默认在话题目录内工作、互不踩文件），不是防恶意的硬沙箱；硬边界需要 header.cwd 直接指向话题目录，代价是会话失去工作区归属（见 §6）。

## 3. 目录布局

```
<baseDir>/
  p2p/<user_id>/                    # 私聊用户工作区（注册 workspace，header.cwd）
    topics/<topic-token>/           # 话题目录（会话实际工作目录）
  groups/<chat_id>/<user_id>/       # 群聊中某成员的工作区（注册 workspace）
    topics/<topic-token>/
  topics/...                        # 旧版「话题=工作区」目录，原样保留，不自动迁移
```

- 私聊一个用户一个工作区；群聊**一个群 × 一个用户**一个工作区（不能做成「用户全局一个」：否则同一个人在不同群之间会串文件，A 群会话可能把 B 群的文件内容贴给 A 群成员）。
- `<baseDir>/p2p/...`、`<baseDir>/groups/...` 与旧版「用户 × 聊天」共享工作区路径一致，升级后旧会话仍归属同一个项目。
- 话题 token：真实话题用 `thread_id`；降级 chat-scoped 会话用其 session id。目录名经过安全字符校验。
- 入站附件：存 DSH 原生附件库（宿主管理、不可变、内容寻址去重），不占话题目录。

## 4. 隔离档位（`topicIsolation`）

| 值 | 行为 |
|---|---|
| `auto`（默认） | 工作区含 `.git`（即用户把工作区做成了 Git 仓库）时，每个话题用 DSH worktree（分支 `feishu-<token>`，checkout 在 `.agents/worktrees/`）；否则用普通话题子目录 |
| `subdir` | 始终普通话题子目录，零 Git 依赖 |
| `worktree` | 始终尝试 worktree；服务缺失 / 非 Git 仓库 / 权限不足时告警并回退子目录 |

- 子目录模式：`mkdir <workspace>/topics/<token>` 后 `workingDirectory.set` 切过去。文档/数据类工作区零成本、不复制文件。
- worktree 模式：`ctx.worktrees.create(agent, { name: 'feishu-<token>' })`，返回的 checkout 即会话目录；分支与工作树由 Git 管理，适合「多个话题并发改同一个代码仓库」。
- 两个模式都保留会话在用户工作区下的 GUI 归属，因为 header.cwd 仍是用户工作区。
- 降级：宿主没有 `workingDirectory` / `worktrees` 服务、或 worktree 创建失败时，回退为「会话直接以话题目录为 cwd」（此时不再 attach 到工作区，会话在 GUI 中可能显示为未分组；文件隔离仍然成立）。

## 5. 路由记录

`channels_routes` 的 v1 记录保持可读，新增可选字段：

- `sessionDir`：会话实际工作目录（话题目录 / worktree）；缺省表示旧记录——直接用 `workspacePath` 作为会话目录。
- `worktreeBranch`：worktree 模式下的话题分支，供目录丢失后的恢复使用。

`workspacePath` 语义变化为「用户工作区（会话 header cwd / 沙箱根）」。

## 6. 取舍与边界

- **隔离强度**：话题子目录/worktree 只保证「工具默认在话题目录工作」。同一用户工作区内的绝对路径访问仍然可行；沙箱写边界仍是用户工作区。
- **硬隔离**（不采用）：把 header.cwd 指向话题目录，会话在 GUI 中不再归属工作区。只有当话题来源不可信、必须防互相读取时才值得。
- **附件**：入站图片/文件只存 DSH 原生附件库，**不写话题目录**。旧版的 archive 后端与 `_staging/` 一次性迁入已移除（D12），遗留目录由运维手动清理；`_staging` 仍保留为工作区根路径的保留名，避免与遗留目录冲突。
- **`/renew`**：同一话题内新建 Session，复用同一话题目录（worktree 也复用）。
- **清理**：插件不删除工作区、话题目录或 Session 日志。运维可手动删除不再需要的话题目录：续聊时 `restoreTopicDir` 会重建空目录（worktree 模式下新建 worktree 分支），Session 不会回落到共享工作区根目录。手动删除 worktree checkout 后，Git 记录可用 `git worktree prune` / `branch -D` 回收。
- **迁移**：不做自动迁移。旧版 `topics/...` 工作区继续服务旧路由；旧版「用户 × 聊天」共享工作区即新的用户工作区，直接复用。

## 7. 实现位置

| 文件 | 职责 |
|---|---|
| `src/workspaces.ts` | 用户工作区 / 话题目录 / 标题 / 暂存目录解析 |
| `src/session/isolation.ts` | 隔离档位判定、工作目录进入、worktree 创建与降级恢复 |
| `src/routing/inbound.ts` | 建会话与续聊时的目录编排、路由写入 |
| `src/session/manager.ts` | 会话创建/恢复/`/renew` 的目录挂载与附件 guidance |
| `src/domain.ts` | 路由记录 v1 兼容扩展（`sessionDir` / `worktreeBranch`） |

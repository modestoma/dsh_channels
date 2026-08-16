# dsh-channels · 真机联调手册

本文档指导你**手动安装** dsh-channels 插件到本机 dsh，配置飞书机器人，并逐项验证私聊/群聊/话题群三条通道的流式卡片体验。所有步骤均已在本机 dsh checkout（web profile）上实测通过。

> 约定：下文用 `$HARNESS` 表示你的 deepseek-harness 仓库目录，`$PLUGIN` 表示本仓库目录（dsh_channels）。

## 0. 前置条件

- dsh 仓库可运行（`cd $HARNESS && pnpm dsh --help` 正常）
- 飞书企业账号 + 开发者后台访问权限
- 一个飞书测试群（用于群聊 / 话题群验证）

## 1. 飞书开放平台配置

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，创建**企业自建应用**，名称随意（如 dsh-channels）。
2. 进入应用 → **添加应用能力** → 开启 **机器人**。
3. **权限管理**，开通以下权限（发布版本时生效）：
   | 权限 | 用途 |
   |------|------|
   | `im:message`（获取与发送单聊、群组消息） | 收发消息、回复话题 |
   | `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息） | 私聊通道 |
   | `im:message.reactions:write_only`（发送、删除消息表情回复） | Typing / DONE 表态 |
   | `im:message:update`（更新消息卡片） | 流式卡片刷新（patch） |

   > 卡片更新接口本身支持 `im:message` 一项即可，但建议把 `im:message:update` 也加上，避免组合差异。
4. **事件与回调** → 事件订阅方式选择 **使用长连接接收事件**（WebSocket，免公网 IP）。
   - 添加事件：**接收消息 im.message.receive_v1**（勾选“接收群聊中 @ 机器人消息”）。
5. **凭证与基础信息** 页复制 `App ID` 与 `App Secret`。
6. **版本管理与发布** → 创建版本（权限与事件配置随版本生效）→ 发布。
7. **可用范围**：把自己（和测试同事）加入可用范围。
8. 建一个测试群，把机器人拉进群；如需验证话题群，另建一个“话题群”（创建群时选话题模式），同样拉入机器人。

## 2. 安装插件到 dsh

dsh 的插件装在 **profile** 里（`$DSH_HOME/profiles/<name>/`，`$DSH_HOME` 未设置时默认 `~/.dsh`）。web 界面使用 `web` profile，首次启动自动初始化。安装命令把 pnpm 转发到 profile 目录执行：

```bash
cd $HARNESS
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add dsh-channels@file:$PLUGIN
```

说明：

- `file:` 指向本地插件目录，机器上即可完成安装（不需要发布到 npm）。
- pnpm 可能输出 `[WARN] Issues with peer dependencies`（`@deepseek-ai/cordis` 由 dsh 统一提供，属预期）与 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: protobufjs`——**安装实际已成功**，`dsh plugin` 的非零退出码可忽略；想消除告警可在 profile 目录的 `pnpm-workspace.yaml` 加 `onlyBuiltDependencies: [protobufjs]`。
- **改了插件代码后**：重新执行上面的 `add` 命令（幂等）再重启 dsh。同一磁盘上 pnpm 会用硬链接安装 `file:` 依赖，有时改源文件会直接生效，但不要依赖这个行为。

验证安装与组合（不启动服务）：

```bash
cd $HARNESS
DSH_HOME=$DSH_HOME pnpm dsh web --dump-config | grep -A 9 "dsh-channels"
# 尚未配置补丁层时这里还看不到条目，属正常；配置完第 3 步后应能看到
```

## 3. 配置插件

### 3.1 凭据写入 dsh 凭据库

插件配置里只填**凭据引用名**，密钥本身放在 dsh 的受管凭据库 `$DSH_HOME/.credentials.yaml`（与 `DEEPSEEK_API_KEY` 同一文件，热加载，`DEEPSEEK_API_KEY` 就在里面）：

```yaml
# $DSH_HOME/.credentials.yaml
FEISHU_APP_ID: cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**权限必须是 600**（dsh 会强制校验，文件可被他人读取时直接拒绝启动）：

```bash
chmod 600 $DSH_HOME/.credentials.yaml
```

解析优先级（由 `dsh-credentials-local` 提供，热加载）：进程环境变量 > `.credentials.yaml` > 启动目录 `.env` > `$DSH_HOME/.env`。不想用凭据库时，直接导出环境变量也能生效。凭据改动后重启 dsh 生效。

### 3.2 写补丁层

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`（新条目必须用 `insert:` 列表格式）：

```yaml
# 用户补丁层：插入 dsh-channels 渠道插件
- insert:
    - id: channels
      name: 'dsh-channels'
      config:
        appId: 'FEISHU_APP_ID'              # 凭据引用名（密钥在 .credentials.yaml）
        appSecret: 'FEISHU_APP_SECRET'
        baseDir: './channels-data'          # 工作区根目录（相对 profile 目录）
        provider: 'deepseek-official'       # 可选，省略用部署默认
        model: 'deepseek-v4-flash'          # 可选
        refreshMs: 500                      # 卡片刷新间隔（下限 200ms）
        requireMention: true                # 普通群需 @ 机器人
        dmMode: 'open'                      # 私聊通道开关
        threadFallback: 'degrade'           # 话题被拒时降级为会话级路由
        loggerLevel: 'info'
```

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `appId` / `appSecret` | 必填 | 凭据引用名（shell 标识符），经 `ctx.credentials` 解析；明文密钥会被拒绝 |
| `baseDir` | `./channels-data` | 工作区目录树根：`p2p/<open_id>/`、`groups/<chat_id>/<open_id>/` |
| `provider` / `model` | 部署默认 | 新建 session 的路由；省略时继承部署默认 |
| `maxTokens` | 适配器默认 | 每次模型请求输出上限 |
| `refreshMs` | `500` | 流式卡片刷新频率（200–10000） |
| `dmMode` | `open` | 私聊开关 |
| `requireMention` | `true` | 普通群是否需要 @ 机器人（话题内续聊不受影响） |
| `threadFallback` | `degrade` | 话题回复被拒时：`degrade` 降级为会话级延续 / `strict` 直接失败 |
| `loggerLevel` | `info` | 官方 SDK 日志级别 |

验证组合无误：

```bash
cd $HARNESS
DSH_HOME=$DSH_HOME pnpm dsh web --dump-config | grep -B 1 -A 9 "name: dsh-channels"
```

## 4. 启动与日志判读

```bash
cd $HARNESS
DSH_HOME=$DSH_HOME pnpm dsh web        # 默认 http://127.0.0.1:3080
```

**连接成功**（终端会打出）：

```
[dsh-channels] feishu long connection established, bot open_id: ou_xxxxxxxx
```

**常见启动失败**：

| 输出 | 原因 |
|------|------|
| `could not resolve bot identity via /open-apis/bot/v3/info` | App ID/Secret 错误，或未开启机器人能力 |
| `permission_denied` / `invalid tenant access token` | 同上，先核对凭证再查权限 |
| `credential "FEISHU_APP_ID" is not configured` | `.credentials.yaml` 缺对应条目（或环境变量未导出），见 §3.1 |
| `is readable beyond its owner (mode 644)` | `.credentials.yaml` 权限过宽，`chmod 600` 后重启 |
| `dsh: plugin tree failed to load … dsh-channels` | 插件本身加载失败（多为 `name:` 拼写或未安装），看后续 cause |
| 无任何 `dsh-channels` 输出 | 插件未装载：检查 `--dump-config` 是否含条目、补丁层是否用了 `insert:` 格式 |

> 说明：插件内部其余日志走 dsh 的 cordis logger，web 组合下部分早期日志可能只进缓冲不落终端；上面两条**生命周期日志**（连接成功 / 启动失败）额外直接输出到控制台，联调时以它们为准。

## 5. 三通道联调清单

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 1 | 私聊 | 给机器人发一条消息 | 消息下立刻出现 **Typing** 表情 → 以话题形式回复卡片（**推理中** 折叠面板）→ 正文流式输出（500ms 刷新，面板变 **回复中**）→ 结束变 **回复结束**、Typing 变 **DONE**；卡片底部两行 session 信息 |
| 2 | 私聊续聊 | 在刚建的话题里直接再发消息（**不 @**） | 继续同一 session：卡片底部 session id 不变，input/output token 累计增长 |
| 3 | 群聊 @ | 在普通群 @ 机器人发消息 | 同 #1；该消息成为新话题根 |
| 4 | 群聊话题内 | 在上一步的话题里直接发消息（不 @） | 延续该 session，不再要求 @ |
| 5 | 同群第二个用户 | 换另一个人 @ 机器人 | 新话题 + 新 session；dsh 工作区列表中出现**独立的第二个工作区**（`groups/<chat_id>/<用户 open_id>/`） |
| 6 | 话题群 | 在话题群某话题中 @ 机器人 | 机器人直接在该话题内回复卡片（不新建话题） |
| 7 | 折叠面板 | 点面板标题 | 展开推理内容，右侧箭头翻转向上；再点收起 |
| 8 | 重启恢复 | 重启 dsh 后在旧话题里发消息 | 机器人懒恢复原 session，token 统计继续累计 |
| 9 | 降级路径 | 在关闭话题功能的群里 @ 机器人 | 正常回复（普通回复气泡），后续 @ 延续同一 session |

### 5.1 私聊话题验证点（重点）

飞书官方文档没有明示 `reply_in_thread` 对**私聊**的约束。联调时在私聊里观察第 1 步：消息是否真的聚合成“话题”形态（话题气泡）。若飞书拒绝话题回复，插件按 `threadFallback: 'degrade'` 自动改为普通回复，此时私聊内所有消息延续同一个 session（等价于“私聊整体即话题”），功能不受阻。若你希望私聊必须话题形态，把 `threadFallback` 设为 `strict` 并反馈错误码。

### 5.2 验证工作区归属

打开 dsh Web GUI → 工作区列表，应看到：

```
飞书私聊 · ou_xxx          （对应 <baseDir>/p2p/ou_xxx/）
飞书群聊 · oc_yyy · ou_xxx （对应 <baseDir>/groups/oc_yyy/ou_xxx/）
```

## 6. 常见问题排查

| 现象 | 排查 |
|------|------|
| 私聊无响应 | 用户是否在应用**可用范围**内；权限 `im:message.p2p_msg:readonly` 是否随版本发布 |
| 群聊 @ 无响应 | 事件订阅是否勾选“接收群聊中 @ 机器人消息”；机器人是否在群内且未被群主禁言 |
| 有 Typing 但无卡片 | 权限 `im:message` / `im:message:update`；卡片 2.0 需要较新的飞书客户端（升级客户端后重试） |
| 卡片正文只到某长度 | 旧版行为；新版单卡预算 28 KB（30 KB 上限留 2 KB 冗余），超长正文自动分段为多张续卡（「回复分段 n」，每卡 ≤ 5 个表格），全文保留；推理仅按剩余预算截断 |
| 报错 230099 / `ErrCode: 11310 card table number over limit` | 飞书单卡表格数量超限（真机验证上限 5 个）；新版已按“每卡最多 5 个表格”自动切分，不再触发；历史版本请重装插件并重启 dsh |
| 流式期间手动展开面板又被收起 | v1 已知取舍：patch 是全量替换卡片，500ms 内的下一次刷新会重置折叠状态；流式结束后可自由展开 |
| 错误码 `230013` | 用户不在可用范围 / 被禁用 |
| 错误码 `230071` | 该群不支持话题回复 → 自动降级路径（见 §5.1） |
| 错误码 `230099`（`parse card json err` / `unknown property, property: elements`） | 卡片结构混用：2.0 声明下把组件放在顶层 `elements`（应在 `body.elements`）。新版插件已改为规范 2.0 结构：重装插件并重启 dsh |
| 折叠面板不显示 / 正文不是富文本 | 旧版卡片的两个已知问题（`icon.tag: "img"` 非法、1.0 结构 markdown 语法受限），新版插件已切 2.0 结构 + 内置 `standard_icon` 箭头：重装插件并重启 dsh |
| 错误码 `231001` / `231002` | 表态表情失败：表情名（`Typing`/`DONE`）必须一字不差；机器人需在会话内 |

## 7. 改代码 → 生效的循环

```bash
# 1) 修改 $PLUGIN 源码后：
cd $PLUGIN && pnpm typecheck && pnpm test
# 2) 重装（幂等）并重启：
cd $HARNESS && DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add dsh-channels@file:$PLUGIN
DSH_HOME=$DSH_HOME pnpm dsh web
```

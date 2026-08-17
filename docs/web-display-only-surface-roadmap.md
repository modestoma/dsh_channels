# 飞书专用 Web 展示模式实施路线图

> 状态：规划完成，尚未开始实施  
> 评估日期：2026-08-17  
> 评估基线：`dsh_channels@1190ae3`、`deepseek-harness@4ce40c1359`

## 1. 目标

在继续保持“一个 `dsh-channels` npm 包、一个 Cordis 插件、一个 Loader row”的前提下，为 Web profile 增加一个显式的展示模式：

```yaml
- id: dsh-channels
  config:
    appId: FEISHU_APP_ID
    appSecret: FEISHU_APP_SECRET
    webSurface: display-only
```

只有 `webSurface: display-only` 时，Web 页面才隐藏以下写入入口：

1. 新建工作区入口；
2. 所有新建 Session 入口；
3. 整个会话输入区域，包括空白页工作区选择器、输入框以及 Web 侧审批/提问接管面板。

页面继续展示侧栏工作区与 Session 列表、历史消息、流式输出、工具调用、运行状态和 Session 详情。飞书仍是新建工作区、创建/恢复 Session、发送消息和处理 HITL 审批的交互入口。

未配置 `webSurface` 或显式配置为 `default` 时，Web UI 必须保持现有行为，不隐藏任何入口。非 Web profile 不因本功能新增必需依赖，也不改变飞书通道的连接和消息处理。

## 2. 语义与安全边界

本功能是 **Web UI 展示模式**，不是安全意义上的只读模式。

- 不删除或拦截 `workspace.create`、`session.create`、`session.prompt` 等 Host API。
- 能直接访问 API、修改 DOM 或禁用样式的用户仍可绕过页面限制。
- 不把 `display-only` 当作租户隔离、权限控制或不可信网络暴露方案。
- 若以后需要真正的只读权限，必须在 Host/API 层增加调用方身份、写操作策略和拒绝审计；该工作不属于本路线图。

本次 MVP 严格沿用已确认的三类隐藏目标。当前 Web UI 还存在工作区重命名/删除、Session 重命名/分叉/归档等管理动作；它们不在本次验收范围内。若产品要求“页面上的任何状态都不可修改”，应在完成本路线图后单独扩展稳定动作标记和隐藏清单，不能把当前 MVP 描述成完整权限只读。

## 3. 当前实现盘点

| 能力 | 当前状态 | 证据与影响 |
| --- | --- | --- |
| 飞书 Host 通道 | 已实现 | `src/index.ts`、`src/service.ts` 已负责飞书连接、路由、Session、卡片、命令和审批 |
| 单包、单 Loader row | 已实现 | `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，后者只插入 `dsh-channels` 一行 |
| `webSurface` 配置 | 未实现 | `src/config.ts` 当前没有该字段 |
| Host 向浏览器投影展示模式 | 未实现 | `HostContext` 没有 WebServer 最小类型，插件没有调用 `tapIndex()` |
| Client 插件入口 | 未实现 | `package.json` 没有 `exports["./client"]` 和 `dsh.client`，仓库没有 `src/client/` |
| Client 构建产物 | 未实现 | Harness 的 Client Module Loader 只读取已构建的 `lib/client.js`，不会直接执行 TypeScript 源码 |
| 输入区稳定选择器 | 已具备 | Harness `ConversationRoot` 已提供 `[data-composer-seat]` |
| 新建工作区/Session 稳定选择器 | 未具备 | 当前按钮主要依赖 CSS Module 类名或本地化 `aria-label`，不适合作为跨包契约 |
| Host API 只读策略 | 未实现 | 明确不属于本路线图 |

因此该功能不能只在 `dsh_channels` 内写一段 CSS 就可靠交付：首次实现需要在 Harness 增加一组无行为变化的稳定 DOM 动作标记；其余配置、模式投影、Client 入口和隐藏逻辑都留在 `dsh_channels` 包内。

## 4. 目标架构

```text
同一个 Loader row：dsh-channels
│
├─ Host 端（src/index.ts）
│  ├─ 继续运行现有飞书通道
│  ├─ 解析 webSurface，默认 default
│  └─ WebServer 存在且值为 display-only 时
│     └─ 通过 tapIndex() 注入固定的 <meta> 模式标记
│
└─ Client 端（src/client/index.ts → lib/client.js）
   ├─ 读取 <meta name="dsh-channels-web-surface">
   ├─ 仅在 content="display-only" 时挂载展示模式样式
   └─ fiber 卸载时移除自身样式/根标记
      ├─ [data-dsh-action="workspace.create"]
      ├─ [data-dsh-action="session.create"]
      └─ [data-composer-seat]
```

配置不会自动出现在 Harness 的 `window.__DSH_BOOT__` 中。启动图只负责 Client 插件的 `id/url/rev/inject/immediately`；`webSurface` 必须由 `dsh_channels` Host 端显式投影。投影值来自固定枚举，不允许拼接用户提供的任意 HTML。

## 5. 任务依赖

```text
WS-01 Harness 稳定动作标记 ───────────────┐
                                            ├─ WS-05 Client 展示行为
WS-02 配置契约 ── WS-03 Host 模式投影 ─────┤
                                            │
WS-04 Client 打包与包清单 ──────────────────┘
                         │
                         └─ WS-06 自动化与真实组合验证
                              └─ WS-07 文档与升级说明
                                   └─ WS-08 手动验收与交付
```

WS-01 位于 `deepseek-harness`；WS-02 至 WS-08 位于 `dsh_channels`。两个仓库分别提交，禁止把 Harness 改动混入插件提交。

## 6. 实施任务

### WS-01：为 Harness 写入口增加稳定动作标记

**仓库**：`deepseek-harness`  
**依赖**：无  
**状态**：待实施

**工作内容**：

- 在 `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` 的品牌 Logo 新会话快捷入口和主 New Session 按钮上增加 `data-dsh-action="session.create"`。
- 在 `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx` 的新增工作区按钮上增加 `data-dsh-action="workspace.create"`。
- 在 `packages/client/ui-workspace/src/client/rows/Rows.tsx` 的工作区内新建 Session “+” 按钮上增加 `data-dsh-action="session.create"`。
- 保留现有 `[data-composer-seat]` 契约，不新增对 CSS Module 类名、中文/英文文案或 `aria-label` 的依赖。
- 在对应 Client 单元测试中断言动作标记存在且点击行为不变。
- 把这些属性视作插件扩展契约；后续重构按钮结构时必须保留或同步迁移测试。

**交付物**：三个组件的稳定动作标记和回归测试。

**验收条件**：

- 展开/折叠侧栏中所有新建 Session 入口都能被 `[data-dsh-action="session.create"]` 命中。
- 宽侧栏和 rail 状态的新建工作区入口都能被 `[data-dsh-action="workspace.create"]` 命中。
- 搜索、打开既有 Session、折叠侧栏等既有行为无变化。
- Harness 相关 typecheck、Client 单测和 `git diff --check` 通过。

### WS-02：冻结 `webSurface` 配置契约

**仓库**：`dsh_channels`  
**依赖**：无  
**状态**：待实施

**工作内容**：

- 在 `src/config.ts` 增加：

  ```ts
  webSurface: z.enum(['default', 'display-only']).default('default')
  ```

- 导出对应类型时继续由 `FeishuConfig` 推导，不维护第二份字符串联合。
- 扩展 `tests/config.test.ts`：覆盖未配置默认值、两个合法值和非法值拒绝。
- 明确该字段不是 credential，不进入凭据解析，也不得改变飞书 SDK 配置。

**交付物**：配置 schema、推导类型和单元测试。

**验收条件**：

- 未配置时解析为 `default`。
- 只有精确值 `display-only` 才启用隐藏；大小写、空字符串和未知值全部拒绝启动。
- 现有配置测试和类型检查通过。

### WS-03：将 Host 配置安全投影到 Web 页面

**仓库**：`dsh_channels`  
**依赖**：WS-02  
**状态**：待实施

**工作内容**：

- 在 `src/dsh-types.ts` 增加插件实际使用的最小 WebServer 类型，只包含 `tapIndex(transform)`；不要引入整个 Harness Host 包。
- WebServer 必须是机会性依赖。不要把 `webServer` 加入顶层静态 `inject`，否则 headless/profile 中没有 WebServer 时插件会一直 PENDING。
- 通过 Cordis 的可选服务监听/注入方式注册 index transform；服务出现时注册，fiber 或服务卸载时释放 transform。
- 仅当 `webSurface === 'display-only'` 时注入：

  ```html
  <meta name="dsh-channels-web-surface" content="display-only">
  ```

- `default` 模式不注入该 meta，避免默认页面携带无意义状态。
- 将 HTML 转换实现为可独立测试的纯函数，覆盖有 `<head>` 和最小 HTML fragment 两种输入。
- 不把飞书凭据、完整插件配置或动态字符串写入 HTML。

**交付物**：最小 Host Web 类型桥、index transform、生命周期接入和测试。

**验收条件**：

- `default` 和未配置模式产生的页面不含展示模式 meta。
- `display-only` 页面只包含一份固定 meta；插件刷新/重载不重复注入。
- WebServer 缺失时飞书通道照常启动；WebServer 晚到或重载时能正确注册和清理 transform。
- transform 输出不包含 `appId`、`appSecret` 引用、密钥或其他业务配置。

### WS-04：把单包升级为可发布的 Host + Client 双端包

**仓库**：`dsh_channels`  
**依赖**：无，可与 WS-02/WS-03 并行设计但应独立提交  
**状态**：待实施

**工作内容**：

- 新增 `src/client/index.ts`，导出命名的 `apply()`；不新增第二个 npm 包或第二个 Loader row。
- 在 `package.json` 增加：

  - `exports["./client"]` 指向已构建的 `./lib/client.js`；
  - `dsh.client.platform: "web"`；
  - `dsh.client.immediately: true`，使样式插件在 App UI 呈现前进入预取阶段；
  - `files` 包含 `lib/client.js`、source map 和必要类型；
  - `build:client`、`prepack` 与构建产物检查脚本。

- 使用仓库内可复现的 bundler 配置生成 Harness 所需的 lazy-CJS 包装：

  ```js
  window.__ModuleLoader__.load({
    id: 'dsh-channels',
    factory: (require) => { /* CommonJS body */ return module.exports },
  })
  ```

- 不把 `lib/client.js` 当作手工维护源码；发布前必须由脚本生成。
- Client 端优先保持零运行时业务依赖，只使用 DOM 和 Cordis 传入的最小生命周期面，避免把 React 或 Harness Client runtime 的第二份实例打进外部 bundle。
- 保持现有 Host 默认导出面和 `cordis.patch.yml` 不变；安装者仍只看到一个插件和一行配置。

**交付物**：Client 源码入口、构建配置、`lib/client.js` 发布产物、manifest/打包测试。

**验收条件**：

- `pnpm pack --dry-run` 中包含 Host 源码、`cordis.patch.yml` 和 Client 构建产物。
- Harness Client Module Loader 能从同一个 `dsh-channels` Loader row 发现 `dsh.client`，读取 `./client` 并生成 `/plugins/dsh-channels/client.js` 图行。
- 生成的 bundle 执行后只登记 factory；插件物化时才执行主体副作用。
- 包仍然只贡献 `id: dsh-channels` 一行，没有额外安装步骤。

### WS-05：实现 Client 展示模式

**仓库**：`dsh_channels`  
**依赖**：WS-01、WS-03、WS-04  
**状态**：待实施

**工作内容**：

- Client `apply()` 读取 `meta[name="dsh-channels-web-surface"]`，只有 `content === 'display-only'` 时启用样式。
- 注入一个带包归属标记的 `<style>`，集中维护以下选择器：

  ```css
  [data-dsh-action="workspace.create"],
  [data-dsh-action="session.create"],
  [data-composer-seat] {
    display: none !important;
  }
  ```

- 样式节点使用固定 id 或 `data-plugin` 标记，重复 apply 不产生多份样式；fiber 卸载只清理自己的节点。
- 不使用 CSS Module 生成类名、本地化文本、按钮顺序、SVG 结构或 `aria-label` 作为选择器。
- 不删除 DOM、不 monkey-patch click handler、不调用 Session/Workspace API。
- 验证隐藏 composer seat 后，聊天滚动区域不保留不可见底部高度，历史消息仍可滚动到底。

**交付物**：Client 展示模式实现和 DOM 生命周期单测。

**验收条件**：

- meta 缺失、值为 `default` 或未知值时 Client 不注入隐藏样式。
- `display-only` 时四类新建入口（Logo、主按钮、工作区 “+”、新增工作区）和整个 composer seat 均不可见且不可聚焦。
- 已有工作区、Session、消息、工具调用和实时状态仍可见。
- 插件卸载或 HMR 刷新后样式无泄漏、无重复。

### WS-06：建立自动化与真实组合验证

**仓库**：两个仓库  
**依赖**：WS-01 至 WS-05  
**状态**：待实施

**工作内容**：

- `dsh_channels` 单测覆盖配置、HTML 投影、Client DOM 行为和生命周期清理。
- 扩展 package/bundle 测试，断言 `dsh.bundle.patch` 与 `dsh.client` 同时存在但 Loader row 仍只有一个。
- 增加 built-client smoke：真实执行 `lib/client.js`，断言以 id `dsh-channels` 登记 factory，物化后得到命名 `apply`。
- 在 Harness 中增加组件测试，固定 `data-dsh-action` 契约。
- 使用本地 link 安装到 Web profile，分别以 `default` 和 `display-only` 启动真实 Web 组合；检查启动图、bundle route 和最终 DOM，而不是只检查自定义函数返回值。
- 为 display-only 场景预置已有工作区/Session/日志，证明页面不是被整体隐藏，而是仍能观察飞书创建的会话。

**交付物**：跨层自动化测试、真实 Loader/Web 组合检查和失败诊断说明。

**验收条件**：

- `pnpm typecheck`、`pnpm test`、构建产物 smoke 和两个仓库的 `git diff --check` 通过。
- 默认模式的可见按钮数量与改造前一致。
- display-only 模式下目标元素计算样式为不可见，键盘 Tab 不能落到这些入口。
- 浏览器控制台无 Client bundle 加载、factory 登记、重复样式或 React 运行时错误。
- 不使用真实飞书也能完成 Web 组合回归；真实飞书链路留在 WS-08 最终验收。

### WS-07：补齐用户文档与升级说明

**仓库**：`dsh_channels`  
**依赖**：WS-02 至 WS-06  
**状态**：待实施

**工作内容**：

- 更新 `README.md` 配置示例和配置字段说明。
- 更新 `docs/feishu-onboarding.md`，说明 Web profile 下的启用步骤、默认行为和排障方式。
- 明确写出：

  - `display-only` 只影响 Web UI；
  - 未配置和 `default` 完全保持原 UI；
  - headless 不受影响；
  - API 写能力仍存在；
  - 需要包含 WS-01 动作标记的 Harness 版本。

- 给出兼容性失败表现：Harness 版本过旧时，composer 会隐藏，但缺少动作标记的侧栏按钮不会被可靠隐藏；启动检查应尽可能显式提示，而不是静默宣称成功。
- 记录构建与发布要求，避免发布不含 `lib/client.js` 的包。

**交付物**：README、接入文档和兼容性说明。

**验收条件**：

- 用户只需安装一次 `dsh-channels`、配置同一 Loader row 和一个字段。
- 文档不使用“权限只读”“接口已禁用”等错误表述。
- 所有相对链接有效，示例字段与 `configSchema` 一致，`git diff --check` 通过。

### WS-08：真实飞书与浏览器联合验收

**仓库**：`dsh_channels`  
**依赖**：WS-06、WS-07  
**状态**：待实施

**工作内容**：

- 使用真实 Web profile、真实飞书机器人和至少一个浏览器执行第 7 节验收表。
- 验收期间同时观察飞书消息、Host 日志、浏览器 DOM/控制台和 Session 持久化结果。
- 将日期、Harness/dsh_channels 版本、浏览器、结论和证据直接填写在本文档中，不另建一份验收文件。

**交付物**：本文档内完成的手动验收记录。

**验收条件**：

- 第 7 节 DV-01 至 DV-12 全部通过。
- 没有把静态测试或 mock 结果代替真实飞书/Web 联合验收。
- 两个仓库的提交边界清晰；不夹带实施前已有的无关工作树变更。

## 7. 手动验收记录

| 编号 | 场景 | 操作与预期 | 状态 | 日期/证据 |
| --- | --- | --- | --- | --- |
| DV-01 | 默认兼容 | 删除 `webSurface` 后启动 Web；新建工作区、新建 Session 和输入区全部保持可见 | 未执行 | — |
| DV-02 | 显式默认 | 配置 `webSurface: default`；行为与 DV-01 完全一致 | 未执行 | — |
| DV-03 | 配置拒绝 | 配置未知值；启动阶段给出明确 schema 错误 | 未执行 | — |
| DV-04 | 单包加载 | `--dump-config` 只有一个 `dsh-channels` Loader row，启动图同时包含其 Client entry | 未执行 | — |
| DV-05 | 工作区入口 | `display-only` 下宽侧栏和折叠 rail 均无新增工作区入口 | 未执行 | — |
| DV-06 | Session 入口 | `display-only` 下 Logo、主 New Session 按钮和每个工作区 “+” 均不可见、不可聚焦 | 未执行 | — |
| DV-07 | 输入区 | 打开已有 Session；composer、发送按钮和 Web 审批/提问接管区均不可见 | 未执行 | — |
| DV-08 | 展示完整性 | 飞书发送消息并触发工具调用；Web 自动出现/更新对应 Session、消息、工具状态和最终回复 | 未执行 | — |
| DV-09 | 历史导航 | 从侧栏切换多个既有 Session；历史消息可读，滚动到底无异常空白 | 未执行 | — |
| DV-10 | 飞书唯一交互 | 在飞书继续同一话题并完成一次 HITL 审批；Web 实时反映结果但不提供输入入口 | 未执行 | — |
| DV-11 | 非 Web profile | 在没有 WebServer 的 profile 启动；飞书长连接、消息处理和卸载均正常 | 未执行 | — |
| DV-12 | 生命周期 | 刷新、插件 HMR/重载、正常关闭；无重复 meta/style、无 bundle 404、无残留生命周期错误 | 未执行 | — |

## 8. 提交与实施顺序

建议按以下顺序做小提交，每一步通过自己的验收后再进入下一步：

1. `deepseek-harness`：`feat(web): expose stable create-action markers`（WS-01）。
2. `dsh_channels`：`feat: add web surface configuration`（WS-02）。
3. `dsh_channels`：`feat: project web display mode from host`（WS-03）。
4. `dsh_channels`：`build: add client plugin bundle`（WS-04）。
5. `dsh_channels`：`feat: hide web write surfaces in display-only mode`（WS-05）。
6. 两仓分别提交自己的测试；插件文档与最终验收记录最后提交（WS-06 至 WS-08）。

实施前必须重新检查两个工作树。路线图编写时 `dsh_channels` 已存在与斜杠命令后续实现有关的未提交修改；后续提交需要逐文件、逐 hunk 暂存，不能覆盖或夹带这些既有改动。

## 9. 完成交付标准

只有同时满足以下条件，才能把本路线图标记为完成：

- `webSurface` 默认兼容和显式 `display-only` 行为均有自动化覆盖。
- Harness 提供经过测试的稳定动作标记，插件不依赖 CSS Module 类名或本地化文本。
- 同一 npm 包同时交付 Host 和 Client 入口，且仍只有一个 Loader row。
- 发布包真实包含可被 Harness 加载的 `lib/client.js`。
- Web profile、非 Web profile、插件卸载/HMR 均通过生命周期验证。
- 真实飞书消息能创建/更新 Web 中可观察的 Session，而 Web 的三类写入口保持隐藏。
- DV-01 至 DV-12 均填写为通过并附版本与证据。
- 文档明确保留“UI 展示模式，不是安全只读”的边界。

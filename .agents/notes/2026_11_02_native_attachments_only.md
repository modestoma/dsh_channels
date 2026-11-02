# 入站附件只用 DSH 原生附件库（2026-11-02）

## 问题与适用范围

插件同时维护两套入站附件存储：默认的 native（`ctx.attachments`，图片预取、文件由 `feishu_attachment_fetch` 懒取）和旧版 archive（会话建立前把图片/文件同步下载到话题目录 `attachments/`，话题未建时先写 `<baseDir>/_staging/`）。archive 在三种情况下生效：显式 `attachmentStore: 'archive'`、宿主未挂载原生附件库、`feishuTools.attachmentFetch=false`。适用于入站准入、附件 guidance、fetch 工具挂载与设置面板。

## 备选方案

1. **保留双后端（原实现）**：每条入站消息、guidance、工具挂载和工具描述都要先算生效后端；archive 落盘、`_staging` 迁入、旧版提示词与失败提示整套代码和测试一直要维护。
2. **采纳：只用原生附件库**：删除 archive 后端、`InboundAttachmentStore`、后端选择与降级、`_staging` 一次性迁入（D12 原定的移除时点已到）、`attachmentStore` 与 `feishuTools.attachmentFetch` 配置项；`attachments` 加入插件 `inject` 列表，缺少原生附件库时插件不启动；`acceptAttachments` 成为唯一开关，同时决定 guidance、清单与 fetch 工具。

## 用户选择与理由

- 用户于 2026-11-02 决定附件统一采用 DSH 原生附件库，不再自己维护。
- 理由：DSH 默认组合（base bundle）已挂载 `dsh-attachment-local`，archive 只服务于少见的降级部署；去掉它可以删掉约 800 行源码和对应测试，入站路径只剩一条。
- 不改 deepseek-harness：插件只消费原生附件库已有的 `saveImage` / `saveFileStream` / `fileHostPath` / `imageHostPath`。
- 代价：没有原生附件库的精简组合无法加载插件（以前会降级到 archive）；原生附件库里的文件是只读的且不会自动清理，模型要修改或回发文件需先复制到工作区；旧版本留下的 `attachments/` 与 `_staging/` 不迁移，由运维手动清理。

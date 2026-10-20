# attachment_pipeline_v2 整体交付与验收

本文件保存整体验证证据与用户验收结论；当前调度和同步状态见协调者 checkout 的 `runtime.json`。

| AC | 实现入口 | 实际验证与证据 | 未验证项 / 遗留问题 |
| --- | --- | --- | --- |
| AC-1 / AC-2 / AC-3 / AC-5 / AC-7（P0 局部） | [platform_spike.md](../../issues/platform_spike.md) | 2026-10-20 P0：工具注册、图片原生可见（含重启后历史回放）、文件流式/只读路径/取消、大文件 980MB 流式入库（RSS 峰值 451MB）、飞书 get/list/合并转发容器、未 @ 事件投递均通过 | 入群前历史与 p2p message.list 待 P2 补测 |

## 用户验收

尚未获得用户验收结论。通过时记录具体 revision、交付 SHA、用户结论与确认来源；驳回时记录关联返工任务。

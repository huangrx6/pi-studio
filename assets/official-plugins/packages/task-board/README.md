# 任务看板

在「设置 → 插件 → 官方精选」安装任务看板。从工作台启动台的「插件」分组打开，也可以在输入框运行 `/taskboard`。所有工作区和会话共享同一份任务。当前应用需要支持全局任务看板协议。

点击「新增任务」记录标题、详情、状态、优先级，以及计划和实际的开始与结束时间。点击卡片可编辑，拖到另一列可改状态。状态包括待办、进行中、受阻和已完成。时间字段可留空，按设备当前时区显示。看板可按任务创建日期筛选。

## AI 查询

- `task_board_list` 支持按状态、本地日期范围和日期字段查询。比如用 `{"status":"in_progress","dateField":"plannedEndAt","from":"today","to":"today"}` 查今天计划结束的进行中任务。日期也可写成 `YYYY-MM-DD`，首尾日期均包含在内。
- `task_board_get` 用任务 ID 查询完整详情和时间。可在输入框用 `$` 选择「任务看板」并用自然语言提问。

## 数据位置

`~/.pi-studio/plugin-data/studio.task-board/studio.task-board/tasks.sqlite` 保存全局任务。升级和重装沿用这份数据库。任务独立于会话与工作区的归档和删除。

看板由 Studio 渲染，使用 MIT 许可的 [React Kanban](https://github.com/christopher-caldwell/react-kanban) 和 [Hello Pangea DnD](https://github.com/hello-pangea/dnd)。

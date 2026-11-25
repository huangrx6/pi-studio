---
name: task-board-reporting
description: Query Pi Studio Task Board records and synthesize daily reports, weekly reports, or project-specific progress summaries in any conversation or temporary chat.
---

# 任务看板梳理与汇报（日报 / 周报 / 项目复盘）

当用户要求写日报、周报、复盘某一时间段的工作、或按项目梳理对接任务进展时，优先调用任务看板的只读工具，基于真实任务与进展记录生成总结，不要凭空编造未记录的任务或日期。

## 可用工具

1. `task_board_summary({ from, to, project?, type? })`
   - 聚合指定本地日期区间（`YYYY-MM-DD` 或 `today`）内的：
     - `completed`：区间内实际完成的任务（按 `actualEndAt` 归属，包含后续已归档的任务；不会因后续归档或改名而算错日期）。
     - `progressed`：未在区间内完成但有进展记录、状态推进或实际开始的任务，含按日期整理好的 `notes`。
     - `blocked`：当前受阻或区间内受阻的事项。
     - `planned`：正在进行中或高优先级待办事项，可用于明日/下周计划。
     - `stats`：按类型（`feature` 需求 / `bug` Bug / `improvement` 优化 / `chore` 常规任务）与关联项目（`byProject`）的统计。
2. `task_board_list(...)`：需要按状态、类型、项目、关键词或归档状态做补充检索时调用。
3. `task_board_get({ id })`：需要深入核对某条任务的完整详情与逐条活动记录时调用。

## 整理口径

- **日报**：
  - 分四块：`今日完成`、`今日推进`、`当前阻塞`、`明日计划`。
  - 保留当天具体的进展记录（例如“已复现，等待上游确认”），多项目对接任务标注涉及的项目名（如 `[项目A / 项目B]`）。
- **周报**：
  - 分四块：`本周成果`（按 **需求 / Bug 修复 / 优化 / 常规任务** 归类，同一任务去重只出现一次）、`跨天推进`（把同一任务多天记录合并为凝练进展）、`仍待解决的问题`、`下周计划`。
  - 如果用户指定了某个项目或对接方，可在 `task_board_summary` 中传入 `project` 参数，或在周报里按项目维度小节汇总。
- **自定义需求**：
  - 严格遵守用户额外指定的时间范围、受众口吻（发给团队、同步给合作方、个人复盘等）和侧重点。
  - 若某个区间缺少历史进展记录，如实说明，不补写未发生的事实。

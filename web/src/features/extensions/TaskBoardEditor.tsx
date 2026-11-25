import { Fragment, useState } from 'react';
import { Clock3, Flag } from 'lucide-react';
import { DatePicker } from '../../shared/DatePicker';
import { Select } from '../../shared/Select';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { errorText } from '../../shared/error-text';
import type {
  TaskBoardFields, TaskBoardMutation, TaskBoardPriority, TaskBoardScheduleField, TaskBoardStatus, TaskBoardTask,
} from '../../types/task-board';
import {
  localDateTime, readLocalDateTime, SCHEDULE_GROUPS, TASK_PRIORITY_LABELS, TASK_STATUS_ICONS, TASK_STATUS_LABELS,
} from './task-board-fields';
import './styles/task-board-editor.css';

type EditorFields = Omit<TaskBoardFields, TaskBoardScheduleField> & Record<TaskBoardScheduleField, string>;
const statusOptions = Object.entries(TASK_STATUS_LABELS).map(([value, label]) => ({ value, label }));
const priorityOptions = Object.entries(TASK_PRIORITY_LABELS).map(([value, label]) => ({ value, label }));

function initialFields(task: TaskBoardTask | undefined, initialStatus: TaskBoardStatus): EditorFields {
  const time = (key: TaskBoardScheduleField) => task?.[key] ? localDateTime(new Date(task[key])) : '';
  return {
    title: task?.title ?? '',
    details: task?.details ?? '',
    status: task?.status ?? initialStatus,
    priority: task?.priority ?? 'normal',
    plannedStartAt: time('plannedStartAt'),
    plannedEndAt: time('plannedEndAt'),
    actualStartAt: time('actualStartAt'),
    actualEndAt: time('actualEndAt'),
  };
}

export function TaskBoardEditor({ task, initialStatus, busy, onSave, onClose }: {
  task?: TaskBoardTask;
  initialStatus: TaskBoardStatus;
  busy: boolean;
  onSave: (mutation: TaskBoardMutation) => Promise<unknown>;
  onClose: () => void;
}) {
  const [id] = useState(() => task?.id ?? crypto.randomUUID());
  const [form, setForm] = useState(() => initialFields(task, initialStatus));
  const [error, setError] = useState<string | null>(null);
  const StatusIcon = TASK_STATUS_ICONS[form.status];
  const update = <Key extends keyof EditorFields>(key: Key, value: EditorFields[Key]) => {
    setForm(previous => ({ ...previous, [key]: value }));
  };

  function timePicker(key: TaskBoardScheduleField, label: string) {
    return <DatePicker includeTime label={label} placeholder="选择时间" value={form[key]} disabled={busy}
      onChange={value => update(key, value)} />;
  }

  return <SettingsDialog title={task ? '编辑任务' : '新增任务'} action={task ? '保存更改' : '新增任务'}
    className="task-board-editor" busy={busy} loading={false} unavailable={!form.title.trim()} error={error} onClose={onClose}
    onSubmit={dismiss => {
      void (async () => {
        setError(null);
        try {
          const time = (key: TaskBoardScheduleField) => readLocalDateTime(form[key], task?.[key]);
          const fields = {
            ...form,
            plannedStartAt: time('plannedStartAt'),
            plannedEndAt: time('plannedEndAt'),
            actualStartAt: time('actualStartAt'),
            actualEndAt: time('actualEndAt'),
          };
          await onSave(task
            ? { action: 'update', id, revision: task.revision, fields }
            : { action: 'create', id, fields });
          await dismiss(onClose);
        } catch (reason) {
          setError(errorText(reason));
        }
      })();
    }}>
    <div className="task-board-form">
      <div className="task-board-copy">
        <input type="text" required aria-label="标题" placeholder="任务标题" maxLength={160} value={form.title}
          onChange={event => update('title', event.target.value)} />
        <textarea aria-label="详情" placeholder="添加任务详情…" maxLength={4000} rows={2} value={form.details}
          onChange={event => update('details', event.target.value)} />
      </div>
      <div className="task-board-properties">
        <div className="task-board-property" data-task-status={form.status}>
          <span>状态</span>
          <Select label="状态" leadingIcon={<StatusIcon />} options={statusOptions} value={form.status} disabled={busy}
            onChange={value => update('status', value as TaskBoardStatus)} />
        </div>
        <div className="task-board-property" data-priority={form.priority}>
          <span>优先级</span>
          <Select label="优先级" leadingIcon={<Flag />} options={priorityOptions} value={form.priority} disabled={busy}
            onChange={value => update('priority', value as TaskBoardPriority)} />
        </div>
      </div>
      <section className="task-board-schedule" aria-label="时间安排">
        <h3><Clock3 aria-hidden="true" />时间安排</h3>
        <div className="task-board-schedule-grid">
          <span aria-hidden="true" className="task-board-schedule-spacer" />
          <span aria-hidden="true">开始</span>
          <span aria-hidden="true">结束</span>
          {SCHEDULE_GROUPS.map(({ label, start, end }) => <Fragment key={label}>
            <strong>{label}</strong>
            {timePicker(start, label + '开始时间')}
            {timePicker(end, label + '结束时间')}
          </Fragment>)}
        </div>
      </section>
    </div>
  </SettingsDialog>;
}

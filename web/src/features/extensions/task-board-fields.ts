import { CircleAlert, CircleCheck, CircleDashed, CircleDot, type LucideIcon } from 'lucide-react';
import type { TaskBoardPriority, TaskBoardScheduleField, TaskBoardStatus } from '../../types/task-board';

export const TASK_STATUS_LABELS: Record<TaskBoardStatus, string> = {
  todo: '待办',
  in_progress: '进行中',
  blocked: '受阻',
  done: '已完成',
};

export const TASK_STATUS_ICONS = {
  todo: CircleDashed,
  in_progress: CircleDot,
  blocked: CircleAlert,
  done: CircleCheck,
} satisfies Record<TaskBoardStatus, LucideIcon>;

export const TASK_PRIORITY_LABELS: Record<TaskBoardPriority, string> = {
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急',
};

export const SCHEDULE_GROUPS = [
  { label: '计划', start: 'plannedStartAt', end: 'plannedEndAt' },
  { label: '实际', start: 'actualStartAt', end: 'actualEndAt' },
] as const satisfies readonly { label: string; start: TaskBoardScheduleField; end: TaskBoardScheduleField }[];

const pad = (value: number, length = 2) => String(value).padStart(length, '0');
export function localDate(date: Date) {
  return [pad(date.getFullYear(), 4), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
}

export function localDateTime(date: Date) {
  return localDate(date) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

export function readLocalDateTime(value: string, original?: string | null) {
  if (!value) return null;
  if (original && localDateTime(new Date(original)) === value) return original;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localDateTime(date) !== value) throw new Error('请选择有效的本地日期和时间');
  return date.toISOString();
}

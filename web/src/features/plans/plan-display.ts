import type { PlanRun, PlanSchedule } from '../../types/plans';
import { addPickerDays, parseIsoDay } from '../../shared/date-picker';

export const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
export const workingDays = [1, 2, 3, 4, 5];
export const runStatus: Record<PlanRun['status'], string> = {
  queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已停止',
};

export function localZone() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }

export function mondayOf(day: string) {
  return addPickerDays(day, -((parseIsoDay(day)!.getDay() + 6) % 7));
}

export function weekDays(monday: string) {
  return Array.from({ length: 7 }, (_, index) => addPickerDays(monday, index));
}

export function scheduleLabel(rule: PlanSchedule) {
  if (rule.kind === 'once') return `${rule.date} · ${rule.time} · 单次`;
  if (rule.kind === 'interval') return rule.minutes % 60 === 0 ? `每隔 ${rule.minutes / 60} 小时` : `每隔 ${rule.minutes} 分钟`;
  if (rule.kind === 'daily') return `每天 · ${rule.time}`;
  if (rule.kind === 'monthly') return `每月${rule.day === 'last' ? '最后一天' : ` ${rule.day} 日`} · ${rule.time}`;
  if (rule.days.join(',') === workingDays.join(',')) return `工作日 · ${rule.time}`;
  return `每周${[1, 2, 3, 4, 5, 6, 0].filter(d => rule.days.includes(d)).map(d => weekdayNames[d]).join('、')} · ${rule.time}`;
}

const formatTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function timeLabel(at: number) { return formatTime.format(at); }
export function dayLabel(at: number, now = new Date()) {
  const date = new Date(at);
  if (date.toDateString() === now.toDateString()) return '今天';
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return '明天';
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
export function stamp(at: number) { return `${dayLabel(at)} ${timeLabel(at)}`; }

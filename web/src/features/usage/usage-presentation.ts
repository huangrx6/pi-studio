import type { UsageAnalyticsSnapshot, UsageTotals } from '../../types/usage-types';

export const ALL_MODELS = '__all__';
export type ModelRange = 'all' | 'today' | '7' | '30' | '90' | '365' | 'custom';
export type ModelWindow = { all: true } | { days: number } | { sinceDay: string; untilDay: string };

export const modelKey = (providerId: string, modelId: string) => `${providerId}\0${modelId}`;
export function dayKey(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
export function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isFinite(date.getTime()) && dayKey(date) === value ? date : null;
}
export function dayFromToday(offset: number, now = Date.now()): string {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return dayKey(date);
}
export function usageModelWindow(range: ModelRange, from: string, to: string, now = Date.now()): ModelWindow | null {
  if (range === 'all') return { all: true };
  if (range === 'custom') return parseDay(from) && parseDay(to) && from <= to ? { sinceDay: from, untilDay: to } : null;
  if (range === 'today') {
    const today = dayFromToday(0, now);
    return { sinceDay: today, untilDay: today };
  }
  return { days: Number(range) };
}
export function heatmapDates(snapshot: Pick<UsageAnalyticsSnapshot, 'sinceDay' | 'generatedAt'>): string[] {
  const start = parseDay(snapshot.sinceDay);
  const end = parseDay(dayKey(new Date(snapshot.generatedAt)));
  if (!start || !end || start > end) return [];
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const dates: string[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) dates.push(dayKey(cursor));
  return dates;
}
export function heatLevel(value: number, maximum: number): number {
  if (value <= 0) return 0;
  const ratio = maximum > 0 ? value / maximum : 0;
  return ratio <= .18 ? 1 : ratio <= .42 ? 2 : ratio <= .72 ? 3 : 4;
}
export function shareOf(value: number, total: number): number {
  return Number.isFinite(value) && Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
}
export function tokenParts(totals: Pick<UsageTotals, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'totalTokens'>) {
  return [
    { label: '输入', value: totals.input, className: 'is-input' },
    { label: '输出', value: totals.output, className: 'is-output' },
    { label: '缓存', value: totals.cacheRead + totals.cacheWrite, className: 'is-cache' },
  ].map(part => ({ ...part, share: shareOf(part.value, totals.totalTokens) }));
}
export function shareLabel(share: number): string {
  return share > 0 && share < .001 ? '<0.1%' : `${Math.round(share * 1000) / 10}%`;
}
/** Column-major calendar: vertical keys move a day, horizontal keys move a week. */
export function heatmapNavigation(dates: string[], current: string, key: string): string | null {
  const index = dates.indexOf(current);
  if (index < 0 || !dates.length) return null;
  const offsets: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };
  if (key === 'Home') return dates[0];
  if (key === 'End') return dates[dates.length - 1];
  if (!(key in offsets)) return null;
  return dates[Math.max(0, Math.min(dates.length - 1, index + offsets[key]))];
}

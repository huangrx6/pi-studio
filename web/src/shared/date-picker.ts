/**
 * Pure local-calendar helpers for the shared date picker.
 *
 * Calendar days stay in YYYY-MM-DD form. Dates are built at local noon so
 * daylight-saving transitions cannot move a calendar day.
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
export const DATE_PICKER_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function atLocalNoon(year: number, monthIndex: number, day: number) {
  const date = new Date(2000, 0, 1, 12);
  date.setFullYear(year, monthIndex, day);
  return date;
}

/** Parse a renderer-safe YYYY-MM-DD value as a local calendar date. */
export function parseIsoDay(value: string) {
  const match = ISO_DAY.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = atLocalNoon(year, month - 1, day);
  return year > 0 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

/** Serialize a local calendar date without converting it to UTC. */
export function isoDay(date: Date) {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function todayIsoDay() {
  return isoDay(new Date());
}

/** Normalize a valid day to the first day in its month. */
export function monthStart(value = todayIsoDay()) {
  const date = parseIsoDay(value) || new Date();
  return isoDay(atLocalNoon(date.getFullYear(), date.getMonth(), 1));
}

/** Format the trigger value as a stable, locale-independent numeric date. */
export function formatPickerDay(value: string) {
  return parseIsoDay(value) ? String(value).replace(/-/g, '/') : '';
}

/** Accept 9:30 or 0930 and return a 24-hour HH:mm value. */
export function normalizePickerTime(value: string) {
  const match = /^(\d{1,2}):?(\d{2})$/.exec(value.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return '';
  return match[1].padStart(2, '0') + ':' + match[2];
}

/** Human-readable month heading used inside the popover. */
export function formatPickerMonth(value: string) {
  const date = parseIsoDay(value);
  if (!date) return '';
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

export function pickerWeekday(value: string) {
  const date = parseIsoDay(value);
  return date ? `星期${WEEKDAYS[date.getDay()]}` : '';
}

export function addPickerDays(value: string, amount: number) {
  const date = parseIsoDay(value);
  if (!date || !Number.isFinite(amount)) return '';
  date.setDate(date.getDate() + amount);
  return isoDay(date);
}

/** Shift months while clamping the original day to the target month's end. */
export function addPickerMonths(value: string, amount: number) {
  const date = parseIsoDay(value);
  if (!date || !Number.isFinite(amount)) return '';
  const day = date.getDate();
  const target = atLocalNoon(date.getFullYear(), date.getMonth() + amount, 1);
  const lastDay = atLocalNoon(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return isoDay(target);
}

/**
 * Six complete Monday-to-Sunday weeks, including adjacent-month days.
 * The fixed 42-cell matrix keeps the popover from resizing between months.
 */
export function pickerCalendarDays(value: string) {
  const first = monthStart(value);
  const parsed = parseIsoDay(first)!;
  const mondayOffset = (parsed.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_item, index) => addPickerDays(first, index - mondayOffset));
}

export function isPickerDayDisabled(value: string, min = '', max = '') {
  if (!parseIsoDay(value)) return true;
  if (parseIsoDay(min) && value < min) return true;
  if (parseIsoDay(max) && value > max) return true;
  return false;
}

export function isSamePickerMonth(left: string, right: string) {
  return monthStart(left).slice(0, 7) === monthStart(right).slice(0, 7);
}

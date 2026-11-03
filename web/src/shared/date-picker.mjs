/**
 * Pure local-calendar helpers for the shared date picker.
 *
 * Values stay in YYYY-MM-DD form at every component boundary. Dates are built
 * at local noon so daylight-saving transitions cannot move a calendar day.
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
export const DATE_PICKER_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function validParts(year, month, day) {
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

/** Parse a renderer-safe YYYY-MM-DD value as a local calendar date. */
export function parseIsoDay(value) {
  const match = ISO_DAY.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return validParts(year, month, day) ? new Date(year, month - 1, day, 12) : null;
}

/** Serialize a local calendar date without converting it to UTC. */
export function isoDay(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function todayIsoDay() {
  return isoDay(new Date());
}

/** Normalize a valid day to the first day in its month. */
export function monthStart(value = todayIsoDay()) {
  const date = parseIsoDay(value) || parseIsoDay(todayIsoDay());
  return isoDay(new Date(date.getFullYear(), date.getMonth(), 1, 12));
}

/** Format the trigger value as a stable, locale-independent numeric date. */
export function formatPickerDay(value) {
  return parseIsoDay(value) ? String(value).replace(/-/g, '/') : '';
}

/** Human-readable month heading used inside the popover. */
export function formatPickerMonth(value) {
  const date = parseIsoDay(value);
  if (!date) return '';
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

export function pickerWeekday(value) {
  const date = parseIsoDay(value);
  return date ? `星期${WEEKDAYS[date.getDay()]}` : '';
}

export function addPickerDays(value, amount) {
  const date = parseIsoDay(value);
  if (!date || !Number.isFinite(amount)) return '';
  date.setDate(date.getDate() + amount);
  return isoDay(date);
}

/** Shift months while clamping the original day to the target month's end. */
export function addPickerMonths(value, amount) {
  const date = parseIsoDay(value);
  if (!date || !Number.isFinite(amount)) return '';
  const day = date.getDate();
  const target = new Date(date.getFullYear(), date.getMonth() + amount, 1, 12);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  target.setDate(Math.min(day, lastDay));
  return isoDay(target);
}

/**
 * Six complete Monday-to-Sunday weeks, including adjacent-month days.
 * The fixed 42-cell matrix keeps the popover from resizing between months.
 */
export function pickerCalendarDays(value) {
  const first = monthStart(value);
  const parsed = parseIsoDay(first);
  const mondayOffset = (parsed.getDay() + 6) % 7;
  const start = addPickerDays(first, -mondayOffset);
  return Array.from({ length: 42 }, (_item, index) => addPickerDays(start, index));
}

export function isPickerDayDisabled(value, min = '', max = '') {
  if (!parseIsoDay(value)) return true;
  if (parseIsoDay(min) && value < min) return true;
  if (parseIsoDay(max) && value > max) return true;
  return false;
}

export function isSamePickerMonth(left, right) {
  return monthStart(left).slice(0, 7) === monthStart(right).slice(0, 7);
}

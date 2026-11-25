import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addPickerDays,
  addPickerMonths,
  formatPickerDay,
  formatPickerMonth,
  isPickerDayDisabled,
  monthStart,
  normalizePickerTime,
  parseIsoDay,
  pickerCalendarDays,
  pickerWeekday,
} from '../../web/src/shared/date-picker.ts';

test('date picker parses and formats local calendar days deterministically', () => {
  const date = parseIsoDay('2026-10-05');
  assert.ok(date);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(formatPickerDay('2026-10-05'), '2026/10/05');
  assert.equal(formatPickerMonth('2026-10-05'), '2026 年 10 月');
  assert.equal(pickerWeekday('2026-10-05'), '星期一');
  assert.equal(monthStart('2026-10-21'), '2026-10-01');
  assert.equal(parseIsoDay('2026-02-30'), null);
  assert.equal(parseIsoDay('not-a-day'), null);
});

test('date picker builds a stable Monday-first six-week calendar', () => {
  const days = pickerCalendarDays('2026-10-05');
  assert.equal(days.length, 42);
  assert.equal(days[0], '2026-09-28');
  assert.equal(days[41], '2026-11-08');
  assert.equal(days[3], '2026-10-01');
});

test('date picker shifts across leap days and respects inclusive bounds', () => {
  assert.equal(addPickerDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addPickerMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addPickerMonths('2024-03-31', -1), '2024-02-29');
  assert.equal(isPickerDayDisabled('2026-10-04', '2026-10-05', '2026-10-10'), true);
  assert.equal(isPickerDayDisabled('2026-10-05', '2026-10-05', '2026-10-10'), false);
  assert.equal(isPickerDayDisabled('2026-10-10', '2026-10-05', '2026-10-10'), false);
  assert.equal(isPickerDayDisabled('2026-10-11', '2026-10-05', '2026-10-10'), true);
});

test('date-time picker retains early supported dates and validates 24-hour times', () => {
  assert.equal(formatPickerDay('0001-01-04'), '0001/01/04');
  assert.ok(pickerCalendarDays('0001-01-04').includes('0001-01-04'));
  assert.equal(addPickerMonths('0099-12-01', 1), '0100-01-01');
  assert.equal(normalizePickerTime('9:30'), '09:30');
  assert.equal(normalizePickerTime('0930'), '09:30');
  assert.equal(normalizePickerTime('00:00'), '00:00');
  assert.equal(normalizePickerTime('23:59'), '23:59');
  assert.equal(normalizePickerTime('24:00'), '');
  assert.equal(normalizePickerTime('09:60'), '');
});

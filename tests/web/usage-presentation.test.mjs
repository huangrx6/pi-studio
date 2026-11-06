import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dayFromToday, heatmapDates, heatmapNavigation, modelKey, parseDay,
  shareLabel, shareOf, tokenParts, usageModelWindow,
} from '../../web/src/features/usage/usage-presentation.ts';

test('token widths use actual fractions without minimums, gaps or fabricated nonzero shares', () => {
  const parts = tokenParts({ input: 9900, output: 1, cacheRead: 98, cacheWrite: 1, totalTokens: 10000 });
  parts.forEach((part, index) => assert.ok(Math.abs(part.share * 100 - [99, .01, .99][index]) < 1e-12));
  assert.equal(parts.reduce((sum, part) => sum + part.share, 0), 1);
  assert.deepEqual(tokenParts({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }).map(part => part.share), [0, 0, 0]);
  assert.equal(shareOf(0, 10000), 0);
  assert.equal(shareOf(1, 10000), .0001);
  assert.equal(shareLabel(.0001), '<0.1%');
});

test('custom windows reject invalid or reversed dates but retain same-day and future dates', () => {
  assert.equal(parseDay('2026-02-29'), null);
  assert.equal(parseDay('2026-02-30'), null);
  assert.equal(parseDay('2026-2-01'), null);
  assert.ok(parseDay('2028-02-29'));
  assert.equal(usageModelWindow('custom', '', '2026-11-01'), null);
  assert.equal(usageModelWindow('custom', '2026-11-02', '2026-11-01'), null);
  assert.deepEqual(usageModelWindow('custom', '2028-02-29', '2028-02-29'), { sinceDay: '2028-02-29', untilDay: '2028-02-29' });
  assert.deepEqual(usageModelWindow('30', '', ''), { days: 30 });
  assert.deepEqual(usageModelWindow('all', '', ''), { all: true });
});

test('today uses the refreshed local calendar day and calendar arithmetic crosses month/year boundaries', () => {
  const before = new Date(2026, 11, 31, 23, 59).getTime();
  const after = new Date(2027, 0, 1, 0, 1).getTime();
  assert.deepEqual(usageModelWindow('today', '', '', before), { sinceDay: '2026-12-31', untilDay: '2026-12-31' });
  assert.deepEqual(usageModelWindow('today', '', '', after), { sinceDay: '2027-01-01', untilDay: '2027-01-01' });
  assert.equal(dayFromToday(-1, after), '2026-12-31');
});

test('heatmap starts on Monday, includes the end day, and does not invent future cells', () => {
  const dates = heatmapDates({ sinceDay: '2026-11-04', generatedAt: new Date(2026, 10, 6, 12).getTime() });
  assert.deepEqual(dates, ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
  assert.deepEqual(heatmapDates({ sinceDay: 'invalid', generatedAt: Date.now() }), []);
});

test('column-major heatmap keys move by day/week and clamp at visible range boundaries', () => {
  const dates = Array.from({ length: 15 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
  assert.equal(heatmapNavigation(dates, dates[7], 'ArrowUp'), dates[6]);
  assert.equal(heatmapNavigation(dates, dates[7], 'ArrowDown'), dates[8]);
  assert.equal(heatmapNavigation(dates, dates[7], 'ArrowLeft'), dates[0]);
  assert.equal(heatmapNavigation(dates, dates[7], 'ArrowRight'), dates[14]);
  assert.equal(heatmapNavigation(dates, dates[0], 'ArrowUp'), dates[0]);
  assert.equal(heatmapNavigation(dates, dates[7], 'Home'), dates[0]);
  assert.equal(heatmapNavigation(dates, dates[7], 'End'), dates[14]);
  assert.equal(heatmapNavigation(dates, dates[7], 'Tab'), null);
});

test('same model ids from separate providers remain separate and invalid ratios stay finite', () => {
  assert.notEqual(modelKey('one', 'model'), modelKey('two', 'model'));
  assert.equal(shareOf(1, 0), 0);
  assert.equal(shareOf(-1, 10), 0);
  assert.equal(shareOf(Infinity, 10), 0);
  assert.equal(shareOf(10, 1), 1);
});

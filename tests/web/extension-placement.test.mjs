import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conversationExtensionPositions,
  panelContributionId,
  placementOptionsFor,
  configurablePanels,
  placementFor,
} from '../../web/src/features/extensions/extension-placement.ts';
import { normalizePreferences } from '../../web/src/shared/preferences.ts';
import { statusAppearance, statusIconDataUrl } from '../../web/src/shared/extension-appearance.ts';

function extension(panels, { id = 'pi-metrics', scope = 'user' } = {}) {
  return {
    id,
    scope,
    name: '用量与额度',
    version: '0.5.5',
    manifest: { id, contributes: { panels } },
  };
}

test('placement preferences accept only the current display positions', () => {
  const normalized = normalizePreferences({
    extensionPlacements: {
      'user:pi-metrics/metrics-chip': 'below',
      'user:tools/summary': 'above',
      'user:quota/summary': 'header',
      'user:other/chip': 'both',
      'user:third/chip': 'nonsense',
      '': 'header',
    },
  });
  assert.deepEqual(normalized.extensionPlacements, {
    'user:pi-metrics/metrics-chip': 'below',
    'user:tools/summary': 'above',
  });
  assert.deepEqual(normalizePreferences({}).extensionPlacements, {});
  assert.deepEqual(normalizePreferences({ extensionPlacements: [] }).extensionPlacements, {});
});

test('contribution id matches the main process format', () => {
  assert.equal(panelContributionId('user', 'pi-metrics', 'metrics-chip'), 'user:pi-metrics/metrics-chip');
  assert.equal(panelContributionId('project', 'acme', 'chip'), 'project:acme/chip');
});

test('tool views get appearance controls, while summaries also expose positions', () => {
  const slots = ['status.chip', 'composer.above', 'composer.below'];
  const item = extension([
    { id: 'metrics-chip', title: '实时指标', icon: 'activity', color: 'info', slots },
    { id: 'detail', title: '详情', slot: 'tool.view', icon: 'cloud' },
  ]);
  assert.deepEqual(configurablePanels(item), [
    { id: 'user:pi-metrics/metrics-chip', title: '实时指标', slot: undefined, icon: 'activity', color: 'info', slots },
    { id: 'user:pi-metrics/detail', title: '详情', slot: 'tool.view', icon: 'cloud', color: undefined, slots: [] },
  ]);
});

test('settings use the plugin image for tool views until the user chooses a glyph', () => {
  const iconDataUrl = 'data:image/png;base64,example';
  const item = extension([
    { id: 'board', title: '画布', slot: 'tool.view' },
    { id: 'summary', title: '摘要', slot: 'status.chip', icon: 'activity' },
  ], { id: 'studio.excalidraw' });
  const [board, summary] = configurablePanels({ ...item, iconDataUrl });
  assert.equal(statusIconDataUrl(board), iconDataUrl);
  assert.equal(statusIconDataUrl(board, { color: 'accent' }), iconDataUrl);
  assert.equal(statusIconDataUrl(board, { icon: 'cloud' }), undefined);
  assert.equal(statusIconDataUrl(summary), undefined);
  assert.equal(statusIconDataUrl({ ...board, iconDataUrl: 'https://example.test/logo.png' }), undefined);
});

test('each status field inherits the panel default until overridden for that exact contribution', () => {
  const panel = { id: 'user:pi-metrics/quota', icon: 'gauge', color: 'info' };
  const { extensionAppearances } = normalizePreferences({ extensionAppearances: {
    [panel.id]: { color: 'warning', icon: '../icon.svg' },
    'project:pi-metrics/quota': { icon: 'wallet', color: '#fff' },
    'user:pi-metrics': { color: 'accent' },
    'user:pi-metrics/unused': { icon: 'constructor', color: 'inherit' },
  } });
  assert.deepEqual(extensionAppearances, {
    [panel.id]: { color: 'warning' },
    'project:pi-metrics/quota': { icon: 'wallet' },
  });
  assert.deepEqual(statusAppearance(panel, extensionAppearances[panel.id]), { icon: 'gauge', color: 'warning' });
  assert.deepEqual(statusAppearance(panel, extensionAppearances['project:pi-metrics/quota']), { icon: 'wallet', color: 'info' });
  assert.deepEqual(statusAppearance(panel), { icon: 'gauge', color: 'info' });
  assert.deepEqual(statusAppearance({ id: 'a', icon: 'pulse' }), { icon: 'activity', color: 'neutral' });
  assert.deepEqual(statusAppearance({ id: 'b', icon: 'future-glyph' }), { icon: 'activity', color: 'neutral' });
  assert.deepEqual(statusAppearance({ id: 'c', slot: 'tool.view' }), { icon: 'plug', color: 'neutral' });
});

test('the author controls which display positions a user can choose', () => {
  const values = slots => placementOptionsFor(slots).map(option => option.value);
  assert.deepEqual(values(['status.chip', 'composer.above', 'composer.below']), ['above', 'below', 'statusbar', 'hidden']);
  assert.deepEqual(values(['status.chip']), ['statusbar', 'hidden']);
  assert.deepEqual(values(['composer.below']), ['below', 'hidden']);
});

test('removed positions fall back to a declared summary location', () => {
  assert.equal(placementFor({ x: 'header' }, 'x', ['status.chip']), 'statusbar');
  assert.equal(placementFor({ x: 'menu' }, 'x', ['composer.above']), 'above');
  assert.equal(placementFor({ x: 'hidden' }, 'x', ['status.chip']), 'hidden');
});

test('summary layout keeps the chosen location and hides inactive or session-only readings', () => {
  const quota = { id:'user:pi-quota-status/chip', extensionId:'user:pi-quota-status', slot:'status.chip' };
  const metrics = { id:'builtin:studio-metrics/chip', extensionId:'builtin:studio-metrics', slot:'status.chip',
    slots:['status.chip', 'composer.below'], visibility:'while-active' };
  const view = {id:'project:app/tool', extensionId:'project:app', slot:'tool.view'};
  const layout = (session, active, placements = {}) => conversationExtensionPositions([quota, metrics, view], placements, session, active);
  assert.deepEqual(layout(undefined, true).statusBarItems, [quota]);
  assert.deepEqual(layout('chat', false).statusBarItems, [quota]);
  assert.deepEqual(layout('chat', true).statusBarItems, [quota, metrics]);
  assert.deepEqual(layout('chat', true, { [quota.id]:'hidden', [metrics.id]:'below' }).belowItems, [metrics]);
});

test('the keep-awake control is available before a conversation and across app sections', () => {
  const chip = { id: 'builtin:studio-keep-awake/chip', extensionId: 'builtin:studio-keep-awake', slot: 'status.chip' };
  const metrics = { id: 'builtin:studio-metrics/chip', extensionId: 'builtin:studio-metrics', slot: 'status.chip' };
  const layout = (placements, session) => conversationExtensionPositions([metrics, chip], placements, session, false);
  assert.deepEqual(layout({}).statusBarItems, [chip]);
  assert.deepEqual(layout({}, 'chat').globalStatusBarItems, [chip]);
  assert.deepEqual(layout({ [chip.id]: 'hidden' }).globalStatusBarItems, []);
});

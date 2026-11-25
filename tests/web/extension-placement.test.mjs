import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
    'user:quota/summary': 'header',
  });
  assert.deepEqual(normalizePreferences({}).extensionPlacements, {});
  assert.deepEqual(normalizePreferences({ extensionPlacements: [] }).extensionPlacements, {});
});

test('contribution id matches the main process format', () => {
  assert.equal(panelContributionId('user', 'pi-metrics', 'metrics-chip'), 'user:pi-metrics/metrics-chip');
  assert.equal(panelContributionId('project', 'acme', 'chip'), 'project:acme/chip');
});

test('workbench panels get appearance controls, while summaries also expose positions', () => {
  const slots = ['status.chip', 'composer.above', 'composer.below'];
  const item = extension([
    { id: 'metrics-chip', title: '实时指标', icon: 'activity', color: 'info', slots },
    { id: 'detail', title: '详情', slot: 'panel.side', icon: 'cloud' },
  ]);
  assert.deepEqual(configurablePanels(item), [
    { id: 'user:pi-metrics/metrics-chip', title: '实时指标', slot: undefined, icon: 'activity', color: 'info', slots },
    { id: 'user:pi-metrics/detail', title: '详情', slot: 'panel.side', icon: 'cloud', color: undefined, slots: [] },
  ]);
});

test('settings use the plugin image for workbench panels until the user chooses a glyph', () => {
  const iconDataUrl = 'data:image/png;base64,example';
  const item = extension([
    { id: 'board', title: '画布', slot: 'panel.side' },
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
  assert.deepEqual(statusAppearance({ id: 'c', slot: 'panel.side' }), { icon: 'plug', color: 'neutral' });
});

test('the author controls which display positions a user can choose', () => {
  const values = slots => placementOptionsFor(slots).map(option => option.value);
  assert.deepEqual(values(['status.chip', 'composer.above', 'composer.below']), ['header', 'above', 'below', 'menu', 'hidden']);
  assert.deepEqual(values(['status.chip']), ['header', 'menu', 'hidden']);
  assert.deepEqual(values(['composer.below']), ['below', 'hidden']);
});

test('quota belongs in the extension menu and other status summaries default there', () => {
  const positions = ['status.chip', 'composer.above', 'composer.below'];
  assert.deepEqual(placementOptionsFor(['status.chip'], 'user:pi-quota-status').map(option => option.value), ['menu', 'hidden']);
  assert.equal(placementFor(undefined, 'x', ['status.chip'], 'user:pi-quota-status'), 'menu');
  assert.equal(placementFor({ x: 'header' }, 'x', ['status.chip'], 'user:pi-quota-status'), 'menu');
  assert.equal(placementFor({ x: 'hidden' }, 'x', ['status.chip'], 'user:pi-quota-status'), 'hidden');
  assert.equal(placementFor(undefined, 'x', positions, 'user:example'), 'menu');
  assert.equal(placementFor(undefined, 'x', ['composer.above'], 'user:example'), 'above');
  for (const selection of ['header', 'above', 'below', 'menu', 'hidden']) {
    assert.equal(placementFor({ x: selection }, 'x', positions, 'user:example'), selection);
  }
  assert.equal(placementFor({ x: 'above' }, 'x', ['composer.below'], 'user:example'), 'below');
});

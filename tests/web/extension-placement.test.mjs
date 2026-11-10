import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXTENSION_PLACEMENT_OPTIONS,
  panelContributionId,
  placeablePanels,
  placementAllowsSlot,
  placementFor,
} from '../../web/src/features/extensions/extension-placement.ts';
import { normalizePreferences } from '../../web/src/shared/preferences.ts';

function extension(panels, { id = 'pi-metrics', scope = 'user' } = {}) {
  return {
    id,
    scope,
    name: '用量与额度',
    version: '0.5.5',
    manifest: { id, contributes: { panels } },
  };
}

test('placement preference only stores non-default values', () => {
  const normalized = normalizePreferences({
    extensionPlacements: {
      'user:pi-metrics/metrics-chip': 'footer',
      'user:other/chip': 'both',
      'user:third/chip': 'nonsense',
      '': 'chip',
    },
  });
  assert.deepEqual(normalized.extensionPlacements, { 'user:pi-metrics/metrics-chip': 'footer' });
  assert.deepEqual(normalizePreferences({}).extensionPlacements, {});
  assert.deepEqual(normalizePreferences({ extensionPlacements: [] }).extensionPlacements, {});
});

test('contribution id matches the main process format', () => {
  assert.equal(panelContributionId('user', 'pi-metrics', 'metrics-chip'), 'user:pi-metrics/metrics-chip');
  assert.equal(panelContributionId('project', 'acme/panel', 'chip'), 'project:acme/panel/chip');
});

test('only panels with two configurable slots become a placement choice', () => {
  const both = extension([
    { id: 'metrics-chip', slot: 'status.chip', slots: ['status.chip', 'conversation.footer'] },
  ]);
  assert.deepEqual(placeablePanels(both), [
    { id: 'user:pi-metrics/metrics-chip', slots: ['status.chip', 'conversation.footer'] },
  ]);

  const single = extension([
    { id: 'quota-chip', slot: 'status.chip', slots: ['status.chip'] },
    { id: 'settings-panel', slot: 'settings.panel' },
  ]);
  assert.deepEqual(placeablePanels(single), []);

  const legacy = extension([{ id: 'legacy', slot: 'conversation.footer' }]);
  assert.deepEqual(placeablePanels(legacy), []);
});

test('placement defaults to both and falls back for unknown values', () => {
  assert.equal(placementFor(undefined, 'x'), 'both');
  assert.equal(placementFor({}, 'x'), 'both');
  assert.equal(placementFor({ x: 'hidden' }, 'x'), 'hidden');
  assert.equal(placementFor({ x: 'other' }, 'x'), 'both');
});

test('each placement decides which slots render', () => {
  assert.equal(placementAllowsSlot('both', 'status.chip'), true);
  assert.equal(placementAllowsSlot('both', 'conversation.footer'), true);
  assert.equal(placementAllowsSlot('chip', 'status.chip'), true);
  assert.equal(placementAllowsSlot('chip', 'conversation.footer'), false);
  assert.equal(placementAllowsSlot('footer', 'status.chip'), false);
  assert.equal(placementAllowsSlot('footer', 'conversation.footer'), true);
  assert.equal(placementAllowsSlot('hidden', 'status.chip'), false);
  assert.equal(placementAllowsSlot('hidden', 'conversation.footer'), false);
});

test('the selector offers the four documented choices in order', () => {
  assert.deepEqual(EXTENSION_PLACEMENT_OPTIONS.map((option) => option.label), ['两处', '只在顶栏', '只在输入框下', '隐藏']);
});

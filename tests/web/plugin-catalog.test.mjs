import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesPluginQuery, pluginCatalogEntries } from '../../web/src/features/plugins/plugin-catalog.ts';

const installed = { id: 'studio.canvas', name: 'Canvas Local', version: '1', enabled: false, provides: { skills: [{ name: 'draw-map', path: 'skills/maps' }] } };
const localOnly = { id: 'studio.local', name: 'Local tools', provides: { cli: [{ name: 'Translate', id: 'translate' }] } };
const official = { id: installed.id, name: 'Canvas', sourceId: 'official', latestVersion: '2', provides: { mcpNames: ['render-board'] } };
const mirror = { ...official, name: 'Canvas Preview', latestVersion: '3', sourceId: 'preview' };

test('the directory keeps one card per plugin ID and uses live installation state', () => {
  const cards = pluginCatalogEntries([official, mirror], [installed, localOnly], true);
  assert.deepEqual(cards, [{ item: official, installed }, { item: localOnly, installed: localOnly }]);
  assert.equal(pluginCatalogEntries([{ ...official, installed: true }], [], true)[0].installed, undefined);
  assert.equal(pluginCatalogEntries([], [localOnly], true)[0].item, localOnly);
});

test('a source filter keeps its own package version and excludes unrelated local packages', () => {
  assert.deepEqual(pluginCatalogEntries([mirror], [installed, localOnly], false), [{ item: mirror, installed }]);
  assert.deepEqual(pluginCatalogEntries([], [localOnly], false), []);
});

test('a unified card is searchable by both its catalog metadata and its installed resources', () => {
  const entry = { item: official, installed };
  for (const query of ['canvas local', 'render-board', 'draw-map', 'skills/maps']) assert.ok(matchesPluginQuery(entry, query), query);
  assert.equal(matchesPluginQuery(entry, 'unrelated'), false);
  assert.ok(matchesPluginQuery({ item: localOnly, installed: localOnly }, 'translate'));
});

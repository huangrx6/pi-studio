import assert from 'node:assert/strict';
import test from 'node:test';
import { modelCatalogPage, discoverySelection } from '../../web/src/features/models/model-settings-catalog.mjs';
const catalog = Array.from({ length: 347 }, (_, index) => ({ id: `source/model-${index}`, model: `model-${index}`, name: `Model ${index}` }));

test('catalog pages expose all 300+ models with an explicit remaining count', () => {
  assert.equal(modelCatalogPage(catalog, '').items.length, 100);
  assert.equal(modelCatalogPage(catalog, '').remaining, 247);
  assert.equal(modelCatalogPage(catalog, '', 300).remaining, 47);
  const full = modelCatalogPage(catalog, '', 400);
  assert.equal(full.items.length, 347);
  assert.equal(full.remaining, 0);
  assert.equal(full.items.at(-1).id, 'source/model-346');
});

test('search reaches the final model before pagination and handles whitespace/case', () => {
  const found = modelCatalogPage(catalog, '  MODEL-346  ');
  assert.equal(found.total, 1);
  assert.equal(found.items[0].id, 'source/model-346');
  assert.equal(modelCatalogPage(catalog, 'missing').total, 0);
  assert.equal(catalog.length, 347);
});

test('discovery import only contains explicitly selected not-yet-added models', () => {
  const discovered = [{ id: 'existing' }, { id: 'new-a' }, { id: 'new-b' }];
  const selection = discoverySelection(discovered, [{ model: 'existing' }], ['existing', 'new-b', 'stale']);
  assert.deepEqual(selection.selectedMissing, [{ id: 'new-b' }]);
  assert.equal(selection.allMissingSelected, false);
  assert.deepEqual(selection.missing.map((item) => item.id), ['new-a', 'new-b']);
  assert.equal(discoverySelection(discovered, [{ model: 'existing' }], ['new-a', 'new-b']).allMissingSelected, true);
  assert.equal(discoverySelection([{ id: 'existing' }], [{ model: 'existing' }], []).allMissingSelected, false);
});

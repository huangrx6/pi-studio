import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeAppearanceChange, nativeAppearanceKey } from '../../web/src/shared/appearance-sync.ts';

const base = { theme: 'light', palette: 'lime', radiusStyle: 'standard' };

test('native appearance changes only for theme, palette and radius', () => {
  const initial = nativeAppearanceChange('', base);
  assert.equal(initial.changed, true);

  for (const preferences of [
    { ...base, backgroundOpacity: 10 },
    { ...base, backgroundBlur: 40 },
    { ...base, fontSize: 16 },
    { ...base, stepDisplay: 'detailed' },
  ]) {
    const next = nativeAppearanceChange(initial.key, preferences);
    assert.equal(next.changed, false);
    assert.equal(next.key, initial.key);
  }

  assert.equal(nativeAppearanceChange(initial.key, { ...base, theme: 'dark' }).changed, true);
  assert.equal(nativeAppearanceChange(initial.key, { ...base, palette: 'ocean' }).changed, true);
  assert.equal(nativeAppearanceChange(initial.key, { ...base, radiusStyle: 'soft' }).changed, true);
});

test('native appearance key is stable for an unchanged preference object', () => {
  assert.equal(nativeAppearanceKey(base), nativeAppearanceKey({ ...base }));
});

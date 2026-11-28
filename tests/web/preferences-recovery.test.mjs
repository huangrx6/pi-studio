import assert from 'node:assert/strict';
import test from 'node:test';

const {
  DEFAULT_PREFERENCES,
  loadPreferences,
  normalizePreferences,
  savePreferences,
} = await import('../../web/src/shared/preferences.ts');
const {
  loadStoredSessionOrder,
  loadStoredWorkspaceOrder,
  normalizeStoredSessionOrder,
} = await import('../../web/src/shared/stored-ui-state.ts');
const { DEFAULT_SHORTCUTS } = await import('../../web/src/shared/shortcuts.ts');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      writes.push([key, value]);
      values.set(key, value);
    },
  };
}

test('preferences validate every field and repair malformed storage once', () => {
  const storage = memoryStorage({
    'pi-studio:preferences': JSON.stringify({
      theme: 'sepia',
      palette: 'violet',
      fontSize: '17',
      stepDisplay: 'full',
      stepCollapse: 'never',
      showCodeView: 'false',
      gitDiffLayout: 'inline',
      gitDiffWrap: 'off',
      linkOpen: 'embedded',
      radiusStyle: 'pill',
      backgroundMedia: [],
      backgroundOpacity: null,
      backgroundBlur: 500,
      backgroundSurfaceOpacity: false,
      backgroundInsideVisibility: 'lots',
      shortcuts: { toggleSidebar: 'not-a-shortcut' },
      unknown: 'drop',
    }),
  });

  const preferences = loadPreferences(storage);
  assert.deepEqual(preferences, {
    ...DEFAULT_PREFERENCES,
    backgroundBlur: 100,
  });
  assert.deepEqual(preferences.shortcuts, DEFAULT_SHORTCUTS);
  assert.equal(Object.hasOwn(preferences, 'unknown'), false);
  assert.equal(storage.writes.length, 1);

  const repaired = storage.values.get('pi-studio:preferences');
  loadPreferences(storage);
  assert.equal(storage.writes.length, 1);
  assert.equal(storage.values.get('pi-studio:preferences'), repaired);
});

test('preferences recover invalid JSON and unavailable storage without throwing', () => {
  const malformed = memoryStorage({ 'pi-studio:preferences': '{bad-json' });
  assert.deepEqual(loadPreferences(malformed), DEFAULT_PREFERENCES);
  assert.equal(malformed.writes.length, 1);

  const readFailure = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.deepEqual(loadPreferences(readFailure), DEFAULT_PREFERENCES);

  const writeFailure = memoryStorage({ 'pi-studio:preferences': '{bad-json' });
  writeFailure.setItem = () => { throw new Error('quota'); };
  assert.deepEqual(loadPreferences(writeFailure), DEFAULT_PREFERENCES);
  assert.equal(writeFailure.values.get('pi-studio:preferences'), '{bad-json');
});

test('previous accent selections survive reload and the retired teal moves to ocean blue', () => {
  const key = 'pi-studio:preferences';
  for (const [saved, expected] of [['lime', 'ocean'], ['ocean', 'ocean'], ['amber', 'amber'], ['berry', 'berry']]) {
    const previous = { ...normalizePreferences({ theme: 'dark' }), palette: saved };
    const storage = memoryStorage({ [key]: JSON.stringify(previous) });
    const preferences = loadPreferences(storage);
    assert.deepEqual(preferences, { ...previous, palette: expected });
    assert.deepEqual(JSON.parse(storage.getItem(key)), preferences);
    assert.deepEqual(loadPreferences(storage), preferences);
    assert.equal(storage.writes.length, saved === 'lime' ? 1 : 0);
  }
});

test('saving preferences writes the same canonical object loaded next time', () => {
  const storage = memoryStorage();
  savePreferences({
    ...DEFAULT_PREFERENCES,
    theme: 'dark',
    gitDiffLayout: 'unified',
    gitDiffWrap: true,
    fontSize: 99,
    shortcuts: { ...DEFAULT_SHORTCUTS, togglePanel: 'alt+mod+j' },
  }, storage);

  const saved = JSON.parse(storage.values.get('pi-studio:preferences'));
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.gitDiffLayout, 'unified');
  assert.equal(saved.gitDiffWrap, true);
  assert.equal(saved.fontSize, 20);
  assert.equal(saved.shortcuts.togglePanel, 'Mod+Alt+J');
  assert.deepEqual(loadPreferences(storage), saved);
  assert.equal(storage.writes.length, 1);
});

test('legacy default chat size follows the global body size and explicit sizes survive reload', () => {
  const key = 'pi-studio:preferences';
  for (const [legacy, expected] of [[15, null], [12, 12], [13, 13], [16, 16], [20, 20]]) {
    const storage = memoryStorage({ [key]: JSON.stringify({ fontSize: legacy, terminalFontSize: 17 }) });
    const preferences = loadPreferences(storage);
    assert.equal(preferences.fontSize, expected);
    assert.equal(preferences.terminalFontSize, 17);
    assert.deepEqual(loadPreferences(storage), preferences);
    assert.equal(storage.writes.length, 1);
    savePreferences({ ...preferences, fontSize: 15 }, storage);
    assert.equal(loadPreferences(storage).fontSize, 15);
    savePreferences({ ...preferences, fontSize: 10 }, storage);
    assert.equal(loadPreferences(storage).fontSize, 10);
  }
});

test('stored UI collections reject wrong shapes, duplicates and unsafe keys', () => {
  assert.deepEqual(normalizeStoredSessionOrder({}), {});
  assert.deepEqual(normalizeStoredSessionOrder([]), {});
  assert.deepEqual(normalizeStoredSessionOrder(null), {});
  const normalized = normalizeStoredSessionOrder(Object.fromEntries([
    ['/workspace/a/', ['session-a', 'session-a', 42, 'constructor']],
    ['constructor', ['session-b']],
    ['relative', ['session-c']],
    ['/workspace/b', 'not-an-array'],
  ]));
  assert.deepEqual(normalized, {
    '/workspace/a/': ['session-a'],
  });
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
});

test('stored UI loaders repair bad values and leave canonical values untouched', () => {
  const storage = memoryStorage({
    'pi-studio:workspace-order': JSON.stringify([
      '/workspace/a',
      '/workspace/a',
      42,
      '/workspace/b',
    ]),
    'pi-studio:session-order': JSON.stringify({
      '/workspace/a': ['session-a', 'session-a', 'constructor'],
    }),
  });

  assert.deepEqual(loadStoredWorkspaceOrder(storage), ['/workspace/a', '/workspace/b']);
  assert.deepEqual(loadStoredSessionOrder(storage), {
    '/workspace/a': ['session-a'],
  });
  assert.equal(storage.writes.length, 2);

  const writeCount = storage.writes.length;
  loadStoredWorkspaceOrder(storage);
  loadStoredSessionOrder(storage);
  assert.equal(storage.writes.length, writeCount);
});

test('missing UI state returns defaults without creating storage entries', () => {
  const storage = memoryStorage();
  assert.deepEqual(loadStoredWorkspaceOrder(storage), []);
  assert.deepEqual(loadStoredSessionOrder(storage), {});
  assert.equal(storage.writes.length, 0);
  assert.equal(storage.values.size, 0);
});

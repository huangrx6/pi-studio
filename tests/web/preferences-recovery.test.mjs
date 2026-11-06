import assert from 'node:assert/strict';
import test from 'node:test';

const {
  DEFAULT_PREFERENCES,
  loadPreferences,
  normalizePreferences,
  savePreferences,
} = await import('../../web/src/shared/preferences.ts');
const {
  loadStoredActiveSession,
  loadStoredExpandedWorkspaces,
  loadStoredModelComparisons,
  loadStoredSessionOrder,
  loadStoredWorkspaceOrder,
  normalizeStoredModelComparisons,
  normalizeStoredSessionOrder,
} = await import('../../web/src/shared/stored-ui-state.ts');
const { DEFAULT_SHORTCUTS } = await import('../../web/src/shared/shortcuts.mjs');

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
      linkOpen: 'embedded',
      radiusStyle: 'pill',
      backgroundMedia: [],
      backgroundOpacity: null,
      backgroundBlur: 500,
      backgroundSurfaceOpacity: false,
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

test('saving preferences writes the same canonical object loaded next time', () => {
  const storage = memoryStorage();
  savePreferences({
    ...DEFAULT_PREFERENCES,
    theme: 'dark',
    fontSize: 99,
    shortcuts: { ...DEFAULT_SHORTCUTS, togglePanel: 'alt+mod+j' },
  }, storage);

  const saved = JSON.parse(storage.values.get('pi-studio:preferences'));
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.fontSize, 17);
  assert.equal(saved.shortcuts.togglePanel, 'Mod+Alt+J');
  assert.deepEqual(loadPreferences(storage), saved);
  assert.equal(storage.writes.length, 1);
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
    'pi-studio:expanded-workspaces': JSON.stringify({}),
    'pi-studio:workspace-order': JSON.stringify([
      '/workspace/a',
      '/workspace/a',
      42,
      '/workspace/b',
    ]),
    'pi-studio:session-order': JSON.stringify({
      '/workspace/a': ['session-a', 'session-a', 'constructor'],
    }),
    'pi-studio:active-session': JSON.stringify({
      id: 'session-a',
      cwd: '/workspace/a',
      extra: true,
    }),
    'pi-studio:model-comparisons': JSON.stringify({ broken: {} }),
  });

  assert.deepEqual(loadStoredExpandedWorkspaces(storage), []);
  assert.deepEqual(loadStoredWorkspaceOrder(storage), ['/workspace/a', '/workspace/b']);
  assert.deepEqual(loadStoredSessionOrder(storage), {
    '/workspace/a': ['session-a'],
  });
  assert.deepEqual(loadStoredActiveSession(storage), {
    id: 'session-a',
    cwd: '/workspace/a',
  });
  assert.deepEqual(loadStoredModelComparisons(storage), {});
  assert.equal(storage.writes.length, 5);

  const writeCount = storage.writes.length;
  loadStoredExpandedWorkspaces(storage);
  loadStoredWorkspaceOrder(storage);
  loadStoredSessionOrder(storage);
  loadStoredActiveSession(storage);
  loadStoredModelComparisons(storage);
  assert.equal(storage.writes.length, writeCount);
});

test('missing UI state returns defaults without creating storage entries', () => {
  const storage = memoryStorage();
  assert.deepEqual(loadStoredExpandedWorkspaces(storage), []);
  assert.deepEqual(loadStoredWorkspaceOrder(storage), []);
  assert.deepEqual(loadStoredSessionOrder(storage), {});
  assert.equal(loadStoredActiveSession(storage), null);
  assert.deepEqual(loadStoredModelComparisons(storage), {});
  assert.equal(storage.writes.length, 0);
  assert.equal(storage.values.size, 0);
});

test('model comparison validation drops incomplete or mismatched entries', () => {
  const valid = {
    result: {
      id: 'comparison-1',
      parentId: 'parent-1',
      prompt: 'Compare this',
      createdAt: Date.now(),
      branches: [
        {
          sessionId: 'session-a',
          label: 'A',
          modelRef: 'provider/a',
          thinkingLevel: 'medium',
          worktreeId: 'worktree-a',
        },
        {
          sessionId: 'session-b',
          label: 'B',
          modelRef: 'provider/b',
          thinkingLevel: 'high',
          worktreeId: 'worktree-b',
        },
      ],
    },
    cwd: '/workspace/a',
    initialModelRef: 'provider/a',
    initialThinkingLevel: 'medium',
  };
  const normalized = normalizeStoredModelComparisons(Object.fromEntries([
    ['parent-1', valid],
    ['wrong-parent', {
      ...valid,
      result: { ...valid.result, id: 'comparison-2' },
    }],
    ['parent-2', {
      ...valid,
      result: {
        ...valid.result,
        parentId: 'parent-2',
        branches: [valid.result.branches[0]],
      },
    }],
    ['__proto__', valid],
  ]));

  assert.deepEqual(Object.keys(normalized), ['parent-1']);
  assert.equal(normalized['parent-1'].result.parentId, 'parent-1');
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  assert.equal(Object.hasOwn(normalized, '__proto__'), false);
});

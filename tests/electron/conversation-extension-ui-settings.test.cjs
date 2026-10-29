const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-conversation-ui-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  deleteWorkspaceScopedSettings,
  getConversationExtensionUiPreferences,
  saveConversationExtensionUiPreferences,
} = require('../../electron/core/app-settings.cjs');
const { closeStudioDatabase } = require('../../electron/core/studio-db.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('conversation extension UI preferences persist global and session order', () => {
  assert.deepEqual(getConversationExtensionUiPreferences(), {
    version: 1,
    layout: 'grid',
    globalOrder: [],
    sessionOrders: {},
  });

  const saved = saveConversationExtensionUiPreferences({
    layout: 'list',
    globalOrder: [
      'user:alpha',
      'project:beta',
      'user:alpha',
      'invalid',
    ],
    sessionId: 'session-a',
    sessionOrder: ['project:beta', 'user:alpha'],
  });
  assert.deepEqual(saved, {
    version: 1,
    layout: 'list',
    globalOrder: ['user:alpha', 'project:beta'],
    sessionOrders: {
      'session-a': ['project:beta', 'user:alpha'],
    },
  });

  const cleared = saveConversationExtensionUiPreferences({
    sessionId: 'session-a',
    sessionOrder: null,
  });
  assert.deepEqual(cleared.sessionOrders, {});
  assert.deepEqual(cleared.globalOrder, ['user:alpha', 'project:beta']);
});

test('removing a workspace clears only its conversation overrides', () => {
  saveConversationExtensionUiPreferences({
    sessionId: 'session-a',
    sessionOrder: ['user:alpha', 'project:beta'],
  });
  saveConversationExtensionUiPreferences({
    sessionId: 'session-b',
    sessionOrder: ['project:beta', 'user:alpha'],
  });
  saveConversationExtensionUiPreferences({
    sessionId: 'session-other',
    sessionOrder: ['user:alpha', 'project:beta'],
  });

  deleteWorkspaceScopedSettings(temporary, ['session-a', 'session-b']);
  assert.deepEqual(
    getConversationExtensionUiPreferences().sessionOrders,
    { 'session-other': ['user:alpha', 'project:beta'] },
  );
});

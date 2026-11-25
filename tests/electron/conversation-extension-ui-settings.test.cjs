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
} = require('../../electron/main/core/app-settings.cjs');
const { closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('conversation extension UI preferences persist a validated global order', () => {
  assert.deepEqual(getConversationExtensionUiPreferences(), {
    version: 1,
    globalOrder: [],
  });

  const saved = saveConversationExtensionUiPreferences({
    globalOrder: [
      'user:alpha',
      'project:beta',
      'user:alpha',
      'invalid',
    ],
  });
  assert.deepEqual(saved, {
    version: 1,
    globalOrder: ['user:alpha', 'project:beta'],
  });

  assert.deepEqual(getConversationExtensionUiPreferences(), saved);
  assert.deepEqual(saveConversationExtensionUiPreferences({ globalOrder: 'invalid' }), saved);
});

test('removing a workspace retains the global display preference', () => {
  const saved = saveConversationExtensionUiPreferences({ globalOrder: ['project:beta', 'user:alpha'] });
  deleteWorkspaceScopedSettings(temporary, ['session-a', 'session-b']);
  assert.deepEqual(getConversationExtensionUiPreferences(), saved);
});

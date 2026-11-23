const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-tools-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase, getStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const {
  DEFAULT_AGENT_TOOLS,
  readAgentToolSelection,
} = require('../../electron/main/runtime/tool-selection.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('defaults include browser act tools', () => {
  assert.ok(DEFAULT_AGENT_TOOLS.includes('browser_tabs'));
  assert.ok(DEFAULT_AGENT_TOOLS.includes('browser_click'));
  assert.ok(DEFAULT_AGENT_TOOLS.includes('browser_type'));
  assert.ok(DEFAULT_AGENT_TOOLS.includes('browser_wait'));
  assert.ok(DEFAULT_AGENT_TOOLS.includes('browser_highlight'));
  assert.ok(!DEFAULT_AGENT_TOOLS.includes('browser_evaluate'));
});

test('version 3 selections migrate through browser act tools', () => {
  const db = getStudioDatabase();
  db.setSetting('studio.agent.tools', {
    enabled: ['read', 'write', 'todo', 'mcp__*'],
    sources: {},
  });
  db.setSetting('studio.agent.tools.version', 3);
  const next = readAgentToolSelection(db);
  for (const name of [
    'browser_tabs', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_screenshot',
    'browser_click', 'browser_type', 'browser_scroll', 'browser_wait', 'browser_select',
    'browser_dialog', 'browser_download', 'browser_highlight',
  ]) {
    assert.ok(next.enabled.includes(name), `missing ${name}`);
  }
  assert.ok(!next.enabled.includes('browser_evaluate'), 'evaluate must not auto-enable');
  assert.equal(db.getSetting('studio.agent.tools.version'), 6);
});

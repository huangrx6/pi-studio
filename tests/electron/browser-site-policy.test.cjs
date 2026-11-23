const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-site-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const {
  resolveSiteAction,
  upsertSitePolicy,
  removeSitePolicy,
  readSitePolicies,
} = require('../../electron/main/services/browser/site-policy.cjs');
const {
  enqueueBrowserAction,
  setBrowserControlPaused,
  getBrowserControlState,
} = require('../../electron/main/services/browser/queue.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('localhost defaults allow act and read', () => {
  assert.equal(resolveSiteAction('http://localhost:5173/app', 'act').decision, 'allow');
  assert.equal(resolveSiteAction('http://127.0.0.1:3000', 'read').source, 'localhost');
  assert.equal(resolveSiteAction('https://example.com', 'act').decision, 'ask');
  assert.equal(resolveSiteAction('https://example.com', 'evaluate').decision, 'deny');
});

test('explicit site policies override defaults', () => {
  upsertSitePolicy({ originPattern: 'example.com', actionClass: 'act', decision: 'allow' });
  assert.equal(resolveSiteAction('https://example.com/x', 'act').decision, 'allow');
  assert.equal(resolveSiteAction('https://example.com/x', 'act').source, 'policy');
  removeSitePolicy('example.com', 'act');
  assert.equal(readSitePolicies().some((row) => row.originPattern === 'example.com' && row.actionClass === 'act'), false);
});

test('control pause blocks queued actions', async () => {
  setBrowserControlPaused(false);
  assert.equal(getBrowserControlState().paused, false);
  setBrowserControlPaused(true);
  await assert.rejects(
    () => enqueueBrowserAction('tab-1', async () => 'ok'),
    (error) => error && error.code === 'paused_by_user',
  );
  setBrowserControlPaused(false);
  const value = await enqueueBrowserAction('tab-1', async () => 'ok');
  assert.equal(value, 'ok');
});

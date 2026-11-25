const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-browser-settings-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const { closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const {
  assertBrowserAgentControlEnabled,
  assertBrowserCdpAllowed,
  assertBrowserEvaluateAllowed,
  assertBrowserExternalChromeAllowed,
  assertBrowserHistoryAccess,
  getBrowserPreferences,
  isBrowserCdpEnabled,
  isBrowserEvaluateEnabled,
  isBrowserExternalChromeEnabled,
  resolveLinkOpenTarget,
  setBrowserEvaluateEnabled,
  setBrowserPreferences,
  subscribeBrowserPreferences,
} = require('../../electron/main/services/browser/settings.cjs');
const {
  listBrowserContacts,
  listBrowserPasswords,
  removeBrowserContact,
  removeBrowserPassword,
  revealBrowserPassword,
  upsertBrowserContact,
  upsertBrowserPassword,
} = require('../../electron/main/services/browser/vault.cjs');
const { listBrowserExtensions } = require('../../electron/main/services/browser/extensions.cjs');
const { upsertSitePolicy, removeSitePolicy } = require('../../electron/main/services/browser/site-policy.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('evaluate stays disabled by default', () => {
  assert.equal(isBrowserEvaluateEnabled(), false);
  assert.throws(
    () => assertBrowserEvaluateAllowed('http://localhost:5173'),
    (error) => error && error.code === 'evaluate_disabled',
  );
});

test('evaluate requires setting and explicit site allow', () => {
  setBrowserEvaluateEnabled(true);
  assert.equal(isBrowserEvaluateEnabled(), true);
  assert.throws(
    () => assertBrowserEvaluateAllowed('https://example.com'),
    (error) => error && (error.code === 'site_policy_ask' || /尚未允许 evaluate/.test(String(error.message))),
  );
  upsertSitePolicy({ originPattern: 'example.com', actionClass: 'evaluate', decision: 'allow' });
  assert.doesNotThrow(() => assertBrowserEvaluateAllowed('https://example.com/app'));
  removeSitePolicy('example.com', 'evaluate');
  setBrowserEvaluateEnabled(false);
  assert.equal(isBrowserEvaluateEnabled(), false);
});

test('preferences bag defaults keep L4 off and agent control on', () => {
  const preferences = getBrowserPreferences();
  assert.equal(preferences.agentControlEnabled, true);
  assert.equal(preferences.cdpEnabled, false);
  assert.equal(preferences.externalChromeEnabled, false);
  assert.equal(preferences.historyAccess, 'ask');
  assert.equal(preferences.showFullUrl, false);
  assert.equal(preferences.linkOpenInstructAgent, true);
  assert.equal(preferences.linkOpenBlockExternal, true);
  assert.equal(isBrowserCdpEnabled(), false);
  assert.equal(isBrowserExternalChromeEnabled(), false);
  assert.doesNotThrow(() => assertBrowserAgentControlEnabled());
});

test('cdp and external chrome stay gated until enabled', () => {
  assert.throws(
    () => assertBrowserCdpAllowed('https://example.com'),
    (error) => error && error.code === 'cdp_disabled',
  );
  assert.throws(
    () => assertBrowserExternalChromeAllowed(),
    (error) => error && error.code === 'external_chrome_disabled',
  );

  setBrowserPreferences({ cdpEnabled: true });
  assert.equal(isBrowserCdpEnabled(), true);
  assert.throws(
    () => assertBrowserCdpAllowed('https://example.com'),
    (error) => error && (error.code === 'site_policy_ask' || error.code === 'site_policy_deny'),
  );
  upsertSitePolicy({ originPattern: 'example.com', actionClass: 'cdp', decision: 'allow' });
  assert.doesNotThrow(() => assertBrowserCdpAllowed('https://example.com/x'));

  assert.throws(
    () => assertBrowserExternalChromeAllowed(),
    (error) => error && error.code === 'external_chrome_disabled',
  );
  setBrowserPreferences({ externalChromeEnabled: true });
  assert.doesNotThrow(() => assertBrowserExternalChromeAllowed());

  setBrowserPreferences({
    cdpEnabled: false,
    externalChromeEnabled: false,
  });
  removeSitePolicy('example.com', 'cdp');
});

test('history access and agent master switch', () => {
  setBrowserPreferences({ historyAccess: 'deny' });
  assert.throws(
    () => assertBrowserHistoryAccess(),
    (error) => error && error.code === 'history_denied',
  );
  setBrowserPreferences({ historyAccess: 'ask' });
  assert.throws(
    () => assertBrowserHistoryAccess(),
    (error) => error && error.code === 'history_ask',
  );
  setBrowserPreferences({ historyAccess: 'allow' });
  assert.equal(assertBrowserHistoryAccess(), 'allow');

  setBrowserPreferences({ agentControlEnabled: false });
  assert.throws(
    () => assertBrowserAgentControlEnabled(),
    (error) => error && error.code === 'browser_agent_disabled',
  );
  setBrowserPreferences({ agentControlEnabled: true, historyAccess: 'ask' });
});

test('legacy evaluate key stays in sync with preferences', () => {
  setBrowserPreferences({ evaluateEnabled: true });
  assert.equal(isBrowserEvaluateEnabled(), true);
  setBrowserEvaluateEnabled(false);
  assert.equal(getBrowserPreferences().evaluateEnabled, false);
});

test('link open target follows web vs local preferences', () => {
  setBrowserPreferences({ webLinkOpenTarget: 'system', localLinkOpenTarget: 'workbench' });
  assert.equal(resolveLinkOpenTarget('https://example.com/docs'), 'system');
  assert.equal(resolveLinkOpenTarget('http://localhost:5173'), 'workbench');
  assert.equal(resolveLinkOpenTarget('file:///tmp/index.html'), 'workbench');
  setBrowserPreferences({ webLinkOpenTarget: 'workbench', localLinkOpenTarget: 'system' });
  assert.equal(resolveLinkOpenTarget('https://example.com'), 'workbench');
  assert.equal(resolveLinkOpenTarget('http://127.0.0.1:3000/app'), 'system');
  setBrowserPreferences({ webLinkOpenTarget: 'workbench', localLinkOpenTarget: 'workbench' });
});

test('preference subscribers receive live updates', () => {
  let seen = null;
  const stop = subscribeBrowserPreferences((next) => { seen = next; });
  setBrowserPreferences({ showFullUrl: true, askDownloadPath: true });
  assert.equal(seen.showFullUrl, true);
  assert.equal(seen.askDownloadPath, true);
  setBrowserPreferences({ showFullUrl: false, askDownloadPath: false });
  stop();
});

test('password vault stores and reveals without listing secrets', async () => {
  const listed = await listBrowserPasswords();
  assert.equal(listed.ok, true);
  assert.ok(Array.isArray(listed.passwords));
  if (!listed.available) {
    // Unit tests run outside Electron; safeStorage is only available in the app.
    return;
  }
  const created = await upsertBrowserPassword({
    origin: 'https://vault.example',
    username: 'demo',
    password: 's3cret-value',
    note: 'test',
  });
  assert.equal(created.ok, true);
  assert.equal(created.password.username, 'demo');
  assert.equal('password' in created.password, false);
  const again = await listBrowserPasswords();
  const row = again.passwords.find((item) => item.origin.includes('vault.example'));
  assert.ok(row);
  assert.equal('password' in row, false);
  const revealed = await revealBrowserPassword(row.id);
  assert.equal(revealed.password.password, 's3cret-value');
  await removeBrowserPassword(row.id);
  const after = await listBrowserPasswords();
  assert.equal(after.passwords.some((item) => item.id === row.id), false);
});

test('contacts vault round-trip', () => {
  const created = upsertBrowserContact({
    name: 'Ada',
    phone: '123',
    email: 'ada@example.com',
    address: 'Lab',
  });
  assert.equal(created.ok, true);
  assert.equal(created.contact.name, 'Ada');
  const listed = listBrowserContacts();
  assert.ok(listed.contacts.some((row) => row.name === 'Ada'));
  removeBrowserContact(created.contact.id);
  assert.equal(listBrowserContacts().contacts.some((row) => row.id === created.contact.id), false);
});

test('extensions list reports support flag without throwing', () => {
  const listed = listBrowserExtensions();
  assert.equal(listed.ok, true);
  assert.ok(Array.isArray(listed.extensions));
  assert.equal(typeof listed.supported, 'boolean');
});

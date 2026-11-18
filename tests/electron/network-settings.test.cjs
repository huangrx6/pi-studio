const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-proxy-'));
process.env.PI_STUDIO_DB = path.join(directory, 'studio.sqlite');
const { getStudioDatabase, closeStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const {
  DEFAULT_NETWORK_SETTINGS, NETWORK_SETTINGS_KEY, normalizeNetworkSettings,
  normalizeProxyUrl, getNetworkSettings, saveNetworkSettings, proxyConfig,
} = require('../../electron/main/core/network-settings.cjs');

test.after(() => { closeStudioDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });

test('proxy settings default to the system and survive database reopening', () => {
  assert.deepEqual(getNetworkSettings(), DEFAULT_NETWORK_SETTINGS);
  const next = saveNetworkSettings({ mode: 'manual', proxyUrl: ' socks5://[::1]:7897/ ', bypassRules: '*.local; 192.168.0.0/16, *.local' });
  assert.deepEqual(next, { mode: 'manual', proxyUrl: 'socks5://[::1]:7897', bypassRules: '*.local, 192.168.0.0/16' });
  closeStudioDatabase();
  assert.deepEqual(getNetworkSettings(), next);
  assert.deepEqual(proxyConfig(next), { mode: 'fixed_servers', proxyRules: 'socks5://[::1]:7897', proxyBypassRules: 'localhost,127.0.0.1,[::1],*.local, 192.168.0.0/16' });
  assert.deepEqual(proxyConfig({ ...next, mode: 'direct' }), { mode: 'direct' });
  assert.deepEqual(proxyConfig({ ...next, mode: 'system' }), { mode: 'system' });
});

test('invalid and credential-bearing proxy URLs never overwrite persisted settings', () => {
  const previous = getNetworkSettings();
  for (const proxyUrl of ['http://user:secret@localhost:7897', 'ftp://localhost:1234', 'http://localhost:0', 'http://localhost:65536', 'http://localhost/path', 'http://localhost?token=secret', 'http://localhost/#fragment', '127.0.0.1:7897', 'http://localhost;evil:7897']) {
    assert.throws(() => saveNetworkSettings({ mode: 'manual', proxyUrl }));
    assert.deepEqual(getNetworkSettings(), previous);
  }
  assert.throws(() => normalizeNetworkSettings({ mode: 'manual', proxyUrl: '' }));
  assert.throws(() => normalizeNetworkSettings({ mode: 'other' }));
  assert.throws(() => normalizeNetworkSettings({ mode: 'manual', proxyUrl: 'http://localhost:7897', bypassRules: '<-loopback>' }));
  assert.throws(() => normalizeNetworkSettings({ mode: 'manual', proxyUrl: 'http://localhost:7897', bypassRules: 'host\nother' }));
  assert.equal(normalizeProxyUrl('https://localhost'), 'https://localhost:443');
  assert.equal(normalizeProxyUrl('socks5://localhost'), 'socks5://localhost:1080');
  assert.deepEqual(normalizeNetworkSettings({ mode: 'direct', proxyUrl: 'http://user:password@localhost', bypassRules: '<-loopback>' }), {
    mode: 'direct', proxyUrl: '', bypassRules: '',
  });
});

test('corrupt stored network settings recover to the system default', () => {
  getStudioDatabase().setSetting(NETWORK_SETTINGS_KEY, { mode: 'manual', proxyUrl: 'http://user:password@localhost:1234' });
  assert.deepEqual(getNetworkSettings(), DEFAULT_NETWORK_SETTINGS);
});

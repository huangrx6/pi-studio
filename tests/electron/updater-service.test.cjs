const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const updateState = require('../../electron/update-state.cjs');

// Load the actual service, replacing only Electron, updater transport and build
// identity IO. No network, real windows, notifications or app data are used.
function fixture() {
  const autoUpdater = new EventEmitter();
  const messages = [], notifications = [];
  let reveals = 0;
  autoUpdater.checkForUpdates = () => assert.fail('Synthetic development app must not contact a release service');
  autoUpdater.downloadUpdate = () => assert.fail('No actual download is allowed');
  autoUpdater.quitAndInstall = () => assert.fail('No actual installation is allowed');
  const app = new EventEmitter();
  app.isPackaged = false;
  app.getVersion = () => '1.2.3';
  const win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, isLoading: () => false, send: (channel, payload) => messages.push({ channel, payload }) },
  };
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { this.shown = true; }
    close() { this.emit('close'); }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../electron/services/updater.cjs'), 'utf8'), {
    module, exports: module.exports, console,
    process: { resourcesPath: '/synthetic/resources' },
    setTimeout: () => assert.fail('No startup timer in the synthetic development app'),
    setInterval: () => assert.fail('No background polling in this test'),
    clearTimeout() {}, clearInterval() {}, setImmediate: callback => callback(),
    require(id) {
      if (id === 'electron') return { app, Notification };
      if (id === 'electron-updater') return { autoUpdater };
      if (id === '../core/state.cjs') return { getWindow: () => win };
      if (id === '../window.cjs') return { showMainWindow: () => { reveals++; return win; } };
      if (id === '../update-state.cjs') return updateState;
      if (id === './update-identity.cjs') return {
        readInstalledBuildIdentity: () => ({ buildId: 'installed-build' }),
        attachBuildAwareUpdateCheck() {},
        isSameVersionBuildUpdate: info => info.version === '1.2.3' && info.buildId !== 'installed-build',
      };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  module.exports.initializeUpdater();
  return {
    service: module.exports, notifications,
    emit: info => autoUpdater.emit('update-downloaded', info),
    get reveals() { return reveals; },
    get opens() { return messages.filter(message => message.channel === 'pi:open-update').length; },
    get states() { return messages.filter(message => message.channel === 'pi:update-state').map(message => message.payload); },
  };
}

test('duplicate downloaded targets broadcast state but reveal and notify automatically only once', () => {
  const h = fixture();
  h.emit({ version: '1.3.0', buildId: 'build-a' });
  h.emit({ version: '1.3.0', buildId: 'build-a' });
  assert.equal(h.states.length, 2);
  assert.equal(h.states.at(-1).state, 'downloaded');
  assert.equal(h.reveals, 1); assert.equal(h.opens, 1);
  assert.equal(h.notifications.length, 1); assert.equal(h.notifications[0].shown, true);
});

test('a different build of the same version and a different version each announce completion', () => {
  const h = fixture();
  h.emit({ version: '1.2.3', buildId: 'build-a' });
  h.emit({ version: '1.2.3', buildId: 'build-b' });
  h.emit({ version: '1.3.0', buildId: 'build-b' });
  h.emit({ version: '1.2.3', buildId: 'build-a' });
  assert.equal(h.opens, 3); assert.equal(h.reveals, 3); assert.equal(h.notifications.length, 3);
});

test('explicit UI, menu and notification click requests still reveal after automatic deduplication', () => {
  const h = fixture(); h.emit({ version: '1.3.0', buildId: 'build-a' });
  h.service.notifyUpdateUi(); h.service.notifyUpdateUi();
  h.service.openAndCheckForUpdates(); h.service.openAndCheckForUpdates();
  h.notifications[0].emit('click');
  assert.equal(h.reveals, 6); assert.equal(h.opens, 6);
  assert.equal(h.notifications.length, 1);
  h.emit({ version: '1.3.0', buildId: 'build-a' });
  assert.equal(h.reveals, 6); assert.equal(h.opens, 6);
});

test('buildless release metadata deduplicates using its version', () => {
  const h = fixture(); h.emit({ version: '1.3.0' }); h.emit({ version: '1.3.0' });
  h.emit({ version: '1.4.0' });
  assert.equal(h.opens, 2); assert.equal(h.notifications.length, 2);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installSingleInstanceGuard } = require('../../electron/core/single-instance.cjs');

function appFixture(primary) {
  const app = new EventEmitter();
  let quitCalls = 0;
  app.requestSingleInstanceLock = () => primary;
  app.getPath = () => '/tmp/pi-studio-profile';
  app.quit = () => {
    quitCalls += 1;
  };
  return {
    app,
    get quitCalls() {
      return quitCalls;
    },
  };
}

test('secondary launch exits without installing another main listener', () => {
  const fixture = appFixture(false);
  let forwarded = 0;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(installSingleInstanceGuard(fixture.app, () => {
      forwarded += 1;
    }), false);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(fixture.quitCalls, 1);
  // 静默退出最难排查：必须留下数据目录，说明是被另一个实例占住了。
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /另一个 Pi Studio/);
  assert.match(warnings[0], /\/tmp\/pi-studio-profile/);
  assert.equal(fixture.app.listenerCount('second-instance'), 0);
  fixture.app.emit('second-instance', {}, [], '/tmp');
  assert.equal(forwarded, 0);
});

test('primary launch forwards second-instance details to the existing process', () => {
  const fixture = appFixture(true);
  let received;
  assert.equal(installSingleInstanceGuard(fixture.app, (details) => {
    received = details;
  }), true);
  fixture.app.emit('second-instance', {}, ['Pi Studio', '--flag'], '/workspace');
  assert.deepEqual(received, {
    argv: ['Pi Studio', '--flag'],
    workingDirectory: '/workspace',
  });
  assert.equal(fixture.quitCalls, 0);
});

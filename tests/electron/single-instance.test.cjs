const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installSingleInstanceGuard } = require('../../electron/core/single-instance.cjs');

function appFixture(primary) {
  const app = new EventEmitter();
  let quitCalls = 0;
  app.requestSingleInstanceLock = () => primary;
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
  assert.equal(installSingleInstanceGuard(fixture.app, () => {
    forwarded += 1;
  }), false);
  assert.equal(fixture.quitCalls, 1);
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

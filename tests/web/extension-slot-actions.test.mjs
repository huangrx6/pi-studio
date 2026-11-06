import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateExtensionSlotAction,
  advanceExtensionSlotOwner,
  executeExtensionSlotCommand,
  extensionSlotOwnerKey,
} from '../../web/src/features/extensions/extension-slot-actions.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function fixture(overrides = {}) {
  const calls = {
    commands: [],
    prompts: [],
    panels: [],
    settings: [],
    copies: [],
    urls: [],
    notices: [],
  };
  const effects = {
    runCommand: async (commandId) => {
      calls.commands.push(commandId);
      return {};
    },
    openSettings: (page) => calls.settings.push(page),
    openPanel: (panelId) => calls.panels.push(panelId),
    sendPrompt: (text, submit) => calls.prompts.push([text, submit]),
    copyText: async (text) => calls.copies.push(text),
    openUrl: async (url) => calls.urls.push(url),
    notify: (message, tone) => calls.notices.push([message, tone]),
    ...overrides,
  };
  return { calls, effects };
}

test('owner changes advance only when slot, workspace, session, or model changes', () => {
  const initial = { key: extensionSlotOwnerKey('composer.before', '/a', 'one', 'model:a'), generation: 0 };
  assert.equal(advanceExtensionSlotOwner(initial, initial.key), initial);
  for (const key of [
    extensionSlotOwnerKey('status.bar', '/a', 'one', 'model:a'),
    extensionSlotOwnerKey('composer.before', '/b', 'one', 'model:a'),
    extensionSlotOwnerKey('composer.before', '/a', 'two', 'model:a'),
    extensionSlotOwnerKey('composer.before', '/a', 'one', 'model:b'),
  ]) {
    assert.notEqual(key, initial.key);
    const next = advanceExtensionSlotOwner(initial, key);
    assert.notEqual(next, initial);
    assert.equal(next.generation, initial.generation + 1);
  }
});

test('late command results cannot send a prompt, open a panel, or notify the next owner', async () => {
  const response = deferred();
  const f = fixture({
    runCommand: (commandId) => {
      f.calls.commands.push(commandId);
      return response.promise;
    },
  });
  const owner = { key: 'A', generation: 1 };
  const current = { value: owner };
  const running = executeExtensionSlotCommand('scope.command', () => current.value === owner, f.effects);

  current.value = { key: 'B', generation: 2 };
  response.resolve({
    promptText: 'old prompt',
    submit: true,
    panelId: 'project:scope/panel',
    message: 'old result',
  });

  assert.equal(await running, false);
  assert.deepEqual(f.calls.commands, ['scope.command']);
  assert.deepEqual(f.calls.prompts, []);
  assert.deepEqual(f.calls.panels, []);
  assert.deepEqual(f.calls.notices, []);
});

test('a nested command is not started or applied after ownership changes', async () => {
  const first = deferred();
  const second = deferred();
  const f = fixture({
    runCommand: (commandId) => {
      f.calls.commands.push(commandId);
      return commandId === 'scope.second' ? second.promise : first.promise;
    },
  });
  const owner = { key: 'A', generation: 1 };
  const current = { value: owner };
  const running = executeExtensionSlotCommand('scope.first', () => current.value === owner, f.effects);

  first.resolve({ action: { kind: 'runCommand', commandId: 'scope.second' } });
  await flush();
  assert.deepEqual(f.calls.commands, ['scope.first', 'scope.second']);

  current.value = { key: 'B', generation: 2 };
  second.resolve({ promptText: 'nested old prompt', panelId: 'project:scope/panel' });

  assert.equal(await running, false);
  assert.deepEqual(f.calls.prompts, []);
  assert.deepEqual(f.calls.panels, []);
});

test('late command rejection cannot surface an error in the next owner', async () => {
  const response = deferred();
  const f = fixture({ runCommand: () => response.promise });
  const owner = { key: 'A', generation: 1 };
  const current = { value: owner };
  const running = activateExtensionSlotAction(
    { kind: 'runCommand', commandId: 'scope.failure' },
    () => current.value === owner,
    f.effects,
  );

  current.value = { key: 'B', generation: 2 };
  response.reject(new Error('old failure'));

  assert.equal(await running, false);
  assert.deepEqual(f.calls.notices, []);
});

test('late clipboard completion cannot post its success notice into the next owner', async () => {
  const copied = deferred();
  const f = fixture({
    copyText: (text) => {
      f.calls.copies.push(text);
      return copied.promise;
    },
  });
  const owner = { key: 'A', generation: 1 };
  const current = { value: owner };
  const running = activateExtensionSlotAction(
    { kind: 'copyText', text: 'owned text' },
    () => current.value === owner,
    f.effects,
  );

  current.value = { key: 'B', generation: 2 };
  copied.resolve();

  assert.equal(await running, false);
  assert.deepEqual(f.calls.copies, ['owned text']);
  assert.deepEqual(f.calls.notices, []);
});

test('same-owner command results still apply every declared renderer effect', async () => {
  const f = fixture({
    runCommand: async () => ({
      promptText: 'current prompt',
      submit: false,
      settingsPage: 'extensions',
      panelId: 'project:scope/panel',
      message: 'current result',
    }),
  });
  const owner = { key: 'A', generation: 1 };
  const applied = await activateExtensionSlotAction(
    { kind: 'runCommand', commandId: 'scope.current' },
    () => owner === owner,
    f.effects,
  );

  assert.equal(applied, true);
  assert.deepEqual(f.calls.prompts, [['current prompt', false]]);
  assert.deepEqual(f.calls.settings, ['extensions']);
  assert.deepEqual(f.calls.panels, ['project:scope/panel']);
  assert.deepEqual(f.calls.notices, [['current result', undefined]]);
});

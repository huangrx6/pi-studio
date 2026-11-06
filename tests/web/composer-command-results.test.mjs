import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { composerDraftMatches, snapshotComposerDraft } from '../../web/src/features/conversation/composer-preparation.ts';
import { clearComposerDraft, readComposerDraft, saveComposerDraft } from '../../web/src/features/conversation/composer-drafts.ts';

// Run the actual App command functions with controlled IPC promises. Private UI
// dependencies are stubs; ownership checks and await boundaries remain production code.
const source = fs.readFileSync(new URL('../../web/src/features/conversation/useComposerCommands.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('useComposerCommands.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['executeBuiltinCommand', 'executeExtensionCommand', 'applyExtensionCommandResult'];
const found = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.set(node.name.text, node.getText(parsed));
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.equal(found.size, names.length);
const compiled = ts.transpileModule([...found.values()].join('\n') + `\nexport { ${names.join(', ')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  const store = new Map();
  saveComposerDraft(store, 'A', { text: '/command', attachments: [] });
  const calls = { notifications: [], feedback: [], prompts: [], actions: [], opened: [], errors: [], refreshes: 0 };
  const pending = { command: deferred(), create: deferred(), goal: deferred(), action: null, settings: null, nested: null };
  const owner = { current: 'A' }, generation = { current: 1 }, session = { current: { id: 'A', title: 'Session A' } };
  const module = { exports: {} };
  const globals = {
    module, exports: module.exports, Error,
    composerDraftKeyRef: owner, sessionLoadRef: generation, composerDraftsRef: { current: store }, sessionRef: session,
    workspace: '/workspace-a', composerDraftMatches, snapshotComposerDraft, clearComposerDraft, readComposerDraft,
    parseStudioCommand: () => ({ route: 'goal.control', argument: 'goal' }), parseGoalCommandArgument: () => ({ action: 'set', text: 'goal' }),
    setLongTaskBusy() {}, setBusy() {}, setError: error => calls.errors.push(error), errorText: error => String(error),
    pushNotification: (...args) => calls.notifications.push(args), showComposerFeedback: (...args) => calls.feedback.push(args),
    sendPromptFromExtension: (text, submit) => {
      calls.prompts.push([text, submit]);
      saveComposerDraft(store, owner.current, { ...readComposerDraft(store, owner.current), text });
      if (submit) queueMicrotask(() => clearComposerDraft(store, owner.current));
    },
    applyExtensionAction: async action => { calls.actions.push(action); if (pending.action) await pending.action.promise; },
    openSettings: async () => { if (pending.settings) await pending.settings.promise; }, conversationExtensionItems: [], openConversationExtension() {},
    loadState: async () => { calls.refreshes++; },
    conversationNavigationRef: { current: { open: async created => {
      calls.opened.push(created.id); generation.current++; owner.current = `session:${created.id}`; session.current = created; return true;
    } } },
    window: { piApi: {
      runExtensionCommand: ({ commandId }) => commandId === 'nested.command' && pending.nested ? pending.nested.promise : pending.command.promise,
      createConversation: () => pending.create.promise,
      conversationAction: payload => { calls.actions.push(payload); return pending.goal.promise; },
    } },
  };
  vm.runInNewContext(compiled, globals);
  return { ...module.exports, calls, pending, owner, generation, session, store };
}

test('late successful extension result cannot replace or submit another conversation draft', async () => {
  const f = fixture(); const running = f.executeExtensionCommand('fixture.command');
  f.owner.current = 'B'; f.generation.current++;
  saveComposerDraft(f.store, 'B', { text: 'keep B', attachments: [] });
  f.pending.command.resolve({ promptText: 'old result', submit: true });
  assert.equal(await running, true, 'main execution succeeded even though its UI result was suppressed');
  assert.equal(f.calls.prompts.length, 0);
  assert.equal(readComposerDraft(f.store, 'B').text, 'keep B');
  assert.equal(f.calls.notifications[0][3], 'A');
});

test('edited input suppresses extension sendPrompt actions and explains the preserved input', async () => {
  const f = fixture(); const running = f.executeExtensionCommand('fixture.command');
  saveComposerDraft(f.store, 'A', { text: 'new input', attachments: [] });
  f.pending.command.resolve({ action: { kind: 'sendPrompt', text: 'old', submit: true }, promptText: 'also old' });
  assert.equal(await running, true);
  assert.equal(f.calls.actions.length, 0); assert.equal(f.calls.prompts.length, 0);
  assert.match(f.calls.feedback[0][0], /结果未替换当前输入/);
});

test('result application rechecks ownership after an awaited action before later prompt fields', async () => {
  const f = fixture(); f.pending.action = deferred();
  const running = f.executeExtensionCommand('fixture.command');
  f.pending.command.resolve({ action: { kind: 'copyText', text: 'copy' }, promptText: 'late prompt' });
  await flush(); assert.equal(f.calls.actions.length, 1);
  saveComposerDraft(f.store, 'A', { text: 'typed during awaited action', attachments: [] });
  f.pending.action.resolve(); await running;
  assert.equal(f.calls.prompts.length, 0);
});

test('a goal whose creation finishes after navigation is not submitted or opened', async () => {
  const f = fixture(); f.session.current = null;
  const running = f.executeBuiltinCommand('/goal goal');
  f.owner.current = 'B'; f.generation.current++;
  f.pending.create.resolve({ id: 'new-goal', cwd: '/workspace-a', title: 'Goal' });
  await running;
  assert.equal(f.calls.actions.length, 0); assert.equal(f.calls.opened.length, 0);
  assert.match(f.calls.notifications[0][0], /目标尚未提交/);
  assert.equal(readComposerDraft(f.store, 'A').text, '/command');
});

test('a committed goal remains committed after navigation but never clears or opens the new context', async () => {
  const f = fixture(); f.session.current = null;
  const running = f.executeBuiltinCommand('/goal goal');
  f.pending.create.resolve({ id: 'new-goal', cwd: '/workspace-a', title: 'Goal' });
  await flush(); assert.equal(f.calls.actions.length, 1);
  f.owner.current = 'B'; f.generation.current++;
  saveComposerDraft(f.store, 'B', { text: 'keep B', attachments: [] });
  f.pending.goal.resolve({ started: true }); await running;
  assert.equal(f.calls.opened.length, 0);
  assert.match(f.calls.notifications[0][0], /目标已在/);
  assert.equal(readComposerDraft(f.store, 'B').text, 'keep B');
  assert.equal(readComposerDraft(f.store, 'A').text, '/command');
});

test('an unchanged goal opens its created conversation and consumes only the original draft slot', async () => {
  const f = fixture(); f.session.current = null;
  const running = f.executeBuiltinCommand('/goal goal');
  f.pending.create.resolve({ id: 'new-goal', cwd: '/workspace-a', title: 'Goal' });
  await flush(); f.pending.goal.resolve({ started: true }); await running;
  assert.deepEqual(f.calls.opened, ['new-goal']);
  assert.equal(f.store.has('A'), false);
  assert.match(f.calls.feedback[0][0], /新目标已建立/);
});


test('combined owned prompt changes still apply subsequent settings and message fields', async () => {
  const f = fixture();
  const running = f.executeExtensionCommand('fixture.command');
  f.pending.command.resolve({ action: { kind: 'sendPrompt', text: 'action text' }, promptText: 'final text', settingsPage: 'general', message: 'all applied' });
  await running;
  assert.deepEqual(f.calls.prompts, [['action text', false], ['final text', false]]);
  assert.equal(readComposerDraft(f.store, 'A').text, 'final text');
  assert.equal(f.calls.feedback.length, 0);
  assert.equal(f.calls.notifications[0][0], 'all applied');
});

test('an intentional submission consuming its own text does not suppress later result messages', async () => {
  const f = fixture(); f.pending.settings = deferred();
  const running = f.executeExtensionCommand('fixture.command');
  f.pending.command.resolve({ promptText: 'submit this', submit: true, settingsPage: 'general', message: 'submitted' });
  await flush(); f.pending.settings.resolve(); await running;
  assert.equal(f.calls.feedback.length, 0);
  assert.equal(f.calls.notifications[0][0], 'submitted');
});

test('nested commands propagate only their own draft changes to the parent result guard', async () => {
  const f = fixture(); f.pending.nested = deferred();
  const running = f.executeExtensionCommand('fixture.command');
  f.pending.command.resolve({ action: { kind: 'runCommand', commandId: 'nested.command' }, promptText: 'parent final', message: 'finished' });
  await flush(); f.pending.nested.resolve({ promptText: 'nested text' }); await running;
  assert.deepEqual(f.calls.prompts, [['nested text', false], ['parent final', false]]);
  assert.equal(f.calls.feedback.length, 0);
  assert.equal(f.calls.notifications[0][0], 'finished');
});

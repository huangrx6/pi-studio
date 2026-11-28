import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as durable from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxToolCall, fauxAssistantMessage } from '@earendil-works/pi-ai';

const require = createRequire(import.meta.url);

test('desktop chat tools keep focus, distinguish popup coordinates and check recipients before dispatch', async t => {
  t.mock.method(require('../../electron/main/core/studio-db.cjs'), 'getStudioDatabase', () => ({ getConversation: () => null }));
  const service = require('../../electron/main/services/desktop-control/index.cjs');
  const shot = { windowId: 10, mimeType: 'image/png', data: 'TUFJTg==', imageWidth: 300, imageHeight: 200, bytes: 4,
    panels: [{ windowId: 12, mimeType: 'image/png', data: 'UEFORUw=', imageWidth: 80, imageHeight: 120, bytes: 5 }] };
  const app = { appName: '示例应用', bundleId: 'studio.fixture.localized', windowId: 10 };
  const launches = [];
  const actions = [];
  const hotkeys = [];
  t.mock.method(service, 'hotkeyAllowedDesktop', async args => {
    hotkeys.push(args);
    return { ...app, key: args.key };
  });
  t.mock.method(service, 'launchAllowedDesktopApp', async args => {
    launches.push(args);
    return { ...app, alreadyRunning: true, screenshot: shot };
  });
  t.mock.method(service, 'captureAllowedDesktopScreenshot', async () => ({ ...app, ...shot }));
  t.mock.method(service, 'actAllowedDesktop', async args => {
    actions.push(args.actions);
    const steps = args.actions.map(step => ({ ...step, ok: true, chars: step.text?.length || 0, submitted: !!step.submit, chord: step.key || '' }));
    return { ...app, ok: true, steps, screenshot: shot };
  });
  let shells = 0;
  const bash = durable.defineTool({
    name: 'bash', description: 'Fixture', parameters: { type: 'object', properties: { command: { type: 'string' } } },
    async execute() { shells++; return { output: [{ type: 'text', text: 'ok' }] }; },
  });
  const desktop = require('../../electron/main/capabilities/desktop-control/index.cjs').createDesktopControlTools(durable);
  const shell = durable.defineExtension({ name: 'fixture-shell', tools: [bash] });
  const registry = durable.createRegistry();
  registry.install(desktop);
  registry.install(shell);
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'probe', name: 'Fixture' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models, registry }, context);
  t.after(() => harness.close(context));
  const conversation = await harness.root(context, { agent: {
    model: { provider: 'faux', modelId: 'probe' }, extensions: [desktop, shell], tools: [...desktop.tools, bash],
  } });
  const tool = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
  async function run(content, calls) {
    faux.setResponses([...calls, fauxAssistantMessage('结束')]);
    const submission = await conversation.submit({ type: 'input', content }, context);
    assert.equal((await submission.wait(context)).status, 'done');
  }

  await run('启动示例应用', [tool('desktop_launch', { ...app, bringToFront: true })]);
  assert.equal(launches.length, 0);
  const sendRequest = '给示例应用中的亿万富豪交流群发送晚安';
  const message = [{ type: 'type', text: '晚安', submit: true }];
  await run(sendRequest, [
    tool('desktop_launch', app),
    tool('bash', { command: "printf '%s' wx | /usr/bin/pbcopy" }),
    tool('desktop_act', { ...app, searchField: true, actions: [{ type: 'type', text: '亿万富豪交流群', clear: true }] }),
    tool('desktop_act', { ...app, actions: [{ type: 'hotkey', key: 'Enter' }] }),
    tool('desktop_act', { ...app, actions: [{ type: 'click', popupWindowId: 12, normX: 500, normY: 400 }] }),
    tool('desktop_act', { ...app, actions: message, chatTarget: { requested: '亿万富豪交流群', visibleTitle: '亿万富豪交流合作 (13)' } }),
  ]);
  assert.deepEqual(launches.map(call => call.bringToFront), [false]);
  assert.equal(shells, 0);
  assert.deepEqual(actions.map(steps => steps[0].type), ['type', 'click']);
  assert.equal(actions[1][0].popupWindowId, 12);
  await run(sendRequest, [
    tool('desktop_act', { ...app, actions: message, chatTarget: { requested: '亿万富豪交流合作', visibleTitle: '亿万富豪交流合作 (13)' } }),
  ]);
  await run('给示例应用中的 亿万富豪交流群中 发送一条消息，晚安', [
    tool('desktop_act', { ...app, actions: message, chatTarget: { requested: '亿万富豪', visibleTitle: '亿万富豪' } }),
  ]);
  assert.equal(actions.length, 2);
  await run(sendRequest, [
    tool('desktop_screenshot', app),
    tool('desktop_act', { ...app, actions: message, chatTarget: { requested: '亿万富豪交流群', visibleTitle: '亿万富豪交流群（13）', composer: 'empty' } }),
  ]);
  assert.equal(actions.length, 3);
  await run(sendRequest, [tool('desktop_hotkey', { ...app, key: ' CTRL + ReTuRn+ ' })]);
  assert.equal(hotkeys.length, 0);
  const target = { requested: '亿万富豪交流群', visibleTitle: '亿万富豪交流群（13）' };
  const send = (composer, steps = message) => tool('desktop_act', { ...app, chatTarget: { ...target, composer }, actions: steps });
  const paste = [{ type: 'hotkey', key: 'cmd+v' }];
  const enter = [{ type: 'hotkey', key: 'Return' }];
  for (const composer of ['existing', 'unreadable', 'prepared']) {
    await run(sendRequest, [tool('desktop_screenshot', app), send(composer, [...paste, ...enter])]);
    assert.equal(actions.length, 3);
  }
  await run(sendRequest, [send('empty')]); // Another submission's screenshot cannot authorize editing.
  assert.equal(actions.length, 3);
  // Both text and a deliberately pasted image can be prepared from an empty, observed composer.
  for (const [request, edit] of [[sendRequest, [{ type: 'type', text: '晚安' }]], ['给示例应用中的亿万富豪交流群发送剪贴板图片', paste]]) {
    await run(request, [tool('desktop_screenshot', app), send('empty', edit), send('prepared', enter)]);
  }
  assert.equal(actions.length, 7);
  const multiline = [{ type: 'type', text: '晚安\n明天见' }];
  await run(sendRequest, [tool('desktop_screenshot', app), send('empty', [...multiline, ...enter])]);
  await run(sendRequest, [tool('desktop_screenshot', app), send('empty', [{ ...multiline[0], submit: true }])]);
  assert.equal(actions.length, 7);
  await run(sendRequest, [tool('desktop_screenshot', app), send('empty', multiline), send('prepared', enter)]);
  assert.equal(actions.length, 9);
  await run(sendRequest, [tool('desktop_screenshot', app), tool('desktop_hotkey', { ...app, key: 'cmd+v' })]);
  assert.equal(hotkeys.length, 0);
  await run('使用命令行操作剪贴板', [tool('bash', { command: 'pbpaste' })]);
  assert.equal(shells, 1);
  const page = await conversation.entries({ order: 'ascending' }, 350, undefined, context);
  const results = page.items.flatMap(entry => entry.model || []).filter(message => message.role === 'toolResult');
  const errors = results.filter(result => result.isError).map(result => result.details?.code ?? result.toolName);
  assert.deepEqual(errors, ['desktop_agent_focus_blocked', 'bash', 'desktop_chat_target_required', 'desktop_chat_target_mismatch', 'desktop_chat_target_mismatch', 'desktop_chat_target_mismatch', 'desktop_chat_target_required',
    'desktop_chat_draft_preserved', 'desktop_chat_draft_preserved', 'desktop_chat_draft_preserved', 'desktop_chat_observation_required', 'desktop_chat_observation_required', 'desktop_chat_observation_required', 'desktop_chat_target_required']);
  assert.match(results.find(result => result.toolName === 'bash').content[0].text, /通过桌面工具/);
  for (const name of ['desktop_launch', 'desktop_act', 'desktop_screenshot']) {
    const result = results.find(item => item.toolName === name && !item.isError);
    assert.deepEqual(result.content.map(part => part.type), ['text', 'image', 'text', 'image']);
    assert.match(result.content[2].text, /popupWindowId=12/);
    assert.equal(result.content[3].data, shot.panels[0].data);
    const metadata = result.details.screenshot || result.details;
    assert.equal(metadata.panels[0].windowId, 12);
    assert.equal(Object.hasOwn(metadata.panels[0], 'data'), false);
  }
});

test('chat addresses use complete delimited names and all public Enter forms', async () => {
  const { checkChatTarget } = require('../../electron/main/capabilities/desktop-control/chat-target.cjs');
  function check(request, target, key = 'Enter', extra = {}) {
    const api = {
      conversationId: 1,
      commit: change => change({
        doc: async () => ({ run: { inputs: [2] } }),
        submission: async () => ({ entry: 3 }),
        entry: async () => ({ model: [{ role: 'user', content: request }] }),
      }),
    };
    return checkChatTarget('desktop_hotkey', { appName: '示例应用', windowId: 10, key, chatTarget: target ? { composer: 'empty', ...target } : target, ...extra }, api, durable, context, { observedWindow: 10 });
  }
  const checkNamed = (request, name) => check(request, { requested: name, visibleTitle: name + ' (13)' });
  for (const [request, full, partial] of [
    ['给示例应用中的 亿万富豪交流群中 发送一条消息，晚安', '亿万富豪交流群', '亿万富豪'],
    ['给示例应用中的\n**「产品设计群」**\n发送晚安', '产品设计群', '产品设计'],
    ['发给群聊 “产品、销售” 一句话', '产品、销售', '产品'],
    ['Send "good night" to “Product and QA”', 'Product and QA', 'Product'],
    ['Send a message to Project Atlas: good evening', 'Project Atlas', 'Project'],
    ['Send a message to “Project, Alpha”: nice work', 'Project, Alpha', 'Project'],
    ['**收件人**：`Ada Lovelace`\n内容：你好 Ada', 'Ada Lovelace', 'Ada'],
  ]) {
    await checkNamed(request, full);
    await assert.rejects(checkNamed(request, partial), { code: 'desktop_chat_target_mismatch' });
  }
  await check('请给当前群发送晚安', { requested: '当前群', visibleTitle: '内部群聊 (12)' });
  await check('在另一个应用搜索文档后按回车查看结果', null);
  await check('查找联系人并查看搜索结果', null);
  await check('Send an HTTP request to the local server', null);
  for (const [key, modifiers] of [['Enter', []], ['return', ['cmd']], [' CTRL + ReTuRn ', []], ['ctrl++ENTER+', []]]) {
    await assert.rejects(check('发送消息给联系人', null, key, { modifiers }), { code: 'desktop_chat_target_required' });
  }
  await assert.rejects(check('发送消息给联系人', null, 'x', { keyCode: 36 }), { code: 'desktop_hotkey_blocked' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as durable from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxToolCall, fauxAssistantMessage } from '@earendil-works/pi-ai';

const require = createRequire(import.meta.url);

test('desktop errors preserve completed steps, restrict the failing input to a report and restore tools on the next input', async t => {
  const service = require('../../electron/main/services/desktop-control/index.cjs');
  const failedStep = { index: 2, type: 'type', code: 'desktop_keyboard_permission', error: '键盘输入权限受阻' };
  let submits = 0;
  const screenshotError = { code: 'desktop_screenshot_failed', message: '截图失败' };
  t.mock.method(service, 'actAllowedDesktop', async ({ actions }) => {
    if (actions[0].submit || actions[0].key === 'enter') {
      submits++;
      const step = actions[0].submit ? { type: 'type', chars: 2, submitted: true, valueVerified: true }
        : { type: 'hotkey', chord: 'enter' };
      return { appName: 'Fixture', windowId: 1, ok: true, screenshotError, steps: [{ ...step, index: 1, ok: true }] };
    }
    return {
      appName: 'Fixture', bundleId: 'test.fixture', windowId: 1, ok: false, failedStep,
      steps: [{ index: 1, type: 'click', ok: true }, { ...failedStep, ok: false }],
    };
  });
  t.mock.method(service, 'typeAllowedDesktop', async () => {
    throw Object.assign(new Error('输入结果待核实'), { code: 'desktop_type_failed',
      cause: Object.assign(new Error('helper disconnected'), { code: 'desktop_action_outcome_unknown' }) });
  });
  let activeDesktopRuns = 0;
  let desktopRuns = 0;
  const observeRun = async (id, observer) => {
    const observation = await harness.observeDoc(durable.LiveDoc, id, observer, context);
    activeDesktopRuns++;
    desktopRuns++;
    return { value: observation.value, detach() { observation.detach(); activeDesktopRuns--; } };
  };
  const desktop = require('../../electron/main/capabilities/desktop-control/index.cjs').createDesktopControlTools(durable, observeRun);
  let shells = 0;
  const bash = durable.defineTool({
    name: 'bash', description: 'Fixture', parameters: { type: 'object', properties: {} },
    async execute() { shells++; return { output: [{ type: 'text', text: 'ok' }] }; },
  });
  const shell = durable.defineExtension({ name: 'shell-fixture', tools: [bash] });
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'probe', name: 'Desktop fixture' }] });
  const requestTools = [];
  let firstWorkflow;
  function observe(content, stopReason) {
    return ({ messages }) => {
      if (!requestTools.length) {
        firstWorkflow = messages.find(m => m.sections?.['studio-desktop-workflow'])?.sections['studio-desktop-workflow'];
      }
      requestTools.push(messages.flatMap(m => m.toolsAdded ?? []).map(tool => tool.name));
      return fauxAssistantMessage(content, { stopReason });
    };
  }
  const sendText = { actions: [{ type: 'type', text: '正文', submit: true }] };
  const pressEnter = { actions: [{ type: 'hotkey', key: 'enter' }] };
  faux.setResponses([
    observe([fauxToolCall('desktop_act', { actions: [{ type: 'click' }, { type: 'type', text: 'wx' }] }),
      fauxToolCall('bash', {})], 'toolUse'),
    observe('键盘输入受阻，请检查权限。', 'stop'),
    observe(fauxToolCall('desktop_type', { windowId: 1, text: '正文', submit: true }), 'toolUse'),
    // Even a provider that emits an unadvertised call cannot retry the side effect.
    observe(fauxToolCall('bash', {}), 'toolUse'),
    ...[sendText, pressEnter].flatMap(args => [
      observe([fauxToolCall('desktop_act', args), fauxToolCall('desktop_act', args)], 'toolUse'),
      observe('已按提交键，请核实目标窗口。', 'stop'),
    ]),
    observe(fauxToolCall('bash', {}), 'toolUse'),
    observe('done', 'stop'),
  ]);
  const registry = durable.createRegistry();
  registry.install(desktop);
  registry.install(shell);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models, registry }, context);
  try {
    const conversation = await harness.root(context, { agent: {
      model: { provider: 'faux', modelId: 'probe' }, extensions: [desktop, shell],
      tools: [...desktop.tools, bash],
    } });
    async function submit(content) {
      const input = await conversation.submit({ type: 'input', content }, context);
      assert.equal((await input.wait(context)).status, 'done');
    }
    await submit('输入测试');
    assert.match(firstWorkflow, /If the query is already visible, select the matching result/);
    assert.equal(shells, 0);
    await submit('再次测试');
    assert.equal(shells, 0);
    await submit('验证文本提交后截图失败');
    assert.equal(submits, 1);
    await submit('验证回车后截图失败');
    assert.equal(submits, 2);
    await submit('运行普通工具');
    assert.equal(shells, 1);
    assert.equal(activeDesktopRuns, 0);
    assert.equal(desktopRuns, 4);
    const history = await conversation.entries({ order: 'ascending' }, 100, undefined, context);
    const results = history.items.flatMap(entry => entry.model ?? []).filter(m => m.role === 'toolResult');
    const batch = results.find(m => m.toolName === 'desktop_act');
    assert.equal(batch.isError, true);
    assert.equal(batch.details.retryable, false);
    assert.equal(batch.details.steps[0].ok, true);
    assert.equal(batch.details.failedStep.index, 2);
    const type = results.find(m => m.toolName === 'desktop_type');
    assert.equal(type.isError, true);
    assert.equal(type.details.code, 'desktop_action_outcome_unknown');
    const dispatched = results.filter(m => m.details?.code === 'desktop_submit_unverified');
    assert.equal(dispatched.length, 2);
    for (const result of dispatched) {
      assert.equal(result.isError, false);
      assert.equal(result.details.ok, true);
      assert.equal(result.details.retryable, false);
      assert.equal(result.details.submissionStatus, 'dispatched_unverified');
      assert.deepEqual(result.details.screenshotError, screenshotError);
      assert.match(result.content.map(block => block.text || '').join('\n'), /请在目标窗口核实提交结果/);
    }
    assert.equal(dispatched[0].details.steps[0].submitted, true);
    assert.equal(dispatched[0].details.steps[0].valueVerified, true);
    assert.equal(dispatched[1].details.steps[0].chord, 'enter');
    assert.deepEqual(results.filter(m => m.toolName === 'bash').map(m => m.isError), [true, true, false]);
    assert.deepEqual(requestTools.map(names => names.includes('bash')), [true, false, true, false, true, false, true, false, true, true]);
  } finally {
    await harness.close(context);
  }
});

test('a recoverable window error cannot replay a submission completed earlier in its batch', async () => {
  const { createDesktopFailureHandling } = require('../../electron/main/capabilities/desktop-control/tool-failures.cjs');
  const { wrap } = createDesktopFailureHandling(durable);
  const stop = {};
  const api = {
    conversationId: 1,
    commit: change => change({ doc: async token => token === durable.LiveDoc ? { run: { inputs: [42] } } : stop }),
  };
  const failedStep = { index: 2, type: 'click', code: 'desktop_target_not_found', error: '控件已改变' };
  const tool = wrap({
    async execute({ submitted }) {
      return { output: [{ type: 'text', text: failedStep.error }], details: {
        ok: false, failedStep, steps: [{ index: 1, type: 'type', ok: true, submitted }, { ...failedStep, ok: false }],
      } };
    },
  });
  assert.equal((await tool.execute({ submitted: false }, api, context)).details.retryable, true);
  assert.equal(stop.submission, undefined);
  assert.equal((await tool.execute({ submitted: true }, api, context)).details.retryable, false);
  assert.equal(stop.submission, 42);
});

test('a foreground interruption allows a background alternative and stops repeated physical attempts', async () => {
  const { createDesktopFailureHandling } = require('../../electron/main/capabilities/desktop-control/tool-failures.cjs');
  const { wrap } = createDesktopFailureHandling(durable);
  const state = {};
  let input = 42;
  const api = {
    conversationId: 1,
    commit: change => change({ doc: async token => token === durable.LiveDoc ? { run: { inputs: [input] } } : state }),
  };
  const tool = wrap({ async execute() {
    throw Object.assign(new Error('调度中心'), { code: 'desktop_mission_control_active' });
  } });
  assert.equal((await tool.execute({}, api, context)).details.retryable, true);
  assert.equal(state.submission, undefined);
  assert.equal((await tool.execute({}, api, context)).details.retryable, false);
  assert.equal(state.submission, 42);
  input++;
  assert.equal((await tool.execute({}, api, context)).details.retryable, true);
});

test('a background press with no confirming image keeps its successful dispatch and cannot be replayed', async () => {
  const { createDesktopFailureHandling } = require('../../electron/main/capabilities/desktop-control/tool-failures.cjs');
  const { wrap } = createDesktopFailureHandling(durable);
  const state = {};
  const api = {
    conversationId: 1,
    commit: change => change({ doc: async token => token === durable.LiveDoc ? { run: { inputs: [42] } } : state }),
  };
  const tool = wrap({ async execute() {
    return { output: [], details: { ok: true, steps: [{ type: 'click', ok: true, method: 'AXPress' }],
      screenshotError: { code: 'desktop_screenshot_failed' } } };
  } });
  const result = await tool.execute({}, api, context);
  assert.equal(result.details.pressStatus, 'dispatched_unverified');
  assert.equal(result.details.retryable, false);
  assert.equal(state.submission, 42);
});

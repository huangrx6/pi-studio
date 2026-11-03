import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Harness,
  MemoryStorage,
  createRegistry,
} from '@earendil-works/pi-durable';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

import durableView from '../../electron/services/durable-view.cjs';

/**
 * 端到端护栏：用真实 Harness + 脚本化模型跑一轮，确认 Studio 的投影层能从
 * 真实会话视图里取出完整的流式事件序列。
 *
 * 这个测试存在的理由：1.5.0 删除 `watchEvents()` 时，单元测试因为使用 mock
 * 全部保持绿色，而实时管道整条断掉。凡是"Studio 依赖 Durable 实时契约"的
 * 假设，都必须在这里被真实执行一次。
 */
test('会话视图投影覆盖一轮完整的流式运行', async () => {
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'projection probe' }],
    // 让回答分多个 token 流出，确保至少提交一次流式 partial。
    tokensPerSecond: 40,
    tokenSize: { min: 4, max: 4 },
  });
  faux.setResponses([
    () => fauxAssistantMessage(
      'streamed answer that is long enough to be delivered in several chunks',
    ),
  ]);

  const models = createModels();
  models.setProvider(faux.provider);

  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );

  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'faux-1' },
        extensions: [],
        tools: [],
      },
    });

    const watch = await conversation.watch(BACKGROUND_CONTEXT);
    const frames = [watch.value];
    let sawRun = false;
    let resolveEnded;
    const ended = new Promise((resolve) => { resolveEnded = resolve; });
    watch.start(async (call) => {
      if (call.kind !== 'value') return;
      frames.push(call.value);
      const live = durableView.liveFromView(call.value);
      if (live.run) sawRun = true;
      else if (sawRun) resolveEnded();
    });

    const submission = await conversation.submit(
      { type: 'input', content: 'hello there' },
      BACKGROUND_CONTEXT,
    );
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, 'done');

    const timeout = new Promise((resolve) => setTimeout(resolve, 5_000).unref?.());
    await Promise.race([ended, timeout]);
    await watch.stop();

    // 按 Studio 的投影逻辑重放收到的视图
    const known = durableView.seedEntryIds(frames[0].entries);
    const events = [];
    let previous = durableView.liveFromView(frames[0]);
    for (const frame of frames.slice(1)) {
      for (const entry of durableView.appendedEntries(known, frame.entries)) {
        const assistant = (entry.model || []).some((message) => message.role === 'assistant');
        events.push({ type: assistant ? 'assistant.completed' : 'transcript.appended' });
      }
      const next = durableView.liveFromView(frame);
      for (const change of durableView.diffLive(previous, next)) events.push(change);
      previous = next;
    }

    const types = events.map((event) => event.type);
    assert.ok(types.includes('run.started'), `缺少 run.started，实际为 ${types.join(', ')}`);
    assert.ok(types.includes('assistant.updated'), `缺少流式 assistant.updated，实际为 ${types.join(', ')}`);
    assert.ok(types.includes('assistant.completed'), `缺少 assistant.completed，实际为 ${types.join(', ')}`);
    assert.ok(types.includes('run.completed'), `缺少 run.completed，实际为 ${types.join(', ')}`);

    // 顺序：运行开始 → 流式 → 落定 → 运行结束
    assert.ok(types.indexOf('run.started') < types.indexOf('assistant.updated'));
    assert.ok(types.indexOf('assistant.updated') < types.indexOf('assistant.completed'));
    assert.ok(types.indexOf('assistant.completed') < types.indexOf('run.completed'));

    // 流式内容来自 pi.live.generation.message，落定内容来自 transcript entry
    const streamed = events.find((event) => event.type === 'assistant.updated');
    assert.match(JSON.stringify(streamed.payload.message), /streamed answer/);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test('模型报错时投影出 run.failed 并带上 reason', async () => {
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'projection probe' }],
  });
  faux.setResponses([
    () => {
      throw new Error('provider exploded');
    },
  ]);

  const models = createModels();
  models.setProvider(faux.provider);

  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry: createRegistry(),
      // 关掉自动重试，否则 backoff 会把失败推迟到测试窗口之外。
      settings: { retry: { enabled: false } },
    },
    BACKGROUND_CONTEXT,
  );

  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'faux', modelId: 'faux-1' },
        extensions: [],
        tools: [],
      },
    });

    const watch = await conversation.watch(BACKGROUND_CONTEXT);
    const frames = [watch.value];
    watch.start(async (call) => {
      if (call.kind === 'value') frames.push(call.value);
    });

    const submission = await conversation.submit(
      { type: 'input', content: 'fail please' },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);

    // 等待 runFailure 落地
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const latest = durableView.liveFromView(frames.at(-1));
      if (latest.runFailure) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await watch.stop();

    const known = durableView.seedEntryIds(frames[0].entries);
    const events = [];
    let previous = durableView.liveFromView(frames[0]);
    for (const frame of frames.slice(1)) {
      durableView.appendedEntries(known, frame.entries);
      const next = durableView.liveFromView(frame);
      events.push(...durableView.diffLive(previous, next));
      previous = next;
    }

    const failed = events.filter((event) => event.type === 'run.failed');
    assert.equal(failed.length, 1, '失败必须恰好通知一次');
    assert.equal(failed[0].payload.reason, 'model_error');
    assert.equal(typeof failed[0].payload.taskId, 'string');
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

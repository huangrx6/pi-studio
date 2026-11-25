/** Isolated Electron + Durable + real SDK stream, with a loopback model only. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchTestDesktop, configureTestModel, selectTestSession } from './fixtures/isolated-desktop.mjs';
const output = new URL('../../.qa/live-metrics/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'profile-'));
const workspace = path.join(profile, 'workspace');
await mkdir(workspace);
let finish;
const model = http.createServer(async (req, res) => {
  for await (const _ of req) { /* consume request without logging its content */ }
  if (!req.url.endsWith('/chat/completions')) { res.end(JSON.stringify({ data: [] })); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'qa-stream', object: 'chat.completion.chunk', model: 'check', choices: [{ index: 0, delta, finish_reason: reason }], ...(usage ? { usage } : {}) })}\n\n`);
  const timer = setInterval(() => chunk({ content: '持续生成中的测试内容。' }), 150);
  res.on('close', () => clearInterval(timer));
  finish = () => {
    if (res.writableEnded || res.destroyed) return;
    clearInterval(timer);
    chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 73, total_tokens: 85 });
    res.end('data: [DONE]\n\n');
  };
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
let app, page;
function all(value) { return Array.isArray(value) ? value.flatMap(all) : value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(all)] : []; }
function metric(snapshot, id) { return all(snapshot).find(value => value.id === id)?.value; }
async function waitForStream(subscriptionId, after = 0, finishedRounds = 0) {
  await page.waitForFunction(({ subscriptionId, after, finishedRounds }) => {
    const values = window.metricEvents.slice(after).filter(event => event.subscriptionId === subscriptionId)
      .filter(event => (event.snapshot.content.find(block => block.title === '最近结果')?.items?.length || 0) >= finishedRounds)
      .flatMap(event => event.snapshot.content.flatMap(block => block.metrics || []))
      .filter(metric => metric.id === 'output-tokens' && metric.detail?.includes('流式估算') && Number(metric.value) > 0)
      .map(metric => metric.value);
    return new Set(values).size >= 3;
  }, { subscriptionId, after, finishedRounds }, { timeout: 20000 });
  return page.evaluate(({ subscriptionId, after }) => window.metricEvents.slice(after).filter(event => event.subscriptionId === subscriptionId), { subscriptionId, after });
}
async function waitForCompletion(subscriptionId, after = 0) {
  await page.waitForFunction(({ subscriptionId, after }) => window.metricEvents.slice(after)
    .filter(event => event.subscriptionId === subscriptionId)
    .some(event => event.snapshot.content.some(block => block.metrics?.some(metric => (
      metric.id === 'output-tokens' && metric.value === '73' && metric.detail === '最近一轮'
    )))), { subscriptionId, after }, { timeout: 15000 });
}
function assertLiveTps(snapshot) {
  const samples = snapshot.content.find(block => block.kind === 'sparkline')?.values;
  assert.ok(samples?.at(-1) > 0, 'the current round has live TPS samples');
  assert.match(snapshot.content[0].text, /本轮运行/);
  assert.equal(Number(metric(snapshot, 'live-tps')), samples.at(-1), 'TPS card and chart share the latest sample');
  assert.ok(Number(metric(snapshot, 'output-tokens')) < 73, 'live output excludes the previous round');
}
try {
  ({ app, page } = await launchTestDesktop(workspace, profile, 1180, 900));
  await page.evaluate(() => window.piApi.waitForStartup());
  await configureTestModel(page, workspace, `http://127.0.0.1:${model.address().port}/v1`);
  const sessions = await page.evaluate(async cwd => {
    const api = window.piApi;
    const a = await api.createConversation({ cwd, title: '流式指标会话 A' });
    const b = await api.createConversation({ cwd, title: '独立指标会话 B' });
    return { a: a.id, b: b.id };
  }, workspace);
  await page.reload();
  await selectTestSession(page, workspace, sessions.a);
  const openExtensions = () => page.locator('.chat-header').getByRole('button', { name: '扩展', exact: true }).click();
  const metricsCard = page.getByRole('dialog', { name: '扩展', exact: true }).getByRole('article', { name: 'Studio 指标', exact: true });
  await openExtensions();
  await metricsCard.getByText('等待首次模型请求', { exact: true }).waitFor();
  await metricsCard.evaluate(card => {
    window.metricsCardRates = [];
    const observation = new MutationObserver(() => {
      const rate = Number(card.textContent.match(/([\d.]+) tok\/s/)?.[1]);
      if (rate > 0) window.metricsCardRates.push(rate);
    });
    observation.observe(card, { subtree: true, childList: true, characterData: true });
  });
  const ids = await page.evaluate(async ({ a, b, cwd }) => {
    const api = window.piApi;
    window.metricEvents = [];
    api.onExtensionDataView(event => window.metricEvents.push(event));
    const first = await api.openExtensionDataView({ sourceId: 'builtin:studio-metrics/live', sessionId: a, cwd });
    const second = await api.openExtensionDataView({ sourceId: 'builtin:studio-metrics/live', sessionId: b, cwd });
    window.metricViews = [first, second];
    await api.conversationSubmit({ id: a, text: 'Generate a synthetic test answer.', requestId: 'qa-streaming' });
    return { a, b, first: first.subscriptionId, second: second.subscriptionId };
  }, { ...sessions, cwd: workspace });
  const aEvents = await waitForStream(ids.first);
  assertLiveTps(aEvents.at(-1).snapshot);
  await page.waitForFunction(() => new Set(window.metricsCardRates).size >= 2);
  await metricsCard.screenshot({ path: path.join(output, 'card-streaming.png') });
  assert.equal((await page.evaluate(id => window.piApi.conversationSnapshot(id), ids.a)).running, true);
  const streamed = await page.evaluate(() => window.metricEvents);
  assert.ok(aEvents.some(e => JSON.stringify(e.snapshot.content).includes('流式指标会话 A')));
  assert.ok(aEvents.some(e => JSON.stringify(e.snapshot.content).includes('流式估算')));
  assert.ok(aEvents.some(e => parseFloat(metric(e.snapshot, 'live-tps')) > 0));
  for (const e of streamed.filter(e => e.subscriptionId === ids.second)) assert.ok(!Number(metric(e.snapshot, 'output-tokens')));
  finish();
  await waitForCompletion(ids.first);
  await metricsCard.getByText(/^最近请求 · [\d.]+ tok\/s · TTFT /).waitFor();
  const afterFirst = await page.evaluate(async (id) => {
    const start = window.metricEvents.length;
    await window.piApi.conversationSubmit({ id, text: 'Generate another synthetic test answer.', requestId: 'qa-streaming-follow-up' });
    return start;
  }, ids.a);
  const nextEvents = await waitForStream(ids.first, afterFirst, 1);
  assertLiveTps(nextEvents.at(-1).snapshot);
  const afterSecond = await page.evaluate(async (id) => {
    await window.piApi.conversationSubmit({ id, text: 'Generate a queued synthetic answer.', requestId: 'qa-streaming-queued', whenBusy: 'followUp' });
    return window.metricEvents.length;
  }, ids.a);
  finish();
  const queuedEvents = await waitForStream(ids.first, afterSecond, 2);
  assertLiveTps(queuedEvents.at(-1).snapshot);
  const beforeFinal = await page.evaluate(() => window.metricEvents.length);
  finish();
  await waitForCompletion(ids.first, beforeFinal);
  const events = await page.evaluate(() => window.metricEvents);
  const final = events.filter(e => e.subscriptionId === ids.first).at(-1).snapshot;
  assert.equal(Number(metric(final, 'live-tps')), final.content.find(block => block.kind === 'sparkline').values.at(-1));
  await metricsCard.getByText(/^最近请求 · [\d.]+ tok\/s · TTFT /).waitFor();
  await page.keyboard.press('Escape');
  await selectTestSession(page, workspace, ids.b);
  await openExtensions();
  await metricsCard.getByText('等待首次模型请求', { exact: true }).waitFor();
  await page.evaluate(async () => { for (const view of window.metricViews) await window.piApi.closeExtensionDataView(view.subscriptionId); });
  await writeFile(output + 'result.json', JSON.stringify({ checks: ['extension card updates before completion and retains the recent rate', 'public session maps to its Durable metrics and title', 'other session remains empty', 'TPS card matches the stream chart in consecutive and queued rounds', 'final output reconciles to 73 provider tokens'], streamingUpdates: aEvents.length, outputValues: aEvents.map(e => metric(e.snapshot, 'output-tokens')), final }, null, 2));
  console.log('Real Electron streaming metrics QA passed');
} catch (error) {
  if (page) await writeFile(output + 'failure.json', JSON.stringify(await page.evaluate(() => ({ events: window.metricEvents, views: window.metricViews })), null, 2));
  throw error;
} finally { finish?.(); if (app) await app.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }

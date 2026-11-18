/** Isolated Electron + Durable + real SDK stream, with a loopback model only. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchTestDesktop, configureTestModel } from './fixtures/isolated-desktop.mjs';
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
  let parts = 0;
  const timer = setInterval(() => { parts++; chunk({ content: '持续生成中的测试内容。' }); }, 150);
  res.on('close', () => clearInterval(timer));
  finish = () => { clearInterval(timer); chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 73, total_tokens: 85 }); res.end('data: [DONE]\n\n'); };
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
let app, page;
function all(value) { return Array.isArray(value) ? value.flatMap(all) : value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(all)] : []; }
function metric(snapshot, id) { return all(snapshot).find(value => value.id === id)?.value; }
try {
  ({ app, page } = await launchTestDesktop(workspace, profile, 1180, 900));
  await page.evaluate(() => window.piApi.waitForStartup());
  await configureTestModel(page, workspace, `http://127.0.0.1:${model.address().port}/v1`);
  const ids = await page.evaluate(async cwd => {
    const api = window.piApi;
    const a = await api.createConversation({ cwd, title: '流式指标会话 A' });
    const b = await api.createConversation({ cwd, title: '独立指标会话 B' });
    await api.subscribeConversation(a.id);
    window.metricEvents = [];
    api.onExtensionDataView(event => window.metricEvents.push(event));
    const first = await api.openExtensionDataView({ sourceId: 'builtin:studio-metrics/live', sessionId: a.id, cwd });
    const second = await api.openExtensionDataView({ sourceId: 'builtin:studio-metrics/live', sessionId: b.id, cwd });
    window.metricViews = [first, second];
    await api.conversationSubmit({ id: a.id, text: 'Generate a synthetic test answer.', requestId: 'qa-streaming' });
    return { a: a.id, b: b.id, first: first.subscriptionId, second: second.subscriptionId };
  }, workspace);
  await page.waitForFunction(first => {
    const values = window.metricEvents.filter(e => e.subscriptionId === first).flatMap(e => e.snapshot.content.flatMap(block => block.metrics || [])).filter(m => m.id === 'output-tokens').map(m => m.value).filter(v => Number(v) > 0);
    return new Set(values).size >= 3;
  }, ids.first, { timeout: 20000 });
  assert.equal((await page.evaluate(id => window.piApi.conversationSnapshot(id), ids.a)).running, true);
  const streamed = await page.evaluate(() => window.metricEvents);
  const aEvents = streamed.filter(e => e.subscriptionId === ids.first);
  assert.ok(aEvents.some(e => JSON.stringify(e.snapshot.content).includes('流式指标会话 A')));
  assert.ok(aEvents.some(e => JSON.stringify(e.snapshot.content).includes('流式估算')));
  assert.ok(aEvents.some(e => parseFloat(metric(e.snapshot, 'live-tps')) > 0));
  for (const e of streamed.filter(e => e.subscriptionId === ids.second)) assert.ok(!Number(metric(e.snapshot, 'output-tokens')));
  finish();
  await page.waitForFunction(first => window.metricEvents.filter(e => e.subscriptionId === first).some(e => e.snapshot.content.some(block => block.metrics?.some(m => m.id === 'output-tokens' && String(m.value) === '73' && m.detail === '最近一轮'))), ids.first, { timeout: 15000 });
  const events = await page.evaluate(() => window.metricEvents);
  await page.evaluate(async () => { for (const view of window.metricViews) await window.piApi.closeExtensionDataView(view.subscriptionId); });
  await writeFile(output + 'result.json', JSON.stringify({ checks: ['updates before stream completes', 'public session maps to its Durable metrics and title', 'other session remains empty', 'final output reconciles to 73 provider tokens'], streamingUpdates: aEvents.length, outputValues: aEvents.map(e => metric(e.snapshot, 'output-tokens')), final: events.filter(e => e.subscriptionId === ids.first).at(-1).snapshot }, null, 2));
  console.log('Real Electron streaming metrics QA passed');
} catch (error) {
  if (page) await writeFile(output + 'failure.json', JSON.stringify(await page.evaluate(() => ({ events: window.metricEvents, views: window.metricViews })), null, 2));
  throw error;
} finally { finish?.(); if (app) await app.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }

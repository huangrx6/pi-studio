/**
 * Performance gate for opening a large conversation.
 *
 * Copies the real Studio database into a throw-away profile, opens the largest
 * conversation and fails when the page payload, DOM size or long-task budget
 * regress past the numbers the transcript windowing and lazy traces established.
 *
 *   node tools/qa/qa-performance.mjs
 *
 * Budgets (measured on the 2000-message reference conversation):
 *   payload  ≤ 13 MB   (summaries removed 8.6 MB of request snapshots)
 *   DOM      ≤ 30 000  (window mounts 24 turns; heavy turns vary the count)
 *   open     ≤ 6 000 ms
 *   blocking ≤ 2 000 ms total long-task time
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const reference = '00562e20-27e6-427e-9cc4-e14f88d9c8c7';
const profile = mkdtempSync(path.join(tmpdir(), 'pi-perf-'));
const db = path.join(profile, 'pi-studio.sqlite');
execSync(`sqlite3 "file:${process.env.HOME}/Library/Application Support/pi-studio/pi-studio.sqlite?mode=ro" ".backup '${db}'"`);
const env = { ...process.env, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: db };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;

const app = await _electron.launch({ args: [root], env });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 60000 });

  const payload = await app.evaluate(async (_electron, { rootPath, id }) => {
    const requirePath = process.getBuiltinModule('module').createRequire(`${rootPath}/package.json`);
    const { conversationPage } = requirePath(`${rootPath}/electron/runtime/conversations.cjs`);
    const started = Date.now();
    const result = await conversationPage(id, { limit: 2000 });
    return {
      ms: Date.now() - started,
      bytes: JSON.stringify(result).length,
      messages: result.messages.length,
      tracesDeferred: (result.requestTraces || []).every((trace) => trace.snapshot === 'deferred'),
    };
  }, { rootPath: root, id: reference });

  assert.ok(payload.bytes <= 13 * 1024 * 1024, `page payload stays bounded (${(payload.bytes / 1024 / 1024).toFixed(1)} MB)`);
  assert.equal(payload.tracesDeferred, true, 'request traces ship as summaries');

  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__long.push(Math.round(entry.duration));
    }).observe({ entryTypes: ['longtask'] });
  });

  if (await page.locator('.session-row').count() === 0) {
    await page.locator('.workspace-head, .workspace-row').filter({ hasText: 'pi-studio' }).first().click();
    await page.waitForSelector('.session-row', { timeout: 30000 });
  }
  const started = Date.now();
  await page.locator('.session-row', { hasText: '优化方向' }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.messages > *').length > 5, null, { timeout: 120000 });
  const openMs = Date.now() - started;
  await page.waitForTimeout(1200);
  const dom = await page.evaluate(() => ({
    nodes: document.getElementsByTagName('*').length,
    blocking: window.__long.reduce((sum, value) => sum + value, 0),
    mountedTurns: document.querySelectorAll('.message.user').length,
  }));

  assert.ok(openMs <= 6000, `opening lands under 6s (${openMs} ms)`);
  assert.ok(dom.nodes <= 30000, `DOM stays under 30k nodes (${dom.nodes})`);
  assert.ok(dom.mountedTurns <= 40, `only a window of turns is mounted (${dom.mountedTurns})`);
  assert.ok(dom.blocking <= 2000, `long tasks stay under 2s (${dom.blocking} ms)`);

  console.log('performance gate passed', JSON.stringify({
    payloadMb: Number((payload.bytes / 1024 / 1024).toFixed(1)),
    pageMs: payload.ms,
    messages: payload.messages,
    openMs,
    domNodes: dom.nodes,
    mountedTurns: dom.mountedTurns,
    blockingMs: dom.blocking,
  }));
} finally {
  await app.close();
}

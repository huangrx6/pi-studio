/**
 * Isolated production-renderer baseline (not Electron, IPC, database or model latency).
 * Run after building: node tools/qa/qa-performance.mjs
 * Optional: QA_PERF_LABEL=after; QA_PERF_SAMPLES=5 (minimum 5); CHROME_BIN=...
 * All fixture data is synthetic. Only web-dist assets are served on loopback.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
import { installPerformanceFixture } from './fixtures/performance.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sampleCount = Math.max(5, Number(process.env.QA_PERF_SAMPLES) || 5);
const label = (process.env.QA_PERF_LABEL || 'baseline').replace(/[^a-z0-9_-]/gi, '-');
const output = path.join(root, '.qa', 'performance', label);
const viewport = { width: 1440, height: 920 };
const scenarios = [{ name: '120-sessions-120-turns', sessionCount: 120, turnCount: 120 }, { name: '1200-sessions-1200-turns', sessionCount: 1200, turnCount: 1200 }];
const percentile = (values, quantile) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * quantile) - 1)] : null;
const stats = (values) => ({ count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null });
const assets = await Promise.all(['index.html', ...(await readdir(path.join(root, 'web-dist/assets'))).filter((name) => /\.(js|css)$/.test(name)).sort().map((name) => `assets/${name}`)].map(async (name) => {
  const content = await readFile(path.join(root, 'web-dist', name));
  return { name, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
}));
const result = {
  schemaVersion: 1, createdAt: new Date().toISOString(), label,
  scope: 'Headless Chromium production renderer, synthetic synchronous in-memory API, fresh browser context per sample, shared browser process. Loopback assets; no real user data, Electron, model, IPC, OS cold-cache or actual display presentation measured.',
  method: { sampleCount, viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', cache: 'new context per sample; OS disk cache uncontrolled', input: 'trusted keyboard input event to second requestAnimationFrame = paint-opportunity proxy, not physical input-to-pixel latency', navigation: 'programmatic row click to expected heading, transcript, editable composer and second RAF', scroll: '60 RAF-driven upward scroll steps; RAF intervals proxy scheduling only, not real display FPS', heap: 'CDP Runtime.getHeapUsage without forced GC; includes synthetic fixture objects; not RSS', percentiles: 'nearest rank; with n=5 P95 is maximum; no statistical confidence or performance budget claimed' },
  machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
  assets, samples: [], summaries: {},
};
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(root);
let browser;

async function ready(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const start = performance.now();
    const check = () => {
      const input = document.querySelector('[role="textbox"][aria-label="发送给 Pi 的消息"]');
      if (input && !input.disabled && input.getBoundingClientRect().width > 0) requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
      else if (performance.now() - start > 15000) reject(new Error('Composer never became editable'));
      else requestAnimationFrame(check);
    }; check();
  }));
}
async function openSession(page, title) {
  return page.evaluate((expected) => new Promise((resolve, reject) => {
    const row = [...document.querySelectorAll('.session-row')].find((node) => node.querySelector('.session-title')?.textContent === expected);
    if (!row) return reject(new Error(`Missing row: ${expected}`));
    const start = performance.now();
    const callsBefore = window.__performanceQa.pageCalls.length;
    row.click();
    const check = () => {
      const input = document.querySelector('[role="textbox"][aria-label="发送给 Pi 的消息"]');
      if (document.querySelector('.chat-heading h1')?.textContent === expected && document.querySelector('.assistant-response') && input && !input.disabled) {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({ start, end: performance.now(), ms: performance.now() - start, pageCalls: window.__performanceQa.pageCalls.length - callsBefore })));
      } else if (performance.now() - start > 20000) reject(new Error(`Session did not render: ${expected}`));
      else requestAnimationFrame(check);
    }; requestAnimationFrame(check);
  }), title);
}
async function dom(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector('.workspace-list');
    const viewportBox = viewport?.getBoundingClientRect();
    const visibleRows = [...document.querySelectorAll('.session-row:not(.empty)')].filter((row) => {
      const box = row.getBoundingClientRect();
      return viewportBox && box.bottom > viewportBox.top && box.top < viewportBox.bottom && box.width > 0;
    }).length;
    return { totalElements: document.querySelectorAll('*').length, sidebarElements: document.querySelector('.sidebar')?.querySelectorAll('*').length ?? null, sessionRows: document.querySelectorAll('.session-row').length, sidebarVisibleRows: visibleRows, sidebarViewportHeight: viewport?.clientHeight ?? null, sidebarScrollHeight: viewport?.scrollHeight ?? null, transcriptElements: document.querySelector('.messages')?.querySelectorAll('*').length ?? null, mountedUserTurns: document.querySelectorAll('.message.user').length, mountedAssistantResponses: document.querySelectorAll('.assistant-response').length };
  });
}
async function inputFeedback(page) {
  const input = page.locator('[role="textbox"][aria-label="发送给 Pi 的消息"]');
  await input.focus();
  await page.evaluate(() => {
    window.__inputFeedback = [];
    document.querySelector('[role="textbox"][aria-label="发送给 Pi 的消息"]').addEventListener('input', () => {
      const start = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => window.__inputFeedback.push(performance.now() - start)));
    });
  });
  await input.pressSequentially('local input feedback', { delay: 40 });
  await page.waitForFunction(() => window.__inputFeedback.length === 20);
  assert.equal(await input.inputValue(), 'local input feedback');
  return page.evaluate(() => window.__inputFeedback);
}
async function scroll(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const pane = document.querySelector('.chat-scroll');
    if (!pane) return reject(new Error('Missing chat scroll pane'));
    const start = performance.now(); const intervals = []; let last = start; let frames = 0;
    const step = (time) => {
      intervals.push(time - last); last = time;
      pane.scrollTop = Math.max(0, pane.scrollTop - 600);
      if (++frames < 60) requestAnimationFrame(step);
      else requestAnimationFrame(() => requestAnimationFrame(() => resolve({ start, end: performance.now(), intervals, scrollTop: pane.scrollTop, scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight })));
    };
    requestAnimationFrame(step);
  }));
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  result.browserVersion = browser.version();
  // Interleave sizes to reduce systematic ordering effects. Each context has fresh storage/cache.
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const sample = { scenario: scenario.name, sampleIndex, pageErrors: [], blockedRequests: [] };
    result.samples.push(sample);
    try {
      page.on('pageerror', (error) => sample.pageErrors.push(error.message));
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith(`${server.origin}/`) || /^(data|blob):/.test(url)) return route.continue();
        sample.blockedRequests.push(url); return route.abort();
      });
      await page.addInitScript(installPerformanceFixture, scenario);
      await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
      sample.firstEditableMs = await ready(page);
      sample.welcomeDom = await dom(page);
      const cdp = await context.newCDPSession(page);
      sample.heapWelcome = await cdp.send('Runtime.getHeapUsage');
      sample.openLong = await openSession(page, '性能会话 0000');
      sample.initialDom = await dom(page);
      sample.heapLong = await cdp.send('Runtime.getHeapUsage');
      sample.inputFeedbackMs = await inputFeedback(page);
      sample.scroll = await scroll(page);
      sample.afterScrollDom = await dom(page);
      sample.heapAfterScroll = await cdp.send('Runtime.getHeapUsage');
      sample.switchShort = await openSession(page, '性能会话 0001');
      sample.cachedRevisit = await openSession(page, '性能会话 0000');
      sample.revisitDom = await dom(page);
      sample.fixture = await page.evaluate(() => window.__performanceQa);
      assert.equal(sample.fixture.submitCalls, 0);
      assert.equal(sample.cachedRevisit.pageCalls, 0, 'revisit must exercise transcript cache');
      assert.deepEqual(sample.pageErrors, []);
      assert.deepEqual(sample.blockedRequests, []);
      console.log(JSON.stringify({ scenario: sample.scenario, sampleIndex, editableMs: sample.firstEditableMs, openMs: sample.openLong.ms, switchMs: sample.switchShort.ms, revisitMs: sample.cachedRevisit.ms, initialDom: sample.initialDom, afterScrollDom: sample.afterScrollDom }));
    } catch (error) { sample.error = error.stack; throw error; }
    finally { await context.close(); await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); }
  }
  for (const scenario of scenarios) {
    const samples = result.samples.filter((sample) => sample.scenario === scenario.name);
    const summary = {};
    const fields = { firstEditableMs: (s) => s.firstEditableMs, openLongMs: (s) => s.openLong.ms, switchShortMs: (s) => s.switchShort.ms, cachedRevisitMs: (s) => s.cachedRevisit.ms, initialElements: (s) => s.initialDom.totalElements, initialTranscriptElements: (s) => s.initialDom.transcriptElements, initialMountedTurns: (s) => s.initialDom.mountedUserTurns, afterScrollElements: (s) => s.afterScrollDom.totalElements, afterScrollMountedTurns: (s) => s.afterScrollDom.mountedUserTurns, heapLongBytes: (s) => s.heapLong.usedSize, inputP95Ms: (s) => percentile(s.inputFeedbackMs, .95), scrollFrameP95Ms: (s) => percentile(s.scroll.intervals.slice(1), .95), scrollFramesOver33Ms: (s) => s.scroll.intervals.slice(1).filter((value) => value > 33.4).length, longTaskTotalMs: (s) => s.fixture.longTasks.reduce((sum, entry) => sum + entry.duration, 0), longTaskMaxMs: (s) => Math.max(0, ...s.fixture.longTasks.map((entry) => entry.duration)), openLongTaskTotalMs: (s) => s.fixture.longTasks.filter((entry) => entry.startTime >= s.openLong.start && entry.startTime < s.openLong.end).reduce((sum, entry) => sum + entry.duration, 0), fixtureInitializationMs: (s) => s.fixture.fixtureMs };
    fields.initialSidebarElements = (sample) => sample.initialDom.sidebarElements;
    fields.initialMountedSessionRows = (sample) => sample.initialDom.sessionRows;
    fields.sidebarVisibleRows = (sample) => sample.initialDom.sidebarVisibleRows;
    fields.sidebarViewportHeight = (sample) => sample.initialDom.sidebarViewportHeight;
    for (const [key, read] of Object.entries(fields)) summary[key] = stats(samples.map(read));
    result.summaries[scenario.name] = summary;
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, summaries: result.summaries }, null, 2));
} finally { await browser?.close(); await server.close(); }

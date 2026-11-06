/**
 * Real unpackaged Electron process-tree smoke, with an isolated real-IPC empty
 * main window and a separate synthetic renderer stress window. Run after build.
 * Short fixed-cycle observations are evidence, not a long-term leak guarantee.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { installMemorySmokeFixture } from './fixtures/memory-smoke.mjs';

if (process.platform !== 'darwin') throw new Error('This process RSS smoke currently requires macOS ps.');
const root = fileURLToPath(new URL('../..', import.meta.url));
const rendererFile = path.join(root, 'web-dist/index.html');
const html = await readFile(rendererFile, 'utf8');
const output = path.join(root, '.qa/memory-smoke'); await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-memory-smoke-'));
const workspace = path.join(profile, 'empty-workspace'); await mkdir(workspace);
const environment = { ...process.env, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite'), PI_WORKSPACE: workspace };
delete environment.ELECTRON_RUN_AS_NODE; delete environment.PI_STUDIO_DEV;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const rounds = 6;
const viewport = { width: 1440, height: 900 };
const result = {
  startedAt: new Date().toISOString(),
  scope: { process: 'real unpackaged Electron tree', mainWindow: 'real preload/IPC with disposable empty SQLite/profile/workspace', stressWindow: 'production renderer with synthetic piApi; no preload/real IPC/model workload', gc: 'CDP forced GC at each renderer sample', limitations: ['Six fixed rounds and three post-close samples cannot establish long-term bounded memory.', 'RSS includes main, GPU, utility, and both renderer processes; OS allocator and shared pages affect comparisons.', 'CDP JS listener/node counts are runtime totals; fixture subscriber counts separately describe only synthetic piApi registrations.', 'Heap samples follow forced GC and do not measure transient allocation peaks.'] },
  machine: { platform: process.platform, arch: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, totalMemoryMiB: os.totalmem() / 1048576, node: process.version },
  assets: html.match(/assets\/[^"']+\.(?:js|css)/g), viewport, rounds,
  samples: [], checks: [], rendererErrors: [], blockedRequests: [], cleanup: {},
};
let electronApp; let electronPid; let stressPage; let processHandle;
const tracked = new Map();
function processRows() {
  const map = new Map();
  for (const line of execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (match) map.set(Number(match[1]), { ppid: Number(match[2]), rssKiB: Number(match[3]), command: match[4] });
  }
  return map;
}
function processTree() {
  const rows = processRows(); const pids = new Set(rows.has(electronPid) ? [electronPid] : []);
  let changed = true;
  while (changed) { changed = false; for (const [pid, row] of rows) if (!pids.has(pid) && pids.has(row.ppid)) { pids.add(pid); changed = true; } }
  return [...pids].map(pid => {
    const row = rows.get(pid); tracked.set(pid, row.command);
    return { pid, parent: row.ppid, rssMiB: row.rssKiB / 1024, kind: pid === electronPid ? 'main' : /--type=renderer/.test(row.command) ? 'renderer' : /--type=gpu-process/.test(row.command) ? 'gpu' : /--type=utility/.test(row.command) ? 'utility' : 'other' };
  });
}
async function rendererMetrics(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Performance.enable'); await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const values = Object.fromEntries(metrics.map(item => [item.name, item.value]));
    const dom = await cdp.send('Memory.getDOMCounters');
    const visible = await page.evaluate(() => ({
      liveElements: document.querySelectorAll('*').length,
      messageElements: document.querySelectorAll('.message').length,
      userTurns: document.querySelectorAll('.message.user').length,
      assistantTurns: document.querySelectorAll('.assistant-turn').length,
      images: document.querySelectorAll('.chat-scroll img').length,
      decodedImages: [...document.querySelectorAll('.chat-scroll img')].filter(image => image.complete && image.naturalWidth > 0).length,
      fixture: window.__memorySmoke?.() ?? null,
    }));
    return { heapUsedMiB: (values.JSHeapUsedSize || 0) / 1048576, heapTotalMiB: (values.JSHeapTotalSize || 0) / 1048576, documents: dom.documents, nodes: dom.nodes, jsEventListeners: dom.jsEventListeners, ...visible };
  } finally { await cdp.detach().catch(() => {}); }
}
async function sample(label, page, round) {
  const renderer = page ? await rendererMetrics(page) : undefined;
  const processes = processTree();
  const mainListeners = await electronApp.evaluate(({ app, ipcMain, webContents }) => ({
    app: app.eventNames().reduce((sum, name) => sum + app.listenerCount(name), 0),
    ipcMainEmitter: ipcMain.eventNames().reduce((sum, name) => sum + ipcMain.listenerCount(name), 0),
    webContents: webContents.getAllWebContents().length,
  }));
  const row = { label, round, elapsedSeconds: (Date.now() - Date.parse(result.startedAt)) / 1000, totalRssMiB: processes.reduce((sum, row) => sum + row.rssMiB, 0), processes, mainListeners, renderer };
  result.samples.push(row);
  console.log(`${label}: RSS ${row.totalRssMiB.toFixed(1)} MiB, processes ${processes.length}${renderer ? `, heap ${renderer.heapUsedMiB.toFixed(1)} MiB, DOM ${renderer.liveElements}, listeners ${renderer.jsEventListeners}` : ''}`);
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  return row;
}
async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function openConversation(page, title) {
  await page.locator('.session-row').filter({ hasText: title }).click();
  await page.locator('.chat-heading h1').filter({ hasText: title }).waitFor();
  await page.locator('.chat-scroll .assistant-turn').first().waitFor();
  await settle(page);
}
async function openStressWindow() {
  const next = electronApp.waitForEvent('window');
  result.stressWebContentsId = await electronApp.evaluate(({ BrowserWindow }, viewport) => {
    const win = new BrowserWindow({ show: false, ...viewport, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'memory-smoke-synthetic' } });
    void win.loadURL('about:blank');
    return win.webContents.id;
  }, viewport);
  const page = await next; page.setDefaultTimeout(15_000);
  page.on('pageerror', error => result.rendererErrors.push(error.message));
  page.on('crash', () => result.rendererErrors.push('Stress renderer crashed'));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (/^(file|data|blob|about):/.test(url)) return route.continue();
    result.blockedRequests.push(new URL(url).origin); return route.abort();
  });
  await page.addInitScript(installMemorySmokeFixture);
  await page.goto(pathToFileURL(rendererFile).href); await page.locator('.brand').waitFor();
  const rows = page.locator('.session-row');
  if (!await rows.count()) await page.locator('.workspace-row').filter({ hasText: 'memory-regression' }).click();
  return page;
}
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { raw: values, min: sorted[0], max: sorted.at(-1), p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], lastMinusFirst: values.at(-1) - values[0] };
}
async function cleanupRemaining() {
  const live = processRows();
  const remaining = [...tracked].filter(([pid, command]) => live.get(pid)?.command === command).map(([pid]) => pid);
  result.cleanup.remainingBeforeFallback = remaining;
  if (remaining.length) {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      for (const pid of remaining.toReversed()) {
        if (processRows().get(pid)?.command !== tracked.get(pid)) continue;
        try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await sleep(500);
    }
  }
  result.cleanup.remainingAfterFallback = [...tracked].filter(([pid, command]) => processRows().get(pid)?.command === command).map(([pid]) => pid);
}
try {
  electronApp = await _electron.launch({ args: [root, `--user-data-dir=${profile}`, '--js-flags=--expose-gc', '--disable-background-networking', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'], cwd: workspace, env: environment });
  processHandle = electronApp.process(); electronPid = processHandle.pid; processTree();
  const main = await electronApp.firstWindow(); main.setDefaultTimeout(15000); main.on('pageerror', error => result.rendererErrors.push(`Main window: ${error.message}`)); await main.locator('.brand').waitFor();
  result.electron = await electronApp.evaluate(({ app }) => ({ electron: process.versions.electron, chrome: process.versions.chrome, packaged: app.isPackaged }));
  const ipcState = await main.evaluate(async () => { const state = await window.piApi.state(); return { workspaces: state.workspaces.length, sessions: state.workspaces.reduce((sum, row) => sum + row.sessions.length, 0) }; });
  assert.equal(ipcState.sessions, 0); result.realIpcEmptyState = ipcState;
  await sleep(2000); await sample('empty-main-initial', main);
  await sleep(3000); await sample('empty-main-idle', main);
  stressPage = await openStressWindow(); await openConversation(stressPage, 'Memory long transcript');
  const initial = await sample('synthetic-long-initial', stressPage);
  assert.ok(initial.renderer.userTurns > 0 && initial.renderer.userTurns <= 48, 'initial long transcript uses a bounded mounted turn window');
  assert.ok(initial.renderer.fixture.fixtureMessages['memory-long'] >= 420, 'fixture still contains full long history');
  result.checks.push('Real preload IPC confirms empty isolated storage; synthetic 420+ message history mounts only the current turn window.');
  // One deliberate history expansion exercises the observer, followed by a session switch reset.
  await stressPage.locator('.chat-scroll').evaluate(node => { node.scrollTop = 0; }); await sleep(400); await sample('synthetic-history-expanded', stressPage);
  const image = stressPage.locator('.chat-scroll img').first();
  await image.scrollIntoViewIfNeeded();
  await stressPage.waitForFunction(() => [...document.querySelectorAll('.chat-scroll img')].some(image => image.complete && image.naturalWidth > 0));
  const decoded = await sample('synthetic-image-decoded', stressPage);
  assert.ok(decoded.renderer.decodedImages > 0, 'image decode, not merely image markup, is exercised');
  await stressPage.locator('.chat-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
  const agents = stressPage.getByRole('tab').filter({ hasText: '子智能体' });
  for (let round = 1; round <= rounds; round++) {
    await openConversation(stressPage, 'Memory medium A');
    await agents.click(); await stressPage.getByRole('button', { name: '列表视图', exact: true }).click();
    await stressPage.locator('.agent-list-main').first().click(); await stressPage.locator('.agent-context-view .agent-transcript .assistant-turn').last().waitFor();
    if (round === 1) await sample('synthetic-child-transcript', stressPage);
    await stressPage.getByRole('button', { name: '返回主智能体', exact: true }).click();
    await openConversation(stressPage, 'Memory medium B');
    await openConversation(stressPage, 'Memory long transcript');
    await agents.click(); await stressPage.getByRole('button', { name: '列表视图', exact: true }).click();
    assert.equal(await stressPage.locator('.agent-list-row').count(), 8);
    await stressPage.locator('.agent-list-main').first().click(); await stressPage.locator('.agent-context-view .agent-transcript .assistant-turn').last().waitFor();
    await stressPage.getByRole('button', { name: '返回主智能体', exact: true }).click();
    await settle(stressPage); await sleep(200);
    const current = await sample(`synthetic-cycle-${round}`, stressPage, round);
    assert.equal(current.renderer.fixture.listeners.onConversationEvent, 1, 'one synthetic conversation listener after settle');
    assert.equal(current.renderer.fixture.subscriptions.length, 1, 'one synthetic conversation subscription after settle');
    assert.equal(current.renderer.fixture.calls.submits, 0, 'no model submissions');
  }
  const cycles = result.samples.filter(row => row.round);
  result.cycleSummary = { rssMiB: summary(cycles.map(row => row.totalRssMiB)), heapUsedMiB: summary(cycles.map(row => row.renderer.heapUsedMiB)), nodes: summary(cycles.map(row => row.renderer.nodes)), jsEventListeners: summary(cycles.map(row => row.renderer.jsEventListeners)), liveElements: summary(cycles.map(row => row.renderer.liveElements)) };
  result.checks.push('Six fixed cycles cover three conversation histories, parent/subagent tabs, child transcripts, image-bearing history, and subscriber cleanup.');
  const stressPid = await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)?.getOSProcessId(), result.stressWebContentsId);
  await stressPage.close(); stressPage = undefined;
  for (let index = 1; index <= 3; index++) { await sleep(2000); await sample(`after-stress-window-close-${index}`, main); }
  result.stressProcessId = stressPid;
  const stopped = result.samples.at(-1).processes.length < cycles.at(-1).processes.length;
  assert.ok(stopped, 'closing stress window releases its renderer process');
  result.checks.push('Three post-close samples record reclamation; stress renderer process count decreases. No fixed-MiB release claim.');
  assert.deepEqual(result.rendererErrors, []);
  const exited = once(processHandle, 'exit').then(([code, signal]) => ({ code, signal }));
  await electronApp.evaluate(({ app }) => { setImmediate(() => app.quit()); });
  const exit = await Promise.race([exited, sleep(15000).then(() => null)]);
  await sleep(1000);
  const live = processRows(); const remaining = [...tracked].filter(([pid, command]) => live.get(pid)?.command === command).map(([pid]) => pid);
  result.exit = { natural: Boolean(exit), ...exit, remainingTrackedPids: remaining };
  assert.ok(exit, 'main exits naturally within 15 seconds'); assert.deepEqual(remaining, [], 'all tracked Electron processes exit naturally');
  result.checks.push('Application quit finishes naturally and all tracked process IDs exit without cleanup signals.');
  result.passed = true; await rm(path.join(output, 'failure.png'), { force: true });
  console.log('Memory smoke passed: fixed-cycle observations and clean teardown recorded; no long-term bound asserted.');
} catch (error) {
  result.passed = false; result.failure = String(error.stack || error);
  if (stressPage && !stressPage.isClosed()) await stressPage.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (processHandle?.exitCode === null && electronApp) {
    await Promise.race([electronApp.evaluate(({ app }) => { app.quit(); }).catch(() => {}), sleep(2000)]);
    await Promise.race([electronApp.close().catch(() => {}), sleep(5000)]);
  }
  await cleanupRemaining();
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  result.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
}

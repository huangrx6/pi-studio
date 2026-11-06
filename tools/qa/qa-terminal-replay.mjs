/** Real isolated PTY diagnostic. Does not replace IPC results or alter production source. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { _electron } from 'playwright-core';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = path.join(root, '.qa/terminal-replay-diagnostic');
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-terminal-replay-'));
const workspace = path.join(profile, 'workspace');
await mkdir(workspace); await mkdir(output, { recursive: true });
const env = { ...process.env, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite'), ZDOTDIR: profile, SHELL: '/bin/zsh', PI_WORKSPACE: workspace };
delete env.ELECTRON_RUN_AS_NODE; delete env.PI_STUDIO_DEV;
const result = { startedAt: new Date().toISOString(), scope: 'Real isolated Electron IPC and PTY; transparent diagnostic handler wrappers; default zsh prompt; no network/model calls. xterm parsing controls are not replacement production rendering.', assets: (await readFile(path.join(root, 'web-dist/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g), machine: { platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model }, stages: [], errors: [] };
let app, page;
const marker = 'QA_REPLAY_READY';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  app = await _electron.launch({ args: [root, '--disable-background-networking', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'], cwd: workspace, env });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => result.errors.push(e.message));
  await page.locator('.brand').waitFor();
  await app.evaluate(({ ipcMain, dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    globalThis.__terminalDiagnostic = [];
    // Electron private handler map is used only for diagnostics; every call delegates unchanged.
    for (const channel of ['pi:terminal-create', 'pi:terminal-resize', 'pi:terminal-write', 'pi:terminal-close']) {
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error(`Missing diagnostic target ${channel}`);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, payload) => {
        const record = { channel, payload, start: Date.now() }; globalThis.__terminalDiagnostic.push(record);
        const value = await original(event, payload); record.end = Date.now(); record.result = value; return value;
      });
    }
  }, workspace);
  await page.evaluate(() => { window.__terminalEvents = []; window.__stopTerminalDiagnostic = window.piApi.onTerminalEvent(event => window.__terminalEvents.push({ ...event, at: Date.now() })); });
  await page.getByRole('button', { name: '打开工作区', exact: true }).click();
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  await page.locator('.panel-start-tools').waitFor();
  await page.waitForFunction(() => (document.querySelector('.file-panel')?.getBoundingClientRect().width || 0) > 300);
  await page.waitForTimeout(350);
  const handle = await page.locator('.panel-resize-handle').boundingBox();
  const bounds = await page.locator('.file-panel').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 320, handle.y + 100, { steps: 8 }); await page.mouse.up();
  await page.locator('.panel-tool').filter({ hasText: '终端' }).click();
  await page.locator('.xterm-helper-textarea').waitFor();
  await page.waitForTimeout(400);
  // A finite background process reproduces asynchronous shell output without any listener or leftover child.
  const code = 'setTimeout(()=>console.log("QA_REPLAY_PORT=12345\\nQA_REPLAY_PID="+process.pid+"\\nQA_REPLAY_READY"),60);setTimeout(()=>{},20000)';
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`${quote(process.execPath)} -e ${quote(code)} &`); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /QA_REPLAY_PORT=12345\s*QA_REPLAY_PID=\d+\s*QA_REPLAY_READY/.test(document.querySelector('.xterm-rows')?.textContent || ''));
  const capture = async name => {
    await page.waitForTimeout(350);
    const state = await page.evaluate(() => ({ at: Date.now(), text: document.querySelector('.xterm-rows')?.textContent, lines: [...document.querySelectorAll('.xterm-rows > div')].map(row => row.textContent), viewport: { width: innerWidth, height: innerHeight }, terminal: document.querySelector('.terminal-host')?.getBoundingClientRect().toJSON(), eventCount: window.__terminalEvents.length }));
    result.stages.push({ name, ...state }); await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  };
  await capture('01-live');
  await page.getByRole('button', { name: '打开工具', exact: true }).click(); await page.getByRole('menuitem', { name: '运行服务', exact: true }).click();
  await page.getByRole('tab').filter({ hasText: '终端' }).click(); await page.locator('.xterm').waitFor();
  await capture('02-same-size-remount');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 760));
  await capture('03-live-resize');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 860));
  await capture('04-live-resize-back');
  await page.getByRole('tab').filter({ hasText: '服务' }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 760));
  await page.waitForTimeout(350);
  await page.getByRole('tab').filter({ hasText: '终端' }).click(); await page.locator('.xterm').waitFor();
  await capture('05-smaller-remount');
  await page.getByRole('button', { name: '重新连接终端', exact: true }).click(); await page.waitForTimeout(350);
  await capture('06-reconnect');
  // Eliminate the asynchronous writer before checking genuine column changes.
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type("kill %1 2>/dev/null; wait %1 2>/dev/null; printf '%s\\n' QA_STABLE_HISTORY"); await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent.trim() === 'QA_STABLE_HISTORY'));
  await capture('07-foreground-history');
  const widerHandle = await page.locator('.panel-resize-handle').boundingBox();
  const narrowerBounds = await page.locator('.file-panel').boundingBox();
  await page.mouse.move(widerHandle.x + widerHandle.width / 2, widerHandle.y + 100); await page.mouse.down();
  await page.mouse.move(narrowerBounds.x + narrowerBounds.width - 480, widerHandle.y + 100, { steps: 8 }); await page.mouse.up();
  await capture('08-live-wider-columns');
  await page.getByRole('tab').filter({ hasText: '服务' }).click();
  await page.getByRole('tab').filter({ hasText: '终端' }).click(); await page.locator('.xterm').waitFor();
  await capture('09-wider-remount');
  for (const name of ['10-first-reconnect', '11-second-reconnect']) {
    const oldTerminal = await page.locator('.terminal-host .xterm').elementHandle();
    await page.getByRole('button', { name: '重新连接终端', exact: true }).click();
    await page.waitForFunction(node => !node.isConnected, oldTerminal);
    await page.locator('.terminal-host .xterm').waitFor();
    await capture(name);
  }
  const shrinkHandle = await page.locator('.panel-resize-handle').boundingBox();
  const wideBounds = await page.locator('.file-panel').boundingBox();
  await page.mouse.move(shrinkHandle.x + shrinkHandle.width / 2, shrinkHandle.y + 100); await page.mouse.down();
  await page.mouse.move(wideBounds.x + wideBounds.width - 320, shrinkHandle.y + 100, { steps: 8 }); await page.mouse.up();
  await capture('12-original-columns');
  await page.getByRole('tab').filter({ hasText: '服务' }).click();
  await page.getByRole('tab').filter({ hasText: '终端' }).click(); await page.locator('.xterm').waitFor();
  await capture('13-original-columns-remount');
  result.calls = await app.evaluate(() => globalThis.__terminalDiagnostic);
  result.events = await page.evaluate(() => window.__terminalEvents);
  // DevTools evaluation supplies the same local library for read-only parsing controls; no CSP change.
  await page.evaluate(await readFile(path.join(root, 'node_modules/@xterm/xterm/lib/xterm.js'), 'utf8'));
  result.controls = await page.evaluate(async ({ calls, events, marker }) => {
    const creates = calls.filter(call => call.channel === 'pi:terminal-create');
    const initial = creates[0].payload;
    const snapshots = creates.filter(call => call.result?.replay?.steps?.length);
    const lines = terminal => Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) || '');
    const replay = async (raw, cols, rows) => {
      const terminal = new window.Terminal({ cols, rows, scrollback: 8000 });
      await new Promise(resolve => terminal.write(raw, resolve));
      const value = lines(terminal); terminal.dispose(); return { cols, rows, markerPresent: value.some(line => line.trim() === marker), stableMarkerPresent: value.some(line => line.trim() === 'QA_STABLE_HISTORY'), lines: value };
    };
    const parseJournal = async journal => {
      const terminal = new window.Terminal({ cols: journal.cols, rows: journal.rows, scrollback: 8000 });
      for (const step of journal.steps) {
        if (step.type === 'data') await new Promise(resolve => terminal.write(step.data, resolve));
        else if (step.type === 'resize') terminal.resize(step.cols, step.rows);
        else throw new Error(`Unexpected replay step ${step.type}`);
      }
      const value = lines(terminal); const geometry = { cols: terminal.cols, rows: terminal.rows }; terminal.dispose();
      return { ...geometry, markerPresent: value.some(line => line.trim() === marker), stableMarkerPresent: value.some(line => line.trim() === 'QA_STABLE_HISTORY'), lines: value };
    };
    const comparisons = [];
    for (const snapshot of snapshots) {
      const journal = snapshot.result.replay;
      const raw = journal.steps.filter(step => step.type === 'data').map(step => step.data).join('');
      const received = events.filter(event => event.type === 'data' && event.sequence <= snapshot.result.sequence).map(event => event.data).join('');
      comparisons.push({ sequence: snapshot.result.sequence, requested: snapshot.payload, truncated: journal.truncated, journalStepCount: journal.steps.length, journal: await parseJournal(journal), rawMarkerPresent: raw.includes(marker), equalsCollectedEvents: raw === received, oldGeometry: await replay(raw, initial.cols, initial.rows), newGeometry: await replay(raw, snapshot.payload.cols, snapshot.payload.rows), alternateColumns: await replay(raw, initial.cols + 14, snapshot.payload.rows) });
    }
    const continuous = new window.Terminal({ cols: initial.cols, rows: initial.rows, scrollback: 8000 });
    const timeline = [...events.filter(e => e.type === 'data').map(e => ({ at: e.at, type: 'data', data: e.data })), ...calls.filter(c => c.channel === 'pi:terminal-resize' || c.channel === 'pi:terminal-create').slice(1).map(c => ({ at: c.start, type: 'resize', cols: c.payload.cols, rows: c.payload.rows }))].sort((a,b) => a.at-b.at);
    for (const item of timeline) { if (item.type === 'data') await new Promise(resolve => continuous.write(item.data, resolve)); else continuous.resize(item.cols, item.rows); }
    const continuousLines = lines(continuous); continuous.dispose();
    return { initial, comparisons, continuous: { markerPresent: continuousLines.some(line => line.trim() === marker), stableMarkerPresent: continuousLines.some(line => line.trim() === 'QA_STABLE_HISTORY'), lines: continuousLines }, note: 'Timeline timestamps are millisecond-resolution; continuous control supplements rather than replaces live evidence.' };
  }, { calls: result.calls, events: result.events, marker });
  result.observations = result.stages.map(stage => ({ name: stage.name, markerVisible: stage.lines.some(line => line.trim() === marker), stableMarkerVisible: stage.lines.some(line => line.trim() === 'QA_STABLE_HISTORY'), terminalWidth: stage.terminal?.width, terminalHeight: stage.terminal?.height }));
  assert.deepEqual(result.errors, []);
  assert.ok(result.controls.comparisons.length >= 4, 'Require all retained-output remount snapshots');
  assert.ok(result.controls.comparisons.every(item => item.truncated === false), 'This small diagnostic must fit in the replay budget');
  assert.ok(result.controls.comparisons.every(item => item.equalsCollectedEvents), 'Every main snapshot must equal collected real PTY data through its sequence');
  assert.ok(result.observations[0].markerVisible, 'Require the actual standalone output marker, not its command echo');
  assert.equal(result.observations[1].markerVisible, result.observations[0].markerVisible, 'Unchanged geometry remount preserves the actual output marker');
  const liveResize = result.observations.find(stage => stage.name === '03-live-resize');
  const final = result.observations.at(-1);
  assert.equal(final.markerVisible, result.controls.continuous.markerPresent, 'Final live viewport agrees with the continuously parsed PTY control');
  result.classification = {
    mainBufferLoss: false,
    sameSizeRemountLoss: false,
    continuousLiveResizeOverwroteMarker: !liveResize.markerVisible,
    backgroundMarkerReplayMatchesContinuous: final.markerVisible === result.controls.continuous.markerPresent,
    resizeControlEvents: result.events.filter(event => event.type === 'data' && event.data.includes('\x1b[A') && event.data.includes('\x1b[J')),
    rowsOnlyInterpretation: !liveResize.markerVisible ? 'The same mounted terminal loses the standalone marker on rows-only resize. Real zsh output contains cursor-up plus erase-down plus prompt redraw; main raw bytes are intact. This reproduction is shell redraw, not an application remount data-loss finding.' : 'This run did not reproduce live resize overwrite; inspect raw events and stage evidence before assigning a cause.',
  };
  const foregroundStages = result.observations.filter(stage => /^(07|08|09|10|11|12|13)-/.test(stage.name));
  const widerSnapshot = result.controls.comparisons.findLast(snapshot => snapshot.requested.cols > result.controls.initial.cols);
  result.columnChange = { stages: foregroundStages, lastSnapshotGeometry: result.controls.comparisons.at(-1)?.requested, continuousStableMarker: result.controls.continuous.stableMarkerPresent, replayStableMarker: result.controls.comparisons.at(-1)?.journal.stableMarkerPresent, rawAtNewWidthStableMarker: widerSnapshot?.newGeometry.stableMarkerPresent, widerJournalStableMarker: widerSnapshot?.journal.stableMarkerPresent, visibleLinesEqual: JSON.stringify(result.stages.find(stage => stage.name === '08-live-wider-columns').lines.filter(line => line.trim())) === JSON.stringify(result.stages.find(stage => stage.name === '09-wider-remount').lines.filter(line => line.trim())), note: 'A stable foreground marker checks retained output; full line comparison separately detects raw ANSI reconstruction differences in command echo/prompt history.' };
  result.acceptance = ['Compare standalone marker lines, never command-echo substrings.', 'At unchanged geometry, remount must match the live terminal output.', 'Every main snapshot equals the collected real PTY stream through its sequence.', 'A resize followed by replay must be assessed against the same data in a continuously maintained terminal; shell-emitted erase sequences are not missing main-buffer data.', 'Different-column raw replay controls are supplemental and do not by themselves prove a product regression.'];
  result.diagnosticCompleted = true;
  result.regressionPassed = foregroundStages.every(stage => stage.stableMarkerVisible) && result.controls.comparisons.at(-1)?.journal.stableMarkerPresent === true;
  assert.ok(result.regressionPassed, 'Stable foreground output survives column resize, remount, two reconnects and return to original columns');
  assert.equal(result.controls.comparisons.at(-1)?.requested.cols, result.controls.initial.cols, 'Final remount must return to the actual initial column count');
  await rm(path.join(output, 'failure.png'), { force: true });
  console.log(JSON.stringify({ observations: result.observations, comparisons: result.controls.comparisons.map(c => ({ sequence: c.sequence, requested: c.requested, rawMarkerPresent: c.rawMarkerPresent, equalsCollectedEvents: c.equalsCollectedEvents, oldGeometryMarker: c.oldGeometry.markerPresent, newGeometryMarker: c.newGeometry.markerPresent, journalStableMarker: c.journal.stableMarkerPresent })), continuousMarker: result.controls.continuous.markerPresent }));
} catch (error) {
  result.failure = String(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) {
    const process = app.process(); const exit = once(process, 'exit').then(([code, signal]) => ({ code, signal }));
    await app.close(); result.exit = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const ownPids = [...new Set((result.events || []).filter(event => event.type === 'data').flatMap(event => [...event.data.matchAll(/QA_REPLAY_PID=(\d+)\r?\n/g)].map(match => Number(match[1]))))];
  result.cleanup = { ownPids, remainingOwnPids: [] };
  for (const pid of ownPids) {
    try { process.kill(pid, 0); result.cleanup.remainingOwnPids.push(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  result.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  assert.equal(result.exit?.code, 0, 'Electron must exit naturally');
  assert.deepEqual(result.cleanup.remainingOwnPids, [], 'Owned finite background child must not survive app shutdown');
}

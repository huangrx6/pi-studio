/**
 * Real Electron check for the terminal and runtime-service workbench tabs.
 * The terminal starts a local HTTP listener; the service panel must attribute
 * it to the Studio process tree and closing the terminal tab must stop it.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = path.join(root, '.qa', 'runtime-panel');
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-runtime-panel-'));
const workspace = path.join(profile, 'workspace');
// Optional diagnostic reproduces ANSI replay across columns with zsh's default long prompt.
const defaultPromptDiagnostic = process.env.QA_TERMINAL_DEFAULT_PROMPT === '1';
await mkdir(workspace);
// Keep zsh's default prompt; stable foreground history is the retention contract.
for (const label of ['QA_FIRST', 'QA_SECOND']) {
  await writeFile(path.join(workspace, `${label}.cjs`), `const server=require('http').createServer((q,s)=>s.end('${label}'));server.listen(0,'127.0.0.1',()=>console.log('${label}_PORT='+server.address().port+'\\n${label}_PID='+process.pid+'\\n${label}_READY'));`);
}
await mkdir(output, { recursive: true });

const environment = {
  ...process.env,
  PI_STUDIO_USER_DATA: profile,
  PI_STUDIO_DB: path.join(profile, 'studio.sqlite'),
  ZDOTDIR: profile,
  SHELL: '/bin/zsh',
  PI_WORKSPACE: workspace,
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.PI_STUDIO_DEV;

async function waitForProcessGone(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`process ${pid} is still running`);
}

const result = {
  startedAt: new Date().toISOString(),
  scope: 'Real isolated Electron preload/IPC + zsh PTY; disposable loopback servers, no model calls',
  machine: { platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model, node: process.version },
  assets: (await readFile(path.join(root, 'web-dist/index.html'), 'utf8')).match(/assets\/[^"']+\.(?:js|css)/g),
  fixture: { isolatedUserData: true, isolatedWorkspace: true, isolatedZshConfig: true, prompt: 'zsh default', dynamicLoopbackPorts: true },
  limitations: ['Development Electron shell with production renderer assets, not an installed package or a long-duration memory test.', 'Default zsh may explicitly erase background output during prompt redraw; retention assertions use earlier stable foreground history. Separate terminal-replay-diagnostic covers true column-change ANSI replay, which is not certified by this runtime workflow.'],
  checks: [], errors: [], servers: [], cleanup: {},
};
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function terminalServerCommand(label) {
  if (defaultPromptDiagnostic) {
    const code = `const server=require("http").createServer((q,s)=>s.end("${label}"));server.listen(0,"127.0.0.1",()=>console.log("${label}_PORT="+server.address().port+"\\n${label}_PID="+process.pid+"\\n${label}_READY"))`;
    return `${shellQuote(process.execPath)} -e ${shellQuote(code)} &`;
  }
  return `${shellQuote(process.execPath)} ${shellQuote(path.join(workspace, `${label}.cjs`))} &`;
}
function ownedTerminalServer(pid) {
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return ['QA_FIRST', 'QA_SECOND'].some(label => command.includes(path.join(workspace, `${label}.cjs`))) || (defaultPromptDiagnostic && /QA_(FIRST|SECOND)_PORT/.test(command));
  } catch { return false; }
}
let page;
let electronApp;
let serverPid;
let firstServerPid;
let localServer;
try {
  electronApp = await _electron.launch({ args: [root, '--disable-background-networking', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'], cwd: workspace, env: environment });
  result.electron = await electronApp.evaluate(({ app }) => ({ version: process.versions.electron, chromium: process.versions.chrome, packaged: app.isPackaged }));
  page = await electronApp.firstWindow();
  page.setDefaultTimeout(30_000);
  const errors = result.errors;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.brand').waitFor();
  result.initialViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }));
  await electronApp.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, workspace);
  await page.getByRole('button', { name: '打开工作区', exact: true }).click();
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  await page.locator('.panel-start-tools').waitFor();
  await page.waitForFunction(() => (document.querySelector('.file-panel')?.getBoundingClientRect().width || 0) > 300);
  const toolAlignment = await page.locator('.panel-tool').evaluateAll((buttons) => buttons.map((button) => {
    const icon = button.querySelector('.panel-tool-icon')?.getBoundingClientRect();
    const label = button.querySelector('.panel-tool-label')?.getBoundingClientRect();
    return {
      iconCenter: icon ? icon.top + icon.height / 2 : Number.NaN,
      labelCenter: label ? label.top + label.height / 2 : Number.NaN,
    };
  }));
  assert.ok(toolAlignment.every((item) => Math.abs(item.iconCenter - item.labelCenter) <= 1));
  assert.equal(await page.locator('.panel-tool').evaluateAll((buttons) => (
    buttons.length === 5
    && buttons.every((button) => Math.abs(button.getBoundingClientRect().width - buttons[0].getBoundingClientRect().width) <= 1)
  )), true);
  result.toolLabels = await page.locator('.panel-tool-label').allTextContents();
  result.checks.push('Five tool entries retain aligned icons and equal-width controls.');
  await page.screenshot({ path: path.join(output, 'start.png'), animations: 'disabled' });
  for (const width of [480, 320]) {
    const handle = await page.locator('.panel-resize-handle').boundingBox();
    const bounds = await page.locator('.file-panel').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - width, handle.y + 100, { steps: 8 });
    await page.mouse.up();
    await page.screenshot({ path: path.join(output, `start-${width}.png`), animations: 'disabled' });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: path.join(output, 'start-320-dark.png'), animations: 'disabled' });

  await page.locator('.panel-tool').filter({ hasText: '终端' }).click();
  await page.locator('.terminal-host .xterm').waitFor();
  await page.locator('.xterm-helper-textarea').focus();
  await page.evaluate(() => document.fonts.load('14px "Studio Terminal Symbols"', '\uf07b\uf15b\ue0b0\udb80\udf7b'));
  await page.waitForTimeout(600);
  await page.keyboard.type("printf '\\uf07b projects  \\uf15b README.md  \\ue0b0 main  \\U000f03b0 package.json\\n'");
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('\uf07b projects'));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root: dom } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: dom.nodeId, selector: '.xterm-rows span' });
  const fontRows = await Promise.all(nodeIds.map((nodeId) => cdp.send('CSS.getPlatformFontsForNode', { nodeId })));
  const fonts = fontRows.flatMap((row) => row.fonts);
  await page.screenshot({ path: path.join(output, 'terminal-symbols.png'), animations: 'disabled' });
  // Chromium must actually paint with the bundled font, not merely register it.
  assert.ok(fonts.some((font) => font.isCustomFont && /Symbols/.test(font.familyName) && font.glyphCount > 0), JSON.stringify(fonts));
  await cdp.detach();
  result.terminalSymbolFonts = fonts.filter(font => font.isCustomFont && /Symbols/.test(font.familyName));
  result.checks.push('Real PTY prints bundled Nerd Font glyphs; Chromium reports actual custom glyph painting.');
  await page.keyboard.type('printf \"QA_%s\\n\" STABLE_HISTORY'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent.trim() === 'QA_STABLE_HISTORY'));
  await page.keyboard.type(terminalServerCommand('QA_FIRST'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /QA_FIRST_PORT=\d+\s*QA_FIRST_PID=\d+\s*QA_FIRST_READY/.test(document.querySelector('.xterm-rows')?.textContent || ''));
  const terminalText = await page.locator('.xterm-rows').textContent();
  firstServerPid = Number(/QA_FIRST_PID=(\d+)/.exec(terminalText)?.[1]);
  const firstPort = Number(/QA_FIRST_PORT=(\d+)/.exec(terminalText)?.[1]);
  assert.ok(firstServerPid && firstPort && ownedTerminalServer(firstServerPid));
  result.servers.push({ label: 'first PTY child', pid: firstServerPid, port: firstPort });
  await page.screenshot({ path: path.join(output, 'terminal.png'), animations: 'disabled' });

  await page.getByRole('button', { name: '打开工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '运行服务', exact: true }).click();
  const serviceRow = page.locator('.runtime-service-row').filter({ has: page.locator('.runtime-service-port', { hasText: new RegExp(`^${firstPort}$`) }) });
  await serviceRow.waitFor();
  assert.match(await serviceRow.locator('.runtime-service-open').getAttribute('title'), /Studio 子进程/);
  assert.match(await serviceRow.innerText(), new RegExp(`PID ${firstServerPid}`));
  assert.equal(await page.locator('.runtime-service-row').filter({ hasText: 'Studio 主进程' }).count(), 0);
  await page.screenshot({ path: path.join(output, 'services.png'), animations: 'disabled' });
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1_100, 760);
  });
  await page.waitForTimeout(350);
  assert.equal(await page.locator('.runtime-services-panel').evaluate((panel) => (
    panel.scrollWidth <= panel.clientWidth + 1
  )), true);
  assert.equal(await serviceRow.evaluate((row) => row.scrollWidth <= row.clientWidth + 1), true);
  await page.screenshot({ path: path.join(output, 'services-compact.png'), animations: 'disabled' });
  await serviceRow.screenshot({ path: path.join(output, 'service-row-dark.png'), animations: 'disabled' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await serviceRow.screenshot({ path: path.join(output, 'service-row-light.png'), animations: 'disabled' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });

  // Switching away unmounts the renderer TerminalPanel, but the main-owned PTY must survive.
  await page.getByRole('tab').filter({ hasText: '终端' }).click();
  await page.locator('.terminal-host .xterm').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent.trim() === 'QA_STABLE_HISTORY'));
  assert.ok(ownedTerminalServer(firstServerPid), 'tab switch must retain the same PTY child');
  const previousXterm = await page.locator('.terminal-host .xterm').elementHandle();
  await page.getByRole('button', { name: '重新连接终端', exact: true }).click();
  await page.waitForFunction(node => !node.isConnected, previousXterm);
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent.trim() === 'QA_STABLE_HISTORY'));
  assert.ok(ownedTerminalServer(firstServerPid), 'reconnect must reuse existing PTY, not spawn a replacement shell');
  assert.match(await page.locator('.terminal-toolbar code').getAttribute('title'), new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('printf "QA_%s\\n" RECONNECTED_OK'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('QA_RECONNECTED_OK'));
  result.checks.push('Services→terminal switch and explicit reconnect retain stable foreground history, original cwd and the same live PTY child; input remains usable.');
  await page.getByRole('tab').filter({ hasText: '服务' }).click(); await serviceRow.waitFor();
  await serviceRow.locator('.runtime-service-stop').click();
  const terminateDialog = page.getByRole('alertdialog', { name: /终止 node/ });
  await terminateDialog.waitFor();
  assert.match(await terminateDialog.innerText(), /PID \d+/);
  const dialogLayout = await terminateDialog.evaluate((dialog) => {
    const overlay = dialog.closest('.confirm-overlay');
    const overlayRect = overlay.getBoundingClientRect();
    return {
      width: dialog.querySelector('.confirm-card')?.getBoundingClientRect().width || dialog.getBoundingClientRect().width,
      backdropFilter: getComputedStyle(overlay).backdropFilter,
      overlayLeft: overlayRect.left,
      overlayTop: overlayRect.top,
      overlayWidth: overlayRect.width,
      overlayHeight: overlayRect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  assert.ok(dialogLayout.width <= 430);
  assert.ok(dialogLayout.backdropFilter === 'none');
  assert.ok(dialogLayout.overlayLeft === 0 && dialogLayout.overlayTop === 0);
  assert.ok(dialogLayout.overlayWidth === dialogLayout.viewportWidth);
  assert.ok(dialogLayout.overlayHeight === dialogLayout.viewportHeight);
  await page.screenshot({ path: path.join(output, 'terminate-confirm.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '终止服务', exact: true }).click();
  await serviceRow.waitFor({ state: 'detached' });
  await waitForProcessGone(firstServerPid);
  result.checks.push('Service panel attributes own PTY child, shows native destructive confirmation, and stops exactly the fixture PID.');

  // A sibling process started outside Studio must also have a visible action.
  localServer = spawn(process.execPath, ['-e', 'const s=require("http").createServer((q,r)=>r.end("qa"));s.listen(0,"127.0.0.1",()=>console.log(s.address().port))'], { cwd: profile, stdio: ['ignore', 'pipe', 'pipe'] });
  const localPort = await Promise.race([new Promise((resolve, reject) => {
    localServer.once('error', reject);
    localServer.stdout.once('data', (data) => resolve(Number(data.toString().trim())));
  }), new Promise((_, reject) => setTimeout(() => reject(new Error('Local QA server did not listen')), 10000))]);
  assert.ok(localPort); result.servers.push({ label: 'own external sibling', pid: localServer.pid, port: localPort });
  await page.getByRole('button', { name: /^全部/ }).click();
  const localRow = page.locator('.runtime-service-row').filter({ hasText: `PID ${localServer.pid}` });
  await localRow.waitFor();
  assert.match(await localRow.innerText(), new RegExp(String(localPort)));
  await localRow.getByText('本机', { exact: true }).first().waitFor();
  await localRow.locator('.runtime-service-stop').click();
  await page.getByRole('alertdialog').getByText(/工作区以外的本机服务/).waitFor();
  await page.getByRole('button', { name: '终止服务', exact: true }).click();
  await localRow.waitFor({ state: 'detached' });
  await waitForProcessGone(localServer.pid);

  await page.getByRole('tab').filter({ hasText: '终端' }).click();
  await page.locator('.terminal-host .xterm').waitFor();
  await page.locator('.xterm-helper-textarea').focus();
  result.checks.push('A separate process launched by this QA is classified as local and terminated only after its own PID-specific confirmation.');
  await page.keyboard.type(terminalServerCommand('QA_SECOND'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /QA_SECOND_PORT=\d+\s*QA_SECOND_PID=\d+\s*QA_SECOND_READY/.test(document.querySelector('.xterm-rows')?.textContent || ''));
  const secondText = await page.locator('.xterm-rows').textContent();
  serverPid = Number(/QA_SECOND_PID=(\d+)/.exec(secondText)?.[1]);
  const secondPort = Number(/QA_SECOND_PORT=(\d+)/.exec(secondText)?.[1]);
  assert.ok(serverPid && secondPort && ownedTerminalServer(serverPid));
  result.servers.push({ label: 'PTY child closed with tab', pid: serverPid, port: secondPort });
  await page.screenshot({ path: path.join(output, 'terminal-compact.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '关闭 终端', exact: true }).click();
  await waitForProcessGone(serverPid, 5000);
  result.checks.push('Closing the terminal tab terminates its dynamic-port server child.');
  assert.deepEqual(errors, []);
  result.passed = true;
  await rm(path.join(output, 'failure.png'), { force: true });
  console.log(`runtime panel: real PTY + service attribution + reconnect + cleanup passed (${output})`);
} catch (error) {
  result.passed = false; result.failure = String(error.stack || error);
  if (page && !page.isClosed()) {
    result.failureTerminal = await page.evaluate(() => ({ text: document.querySelector('.xterm-rows')?.textContent, toolbar: document.querySelector('.terminal-toolbar')?.textContent, width: innerWidth, height: innerHeight })).catch(() => null);
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  const appProcess = electronApp?.process();
  const exited = appProcess && appProcess.exitCode === null ? once(appProcess, 'exit').then(([code, signal]) => ({ code, signal })) : Promise.resolve(null);
  await electronApp?.close().catch(() => {});
  result.cleanup.electronExit = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
  localServer?.kill();
  const forced = [];
  for (const pid of [firstServerPid, serverPid]) {
    if (!pid || !ownedTerminalServer(pid)) continue;
    forced.push(pid);
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  result.cleanup.forcedOwnServerPids = forced;
  result.cleanup.remainingOwnServerPids = [];
  for (const pid of [firstServerPid, serverPid, localServer?.pid].filter(Boolean)) {
    try { await waitForProcessGone(pid, 3000); } catch { result.cleanup.remainingOwnServerPids.push(pid); }
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  result.cleanup.passed = result.cleanup.electronExit?.code === 0 && result.cleanup.remainingOwnServerPids.length === 0 && forced.length === 0;
  if (!result.cleanup.passed) result.passed = false;
  result.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  if (!result.cleanup.passed) throw new Error('Runtime QA cleanup did not complete naturally; inspect results.json');
}

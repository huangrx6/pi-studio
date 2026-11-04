/**
 * Real Electron check for the terminal and runtime-service workbench tabs.
 * The terminal starts a local HTTP listener; the service panel must attribute
 * it to the Studio process tree and closing the terminal tab must stop it.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import { spawn } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = path.join(root, '.qa', 'runtime-panel');
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-runtime-panel-'));
const workspace = path.join(profile, 'workspace');
await mkdir(workspace);
await mkdir(output, { recursive: true });

const environment = {
  ...process.env,
  PI_STUDIO_USER_DATA: profile,
  PI_STUDIO_DB: path.join(profile, 'studio.sqlite'),
  ZDOTDIR: profile,
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

let electronApp;
let serverPid;
let firstServerPid;
let localServer;
try {
  electronApp = await _electron.launch({ args: [root], env: environment });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.brand').waitFor();
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
    buttons.length === 4
    && buttons.every((button) => Math.abs(button.getBoundingClientRect().width - buttons[0].getBoundingClientRect().width) <= 1)
  )), true);
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
  await page.keyboard.type(
    'node -e \'require("http").createServer((q,s)=>s.end("ready")).listen(38123,"127.0.0.1")\' & echo PORT_PID=$!',
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /PORT_PID=\d+/.test(
    document.querySelector('.xterm-rows')?.textContent || '',
  ));
  const terminalText = await page.locator('.xterm-rows').innerText();
  await page.screenshot({ path: path.join(output, 'terminal.png'), animations: 'disabled' });
  firstServerPid = Number(/PORT_PID=(\d+)/.exec(terminalText)?.[1]);
  assert.ok(firstServerPid, 'terminal did not report the test server PID');

  await page.getByRole('button', { name: '打开工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '运行服务', exact: true }).click();
  const serviceRow = page.locator('.runtime-service-row').filter({ hasText: '38123' });
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

  await serviceRow.locator('.runtime-service-stop').click();
  const terminateDialog = page.getByRole('alertdialog', { name: /终止 node/ });
  await terminateDialog.waitFor();
  assert.match(await terminateDialog.innerText(), /PID \d+/);
  const dialogLayout = await terminateDialog.evaluate((dialog) => {
    const overlay = dialog.closest('.confirm-overlay');
    const overlayRect = overlay.getBoundingClientRect();
    return {
      width: dialog.getBoundingClientRect().width,
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

  // A sibling process started outside Studio must also have a visible action.
  localServer = spawn(process.execPath, ['-e', 'const s=require("http").createServer((q,r)=>r.end("qa"));s.listen(0,"127.0.0.1",()=>console.log(s.address().port))'], { cwd: profile, stdio: ['ignore', 'pipe', 'pipe'] });
  const localPort = await new Promise((resolve, reject) => {
    localServer.once('error', reject);
    localServer.stdout.once('data', (data) => resolve(Number(data.toString().trim())));
  });
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
  await page.keyboard.type(
    'node -e \'require("http").createServer((q,s)=>s.end("ready")).listen(38124,"127.0.0.1")\' & echo SECOND_PID=$!',
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /SECOND_PID=\d+/.test(
    document.querySelector('.xterm-rows')?.textContent || '',
  ));
  serverPid = Number(/SECOND_PID=(\d+)/.exec(
    await page.locator('.xterm-rows').innerText(),
  )?.[1]);
  assert.ok(serverPid, 'terminal did not report the cleanup test server PID');
  await page.screenshot({ path: path.join(output, 'terminal-compact.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '关闭 终端', exact: true }).click();
  await page.waitForTimeout(750);
  assert.throws(() => process.kill(serverPid, 0), /ESRCH/, 'closing the terminal tab left its server running');
  assert.deepEqual(errors, []);
  console.log(`runtime panel: terminal + service attribution + cleanup passed (${output})`);
} finally {
  await electronApp?.close().catch(() => {});
  localServer?.kill();
  if (firstServerPid) {
    try { process.kill(firstServerPid, 'SIGKILL'); } catch { /* Already stopped. */ }
  }
  if (serverPid) {
    try {
      process.kill(serverPid, 'SIGKILL');
    } catch {
      // Expected when terminal cleanup passed.
    }
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

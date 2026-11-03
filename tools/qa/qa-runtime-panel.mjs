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

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = path.join(root, '.qa', 'runtime-panel');
const profile = await mkdtemp(path.join(os.tmpdir(), 'pi-studio-runtime-panel-'));
await mkdir(output, { recursive: true });

const environment = {
  ...process.env,
  PI_STUDIO_USER_DATA: profile,
  PI_STUDIO_DB: path.join(profile, 'studio.sqlite'),
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
try {
  electronApp = await _electron.launch({ args: [root], env: environment });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.brand').waitFor();
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  await page.locator('.panel-start-tools').waitFor();
  await page.waitForFunction(() => (document.querySelector('.file-panel')?.getBoundingClientRect().width || 0) > 300);
  const toolAlignment = await page.locator('.panel-tool').evaluateAll((buttons) => buttons.map((button) => {
    const icon = button.querySelector('.panel-tool-icon')?.getBoundingClientRect();
    const label = button.querySelector('strong')?.getBoundingClientRect();
    const arrow = button.querySelector('.panel-tool-arrow');
    return {
      iconCenter: icon ? icon.top + icon.height / 2 : Number.NaN,
      labelCenter: label ? label.top + label.height / 2 : Number.NaN,
      arrowTransform: arrow ? getComputedStyle(arrow).transform : '',
    };
  }));
  assert.ok(toolAlignment.every((item) => Math.abs(item.iconCenter - item.labelCenter) <= 1));
  assert.ok(toolAlignment.every((item) => item.arrowTransform === 'none'));
  assert.equal(await page.locator('.panel-tool').evaluateAll((buttons) => (
    buttons.length === 4
    && buttons.every((button) => button.getBoundingClientRect().width === buttons[0].getBoundingClientRect().width)
  )), true);
  await page.screenshot({ path: path.join(output, 'start.png'), animations: 'disabled' });

  await page.locator('.panel-tool').filter({ hasText: '终端' }).click();
  await page.locator('.terminal-host .xterm').waitFor();
  await page.locator('.xterm-helper-textarea').focus();
  await page.waitForTimeout(600);
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

  await page.getByRole('tab').filter({ hasText: '开始' }).click();
  await page.locator('.panel-tool').filter({ hasText: '运行服务' }).click();
  const serviceRow = page.locator('.runtime-service-row').filter({ hasText: '38123' });
  await serviceRow.waitFor();
  await serviceRow.getByText('任务进程', { exact: true }).waitFor();
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
  await page.screenshot({ path: path.join(output, 'services-compact.png'), animations: 'disabled' });

  await page.locator('.runtime-service-stop').click();
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
  if (serverPid) {
    try {
      process.kill(serverPid, 'SIGKILL');
    } catch {
      // Expected when terminal cleanup passed.
    }
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

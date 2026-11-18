// Run after pnpm run build on macOS. Exercises real keyboard -> xterm -> PTY -> vi.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const executablePath = process.env.PI_STUDIO_PACKAGED_APP;
const profile = await mkdtemp(path.join(tmpdir(), 'pi-terminal-vi-'));
const sample = path.join(profile, 'sample.txt');
const env = {
  ...process.env,
  PI_STUDIO_USER_DATA: profile,
  PI_STUDIO_DB: path.join(profile, 'studio.sqlite'),
  PI_WORKSPACE: profile,
  ZDOTDIR: profile,
  SHELL: '/bin/zsh',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;
let app;
try {
  for (const name of ['.zshenv', '.zshrc', '.zprofile', '.zlogin']) {
    await writeFile(path.join(profile, name), '');
  }
  await writeFile(sample, 'alpha\nbravo\ncharlie\n');
  app = await _electron.launch({ executablePath, args: executablePath ? [] : [root], cwd: profile, env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, profile);
  await page.getByRole('button', { name: '打开工作区', exact: true }).click();
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  await page.locator('.panel-tool').filter({ hasText: '终端' }).click();
  await page.locator('.terminal-live-state').filter({ hasText: '运行中' }).waitFor();
  await page.locator('.terminal-host').click();
  await page.evaluate(() => {
    window.viOutput = '';
    window.piApi.onTerminalEvent(event => {
      if (event.type === 'data') window.viOutput = (window.viOutput + event.data).slice(-16000);
    });
  });
  await page.keyboard.type('/usr/bin/vi -Nu NONE -i NONE -n sample.txt');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.viOutput.includes('charlie'));
  // Vim sends DECRQM after its initial screen. Exiting too soon misses the
  // production-bundle parser crash and only verifies that input reaches the PTY.
  await page.waitForFunction(() => window.viOutput.includes('\u001b[?12$p'));
  await page.getByRole('button', { name: '打开工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '运行服务', exact: true }).click();
  const terminalTab = page.getByRole('tab').filter({ hasText: '终端' });
  await terminalTab.click();
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
  // Selecting an already-active tab used to leave all input on the tab header.
  await terminalTab.click();
  assert.ok(await page.locator('.xterm-helper-textarea').evaluate(input => document.activeElement === input));
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowRight', 'ArrowLeft',
    'r', 'X', 'u', 'Control+r', 'i', 'Q', 'Escape']) {
    await page.keyboard.press(key);
  }
  await page.keyboard.type(':wq');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.viOutput.includes('written'));
  assert.equal(await readFile(sample, 'utf8'), 'alpha\nbQXavo\ncharlie\n');
  assert.deepEqual(errors, [], 'The built terminal must parse Vim mode queries without freezing');
  console.log('Passed vi arrows, undo/redo, insert, Escape and save after tab reactivation.');
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}

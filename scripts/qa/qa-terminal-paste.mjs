// Run after pnpm run build on macOS. Uses a disposable zsh session and fixture clipboard text.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import { openToolPanel } from './fixtures/tool-panel.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(root, '.qa/terminal-paste');
const profile = await mkdtemp(path.join(tmpdir(), 'pi-terminal-paste-'));
const env = { ...process.env, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite'), PI_WORKSPACE: profile, ZDOTDIR: profile, SHELL: '/bin/zsh' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;
const sample = ["project='Pi Studio'", '', 'if [[ -n "$project" ]]; then', '  printf \'<%s>\\n\' "$project"', 'fi', ''].join('\r\n');
const bracketed = text => '\x1b[200~' + text.replace(/\r?\n/g, '\r') + '\x1b[201~';
const focused = locator => locator.evaluate(node => node === document.activeElement);

let app;
try {
  await mkdir(output, { recursive: true });
  for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) await writeFile(path.join(profile, name), '');
  app = await _electron.launch({ args: [root, '--disable-background-networking', '--proxy-server=http://127.0.0.1:9'], cwd: profile, env });
  const main = await app.firstWindow();
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, profile);
  await main.getByRole('button', { name: '打开工作区', exact: true }).click();
  const panel = await openToolPanel(app, main);
  panel.setDefaultTimeout(15000);
  await panel.evaluate(() => {
    window.pasteOutput = '';
    window.piApi.onTerminalEvent(event => { if (event.type === 'data') window.pasteOutput += event.data; });
    Object.defineProperty(navigator.clipboard, 'readText', { value: async () => window.pasteSample });
  });
  await panel.getByRole('button', { name: '新终端', exact: true }).click();
  await panel.getByText('运行中', { exact: true }).waitFor();
  await panel.waitForFunction(() => window.pasteOutput.includes('\x1b[?2004h'));
  await app.evaluate(({ ipcMain }) => {
    globalThis.pasteWrites = [];
    ipcMain.on('pi:terminal-write', (_event, { data }) => globalThis.pasteWrites.push(data));
  });
  const writes = () => app.evaluate(() => globalThis.pasteWrites);
  const terminal = panel.locator('.xterm-helper-textarea');
  const dialog = panel.getByRole('dialog', { name: '粘贴预览' });
  const accept = dialog.getByRole('button', { name: '粘贴到终端' });
  const nativePaste = text => terminal.evaluate((node, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, text);

  await panel.evaluate(text => { window.pasteSample = text; }, sample);
  await panel.getByRole('button', { name: '更多终端操作' }).click();
  await panel.getByRole('menuitem', { name: '粘贴', exact: true }).click();
  assert.equal(await dialog.locator('pre').textContent(), sample);
  assert.equal(await focused(accept), true);
  assert.deepEqual(await writes(), []);
  await panel.screenshot({ path: path.join(output, 'preview.png'), animations: 'disabled' });
  await accept.click();
  assert.equal(await focused(terminal), true);
  assert.deepEqual(await writes(), [bracketed(sample)]);
  await panel.keyboard.press('Enter');
  await panel.waitForFunction(() => window.pasteOutput.includes('<Pi Studio>'));
  assert.deepEqual(await writes(), [bracketed(sample), '\r']);

  const longLine = '0123456789'.repeat(500);
  await nativePaste(longLine);
  const preview = dialog.locator('pre');
  assert.equal(await preview.textContent(), longLine);
  assert.ok(await preview.evaluate(node => node.scrollHeight > node.clientHeight && node.scrollWidth <= node.clientWidth + 1));
  await panel.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await focused(terminal), true);
  assert.deepEqual(await writes(), [bracketed(sample), '\r']);

  await panel.keyboard.press('Meta+v');
  await accept.waitFor();
  await panel.keyboard.press('Enter');
  assert.equal(await focused(terminal), true);
  assert.deepEqual(await writes(), [bracketed(sample), '\r', bracketed(sample)]);
  await nativePaste('pwd');
  assert.equal(await dialog.count(), 0);
  assert.equal((await writes()).at(-1), bracketed('pwd'));
  console.log('Passed terminal paste preview, cancellation, focus restoration and separate shell submission.');
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}

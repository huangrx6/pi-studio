/**
 * Focused Electron QA for the configurable shortcuts.
 *
 * Proves the shell really reacts to the default bindings (⌘B / ⌘J), that the
 * settings page lists them, and that recording a conflicting combo is refused
 * while a free combo is stored and applied.
 *
 *   node tools/qa/qa-shortcuts.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = new URL('../../.qa/screenshots/shortcuts/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'pi-shortcuts-qa-'));
const env = { ...process.env, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;

const app = await _electron.launch({ args: [root], env });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 60000 });
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 'Meta' : 'Control';
  const press = async (key) => page.keyboard.press(`${mod}+${key}`);

  await press('b');
  await page.waitForFunction(() => document.querySelector('.app')?.classList.contains('is-sidebar-collapsed'), null, { timeout: 5000 });
  await press('b');
  await page.waitForFunction(() => !document.querySelector('.app')?.classList.contains('is-sidebar-collapsed'), null, { timeout: 5000 });

  await press('j');
  await page.waitForSelector('.file-panel.is-open', { timeout: 5000 });
  await press('j');
  await page.waitForFunction(() => !document.querySelector('.file-panel.is-open'), null, { timeout: 5000 });

  // Settings → 快捷键 lists every action with its current binding.
  await page.getByRole('button', { name: '设置' }).first().click();
  await page.getByRole('button', { name: '快捷键' }).first().click();
  await page.waitForSelector('.shortcut-row');
  const rows = await page.locator('.shortcut-row').count();
  assert.ok(rows >= 10, `every action is listed (${rows})`);
  assert.match(await page.locator('.shortcut-key').first().innerText(), isMac ? /⌘K/ : /Ctrl\+K/);

  // Recording a combo another action owns is refused.
  const sidebarKey = page.locator('.shortcut-row', { hasText: '折叠 / 展开侧栏' }).locator('.shortcut-key');
  await sidebarKey.click();
  await page.keyboard.press(`${mod}+J`);
  await page.waitForSelector('.shortcut-conflict');
  assert.match(await page.locator('.shortcut-conflict').innerText(), /已被/);

  // A free combo is stored and shown.
  await page.keyboard.press(`${mod}+Alt+9`);
  await page.waitForFunction(() => !document.querySelector('.shortcut-conflict'), null, { timeout: 5000 });
  assert.match(await sidebarKey.innerText(), isMac ? /⌘⌥9/ : /Ctrl\+Alt\+9/);
  await page.screenshot({ path: `${output}settings.png` });
  console.log('shortcut QA passed', JSON.stringify({ rows }));
} finally {
  await app.close();
}

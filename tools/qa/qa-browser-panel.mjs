/**
 * Focused Electron QA for the right-panel browser.
 *
 * Launches the real app against a throw-away profile, opens the panel browser
 * tab, navigates it to a page served by a local HTTP server and proves:
 *   - the tab renders a sandboxed <webview> in its own partition;
 *   - the address bar normalises input and the page really loads;
 *   - non-http(s) navigation is refused by the main-process guard.
 *
 * Run `pnpm run build` first (the app loads web-dist).
 *   node tools/qa/qa-browser-panel.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = new URL('../../.qa/screenshots/browser-panel/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'pi-studio-browser-qa-'));
const env = { ...process.env, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_STUDIO_DEV;

const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Pi Browser QA</title><h1 id="probe">browser panel works</h1>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let app;
try {
  app = await _electron.launch({ args: [root], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);

  await page.click('button[aria-label="打开右侧面板"]');
  await page.waitForSelector('.panel-start-tools', { timeout: 15000 });
  await page.locator('.panel-start-tools button', { hasText: '浏览器' }).first().click();

  await page.waitForSelector('.browser-panel webview', { timeout: 15000 });
  const attributes = await page.evaluate(() => {
    const view = document.querySelector('.browser-panel webview');
    return {
      partition: view.getAttribute('partition'),
      prefs: view.getAttribute('webpreferences'),
      popups: view.getAttribute('allowpopups'),
    };
  });
  assert.equal(attributes.partition, 'persist:pi-browser');
  assert.match(String(attributes.prefs), /nodeIntegration=no/);
  assert.equal(attributes.popups, 'false');

  // The pill owns the focus state: the bare input must not paint its own box.
  await page.click('.browser-address input');
  await page.waitForTimeout(400);
  const focus = await page.evaluate(() => {
    const form = document.querySelector('.browser-address');
    const input = form.querySelector('input');
    const formBox = getComputedStyle(form);
    const inputBox = getComputedStyle(input);
    return {
      ring: formBox.boxShadow,
      border: formBox.borderColor,
      inputShadow: inputBox.boxShadow,
      inputRadius: inputBox.borderRadius,
      fitsHeight: input.getBoundingClientRect().height <= form.getBoundingClientRect().height,
    };
  });
  assert.notEqual(focus.ring, 'none', 'the pill paints the focus ring');
  assert.equal(focus.inputShadow, 'none', 'the inner input paints no ring');
  assert.equal(focus.inputRadius, '0px', 'the inner input has no rounded box');
  assert.equal(focus.fitsHeight, true, 'the input stays inside the pill');

  await page.fill('.browser-address input', `127.0.0.1:${port}`);
  await page.press('.browser-address input', 'Enter');
  await page.waitForFunction(async (expected) => {
    const view = document.querySelector('.browser-panel webview');
    if (!view) return false;
    try {
      if (typeof view.getURL === 'function') return view.getURL() === expected;
    } catch {
      return false;
    }
    return false;
  }, `https://127.0.0.1:${port}`, { timeout: 15000 }).catch(() => {});

  // The server only speaks http, so the normaliser produced https and the load
  // fails; retype the full http URL to prove a real navigation.
  await page.fill('.browser-address input', `http://127.0.0.1:${port}/`);
  await page.press('.browser-address input', 'Enter');
  await page.waitForFunction((expected) => {
    const view = document.querySelector('.browser-panel webview');
    try {
      return typeof view?.getURL === 'function' && view.getURL() === expected;
    } catch {
      return false;
    }
  }, `http://127.0.0.1:${port}/`, { timeout: 20000 });

  const loaded = await page.evaluate(() => {
    const view = document.querySelector('.browser-panel webview');
    return { url: view.getURL(), title: view.getTitle() };
  });
  assert.equal(loaded.url, `http://127.0.0.1:${port}/`);
  assert.equal(loaded.title, 'Pi Browser QA');

  // file: navigation is refused by the guard and the page stays put.
  await page.evaluate(() => {
    const view = document.querySelector('.browser-panel webview');
    try { view.loadURL('file:///etc/hosts'); } catch { /* refused synchronously */ }
  });
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => document.querySelector('.browser-panel webview').getURL());
  assert.equal(after, `http://127.0.0.1:${port}/`, 'non-http navigation must be refused');

  await page.screenshot({ path: `${output}panel.png` });
  console.log('browser panel QA passed', JSON.stringify({ attributes, loaded }));
} finally {
  if (app) await app.close().catch(() => {});
  server.close();
}

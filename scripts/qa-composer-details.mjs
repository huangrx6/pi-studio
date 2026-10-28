// Actual App and composer; isolated IPC fixtures, no credentials or model requests.
import { chromium } from 'playwright-core';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = new URL('../screenshots/composer-details/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  page.setDefaultTimeout(8000); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const model = { modelRef: 'demo/model', label: 'Demo', thinkingLevel: 'default', thinkingLevels: ['default'], effectiveThinkingLevel: 'off' };
    const session = { id: 'demo', cwd: '/workspace', title: '实时底栏检查', modified: Date.now(), messages: [] };
    let listener, view = { lines: [], overlay: null, interactive: false };
    window.updateFooter = text => { view = { ...view, lines: [Array.from(text, text => ({ text, width: /[\u3000-\uffff]/u.test(text) ? 2 : 1 }))] }; listener?.({ sessionId: 'demo', view, text }); };
    window.piApi = new Proxy({
      state: async () => ({ workspaces: [{ cwd: '/workspace', name: '测试工作区', sessions: [session] }], model }),
      session: async () => session,
      modeGet: async () => ({ available: true, mode: 'smart' }), modeSet: async ({mode}) => ({mode,applied:true}),
      composerResources: async () => ({ commands: [], skills: [] }),
      extensionState: async () => ({ statuses: [], footer: '', view }),
      footerAction: async () => view,
      onExtensionFooter: fn => { listener = fn; return () => { listener = undefined; }; },
    }, { get: (target, key) => key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => undefined });
  });
  await page.goto('http://127.0.0.1:5180', { waitUntil: 'domcontentloaded' });
  await page.locator('.workspace-row').first().click();
  await page.locator('.session-row').first().click();
  await page.locator('.composer textarea').fill('检查图片和底栏');
  // Create an image fixture without reading user attachments.
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#82a857'; ctx.fillRect(0,0,160,120);
    ctx.fillStyle = '#e8eee1'; ctx.fillRect(20,20,120,80);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'sample.png', {type:'image/png'}));
    document.querySelector('.composer').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  const thumbnail = page.locator('.composer-attachment.is-image'); await thumbnail.waitFor();
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.mouse.move(10,10);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.composer-attachment img')).filter === 'none');
    await thumbnail.hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.composer-attachment img')).filter.includes('0.8'));
    const geometry = await thumbnail.locator('button').evaluate(button => {
      const b = button.getBoundingClientRect(), s = button.querySelector('svg').getBoundingClientRect();
      return { x: Math.abs(b.x + b.width/2 - s.x - s.width/2), y: Math.abs(b.y + b.height/2 - s.y - s.height/2), bg: getComputedStyle(button).backgroundColor };
    });
    assert.ok(geometry.x < .1 && geometry.y < .1, JSON.stringify(geometry));
    assert.equal(geometry.bg, 'rgb(255, 255, 255)');
    await page.evaluate(() => window.updateFooter('◴ 1 轮 1 步 · ≈72 tok/s   ▱ ≈180 tok   ◔ ≈12%   ···'));
    await page.getByText('≈72 tok/s', {exact:false}).last().waitFor();
    await page.screenshot({path:`${output}${theme}.png`,animations:'disabled'});
  }
  await page.evaluate(() => window.updateFooter('◴ 1 轮 1 步 · 80 tok/s   ▱ 200 tok   ◔ 13%   ···'));
  await page.waitForFunction(() => document.querySelector('.extension-footer')?.textContent.includes('200 tok'));
  await thumbnail.locator('button').focus();
  await page.keyboard.press('Enter'); await thumbnail.waitFor({state:'detached'});
  await page.getByRole('button', {name:'权限模式',exact:true}).click();
  await page.getByRole('option').filter({hasText:'完全权限'}).click();
  assert.equal(await page.locator('.extension-toast').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: actual composer, light/dark hover, centered close glyph, keyboard deletion, footer event updates, mode switch.');
} finally { await browser.close(); }

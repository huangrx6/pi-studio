import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = new URL('../screenshots/status-dock/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  page.setDefaultTimeout(8000); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const model = { modelRef: 'demo/model', label: 'DeepSeek V4.1 Flash', thinkingLevel: 'max', thinkingLevels: ['default','max'], effectiveThinkingLevel: 'max' };
    const session = { id: 'demo', cwd: '/workspace', title: '压缩恢复测试', modified: new Date().toISOString(), messages: [] };
    const status = new Map([['pi-throughput','6 轮 309 步 · llm: 33m13s · tools: 14m2s · ttft: 2.2s · out: 181 t/s'],['context:auto','◎ Context 5%'],['quota','⚡DeepSeek balance: ¥251.58']]);
    const listeners = new Set(), prompts = new Set();
    let requestId, resolvePrompt;
    window.emitPrompt = payload => { for (const listener of prompts) listener({ requestId, ...payload }); };
    window.finishPrompt = () => resolvePrompt?.();
    window.updateStatus = (key, text) => { status.set(key,text); for (const listener of listeners) listener({sessionId:'demo',key,text}); };
    window.piApi = new Proxy({
      state: async () => ({ workspaces: [{ cwd: '/workspace', name: '测试工作区', sessions: [session] }], model }),
      session: async () => session,
      prompt: payload => { requestId = payload.requestId; return new Promise(resolve => { resolvePrompt = resolve; }); },
      modeGet: async () => ({ available: true, mode: 'full' }),
      composerResources: async () => ({ commands: [], skills: [] }),
      extensionState: async () => ({ statuses: [...status], footer: '' }),
      onExtensionStatus: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      onPrompt: fn => { prompts.add(fn); return () => prompts.delete(fn); },
    }, { get: (target, key) => key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => undefined });
  });
  await page.goto('http://127.0.0.1:5180', { waitUntil: 'domcontentloaded' });
  await page.locator('.workspace-row').first().click();
  await page.locator('.session-row').first().click();
  await page.locator('.composer textarea').fill('继续优化代码');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await page.evaluate(() => window.emitPrompt({type:'compaction-start',reason:'manual'}));
  await page.locator('.compaction-banner').waitFor();
  assert.ok(await page.getByRole('button',{name:'正在压缩上下文',exact:true}).isDisabled());
  await page.evaluate(() => window.emitPrompt({type:'compaction-end'}));
  await page.locator('.compaction-banner').waitFor({state:'detached'});
  assert.doesNotMatch(await page.locator('.composer textarea').getAttribute('placeholder'), /压缩/);
  await page.evaluate(() => window.emitPrompt({type:'compaction-interrupted',compacting:false}));
  assert.equal(await page.locator('.compaction-banner').count(), 0);
  await page.evaluate(() => window.emitPrompt({type:'message_update',message:{role:'assistant',timestamp:10,content:[{type:'text',text:'压缩完成，继续检查代码。'}]}}));
  await page.getByText('压缩完成，继续检查代码。',{exact:true}).waitFor();
  await page.locator('.composer textarea').fill('补充说明');
  assert.equal(await page.locator('.send-button').isDisabled(), false);
  // Repeated compaction and aborted/failed completion must also unlock the composer.
  await page.evaluate(() => window.emitPrompt({type:'compaction-start'}));
  await page.locator('.compaction-banner').waitFor();
  await page.evaluate(() => window.emitPrompt({type:'compaction-end',aborted:true}));
  await page.locator('.compaction-banner').waitFor({state:'detached'});
  await page.evaluate(() => window.emitPrompt({type:'done'}));
  const stat = page.locator('.status-chip').filter({hasText:'6 轮'});
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; },theme);
    await stat.click();
    const dialog = page.getByRole('dialog',{name:'状态详情',exact:true}); await dialog.waitFor();
    assert.equal(await dialog.locator('.status-detail-row').count(), 4);
    assert.equal(await dialog.getByText('前移',{exact:true}).count(), 0);
    await page.evaluate(() => window.updateStatus('pi-throughput','6 轮 310 步 · llm: 33m15s · tools: 14m2s · ttft: 2.2s · out: 185 t/s'));
    await dialog.getByText('185 t/s',{exact:true}).waitFor();
    await page.screenshot({path:`${output}${theme}.png`,animations:'disabled'});
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'detached'});
    assert.ok(await stat.evaluate(node => document.activeElement === node));
    await page.locator('.status-chip').filter({hasText:'balance'}).click();
    const chipBox = await page.locator('.status-chip').filter({hasText:'balance'}).boundingBox();
    const dialogBox = await dialog.boundingBox();
    assert.ok(dialogBox.y + dialogBox.height < chipBox.y);
    await page.locator('.composer textarea').click(); await dialog.waitFor({state:'detached'});
  }
  await page.getByRole('button',{name:'管理状态栏',exact:true}).click();
  const manage = page.getByRole('dialog',{name:'状态栏管理',exact:true});
  assert.ok(await manage.getByRole('button',{name:'上移',exact:true}).first().isDisabled());
  await manage.getByRole('button',{name:'下移',exact:true}).first().click();
  await manage.locator('.status-manage-check').first().click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.status-chip').count(), 2);
  await page.setViewportSize({width:580,height:760});
  await page.locator('.status-chip').first().click();
  const box = await page.getByRole('dialog',{name:'状态详情',exact:true}).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 580, JSON.stringify(box));
  await page.screenshot({path:`${output}narrow.png`,animations:'disabled'});
  assert.deepEqual(errors, []);
  console.log('PASS: compaction end/late recovery/abort unlock input; dock live values, anchored panels, keyboard/outside dismissal, management, themes and narrow viewport.');
} finally { await browser.close(); }

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startChecklistModel } from './fixtures/checklist-model.mjs';
import { configureTestModel, launchTestDesktop } from './fixtures/isolated-desktop.mjs';

const output = fileURLToPath(new URL('../../.qa/keep-awake/', import.meta.url));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'profile-'));
const workspace = path.join(profile, 'workspace');
await mkdir(workspace);
const model = await startChecklistModel();
const exec = promisify(execFile);
let app;
let page;

async function launch() {
  ({ app, page } = await launchTestDesktop(workspace, profile, 1100, 760));
  await page.evaluate(() => window.piApi.waitForStartup());
}
const chip = () => page.getByRole('button', { name: '打开 防止电脑休眠 详情', exact: true });
const panel = () => page.getByRole('dialog', { name: '防止电脑休眠', exact: true });
const frame = () => panel().frameLocator('iframe');
const state = label => chip().getByText(label, { exact: true }).waitFor();

async function waitForModes() {
  await page.waitForFunction(() => {
    const frame = document.querySelector('.studio-status-details iframe.is-ready');
    return frame && getComputedStyle(frame).opacity === '1';
  });
  await frame().locator('fieldset:not(:disabled)').waitFor();
}

async function openModes() {
  await chip().click();
  await waitForModes();
}

async function openWithSlowView(previousHeight) {
  // Hold the document on first open, then hold only the data on reopen.
  await app.evaluate(({ app }, holdData) => {
    const path = process.getBuiltinModule('path');
    const require = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'));
    let release;
    let restore;
    const held = new Promise(resolve => { release = resolve; });
    if (holdData) {
      const { extensionDataSource } = require('./electron/main/services/studio-extensions.cjs');
      const provider = extensionDataSource('builtin:studio-keep-awake/control');
      const read = provider.read;
      provider.read = async function(...args) { await held; return read.apply(this, args); };
      restore = () => { provider.read = read; };
    } else {
      const fs = require('node:fs').promises;
      const entry = path.join(app.getAppPath(), 'electron/main/capabilities/keep-awake/ui/index.html');
      const readFile = fs.readFile;
      fs.readFile = async function(file, ...options) {
        if (file === entry) await held;
        return readFile.call(this, file, ...options);
      };
      restore = () => { fs.readFile = readFile; };
    }
    global.qaReleaseModePanel = () => { restore(); release(); delete global.qaReleaseModePanel; };
  }, previousHeight !== undefined);
  const loading = panel().getByRole('status').filter({ hasText: '正在加载…' });
  try {
    await chip().click();
    await loading.waitFor();
    if (previousHeight !== undefined) await frame().locator('fieldset').waitFor({ state: 'attached' });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.studio-status-details')).opacity === '1');
    assert.ok(await loading.locator('.loading-pi').isVisible());
    assert.equal(await loading.evaluate(node => getComputedStyle(node).opacity), '1');
    assert.equal(await panel().locator('iframe').isVisible(), false);
    if (previousHeight === undefined) {
      await panel().screenshot({ path: path.join(output, 'modes-opening.png') });
    } else {
      assert.equal(await panel().evaluate(node => node.offsetHeight), previousHeight,
        'the reopened panel keeps its measured height while the frame loads');
    }
  } finally {
    await app.evaluate(() => global.qaReleaseModePanel());
  }
  await waitForModes();
  await loading.waitFor({ state: 'detached' });
}

async function nativeAssertion(expected) {
  if (process.platform !== 'darwin') return;
  const deadline = Date.now() + 8000;
  const pid = await app.evaluate(() => process.pid);
  let assertions;
  do {
    const { stdout } = await exec('/usr/bin/pmset', ['-g', 'assertions']);
    assertions = stdout.split('\n').filter(line => line.includes('pid ' + pid + '('));
    assert.ok(!assertions.some(line => /NoDisplaySleepAssertion|PreventUserIdleDisplaySleep/.test(line)), 'the display may turn off');
    if (assertions.some(line => /NoIdleSleepAssertion|PreventUserIdleSystemSleep/.test(line)) === expected) return;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail('macOS idle system sleep assertion for the isolated app should be ' + expected + ': ' + JSON.stringify(assertions));
}

// Exercise the actual switch, IPC and native lease without an administrator
// prompt. Replace only the OS authorization process in this isolated Electron.
async function checkLidSwitch(toggle) {
  const fixtureReady = await app.evaluate(async ({ app }) => {
    const cp = process.getBuiltinModule('child_process');
    const path = process.getBuiltinModule('path');
    const require = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'));
    const capability = path.join(app.getAppPath(), 'electron/main/capabilities/keep-awake');
    const { authorization } = require(path.join(capability, 'mac-lid.cjs'));
    const original = cp.ChildProcess.prototype.spawn;
    const worker = `do shift(@ARGV) or die $@ || $!;
      my $socket = connect_studio(@ARGV) or die 'peer PID';
      my $held = 0;
      my $end = guard_session($socket, sub { '' }, sub { $held = 1; 'active' }, sub { $held = 0 }, 24);
      die 'policy still active' if $held;
      print {$socket} "$end\\n";`;
    cp.ChildProcess.prototype.spawn = function(options) {
      if (options.file !== '/usr/bin/osascript') return original.call(this, options);
      if (options.args.includes('studio-lid-fixture-probe')) {
        return original.call(this, { ...options, file: '/usr/bin/printf', args: ['/usr/bin/printf', 'fixture'] });
      }
      if (!options.args.includes(authorization)) throw new Error('Unexpected AppleScript in isolated authorization test');
      const job = JSON.parse(cp.execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: options.args.at(-1) }));
      const args = ['/usr/bin/perl', '-e', worker, path.join(capability, 'lid-guard.pl'), ...job.ProgramArguments.slice(-3)];
      return original.call(this, { ...options, file: args[0], args });
    };
    global.qaRestoreLidFixture = () => { cp.ChildProcess.prototype.spawn = original; };
    return new Promise(resolve => cp.execFile('/usr/bin/osascript', ['-e', 'studio-lid-fixture-probe'],
      (error, stdout) => resolve(!error && stdout === 'fixture')));
  });
  assert.ok(fixtureReady);
  try {
    const notice = frame().locator('#lid-status');
    await toggle.click();
    await frame().getByText('本次已授权，随上方模式生效。').waitFor();
    assert.ok(await toggle.isChecked());
    await frame().getByRole('radio', { name: /^开启/ }).click();
    await frame().getByText(/^合盖运行已生效/).waitFor();
    await toggle.click();
    await frame().getByText(/^临时更改整机休眠/).waitFor();
    assert.equal(await toggle.isChecked(), false);
    assert.match(await notice.innerText(), /20%/);
    await frame().getByRole('radio', { name: /^代理/ }).click();
    await state('代理 · 等待任务');
  } finally { await app.evaluate(() => global.qaRestoreLidFixture()); }
}

async function toggleExtension(enabled) {
  await page.locator('.sidebar-bottom').getByRole('button', { name: '设置', exact: true }).click();
  const nav = page.locator('.settings-navigation');
  await nav.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('tab', { name: '扩展', exact: true }).click();
  const builtins = page.locator('.builtin-extension-section');
  if (!await builtins.evaluate(node => node.open)) await builtins.locator('summary').click();
  await builtins.getByRole('button', { name: '打开 防止电脑休眠 设置' }).click();
  const detail = page.locator('.extension-detail-dialog');
  await detail.getByRole('switch', { name: (enabled ? '启用' : '停用') + ' 防止电脑休眠' }).click();
  await detail.getByRole('switch', { name: (enabled ? '停用' : '启用') + ' 防止电脑休眠', checked: enabled }).waitFor();
  await detail.getByRole('button', { name: '完成', exact: true }).click();
  await nav.getByRole('button', { name: /^返回/ }).click();
}

try {
  await launch();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await state('关闭 · 未生效');
  await nativeAssertion(false);
  const service = page.locator('.runtime-status-trigger');
  const launcher = page.locator('.tools-window-entry');
  await page.mouse.move(12, 12);
  const serviceLeft = (await service.boundingBox()).x;
  const launcherLeft = (await launcher.boundingBox()).x;
  const textEnd = node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().right;
  };
  async function assertStatusSpacing() {
    const awakeEnd = await chip().getByText(/ · /).evaluate(textEnd);
    const countEnd = await service.locator('span').last().evaluate(textEnd);
    const awakeGap = (await service.locator('svg').boundingBox()).x - awakeEnd;
    const serviceGap = (await launcher.locator('svg').boundingBox()).x - countEnd;
    assert.ok(Math.abs(awakeGap - serviceGap) <= 2, `text-to-icon gaps: ${awakeGap}px / ${serviceGap}px`);
    const [awakeBox, serviceBox, launcherBox] = await Promise.all([
      chip().boundingBox(), service.boundingBox(), launcher.boundingBox(),
    ]);
    const firstGap = serviceBox.x - awakeBox.x - awakeBox.width;
    const secondGap = launcherBox.x - serviceBox.x - serviceBox.width;
    assert.ok(Math.abs(firstGap - secondGap) <= 1, `button gaps: ${firstGap}px / ${secondGap}px`);
    assert.ok(Math.abs(serviceBox.x - serviceLeft) <= 1 && Math.abs(launcherBox.x - launcherLeft) <= 1,
      'changing the sleep label keeps both controls to its right in place');
  }
  async function captureStatusBar(file) {
    const bar = await page.locator('.studio-statusbar').boundingBox();
    const left = Math.floor((await chip().boundingBox()).x) - 8;
    await page.screenshot({ path: path.join(output, file), animations: 'disabled', clip: {
      x: left, y: bar.y, width: bar.x + bar.width - left, height: bar.height,
    } });
  }
  async function assertHighlightInsets(button) {
    const [top, bottom] = await button.evaluate(node => {
      const bar = node.closest('.studio-statusbar');
      const row = bar.getBoundingClientRect();
      const hit = node.getBoundingClientRect();
      return [hit.top - row.top - bar.clientTop, row.bottom - hit.bottom];
    });
    assert.ok(top >= 2 && Math.abs(top - bottom) < 1, `footer highlight insets: ${top}px / ${bottom}px`);
  }
  await assertStatusSpacing();
  assert.equal(await chip().locator('.extension-badge').count(), 0);
  const triggerStyle = button => button.evaluate(node => {
    const style = getComputedStyle(node);
    return [style.fontSize, style.color, style.borderWidth, style.backgroundColor, style.paddingInline];
  });
  assert.deepEqual(await triggerStyle(chip()), await triggerStyle(service));
  await service.hover();
  await assertStatusSpacing();
  await assertHighlightInsets(service);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    window.qaStatusMotion = [];
    document.addEventListener('transitionrun', event => {
      if (event.propertyName === 'opacity' && event.target.matches('[data-status-popover]')) {
        const node = event.target;
        window.qaStatusMotion.push([node.getAttribute('aria-label'), node.dataset.statusPopover, node.inert, node.childElementCount]);
      }
    }, true);
  });
  await page.mouse.move(12, 12);
  await captureStatusBar('statusbar-idle.png');
  await openWithSlowView();
  assert.equal(await frame().locator('html').evaluate(node => node.style.colorScheme), 'dark');
  await assertHighlightInsets(chip());
  assert.equal(await frame().getByRole('radio', { name: /^关闭/ }).isChecked(), true);
  await frame().getByRole('radio', { name: /^开启/ }).click();
  await state('开启 · 已生效');
  await assertStatusSpacing();
  await nativeAssertion(true);
  const bounds = await panel().boundingBox();
  const footer = await chip().boundingBox();
  await page.screenshot({ path: path.join(output, 'modes.png'), clip: {
    x: bounds.x - 6, y: bounds.y - 6, width: bounds.width + 12, height: footer.y + footer.height - bounds.y + 8,
  } });
  await frame().getByRole('radio', { name: /^代理/ }).click();
  await state('代理 · 等待任务');
  await assertStatusSpacing();
  await nativeAssertion(false);
  if (process.platform === 'darwin' && (await exec('/usr/bin/pmset', ['-g', 'batt'])).stdout.includes('InternalBattery')) {
    const lid = frame().getByRole('switch', { name: '合盖运行' });
    await lid.waitFor();
    assert.equal(await lid.isChecked(), false);
    assert.match(await frame().locator('#lid-status').innerText(), /管理员授权/);
    assert.equal(await frame().locator('body').evaluate(body => body.scrollHeight <= innerHeight + 1), true);
    await checkLidSwitch(lid);
  }
  const modePanelHeight = await panel().evaluate(node => node.offsetHeight);
  await page.keyboard.press('Escape');
  await page.locator('.studio-status-details').waitFor({ state: 'detached' });
  assert.equal(await chip().evaluate(node => node === document.activeElement), true);
  await service.click();
  const servicePanel = page.locator('.runtime-status-popover');
  await servicePanel.waitFor();
  await page.mouse.move(12, 12);
  await assertHighlightInsets(service);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.runtime-status-popover')).opacity === '1');
  await captureStatusBar('statusbar-highlight.png');
  await servicePanel.getByRole('button', { name: '关闭运行服务' }).click();
  await servicePanel.waitFor({ state: 'detached' });
  const motion = await page.evaluate(() => window.qaStatusMotion);
  for (const name of ['防止电脑休眠', '运行服务']) {
    assert.ok(motion.some(([label, phase]) => label === name && phase === 'open'), name + ' enters');
    assert.ok(motion.some(([label, phase, inert, children]) => label === name && phase === 'closing' && inert && children > 0), name + ' exits with its contents');
  }
  // Reopening mid-exit reverses the same surface instead of unmounting it later.
  await service.click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.runtime-status-popover')).opacity === '1');
  assert.equal(await service.evaluate(async button => {
    const node = document.querySelector('.runtime-status-popover');
    button.click();
    await new Promise(requestAnimationFrame);
    const closing = node.inert;
    button.click();
    await new Promise(requestAnimationFrame);
    await Promise.allSettled(node.getAnimations().map(animation => animation.finished));
    return closing && node.isConnected && !node.inert;
  }), true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await servicePanel.getByRole('button', { name: '关闭运行服务' }).click();
  await servicePanel.waitFor({ state: 'detached' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await openWithSlowView(modePanelHeight);
  assert.equal(await frame().locator('html').evaluate(node => node.style.colorScheme), 'light');
  assert.equal(await panel().evaluate(node => getComputedStyle(node).transitionDuration), '0s');
  await page.keyboard.press('Tab');
  await frame().locator('input[type=radio]:checked').press('Escape');
  await page.locator('.studio-status-details').waitFor({ state: 'detached' });
  assert.ok(await chip().evaluate(node => document.activeElement === node && getComputedStyle(node).outlineStyle === 'none'),
    'Escape from the sandboxed view restores the pointer opener after keyboard navigation inside the panel');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await configureTestModel(page, workspace, model.baseUrl);
  const normalId = await page.evaluate(async cwd => {
    const chat = await window.piApi.createConversation({ cwd, title: '防休眠验收' });
    await window.piApi.conversationSubmit({ id: chat.id, text: 'QA-DONE', requestId: 'qa-keep-awake-normal' });
    return chat.id;
  }, workspace);
  await model.wait('QA-DONE');
  await state('代理 · 已生效');
  await nativeAssertion(true);
  await page.evaluate(() => {
    window.qaTemporary = window.piApi.temporaryPrompt({ id: 'qa-keep-awake', text: 'QA-STOP', modelRef: 'desktop-qa/check' });
  });
  await model.wait('QA-STOP');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await model.reply('QA-DONE', 'finish');
  await page.waitForFunction(async id => !(await window.piApi.conversationSnapshot(id)).running,
    normalId, { polling: 100 });
  await nativeAssertion(true);
  await model.reply('QA-STOP', 'finish');
  await page.evaluate(() => window.qaTemporary);
  await nativeAssertion(false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await state('代理 · 等待任务');

  await openModes();
  await frame().getByRole('radio', { name: /^开启/ }).click();
  await state('开启 · 已生效');
  await toggleExtension(false);
  await chip().waitFor({ state: 'detached' });
  await nativeAssertion(false);
  await app.close();
  app = undefined;
  await launch();
  const items = await page.evaluate(cwd => window.piApi.extensionsUi(cwd), workspace);
  assert.ok(!items.items.some(item => item.extensionId === 'builtin:studio-keep-awake'));
  await nativeAssertion(false);
  await toggleExtension(true);
  await state('开启 · 已生效');
  await nativeAssertion(true);
  await app.close();
  app = undefined;
  await launch();
  await state('开启 · 已生效');
  await nativeAssertion(true);
  await openModes();
  await frame().getByRole('radio', { name: /^关闭/ }).click();
  await state('关闭 · 未生效');
  await nativeAssertion(false);
  console.log('Passed footer layout and motion, lid switch with simulated power writes, concurrent background runs, extension toggle and restart.');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png') });
    console.error('Status chip:', await chip().allTextContents());
    console.error('Mode picker:', await frame().locator('output').allTextContents().catch(() => []));
    const data = await page.evaluate(async () => {
      const opened = await window.piApi.openExtensionDataView({ sourceId: 'builtin:studio-keep-awake/control' });
      await window.piApi.closeExtensionDataView(opened.subscriptionId);
      return opened.snapshot.viewData;
    }).catch(reason => String(reason));
    console.error('Host state:', data);
  }
  throw error;
} finally {
  await model.close();
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}

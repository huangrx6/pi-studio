import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import metrics from '../../electron/main/capabilities/metrics/index.cjs';
import { installPerformanceFixture } from './fixtures/performance.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = new URL('../../', import.meta.url);
const output = new URL('.qa/pi-cursor-writing/', root);
await mkdir(output, { recursive: true });
const scripts = JSON.parse(await readFile(new URL('extensions/pi-project-scripts/pi-studio.extension.json', root), 'utf8'));
const items = [[scripts, 'user'], [metrics.manifests[0], 'builtin']].flatMap(([manifest, scope]) =>
  manifest.contributes.panels.map((panel, sourceOrder) => ({
    ...panel, visibility: 'always', id: `${scope}:${manifest.id}/${panel.id}`, contributionId: panel.id,
    extensionId: manifest.id, extensionName: manifest.name, scope, sourceOrder,
    slot: panel.slot ?? panel.slots[0], slots: panel.slots ?? [panel.slot],
  })),
);

function holdDataViews(items) {
  const pending = new Map();
  window.piApi.extensionsUi = async () => ({ items, errors: [], syncedAt: Date.now(), apiVersion: 1 });
  window.piApi.openExtensionDataView = ({ sourceId }) => new Promise(resolve => {
    pending.set(sourceId, content => resolve({
      subscriptionId: sourceId, snapshot: { sourceId, revision: 1, updatedAt: Date.now(), content },
    }));
  });
  window.finishDataView = (id, content) => pending.get(id)(content);
}

function holdStartup(theme, palette) {
  const prefs = JSON.parse(localStorage.getItem('pi-studio:preferences'));
  localStorage.setItem('pi-studio:preferences', JSON.stringify({ ...prefs, theme, palette }));
  window.piApi.waitForStartup = () => new Promise((resolve, reject) => {
    window.finishStartup = resolve;
    window.failStartup = () => reject(new Error('Synthetic startup failure'));
  });
  window.launchQa = { handoffs: 0 };
  window.piApi.workspaceReady = () => { window.launchQa.handoffs++; };
  const getState = window.piApi.state;
  window.piApi.state = async () => {
    await new Promise(resolve => { window.finishWorkspaceList = resolve; });
    return getState();
  };
}

async function checkLaunchWriting(mark) {
  // Coordinates use the master mark's 64-unit viewBox, so this checks the painted
  // cursor center against the growing ink even when the UI changes display size.
  const frames = await mark.evaluate(el => {
    const symbol = el.querySelector('.launch-symbol').getBoundingClientRect();
    const scale = 64 / symbol.width;
    const beam = el.querySelector('.launch-beam');
    const left = el.querySelector('.launch-leg-left');
    const right = el.querySelector('.launch-leg-right');
    const cursor = el.querySelector('.launch-cursor');
    const word = el.querySelector('.launch-wordmark');
    const duration = cursor.getAnimations()[0].effect.getTiming().duration;
    const animations = el.getAnimations({ subtree: true });
    animations.forEach(animation => animation.pause());
    const frames = {};
    for (const percent of [0, 6, 12, 18, 24, 29, 34, 40, 46, 53, 59, 65, 70, 76, 82, 85, 89, 95, 100, 125]) {
      animations.forEach(animation => { animation.currentTime = duration * percent / 100; });
      const nib = cursor.getBoundingClientRect();
      frames[percent] = {
        beam: (beam.getBoundingClientRect().right - symbol.left) * scale,
        left: (left.getBoundingClientRect().bottom - symbol.top) * scale,
        right: (right.getBoundingClientRect().bottom - symbol.top) * scale,
        x: (nib.left + nib.width * 60.375 / 64 - symbol.left) * scale,
        y: (nib.top + nib.height * 50.375 / 64 - symbol.top) * scale,
        completeInk: Number(getComputedStyle(beam.parentElement, '::after').opacity),
        cursorOpacity: Number(getComputedStyle(cursor).opacity),
        wordOpacity: Number(getComputedStyle(word).opacity),
      };
    }
    return frames;
  });
  const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.1, `${message}: ${actual} vs ${expected}`);
  for (const [t, x, y] of [[0, .25, 13], [24, 55.5, 13], [34, 14.5, 13], [53, 14.5, 53.75], [65, 42.75, 13], [82, 42.75, 53.75], [89, 60.375, 50.375]]) {
    near(frames[t].x, x, `cursor x at ${t}%`);
    near(frames[t].y, y, `cursor y at ${t}%`);
  }
  const strokes = ['beam', 'left', 'right'];
  for (const [start, end, moving, horizontal] of [[0, 24, 'beam', true], [24, 34], [34, 53, 'left'], [53, 65], [65, 82, 'right'], [82, 89], [89, 125]]) {
    let previous = frames[start];
    for (const [t, frame] of Object.entries(frames).filter(([t]) => +t > start && +t <= end)) {
      for (const stroke of strokes) {
        if (stroke === moving) {
          assert.ok(frame[stroke] > previous[stroke], `${stroke} grows at ${t}%`);
          near(frame[stroke], horizontal ? frame.x : frame.y, `${stroke} edge follows the cursor at ${t}%`);
          near(horizontal ? frame.y : frame.x, horizontal ? 13 : frames[start].x, `straight stroke at ${t}%`);
        } else near(frame[stroke], previous[stroke], `${stroke} stays still at ${t}%`);
      }
      previous = frame;
    }
  }
  assert.equal(frames[0].wordOpacity, 0);
  for (const [time, frame] of Object.entries(frames)) assert.equal(frame.completeInk, Number(+time >= 82), `full silhouette at ${time}%`);
  assert.equal(frames[89].cursorOpacity, 1);
  assert.equal(frames[89].wordOpacity, 1);
  assert.deepEqual(frames[95], frames[89], 'the finished signature holds');
  assert.deepEqual(frames[125], frames[100], 'a slow startup keeps the finished mark');
}

async function openWorkspace(page) {
  await page.evaluate(() => window.finishStartup());
  await page.waitForFunction(() => typeof window.finishWorkspaceList === 'function');
  assert.equal(await page.locator('#root').evaluate(el => el.inert), true);
  await page.evaluate(() => {
    window.launchQa.readyAt = performance.now();
    window.finishWorkspaceList();
  });
}

// Record the real transition while the accessibility tree and root are still gated.
function observeLaunch(screen) {
  const qa = window.launchQa;
  const root = document.getElementById('root');
  const observer = new MutationObserver(() => {
    if (screen.isConnected && screen.dataset.leaving && qa.fadeAt === undefined) {
      qa.fadeAt = performance.now();
      qa.inertDuringFade = root.inert;
      const fade = screen.getAnimations()[0];
      qa.fadeDuration = fade?.effect.getTiming().duration;
      if (qa.pauseFade) fade?.pause();
    }
    if (!screen.isConnected) {
      qa.detachedAt = performance.now();
      observer.disconnect();
    }
  });
  observer.observe(screen.parentElement, { childList: true });
  observer.observe(screen, { attributes: true, attributeFilter: ['data-leaving'] });
}

async function checkAlternateStartup(browser, origin, scenario) {
  const reduce = scenario === 'reduced';
  const page = await browser.newPage({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
  try {
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:1,turnCount:2});(${holdStartup})('light','amber');` });
    await page.goto(origin);
    const launch = page.getByRole('status', { name: '正在启动', exact: true });
    await page.waitForFunction(() => typeof window.finishStartup === 'function');
    await launch.evaluate(observeLaunch);
    if (scenario === 'failure') {
      await page.evaluate(() => window.failStartup());
      const alert = page.getByRole('alert');
      await alert.waitFor();
      assert.equal(await alert.innerText(), '启动失败，请重新打开应用。');
      assert.equal(await launch.count(), 0);
      assert.equal(await page.evaluate(() => window.launchQa.handoffs), 0);
    } else {
      if (scenario === 'no-animation') await page.addStyleTag({ content: '.launch-mark *, .launch-strokes::after { animation: none !important; }' });
      if (reduce || scenario === 'no-animation') assert.equal(await launch.evaluate(el => el.getAnimations({ subtree: true }).length), 0);
      else await launch.evaluate(el => el.getAnimations({ subtree: true }).forEach(animation => {
        animation.pause(); animation.currentTime = 180;
      }));
      await openWorkspace(page);
      if (!reduce && scenario !== 'no-animation') {
        await page.locator('.workspace-choice').waitFor({ state: 'attached' });
        assert.equal(await launch.getAttribute('data-leaving'), null);
        if (scenario === 'switch-reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
        else if (scenario === 'cancel') await launch.locator('.launch-cursor').evaluate(el => el.getAnimations()[0].cancel());
        else {
          await launch.locator('.launch-cursor').evaluate(el => {
            window.launchQa.pauseFade = true;
            el.getAnimations()[0].finish();
          });
          await page.waitForFunction(() => window.launchQa.fadeAt !== undefined);
          await page.emulateMedia({ reducedMotion: 'reduce' });
        }
      }
      await launch.waitFor({ state: 'detached', timeout: 4000 });
      const qa = await page.evaluate(() => window.launchQa);
      assert.equal(qa.handoffs, 1);
      if (['cancel', 'switch-fade', 'no-animation'].includes(scenario)) assert.equal(qa.fadeDuration, 240);
      else assert.equal(qa.fadeAt, undefined, 'reduced motion skips the fade');
    }
    assert.equal(await page.locator('#root').evaluate(el => el.inert), false);
    console.log(`${scenario} startup passed`);
  } finally { await page.close(); }
}

const server = await serveProductionRenderer(fileURLToPath(root));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const [theme, width, palette] of [['light', 980, 'amber'], ['dark', 1440, 'berry']]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(server.origin) ? route.continue() : route.abort());
    await page.addInitScript({ content: `(${installPerformanceFixture})({sessionCount:1,turnCount:2});(${holdDataViews})(${JSON.stringify(items)});(${holdStartup})(...${JSON.stringify([theme, palette])});` });
    await page.goto(server.origin);
    const launch = page.getByRole('status', { name: '正在启动', exact: true });
    await page.waitForFunction(() => typeof window.finishStartup === 'function');
    assert.equal(await page.locator('#root').evaluate(el => [el.inert, el.childElementCount].join()), 'true,0');
    const mark = launch.locator('.launch-mark');
    await mark.waitFor({ state: 'visible' });
    assert.equal(await page.locator('html').getAttribute('data-palette'), palette);
    assert.equal((await mark.locator('.launch-wordmark').innerText()).trim(), 'Pi Studio');
    const masks = await mark.locator('.launch-symbol .pi-mark').evaluateAll(parts => parts.map(el => getComputedStyle(el).maskImage));
    assert.equal(masks.length, 2);
    assert.notEqual(masks[0], 'none');
    assert.equal(masks[0], masks[1]);
    assert.equal(await launch.getByRole('button').count(), 0);
    await checkLaunchWriting(mark);
    if (theme === 'dark') {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await launch.evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length), 0);
      const firstFrame = await mark.screenshot();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(firstFrame.equals(await mark.screenshot()), 'the reduced-motion mark stays still');
    }
    await launch.screenshot({ path: fileURLToPath(new URL(`launch-${theme}.png`, output)), animations: 'disabled' });
    // The user's contrast scheme can differ from the saved Studio theme.
    await page.emulateMedia({ forcedColors: 'active', colorScheme: theme === 'dark' ? 'light' : 'dark' });
    const contrast = await launch.evaluate(screen => {
      return {
        body: getComputedStyle(screen.querySelector('.launch-beam')).backgroundColor,
        cursor: getComputedStyle(screen.querySelector('.launch-cursor')).backgroundColor,
        text: getComputedStyle(screen.querySelector('.launch-wordmark')).color,
        backdrop: getComputedStyle(screen).backgroundColor,
      };
    });
    assert.equal(contrast.body, contrast.text);
    assert.equal(contrast.cursor, contrast.text);
    assert.notEqual(contrast.text, contrast.backdrop);
    await page.emulateMedia({ forcedColors: 'none', colorScheme: theme, reducedMotion: 'no-preference' });
    const fast = theme === 'light';
    await launch.evaluate(observeLaunch);
    await mark.evaluate((el, fast) => {
      const animations = el.getAnimations({ subtree: true });
      const cursor = el.querySelector('.launch-cursor').getAnimations()[0];
      window.launchQa.duration = cursor.effect.getTiming().duration;
      for (const animation of animations) {
        if (fast) { animation.pause(); animation.currentTime = 0; }
        else animation.finish();
      }
      cursor.finished.then(() => { window.launchQa.writtenAt = performance.now(); });
    }, fast);
    await openWorkspace(page);
    if (fast) {
      // The application has real data, but its workspace stays inert during writing.
      await page.locator('.workspace-choice').waitFor({ state: 'attached' });
      assert.equal(await launch.getAttribute('data-leaving'), null);
      assert.equal(await page.locator('#root').evaluate(el => el.inert), true);
      await mark.evaluate(el => {
        window.launchQa.playAt = performance.now();
        el.getAnimations({ subtree: true }).forEach(animation => animation.play());
      });
    }
    await launch.waitFor({ state: 'detached', timeout: 8000 });
    const qa = await page.evaluate(() => window.launchQa);
    assert.equal(qa.inertDuringFade, true);
    assert.equal(qa.fadeDuration, 240);
    assert.equal(qa.handoffs, 1);
    assert.ok(qa.detachedAt - qa.fadeAt >= qa.fadeDuration - 35, 'input stays gated throughout the exit fade');
    assert.ok(qa.fadeAt >= qa.writtenAt - 35, 'the fade follows the final hold');
    if (fast) assert.ok(qa.fadeAt - qa.playAt >= qa.duration - 35, 'fast data still presents the full signature');
    else assert.ok(qa.fadeAt - qa.readyAt < qa.duration / 2, 'late data releases the already finished signature promptly');
    assert.equal(await page.locator('#root').evaluate(el => el.inert), false);
    await page.locator('.workspace-choice:not(.has-selection)').waitFor();
    assert.equal(await page.evaluate(() => window.__performanceQa.pageCalls.length), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => {
      const read = window.piApi.conversationPage;
      const held = new Promise(resolve => { window.finishTranscript = resolve; });
      window.piApi.conversationPage = async payload => { await held; return read(payload); };
    });
    await page.locator('.session-row').first().hover();
    await page.locator('.session-row').first().click();
    await page.locator('.chat-loading-line.is-visible').waitFor();
    await page.evaluate(() => window.finishTranscript());
    await page.locator('.assistant-response').first().waitFor();
    assert.equal(await page.evaluate(() => window.__performanceQa.pageCalls.length), 1);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const trigger = page.getByRole('button', { name: '扩展', exact: true });
    const menu = page.getByRole('dialog', { name: '扩展' });
    const row = menu.getByRole('article', { name: metrics.manifests[0].name });
    const scriptsRow = menu.getByRole('article', { name: scripts.name });
    const status = row.getByRole('status');
    // Measure layout independently of the popover's scale-in animation.
    const height = locator => locator.evaluate(el => el.offsetHeight);
    await trigger.click();
    await scriptsRow.getByText('正在读取项目脚本').waitFor();
    await status.getByText('正在连接实时数据').waitFor();
    await status.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    assert.ok(await height(status) <= 20, 'default compact loading fits one text line');
    const pendingHeight = await height(row);
    assert.ok(Math.abs(pendingHeight - await height(scriptsRow)) <= 1, 'default and extension-authored hints have the same row height');
    const icon = status.locator('svg[aria-hidden="true"]');
    assert.equal(await icon.evaluate(el => getComputedStyle(el).color), await status.evaluate(el => getComputedStyle(el).color));
    await menu.screenshot({ path: fileURLToPath(new URL(`menu-${theme}.png`, output)), animations: 'disabled' });

    await page.evaluate(() => {
      document.documentElement.style.setProperty('--loading-icon-size', '14px');
      document.documentElement.style.setProperty('--loading-spin-duration', '2s');
    });
    assert.deepEqual(await icon.evaluate(el => [getComputedStyle(el).width, getComputedStyle(el).animationDuration]), ['14px', '2s']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await icon.evaluate(el => getComputedStyle(el).animationName), 'none');
    assert.equal(await status.evaluate(el => getComputedStyle(el).opacity), '1');
    for (const [content, expected] of [[[{ kind: 'text', text: '32 tok/s' }], '32 tok/s'], [[], '等待首次模型请求']]) {
      await page.evaluate(({ id, content }) => window.finishDataView(id, content), { id: metrics.METRICS_FOOTER_SOURCE_ID, content });
      await row.getByText(expected, { exact: true }).waitFor();
      const resolvedHeight = await height(row);
      assert.ok(Math.abs(pendingHeight - resolvedHeight) <= 1, `${expected}: ${pendingHeight}px pending, ${resolvedHeight}px resolved`);
      assert.equal(await status.count(), 0);
      if (content.length) {
        await trigger.click();
        // Stretch the threshold so the next result arrives deterministically before any visible loading frame.
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(() => document.documentElement.style.setProperty('--loading-delay', '60s'));
        await trigger.click();
        await status.waitFor();
        assert.equal(await status.evaluate(el => getComputedStyle(el).opacity), '0');
      }
    }
    await trigger.click();
    await page.evaluate(() => document.documentElement.style.removeProperty('--loading-delay'));
    let finishSettings;
    const held = new Promise(resolve => { finishSettings = resolve; });
    await page.route('**/GeneralSettings-*.js', async route => { await held; await route.continue(); });
    await page.locator('.sidebar-bottom button[title="设置"]').click();
    const pageIndicator = page.locator('.settings-overlay .loading-pi');
    await pageIndicator.waitFor();
    const motion = () => pageIndicator.evaluate(el => getComputedStyle(el, '::after').animationName);
    assert.equal(await pageIndicator.evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
    assert.equal(await motion(), 'loading-cursor');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await motion(), 'none');
    finishSettings();
    await page.locator('.general-settings').waitFor();
    assert.equal(await launch.count(), 0);
    assert.deepEqual(errors, []);
    console.log(`${theme} · ${width}px · menu row ${pendingHeight}px · ${fast ? 'early' : 'late'} readiness to fade ${Math.round(qa.fadeAt - qa.readyAt)}ms · fade ${Math.round(qa.detachedAt - qa.fadeAt)}ms`);
    await page.close();
  }
  for (const scenario of ['reduced', 'switch-reduced', 'switch-fade', 'no-animation', 'cancel', 'failure']) {
    await checkAlternateStartup(browser, server.origin, scenario);
  }
} finally {
  await browser?.close();
  await server.close();
}

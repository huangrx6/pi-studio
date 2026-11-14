/**
 * Static documentation QA.
 *
 * Opens docs/index.html and docs/guide.html directly from disk, verifies anchor
 * targets, local images, search, theme switching, desktop/mobile overflow, and
 * captures reviewed previews under .qa/docs-preview/.
 */
import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(projectRoot, '.qa/docs-preview');
const guidePath = path.join(projectRoot, 'docs/guide.html');
const indexPath = path.join(projectRoot, 'docs/index.html');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const desktopViewport = { width: 1736, height: 962 };
const page = await browser.newPage({ viewport: desktopViewport, deviceScaleFactor: 2 });
page.setDefaultTimeout(10_000);

const errors = [];
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
page.on('requestfailed', (request) => errors.push(`request: ${request.url()} ${request.failure()?.errorText || ''}`));
await page.emulateMedia({ colorScheme: 'dark' });

async function checkReadingProgress(fraction) {
  await page.evaluate(value => {
    const distance = document.documentElement.scrollHeight - innerHeight;
    window.scrollTo({ top: distance * value, behavior: 'instant' });
  }, fraction);
  await page.waitForFunction(expected => {
    const meter = document.querySelector('.reading-meter i');
    if (!meter) return false;
    const transform = getComputedStyle(meter).transform;
    return transform !== 'none' && Math.abs(new DOMMatrixReadOnly(transform).a - expected) < 0.02;
  }, fraction);
}

try {
  await page.goto(pathToFileURL(guidePath).href);
  await page.getByRole('heading', { name: '使用、扩展与实现手册', exact: true }).waitFor();
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'guide should default to light even when the system prefers dark');

  assert.equal(await page.locator('.doc-section').count(), 28);
  assert.equal(await page.locator('.docs-aside').count(), 0, 'duplicate right-hand chapter navigation should stay removed');
  const missingAnchors = await page.locator('a[href^="#"]').evaluateAll((links) => links
    .map((link) => link.getAttribute('href')?.slice(1))
    .filter(Boolean)
    .filter((id, index, all) => all.indexOf(id) === index)
    .filter((id) => !document.getElementById(id)));
  assert.deepEqual(missingAnchors, []);

  const localImages = await page.locator('img').evaluateAll((images) => images.map((image) => image.src));
  for (const source of localImages) {
    await access(fileURLToPath(source));
  }

  const guideBackground = await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.equal(guideBackground, 'rgb(255, 255, 255)');

  const search = page.getByRole('searchbox', { name: '搜索文档章节', exact: true });
  await search.fill('扩展');
  assert.ok(await page.locator('.nav-group li[data-search]:not(.is-filtered)').count() >= 4);
  await search.fill('no-such-document-topic');
  await page.locator('#searchEmpty.is-visible').waitFor();
  await search.fill('');
  assert.equal(await page.locator('.nav-group:not([hidden])').count(), 6);
  const searchBox = await page.locator('.docs-search').boundingBox();
  const firstNavGroup = await page.locator('.nav-group').first().boundingBox();
  assert.ok(searchBox && firstNavGroup, 'sidebar search and navigation should have layout boxes');
  assert.ok(
    firstNavGroup.y - (searchBox.y + searchBox.height) >= 36,
    'sidebar search should keep at least 36px of breathing room before the first chapter group',
  );
  const guideShellWidth = await page.locator('.docs-shell').evaluate((element) => element.getBoundingClientRect().width);
  const guideNavBox = await page.locator('.nav-inner').boundingBox();
  const guideBrandBox = await page.locator('.brand').boundingBox();
  assert.ok(guideNavBox && guideBrandBox, 'guide navigation should have layout boxes');
  const guideBrandStyle = await page.locator('.brand').evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing];
  });
  const guideNavLinkStyle = await page.locator('.nav-links a').first().evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing, style.textTransform];
  });

  await page.screenshot({ path: path.join(output, 'guide-desktop-light.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '切换到深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)');
  await page.screenshot({ path: path.join(output, 'guide-desktop-dark.png'), animations: 'disabled' });

  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(desktopOverflow <= 1, `desktop overflow: ${desktopOverflow}px`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开文档目录', exact: true }).click();
  await page.waitForFunction(() => document.body.classList.contains('sidebar-open'));
  assert.equal(await page.locator('#menuToggle').getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: path.join(output, 'guide-mobile-dark-menu.png'), animations: 'disabled' });
  const scrimBox = await page.getByRole('button', { name: '关闭文档目录', exact: true }).boundingBox();
  assert.ok(scrimBox, 'mobile sidebar scrim should have a layout box');
  await page.mouse.click(scrimBox.x + scrimBox.width - 18, scrimBox.y + 180);
  await page.waitForFunction(() => !document.body.classList.contains('sidebar-open'));
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(mobileOverflow <= 1, `mobile overflow: ${mobileOverflow}px`);

  await page.setViewportSize(desktopViewport);
  await page.evaluate(() => localStorage.removeItem('pi-studio-theme'));
  await page.goto(pathToFileURL(indexPath).href);
  await page.getByRole('heading', { level: 1, name: /Pi Studio/i }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'home should default to light even when the system prefers dark');
  const homeShellWidth = await page.locator('.wrap').first().evaluate((element) => element.getBoundingClientRect().width);
  const homeNavBox = await page.locator('.nav-in').boundingBox();
  const homeBrandBox = await page.locator('.brand').boundingBox();
  assert.ok(homeNavBox && homeBrandBox, 'home navigation should have layout boxes');
  const homeBrandStyle = await page.locator('.brand').evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing];
  });
  const homeNavLinkStyle = await page.locator('.nav-links a').first().evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing, style.textTransform];
  });
  assert.ok(
    Math.abs(guideShellWidth - homeShellWidth) <= 1,
    `guide shell width ${guideShellWidth}px should match home shell width ${homeShellWidth}px`,
  );
  assert.ok(
    Math.abs(guideNavBox.x - homeNavBox.x) <= 1 && Math.abs(guideNavBox.width - homeNavBox.width) <= 1,
    'guide and home navigation containers should share the same bounds',
  );
  assert.ok(
    Math.abs(guideBrandBox.x - homeBrandBox.x) <= 1,
    'guide and home brand marks should share the same left edge',
  );
  assert.deepEqual(guideBrandStyle, homeBrandStyle, 'guide and home brand typography should match');
  assert.deepEqual(guideNavLinkStyle, homeNavLinkStyle, 'guide and home navigation typography should match');
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)');
  await page.screenshot({ path: path.join(output, 'index-desktop-light.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '切换到深色', exact: true }).click();
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)');
  await page.screenshot({ path: path.join(output, 'index-desktop-dark.png'), animations: 'disabled' });

  const heroShot = page.locator('.hero-screen');
  await heroShot.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.ok(await heroShot.evaluate(link => link === document.activeElement), 'closing the image should return keyboard focus');

  const stage = page.locator('.tour-stage');
  await stage.waitFor();
  for (const id of ['workbench', 'subagents', 'verify', 'workbench']) {
    await page.locator(`#${id}`).evaluate(scene => scene.scrollIntoView({ behavior: 'instant', block: 'center' }));
    await page.locator(`.scene-index [href="#${id}"][aria-current="step"]`).waitFor();
  }
  await page.screenshot({ path: path.join(output, 'index-tour.png'), animations: 'disabled' });

  const gallery = page.locator('[data-gallery]');
  const tabs = gallery.getByRole('tab');
  const panels = gallery.getByRole('tabpanel', { includeHidden: true });
  assert.equal(await tabs.count(), 3, 'the interface gallery should offer three views');
  assert.equal(await panels.count(), 3);
  async function checkGallerySelection(index) {
    const tab = tabs.nth(index);
    const panel = gallery.getByRole('tabpanel');
    assert.equal(await gallery.getByRole('tab', { selected: true }).count(), 1);
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    assert.equal(await panel.count(), 1, 'only the selected view should be exposed');
    assert.equal(await tab.getAttribute('aria-controls'), await panel.getAttribute('id'));
    assert.equal(await panel.getAttribute('aria-labelledby'), await tab.getAttribute('id'));
    await panel.getByRole('img').first().waitFor();
  }
  await checkGallerySelection(0);
  await tabs.nth(1).click();
  await checkGallerySelection(1);
  for (const [key, index] of [['Home', 0], ['ArrowLeft', 2], ['ArrowRight', 0], ['End', 2]]) {
    await page.keyboard.press(key);
    await checkGallerySelection(index);
    assert.ok(await tabs.nth(index).evaluate(tab => tab === document.activeElement), `${key} should move focus to the selected gallery tab`);
  }

  const comparisonSelector = 'section.appearance .appearance-compare';
  const comparison = page.locator(comparisonSelector);
  const slider = comparison.getByRole('slider');
  const splitPosition = () => comparison.evaluate(element => getComputedStyle(element).getPropertyValue('--split').trim());
  assert.equal(await slider.inputValue(), '55');
  assert.equal(await splitPosition(), '55%');
  await slider.evaluate(input => input.scrollIntoView({ behavior: 'instant', block: 'center' }));
  for (const [key, value] of [['End', '100'], ['Home', '0']]) {
    await slider.press(key);
    assert.equal(await slider.inputValue(), value);
    assert.equal(await splitPosition(), value + '%', `${key} should show the complete theme at that end of the slider`);
  }

  await checkReadingProgress(0);
  await checkReadingProgress(0.5);
  await checkReadingProgress(1);
  const filledMeter = await page.locator('.reading-meter i').boundingBox();
  assert.ok(filledMeter && filledMeter.height > 0 && filledMeter.width > 0, 'the filled reading indicator should be painted');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await stage.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.scene-shot:visible').count(), 3, 'all scenes should be readable with reduced motion');
  const stillTransform = await heroShot.evaluate(link => getComputedStyle(link).transform);
  await checkReadingProgress(0);
  assert.equal(await heroShot.evaluate(link => getComputedStyle(link).transform), stillTransform, 'reduced motion should also stop the hero parallax');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await stage.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.scene-shot:visible').count(), 3, 'mobile should show each screenshot beside its description');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile homepage should fit the viewport');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: path.join(output, 'index-mobile.png'), animations: 'disabled' });

  const staticPage = await browser.newPage({ javaScriptEnabled: false, viewport: desktopViewport });
  await staticPage.goto(pathToFileURL(indexPath).href);
  assert.equal(await staticPage.locator('.scene-shot:visible').count(), 3, 'tour should work as a static gallery without JavaScript');
  const staticImages = staticPage.locator('[data-gallery] img:visible');
  assert.equal(await staticImages.count(), 3, 'all three interface views should remain visible without JavaScript');
  const gallerySources = await staticImages.evaluateAll(images => images.map(image => image.getAttribute('src')));
  assert.equal(new Set(gallerySources).size, 3, 'the static gallery should show three different images');
  const themeImages = staticPage.locator(comparisonSelector).getByRole('img');
  assert.equal(await themeImages.count(), 2, 'both themes should be accessible without JavaScript');
  const [firstTheme, secondTheme] = await Promise.all((await themeImages.all()).map(image => image.boundingBox()));
  assert.ok(firstTheme && secondTheme, 'both static themes should have visible image areas');
  const overlapWidth = Math.min(firstTheme.x + firstTheme.width, secondTheme.x + secondTheme.width) - Math.max(firstTheme.x, secondTheme.x);
  const overlapHeight = Math.min(firstTheme.y + firstTheme.height, secondTheme.y + secondTheme.height) - Math.max(firstTheme.y, secondTheme.y);
  assert.ok(overlapWidth <= 1 || overlapHeight <= 1, 'the static theme screenshots should not cover each other');
  const questions = staticPage.locator('details');
  assert.ok(await questions.count() > 0, 'FAQ should be available without JavaScript');
  for (const question of await questions.all()) {
    const summary = question.locator('summary');
    await summary.waitFor();
    if (await question.getAttribute('open') === null) await summary.click();
    const answer = (await question.innerText()).replace(await summary.innerText(), '').trim();
    assert.ok(answer.length > 0, 'opening a FAQ entry should expose its answer');
  }
  for (const source of await staticPage.locator('img[src]').evaluateAll(images => images.map(image => image.src))) {
    await access(fileURLToPath(source));
  }
  await staticPage.close();

  assert.deepEqual(errors, []);
  console.log(`Documentation checks passed; previews saved to ${output}`);
} finally {
  await browser.close();
}

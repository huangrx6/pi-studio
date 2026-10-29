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
  await page.getByRole('heading', { name: /Pi Studio/, exact: false }).first().waitFor();
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
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)');
  await page.screenshot({ path: path.join(output, 'index-desktop-light.png'), animations: 'disabled' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)');
  await page.screenshot({ path: path.join(output, 'index-desktop-dark.png'), animations: 'disabled' });

  assert.deepEqual(errors, []);
  console.log(`Documentation checks passed; previews saved to ${output}`);
} finally {
  await browser.close();
}

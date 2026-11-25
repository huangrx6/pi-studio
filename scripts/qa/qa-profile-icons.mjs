/** Check profile icon editing in the desktop app with a disposable Studio profile. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchTestDesktop } from './fixtures/isolated-desktop.mjs';

const output = fileURLToPath(new URL('../../.qa/profile-icons/', import.meta.url));
const base = await mkdtemp(path.join(os.tmpdir(), 'studio-profile-icons-'));
const workspace = path.join(base, 'workspace');
const profile = path.join(base, 'profile');
await Promise.all([workspace, profile, output].map(directory => mkdir(directory, { recursive: true })));

const errors = [];
const toolIcon = 'ascending';
const permissionIcon = 'inset';
const harnessIcon = 'descending';
const mistBlue = [201, 218, 240, 255];
const warmSand = [235, 213, 175, 255];
const transparent = [0, 0, 0, 0];
const mark = container => container.locator('.settings-profile-icon').first();
const readMark = container => mark(container).evaluate(node => node.dataset.shape);
const readBackground = container => mark(container).evaluate(node => {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.fillStyle = getComputedStyle(node).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  return Array.from(context.getImageData(0, 0, 1, 1).data);
});
const readArtwork = container => mark(container).locator('img').evaluate(async node => {
  await node.decode();
  return node.src;
});
const changeIcon = container => container.getByRole('button', { name: '更换方案图标', exact: true });
let app;
let page;

async function start() {
  ({ app, page } = await launchTestDesktop(workspace, profile, 1360, 860));
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => window.piApi.waitForStartup());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
}

async function open(section, name) {
  const nav = page.locator('.settings-navigation');
  if (!await nav.isVisible()) await page.locator('.sidebar-bottom button[title="设置"]').click();
  await nav.locator(`[data-settings-page="${section}"]`).click();
  const card = page.getByRole('button', { name: '编辑' + name, exact: true });
  await card.waitFor();
  return card;
}

async function edit(card) {
  await card.click();
  const dialog = page.getByRole('dialog', { name: /^编辑(工具|权限)方案/ });
  await changeIcon(dialog).click();
  return dialog;
}

async function save(dialog) {
  await dialog.getByRole('button', { name: '保存方案', exact: true }).click();
  await page.locator('dialog:is(.tool-profile-dialog, .permission-profile-dialog)').waitFor({ state: 'detached' });
}

async function screenshot(name, target = page) {
  await page.locator('.settings-toast').first().waitFor({ state: 'hidden' });
  await target.screenshot({ path: path.join(output, name + '.png'), scale: 'css', animations: 'disabled' });
}

async function verifyPicker(dialog) {
  const tiles = dialog.locator('.profile-shape-preview');
  assert.equal(await tiles.count(), 6);
  assert.equal(await tiles.locator('.profile-shape-check').count(), 1);
  const backgroundChoices = dialog.getByRole('group', { name: '底色', exact: true });
  assert.equal(await backgroundChoices.getByRole('radio').count(), 8);
  assert.ok(await backgroundChoices.getByRole('radio', { name: '跟随主题', exact: true }).isChecked());
  assert.ok(await backgroundChoices.locator('label').evaluateAll(labels => labels.every(label => {
    const swatch = label.querySelector('.profile-background-swatch');
    return Math.abs(swatch.getBoundingClientRect().left - label.lastElementChild.getBoundingClientRect().left) < 1;
  })));
  const [firstSwatch, firstTile] = await Promise.all([
    backgroundChoices.locator('.profile-background-swatch').first().boundingBox(), tiles.first().boundingBox(),
  ]);
  assert.ok(firstSwatch && firstTile && Math.abs(firstSwatch.x - firstTile.x) < 1);
  assert.ok(await tiles.evaluateAll(async nodes => {
    await Promise.all(nodes.map(node => node.querySelector('img').decode()));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    return nodes.every(node => {
      const { width, height } = node.getBoundingClientRect();
      const image = node.querySelector('img');
      const side = image.naturalWidth;
      if (!width || Math.abs(width - height) >= 1 || side !== image.naturalHeight) return false;
      if (getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)') return false;
      canvas.width = canvas.height = side;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, side, side);
      if ([0, side - 1, side * (side - 1), side * side - 1].some(pixel => data[pixel * 4 + 3] >= 16)) return false;
      let left = side, top = side, right = -1, bottom = -1;
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          if (data[(y * side + x) * 4 + 3] < 128) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
      return right >= left && bottom >= top
        && Math.abs(left + right + 1 - side) <= 3 && Math.abs(top + bottom + 1 - side) <= 3;
    });
  }));
  const images = await tiles.locator('.settings-profile-icon').evaluateAll(nodes =>
    Object.fromEntries(nodes.map(node => [node.dataset.shape, node.querySelector('img').src])));
  assert.equal(new Set(Object.values(images)).size, 6);
  return images;
}

async function verifyBinding(label, name, artwork) {
  const trigger = page.getByRole('button', { name: label, exact: true });
  assert.equal(await trigger.locator('.pi-select-value').textContent(), name);
  assert.equal(await readArtwork(trigger), artwork);
  const background = await readBackground(trigger);
  await trigger.press('ArrowDown');
  const menu = page.getByRole('listbox', { name: label, exact: true });
  const chosen = menu.getByRole('option', { name, exact: true, selected: true });
  assert.equal(await readArtwork(chosen), artwork);
  assert.deepEqual(await readBackground(chosen), background);
  const options = menu.getByRole('option');
  assert.equal(await options.locator('.pi-select-leading img').count(), await options.count());
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  return trigger;
}

try {
  await start();
  await app.evaluate(({ dialog }, cwd) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
  }, workspace);
  await page.getByRole('button', { name: '打开工作区', exact: true }).click();
  await page.locator('[data-workspace-cwd]').waitFor();
  const override = await page.evaluate(async cwd => {
    const api = window.piApi;
    await api.selectPermissionProfile({ cwd, id: 'strict-ask', scope: 'workspace' });
    const current = await api.permissionPolicyGet({ cwd });
    const updated = await api.permissionPolicySet({
      cwd, scope: 'workspace', policy: { ...current.effectivePolicy, tools: { read: 'deny' } },
    });
    return updated.scopes.workspace;
  }, workspace);

  const tools = await open('tools', '主对话默认工具');
  const automaticToolIcon = await readMark(tools);
  const unchangedTool = await readMark(page.getByRole('button', { name: '编辑临时对话默认工具', exact: true }));
  let dialog = await edit(tools);
  assert.equal(await dialog.getByRole('button', { name: '保存方案', exact: true }).isEnabled(), false);
  await dialog.getByText('终端', { exact: true }).click();
  assert.deepEqual(await readMark(changeIcon(dialog)), toolIcon);
  const toolIllustrations = await verifyPicker(dialog);
  const darkBackground = await readBackground(changeIcon(dialog));
  assert.ok(darkBackground.slice(0, 3).every(component => component > 160));
  await screenshot('icon-picker');
  await screenshot('tool-icon-choices', dialog.locator('.profile-icon-picker'));
  const originalPalette = await page.evaluate(() => {
    const { dataset } = document.documentElement;
    const original = dataset.palette ?? null;
    dataset.palette = 'amber';
    dataset.theme = 'light';
    return original;
  });
  const lightBackground = await readBackground(changeIcon(dialog));
  assert.ok(lightBackground.slice(0, 3).every(component => component < 100));
  await screenshot('backgrounds-light', dialog.locator('.settings-form-section').first());
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  assert.notDeepEqual(await readBackground(changeIcon(dialog)), darkBackground);
  await page.evaluate(original => {
    const { dataset } = document.documentElement;
    if (original === null) delete dataset.palette;
    else dataset.palette = original;
  }, originalPalette);
  assert.deepEqual(await readBackground(changeIcon(dialog)), darkBackground);
  await save(dialog);
  assert.deepEqual(await readMark(tools), toolIcon);
  assert.deepEqual(await readMark(page.getByRole('button', { name: '编辑临时对话默认工具', exact: true })), unchangedTool);

  dialog = await edit(tools);
  assert.ok(await dialog.getByRole('button', { name: '保存方案', exact: true }).isDisabled());
  await dialog.getByText('雾蓝', { exact: true }).click();
  assert.deepEqual(await readBackground(changeIcon(dialog)), mistBlue);
  assert.deepEqual(await readMark(changeIcon(dialog)), toolIcon);
  await screenshot('backgrounds-dark', dialog.locator('.settings-form-section').first());
  await save(dialog);
  assert.deepEqual(await readBackground(tools), mistBlue);
  await screenshot('agent-tools');

  const permissions = await open('permissions', '严格确认');
  dialog = await edit(permissions);
  await dialog.getByText('守护', { exact: true }).click();
  assert.deepEqual(await readMark(changeIcon(dialog)), permissionIcon);
  const permissionIllustrations = await verifyPicker(dialog);
  await screenshot('permission-picker');
  await screenshot('permission-icon-choices', dialog.locator('.profile-icon-picker'));
  await save(dialog);
  assert.deepEqual(await readMark(permissions), permissionIcon);
  dialog = await edit(permissions);
  await dialog.getByText('透明', { exact: true }).click();
  assert.deepEqual(await readBackground(changeIcon(dialog)), transparent);
  await save(dialog);
  assert.deepEqual(await readBackground(permissions), transparent);
  const workspaceOverride = () => page.evaluate(async cwd => (await window.piApi.permissionPolicyGet({ cwd })).scopes.workspace, workspace);
  assert.deepEqual(await workspaceOverride(), override);
  await screenshot('permission-strategy');

  const harness = await open('harness', 'Studio 编码基线');
  await harness.click();
  const harnessDialog = page.getByRole('dialog', { name: '编辑 Harness 配置', exact: true });
  await changeIcon(harnessDialog).click();
  const harnessIllustrations = await verifyPicker(harnessDialog);
  assert.equal(new Set([toolIllustrations, permissionIllustrations, harnessIllustrations].flatMap(Object.values)).size, 18);
  await screenshot('harness-picker');
  await screenshot('harness-icon-choices', harnessDialog.locator('.profile-icon-picker'));
  await harnessDialog.getByText('运行', { exact: true }).click();
  await harnessDialog.getByText('暖沙', { exact: true }).click();
  assert.deepEqual(await readBackground(changeIcon(harnessDialog)), warmSand);
  await harnessDialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.locator('dialog.harness-profile-dialog').waitFor({ state: 'detached' });
  assert.deepEqual(await readBackground(harness), warmSand);

  await page.locator('.settings-navigation [data-settings-page="agents"]').click();
  const agents = page.locator('.agents-settings');
  await agents.getByRole('button', { name: '当前工作区', exact: true }).click();
  await verifyBinding('主对话工具方案', '主对话默认工具', toolIllustrations[toolIcon]);
  await verifyBinding('主对话权限方案', '严格确认', permissionIllustrations[permissionIcon]);
  await verifyBinding('主对话 Harness 方案', 'Studio 编码基线', harnessIllustrations[harnessIcon]);
  await agents.getByRole('button', { name: '全局默认', exact: true }).click();
  await verifyBinding('主对话工具方案', '主对话默认工具', toolIllustrations[toolIcon]);
  await verifyBinding('主对话权限方案', '帮我批准（默认）', permissionIllustrations.inset);
  await verifyBinding('主对话 Harness 方案', 'Studio 编码基线', harnessIllustrations[harnessIcon]);
  await screenshot('agent-config-main');

  await agents.getByRole('tab', { name: '临时对话', exact: true }).click();
  await verifyBinding('临时对话工具方案', '临时对话默认工具', toolIllustrations.inset);
  await verifyBinding('临时对话权限方案', '严格确认', permissionIllustrations[permissionIcon]);
  const harnessSelect = await verifyBinding('临时对话 Harness 方案', '临时对话基线', harnessIllustrations.inset);
  await screenshot('agent-config-temporary');
  await harnessSelect.click();
  const harnessMenu = page.getByRole('listbox', { name: '临时对话 Harness 方案', exact: true });
  const nextHarness = harnessMenu.getByRole('option', { name: 'Studio 编码基线', exact: true });
  assert.equal(await readArtwork(nextHarness), harnessIllustrations[harnessIcon]);
  assert.deepEqual(await readBackground(nextHarness), warmSand);
  await screenshot('agent-config-options');
  await nextHarness.click();
  await harnessSelect.locator('.pi-select-value').filter({ hasText: 'Studio 编码基线' }).waitFor();
  assert.equal(await readArtwork(harnessSelect), harnessIllustrations[harnessIcon]);
  assert.deepEqual(await readBackground(harnessSelect), warmSand);

  await app.close();
  await start();
  const restoredPermissions = await open('permissions', '严格确认');
  assert.deepEqual(await readMark(restoredPermissions), permissionIcon);
  assert.deepEqual(await readBackground(restoredPermissions), transparent);
  assert.deepEqual(await workspaceOverride(), override);
  const restoredTools = await open('tools', '主对话默认工具');
  assert.deepEqual(await readMark(restoredTools), toolIcon);
  assert.deepEqual(await readBackground(restoredTools), mistBlue);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  assert.deepEqual(await readBackground(restoredTools), mistBlue);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  dialog = await edit(restoredTools);
  await dialog.getByText('跟随主题', { exact: true }).click();
  assert.deepEqual(await readBackground(changeIcon(dialog)), darkBackground);
  await save(dialog);
  assert.deepEqual(await readMark(restoredTools), toolIcon);
  assert.deepEqual(await readBackground(restoredTools), darkBackground);
  dialog = await edit(restoredTools);
  await dialog.getByRole('button', { name: '恢复自动匹配', exact: true }).click();
  assert.deepEqual(await readMark(changeIcon(dialog)), automaticToolIcon);
  await save(dialog);
  assert.deepEqual(await readMark(restoredTools), automaticToolIcon);
  assert.deepEqual(errors, []);
  console.log('Profile icons passed editing, theme and custom backgrounds, restart persistence, and agent configuration display.');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), scale: 'css' }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await rm(base, { recursive: true, force: true });
}

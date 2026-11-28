import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { installConversationFixture } from './fixtures/conversation-refinement.mjs';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = fileURLToPath(new URL('../../.qa/screenshots/sidebar-projects', import.meta.url));
await mkdir(output, { recursive: true });

function installProjects() {
  localStorage.setItem('pi-studio:preferences', JSON.stringify({ theme: 'dark' }));
  const read = window.piApi.state;
  window.piApi.state = async () => {
    const { workspaces: [solo, main], model } = await read();
    const tree = (projectRoot, branch, main) => ({ projectRoot, branch, main, detached: false });
    const linked = '/qa/workspaces/linked';
    return { model, workspaces: [
      { ...solo, name: '文析', worktree: tree(solo.cwd, 'dev', true), sessions: solo.sessions.slice(1, 3) },
      { ...main, name: 'pi-studio', worktree: tree(main.cwd, 'main', true) },
      { cwd: linked, name: '界面调整', worktree: tree(main.cwd, 'feature/sidebar-typography-and-navigation', false),
        sessions: [{ ...main.sessions[0], id: 'linked-review', cwd: linked, title: '侧边栏在小窗口下的显示与操作检查' }] },
      { cwd: '/qa/workspaces/notes', name: '知识问答', sessions: [] },
    ] };
  };
  window.piApi.gitWorkspaceStatus = async () => ({ available: false, reason: 'qa' });
  window.piApi.teamProject = async () => ({ bots: [], rooms: [] });
}

const server = await serveProductionRenderer(root);
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({ content: `(${installConversationFixture})();(${installProjects})();` });
  await page.goto(server.origin);
  const list = page.locator('.workspace-list');
  const solo = list.locator('[data-workspace-cwd="/qa/workspaces/alpha"]');
  const main = list.locator('[data-workspace-cwd="/qa/workspaces/beta"]');
  const linked = list.locator('[data-workspace-cwd="/qa/workspaces/linked"]');
  const group = list.getByRole('button', { name: 'pi-studio', exact: true });
  const soloProject = list.getByRole('button', { name: '文析', exact: true });
  await soloProject.click();
  await solo.locator('.workspace-row').click();
  await solo.locator('.session-row').first().waitFor();
  assert.equal(await solo.locator('.workspace-row').innerText(), 'dev');
  await solo.locator('.workspace-tree-icon').hover();
  await solo.getByRole('tooltip').filter({ hasText: '主工作树 · 文析' }).waitFor();
  assert.equal(await list.locator('.workspace-row').count(), 4);
  const manage = list.getByRole('button', { name: '管理文析的工作树' });
  await soloProject.hover();
  await manage.click();
  const management = page.getByRole('dialog', { name: '管理工作树' });
  await management.getByRole('button', { name: '关闭' }).click();
  await management.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '管理文析的工作树');
  await group.click();
  await main.locator('.workspace-row').click();
  await linked.locator('.workspace-row').click();
  await main.locator('.session-row').click();
  await main.locator('.session-row[aria-current="page"]').waitFor();

  assert.equal(await list.locator('.workspace-row > .lucide-branch').count(), 3);
  assert.equal(await solo.locator('.workspace-tree-icon.lucide-primary-worktree').count(), 1, 'the primary checkout on dev has the dot');
  assert.equal(await linked.locator('.workspace-tree-icon.lucide-folders').count(), 1);
  for (const workspace of [solo, main]) {
    const offset = await workspace.locator('.workspace-label').evaluate(label => {
      const x = document.createElement('i');
      x.style.cssText = 'display:inline-block; width:0; height:1ex; vertical-align:baseline';
      label.querySelector('.workspace-name').append(x);
      const middle = el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
      const difference = middle(label.querySelector('.workspace-tree-icon')) - middle(x);
      x.remove();
      return difference;
    });
    assert.ok(Math.abs(offset) < .1, 'the dot sits on the optical centerline of the branch text');
  }
  const halo = solo.locator('.worktree-dot-halo');
  const animation = () => halo.evaluate(node => getComputedStyle(node).animationName);
  assert.equal(await animation(), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await animation(), 'worktree-breathe');
  assert.ok(await halo.evaluate(node => {
    const slot = node.ownerSVGElement.getBoundingClientRect();
    const pulse = node.getAnimations()[0];
    pulse.pause();
    return [0, 900, 1800].every(time => {
      pulse.currentTime = time;
      const ring = node.getBoundingClientRect();
      return Math.abs(ring.left + ring.width / 2 - (slot.left + slot.width / 2)) < .05
        && Math.abs(ring.top + ring.height / 2 - (slot.top + slot.height / 2)) < .05;
    });
  }), 'the halo stays centered throughout the pulse');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const colors = await halo.evaluate(node => {
    const root = document.documentElement;
    const palette = root.dataset.palette;
    const fills = ['ocean', 'amber', 'berry'].map(value => {
      root.dataset.palette = value;
      return getComputedStyle(node).fill;
    });
    root.dataset.palette = palette;
    return fills;
  });
  assert.equal(new Set(colors).size, 3, 'the dot follows the selected accent');

  for (const width of [1400, 760]) {
    await page.setViewportSize({ width, height: 820 });
    for (const workspace of [solo, main, linked]) {
      const heading = workspace.locator('.workspace-row-shell');
      await heading.hover();
      const geometry = await heading.evaluate(row => {
        const rect = selector => row.querySelector(selector).getBoundingClientRect();
        const label = rect('.workspace-label');
        const actions = rect('.sidebar-row-actions');
        const ref = rect('.workspace-tree-icon');
        const name = rect('.workspace-name');
        return { clear: label.right <= actions.left, refGap: ref.left - name.right };
      });
      assert.ok(geometry.clear, 'the whole label has its own space beside the actions');
      assert.ok(geometry.refGap >= 0 && geometry.refGap <= 8, 'the worktree icon follows the branch');
    }
    await page.mouse.move(width - 10, 20);
    const sidebar = await page.locator('.shell-sidebar').boundingBox();
    const last = await list.locator('.sidebar-project').last().boundingBox();
    await page.screenshot({ path: `${output}/projects-${width}.png`, clip: {
      x: sidebar.x, y: sidebar.y, width: sidebar.width, height: Math.ceil(last.y + last.height - sidebar.y + 12),
    } });
  }

  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await main.locator('.workspace-row').screenshot({ path: `${output}/primary-branch-light.png` });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });

  await page.getByRole('button', { name: '搜索工作区' }).click();
  await page.getByRole('searchbox').fill('小窗口');
  await linked.locator('.session-row').waitFor();
  assert.equal(await group.count(), 1);
  assert.equal(await main.count(), 0);
  assert.equal(await linked.locator('.workspace-name').innerText(), 'feature/sidebar-typography-and-navigation');
  await page.keyboard.press('Tab');
  await linked.locator('.workspace-row').focus();
  await linked.getByRole('tooltip').filter({ hasText: '链接工作树 · 界面调整' }).waitFor();
  await linked.locator('.workspace-row-shell').hover();
  await linked.getByRole('button', { name: '在界面调整中新建对话' }).click();
  await page.locator('.workspace-choice[title="/qa/workspaces/linked"]').waitFor();
  const rail = page.getByRole('navigation', { name: '主导航' });
  await rail.getByRole('button', { name: '更多', exact: true }).click();
  await rail.getByRole('button', { name: '团队', exact: true }).click();
  const team = page.locator('.team-sidebar-projects');
  await team.locator('.workspace-name').first().waitFor();
  assert.deepEqual(await team.locator('.project-name').allTextContents(), ['文析', 'pi-studio', '知识问答']);
  assert.equal(await team.locator('.sidebar-worktree').count(), 3);
  assert.deepEqual(await team.locator('.sidebar-worktree .workspace-name').allTextContents(), ['dev', 'main', 'feature/sidebar-typography-and-navigation']);
  assert.deepEqual(errors, []);
  console.log('Sidebar projects passed at desktop and compact widths');
} finally {
  await browser?.close();
  await server.close();
}

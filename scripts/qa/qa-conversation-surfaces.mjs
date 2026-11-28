import { openSessionInspection } from './fixtures/open-session-inspection.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveProductionRenderer } from './fixtures/production-renderer-server.mjs';
import { installConversationFixture } from './fixtures/conversation-refinement.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const markdown = process.env.QA_MARKDOWN === '1';
const transcript = process.env.QA_TRANSCRIPT === '1';
const output = `${root}/.qa/conversation-surfaces${transcript ? '/transcript' : markdown ? '/markdown' : ''}`;
await mkdir(output, { recursive: true });
const server = await serveProductionRenderer(root);
let browser;
const errors = [];
const results = [];
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  for (const theme of ['dark', 'light']) {
    for (const visibility of [0, 55, 100]) {
      const placement = { 0: 'below', 55: 'above', 100: 'hidden' }[visibility];
      const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('pi-media://background/surface.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs><linearGradient id="g" x2="0.8" y2="1"><stop stop-color="#708fa2"/><stop offset=".55" stop-color="#364955"/><stop offset="1" stop-color="#627c58"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#g)"/><path d="M0 620L350 210L650 590L980 310L1600 700V1000H0Z" fill="#9ba6ac" opacity=".35"/><path d="M0 790Q500 550 900 790T1600 700V1000H0Z" fill="#162e25" opacity=".65"/></svg>' }));
      await page.addInitScript(installConversationFixture);
      await page.addInitScript(({ theme, visibility, placement, markdown, transcript }) => {
        const chip = {
          id: 'builtin:studio-metrics/metrics-chip', contributionId: 'metrics-chip', extensionId: 'builtin:studio-metrics',
          extensionName: 'Studio 指标', scope: 'builtin', title: '实时指标', icon: 'activity', color: 'info',
          slot: 'status.chip', slots: ['status.chip', 'composer.above', 'composer.below'], details: 'metrics-detail',
          content: [{ kind: 'text', text: '最近请求 · 174.2 tok/s · TTFT 2.29 s' }],
        };
        window.piApi.extensionsUi = async () => ({ syncedAt: 1, apiVersion: 1, errors: [], items: [
          chip, { ...chip, id: 'builtin:studio-metrics/metrics-detail', contributionId: 'metrics-detail', slot: 'status.detail', slots: ['status.detail'] },
        ] });
        localStorage.setItem('pi-studio:preferences', JSON.stringify({ theme, showCodeView: transcript, stepCollapse: 'keep-open', extensionPlacements: { [chip.id]: placement }, backgroundMedia: { kind: 'image', url: 'pi-media://background/surface.svg', name: 'surface.svg', mime: 'image/svg+xml', bytes: 600 }, backgroundInsideVisibility: visibility, backgroundOpacity: 80, backgroundSurfaceOpacity: 30 }));
        if (transcript) {
          const original = window.piApi.conversationPage;
          window.piApi.conversationPage = async input => {
            const value = await original(input);
            const at = Date.now() - 60_000;
            value.messages = [
              { role: 'user', timestamp: at, content: [{ type: 'text', text: '请一起检查用户气泡、引用、附件和工具结果，让它们与背景保持协调。' }], attachments: [{ name: '界面审查.md', path: '/qa/workspaces/alpha/review.md', bytes: 1024, lines: 24, kind: 'file', mime: 'text/markdown' }] },
              { role: 'assistant', timestamp: at + 1000, content: [{ type: 'thinking', thinking: '先检查表面层次，再验证展开、悬浮和编辑状态。' }, { type: 'toolCall', id: 'surface-read', name: 'read', arguments: { path: 'web/src/styles/app.css' } }, { type: 'toolCall', id: 'surface-check', name: 'bash', arguments: { command: 'pnpm check' } }, { type: 'toolCall', id: 'surface-write', name: 'write', arguments: { path: '/qa/workspaces/alpha/review.md', content: '# 界面审查\n气泡、引用和工具结果已归为统一的表面层级。' } }] },
              { role: 'toolResult', toolCallId: 'surface-read', toolName: 'read', timestamp: at + 2000, content: [{ type: 'text', text: '用户气泡、附件、工具参数与结果均使用统一的会话表面。' }] },
              { role: 'toolResult', toolCallId: 'surface-check', toolName: 'bash', timestamp: at + 3000, isError: true, content: [{ type: 'text', text: '示例校验未通过：保留红色提示，错误结果仍可清楚阅读。' }] },
              { role: 'toolResult', toolCallId: 'surface-write', toolName: 'write', timestamp: at + 4000, content: [{ type: 'text', text: 'Successfully wrote review.md' }] },
              { role: 'assistant', timestamp: at + 5000, content: [{ type: 'text', text: '### 整体阅读体验\n\n> 引用内容保留左侧标记，并使用轻柔的中性底色。\n\n气泡、附件与展开结果采用统一层次，行内代码 `surface` 保持清楚。\n\n| 内容 | 表面 |\n| --- | --- |\n| 气泡与编辑框 | 柔和突出 |\n| 工具与附件 | 背景自然透出 |' }] },
            ].map((message, sourceIndex) => ({ ...message, sourceIndex }));
            value.messages.splice(value.messages.length - 1, 0, { role: 'toolResult', toolName: 'todo', toolCallId: 'surface-plan', timestamp: at + 4500, content: [{ type: 'text', text: '计划已更新' }], details: { nextId: 3, tasks: [{ id: '1', subject: '核对用户气泡和附件', status: 'completed' }, { id: '2', subject: '检查展开与悬浮状态', activeForm: '正在检查展开与悬浮状态', status: 'in_progress' }] } });
            value.messages.forEach((message, sourceIndex) => { message.sourceIndex = sourceIndex; });
            return value;
          };
        }
        if (markdown) {
          const original = window.piApi.conversationPage;
          window.piApi.conversationPage = async input => {
            const value = await original(input);
            value.messages = [value.messages[0], { role: 'assistant', timestamp: Date.now(), content: [{ type: 'text', text: '### 对话内容的表面层次\n\n代码块与表格使用统一的阅读底，透出背景色。\n\n```text\n计划    全部完成                         24/24\n排队消息 1\n  根据当前任务继续执行，完成后汇总结果。\n  保留文字层级与清晰的分隔线。\n```\n\n| 区域 | 呈现方式 | 阅读体验 |\n| --- | --- | --- |\n| 代码块 | 单层柔和背景 | 保留等宽排版与复制操作 |\n| 语言标题栏 | 轻微明暗区分 | 与代码正文自然衔接 |\n| 表格表头 | 中性浅色层 | 清晰区分列标题 |\n| 行内代码 | `surface-raised` | 柔和标记，不出现实黑块 |\n\n```typescript\nconst appearance = { opacity: 0.55, theme: "dark" };\n// 表面随透明度融合背景\napplyAppearance(appearance);\n```' }] }];
            return value;
          };
        }
      }, { theme, visibility, placement, markdown, transcript });
      await page.goto(server.origin);
      await page.locator('.workspace-row').first().waitFor();
      await page.getByRole('button', { name: '搜索工作区', exact: true }).click();
      const sessionTitle = transcript ? '精准目标' : '运行中的构建检查';
      await page.getByRole('searchbox', { name: '搜索工作区或会话', exact: true }).fill(sessionTitle);
      await page.locator('.session-row').filter({ hasText: sessionTitle }).click();
      await page.locator(transcript ? '.user-bubble' : '.send-button.is-stop').waitFor();
      await page.locator('.composer-editor').focus();
      await page.mouse.move(1400, 20);
      await page.waitForTimeout(250);
      if (markdown || transcript) {
        await page.locator(transcript ? '.markdown blockquote' : '.markdown-code').first().waitFor();
        await page.locator('.chat-scroll').evaluate(element => { element.scrollTop = 0; });
      }
      const surfaces = await page.evaluate(() => {
        const color = selector => document.querySelector(selector) ? getComputedStyle(document.querySelector(selector)).backgroundColor : null;
        return Object.fromEntries(['.chat-header', '.composer-dock', '.composer', '.new-chat', '.session-row.is-active'].map(selector => [selector, color(selector)]));
      });
      assert.equal(surfaces['.composer-dock'], 'rgba(0, 0, 0, 0)', 'dock must not stack another canvas wash');
      assert.match(surfaces['.composer'], /^rgb\(/, 'the editor has an opaque surface');
      if (visibility > 0) {
        assert.equal(surfaces['.chat-header'], 'rgba(0, 0, 0, 0)');
        const baseline = results.find(result => result.theme === theme && result.visibility === 0);
        assert.equal(surfaces['.composer'], baseline.surfaces['.composer'], 'the wallpaper slider only changes the background');
      }
      assert.ok(surfaces['.session-row.is-active'], 'the selected conversation remains visible');
      const dock = page.locator('.composer-dock:visible');
      const summary = dock.getByRole('button', { name: '打开 实时指标 详情' });
      if (placement === 'hidden') {
        assert.equal(await dock.locator('.extension-summaries').count(), 0, 'hidden summaries reserve no row');
      } else {
        await summary.waitFor();
        const chip = await summary.boundingBox(), editor = await dock.locator('.composer').boundingBox();
        const bounds = await dock.boundingBox();
        const below = placement === 'below';
        const gap = below ? chip.y - editor.y - editor.height : editor.y - chip.y - chip.height;
        const outerGap = below ? bounds.y + bounds.height - chip.y - chip.height : chip.y - bounds.y;
        assert.ok(gap >= 0 && gap <= 4, `editor/summary gap: ${gap}px`);
        assert.ok(outerGap >= 0 && outerGap <= 4, `dock inset: ${outerGap}px`);
        assert.equal(chip.height, 24, 'the summary preserves a compact pointer target');
        await dock.screenshot({ path: `${output}/composer-${theme}-${placement}.png` });
      }
      await page.screenshot({ path: `${output}/${theme}-${visibility}.png` });
      if (markdown) await page.locator('.assistant-response').screenshot({ path: `${output}/${theme}-${visibility}-content.png` });
      if (transcript) {
        await page.locator('.activity-tool').filter({ hasText: 'read' }).locator('summary').click();
        await page.locator('.activity-tool.is-error summary').click();
        await page.locator('.activity-tool-code.is-error').waitFor();
        await page.locator('.chat-scroll').evaluate(element => { element.scrollTop = 0; });
        await page.mouse.move(1400, 20);
        await page.screenshot({ path: `${output}/${theme}-${visibility}-expanded.png` });
        await page.locator('.message.user').hover();
        await page.getByRole('button', { name: '编辑消息', exact: true }).click();
        await page.locator('.message-edit').waitFor();
        await page.screenshot({ path: `${output}/${theme}-${visibility}-editing.png` });
        await page.locator('.message-edit-cancel').click();
        await page.locator('.attachment-card').hover();
        await page.screenshot({ path: `${output}/${theme}-${visibility}-hover.png` });
        await openSessionInspection(page);
        await page.locator('.file-change-summary').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${theme}-${visibility}-changes.png` });
        await page.locator('.todo-row.is-active').waitFor();
        await page.mouse.move(1400, 20);
        await page.screenshot({ path: `${output}/${theme}-${visibility}-plan.png` });
        await page.getByRole('button', { name: '关闭会话详情', exact: true }).click();
      }
      assert.equal(await page.locator('.chat-header').getByRole('button', { name: '会话检视' }).count(), 0);
      const workspaceAction = page.getByRole('button', { name: '打开右侧面板', expanded: false, exact: true });
      await workspaceAction.hover();
      assert.notEqual(await workspaceAction.evaluate(async node => {
        await Promise.allSettled(node.getAnimations().map(animation => animation.finished));
        return getComputedStyle(node).backgroundColor;
      }), 'rgba(0, 0, 0, 0)');
      await page.mouse.move(1400, 20);
      await workspaceAction.screenshot({ path: `${output}/${theme}-${visibility}-tools.png` });
      results.push({ theme, visibility, surfaces });
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(`Conversation surfaces: six theme/transparency combinations passed. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}

/**
 * Pi Studio 的主题 / 视觉回归 QA 脚本（本地手动运行）。
 *
 * 与 qa-ui.mjs 不同，本脚本聚焦主题 / 视觉回归：
 * - 亮色 / 暗色下设置页、模型页、对话框、欢迎页、模型菜单、会话与错误态的截图；
 * - 主题切换后 Electron 原生窗口底色是否同步（mock 记录 setTheme 调用）；
 * - 跟随系统、刷新后持久化、小窗口紧凑布局；
 * - 侧边栏会话 / 工作区的 hover、菜单、置顶、重命名、归档恢复、复制 SessionId、
 *   分叉与删除确认等操作。
 *
 * 运行方式：
 *   pnpm run web              # 终端 A：启动 http://127.0.0.1:5180
 *   node scripts/qa-theme.mjs # 终端 B：执行本脚本
 *
 * 可用环境变量：
 *   PREVIEW_URL   覆盖页面地址（默认 http://127.0.0.1:5180）
 *   CHROME_BIN    覆盖 Chrome 可执行文件路径（默认 macOS 的 Google Chrome）
 *
 * 依赖：playwright-core（直接依赖）、本机 Chrome、node:assert、node:fs/promises。
 * 所有 Pi API 都是 addInitScript 注入的本地 fixture，不读写真实凭据、会话或网络；
 * 本脚本不参与 `pnpm test`。
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 1. 浏览器初始化与错误收集
// ---------------------------------------------------------------------------
// 截图输出到 screenshots/themes/。
const output = new URL('../screenshots/themes/', import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
page.setDefaultTimeout(10000);
// 收集未捕获异常，最后断言为空。
const errors = [];
page.on('pageerror', (event) => errors.push(event.message));

// ---------------------------------------------------------------------------
// 2. 注入 PiAPI mock
// ---------------------------------------------------------------------------
await page.addInitScript(() => {
  const cwd = '/workspace/pi-studio';
  // 2.1 当前模型选择（models IPC 的 selection 字段），默认使用 Max。
  const model = {
    modelRef: 'opencode-go/deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    thinkingLevel: 'max',
    thinkingLevels: ['default', 'low', 'high', 'max'],
    effectiveThinkingLevel: 'max',
    defaultThinkingLevel: 'high',
  };
  // 目录里只有一个已启用模型，足够渲染模型菜单。
  const models = [{
    id: model.modelRef,
    provider: 'opencode-go',
    providerName: 'OpenCode Go',
    model: 'deepseek-v4.1-flash',
    name: model.label,
    contextWindow: 1048576,
    reasoning: true,
  }];
  // 两个工作区：第一个带一个会话（侧边栏操作的目标），第二个用于删除确认。
  const workspaces = [
    { cwd, name: 'pi-studio', sessions: [{ id: 'theme-review', cwd, title: '全局主题预览', messageCount: 3, updatedAt: Date.now() }] },
    { cwd: '/workspace/another-project', name: 'another-project', sessions: [] },
  ];

  // 2.2 测试钩子：记录 UI 实际发给“主进程”的数据，供断言检查。
  window.__createdWorkspaces = [];  // createSession 收到的 cwd
  window.__sidebarActions = [];     // sidebarAction 的调用历史
  // window.__nativeTheme / __promptFailure / __chosenWorkspace / __copiedSessionId
  // 会在后续步骤中动态赋值，分别模拟原生主题、发送失败、文件夹选择与剪贴板。

  // 2.3 设置页快照：主题预览主要看“通用 / 模型与账号”两页。
  const snapshot = {
    model,
    providers: [{ id: 'opencode-go', name: 'OpenCode Go', mode: 'key', authConfigured: true, models: 1 }],
    customModels: [],
    enabledModels: [model.modelRef],
    mcp: [{ name: 'filesystem', transport: 'stdio', enabled: true, target: 'node server.js', description: '读取项目文件' }],
    skills: [],
    extensions: [],
    packages: [],
    extensionData: [],
    authPath: '/demo/auth.json',
    mcpPath: '/demo/mcp.json',
    modelsPath: '/demo/models.json',
  };

  // 2.4 会话消息 fixture，覆盖主题需要检查的所有消息形态：
  // 用户文本、思考块、工具调用与结果、markdown（标题/代码/列表/链接）、错误态。
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '请检查全局主题配色，确认代码、图标和状态的可读性。' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '检查背景与文字对比度，并区分运行、成功与错误状态。' },
        { type: 'toolCall', id: 'read-theme', name: 'read', arguments: { path: 'palette.css' } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'read-theme',
      toolName: 'read',
      content: [{ type: 'text', text: '主题变量已读取，亮色与暗色定义完整。' }],
    },
    {
      role: 'assistant',
      content: [{
        type: 'text',
        text: '## 检查结果\n\n背景采用中性灰阶，绿色用于主要操作与选中状态。\n\n```ts\nconst theme = "dark";\nconst contrast = 7.2;\n// 颜色统一来自全局主题\nconsole.log(theme);\n```\n\n- 完成：文字与图标使用全局变量\n- 完成：错误、成功、加载各有独立语义\n\n[查看项目文档](https://example.test/docs)',
      }],
    },
    // stopReason: 'error' + errorMessage 让会话页渲染历史错误气泡。
    { role: 'assistant', content: [], stopReason: 'error', errorMessage: '演示错误状态：连接暂时不可用，请稍后重试。' },
  ];

  // 2.5 PiAPI fixture
  const api = {
    // 发送消息；__promptFailure 被设置时抛错，用于验证错误提示与草稿保留。
    prompt: async () => {
      if (window.__promptFailure) throw new Error(window.__promptFailure);
    },
    // 记录 renderer 请求的原生窗口主题，断言它和页面 dataset.theme 一致。
    setTheme: async (theme) => { window.__nativeTheme = theme; },
    // 工作区列表会过滤 hidden（删除工作区只设置 hidden，不真删 fixture）。
    state: async () => ({ workspaces: workspaces.filter((item) => !item.hidden), cwd, model }),
    // 侧边栏操作统一入口：记录调用，并在 fixture 上执行对应变更。
    sidebarAction: async ({ kind, id, action, name }) => {
      window.__sidebarActions.push({ kind, id, action, name });
      const item = kind === 'workspace'
        ? workspaces.find((entry) => entry.cwd === id)
        : workspaces.flatMap((entry) => entry.sessions).find((entry) => entry.id === id);
      if (!item) throw new Error('Missing fixture');
      // 工作区改名写 name，会话改名写 title。
      if (action === 'rename') item[kind === 'workspace' ? 'name' : 'title'] = name;
      if (action === 'remove') item.hidden = true;
      if (action === 'pin') item.pinned = !item.pinned;
      if (action === 'archive') item.archived = !item.archived;
      if (action === 'fork') {
        const fork = { ...item, id: 'fork-fixture', title: item.title + ' · 分叉', pinned: false, archived: false };
        workspaces.find((entry) => entry.cwd === item.cwd).sessions.push(fork);
        return fork;
      }
      return { ok: true };
    },
    settings: async () => snapshot,
    models: async () => ({ models, current: model.modelRef, enabled: snapshot.enabledModels, selection: model }),
    // 根据 id 找到会话，附上上面那组消息。
    session: async (id) => ({ ...workspaces.flatMap((item) => item.sessions).find((item) => item.id === id), messages }),
    // 新建会话；记录目标工作区，但不会真的加入列表（用于断言“没有意外创建”）。
    createSession: async (selected) => {
      window.__createdWorkspaces.push(selected);
      return { id: 'new', cwd: selected, title: '新会话', messages: [] };
    },
    // “打开其他文件夹…”返回预设路径，由测试动态设置。
    chooseWorkspace: async () => window.__chosenWorkspace,
    composerResources: async () => ({ commands: [] }),
    extensionState: async () => ({ statuses: [], footer: '' }),
    files: async () => ({ path: '', entries: [{ name: 'palette.css', path: 'palette.css', type: 'file', size: 5800 }] }),
    file: async () => ({
      path: 'palette.css',
      size: 5800,
      binary: false,
      text: '/* All colors live in palette.css */\n:root { color-scheme: light; }',
    }),
  };
  // 用 Proxy 兜底：本脚本没实现的方法返回 async no-op；`onXxx` 订阅返回
  // 一个空的取消订阅函数，避免 UI 因缺少通道而崩溃，同时不记录任何真实数据。
  window.piApi = new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (String(key).startsWith('on')) return () => () => {};
      return async () => undefined;
    },
  });
});

// ---------------------------------------------------------------------------
// 3. 通用工具
// ---------------------------------------------------------------------------
// 截图并检查关键容器没有横向溢出（宽度为 0 的隐藏元素跳过）。
async function capture(name) {
  await page.screenshot({ path: `${output}${name}.png`, animations: 'disabled' });
  const overflow = await page
    .locator('.main, .settings-content, .settings-dialog, .model-popover')
    .evaluateAll((elements) => elements
      .filter((element) => element.clientWidth && element.scrollWidth > element.clientWidth + 2)
      .map((element) => element.className));
  assert.deepEqual(overflow, []);
}

// 打开设置并切换到“外观”分页。
async function openAppearanceSettings() {
  await page.locator('.bottom-row').click();
  await page.getByRole('button', { name: '通用', exact: true }).click();
  await page.getByRole('heading', { name: '外观', exact: true }).waitFor();
}

// 点击主题单选项，并等待 <html data-theme> 真正切换。
async function setTheme(name, mode) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, mode);
}

// 确保工作区展开后打开第一个会话（有会话行时直接点，否则先展开工作区）。
async function openFirstSession() {
  if (!await page.locator('.session-row').count()) await page.locator('.workspace-row').first().click();
  await page.locator('.session-row').first().click();
}

// 鼠标悬停到某一行并点击其行内操作按钮（例如“更多操作”）。
async function hoverAndClick(shell, label) {
  await shell.hover();
  await page.getByRole('button', { name: label, exact: true }).click();
}

// ---------------------------------------------------------------------------
// 4. 冷启动：未选择工作区时的草稿与发送拦截
// ---------------------------------------------------------------------------
try {
  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5180');
  await page.locator('.composer textarea').waitFor();
  const workspacePicker = page.getByRole('button', { name: '新对话工作区', exact: true });
  assert.equal(await workspacePicker.innerText(), '选择工作区');

  // 没有工作区时可以先输入草稿，但发送按钮必须禁用；按 Enter 不能创建会话。
  await page.getByRole('textbox', { name: '发送给 Pi 的消息' }).fill('保留这份草稿');
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true);
  await page.getByRole('textbox', { name: '发送给 Pi 的消息' }).press('Enter');
  assert.deepEqual(await page.evaluate(() => window.__createdWorkspaces), []);
  await page.getByRole('alert').filter({ hasText: '请先选择一个工作区' }).waitFor();

  // -------------------------------------------------------------------------
  // 5. 工作区选择：已知工作区、草稿保留与发送失败
  // -------------------------------------------------------------------------
  // 选择列表里的 pi-studio 后发送按钮应启用；取消选择后回到未选状态。
  await workspacePicker.click();
  await page.getByRole('option', { name: 'pi-studio /workspace/pi-studio', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), false);
  await page.getByRole('button', { name: '取消选择工作区' }).click();
  await openAppearanceSettings();
  await page.locator('.settings-back-button').click();
  assert.equal(await workspacePicker.innerText(), '选择工作区');

  // 切换到另一个工作区，之前输入的草稿必须保留。
  await workspacePicker.click();
  await page.getByRole('option', { name: 'another-project /workspace/another-project', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '发送给 Pi 的消息' }).inputValue(), '保留这份草稿');

  // 发送失败（IPC 抛错）时展示错误提示；此时 createSession 已被调用一次，
  // 目标工作区就是 another-project；随后点击“新会话”不应重复创建。
  await page.evaluate(() => { window.__promptFailure = 'Fixture send failure'; });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Fixture send failure' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__createdWorkspaces), ['/workspace/another-project']);
  await page.getByRole('button', { name: '新会话', exact: true }).first().click();
  assert.equal(await workspacePicker.innerText(), 'another-project');
  assert.deepEqual(await page.evaluate(() => window.__createdWorkspaces), ['/workspace/another-project']);
  await page.evaluate(() => { window.__promptFailure = undefined; });

  // -------------------------------------------------------------------------
  // 6. 打开其他文件夹与取消选择
  // -------------------------------------------------------------------------
  // 通过系统选择器打开列表外的新文件夹：草稿要保留，选择器显示文件夹名。
  await page.getByRole('textbox', { name: '发送给 Pi 的消息' }).fill('打开文件夹时保留草稿');
  await page.evaluate(() => { window.__chosenWorkspace = '/workspace/new-folder'; });
  await workspacePicker.click();
  await page.getByRole('option').filter({ hasText: '打开其他文件夹…' }).click();
  await page.waitForFunction(() => document.querySelector('.workspace-choice .pi-select-value')?.textContent === 'new-folder');
  assert.equal(await page.getByRole('textbox', { name: '发送给 Pi 的消息' }).inputValue(), '打开文件夹时保留草稿');

  // 再次打开选择器但选择器返回 undefined（用户取消）：应保持已选文件夹不变。
  await page.evaluate(() => { window.__chosenWorkspace = undefined; });
  await workspacePicker.click();
  await page.getByRole('option').filter({ hasText: '打开其他文件夹…' }).click();
  assert.equal(await workspacePicker.innerText(), 'new-folder');

  // 清空草稿并取消选择工作区，为下一阶段的主题截图准备干净的欢迎页。
  await page.getByRole('textbox', { name: '发送给 Pi 的消息' }).fill('');
  await page.getByRole('button', { name: '取消选择工作区' }).click();

  // -------------------------------------------------------------------------
  // 7. 主题切换：亮色 / 暗色全页面截图
  // -------------------------------------------------------------------------
  await openAppearanceSettings();
  for (const [mode, label] of [['light', '浅色'], ['dark', '深色']]) {
    // setTheme 同时断言原生窗口收到同一个主题值（__nativeTheme）。
    await setTheme(label, mode);
    assert.equal(await page.evaluate(() => window.__nativeTheme), mode);
    await capture(`${mode}-settings`);

    // 设置页：模型与账号 + 添加来源对话框。
    await page.getByRole('button', { name: '模型与账号', exact: true }).click();
    await capture(`${mode}-models`);
    await page.getByRole('button', { name: '添加模型来源', exact: true }).click();
    await page.locator('.settings-dialog').waitFor();
    await capture(`${mode}-dialog`);
    await page.keyboard.press('Escape');
    await page.locator('.settings-back-button').click();

    // 欢迎页的模型选择器、工作区菜单与模型/推理菜单。
    await capture(`${mode}-new-chat`);
    await workspacePicker.click();
    await capture(`${mode}-workspace-menu`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
    await capture(`${mode}-menu`);
    await page.keyboard.press('Escape');

    // 会话页：markdown、思考块展开、滚动到底部的错误气泡。
    await openFirstSession();
    await page.locator('.assistant-response').first().waitFor();
    await capture(`${mode}-conversation`);
    await page.locator('.activity-drawer > summary').first().click();
    await page.locator('.activity-thinking > summary').first().click();
    // 展开后思考预览行应隐藏，避免内容重复。
    assert.equal(await page.locator('.activity-thinking-preview').first().isVisible(), false);
    await capture(`${mode}-thinking-expanded`);
    await page.locator('.chat-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await capture(`${mode}-error`);

    // 回到新会话，再打开外观页准备下一轮主题。
    await page.getByRole('button', { name: '新会话', exact: true }).first().click();
    await openAppearanceSettings();
    // 原流程中这里会再次点击“通用”，保留该步骤。
    await page.getByRole('button', { name: '通用', exact: true }).click();
  }

  // -------------------------------------------------------------------------
  // 8. 跟随系统、持久化与紧凑视口
  // -------------------------------------------------------------------------
  // 系统切到暗色时选择“跟随系统”，页面应变暗；
  // 系统再切回亮色，页面应自动跟随变亮。
  await page.emulateMedia({ colorScheme: 'dark' });
  await setTheme('跟随系统', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');

  // 手动选深色后刷新：主题必须持久化，刷新后仍是 dark。
  await setTheme('深色', 'dark');
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.locator('.composer textarea').waitFor();

  // 切到 980×640 紧凑视口，先截一张欢迎页。
  await page.setViewportSize({ width: 980, height: 640 });
  await capture('dark-compact');

  // -------------------------------------------------------------------------
  // 9. 历史错误不能吞掉新的 IPC / 凭据错误
  // -------------------------------------------------------------------------
  // 打开带历史错误（.assistant-error）的会话，再触发一次发送失败：
  // 新错误必须显示在 composer 的 alert 里，而不是被历史错误吸收。
  await openFirstSession();
  await page.locator('.assistant-error').waitFor();
  await page.evaluate(() => { window.__promptFailure = '无法读取环境变量 EXAMPLE_API_KEY，请重新保存凭据。'; });
  await page.getByRole('textbox', { name: '发送给 Pi 的消息' }).fill('再试一次');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '无法读取环境变量 EXAMPLE_API_KEY' }).waitFor();
  await capture('credential-error-after-history');

  // 回到桌面尺寸，准备检查侧边栏交互。
  await page.setViewportSize({ width: 1440, height: 920 });

  // -------------------------------------------------------------------------
  // 10. 侧边栏会话操作
  // -------------------------------------------------------------------------
  const sessionShell = page.locator('.session-row-shell').filter({ has: page.locator('.session-title', { hasText: '全局主题预览' }) });
  // hover 行后，行内操作按钮应出现；按钮自身的背景必须保持透明，
  // 只有图标颜色在 hover 时变化（视觉规范要求）。
  await sessionShell.hover();
  const hoverIcon = sessionShell.locator('.sidebar-row-actions > button').first();
  const beforeHover = await hoverIcon.evaluate((element) => getComputedStyle(element).color);
  await hoverIcon.hover();
  assert.equal(await hoverIcon.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.waitForFunction(
    ({ label, color }) => getComputedStyle(document.querySelector(`button[aria-label="${label}"]`)).color !== color,
    { label: '全局主题预览的更多操作', color: beforeHover },
  );
  assert.equal(await sessionShell.locator('.sidebar-row-actions').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  await capture('sidebar-session-hover');

  // 会话菜单应有 5 项；置顶后出现 pin 标记。
  await page.getByRole('button', { name: '全局主题预览的更多操作', exact: true }).click();
  assert.equal(await page.getByRole('menuitem').count(), 5);
  await capture('sidebar-session-menu');
  await page.getByRole('menuitem', { name: '置顶会话', exact: true }).click();
  await sessionShell.locator('.session-pin-mark').waitFor({ state: 'attached' });

  // 重命名后，页面标题与会话行都应更新为新名字。
  await hoverAndClick(sessionShell, '全局主题预览的更多操作');
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('已重命名的会话');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('heading', { name: '已重命名的会话', exact: true }).waitFor();
  const renamedShell = page.locator('.session-row-shell').filter({ hasText: '已重命名的会话' });

  // 归档是二次确认操作：点归档按钮只弹确认框，取消后不能产生 archive 调用。
  await hoverAndClick(renamedShell, '归档会话：已重命名的会话');
  assert.equal(await page.evaluate(() => window.__sidebarActions.filter((entry) => entry.action === 'archive').length), 0);
  await capture('sidebar-archive-confirmation');
  await page.getByRole('dialog', { name: '归档这个会话？' }).getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__sidebarActions.filter((entry) => entry.action === 'archive').length), 0);

  // 确认归档 → 查看归档列表 → 恢复会话 → 返回未归档列表。
  await hoverAndClick(renamedShell, '归档会话：已重命名的会话');
  await page.getByRole('dialog', { name: '归档这个会话？' }).getByRole('button', { name: '归档会话', exact: true }).click();
  await page.getByRole('button', { name: '查看归档会话', exact: true }).click();
  await hoverAndClick(renamedShell, '恢复会话：已重命名的会话');
  await page.getByRole('dialog', { name: '恢复这个会话？' }).getByRole('button', { name: '恢复会话', exact: true }).click();
  await page.getByRole('button', { name: '返回未归档会话', exact: true }).click();

  // 复制 SessionId：替换 navigator.clipboard.writeText，断言复制的是会话 id。
  await hoverAndClick(renamedShell, '已重命名的会话的更多操作');
  await page.evaluate(() => { navigator.clipboard.writeText = async (value) => { window.__copiedSessionId = value; }; });
  await page.getByRole('menuitem', { name: '复制 SessionId', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__copiedSessionId), 'theme-review');

  // 分叉同样是二次确认：按 Escape 取消后不能产生 fork 调用；
  // 确认后才出现“已重命名的会话 · 分叉”。
  await hoverAndClick(renamedShell, '已重命名的会话的更多操作');
  await page.getByRole('menuitem', { name: '分叉会话', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__sidebarActions.filter((entry) => entry.action === 'fork').length), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__sidebarActions.filter((entry) => entry.action === 'fork').length), 0);
  await hoverAndClick(renamedShell, '已重命名的会话的更多操作');
  await page.getByRole('menuitem', { name: '分叉会话', exact: true }).click();
  await page.getByRole('dialog', { name: '分叉这个会话？' }).getByRole('button', { name: '创建分叉', exact: true }).click();
  await page.getByRole('heading', { name: '已重命名的会话 · 分叉', exact: true }).waitFor();

  // -------------------------------------------------------------------------
  // 11. 侧边栏工作区操作
  // -------------------------------------------------------------------------
  // 工作区菜单只有 2 项（重命名 / 删除）。
  const workspaceShell = page.locator('.workspace-row-shell').filter({ hasText: 'pi-studio' });
  await hoverAndClick(workspaceShell, 'pi-studio的更多操作');
  assert.equal(await page.getByRole('menuitem').count(), 2);
  await capture('sidebar-workspace-menu');

  // 重命名工作区后，在其中新建对话：选择器显示别名，且不再显示
  // “工作区”占位标签（.workspace-choice-label 数量为 0）。
  await page.getByRole('menuitem', { name: '重命名工作区', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('工作区别名');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const renamedWorkspaceShell = page.locator('.workspace-row-shell').filter({ hasText: '工作区别名' });
  await hoverAndClick(renamedWorkspaceShell, '在工作区别名中新建对话');
  assert.equal(await workspacePicker.innerText(), '工作区别名');
  assert.equal(await page.locator('.workspace-choice-label').count(), 0);

  // 切到浅色主题后，已选工作区的背景应为纯白（rgb(255, 255, 255)）。
  await openAppearanceSettings();
  await setTheme('浅色', 'light');
  await page.locator('.settings-back-button').click();
  assert.equal(await page.locator('.workspace-choice').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
  await capture('workspace-white-no-label');

  // 删除工作区需要二次确认：取消不产生 remove 调用；确认“从侧边栏移除”后
  // 该工作区从列表消失。
  const otherWorkspaceShell = page.locator('.workspace-row-shell').filter({ hasText: 'another-project' });
  await hoverAndClick(otherWorkspaceShell, 'another-project的更多操作');
  await page.getByRole('menuitem', { name: '删除工作区', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__sidebarActions.filter((entry) => entry.action === 'remove').length), 0);
  await page.getByRole('dialog', { name: '删除这个工作区？' }).getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__sidebarActions.filter((entry) => entry.action === 'remove').length), 0);
  await hoverAndClick(otherWorkspaceShell, 'another-project的更多操作');
  await page.getByRole('menuitem', { name: '删除工作区', exact: true }).click();
  await page.getByRole('dialog', { name: '删除这个工作区？' }).getByRole('button', { name: '从侧边栏移除', exact: true }).click();
  await otherWorkspaceShell.waitFor({ state: 'detached' });

  // 整个流程中浏览器不能有未捕获异常。
  assert.deepEqual(errors, []);
  console.log(`Theme UI checks passed. Screenshots: ${output}`);
} finally { await browser.close(); }

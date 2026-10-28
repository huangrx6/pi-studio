// Run against `pnpm run web`. All Pi APIs are replaced with local fixtures;
// this visual check never reads or writes the user's Pi configuration.
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const output = new URL('../screenshots/ui-refinement/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  const cwd = '/workspace/pi-studio';
  const models = [
    { id: 'minimax-cn/MiniMax-M3.1-Flash', name: 'MiniMax M3.1 Flash', provider: 'minimax-cn', providerName: 'MiniMax', model: 'MiniMax-M3.1-Flash' },
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat' },
    { id: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'opencode-go', providerName: 'OpenCode Go', model: 'deepseek-v4.1-flash' },
  ];
  models.push({ id: 'deepseek/not-favorite', name: 'Not a favorite', provider: 'deepseek', providerName: 'DeepSeek', model: 'not-favorite' });
  const preferences = JSON.parse(localStorage.getItem('qa-thinking') || '{}');
  function selection(id) {
    const levels = id.startsWith('opencode-go/') ? ['low', 'high', 'max'] : id.startsWith('minimax-cn/') ? ['low', 'medium', 'high', 'xhigh', 'max'] : [];
    const level = preferences[id] || 'default';
    const fallback = levels.includes('medium') ? 'medium' : levels.includes('high') ? 'high' : 'off';
    return { modelRef: id, label: models.find((item) => item.id === id).name, thinkingLevel: level, thinkingLevels: ['default', ...levels], effectiveThinkingLevel: level === 'default' ? fallback : level, defaultThinkingLevel: fallback };
  }
  let model = selection(localStorage.getItem('qa-model') || models[2].id);
  const snapshot = {
    customModels: [{ providerId: 'minimax-cn', modelId: 'studio-model', name: 'Studio Model', contextWindow: 128000, maxTokens: 8192, supportsImages: true, reasoning: false }],
    providers: [{ id: 'minimax-cn', name: 'MiniMax', mode: 'env', envName: 'MINIMAX_CN_API_KEY', envAvailable: true, models: 3 }, { id: 'deepseek', name: 'DeepSeek', mode: 'api_key', models: 2 }, { id: 'opencode-go', name: 'OpenCode Go', mode: 'key', authConfigured: false, models: 1 }],
    enabledModels: models.slice(0, 3).map((item) => item.id),
    mcp: [{ name: 'filesystem', transport: 'stdio', enabled: true, target: 'npx -y @modelcontextprotocol/server-filesystem /workspace', description: '读取项目文件，理解工作区中的内容。' }, { name: 'project-documents', transport: 'http', enabled: false, target: 'https://example.test/mcp/a-very-long-project-documentation-endpoint', description: '项目资料与团队文档' }],
    skills: [{ name: 'code-review', description: '审查代码的正确性与可维护性，关注边界条件，并给出具体改进建议。', path: '/Users/demo/.pi/agent/skills/code-review/SKILL.md', scope: 'user' }, { name: 'frontend-design', description: '构建清晰、协调的用户界面，统一组件与交互细节。', path: '/Users/demo/workspace/a-long-project-name/.agents/skills/frontend-design/SKILL.md', scope: 'project' }],
    extensions: [{ name: 'workspace-tools', kind: 'directory', scope: 'user', path: '/Users/demo/.pi/agent/extensions/workspace-tools' }],
    packages: [{ name: 'pi-tools', source: 'npm:pi-tools' }], extensionData: ['workspace-tools'],
    authPath: '/Users/demo/.pi/agent/auth.json', mcpPath: '/Users/demo/.pi/agent/mcp.json', modelsPath: '/Users/demo/.pi/agent/models.json', model,
  };
  const providerConfigs = { 'minimax-cn': { providerId: 'minimax-cn', baseUrl: 'https://api.example.test/v1', api: 'openai-completions' }, deepseek: { providerId: 'deepseek', baseUrl: 'https://deepseek.example.test', api: 'openai-completions' } };
  const mcpConfigs = Object.fromEntries(snapshot.mcp.map((server) => [server.name, { name: server.name, transport: server.transport, description: server.description, command: server.transport === 'stdio' ? 'npx' : '', args: server.transport === 'stdio' ? ['-y', '@modelcontextprotocol/server-filesystem', '/workspace/project with spaces'] : [], env: '', url: server.transport === 'http' ? server.target : '' }]));
  const cloneSnapshot = () => structuredClone(snapshot);
  const workspaces = [{ cwd, name: 'pi-studio', sessions: [{ id: 'session-1', cwd, title: '统一工作台的组件与视觉规范', updatedAt: Date.now(), messageCount: 2 }, { id: 'session-2', cwd, title: '优化文件预览和设置页面的排版', updatedAt: Date.now() - 3600000, messageCount: 4 }] }, { cwd: '/workspace/design-system', name: 'design-system', sessions: [] }, { cwd: '/workspace/very-long-project-name-for-layout-verification', name: '很长的项目名称用于验证侧栏截断与对齐', sessions: [] }];
  let listener = () => {};
  window.piApi = {
    state: async () => ({ workspaces, cwd, model }),
    createSession: async () => ({ id: 'new', cwd, title: '新会话', messages: [] }),
    session: async (id) => ({ id, cwd, title: '统一工作台的组件与视觉规范', messages: [{ role: 'user', text: '帮我优化项目的界面，让各个页面更协调、更舒服。' }, { role: 'assistant', text: '我梳理了界面中的布局与组件，可以从以下几个方面改进：\n\n统一基础尺寸\n按钮、输入框、卡片和列表使用一致的间距与圆角，让操作更自然。\n\n整理内容层级\n通过标题、说明和状态的对比，让关键信息更容易找到。\n\n完善边界状态\n为加载、空列表和长文本保留足够的空间，保证小窗口下也能正常使用。' }] }),
    models: async () => { if (window.__failCatalog) throw new Error('模型列表读取失败'); const extra = window.__catalogExtras || []; return { models: [...models, ...extra], enabled: [...snapshot.enabledModels, ...extra.map((item) => item.id)], current: model.modelRef, selection: model }; },
    providerModels: async (provider) => ({ models: models.filter((item) => item.provider === provider).map((item) => ({ ...item, enabled: true, supportsImages: true, contextWindow: 128000 })) }),
    setModel: async (id) => { model = selection(id); snapshot.model = model; localStorage.setItem('qa-model', id); return model; },
    setThinkingLevel: async ({ modelRef, level, cwd: target }) => {
      if (window.__failThinking) throw new Error('保存失败，请重试');
      if (modelRef !== model.modelRef || !model.thinkingLevels.includes(level)) throw new Error('invalid thinking level');
      window.__lastThinking = { modelRef, level, cwd: target };
      preferences[modelRef] = level; localStorage.setItem('qa-thinking', JSON.stringify(preferences));
      model = selection(modelRef); snapshot.model = model; return model;
    },
    settings: async () => cloneSnapshot(),
    providerConfig: async (id) => structuredClone(providerConfigs[id]),
    mcpConfig: async (name) => structuredClone(mcpConfigs[name]),
    setEnabledModels: async (enabled) => { snapshot.enabledModels = enabled; return cloneSnapshot(); },
    setMcpEnabled: async ({ name, enabled }) => { snapshot.mcp.find((item) => item.name === name).enabled = enabled; return cloneSnapshot(); },
    setKey: async () => cloneSnapshot(),
    addCustomModel: async (input) => {
      const index = snapshot.customModels.findIndex((item) => item.providerId === input.providerId && item.modelId === input.modelId);
      if (input.editing) snapshot.customModels[index] = input;
      else snapshot.customModels.push(input);
      return cloneSnapshot();
    },
    addProvider: async (input) => {
      providerConfigs[input.providerId] = { providerId: input.providerId, baseUrl: input.baseUrl, api: input.api };
      if (!input.editing) snapshot.providers.push({ id: input.providerId, name: input.providerId, mode: 'key', models: 1 });
      return { settings: cloneSnapshot(), models: { models, current: model.modelRef, enabled: snapshot.enabledModels, selection: model } };
    },
    addMcp: async (input) => {
      if (input.name !== input.originalName && snapshot.mcp.some((item) => item.name === input.name)) throw new Error('同名 MCP 已存在');
      const index = snapshot.mcp.findIndex((item) => item.name === input.originalName);
      const server = { name: input.name, description: input.description, transport: input.transport, target: input.transport === 'stdio' ? [input.command, ...input.args].join(' ') : input.url, enabled: index >= 0 ? snapshot.mcp[index].enabled : true };
      if (index >= 0) snapshot.mcp[index] = server; else snapshot.mcp.push(server);
      if (input.originalName && input.originalName !== input.name) delete mcpConfigs[input.originalName];
      mcpConfigs[input.name] = input;
      return cloneSnapshot();
    },
    addPackage: async () => cloneSnapshot(), removePackage: async () => cloneSnapshot(),
    addSkill: async () => undefined, addExtension: async () => undefined,
    chooseWorkspace: async () => cwd,
    files: async (_cwd, path) => ({ path, entries: path ? [] : [{ name: 'src', path: 'src', type: 'directory', size: 0 }, { name: 'package.json', path: 'package.json', type: 'file', size: 1397 }, { name: 'a-long-filename-for-checking-file-list-truncation.tsx', path: 'long.tsx', type: 'file', size: 3800 }] }),
    file: async () => ({ path: 'package.json', size: 1397, binary: false, text: '{\n  "name": "pi-studio",\n  "description": "A thoughtfully designed developer workspace",\n  "version": "0.1.0"\n}' }),
    onOpenSettings: () => () => {}, onPrompt: (callback) => { listener = callback; return () => {}; },
    prompt: async ({ requestId }) => { listener({ type: 'delta', requestId, text: '已收到，开始处理。' }); listener({ type: 'done', requestId }); },
  };
});

async function capture(name) {
  await page.screenshot({ path: `${output}${name}.png`, animations: 'disabled' });
  const overflowing = await page.locator('.main, .composer, .settings-content, .settings-card, .settings-form-grid, .provider-card, .model-popover, .settings-dialog, .dialog-body').evaluateAll((elements) => elements.filter((element) => element.scrollWidth > element.clientWidth + 2).map((element) => ({ className: element.className, width: element.clientWidth, scroll: element.scrollWidth })));
  assert.deepEqual(overflowing, [], `Horizontal overflow in ${name}`);
}

try {
  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5180');
  await page.getByRole('heading', { name: '今天想做些什么？', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-chip, .chat-tabs, .chat-scroll').count(), 0);
  await capture('01-welcome');
  await page.getByRole('button', { name: '搜索工作区', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索工作区或会话' }).fill('no-match');
  await page.getByText('没有匹配的工作区或会话').waitFor();
  await page.getByRole('button', { name: '搜索工作区', exact: true }).click();
  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await capture('02-collapsed');
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
  await capture('03-model-settings');
  await page.getByRole('menuitem', { name: /^模型 / }).click();
  await page.getByRole('group', { name: 'OpenCode Go' }).waitFor();
  await capture('03-model-picker');
  assert.equal(await page.getByRole('menuitemradio', { name: 'Not a favorite' }).count(), 0);
  assert.deepEqual(await page.locator('.model-group-name').allTextContents(), ['MiniMax', 'DeepSeek', 'OpenCode Go']);
  await page.getByRole('textbox', { name: '搜索模型', exact: true }).fill('no-match');
  await page.getByText('没有匹配的模型', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: '选择模型' }).count(), 0);
  await page.getByRole('menuitem', { name: /^推理等级/ }).click();
  assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), ['Default', 'Low', 'High', 'Max']);
  await capture('03-thinking-levels');
  await page.getByRole('menuitemradio', { name: 'Max', exact: true }).click();
  await page.locator('.model-popover').waitFor({ state: 'detached' });
  assert.match(await page.getByRole('button', { name: '模型与推理设置', exact: true }).innerText(), /Max/);
  assert.deepEqual(await page.evaluate(() => window.__lastThinking), { modelRef: 'opencode-go/deepseek-v4.1-flash', level: 'max', cwd: '/workspace/pi-studio' });
  await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
  await page.getByRole('menuitem', { name: /^模型 / }).click();
  await page.getByRole('menuitemradio', { name: 'DeepSeek Chat', exact: true }).click();
  await page.locator('.model-popover').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: '推理等级 不支持' }).isDisabled(), true);
  await page.getByRole('menuitem', { name: /^模型 / }).click();
  await page.getByRole('menuitemradio', { name: 'DeepSeek V4.1 Flash', exact: true }).click();
  await page.locator('.model-popover').waitFor({ state: 'detached' });
  assert.match(await page.getByRole('button', { name: '模型与推理设置', exact: true }).innerText(), /Max/);
  await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
  await page.getByRole('menuitem', { name: /^推理等级/ }).click();
  await page.evaluate(() => { window.__failThinking = true; });
  await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '保存失败' }).waitFor();
  assert.equal(await page.getByRole('menuitemradio', { name: 'Max', exact: true }).getAttribute('aria-checked'), 'true');
  await page.evaluate(() => { window.__failThinking = false; });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('heading', { name: '今天想做些什么？', exact: true }).waitFor();
  assert.match(await page.getByRole('button', { name: '模型与推理设置', exact: true }).innerText(), /Max/);
  await page.locator('.session-row').first().click();
  await capture('04-conversation');
  await page.getByRole('button', { name: '文件查看器', exact: true }).click();
  await capture('05-files');
  await page.getByRole('button', { name: 'package.json', exact: false }).click();
  await page.locator('.code-line').first().waitFor();
  await capture('06-file-preview');
  await page.getByRole('button', { name: '关闭文件查看器' }).click();
  await page.locator('.bottom-row').click();
  for (const [index, tab] of ['模型与账号', 'MCP 服务器', '技能', '扩展', '关于'].entries()) {
    await page.locator('.settings-nav-row', { hasText: tab }).click();
    await capture(`${String(index + 7).padStart(2, '0')}-settings-${index}`);
  }
  assert.equal(await page.locator('.settings-title, .page-icon, .page-eyebrow').count(), 0);
  await page.locator('.settings-nav-row', { hasText: '模型与账号' }).click();
  await page.getByRole('button', { name: '管理模型', exact: true }).first().click();
  await page.locator('.provider-model-row').waitFor();
  await capture('12-provider-models');
  const dialog = page.locator('.settings-dialog');
  await page.getByRole('button', { name: '添加模型来源', exact: true }).click();
  await capture('13-add-provider-dialog');
  await dialog.getByLabel('来源 ID', { exact: true }).fill('draft-only');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.provider-card').count(), 3);
  await page.getByRole('button', { name: '编辑 MiniMax', exact: true }).click();
  await dialog.getByLabel('服务地址', { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('服务地址', { exact: true }).inputValue(), 'https://api.example.test/v1');
  assert.equal(await dialog.getByLabel('API Key', { exact: true }).inputValue(), '');
  await dialog.getByLabel('服务地址', { exact: true }).fill('https://gateway.example.test/v1');
  await dialog.getByRole('button', { name: '保存更改', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '编辑 MiniMax', exact: true }).click();
  await dialog.getByLabel('服务地址', { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('服务地址', { exact: true }).inputValue(), 'https://gateway.example.test/v1');
  await capture('14-edit-provider-dialog');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.settings-overlay').count(), 1);
  await page.getByRole('button', { name: '添加自定义模型', exact: true }).click();
  await dialog.getByRole('button', { name: '模型来源', exact: true }).click();
  await page.getByRole('option', { name: 'MiniMax', exact: true }).click();
  await dialog.getByLabel('模型 ID', { exact: true }).fill('new-model');
  await dialog.getByLabel('显示名称', { exact: true }).fill('New Model');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '编辑模型 New Model', exact: true }).click();
  await dialog.getByLabel('显示名称', { exact: true }).fill('Updated Model');
  await dialog.getByLabel('上下文长度', { exact: true }).fill('64000');
  await capture('15-edit-model-dialog');
  await dialog.getByRole('button', { name: '保存更改', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '编辑模型 Updated Model', exact: true }).waitFor();
  assert.equal(await page.locator('.custom-model-row').count(), 2);
  await page.locator('.settings-nav-row', { hasText: 'MCP 服务器' }).click();
  assert.equal(await page.locator('.settings-content').evaluate((element) => element.scrollTop), 0);
  await page.getByRole('button', { name: '添加 MCP 服务器', exact: true }).click();
  await capture('16-add-mcp-dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('filesystem');
  await dialog.getByRole('button', { name: '传输方式', exact: true }).click();
  await page.getByRole('option', { name: 'Streamable HTTP', exact: true }).click();
  await dialog.getByLabel('服务器地址', { exact: true }).fill('https://example.test/mcp');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert.match(await dialog.getByRole('alert').innerText(), /已存在/);
  assert.equal(await dialog.getByLabel('名称', { exact: true }).inputValue(), 'filesystem');
  await capture('17-dialog-validation');
  await dialog.getByLabel('名称', { exact: true }).fill('new-server');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '编辑 new-server', exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑 filesystem', exact: true }).click();
  await dialog.getByLabel('启动参数', { exact: true }).waitFor();
  assert.match(await dialog.getByLabel('启动参数', { exact: true }).inputValue(), /project with spaces/);
  await dialog.getByLabel('描述', { exact: true }).fill('已更新的文件工具');
  await capture('18-edit-mcp-dialog');
  await dialog.getByRole('button', { name: '保存更改', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByText('已更新的文件工具', { exact: true }).waitFor();
  await page.setViewportSize({ width: 980, height: 640 });
  await capture('19-compact-mcp');
  await page.getByRole('button', { name: '编辑 filesystem', exact: true }).click();
  await dialog.getByLabel('启动参数', { exact: true }).waitFor();
  await capture('20-compact-mcp-dialog');
  for (let step = 0; step < 12; step++) await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  for (const [index, tab] of ['模型与账号', '技能', '扩展', '关于'].entries()) {
    await page.locator('.settings-nav-row', { hasText: tab }).click();
    await capture(`21-compact-settings-${index}`);
  }
  await page.locator('.settings-nav-row', { hasText: '技能' }).click();
  await page.getByRole('button', { name: '添加技能', exact: true }).click();
  await capture('22-skill-import-dialog');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.settings-nav-row', { hasText: '扩展' }).click();
  await page.getByRole('button', { name: '安装扩展包', exact: true }).click();
  await capture('23-package-dialog');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '添加本地扩展', exact: true }).click();
  await capture('24-extension-import-dialog');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.getByRole('button', { name: '新会话', exact: true }).first().click();
  await capture('25-compact-welcome');
  await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
  await page.getByRole('menuitem', { name: /^模型 / }).click();
  await page.getByRole('group', { name: 'OpenCode Go' }).waitFor();
  await capture('26-compact-model-picker');
  const bounds = await page.locator('.model-popover').boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 640);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '文件查看器', exact: true }).click();
  await capture('27-compact-files');
  await page.getByRole('button', { name: '关闭文件查看器' }).click();
  await page.evaluate(() => {
    window.__catalogExtras = Array.from({ length: 30 }, (_, index) => ({ id: `custom/long-model-${index}`, provider: 'custom', providerName: '自定义模型来源', model: `long-model-${index}`, name: `Long model name for layout verification ${index}` }));
  });
  await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
  await page.getByRole('menuitem', { name: /^模型 / }).click();
  await page.getByRole('group', { name: '自定义模型来源' }).waitFor();
  const scroll = page.locator('.model-list');
  assert.equal(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight), true);
  await page.getByRole('textbox', { name: '搜索模型', exact: true }).fill('自定义模型来源');
  await page.keyboard.press('ArrowDown');
  assert.match(await page.locator(':focus').innerText(), /Long model/);
  await page.keyboard.press('End');
  assert.match(await page.locator(':focus').innerText(), /29/);
  await capture('28-long-model-list');
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: '发送给 Pi 的消息' }).click({ position: { x: 12, y: 12 } });
  assert.equal(await page.locator('.model-popover').count(), 0);
  await page.evaluate(() => { window.__catalogExtras = []; window.__failCatalog = true; });
  await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '模型列表读取失败' }).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__failCatalog = false; });
  await page.getByRole('textbox', { name: '发送给 Pi 的消息' }).fill('验证从新对话进入问答');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.chat-tabs').waitFor();
  assert.equal(await page.locator('.new-conversation-intro, .workspace-chip').count(), 0);
  await page.getByText('验证从新对话进入问答', { exact: true }).waitFor();
  await capture('29-first-message');
  await page.getByRole('button', { name: '新会话', exact: true }).first().click();
  await page.getByRole('heading', { name: '今天想做些什么？', exact: true }).waitFor();
  assert.equal(await page.locator('.chat-tabs').count(), 0);
  assert.deepEqual(errors, [], 'Browser runtime errors');
  console.log(`UI checks passed; screenshots saved to ${output}`);
} finally { await browser.close(); }

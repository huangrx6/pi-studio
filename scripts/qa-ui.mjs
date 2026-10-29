/**
 * Pi Studio 渲染进程的视觉 / 布局 QA 脚本（本地手动运行）。
 *
 * 它用 Playwright 打开 Vite 开发服务器，在页面加载前注入一整套 PiAPI mock，
 * 然后走一遍接近真实使用的流程：欢迎页 → 侧边栏搜索/折叠 → 模型与推理等级 →
 * 会话与文件面板 → 设置页各分页 → 小窗口紧凑布局 → 长模型列表与错误态 →
 * 首条消息。关键步骤截图到 screenshots/ui-refinement/，同时检查关键容器没有
 * 横向溢出，最后断言浏览器没有运行时错误。
 *
 * 运行方式：
 *   pnpm run web            # 终端 A：启动 http://127.0.0.1:5180
 *   node scripts/qa-ui.mjs  # 终端 B：执行本脚本
 *
 * 可用环境变量：
 *   PREVIEW_URL   覆盖页面地址（默认 http://127.0.0.1:5180）
 *   CHROME_BIN    覆盖 Chrome 可执行文件路径（默认 macOS 的 Google Chrome）
 *
 * 依赖：playwright-core（直接依赖）、本机 Chrome、node:assert、node:fs/promises。
 * 注意：所有 Pi API 都由 addInitScript 在页面加载前替换为本地 fixture，
 * 不会读取或写入用户的 Pi 配置；本脚本不参与 `pnpm test`。
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 1. 浏览器初始化与全局错误收集
// ---------------------------------------------------------------------------
// 产物目录固定为 screenshots/ui-refinement/（已在 .gitignore 中忽略）。
const output = new URL('../screenshots/ui-refinement/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(10000);
// 收集页面未捕获异常，最后断言为空；避免“截图看着正常、控制台其实报错”。
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

// ---------------------------------------------------------------------------
// 2. 注入 PiAPI mock
// ---------------------------------------------------------------------------
// addInitScript 会在每次导航（包括 page.reload）之前执行，因此 mock 必须
// 自带持久化：qa-model / qa-thinking 写入 localStorage，reload 后仍能恢复选择。
await page.addInitScript(() => {
  // 2.1 基础数据：工作区、模型目录与当前选择
  const cwd = '/workspace/pi-studio';
  // 模型条目的字段与 electron 侧 models IPC 的返回结构保持一致：
  // id 是全局引用（provider/model），providerName 用于选择器分组标题。
  const models = [
    { id: 'minimax-cn/MiniMax-M3.1-Flash', name: 'MiniMax M3.1 Flash', provider: 'minimax-cn', providerName: 'MiniMax', model: 'MiniMax-M3.1-Flash' },
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat' },
    { id: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'opencode-go', providerName: 'OpenCode Go', model: 'deepseek-v4.1-flash' },
  ];
  // 第 4 个模型只存在于目录、不在 enabledModels 中，用于验证选择器会过滤它。
  models.push({ id: 'deepseek/not-favorite', name: 'Not a favorite', provider: 'deepseek', providerName: 'DeepSeek', model: 'not-favorite' });

  // 用户上次选择的推理等级按模型保存在 localStorage 里。
  const preferences = JSON.parse(localStorage.getItem('qa-thinking') || '{}');

  // 生成 models IPC 返回的 selection 结构：
  // - thinkingLevels 是 UI 可选项（第一项固定 default）；
  // - thinkingLevel 是用户保存的选择；
  // - effectiveThinkingLevel 是真正下发给 Pi 的等级，default 时按模型能力夹取。
  function selection(id) {
    const levels = id.startsWith('opencode-go/')
      ? ['low', 'high', 'max']
      : id.startsWith('minimax-cn/')
        ? ['low', 'medium', 'high', 'xhigh', 'max']
        : [];
    const level = preferences[id] || 'default';
    // default 的兜底值：优先 medium，其次 high，都没有则 off。
    const fallback = levels.includes('medium') ? 'medium' : levels.includes('high') ? 'high' : 'off';
    return {
      modelRef: id,
      label: models.find((item) => item.id === id).name,
      thinkingLevel: level,
      thinkingLevels: ['default', ...levels],
      effectiveThinkingLevel: level === 'default' ? fallback : level,
      defaultThinkingLevel: fallback,
    };
  }

  let model = selection(localStorage.getItem('qa-model') || models[2].id);

  // 2.2 设置页快照：所有分页共享这一份数据
  const snapshot = {
    // 自定义模型列表；Studio Model 挂在 minimax-cn 下，后面会再新增并编辑另一个模型。
    customModels: [{ providerId: 'minimax-cn', modelId: 'studio-model', name: 'Studio Model', contextWindow: 128000, maxTokens: 8192, supportsImages: true, reasoning: false }],
    // 三个来源卡片：mode 决定展示的认证方式（env / api_key / key）。
    providers: [
      { id: 'minimax-cn', name: 'MiniMax', mode: 'env', envName: 'MINIMAX_CN_API_KEY', envAvailable: true, models: 3 },
      { id: 'deepseek', name: 'DeepSeek', mode: 'api_key', models: 2 },
      { id: 'opencode-go', name: 'OpenCode Go', mode: 'key', authConfigured: false, models: 1 },
    ],
    // 选择器只展示已启用的模型（前三个）。
    enabledModels: models.slice(0, 3).map((item) => item.id),
    // MCP 列表：一条 stdio、一条禁用且 URL 很长的 HTTP，用于测截断与紧凑布局。
    mcp: [
      { name: 'filesystem', transport: 'stdio', enabled: true, target: 'npx -y @modelcontextprotocol/server-filesystem /workspace', description: '读取项目文件，理解工作区中的内容。' },
      { name: 'project-documents', transport: 'http', enabled: false, target: 'https://example.test/mcp/a-very-long-project-documentation-endpoint', description: '项目资料与团队文档' },
    ],
    // 技能分 user / project 两种 scope，project 路径故意很长，用于验证截断。
    skills: [
      { name: 'code-review', description: '审查代码的正确性与可维护性，关注边界条件，并给出具体改进建议。', path: '/Users/demo/.pi/agent/skills/code-review/SKILL.md', scope: 'user' },
      { name: 'frontend-design', description: '构建清晰、协调的用户界面，统一组件与交互细节。', path: '/Users/demo/workspace/a-long-project-name/.agents/skills/frontend-design/SKILL.md', scope: 'project' },
    ],
    // 扩展目录、npm 包，以及已安装扩展的名字列表。
    extensions: [{ name: 'workspace-tools', kind: 'directory', scope: 'user', path: '/Users/demo/.pi/agent/extensions/workspace-tools' }],
    packages: [{ name: 'pi-tools', source: 'npm:pi-tools' }],
    extensionData: ['workspace-tools'],
    // 这些路径只用于设置页展示，mock 不会真的读写。
    authPath: '/Users/demo/.pi/agent/auth.json',
    mcpPath: '/Users/demo/.pi/agent/mcp.json',
    modelsPath: '/Users/demo/.pi/agent/models.json',
    // 当前模型选择，后续 setModel / setThinkingLevel 会同步更新。
    model,
  };

  // 2.3 对话框数据源
  // “编辑来源”表单只读取这几个字段。
  const providerConfigs = {
    'minimax-cn': { providerId: 'minimax-cn', baseUrl: 'https://api.example.test/v1', api: 'openai-completions' },
    deepseek: { providerId: 'deepseek', baseUrl: 'https://deepseek.example.test', api: 'openai-completions' },
  };
  // “编辑 MCP”表单数据：stdio 用 command/args，http 用 url；
  // args 里特意放带空格的路径，验证参数不会被按空格拆坏。
  const mcpConfigs = Object.fromEntries(snapshot.mcp.map((server) => [server.name, {
    name: server.name,
    transport: server.transport,
    description: server.description,
    command: server.transport === 'stdio' ? 'npx' : '',
    args: server.transport === 'stdio' ? ['-y', '@modelcontextprotocol/server-filesystem', '/workspace/project with spaces'] : [],
    env: '',
    url: server.transport === 'http' ? server.target : '',
  }]));
  // 每次 IPC 返回独立副本，模拟真实序列化，避免 UI 误改 fixture 影响后续断言。
  const cloneSnapshot = () => structuredClone(snapshot);

  // 2.4 工作区 / 会话 fixture
  // 第一个工作区有两个会话；第二个为空；第三个名字很长，用于检查侧边栏截断。
  const workspaces = [
    {
      cwd,
      name: 'pi-studio',
      sessions: [
        { id: 'session-1', cwd, title: '统一工作台的组件与视觉规范', updatedAt: Date.now(), messageCount: 2 },
        { id: 'session-2', cwd, title: '优化文件预览和设置页面的排版', updatedAt: Date.now() - 3600000, messageCount: 4 },
      ],
    },
    { cwd: '/workspace/design-system', name: 'design-system', sessions: [] },
    { cwd: '/workspace/very-long-project-name-for-layout-verification', name: '很长的项目名称用于验证侧栏截断与对齐', sessions: [] },
  ];

  // onPrompt 的订阅回调；prompt() 会用它向前端推送流式事件。
  let listener = () => {};
  // 本次会话里发出的消息；模拟主进程落盘，让 session() 返回包含新消息的历史。
  const sentPrompts = [];

  // 2.5 扩展底栏：模拟主进程把扩展的终端组件快照推给渲染层。
  // 文本分段的命中、浮层内容和宽度都由扩展决定，UI 只负责显示与回传坐标。
  // 浮层这里是主进程 normalizePanel 之后的形态：标题、分隔线类型、裁掉外框的偏移。
  const footerCells = (text, tone) => [...text].map((char) => ({ text: char, width: char.codePointAt(0) > 0x2e80 ? 2 : 1, ...(tone ? { tone } : {}) }));
  const footerText = '状态 就绪 · 额度 76% · 上下文 42% · 速度 32 tok/s';
  let footerPanel = false;
  const footerSnapshot = () => ({
    statuses: [],
    footer: footerText,
    view: {
      lines: [footerCells(footerText, 'muted')],
      interactive: true,
      overlay: footerPanel ? {
        lines: [
          [...footerCells('  模型    ', 'muted'), ...footerCells('DeepSeek V4.1 Flash', 'text')],
          [...footerCells('  上下文  ', 'muted'), ...footerCells('42%', 'text'), ...footerCells(' · ', 'faint'), ...footerCells('额度 76%', 'accent')],
          [...footerCells('  速度    ', 'muted'), ...footerCells('32 tok/s', 'text')],
        ],
        rowTypes: ['text', 'text', 'text'],
        title: '运行状态',
        close: { row: 1, col: 40 },
        offset: { row: 3, col: 1 },
        contentWidth: 40,
        col: 1,
        row: 6,
        width: 42,
      } : null,
    },
  });

  // 2.5 暴露给渲染进程的 PiAPI 子集（只实现 UI 会调用的方法）
  const api = {
    // 初始状态：工作区列表、当前目录与当前模型。
    state: async () => ({ workspaces, cwd, model }),
    createSession: async () => {
      // 草稿会话也要立刻出现在侧边栏：主进程的 drafts 会在 state 里返回它。
      if (!workspaces[0].sessions.some((item) => item.id === 'new')) {
        workspaces[0].sessions.unshift({ id: 'new', cwd, title: '新会话', updatedAt: Date.now(), messageCount: 0 });
      }
      return { id: 'new', cwd, title: '新会话', messages: [] };
    },
    // 固定一段用户 + 助手消息，供会话页与 markdown 渲染使用。
    // 注意消息格式必须与主进程 serializeMessage 的输出一致：content 是内容块数组。
    session: async (id) => ({
      id,
      cwd,
      title: '统一工作台的组件与视觉规范',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '帮我优化项目的界面，让各个页面更协调、更舒服。' }], timestamp: Date.now() - 60_000 },
        {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '我梳理了界面中的布局与组件，可以从以下几个方面改进：\n\n统一基础尺寸\n按钮、输入框、卡片和列表使用一致的间距与圆角，让操作更自然。\n\n整理内容层级\n通过标题、说明和状态的对比，让关键信息更容易找到。\n\n完善边界状态\n为加载、空列表和长文本保留足够的空间，保证小窗口下也能正常使用。',
          }],
          timestamp: Date.now(),
        },
        // 发送过的消息会追加到这里，模拟主进程把用户消息写进会话历史。
        ...sentPrompts.map((text) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() })),
      ],
    }),
    // 模型目录：__failCatalog 模拟读取失败，__catalogExtras 用于长列表场景。
    models: async () => {
      if (window.__failCatalog) throw new Error('模型列表读取失败');
      const extra = window.__catalogExtras || [];
      return {
        models: [...models, ...extra],
        enabled: [...snapshot.enabledModels, ...extra.map((item) => item.id)],
        current: model.modelRef,
        selection: model,
      };
    },
    // 某个来源下的模型列表（“管理模型”弹窗使用），补充启用状态与能力字段。
    providerModels: async (provider) => ({
      models: models
        .filter((item) => item.provider === provider)
        .map((item) => ({ ...item, enabled: true, supportsImages: true, contextWindow: 128000 })),
    }),
    // 切换模型：更新内存与 localStorage，保证 reload 后仍选中同一模型。
    setModel: async (id) => {
      model = selection(id);
      snapshot.model = model;
      localStorage.setItem('qa-model', id);
      return model;
    },
    // 保存推理等级：
    // - __lastThinking 记录成功调用的参数，供测试断言 IPC 入参；
    // - __failThinking 模拟保存失败，用于验证 UI 回滚；
    // - preferences 写入 localStorage，reload 后仍能恢复。
    setThinkingLevel: async ({ modelRef, level, cwd: target }) => {
      if (window.__failThinking) throw new Error('保存失败，请重试');
      if (modelRef !== model.modelRef || !model.thinkingLevels.includes(level)) throw new Error('invalid thinking level');
      window.__lastThinking = { modelRef, level, cwd: target };
      preferences[modelRef] = level;
      localStorage.setItem('qa-thinking', JSON.stringify(preferences));
      model = selection(modelRef);
      snapshot.model = model;
      return model;
    },
    settings: async () => cloneSnapshot(),
    providerConfig: async (id) => structuredClone(providerConfigs[id]),
    mcpConfig: async (name) => structuredClone(mcpConfigs[name]),
    setEnabledModels: async (enabled) => {
      snapshot.enabledModels = enabled;
      return cloneSnapshot();
    },
    setMcpEnabled: async ({ name, enabled }) => {
      snapshot.mcp.find((item) => item.name === name).enabled = enabled;
      return cloneSnapshot();
    },
    setKey: async () => cloneSnapshot(),
    // 新增/编辑自定义模型：editing 时按 providerId + modelId 原地替换，否则追加。
    addCustomModel: async (input) => {
      const index = snapshot.customModels.findIndex((item) => item.providerId === input.providerId && item.modelId === input.modelId);
      if (input.editing) snapshot.customModels[index] = input;
      else snapshot.customModels.push(input);
      return cloneSnapshot();
    },
    // 新增/编辑来源：同步更新 providerConfigs；新建时再补一张来源卡片。
    addProvider: async (input) => {
      providerConfigs[input.providerId] = { providerId: input.providerId, baseUrl: input.baseUrl, api: input.api };
      if (!input.editing) snapshot.providers.push({ id: input.providerId, name: input.providerId, mode: 'key', models: 1 });
      return {
        settings: cloneSnapshot(),
        models: { models, current: model.modelRef, enabled: snapshot.enabledModels, selection: model },
      };
    },
    // 新增/编辑 MCP：重名报错、按 originalName 替换、改名时迁移 configs。
    addMcp: async (input) => {
      if (input.name !== input.originalName && snapshot.mcp.some((item) => item.name === input.name)) throw new Error('同名 MCP 已存在');
      const index = snapshot.mcp.findIndex((item) => item.name === input.originalName);
      const server = {
        name: input.name,
        description: input.description,
        transport: input.transport,
        // target 是列表展示用的字符串：stdio 拼命令 + 参数，http 直接用 URL。
        target: input.transport === 'stdio' ? [input.command, ...input.args].join(' ') : input.url,
        enabled: index >= 0 ? snapshot.mcp[index].enabled : true,
      };
      if (index >= 0) snapshot.mcp[index] = server;
      else snapshot.mcp.push(server);
      if (input.originalName && input.originalName !== input.name) delete mcpConfigs[input.originalName];
      mcpConfigs[input.name] = input;
      return cloneSnapshot();
    },
    addPackage: async () => cloneSnapshot(),
    removePackage: async () => cloneSnapshot(),
    addSkill: async () => undefined,
    addExtension: async () => undefined,
    chooseWorkspace: async () => cwd,
    // 只 mock 了根目录；path 非空时返回空列表（本脚本不展开子目录）。
    files: async (_cwd, path) => ({
      path,
      entries: path ? [] : [
        { name: 'src', path: 'src', type: 'directory', size: 0 },
        { name: 'package.json', path: 'package.json', type: 'file', size: 1397 },
        { name: 'a-long-filename-for-checking-file-list-truncation.tsx', path: 'long.tsx', type: 'file', size: 3800 },
      ],
    }),
    // 任意文件都返回同一段 package.json 文本，供预览与代码行渲染。
    file: async () => ({
      path: 'package.json',
      size: 1397,
      binary: false,
      text: '{\n  "name": "pi-studio",\n  "description": "A thoughtfully designed developer workspace",\n  "version": "0.1.0"\n}',
    }),
    // 扩展状态快照与底栏交互。
    extensionState: async () => footerSnapshot(),
    onExtensionFooter: () => () => {},
    footerAction: async (payload) => {
      if (payload.type === 'click' && payload.target === 'footer') footerPanel = true;
      if (payload.type === 'click' && payload.target === 'overlay') footerPanel = false;
      if (payload.type === 'close') footerPanel = false;
      return footerSnapshot().view;
    },
    onOpenSettings: () => () => {},
    // 订阅流式事件，保存回调供 prompt() 使用。
    onPrompt: (callback) => {
      listener = callback;
      return () => {};
    },
    // 第一轮回复：同步推送 delta + done，足够触发“从新对话进入问答”的 UI 切换。
    prompt: async ({ requestId, text }) => {
      sentPrompts.push(text);
      // 标题与消息计数同步到 state 的 fixture 里，供发送后刷新侧边栏。
      const draft = workspaces[0].sessions.find((item) => item.id === 'new');
      if (draft) { draft.title = text.split('\n')[0].slice(0, 40); draft.messageCount = 1; draft.updatedAt = Date.now(); }
      listener({ type: 'delta', requestId, text: '已收到，开始处理。' });
      listener({ type: 'done', requestId });
    },
  };
  // 未显式 mock 的方法统一兜底：onXxx 返回取消订阅函数，其余返回 resolved undefined。
  // App 新增 IPC 调用时，脚本不会因为 mock 缺方法而整页崩溃。
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
// 截图并检查一组关键容器的横向溢出。scrollWidth 超出 clientWidth 2px 以上
// 视为布局问题（例如长文本没有截断、flex 子项被撑破）。
async function capture(name) {
  await page.screenshot({ path: `${output}${name}.png`, animations: 'disabled' });
  const overflowing = await page
    .locator('.main, .composer, .settings-content, .settings-card, .settings-form-grid, .provider-card, .model-popover, .settings-dialog, .dialog-body')
    .evaluateAll((elements) => elements
      .filter((element) => element.scrollWidth > element.clientWidth + 2)
      .map((element) => ({
        className: element.className,
        width: element.clientWidth,
        scroll: element.scrollWidth,
      })));
  assert.deepEqual(overflowing, [], `Horizontal overflow in ${name}`);
}

// 打开“模型与推理设置”弹层并展开“模型”子菜单；调用前弹层应处于关闭状态。
async function openModelMenu() {
  await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
  await page.getByRole('menuitem', { name: /^模型 / }).click();
}

// 点击某个模型单选项，并等待弹层关闭，确认选择已提交。
async function selectModel(name) {
  await page.getByRole('menuitemradio', { name, exact: true }).click();
  await page.locator('.model-popover').waitFor({ state: 'detached' });
}

// 点击设置页左侧的某个分页。
async function openSettingsSection(name) {
  await page.locator('.settings-nav-row', { hasText: name }).click();
}

// ---------------------------------------------------------------------------
// 4. 冷启动与欢迎页
// ---------------------------------------------------------------------------
try {
  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5180');
  await page.getByRole('heading', { name: '今天，想做点什么？', exact: true }).waitFor();
  // 全新启动时不应出现会话相关的容器，欢迎页应保持干净。
  assert.equal(await page.locator('.workspace-chip, .chat-tabs:not(.is-placeholder), .chat-scroll').count(), 0);
  await capture('01-welcome');

  // 侧边栏搜索：空结果时展示占位文案；再次点击搜索按钮收起搜索框，
  // 然后折叠/展开侧边栏，确认折叠态布局正常。
  await page.getByRole('button', { name: '搜索工作区', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索工作区或会话' }).fill('no-match');
  await page.getByText('没有匹配的结果').waitFor();
  await page.getByRole('button', { name: '搜索工作区', exact: true }).click();
  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await capture('02-collapsed');
  await page.getByRole('button', { name: '展开侧边栏' }).click();

  // -------------------------------------------------------------------------
  // 5. 模型选择器与推理等级
  // -------------------------------------------------------------------------
  // 先截一张“模型与推理设置”弹层的默认状态，再进入模型子菜单。
  await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
  await capture('03-model-settings');
  await page.getByRole('menuitem', { name: /^模型 / }).click();
  await page.getByRole('group', { name: 'OpenCode Go' }).waitFor();
  await capture('03-model-picker');

  // 未启用的 "Not a favorite" 不能出现在选择器里；分组顺序应稳定。
  assert.equal(await page.getByRole('menuitemradio', { name: 'Not a favorite' }).count(), 0);
  assert.deepEqual(await page.locator('.model-group-name').allTextContents(), ['MiniMax', 'DeepSeek', 'OpenCode Go']);

  // 搜索无结果时展示空状态；Escape 关闭模型对话框，主弹层仍然保留。
  await page.getByRole('textbox', { name: '搜索模型', exact: true }).fill('no-match');
  await page.getByText('没有匹配的模型', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: '选择模型' }).count(), 0);

  // 推理等级只列出当前模型真正支持的能力（Go DeepSeek 没有 Medium）。
  await page.getByRole('menuitem', { name: /^推理等级/ }).click();
  assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), ['Default', 'Low', 'High', 'Max']);
  await capture('03-thinking-levels');

  // 选择 Max 后：弹层关闭、按钮文案更新、IPC 收到的参数包含当前 cwd。
  await selectModel('Max');
  assert.match(await page.getByRole('button', { name: '模型与推理设置', exact: true }).innerText(), /Max/);
  // 冷启动还没选工作区，cwd 为空串是预期行为（主进程会回退到默认目录）。
  assert.deepEqual(await page.evaluate(() => window.__lastThinking), {
    modelRef: 'opencode-go/deepseek-v4.1-flash',
    level: 'max',
    cwd: '',
  });

  // 切换到不支持推理的 DeepSeek Chat，推理入口应被禁用。
  await openModelMenu();
  await selectModel('DeepSeek Chat');
  await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: '推理等级 不支持' }).isDisabled(), true);

  // 切回支持 Max 的 Go 模型，之前保存的 Max 应自动恢复（弹层此时仍开着）。
  await page.getByRole('menuitem', { name: /^模型 / }).click();
  await selectModel('DeepSeek V4.1 Flash');
  assert.match(await page.getByRole('button', { name: '模型与推理设置', exact: true }).innerText(), /Max/);

  // 保存失败的路径：打开推理菜单，让 IPC 抛错，点击 Low 后应弹出错误提示，
  // 且当前选中项仍停留在 Max（界面不能乐观地改掉已保存值）。
  await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
  await page.getByRole('menuitem', { name: /^推理等级/ }).click();
  await page.evaluate(() => { window.__failThinking = true; });
  await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '保存失败' }).waitFor();
  assert.equal(await page.getByRole('menuitemradio', { name: 'Max', exact: true }).getAttribute('aria-checked'), 'true');
  await page.evaluate(() => { window.__failThinking = false; });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // 刷新页面验证选择已持久化（mock 通过 localStorage 恢复）。
  await page.reload();
  await page.getByRole('heading', { name: '今天，想做点什么？', exact: true }).waitFor();
  assert.match(await page.getByRole('button', { name: '模型与推理设置', exact: true }).innerText(), /Max/);

  // -------------------------------------------------------------------------
  // 6. 会话与文件面板
  // -------------------------------------------------------------------------
  // 冷启动时工作区是收起的：先展开，再点开第一个会话。
  await page.locator('.workspace-row').first().click();
  await page.locator('.session-row').first().click();
  await capture('04-conversation');

  // 统一状态栏：setFooter 收敛成一个紧凑指标 chip，点击展开完整详情。
  const footerChip = page.locator('.status-chip.is-footer');
  await footerChip.waitFor();
  assert.match(await footerChip.innerText(), /状态 就绪/);
  await footerChip.click();
  await page.locator('.status-dock-popover').waitFor();
  assert.match(await page.locator('.status-dock-detail').innerText(), /额度 76%/);
  await capture('04b-status-dock');
  await page.locator('.status-dock-close').first().click();
  await page.locator('.status-dock-popover').waitFor({ state: 'detached' });
  // 状态栏管理：顺序与显隐。
  await page.locator('.status-dock-manage').click();
  await page.locator('.status-manage-list').waitFor();
  assert.ok(await page.locator('.status-manage-row').count() > 0);
  await capture('04c-status-manage');
  await page.locator('.status-dock-close').first().click();
  await page.locator('.status-dock-popover').waitFor({ state: 'detached' });

  // 打开文件查看器，读取根目录列表，再点开 package.json 预览代码。
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  // 面板默认停在「开始」页，先切到文件标签再等文件列表。
  await page.getByRole('button', { name: '打开工作区文件', exact: true }).click();
  await capture('05-files');
  await page.getByRole('button', { name: 'package.json', exact: false }).click();
  await page.locator('.code-line').first().waitFor();
  await capture('06-file-preview');
  await page.getByRole('button', { name: '收起右侧面板' }).click();

  // -------------------------------------------------------------------------
  // 7. 设置页
  // -------------------------------------------------------------------------
  // 从底部入口进入设置，逐个切换分页并截图（07~11）。
  await page.locator('.bottom-row').click();
  for (const [index, tab] of ['模型与账号', 'MCP 服务器', '技能', '扩展', '关于'].entries()) {
    await openSettingsSection(tab);
    await capture(`${String(index + 7).padStart(2, '0')}-settings-${index}`);
  }
  // 设置页不应出现独立页面级别的大标题 / 图标（保持紧凑的设置面板风格）。
  assert.equal(await page.locator('.settings-title, .page-icon, .page-eyebrow').count(), 0);

  // 7.1 模型与账号：来源列表、来源编辑对话框的草稿与保存
  await openSettingsSection('模型与账号');
  await page.getByRole('button', { name: '管理模型', exact: true }).first().click();
  await page.locator('.provider-model-row').waitFor();
  await capture('12-provider-models');
  const dialog = page.locator('.settings-dialog');

  // 新增来源对话框：填写后取消，不能留下草稿卡片。
  await page.getByRole('button', { name: '添加模型来源', exact: true }).click();
  await capture('13-add-provider-dialog');
  await dialog.getByLabel('来源 ID', { exact: true }).fill('draft-only');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.provider-card').count(), 3);

  // 编辑已有来源：地址从 mock 配置回填，API Key 永远不回显（安全要求）；
  // 修改并保存后再次打开，确认新地址已持久化到表单数据源。
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
  // Escape 只应关闭对话框，底层设置页仍然打开。
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.settings-overlay').count(), 1);

  // 7.2 自定义模型：新增后在列表中编辑，名称与上下文长度应更新，
  // 且原有 Studio Model 仍保留（共两行）。
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

  // 7.3 MCP 服务器：切换分页后内容应回到顶部；新增时重名要展示行内错误，
  // 修改名称后可成功创建；编辑已有服务器应保留带空格的启动参数。
  await openSettingsSection('MCP 服务器');
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

  // -------------------------------------------------------------------------
  // 8. 小窗口 / 紧凑布局（980×640）
  // -------------------------------------------------------------------------
  await page.setViewportSize({ width: 980, height: 640 });
  await capture('19-compact-mcp');

  // 紧凑视口下的 MCP 编辑对话框：连续 Tab 12 次，焦点必须仍被限制在
  // dialog 内（焦点陷阱），Escape 可关闭。
  await page.getByRole('button', { name: '编辑 filesystem', exact: true }).click();
  await dialog.getByLabel('启动参数', { exact: true }).waitFor();
  await capture('20-compact-mcp-dialog');
  for (let step = 0; step < 12; step++) await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // 紧凑视口下依次检查设置页其余分页（21 系列）。
  for (const [index, tab] of ['模型与账号', '技能', '扩展', '关于'].entries()) {
    await openSettingsSection(tab);
    await capture(`21-compact-settings-${index}`);
  }

  // 技能导入、npm 扩展包安装、本地扩展导入三个对话框都应能正常打开/取消。
  await openSettingsSection('技能');
  await page.getByRole('button', { name: '添加全局技能', exact: true }).click();
  await capture('22-skill-import-dialog');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await openSettingsSection('扩展');
  await page.getByRole('button', { name: '安装扩展包', exact: true }).click();
  await capture('23-package-dialog');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '添加本地扩展', exact: true }).click();
  await capture('24-extension-import-dialog');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // 关闭设置回到欢迎页，确认紧凑视口下欢迎页没有残留的旧会话容器。
  await page.getByRole('button', { name: '返回对话' }).click();
  await page.getByRole('button', { name: '新会话', exact: true }).first().click();
  await capture('25-compact-welcome');

  // 紧凑视口下模型弹层不能超出视口高度（boundingBox 需完全落在 0~640 内）。
  await openModelMenu();
  await page.getByRole('group', { name: 'OpenCode Go' }).waitFor();
  await capture('26-compact-model-picker');
  const bounds = await page.locator('.model-popover').boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 640);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // 紧凑视口下的文件面板。
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  await capture('27-compact-files');
  await page.getByRole('button', { name: '收起右侧面板' }).click();

  // -------------------------------------------------------------------------
  // 9. 长模型列表与错误态
  // -------------------------------------------------------------------------
  // 注入 30 个长名字模型：列表应出现滚动条；搜索过滤后键盘上下键仍可用，
  // End 键跳到最后一个结果（名字含 29）。
  await page.evaluate(() => {
    window.__catalogExtras = Array.from({ length: 30 }, (_, index) => ({
      id: `custom/long-model-${index}`,
      provider: 'custom',
      providerName: '自定义模型来源',
      model: `long-model-${index}`,
      name: `Long model name for layout verification ${index}`,
    }));
  });
  await openModelMenu();
  await page.getByRole('group', { name: '自定义模型来源' }).waitFor();
  const scroll = page.locator('.model-list');
  assert.equal(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight), true);
  const modelSearch = page.getByRole('textbox', { name: '搜索模型', exact: true });
  await modelSearch.fill('自定义模型来源');
  // 等搜索结果稳定（30 个自定义模型）后再用键盘导航，避免重渲染期按键丢失。
  await page.waitForFunction(() => document.querySelectorAll('.model-list [role^="menuitem"]').length === 30);
  await modelSearch.press('ArrowDown');
  await page.waitForFunction(() => /Long model/.test(document.activeElement?.textContent || ''));
  assert.match(await page.locator(':focus').innerText(), /Long model/);
  await page.keyboard.press('End');
  await page.waitForFunction(() => /29/.test(document.activeElement?.textContent || ''));
  assert.match(await page.locator(':focus').innerText(), /29/);
  await capture('28-long-model-list');
  await page.keyboard.press('Escape');
  // 点击输入框应关闭残留的模型弹层。
  await page.getByRole('textbox', { name: '发送给 Pi 的消息' }).click({ position: { x: 12, y: 12 } });
  assert.equal(await page.locator('.model-popover').count(), 0);

  // 模拟模型目录 IPC 失败：弹层内展示错误提示，Escape 可关闭。
  await page.evaluate(() => { window.__catalogExtras = []; window.__failCatalog = true; });
  await page.getByRole('button', { name: '模型与推理设置', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '模型列表读取失败' }).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__failCatalog = false; });

  // -------------------------------------------------------------------------
  // 10. 首条消息与收尾
  // -------------------------------------------------------------------------
  // 从欢迎页发送第一条消息：应切换到会话视图（chat-tabs 出现，欢迎页元素消失）。
  await page.getByRole('textbox', { name: '发送给 Pi 的消息' }).fill('验证从新对话进入问答');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.chat-tabs').waitFor();
  assert.equal(await page.locator('.new-conversation-intro, .workspace-chip').count(), 0);
  await page.locator('.chat-scroll').getByText('验证从新对话进入问答', { exact: true }).waitFor();
  // 新会话发完第一条消息后必须出现在侧边栏，否则用户离开就找不到入口。
  await page.locator('.session-row', { hasText: '验证从新对话进入问答' }).waitFor();
  await capture('29-first-message');

  // 点击“新会话”应回到欢迎页，且不残留会话标签。
  await page.getByRole('button', { name: '新会话', exact: true }).first().click();
  await page.getByRole('heading', { name: '今天，想做点什么？', exact: true }).waitFor();
  assert.equal(await page.locator('.chat-tabs').count(), 0);
  // 整个流程中浏览器不能有未捕获异常。
  assert.deepEqual(errors, [], 'Browser runtime errors');
  console.log(`UI checks passed; screenshots saved to ${output}`);
} finally { await browser.close(); }

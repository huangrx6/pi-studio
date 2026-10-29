/**
 * Pi Studio 渲染进程的视觉 / 布局 QA 脚本（本地手动运行）。
 *
 * 它用 Playwright 打开 Vite 开发服务器，在页面加载前注入一整套 PiAPI mock，
 * 然后走一遍接近真实使用的流程：欢迎页 → 侧边栏搜索/折叠 → 模型与推理等级 →
 * 会话与文件面板 → 设置页各分页 → 小窗口紧凑布局 → 长模型列表与错误态 →
 * 首条消息。关键步骤截图到 .qa/screenshots/ui-refinement/，同时检查关键容器没有
 * 横向溢出，最后断言浏览器没有运行时错误。
 *
 * 运行方式：
 *   pnpm run web            # 终端 A：启动 http://127.0.0.1:5180
 *   node tools/qa/qa-ui.mjs  # 终端 B：执行本脚本
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
// 产物目录固定为 .qa/screenshots/ui-refinement/（整个 .qa 已被 Git 忽略）。
const output = new URL('../../.qa/screenshots/ui-refinement/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 2 });
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

  // Agent 工具目录刻意让每个 Pi 核心工具带不同文件路径，用来验证 UI 仍会把
  // 同一个提供者合并成一个 Tab，而不是显示成一长串重复的“Pi 核心”。
  const coreSource = () => ({
    key: 'durable:coding',
    source: 'durable:coding',
    label: 'Pi 核心',
    kind: 'core',
    scope: 'builtin',
    path: '',
    baseDir: '',
  });
  const subagentSource = {
    key: 'extension:studio-subagents',
    source: 'extension:studio-subagents',
    label: 'studio-subagents',
    kind: 'extension',
    scope: 'user',
    path: '',
    baseDir: '',
  };
  const workspaceSource = {
    key: 'extension:workspace-tools',
    source: 'extension:workspace-tools',
    label: 'workspace-tools',
    kind: 'extension',
    scope: 'project',
    path: '/Users/demo/Library/Application Support/pi-studio/extensions/workspace-tools',
    baseDir: '/Users/demo/Library/Application Support/pi-studio/extensions/workspace-tools',
  };
  const coreTools = [
    ['read', '读取工作区文件。', 'direct'],
    ['write', '创建或覆盖文件。', 'direct'],
    ['edit', '精确修改文件内容。', 'direct'],
    ['bash', '执行终端命令。', 'direct'],
    ['grep', '搜索文件内容。', 'direct'],
    ['find', '按名称查找文件。', 'direct'],
    ['ls', '浏览目录结构。', 'direct'],
  ].map(([name, description, exposure]) => ({
    name,
    description,
    exposure,
    source: coreSource(),
  }));
  const agentToolCatalog = {
    tools: [
      ...coreTools,
      {
        name: 'subagent',
        description: '启动一个拥有独立上下文的子 Agent。',
        exposure: 'direct',
        source: subagentSource,
      },
      {
        name: 'workspace_inspect',
        description: '检查当前项目结构、依赖和常用脚本。',
        exposure: 'direct',
        source: workspaceSource,
      },
    ],
    commands: [
      { name: 'subagent', description: '启动一个子 Agent。', source: subagentSource },
      { name: 'workspace', description: '查看工作区状态与相关操作。', source: workspaceSource },
    ],
    errors: [],
    warnings: [],
    storage: 'SQLite · settings/studio.agent.tools',
    refreshedAt: Date.now(),
  };
  const agentToolSourceSnapshot = (source) => ({
    source: source.source,
    label: source.label,
    scope: source.scope,
    path: source.path,
    baseDir: source.baseDir,
  });
  const enabledAgentToolNames = [...coreTools.slice(0, 3).map((tool) => tool.name), 'subagent', 'workspace_inspect'];
  const agentTools = {
    enabled: enabledAgentToolNames,
    sources: Object.fromEntries(enabledAgentToolNames.map((name) => {
      const source = agentToolCatalog.tools.find((tool) => tool.name === name)?.source || coreSource();
      return [name, agentToolSourceSnapshot(source)];
    })),
  };

  const workspaceManifest = {
    format: 1,
    id: 'workspace-tools',
    name: 'Workspace Tools',
    version: '1.2.0',
    description: '为 Studio 提供项目概览、状态卡片和声明式面板。',
    author: 'Pi Studio',
    permissions: ['agent.tools', 'ui.panels'],
    runtime: { durableEntry: './index.cjs' },
    contributes: {
      tools: [{ name: 'workspace_inspect', description: '检查当前项目结构、依赖和常用脚本。' }],
      commands: [{ id: 'workspace', title: '工作区状态', description: '查看工作区状态。', placement: 'composer' }],
      panels: [],
      settings: [],
      composer: [],
    },
  };
  const subagentManifest = {
    format: 1,
    id: 'studio-subagents',
    name: 'Studio 子 Agent',
    version: '1.0.0',
    description: '使用 Durable owned conversation 启动独立上下文的子 Agent。',
    author: 'Pi Studio',
    scope: 'builtin',
    permissions: ['agent.tools', 'agent.sections'],
    runtime: { durableEntry: '' },
    contributes: {
      tools: [{ name: 'subagent', description: '启动一个拥有独立上下文的子 Agent。' }],
      commands: [],
      panels: [],
      settings: [],
      composer: [],
    },
  };
  const extensionRows = [
    {
      id: 'user:workspace-tools',
      name: 'workspace-tools',
      version: '1.2.0',
      scope: 'user',
      source: '/Users/demo/Library/Application Support/pi-studio/extensions/workspace-tools',
      manifest: workspaceManifest,
      enabled: true,
      trusted: true,
      installedAt: Date.now() - 86_400_000,
      updatedAt: Date.now(),
      runtimeName: 'extension:workspace-tools',
      runtimeNames: ['workspace-tools'],
      available: true,
      canRemove: true,
      removeBlockedReason: '',
      commandIds: ['user:workspace-tools/workspace'],
      panelIds: ['user:workspace-tools/status'],
    },
    {
      id: 'builtin:studio-subagents',
      name: 'Studio 子 Agent',
      version: '1.0.0',
      scope: 'builtin',
      source: 'durable:studio-subagents',
      manifest: subagentManifest,
      enabled: true,
      trusted: true,
      installedAt: Date.now() - 172_800_000,
      updatedAt: Date.now() - 172_800_000,
      runtimeName: 'studio-subagents',
      runtimeNames: ['studio-subagents'],
      available: true,
      canRemove: false,
      removeBlockedReason: '内置扩展不能卸载',
      commandIds: [],
      panelIds: [],
    },
  ];
  const officialExtensionRows = [
    {
      id: 'quota-status',
      name: '额度状态',
      version: '0.1.0',
      description: '在 Studio 中查看模型额度与剩余用量。',
      publisher: 'Pi Studio',
      keywords: ['quota', 'usage'],
      permissions: [],
      requires: [],
      executable: false,
      officialManaged: false,
      installed: false,
      updateAvailable: false,
      autoUpdate: false,
      requiresPermissionConsent: false,
      requiresCapabilityConsent: false,
      addedPermissions: [],
      addedProviderAccess: [],
      addedRequirements: [],
      executableExpansion: false,
    },
  ];
  const extensionInstallQa = {
    preparedTokens: [],
    installedTokens: [],
    disposedTokens: [],
  };
  window.__extensionInstallQa = extensionInstallQa;
  const conversationExtensionUi = {
    version: 1,
    layout: 'grid',
    globalOrder: [],
    sessionOrders: {},
  };
  window.__conversationExtensionUiQa = conversationExtensionUi;
  const skillQa = {
    added: [],
    removed: [],
  };
  window.__skillQa = skillQa;

  const extensionUiItems = [
    {
      id: 'user:workspace-tools/status',
      extensionId: 'user:workspace-tools',
      extensionName: 'Workspace Tools',
      scope: 'user',
      contributionId: 'status',
      title: '运行状态',
      description: '来自 Workspace Tools 的实时工作区摘要。',
      slot: 'conversation.detail',
      size: 'regular',
      priority: 10,
      sourceOrder: 0,
      content: [
        { kind: 'keyValue', items: [
          { label: '分支', value: 'main · 2 files changed' },
          { label: '上下文', value: '42%' },
          { label: '速度', value: '32 tok/s' },
        ] },
        { kind: 'actions', buttons: [{
          id: 'open-status',
          label: '查看详情',
          tone: 'primary',
          action: { kind: 'openPanel', panelId: 'user:workspace-tools/status-panel' },
        }] },
      ],
    },
    {
      id: 'user:workspace-tools/context',
      extensionId: 'user:workspace-tools',
      extensionName: 'Workspace Tools',
      scope: 'user',
      contributionId: 'context',
      title: '会话上下文概览',
      description: '集中显示当前会话的上下文与工具状态。',
      slot: 'conversation.header',
      size: 'compact',
      priority: 20,
      sourceOrder: 1,
      content: [
        { kind: 'keyValue', items: [
          { label: '消息', value: '2 条' },
          { label: '工具', value: '5 个已启用' },
        ] },
      ],
    },
    {
      id: 'user:workspace-tools/status-summary',
      extensionId: 'user:workspace-tools',
      extensionName: 'Workspace Tools',
      scope: 'user',
      contributionId: 'status-summary',
      title: '工作区摘要',
      description: '运行状态的单行摘要。',
      slot: 'conversation.footer',
      size: 'compact',
      priority: 20,
      sourceOrder: 2,
      content: [
        { kind: 'text', text: 'main · 2 files changed · 上下文 42% · 32 tok/s' },
      ],
    },
    {
      id: 'user:review-tools/focus',
      extensionId: 'user:review-tools',
      extensionName: 'Review Tools',
      scope: 'user',
      contributionId: 'focus',
      title: '审查焦点',
      description: '把本轮最需要关注的改动集中到一个详情卡片。',
      slot: 'conversation.detail',
      size: 'regular',
      priority: 5,
      sourceOrder: 3,
      content: [
        { kind: 'notice', tone: 'info', title: '当前重点', text: '检查扩展数据源与单行摘要的边界。' },
        { kind: 'list', items: [
          { title: 'Detail', text: '允许完整指标和说明。' },
          { title: 'Footer', text: '只显示一条实时摘要。' },
        ] },
      ],
    },
    {
      id: 'user:review-tools/focus-summary',
      extensionId: 'user:review-tools',
      extensionName: 'Review Tools',
      scope: 'user',
      contributionId: 'focus-summary',
      title: '审查摘要',
      description: '审查焦点的单行摘要。',
      slot: 'conversation.footer',
      size: 'compact',
      priority: 5,
      sourceOrder: 4,
      content: [
        { kind: 'text', text: '审查 · 2 个关注点 · 1 个高优先级' },
      ],
    },
    {
      id: 'user:workspace-tools/status-panel',
      extensionId: 'user:workspace-tools',
      extensionName: 'Workspace Tools',
      scope: 'user',
      contributionId: 'status-panel',
      title: '工作区运行详情',
      description: '声明式扩展面板，不执行 renderer 代码。',
      slot: 'panel.side',
      size: 'regular',
      priority: 10,
      sourceOrder: 5,
      content: [
        { kind: 'notice', tone: 'success', title: '运行正常', text: 'Durable 会话与 Studio SQLite 已连接。' },
        { kind: 'list', items: [
          { title: 'Git', text: 'main 分支，工作树有 2 个文件变更。' },
          { title: 'Context', text: '当前上下文窗口使用 42%。' },
          { title: 'Tools', text: 'Agent 工具白名单已热更新。' },
        ] },
      ],
    },
    {
      id: 'user:workspace-tools/settings',
      extensionId: 'user:workspace-tools',
      extensionName: 'Workspace Tools',
      scope: 'user',
      contributionId: 'settings',
      title: '扩展运行数据',
      description: '扩展只能通过声明式内容展示运行信息。',
      slot: 'settings.panel',
      size: 'compact',
      priority: 10,
      sourceOrder: 6,
      content: [
        { kind: 'text', text: '当前扩展来自 Studio 用户扩展目录，启停与信任变更会在下一轮请求生效。' },
        { kind: 'keyValue', items: [
          { label: '运行时', value: 'Durable' },
          { label: '贡献', value: '1 tool · 1 command · 1 panel' },
        ] },
      ],
    },
  ];

  const harnessSections = [
    ['preamble', '编码身份', '声明编码 Agent 的身份与完成标准。'],
    ['tools', '工具策略', '根据实际开放的工具注入使用策略。'],
    ['rules', '编码规则', '约束修改范围与验证要求。'],
    ['repositoryDocs', '仓库文档', '列出项目内的事实文档。'],
    ['projectContext', '项目指令', '先加载应用级 AGENTS.md，再从最近的 Git 或 Studio 项目边界加载到当前目录。'],
    ['skills', '技能', '注入 Studio 用户与项目技能。'],
    ['cwd', '工作区', '告知当前主工作目录。'],
    ['addendum', '自定义补充', '注入用户维护的 Harness 指令。'],
  ].map(([id, label, description]) => ({ id, label, description }));
  const runtimePolicy = {
    version: 1,
    streamTimeoutMs: 0,
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 },
    toolExecution: 'parallel',
    afterFailedRun: 'keep',
    restartLimit: 5,
    contextRetentionMs: 90000,
    documentRetentionMs: 90000,
  };
  const studioProfile = {
    id: 'studio-coding',
    name: 'Studio 编码基线',
    builtin: true,
    sections: Object.fromEntries(harnessSections.map((section) => [section.id, true])),
    sectionOverrides: {},
    customInstructions: '先把事实查清，再做最小且完整的修改，并运行针对性验证。',
    toolGuidance: { edit: '优先使用小范围、语义清晰的精确修改。' },
  };
  const reviewProfile = {
    ...structuredClone(studioProfile),
    id: 'review-first',
    name: '严格审阅',
    builtin: false,
    customInstructions: '先审查边界条件、失败路径和回归风险，再提交最小修复。',
    toolGuidance: { bash: '只运行与改动直接相关且可重复的验证命令。' },
  };
  const designProfile = {
    ...structuredClone(studioProfile),
    id: 'product-polish',
    name: '产品体验与交互细节',
    builtin: false,
    customInstructions: '优先保证信息层级、交互反馈和不同窗口宽度下的一致体验。',
    toolGuidance: { edit: '同步检查共用组件、空状态与窄窗口布局。' },
  };
  const harnessState = {
    version: 1,
    activeProfileId: studioProfile.id,
    globalProfileId: studioProfile.id,
    workspaceProfileId: studioProfile.id,
    sections: harnessSections,
    profiles: [studioProfile, reviewProfile, designProfile],
    activeProfile: studioProfile,
    path: 'SQLite · studio.harness',
    runtimePolicy,
    runtimePolicyDefaults: structuredClone(runtimePolicy),
    runtimePolicyPath: 'SQLite · studio.runtime.policy',
  };
  const subagentConfig = {
    defaultModel: 'opencode-go/deepseek-v4.1-flash',
    defaultProvider: 'opencode-go',
    defaultThinking: 'high',
    maxThinking: 'max',
    allowedTools: ['read', 'grep', 'find', 'workspace_inspect'],
  };
  const subagentState = {
    installed: true,
    userPath: 'SQLite · studio.subagents.user',
    projectPath: 'SQLite · studio.subagents.projects[workspace]',
    projectRoot: cwd,
    projectRootExists: true,
    user: structuredClone(subagentConfig),
    project: { defaultModel: '', defaultProvider: '', defaultThinking: '', maxThinking: '', allowedTools: [] },
    models: models.slice(0, 3).map((item, index) => ({
      modelRef: item.id,
      provider: item.provider,
      label: `${item.providerName} · ${item.name}`,
      reasoning: index !== 1,
      thinkingLevels: index === 1 ? [] : ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    })),
    currentModel: models[2].id,
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  };
  const permissionModes = [
    {
      id: 'ask',
      label: '请求批准',
      description: '所有工具调用逐次确认；可保存精确到文件、命令或会话的规则。',
      defaultDecision: 'ask',
    },
    {
      id: 'smart',
      label: '帮我批准',
      description: '只自动允许明确的只读工具；风险或未知工具仍会确认。',
      defaultDecision: 'ask',
    },
    {
      id: 'full',
      label: '完全权限',
      description: '普通工具不再逐次询问；显式询问规则、工作区边界和系统级破坏命令仍然生效。',
      defaultDecision: 'allow',
    },
  ];
  const permissionDefaults = { ask: 'ask', smart: 'ask', full: 'allow' };
  const permissionPolicies = {
    user: {
      version: 1,
      preset: 'smart',
      default: 'ask',
      tools: { 'mcp__github__*': 'ask' },
      rules: [{
        id: 'protect-secrets',
        label: '禁止读取密钥文件',
        decision: 'deny',
        match: { tool: 'read', pathGlob: '**/.env*' },
      }],
    },
    workspace: {
      version: 1,
      preset: 'smart',
      default: 'ask',
      tools: { bash: 'ask' },
      rules: [],
    },
    session: null,
  };
  function permissionPolicyState() {
    const layers = [{ scope: 'user', policy: structuredClone(permissionPolicies.user) }];
    if (permissionPolicies.workspace) {
      layers.push({ scope: 'workspace', policy: structuredClone(permissionPolicies.workspace) });
    }
    if (permissionPolicies.session) {
      layers.push({ scope: 'session', policy: structuredClone(permissionPolicies.session) });
    }
    const effective = layers.at(-1);
    return {
      available: true,
      mode: effective.policy.preset,
      effectivePolicy: structuredClone(effective.policy),
      effectiveScope: effective.scope,
      layers,
      cwd,
      sessionId: '',
      scopes: {
        user: structuredClone(permissionPolicies.user),
        workspace: permissionPolicies.workspace ? structuredClone(permissionPolicies.workspace) : null,
        session: permissionPolicies.session ? structuredClone(permissionPolicies.session) : null,
      },
      catalog: {
        modes: structuredClone(permissionModes),
        decisions: [
          { id: 'allow', label: '允许' },
          { id: 'ask', label: '询问' },
          { id: 'deny', label: '拒绝' },
        ],
        decisionsAreValid: ['allow', 'ask', 'deny'],
        presetDefaults: structuredClone(permissionDefaults),
      },
      path: 'SQLite · studio.permissions.policy',
    };
  }

  // 2.2 设置页快照：所有分页共享这一份数据
  const snapshot = {
    // 自定义模型列表；Studio Model 挂在 minimax-cn 下，后面会再新增并编辑另一个模型。
    customModels: [{ providerId: 'minimax-cn', modelId: 'studio-model', name: 'Studio Model', contextWindow: 128000, maxTokens: 8192, supportsImages: true, reasoning: false }],
    // 三个来源卡片：mode 决定展示的认证方式（env / api_key / key）。
    providers: [
      { id: 'minimax-cn', name: 'MiniMax', mode: 'key', authConfigured: true, models: 2, enabled: true, builtin: false },
      { id: 'deepseek', name: 'DeepSeek', mode: 'key', authConfigured: true, models: 2, enabled: true, builtin: false },
      { id: 'opencode-go', name: 'OpenCode Go', mode: 'key', authConfigured: false, models: 1, enabled: true, builtin: false },
    ],
    // 选择器只展示已启用的模型（前三个）。
    enabledModels: models.slice(0, 3).map((item) => item.id),
    // MCP 列表：一条 stdio、一条禁用且 URL 很长的 HTTP，用于测截断与紧凑布局。
    mcp: [
      { name: 'filesystem', transport: 'stdio', enabled: true, target: 'npx -y @modelcontextprotocol/server-filesystem /workspace', description: '读取项目文件，理解工作区中的内容。' },
      { name: 'project-documents', transport: 'http', enabled: false, target: 'https://example.test/mcp/a-very-long-project-documentation-endpoint', description: '项目资料与团队文档' },
    ],
    // 技能按 scope + origin 分来源展示；项目路径故意很长，用于验证截断。
    skills: [
      {
        name: 'code-review',
        description: '审查代码的正确性与可维护性，关注边界条件，并给出具体改进建议。',
        path: '/Users/demo/Library/Application Support/pi-studio/skills/code-review/SKILL.md',
        baseDir: '/Users/demo/Library/Application Support/pi-studio/skills/code-review',
        scope: 'user',
        origin: 'studio',
        bytes: 1840,
        fingerprint: 'a'.repeat(64),
        trusted: true,
        trustChanged: false,
        available: true,
        disableModelInvocation: false,
        warnings: [],
      },
      {
        name: 'cosmic-split',
        description: '按 COSMIC 方法整理功能过程与数据移动。',
        path: '/Users/demo/.agents/skills/cosmic-split/SKILL.md',
        baseDir: '/Users/demo/.agents/skills/cosmic-split',
        scope: 'user',
        origin: 'agents',
        bytes: 2860,
        fingerprint: 'b'.repeat(64),
        trusted: true,
        trustChanged: false,
        available: true,
        disableModelInvocation: false,
        warnings: [],
      },
      {
        name: 'frontend-design',
        description: '构建清晰、协调的用户界面，统一组件与交互细节。',
        path: '/workspace/pi-studio/.pi-studio/skills/frontend-design/SKILL.md',
        baseDir: '/workspace/pi-studio/.pi-studio/skills/frontend-design',
        scope: 'project',
        origin: 'studio',
        bytes: 2420,
        fingerprint: 'c'.repeat(64),
        trusted: false,
        trustChanged: false,
        available: false,
        disableModelInvocation: false,
        warnings: [],
      },
    ],
    skillErrors: [],
    extensions: extensionRows,
    extensionErrors: [],
    extensionApiVersion: 1,
    agentTools,
    agentToolsPath: 'SQLite · settings/studio.agent.tools',
    harness: harnessState,
    storagePath: '/Users/demo/Library/Application Support/pi-studio',
    databasePath: '/Users/demo/Library/Application Support/pi-studio/studio.sqlite',
    skillsPath: '/Users/demo/Library/Application Support/pi-studio/skills',
    agentsSkillsPath: '/Users/demo/.agents/skills',
    projectSkillsPath: '/workspace/pi-studio/.pi-studio/skills',
    projectAgentsSkillsPath: '/workspace/pi-studio/.agents/skills',
    extensionsPath: '/Users/demo/Library/Application Support/pi-studio/extensions',
    projectExtensionsPath: '/workspace/pi-studio/.pi-studio/extensions',
    // 当前模型选择，后续 setModel / setThinkingLevel 会同步更新。
    model,
  };

  // 2.3 对话框数据源
  // “编辑来源”表单只读取这几个字段。
  const providerConfigs = {
    'minimax-cn': { providerId: 'minimax-cn', name: 'MiniMax', baseUrl: 'https://api.example.test/v1', api: 'openai-completions', icon: '', modelsUrl: '', builtin: false, enabled: true },
    deepseek: { providerId: 'deepseek', name: 'DeepSeek', baseUrl: 'https://deepseek.example.test', api: 'openai-completions', icon: '', modelsUrl: 'https://deepseek.example.test/models', builtin: false, enabled: true },
    'opencode-go': { providerId: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.example.test/v1', api: 'openai-completions', icon: '', modelsUrl: '', builtin: false, enabled: true },
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
        {
          id: 'session-1',
          cwd,
          title: '统一工作台的组件与视觉规范',
          kind: 'conversation',
          goal: '',
          pinned: false,
          archived: false,
          createdAt: Date.now() - 7200000,
          updatedAt: Date.now(),
          messageCount: 2,
        },
        {
          id: 'session-2',
          cwd,
          title: '优化文件预览和设置页面的排版',
          kind: 'durable',
          goal: '完成 Durable UI 重构',
          pinned: false,
          archived: false,
          createdAt: Date.now() - 86400000,
          updatedAt: Date.now() - 3600000,
          messageCount: 4,
        },
      ],
    },
    { cwd: '/workspace/design-system', name: 'design-system', sessions: [] },
    { cwd: '/workspace/very-long-project-name-for-layout-verification', name: '很长的项目名称用于验证侧栏截断与对齐', sessions: [] },
  ];

  const conversationListeners = new Set();
  const conversationMessages = new Map([
    ['session-1', [
      {
        role: 'user',
        content: [{ type: 'text', text: '帮我优化项目的界面，让各个页面更协调、更舒服。' }],
        timestamp: Date.now() - 60_000,
        sourceIndex: 0,
      },
      {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '我梳理了界面中的布局与组件，可以从以下几个方面改进：\n\n## 统一基础尺寸\n\n按钮、输入框、卡片和列表使用一致的间距与圆角，让操作更自然。\n\n## 整理内容层级\n\n通过标题、说明和状态的对比，让关键信息更容易找到。\n\n## 完善边界状态\n\n为加载、空列表和长文本保留足够的空间，保证小窗口下也能正常使用。',
        }],
        timestamp: Date.now() - 30_000,
        sourceIndex: 1,
      },
    ]],
  ]);
  const subagentChildrenFixture = [
    {
      key: 'child-runtime-review',
      runId: 'run-runtime-review',
      index: 0,
      agent: 'runtime-reviewer',
      name: 'Durable Runtime 审查',
      task: '检查请求边界、错误映射与流式事件是否完整，给出可以复现的回归结论。',
      status: 'running',
      source: 'foreground',
      context: 'fork',
      model: 'opencode-go/deepseek-v4.1-flash',
      thinking: 'high',
      cwd,
      startedAt: Date.now() - 94_000,
      updatedAt: Date.now(),
      tokens: 18_420,
      toolCount: 7,
      turnCount: 4,
      currentTool: 'bash · pnpm test',
      preview: '正在核对 Durable 事件与 Studio SQLite 投影之间的边界。',
      hasTranscript: true,
    },
    {
      key: 'child-usage-ui',
      runId: 'run-usage-ui',
      index: 1,
      agent: 'usage-ui-designer',
      name: '使用量视图设计',
      task: '检查 Token 热力图、窄窗口布局和模型分布的视觉一致性。',
      status: 'completed',
      source: 'foreground',
      context: 'fresh',
      model: 'minimax-cn/MiniMax-M3.1-Flash',
      thinking: 'medium',
      cwd,
      startedAt: Date.now() - 212_000,
      updatedAt: Date.now() - 164_000,
      durationMs: 48_000,
      tokens: 9_680,
      toolCount: 4,
      turnCount: 3,
      preview: '已完成布局审查，并提交 3 条视觉修正建议。',
      hasTranscript: true,
    },
  ];
  const subagentTranscriptMessages = {
    'child-runtime-review': [
      {
        role: 'user',
        content: [{ type: 'text', text: '审查 Durable 请求边界和模型热更新路径。' }],
        timestamp: Date.now() - 88_000,
        sourceIndex: 0,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '我会先检查运行时取值时机，再运行针对性的 Electron 测试。' }],
        timestamp: Date.now() - 82_000,
        sourceIndex: 1,
      },
    ],
    'child-usage-ui': [
      {
        role: 'user',
        content: [{ type: 'text', text: '检查使用量页面的信息层级和溢出边界。' }],
        timestamp: Date.now() - 205_000,
        sourceIndex: 0,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '热力图在窄窗口内应保持横向滚动，统计卡片改为单列。' }],
        timestamp: Date.now() - 190_000,
        sourceIndex: 1,
      },
    ],
  };
  let activeConversationId = '';

  function sessionSummary(id) {
    return workspaces.flatMap((workspace) => workspace.sessions).find((item) => item.id === id);
  }

  function conversationSnapshot(id) {
    const summary = sessionSummary(id);
    if (!summary) return undefined;
    return {
      ...summary,
      model,
      running: false,
      requestId: '',
      compacting: false,
      inbox: [],
      tools: [],
      nestedTools: [],
      usage: { inputTokens: 18420, outputTokens: 2310 },
      agent: { cwd: summary.cwd, name: 'Studio Coding Agent' },
    };
  }

  function conversationPage(id) {
    const snapshotValue = conversationSnapshot(id);
    if (!snapshotValue) return undefined;
    const messages = structuredClone(conversationMessages.get(id) || []);
    return {
      ...snapshotValue,
      messages,
      turnDiffs: [],
      page: { hasOlder: false },
      messageStart: messages[0]?.sourceIndex || 0,
    };
  }

  function emitConversation(event) {
    for (const listener of conversationListeners) listener(structuredClone(event));
  }

  // 更新提示默认保持隐藏，测试中按需推送“发现新版本”的快照。
  let updateFixture = { currentVersion: '0.0.3', state: 'idle' };
  const updateListeners = new Set();
  window.__setUpdateState = (state) => {
    updateFixture = state === 'available'
      ? { currentVersion: '0.0.3', latestVersion: '0.0.4', state, progress: 0 }
      : { currentVersion: '0.0.3', state };
    for (const listener of updateListeners) listener(structuredClone(updateFixture));
  };

  function usageDayKey(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function usageTotals(rows) {
    return rows.reduce((total, row) => ({
      input: total.input + row.input,
      output: total.output + row.output,
      cacheRead: total.cacheRead + row.cacheRead,
      cacheWrite: total.cacheWrite + row.cacheWrite,
      totalTokens: total.totalTokens + row.input + row.output + row.cacheRead + row.cacheWrite,
      cost: total.cost + row.cost,
      requests: total.requests + row.requests,
      activeDays: total.activeDays + 1,
    }), {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
      requests: 0,
      activeDays: 0,
    });
  }

  function usageSnapshot(days) {
    const now = new Date();
    const since = new Date(now);
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - days + 1);
    const source = [
      { offset: 0, providerId: 'opencode-go', providerName: 'OpenCode Go', modelId: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', input: 128_400, output: 48_260, cacheRead: 72_000, cacheWrite: 5_200, cost: 0.084, requests: 8 },
      { offset: -1, providerId: 'minimax-cn', providerName: 'MiniMax', modelId: 'MiniMax-M3.1-Flash', displayName: 'MiniMax M3.1 Flash', input: 96_200, output: 31_800, cacheRead: 41_000, cacheWrite: 2_100, cost: 0.063, requests: 6 },
      { offset: -2, providerId: 'opencode-go', providerName: 'OpenCode Go', modelId: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', input: 76_800, output: 24_600, cacheRead: 36_000, cacheWrite: 1_800, cost: 0.054, requests: 5 },
      { offset: -4, providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'deepseek-chat', displayName: 'DeepSeek Chat', input: 58_900, output: 18_200, cacheRead: 22_000, cacheWrite: 1_200, cost: 0.031, requests: 4 },
      { offset: -7, providerId: 'minimax-cn', providerName: 'MiniMax', modelId: 'MiniMax-M3.1-Flash', displayName: 'MiniMax M3.1 Flash', input: 43_000, output: 12_400, cacheRead: 14_000, cacheWrite: 900, cost: 0.026, requests: 3 },
      { offset: -12, providerId: 'opencode-go', providerName: 'OpenCode Go', modelId: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', input: 25_000, output: 8_700, cacheRead: 7_000, cacheWrite: 400, cost: 0.017, requests: 2 },
      { offset: -20, providerId: 'legacy-gateway', providerName: 'Legacy Gateway', modelId: 'retired-reasoner', displayName: 'Retired Reasoner', input: 18_000, output: 5_400, cacheRead: 3_000, cacheWrite: 300, cost: 0.012, requests: 2 },
    ];
    const dailyModels = source.map((row) => {
      const date = new Date(now);
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() + row.offset);
      return {
        day: usageDayKey(date),
        providerId: row.providerId,
        providerName: row.providerName,
        modelId: row.modelId,
        displayName: row.displayName,
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        totalTokens: row.input + row.output + row.cacheRead + row.cacheWrite,
        cost: row.cost,
        requests: row.requests,
        activeDays: 1,
      };
    }).sort((left, right) => left.day.localeCompare(right.day));
    const daily = dailyModels.map((row) => ({
      day: row.day,
      input: row.input,
      output: row.output,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      totalTokens: row.totalTokens,
      cost: row.cost,
      requests: row.requests,
      activeDays: row.activeDays,
    }));
    const range = usageTotals(daily);
    const modelDefinitions = [
      { providerId: 'opencode-go', providerName: 'OpenCode Go', modelId: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash' },
      { providerId: 'minimax-cn', providerName: 'MiniMax', modelId: 'MiniMax-M3.1-Flash', displayName: 'MiniMax M3.1 Flash' },
      { providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'deepseek-chat', displayName: 'DeepSeek Chat' },
      { providerId: 'legacy-gateway', providerName: 'Legacy Gateway', modelId: 'retired-reasoner', displayName: 'Retired Reasoner' },
    ];
    const models = modelDefinitions.map((definition) => {
      const rows = source.filter((row) => row.providerId === definition.providerId && row.modelId === definition.modelId);
      return { ...definition, ...usageTotals(rows) };
    }).sort((left, right) => right.totalTokens - left.totalTokens);
    const filterModels = modelDefinitions.map((definition) => ({
      ...definition,
      enabled: definition.providerId !== 'legacy-gateway',
      inUse: true,
    }));
    return {
      generatedAt: now.getTime(),
      days,
      sinceDay: usageDayKey(since),
      collection: { enabled: true, store: 'studio-sqlite' },
      allTime: {
        ...range,
        totalTokens: range.totalTokens + 420_000,
        requests: range.requests + 18,
        activeDays: range.activeDays + 9,
        currentStreak: 6,
        longestStreak: 11,
      },
      range,
      daily,
      dailyModels,
      filterModels,
      models,
    };
  }

  let draftSequence = 0;

  // 2.5 暴露给渲染进程的 PiAPI 子集（只实现 UI 会调用的方法）
  const api = {
    // 初始状态：工作区列表、当前目录与当前模型。
    state: async () => ({ workspaces, cwd, model }),
    conversationList: async () => workspaces,
    createConversation: async (input = {}) => {
      draftSequence += 1;
      const summary = {
        id: `new-${draftSequence}`,
        cwd: input.cwd || cwd,
        title: '新会话',
        kind: input.kind === 'durable' ? 'durable' : 'conversation',
        goal: input.goal || '',
        pinned: false,
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
      };
      const target = workspaces.find((workspace) => workspace.cwd === summary.cwd) || workspaces[0];
      target.sessions.unshift(summary);
      conversationMessages.set(summary.id, []);
      return structuredClone(summary);
    },
    conversationPage: async ({ id }) => structuredClone(conversationPage(id)),
    conversationSnapshot: async (id) => structuredClone(conversationSnapshot(id)),
    conversationOutline: async (id) => {
      const messages = conversationMessages.get(id) || [];
      const items = messages.flatMap((message, index) => (
        message.role === 'user'
          ? [{ sourceIndex: index, text: message.content?.find((part) => part.type === 'text')?.text || '', timestamp: message.timestamp }]
          : []
      ));
      return { id, items, totalMessages: messages.length };
    },
    subscribeConversation: async (id) => {
      activeConversationId = id;
      return structuredClone(conversationSnapshot(id));
    },
    unsubscribeConversation: async () => ({ ok: true }),
    onConversationEvent: (callback) => {
      conversationListeners.add(callback);
      return () => conversationListeners.delete(callback);
    },
    conversationSubmit: async ({ id, text }) => {
      const summary = sessionSummary(id);
      if (!summary) throw new Error('会话不存在');
      const messages = conversationMessages.get(id) || [];
      const title = text.split('\n')[0].trim().slice(0, 36) || '新会话';
      const userMessage = {
        role: 'user',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
        sourceIndex: messages.length,
      };
      const assistantMessage = {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '已收到。下面会基于当前 Studio Harness、项目指令和可用工具继续处理。',
        }],
        timestamp: Date.now() + 1,
        sourceIndex: messages.length + 1,
      };
      messages.push(userMessage, assistantMessage);
      conversationMessages.set(id, messages);
      summary.title = title;
      summary.updatedAt = Date.now();
      summary.messageCount = messages.length;
      activeConversationId = id;
      const requestId = `request-${Date.now()}`;
      setTimeout(() => {
        if (activeConversationId !== id) return;
        emitConversation({
          type: 'assistant.completed',
          conversationId: id,
          revision: Date.now(),
          payload: { message: structuredClone(assistantMessage) },
        });
        emitConversation({
          type: 'run.completed',
          conversationId: id,
          revision: Date.now() + 1,
          payload: { inputs: [requestId] },
        });
      }, 30);
      return {
        conversationId: id,
        submissionId: `submission-${Date.now()}`,
        requestId,
        status: 'placed',
        whenBusy: 'followUp',
      };
    },
    conversationConfigure: async ({ id }) => structuredClone(conversationSnapshot(id)),
    conversationInterrupt: async () => ({ ok: true }),
    conversationAction: async ({ kind, action, id, name }) => {
      if (kind === 'session' && action === 'fork') {
        const source = sessionSummary(id);
        const copy = {
          ...source,
          id: `fork-${Date.now()}`,
          title: `${source?.title || '会话'} · 分叉`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        workspaces[0].sessions.unshift(copy);
        conversationMessages.set(copy.id, structuredClone(conversationMessages.get(id) || []));
        return structuredClone(copy);
      }
      if (kind === 'session' && action === 'rename' && name) {
        const target = sessionSummary(id);
        if (target) target.title = name;
      }
      return { ok: true };
    },
    sessionSubagents: async (id) => (
      id === 'session-1' ? structuredClone(subagentChildrenFixture) : []
    ),
    subagentTranscript: async ({ sessionId, childKey }) => {
      if (sessionId !== 'session-1') throw new Error('会话不存在');
      const child = subagentChildrenFixture.find((item) => item.key === childKey);
      if (!child) throw new Error('子 Agent 会话不存在');
      const messages = subagentTranscriptMessages[childKey] || [];
      return {
        child: structuredClone(child),
        messages: structuredClone(messages),
        totalMessages: messages.length,
        hasMore: false,
        messageStart: messages[0]?.sourceIndex || 0,
      };
    },
    // 模型目录：__failCatalog 模拟读取失败，__catalogExtras 用于长列表场景。
    models: async () => {
      if (window.__failCatalog) throw new Error('模型列表读取失败');
      const extra = window.__catalogExtras || [];
      return {
        models: [...models, ...extra],
        enabled: [...snapshot.enabledModels, ...extra.map((item) => item.id)],
        current: model.modelRef,
        selection: model,
        defaultSelection: model,
      };
    },
    // 某个来源下的模型列表（“管理模型”弹窗使用），补充启用状态与能力字段。
    providerModels: async (provider) => {
      const configured = snapshot.customModels
        .filter((item) => item.providerId === provider)
        .map((item) => ({
          id: `${provider}/${item.modelId}`,
          model: item.modelId,
          name: item.name,
          enabled: snapshot.enabledModels.includes(`${provider}/${item.modelId}`),
          contextWindow: item.contextWindow,
          maxTokens: item.maxTokens,
          supportsImages: item.supportsImages,
          reasoning: item.reasoning,
          thinkingLevels: item.thinkingLevels || [],
          origin: item.origin || 'configured',
          deletable: true,
        }));
      const configuredIds = new Set(configured.map((item) => item.model));
      const runtime = models
        .filter((item) => item.provider === provider && !configuredIds.has(item.model))
        .map((item) => ({
          ...item,
          enabled: snapshot.enabledModels.includes(item.id),
          supportsImages: provider !== 'deepseek',
          reasoning: provider === 'minimax-cn',
          thinkingLevels: provider === 'minimax-cn'
            ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
            : provider === 'opencode-go'
              ? ['off', 'low', 'high', 'max']
              : [],
          contextWindow: provider === 'opencode-go' ? 1000000 : 128000,
          maxTokens: 8192,
          origin: 'builtin',
          deletable: false,
        }));
      return { models: [...configured, ...runtime] };
    },
    discoverProviderModels: async (provider) => ({
      endpoint: `https://${provider}.example.test/v1/models`,
      models: [
        { id: 'discovered-fast', name: 'Discovered Fast', contextWindow: 64000, maxTokens: 8192, supportsImages: false, reasoning: false, thinkingLevels: [] },
        { id: 'discovered-vision', name: 'Discovered Vision', contextWindow: 128000, maxTokens: 16384, supportsImages: true, reasoning: true, thinkingLevels: ['off', 'low', 'high', 'max'] },
      ],
    }),
    importProviderModels: async ({ providerId, models: discovered }) => {
      for (const item of discovered) {
        if (snapshot.customModels.some((model) => model.providerId === providerId && model.modelId === item.id)) continue;
        snapshot.customModels.push({ providerId, modelId: item.id, ...item, origin: 'configured' });
        snapshot.enabledModels.push(`${providerId}/${item.id}`);
      }
      const provider = snapshot.providers.find((item) => item.id === providerId);
      if (provider) provider.models += discovered.length;
      return cloneSnapshot();
    },
    // 切换模型：更新内存与 localStorage，保证 reload 后仍选中同一模型。
    setModel: async (id) => {
      model = selection(id);
      snapshot.model = model;
      localStorage.setItem('qa-model', id);
      return model;
    },
    setDefaultModel: async (id) => {
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
    setDefaultThinkingLevel: async ({ level, cwd: target }) => {
      if (window.__failThinking) throw new Error('保存失败，请重试');
      if (!model.thinkingLevels.includes(level)) throw new Error('invalid thinking level');
      window.__lastThinking = { modelRef: model.modelRef, level, cwd: target };
      preferences[model.modelRef] = level;
      localStorage.setItem('qa-thinking', JSON.stringify(preferences));
      model = selection(model.modelRef);
      snapshot.model = model;
      return model;
    },
    agentToolCatalog: async () => structuredClone(agentToolCatalog),
    setAgentTools: async ({ tools }) => {
      snapshot.agentTools = structuredClone(tools);
      return cloneSnapshot();
    },
    harnessSettings: async () => structuredClone(harnessState),
    saveHarnessProfile: async ({ profile }) => {
      window.__lastHarnessSave = structuredClone(profile);
      const index = harnessState.profiles.findIndex((item) => item.id === profile.id);
      if (index >= 0) harnessState.profiles[index] = structuredClone(profile);
      else harnessState.profiles.push(structuredClone(profile));
      harnessState.activeProfile = structuredClone(profile);
      harnessState.activeProfileId = profile.id;
      snapshot.harness = structuredClone(harnessState);
      return structuredClone(harnessState);
    },
    selectHarnessProfile: async ({ id, scope }) => {
      const profile = harnessState.profiles.find((item) => item.id === id);
      if (!profile) throw new Error('Harness profile 不存在');
      harnessState.activeProfileId = id;
      harnessState.activeProfile = structuredClone(profile);
      if (scope === 'global') harnessState.globalProfileId = id;
      else harnessState.workspaceProfileId = id;
      snapshot.harness = structuredClone(harnessState);
      return structuredClone(harnessState);
    },
    resetHarnessProfile: async ({ id }) => {
      const profile = harnessState.profiles.find((item) => item.id === id);
      if (profile) {
        profile.sections = Object.fromEntries(harnessSections.map((section) => [section.id, true]));
        profile.sectionOverrides = {};
        profile.toolGuidance = {};
        if (profile.builtin) profile.customInstructions = studioProfile.customInstructions;
      }
      harnessState.activeProfile = structuredClone(
        harnessState.profiles.find((item) => item.id === harnessState.activeProfileId) || studioProfile,
      );
      snapshot.harness = structuredClone(harnessState);
      return structuredClone(harnessState);
    },
    deleteHarnessProfile: async ({ id }) => {
      harnessState.profiles = harnessState.profiles.filter((item) => item.id !== id || item.builtin);
      if (harnessState.globalProfileId === id) harnessState.globalProfileId = studioProfile.id;
      if (harnessState.workspaceProfileId === id) harnessState.workspaceProfileId = studioProfile.id;
      harnessState.activeProfileId = studioProfile.id;
      harnessState.activeProfile = structuredClone(studioProfile);
      snapshot.harness = structuredClone(harnessState);
      return structuredClone(harnessState);
    },
    saveRuntimePolicy: async ({ policy }) => {
      window.__lastRuntimePolicy = structuredClone(policy);
      harnessState.runtimePolicy = structuredClone(policy);
      snapshot.harness = structuredClone(harnessState);
      return structuredClone(harnessState);
    },
    subagentSettings: async (requestedCwd) => {
      window.__lastSubagentLoadCwd = requestedCwd;
      return structuredClone({ ...subagentState, projectRoot: requestedCwd || subagentState.projectRoot });
    },
    saveSubagentSettings: async ({ cwd: requestedCwd, scope, settings }) => {
      const target = scope === 'project' ? 'project' : 'user';
      window.__lastSubagentSave = { cwd: requestedCwd, scope, settings: structuredClone(settings) };
      subagentState[target] = structuredClone(settings);
      return structuredClone({ ...subagentState, projectRoot: requestedCwd || subagentState.projectRoot });
    },
    settings: async () => cloneSnapshot(),
    usageSummary: async ({ days = 365 } = {}) => structuredClone(usageSnapshot(days)),
    providerConfig: async (id) => structuredClone(providerConfigs[id]),
    mcpConfig: async (name) => structuredClone(mcpConfigs[name]),
    setEnabledModels: async ({ models: enabled }) => {
      snapshot.enabledModels = enabled;
      return cloneSnapshot();
    },
    setProviderEnabled: async ({ providerId, enabled }) => {
      const provider = snapshot.providers.find((item) => item.id === providerId);
      if (!provider) throw new Error('模型来源不存在');
      provider.enabled = enabled;
      return cloneSnapshot();
    },
    removeProvider: async ({ providerId }) => {
      const index = snapshot.providers.findIndex((item) => item.id === providerId);
      if (index >= 0) snapshot.providers.splice(index, 1);
      snapshot.customModels = snapshot.customModels.filter((item) => item.providerId !== providerId);
      snapshot.enabledModels = snapshot.enabledModels.filter((id) => !id.startsWith(`${providerId}/`));
      delete providerConfigs[providerId];
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
      if (input.editing && index >= 0) snapshot.customModels[index] = { ...input, origin: input.origin === 'override' ? 'override' : 'configured' };
      else snapshot.customModels.push({ ...input, origin: 'configured' });
      const provider = snapshot.providers.find((item) => item.id === input.providerId);
      if (provider && !input.editing) provider.models += 1;
      return cloneSnapshot();
    },
    removeCustomModel: async ({ providerId, modelId }) => {
      const index = snapshot.customModels.findIndex((item) => item.providerId === providerId && item.modelId === modelId);
      if (index >= 0) snapshot.customModels.splice(index, 1);
      snapshot.enabledModels = snapshot.enabledModels.filter((id) => id !== `${providerId}/${modelId}`);
      return cloneSnapshot();
    },
    // 新增/编辑来源：同步更新 providerConfigs；新建时再补一张来源卡片。
    addProvider: async (input) => {
      const existingConfig = providerConfigs[input.providerId];
      providerConfigs[input.providerId] = {
        providerId: input.providerId,
        name: input.name,
        baseUrl: input.baseUrl,
        api: input.api,
        icon: input.icon || '',
        modelsUrl: input.modelsUrl || '',
        builtin: existingConfig?.builtin || false,
        enabled: existingConfig?.enabled ?? true,
      };
      if (!input.editing) snapshot.providers.push({ id: input.providerId, name: input.name || input.providerId, mode: 'key', models: 0, modelsUrl: input.modelsUrl || '', enabled: true, builtin: false });
      else {
        const provider = snapshot.providers.find((item) => item.id === input.providerId);
        if (provider) { provider.name = input.name; provider.modelsUrl = input.modelsUrl || ''; }
      }
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
    addSkill: async (input) => {
      skillQa.added.push(structuredClone(input));
      return cloneSnapshot();
    },
    addExtension: async () => undefined,
    removeSkill: async (path, cwd) => {
      skillQa.removed.push({ path, cwd });
      snapshot.skills = snapshot.skills.filter((skill) => skill.path !== path);
      return cloneSnapshot();
    },
    removeExtension: async ({ id }) => {
      snapshot.extensions = snapshot.extensions.filter((item) => item.id !== id);
      return cloneSnapshot();
    },
    extensionsSnapshot: async () => ({
      extensions: structuredClone(snapshot.extensions),
      errors: [],
      syncedAt: Date.now(),
      apiVersion: 1,
    }),
    officialExtensions: async () => ({
      extensions: structuredClone(officialExtensionRows),
      errors: [],
      updatedAt: Date.now(),
      autoUpdate: { results: [], updated: [] },
    }),
    prepareOfficialExtension: async (id) => {
      const item = officialExtensionRows.find((entry) => entry.id === id);
      if (!item) throw new Error('官方扩展不存在');
      const token = `official-${id}-${extensionInstallQa.preparedTokens.length + 1}`;
      extensionInstallQa.preparedTokens.push(token);
      return {
        token,
        scope: 'user',
        id: item.id,
        name: item.name,
        version: item.version,
        publisher: item.publisher,
        description: item.description,
        permissions: [],
        providerAccess: [],
        requires: [],
        addedRequirements: [],
        missingDependencies: [],
        addedPermissions: [],
        addedProviderAccess: [],
        executable: false,
        executableExpansion: false,
        sourceKind: 'official',
        source: `official:${item.id}`,
        resolvedRef: item.version,
        archiveSha256: null,
        treeSha256: 'a'.repeat(64),
        integrityFileSha256: 'b'.repeat(64),
        signatureStatus: 'valid',
        publisherTrust: 'trusted',
        requiresPublisherTrust: false,
        upgrade: false,
        alreadyInstalled: false,
        requiresPermissionConsent: false,
        requiresCapabilityConsent: false,
      };
    },
    installExtension: async ({ token }) => {
      extensionInstallQa.installedTokens.push(token);
      return {
        installed: {
          id: 'quota-status',
          version: '0.1.0',
          activeCodePath: '',
          dataPath: '',
          contentChanged: false,
          trustRevoked: false,
        },
        settings: cloneSnapshot(),
      };
    },
    disposeExtensionInstall: async (token) => {
      extensionInstallQa.disposedTokens.push(token);
    },
    reloadExtensions: async () => ({
      extensions: structuredClone(snapshot.extensions),
      errors: [],
      syncedAt: Date.now(),
      apiVersion: 1,
    }),
    setExtensionEnabled: async ({ id, enabled }) => {
      const target = snapshot.extensions.find((item) => item.id === id);
      if (target) target.enabled = enabled;
      return cloneSnapshot();
    },
    setExtensionTrusted: async ({ id, trusted }) => {
      const target = snapshot.extensions.find((item) => item.id === id);
      if (target) target.trusted = trusted;
      return cloneSnapshot();
    },
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
    // UI contribution 只返回声明式数据，ExtensionSlot 负责统一渲染。
    extensionsUi: async () => ({
      items: structuredClone(extensionUiItems),
      errors: [],
      syncedAt: Date.now(),
      apiVersion: 1,
    }),
    conversationExtensionUiPreferences: async () => structuredClone(conversationExtensionUi),
    saveConversationExtensionUiPreferences: async (payload) => {
      if (payload.layout === 'grid' || payload.layout === 'list') {
        conversationExtensionUi.layout = payload.layout;
      }
      if (Array.isArray(payload.globalOrder)) {
        conversationExtensionUi.globalOrder = [...payload.globalOrder];
      }
      if (payload.sessionId && Object.hasOwn(payload, 'sessionOrder')) {
        if (payload.sessionOrder === null) {
          delete conversationExtensionUi.sessionOrders[payload.sessionId];
        } else {
          conversationExtensionUi.sessionOrders[payload.sessionId] = [...payload.sessionOrder];
        }
      }
      return structuredClone(conversationExtensionUi);
    },
    onExtensionsChanged: () => () => {},
    runExtensionCommand: async () => ({ ok: true, message: '扩展命令已执行' }),
    updateState: async () => structuredClone(updateFixture),
    checkForUpdates: async () => structuredClone(updateFixture),
    downloadUpdate: async () => structuredClone(updateFixture),
    installUpdate: async () => ({ started: true }),
    onUpdateState: (listener) => {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    onOpenUpdate: () => () => {},
    onOpenSettings: () => () => {},
    onOpenMain: () => () => {},
    onOpenSession: () => () => {},
    onConversationListChanged: () => () => {},
    onRuntimeRefresh: () => () => {},
    onConfirmRequest: () => () => {},
    setTheme: async () => undefined,
    menuBarSettings: async () => ({ available: true, enabled: true, platform: 'darwin' }),
    setMenuBarVisible: async (enabled) => ({ available: true, enabled, platform: 'darwin' }),
    permissionPolicyGet: async () => permissionPolicyState(),
    permissionPolicySet: async ({ scope, policy }) => {
      if (scope === 'user' || scope === 'workspace' || scope === 'session') {
        permissionPolicies[scope] = structuredClone(policy);
      }
      return permissionPolicyState();
    },
    permissionPolicyReset: async ({ scope }) => {
      if (scope === 'workspace') permissionPolicies.workspace = null;
      else if (scope === 'session') permissionPolicies.session = null;
      else {
        permissionPolicies.user = {
          version: 1,
          preset: 'smart',
          default: 'ask',
          tools: {},
          rules: [],
        };
      }
      return permissionPolicyState();
    },
    permissionEvaluate: async ({ policy, call }) => {
      const decision = policy.tools?.[call.name] || policy.default || 'ask';
      return {
        decision,
        explanation: decision === 'allow' ? '未命中限制规则，当前策略允许执行' : '当前策略要求确认',
        previewScope: 'user',
        matches: [],
        risk: {
          level: call.name === 'bash' ? 'high' : 'low',
          title: call.name === 'bash' ? '执行本机命令' : '读取工具',
          detail: String(call.arguments?.command || call.arguments?.path || ''),
        },
        context: {
          tool: call.name,
          command: String(call.arguments?.command || ''),
          path: call.arguments?.path,
        },
        rememberScopes: ['once', 'session'],
        cwd,
        sessionId: '',
      };
    },
    modeGet: async () => permissionPolicyState(),
    modeSet: async ({ mode, scope = 'user' }) => {
      const target = scope === 'user' ? permissionPolicies.user : permissionPolicies[scope];
      if (target) {
        target.preset = mode;
        target.default = permissionDefaults[mode];
      }
      return { ...permissionPolicyState(), applied: true };
    },
    composerResources: async () => ({ commands: [] }),
    searchFiles: async () => ({ files: [] }),
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
  console.log(`captured ${name}`);
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
  await page.getByRole('button', { name: /^(?:新对话默认模型|当前会话模型)$/ }).click();
  await page.getByRole('menuitem', { name: /^(?:修改默认模型|切换会话模型)/ }).click();
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
  // 没有更新时不占品牌行空间；发现更新后，入口与上方侧栏开关使用相同尺寸和右边线。
  assert.equal(await page.locator('.brand-update').count(), 0);
  await page.evaluate(() => window.__setUpdateState('available'));
  const updateButton = page.getByRole('button', { name: /可以更新/ });
  await updateButton.waitFor();
  const [toggleBounds, updateBounds] = await Promise.all([
    page.getByRole('button', { name: '收起侧边栏' }).boundingBox(),
    updateButton.boundingBox(),
  ]);
  assert.ok(toggleBounds && updateBounds);
  assert.equal(updateBounds.width, toggleBounds.width);
  assert.equal(updateBounds.height, toggleBounds.height);
  assert.ok(Math.abs((updateBounds.x + updateBounds.width) - (toggleBounds.x + toggleBounds.width)) <= 1);
  const updateAnimation = await updateButton.evaluate((element) => ({
    glyph: getComputedStyle(element.querySelector('svg')).animationName,
    ring: getComputedStyle(element, '::before').animationName,
  }));
  assert.match(updateAnimation.glyph, /updateGlyph/);
  assert.match(updateAnimation.ring, /updateAttention/);
  await capture('01b-update-available');
  await page.evaluate(() => window.__setUpdateState('idle'));
  await updateButton.waitFor({ state: 'detached' });
  await capture('01-welcome');

  // 侧边栏搜索：空结果时展示占位文案；再次点击搜索按钮收起搜索框，
  // 然后折叠/展开侧边栏，确认折叠态布局正常。
  await page.getByRole('button', { name: '搜索工作区', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索工作区或会话' }).fill('no-match');
  await page.getByText('没有匹配的结果').waitFor();
  const sidebarEmptyAlignment = await page.evaluate(() => ({
    heading: document.querySelector('.workspace-head > span')?.getBoundingClientRect().left,
    empty: document.querySelector('.sidebar-empty > span')?.getBoundingClientRect().left,
  }));
  assert.ok(
    typeof sidebarEmptyAlignment.heading === 'number'
      && typeof sidebarEmptyAlignment.empty === 'number'
      && Math.abs(sidebarEmptyAlignment.heading - sidebarEmptyAlignment.empty) <= 1,
    'sidebar empty-state text must align with the workspace heading',
  );
  await page.getByRole('button', { name: '搜索工作区', exact: true }).click();
  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await capture('02-collapsed');
  await page.getByRole('button', { name: '展开侧边栏' }).click();

  // -------------------------------------------------------------------------
  // 5. 模型选择器与推理等级
  // -------------------------------------------------------------------------
  // 先截一张“模型与推理设置”弹层的默认状态，再进入模型子菜单。
  await page.getByRole('button', { name: /^(?:新对话默认模型|当前会话模型)$/ }).click();
  await capture('03-model-settings');
  await page.getByRole('menuitem', { name: /^(?:修改默认模型|切换会话模型)/ }).click();
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
  await page.getByRole('menuitem', { name: /^(?:默认思考强度|会话思考强度)/ }).click();
  assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), ['Default', 'Low', 'High', 'Max']);
  await capture('03-thinking-levels');

  // 选择 Max 后：弹层关闭、按钮文案更新、IPC 收到的参数包含当前 cwd。
  await selectModel('Max');
  assert.match(await page.getByRole('button', { name: /^(?:新对话默认模型|当前会话模型)$/ }).innerText(), /Max/);
  // 冷启动还没选工作区，cwd 为空串是预期行为（主进程会回退到默认目录）。
  assert.deepEqual(await page.evaluate(() => window.__lastThinking), {
    modelRef: 'opencode-go/deepseek-v4.1-flash',
    level: 'max',
    cwd: '',
  });

  // 切换到不支持推理的 DeepSeek Chat，推理入口应被禁用。
  await openModelMenu();
  await selectModel('DeepSeek Chat');
  await page.getByRole('button', { name: /^(?:新对话默认模型|当前会话模型)$/ }).click();
  assert.equal(await page.getByRole('menuitem', { name: /^(?:默认思考强度|会话思考强度) 不支持$/ }).isDisabled(), true);

  // 切回支持 Max 的 Go 模型，之前保存的 Max 应自动恢复（弹层此时仍开着）。
  await page.getByRole('menuitem', { name: /^(?:修改默认模型|切换会话模型)/ }).click();
  await selectModel('DeepSeek V4.1 Flash');
  assert.match(await page.getByRole('button', { name: /^(?:新对话默认模型|当前会话模型)$/ }).innerText(), /Max/);

  // 保存失败的路径：打开推理菜单，让 IPC 抛错，点击 Low 后应弹出错误提示，
  // 且当前选中项仍停留在 Max（界面不能乐观地改掉已保存值）。
  await page.getByRole('button', { name: /^(?:新对话默认模型|当前会话模型)$/ }).click();
  await page.getByRole('menuitem', { name: /^(?:默认思考强度|会话思考强度)/ }).click();
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
  assert.match(await page.getByRole('button', { name: /^(?:新对话默认模型|当前会话模型)$/ }).innerText(), /Max/);

  // -------------------------------------------------------------------------
  // 6. 会话与文件面板
  // -------------------------------------------------------------------------
  // 冷启动时工作区是收起的：先展开，再点开第一个会话。
  await page.locator('.workspace-row').first().click();
  await page.locator('.session-row').first().click();
  await capture('04-conversation');
  const conversationContentWidth = await page.locator('.chat-scroll > .chat-column').evaluate((column) => (
    column.getBoundingClientRect().width
  ));

  // 会话扩展在顶部分页中展开；主对话始终使用正常消息渲染，不混入扩展卡片。
  assert.equal(await page.locator('.messages .extension-slot').count(), 0);
  const headerExtensionDock = page.getByRole('navigation', { name: '会话顶部扩展', exact: true });
  const footerExtensionDock = page.getByRole('navigation', { name: '会话底部扩展', exact: true });
  assert.equal(await page.locator('.conversation-extension-dock-label').count(), 0);
  assert.equal(await headerExtensionDock.locator('.conversation-extension-dock-item').count(), 1);
  assert.equal(await footerExtensionDock.locator('.conversation-extension-dock-item').count(), 2);
  assert.equal(await footerExtensionDock.locator('button.conversation-extension-dock-item').count(), 0);
  assert.deepEqual(
    await footerExtensionDock.locator('.conversation-extension-dock-item').evaluateAll((items) => (
      items.map((item) => item.tagName)
    )),
    ['ARTICLE', 'ARTICLE'],
  );
  const footerGeometry = await footerExtensionDock
    .locator('.conversation-extension-dock-item')
    .evaluateAll((items) => items.map((item) => ({
      height: item.getBoundingClientRect().height,
      clientHeight: item.clientHeight,
      scrollHeight: item.scrollHeight,
      overflowY: getComputedStyle(item).overflowY,
      hasFullLayout: Boolean(item.querySelector(
        '.extension-metric-grid, .extension-section, .extension-table, .extension-disclosure',
      )),
      compactWhiteSpace: getComputedStyle(
        item.querySelector('.extension-compact-content'),
      ).whiteSpace,
    })));
  assert.ok(footerGeometry.every((item) => item.height <= 34));
  assert.ok(footerGeometry.every((item) => item.scrollHeight <= item.clientHeight + 1));
  assert.ok(footerGeometry.every((item) => item.overflowY === 'hidden'));
  assert.ok(footerGeometry.every((item) => item.hasFullLayout === false));
  assert.ok(footerGeometry.every((item) => item.compactWhiteSpace === 'nowrap'));
  assert.match(await headerExtensionDock.innerText(), /消息/);
  assert.match(await headerExtensionDock.innerText(), /工具/);
  assert.match(await footerExtensionDock.innerText(), /main · 2 files changed/);
  assert.match(await footerExtensionDock.innerText(), /审查 · 2 个关注点/);
  const conversationTabs = page.getByRole('tablist', { name: '对话视图' }).getByRole('tab');
  assert.equal(await conversationTabs.count(), 3);
  assert.equal(await page.locator('.chat-tab-list .tab > svg').count(), 3);
  assert.match(await conversationTabs.nth(0).innerText(), /^对话$/);
  assert.match(await conversationTabs.nth(1).innerText(), /^子智能体\s*2/);
  assert.match(await conversationTabs.nth(2).innerText(), /^扩展\s*2/);
  const extensionTab = page.getByRole('tab', { name: /^扩展/ });
  assert.equal(await extensionTab.locator('.tab-count').innerText(), '2');
  await extensionTab.click();
  await page.locator('.conversation-extension-hub').waitFor();
  const extensionContentWidth = await page.locator('.conversation-extension-scroll > .chat-column').evaluate((column) => (
    column.getBoundingClientRect().width
  ));
  assert.equal(extensionContentWidth, conversationContentWidth);
  assert.equal(await page.locator('.extension-hub-card').count(), 2);
  assert.equal(await page.locator('.extension-hub-card .extension-slot-card').count(), 0);
  assert.equal(await page.locator('.extension-hub-card-rail').count(), 0);
  assert.equal(await page.locator('.extension-hub-card-drag').count(), 2);
  assert.deepEqual(
    await page.locator('.extension-hub-card-title strong').allTextContents(),
    ['运行状态', '审查焦点'],
  );
  await page.getByRole('button', { name: '紧凑列表', exact: true }).click();
  assert.match(await page.locator('.extension-hub-items').getAttribute('class'), /\bis-list\b/);
  await page.getByRole('button', { name: '下移 运行状态', exact: true }).click();
  await page.waitForFunction(() => (
    [...document.querySelectorAll('.extension-hub-card-title strong')]
      .map((element) => element.textContent)
      .join('|') === '审查焦点|运行状态'
  ));
  assert.deepEqual(await page.evaluate(() => structuredClone(window.__conversationExtensionUiQa)), {
    version: 1,
    layout: 'list',
    globalOrder: ['user:review-tools', 'user:workspace-tools'],
    sessionOrders: {},
  });
  const extensionScope = page.getByRole('group', { name: '扩展排序范围' });
  await extensionScope.getByRole('button', { name: '当前会话', exact: true }).click();
  assert.equal(
    await page.locator('.extension-hub-items').getAttribute('data-order-scope'),
    'session',
  );
  await page.getByRole('button', { name: '下移 审查焦点', exact: true }).click();
  await page.waitForFunction(() => (
    [...document.querySelectorAll('.extension-hub-card-title strong')]
      .map((element) => element.textContent)
      .join('|') === '运行状态|审查焦点'
  ));
  assert.deepEqual(
    await page.evaluate(() => window.__conversationExtensionUiQa.sessionOrders['session-1']),
    ['user:workspace-tools', 'user:review-tools'],
  );
  await page.getByRole('button', { name: '恢复全局', exact: true }).click();
  await page.waitForFunction(() => (
    [...document.querySelectorAll('.extension-hub-card-title strong')]
      .map((element) => element.textContent)
      .join('|') === '审查焦点|运行状态'
  ));
  assert.equal(
    await page.evaluate(() => Boolean(window.__conversationExtensionUiQa.sessionOrders['session-1'])),
    false,
  );
  assert.equal(
    await page.locator('.extension-hub-items').getAttribute('data-order-scope'),
    'global',
  );
  await page.getByRole('button', { name: '卡片布局', exact: true }).click();
  assert.match(await page.locator('.extension-hub-items').getAttribute('class'), /\bis-grid\b/);
  assert.equal(await page.evaluate(() => window.__conversationExtensionUiQa.layout), 'grid');
  const extensionCardEdges = await page.locator('.extension-hub-card').first().evaluate((card) => {
    const title = card.querySelector('.extension-hub-card-title')?.getBoundingClientRect();
    const content = card.querySelector('.extension-hub-card-content')?.getBoundingClientRect();
    return title && content
      ? { titleLeft: title.left, contentLeft: content.left, titleRight: title.right, contentRight: content.right }
      : null;
  });
  assert.ok(extensionCardEdges);
  assert.ok(Math.abs(extensionCardEdges.titleLeft - extensionCardEdges.contentLeft) <= 1);
  assert.ok(Math.abs(extensionCardEdges.titleRight - extensionCardEdges.contentRight) <= 1);
  const extensionActionSize = await page.locator('.extension-hub-card-actions > button').first().evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  });
  assert.deepEqual(extensionActionSize, { width: 16, height: 16 });
  await capture('04b-extension-hub');
  const statusHubCard = page.locator('.extension-hub-card', { hasText: '运行状态' });
  assert.match(await statusHubCard.innerText(), /main · 2 files changed/);
  assert.match(await statusHubCard.innerText(), /42%/);
  const detailReadability = await statusHubCard.evaluate((card) => {
    const content = card.querySelector('.extension-hub-card-content');
    return {
      overflow: content ? content.scrollWidth - content.clientWidth : Number.POSITIVE_INFINITY,
      labels: [...card.querySelectorAll('.extension-content dt')]
        .map((element) => element.textContent?.trim()),
    };
  });
  assert.ok(detailReadability.overflow <= 1);
  assert.deepEqual(detailReadability.labels, ['分支', '上下文', '速度']);
  await statusHubCard.getByRole('button', { name: '查看详情', exact: true }).click();
  const extensionDialog = page.getByRole('dialog', { name: '工作区运行详情' });
  await extensionDialog.waitFor();
  assert.match(await extensionDialog.innerText(), /声明式扩展面板/);
  await capture('04b-extension-tab-panel');
  await extensionDialog.getByRole('button', { name: '关闭扩展面板', exact: true }).click();
  await extensionDialog.waitFor({ state: 'detached' });
  await page.locator('.conversation-extension-hub').waitFor();

  // 子智能体只有一个聚合 Tab；总览可进入只读上下文，并有明确路径回到主智能体。
  const agentTab = page.getByRole('tab', { name: /^子智能体/ });
  assert.equal(await agentTab.locator('.tab-count').innerText(), '2');
  assert.match(await agentTab.locator('.agent-tab-count').getAttribute('class'), /\bis-live\b/);
  assert.match(await agentTab.locator('.agent-tab-count').getAttribute('aria-label'), /有任务正在运行/);
  await agentTab.click();
  await page.getByRole('heading', { name: '子智能体总览', exact: true }).waitFor();
  assert.equal(await page.locator('.agent-child-card').count(), 2);
  assert.match(await page.locator('.agent-fleet-strip').innerText(), /运行中\s*1/);
  assert.match(await page.locator('.agent-fleet-strip').innerText(), /已完成\s*1/);
  await capture('04c-subagent-overview');
  await page.locator('.agent-child-card.is-running').click();
  await page.locator('.agent-context-view').waitFor();
  assert.match(await page.locator('.agent-context-view').innerText(), /Durable Runtime 审查/);
  assert.match(await page.locator('.agent-context-view').innerText(), /审查 Durable 请求边界和模型热更新路径/);
  assert.equal(await page.locator('.composer-dock').isVisible(), false);
  await capture('04d-subagent-transcript');
  await page.getByRole('button', { name: '返回主智能体', exact: true }).click();
  await page.locator('.chat-scroll').waitFor();
  await page.locator('.messages').waitFor();

  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await page.locator('.messages').waitFor();

  // 扩展提示统一收进通知中心，不再浮动遮挡对话内容。
  await page.getByRole('button', { name: '通知', exact: true }).click();
  const notificationPanel = page.getByRole('dialog', { name: '通知中心', exact: true });
  await notificationPanel.waitFor();
  assert.match(await notificationPanel.innerText(), /暂无通知/);
  await page.keyboard.press('Escape');
  await notificationPanel.waitFor({ state: 'detached' });

  // 打开文件查看器，读取根目录列表，再点开 package.json 预览代码。
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click();
  // 面板默认停在「开始」页，先切到文件标签再等文件列表。
  await page.getByRole('button', { name: /^工作区文件/ }).click();
  await capture('05-files');
  await page.getByRole('button', { name: 'package.json', exact: false }).click();
  await page.locator('.code-line').first().waitFor();
  await capture('06-file-preview');
  await page.getByRole('button', { name: '收起右侧面板' }).click();

  // -------------------------------------------------------------------------
  // 7. 设置页
  // -------------------------------------------------------------------------
  // 从底部入口进入设置，按导航顺序切换分页并截图。
  await page.locator('.bottom-row').click();
  assert.deepEqual(
    await page.locator('.settings-nav-row').allTextContents(),
    ['通用', '模型配置', '使用量', '归档会话', 'Agent 工具', '权限策略', 'Harness 配置', '子 Agent', 'MCP 服务器', '技能', '扩展', '关于'],
  );
  for (const [index, tab] of ['模型配置', '使用量', '归档会话', 'Agent 工具', '权限策略', 'Harness 配置', '子 Agent', 'MCP 服务器', '技能', '扩展', '关于'].entries()) {
    await openSettingsSection(tab);
    await capture(`${String(index + 7).padStart(2, '0')}-settings-${index}`);
  }
  // 设置页不应出现独立页面级别的大标题 / 图标（保持紧凑的设置面板风格）。
  assert.equal(await page.locator('.settings-title, .page-icon, .page-eyebrow').count(), 0);

  // 7.0 使用量：长期数据来自日期 + 模型聚合；热力图可以按当前启用模型筛选。
  await openSettingsSection('使用量');
  await page.getByRole('heading', { name: 'Token 使用量', exact: true }).waitFor();
  assert.ok(await page.locator('.usage-heat-cell').count() >= 365);
  assert.equal(await page.locator('.usage-model-row').count(), 4);
  assert.doesNotMatch(await page.locator('.usage-model-row').first().innerText(), /NaN|undefined/);
  const usageModelFilters = page.getByRole('group', { name: '按模型筛选热力图', exact: true });
  assert.equal(await usageModelFilters.getByRole('button').count(), 5);
  const retiredUsageFilter = usageModelFilters.getByRole('button', { name: /^Retired Reasoner/ });
  assert.match(await retiredUsageFilter.innerText(), /已停用/);
  await retiredUsageFilter.click();
  await page.getByRole('grid', { name: /Retired Reasoner，365 天 Token 使用量/ }).waitFor();
  const deepSeekUsageFilter = usageModelFilters.getByRole('button', { name: /^DeepSeek V4\.1 Flash/ });
  await deepSeekUsageFilter.click();
  assert.equal(await deepSeekUsageFilter.getAttribute('aria-pressed'), 'true');
  await page.getByRole('grid', { name: /DeepSeek V4\.1 Flash，365 天 Token 使用量/ }).waitFor();
  await page.getByRole('button', { name: '90 天', exact: true }).click();
  await page.getByRole('grid', { name: /DeepSeek V4\.1 Flash，90 天 Token 使用量/ }).waitFor();
  const usage90Cell = await page.locator('.usage-heat-cell:not(.is-outside)').first().evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height };
  });
  assert.ok(usage90Cell.width >= 23 && usage90Cell.height === usage90Cell.width);
  await page.getByRole('button', { name: '180 天', exact: true }).click();
  await page.getByRole('grid', { name: /DeepSeek V4\.1 Flash，180 天 Token 使用量/ }).waitFor();
  const usage180Cell = await page.locator('.usage-heat-cell:not(.is-outside)').first().evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height };
  });
  assert.ok(usage180Cell.width >= 18 && usage180Cell.height === usage180Cell.width);
  await page.getByRole('button', { name: '1 年', exact: true }).click();
  await page.getByRole('grid', { name: /DeepSeek V4\.1 Flash，365 天 Token 使用量/ }).waitFor();
  const usageYear = await page.locator('.usage-heatmap-card').evaluate((card) => {
    const grid = card.querySelector('.usage-heatmap-grid')?.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    return grid ? { gridWidth: grid.width, cardWidth: box.width } : null;
  });
  assert.ok(usageYear);
  assert.ok(usageYear.gridWidth > usageYear.cardWidth * .72);
  await capture('06a-usage-model-filter');

  // 7.0 通用设置：四套全局配色使用同一组页面表面与语义状态色；
  // 切换卡片会同步根节点、按钮实际颜色和本地持久化数据。
  await openSettingsSection('通用');
  const paletteChoices = page.getByRole('radiogroup', { name: '全局配色方案' });
  await paletteChoices.waitFor();
  assert.equal(await paletteChoices.getByRole('radio').count(), 4);
  await paletteChoices.getByRole('radio', { name: /^海蓝/ }).click();
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'ocean');
  assert.equal(await paletteChoices.getByRole('radio', { name: /^海蓝/ }).getAttribute('aria-checked'), 'true');
  assert.equal(await paletteChoices.getByRole('radio', { name: /^海蓝/ }).locator('.palette-preview-actions b').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(124, 183, 255)');
  await capture('11a-general-palette-light');

  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await paletteChoices.getByRole('radio', { name: /^莓果/ }).click();
  await page.waitForFunction(() => document.documentElement.dataset.palette === 'berry');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pi-studio:preferences') || '{}').palette), 'berry');
  await capture('11b-general-palette-dark');

  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await paletteChoices.getByRole('radio', { name: /^玉石/ }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' && document.documentElement.dataset.palette === 'lime');

  // 7.0.1 权限策略：所有选择控件必须走共享 Select，不再渲染平台原生下拉框。
  await openSettingsSection('权限策略');
  await page.locator('.permission-policy-chain').waitFor();
  assert.equal(await page.locator('select').count(), 0);
  const defaultDecision = page.getByRole('button', { name: '未命中时的权限决定', exact: true });
  await defaultDecision.click();
  await page.getByRole('listbox', { name: '未命中时的权限决定', exact: true }).waitFor();
  assert.equal(await page.getByRole('option').count(), 3);
  await capture('12-permission-policy-select');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '未命中时的权限决定');

  // 7.1 Agent 工具：同一 Pi 核心来源只出现一个 Tab；卡片开关不误触详情，
  // 卡片主体打开完整详情，来源切换与搜索都保留正确状态。
  await openSettingsSection('Agent 工具');
  await page.getByRole('tablist', { name: '工具来源' }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 3);
  assert.equal(await page.getByRole('tab', { name: /^Pi 核心/ }).count(), 1);
  assert.equal(await page.locator('.agent-tool-card').count(), 7);
  await capture('12a-agent-tools-core');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture('12a-dark-agent-tools-core');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  await page.getByRole('button', { name: '查看工具 bash 详情', exact: true }).click();
  const toolDetail = page.locator('.agent-tool-detail-dialog');
  await toolDetail.waitFor();
  assert.match(await toolDetail.innerText(), /durable:coding/);
  assert.match(await toolDetail.innerText(), /直接提供/);
  await capture('12b-agent-tool-detail');
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await toolDetail.waitFor({ state: 'detached' });

  const bashSwitch = page.getByRole('switch', { name: '允许工具 bash', exact: true });
  await bashSwitch.click();
  assert.equal(await page.locator('.agent-tool-detail-dialog').count(), 0);
  await page.getByRole('switch', { name: '禁用工具 bash', exact: true }).click();

  await page.getByRole('tab', { name: /^studio-subagents/ }).click();
  await page.getByRole('button', { name: '查看工具 subagent 详情', exact: true }).waitFor();
  assert.equal(await page.locator('.agent-tool-card').count(), 2);
  await capture('12c-agent-tools-subagents');

  await page.getByRole('textbox', { name: '搜索 Agent 工具', exact: true }).fill('workspace');
  await page.getByRole('tab', { name: /^workspace-tools/ }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 1);
  await page.getByRole('button', { name: '清除工具搜索', exact: true }).click();
  await page.getByRole('tab', { name: /^Pi 核心/ }).press('Home');
  assert.equal(await page.getByRole('tab', { name: /^Pi 核心/ }).getAttribute('aria-selected'), 'true');
  const dialog = page.locator('.settings-dialog');

  // 7.1.1 Harness 配置：Profile 使用横向 tab，编辑器操作位于内容头部，
  // 旧的纵向选择栏和悬浮 actionbar 不应回归。
  await openSettingsSection('Harness 配置');
  await page.getByRole('heading', { name: /^Harness 配置/ }).waitFor();
  await page.locator('.settings-content').evaluate((element) => { element.scrollTop = 0; });
  assert.equal(await page.locator('.harness-workspace, .harness-profile-rail, .harness-actionbar').count(), 0);
  assert.equal(await page.locator('.harness-editor-head .harness-editor-actions').count(), 1);
  assert.equal(await page.locator('.harness-section-card').count(), 8);
  assert.equal(await page.locator('.harness-policy-group').count(), 4);
  assert.equal(
    await page.locator('.harness-policy-group').first()
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(250, 250, 250)',
  );
  assert.equal(
    await page.locator('.harness-section-override').first()
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(250, 250, 250)',
  );
  assert.equal(
    await page.locator('.harness-tool-guidance-row').first()
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(250, 250, 250)',
  );
  await page.locator('.harness-policy-card').scrollIntoViewIfNeeded();
  await capture('12d-harness-policy-light');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture('12e-harness-policy-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.locator('.settings-content').evaluate((element) => { element.scrollTop = 0; });
  const harnessTabs = page.locator('.harness-profile-tabs [role="tab"]');
  assert.equal(await harnessTabs.count(), 3);
  assert.equal(await harnessTabs.first().getAttribute('aria-selected'), 'true');
  await harnessTabs.first().press('ArrowRight');
  await page.waitForFunction(() => document.querySelectorAll('.harness-profile-tabs [role="tab"]')[1]?.getAttribute('aria-selected') === 'true');
  assert.match(await page.getByLabel('Harness 名称', { exact: true }).inputValue(), /严格审阅/);
  await page.waitForFunction(() => document.activeElement?.id === 'harness-profile-tab-review-first');
  await harnessTabs.nth(1).press('Home');
  await page.waitForFunction(() => document.activeElement?.id === 'harness-profile-tab-studio-coding');
  assert.match(await page.getByLabel('Harness 名称', { exact: true }).inputValue(), /Studio 编码基线/);
  const harnessInstructions = page.getByLabel('Harness 附加指令', { exact: true });
  await harnessInstructions.fill(`${await harnessInstructions.inputValue()}\n最终回复必须列出验证命令。`);
  const saveHarness = page.getByRole('button', { name: '保存配置', exact: true });
  assert.equal(await saveHarness.isEnabled(), true);
  assert.equal(await page.locator('.harness-editor-head').getByRole('button', { name: '保存配置', exact: true }).count(), 1);
  await page.locator('.settings-content').evaluate((element) => { element.scrollTop = 0; });
  await capture('12d-harness-light');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture('12e-harness-dark');
  const harnessActionHeight = await page.locator('.harness-editor-actions .settings-save')
    .evaluate((element) => element.getBoundingClientRect().height);
  const harnessScopeHeight = await page.locator('.harness-editor-context .settings-scope-tabs button')
    .first()
    .evaluate((element) => element.getBoundingClientRect().height);
  const harnessContextHeight = await page.locator('.harness-editor-context')
    .evaluate((element) => element.getBoundingClientRect().height);
  assert.equal(harnessScopeHeight, harnessActionHeight);
  assert.ok(harnessContextHeight >= 64);
  await page.locator('.harness-section-overrides').scrollIntoViewIfNeeded();
  await capture('12e-harness-overrides-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await capture('12d-harness-overrides-light');
  const overrideGridWidth = await page.locator('.harness-section-overrides')
    .evaluate((element) => element.getBoundingClientRect().width);
  await page.locator('.harness-section-overrides summary').first().click();
  const openOverride = page.locator('.harness-section-overrides details').first();
  await openOverride.getByRole('textbox').waitFor();
  assert.ok(await openOverride.evaluate((element) => element.getBoundingClientRect().width)
    >= overrideGridWidth - 8);
  await capture('12d-harness-override-open-light');
  await openOverride.locator('summary').click();
  const toolGuidanceLabels = page.locator('.harness-tool-guidance-row label > span');
  const [toolLabelTop, guidanceLabelTop] = await toolGuidanceLabels.evaluateAll(
    (labels) => labels.map((label) => label.getBoundingClientRect().top),
  );
  const [toolFieldTop, guidanceFieldTop] = await page.locator(
    '.harness-tool-guidance-row input, .harness-tool-guidance-row textarea',
  ).evaluateAll((fields) => fields.map((field) => field.getBoundingClientRect().top));
  assert.equal(toolLabelTop, guidanceLabelTop);
  assert.equal(toolFieldTop, guidanceFieldTop);
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  assert.equal(await dialog.getAttribute('class'), 'settings-dialog is-backdropless');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await saveHarness.click();
  await page.getByRole('status').filter({ hasText: '配置已保存' }).waitFor();
  assert.match(await page.evaluate(() => window.__lastHarnessSave?.customInstructions || ''), /验证命令/);
  await harnessTabs.first().click();
  await harnessTabs.nth(1).click();
  assert.equal(await harnessTabs.nth(1).getAttribute('aria-selected'), 'true');
  const applyHarness = page.locator('.harness-editor-head').getByRole('button', { name: '应用到工作区', exact: true });
  assert.equal(await applyHarness.isEnabled(), true);
  await applyHarness.click();
  await page.getByRole('status').filter({ hasText: '已应用到当前工作区' }).waitFor();
  assert.equal(await page.locator('.harness-editor-head').getByRole('button', { name: '已应用', exact: true }).isDisabled(), true);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  // 7.1.2 子 Agent：全局默认与指定工作区的覆盖必须明确区分，保存使用所选工作区。
  await openSettingsSection('子 Agent');
  await page.locator('.subagent-runtime-status.is-ready').waitFor();
  assert.equal(await page.getByRole('radio', { name: /所有工作区/ }).count(), 1);
  assert.equal(await page.getByRole('radio', { name: /指定工作区/ }).count(), 1);
  await page.getByRole('radio', { name: /指定工作区/ }).click();
  await page.getByLabel('子 Agent 目标工作区', { exact: true }).waitFor();
  await page.getByLabel('子 Agent 目标工作区', { exact: true }).click();
  await page.getByRole('option', { name: /design-system/ }).click();
  await page.waitForFunction(() => window.__lastSubagentLoadCwd === '/workspace/design-system');
  await page.locator('.settings-content').evaluate((element) => { element.scrollTop = 0; });
  await capture('12f-subagent-settings');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture('12g-subagent-settings-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  assert.ok(await page.locator('.subagent-tool-row').count() >= 4);
  await page.locator('.subagent-tool-row').first().click();
  const solidControlForegrounds = await page.evaluate(() => {
    const toolCheck = document.querySelector('.subagent-tool-row.is-enabled .subagent-tool-check');
    const toggle = document.querySelector('.subagent-toggle-row input:checked');
    const probe = document.createElement('button');
    probe.className = 'settings-save';
    document.body.append(probe);
    const saveStyle = getComputedStyle(probe);
    const styles = {
      saveColor: saveStyle.color,
      saveBackground: saveStyle.backgroundColor,
      toolColor: toolCheck ? getComputedStyle(toolCheck).color : '',
      toolBackground: toolCheck ? getComputedStyle(toolCheck).backgroundColor : '',
      toggleBackground: toggle ? getComputedStyle(toggle).backgroundColor : '',
      toggleThumb: toggle ? getComputedStyle(toggle, '::after').backgroundColor : '',
    };
    probe.remove();
    return styles;
  });
  assert.equal(solidControlForegrounds.saveColor, 'rgb(255, 255, 255)');
  assert.equal(solidControlForegrounds.toolColor, 'rgb(255, 255, 255)');
  assert.equal(solidControlForegrounds.toggleThumb, 'rgb(255, 255, 255)');
  assert.equal(solidControlForegrounds.toolBackground, solidControlForegrounds.saveBackground);
  assert.equal(solidControlForegrounds.toggleBackground, solidControlForegrounds.saveBackground);
  await page.locator('.subagent-savebar').scrollIntoViewIfNeeded();
  await capture('12h-subagent-solid-controls');
  await page.locator('.subagent-savebar').getByRole('button', { name: '保存配置', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__lastSubagentSave));
  assert.deepEqual(await page.evaluate(() => ({
    cwd: window.__lastSubagentSave.cwd,
    scope: window.__lastSubagentSave.scope,
  })), { cwd: '/workspace/design-system', scope: 'project' });

  // 7.2 模型配置：来源列表、来源编辑对话框的草稿与保存
  await openSettingsSection('模型配置');
  const modelFooterLayout = await page.locator('.model-card-footer').first().evaluate((footer) => {
    const status = footer.querySelector('.resource-status');
    const remove = footer.querySelector('.model-card-remove');
    const footerBox = footer.getBoundingClientRect();
    const statusBox = status.getBoundingClientRect();
    const removeBox = remove.getBoundingClientRect();
    const statusStyle = getComputedStyle(status);
    const removeStyle = getComputedStyle(remove);
    return {
      statusInset: statusBox.left - footerBox.left,
      removeInset: footerBox.right - removeBox.right,
      hasGap: statusBox.right < removeBox.left,
      statusDisplay: statusStyle.display,
      statusBackground: statusStyle.backgroundColor,
      statusBorder: statusStyle.borderTopWidth,
      removeDisplay: removeStyle.display,
      removePadding: removeStyle.paddingInlineStart,
      removeBorder: removeStyle.borderTopWidth,
    };
  });
  assert.ok(modelFooterLayout.statusInset <= 16);
  assert.ok(modelFooterLayout.removeInset <= 16);
  assert.equal(modelFooterLayout.hasGap, true);
  assert.match(modelFooterLayout.statusDisplay, /^(inline-)?flex$/);
  assert.notEqual(modelFooterLayout.statusBackground, 'rgba(0, 0, 0, 0)');
  assert.notEqual(modelFooterLayout.statusBorder, '0px');
  assert.match(modelFooterLayout.removeDisplay, /^(inline-)?flex$/);
  assert.notEqual(modelFooterLayout.removePadding, '0px');
  assert.notEqual(modelFooterLayout.removeBorder, '0px');
  const providerFooterAlignment = await page.locator('.provider-card').first().evaluate((card) => {
    const cardBox = card.getBoundingClientRect();
    const iconBox = card.querySelector('.provider-avatar').getBoundingClientRect();
    const statusBox = card.querySelector('.resource-status').getBoundingClientRect();
    const actionsBox = card.querySelector('.provider-actions').getBoundingClientRect();
    const statusStyle = getComputedStyle(card.querySelector('.resource-status'));
    return {
      iconInset: iconBox.left - cardBox.left,
      statusInset: statusBox.left - cardBox.left,
      actionsInset: cardBox.right - actionsBox.right,
      statusDisplay: statusStyle.display,
      statusBorder: statusStyle.borderTopWidth,
    };
  });
  assert.ok(Math.abs(providerFooterAlignment.statusInset - providerFooterAlignment.iconInset) <= 1);
  assert.ok(providerFooterAlignment.actionsInset <= 16);
  assert.match(providerFooterAlignment.statusDisplay, /^(inline-)?flex$/);
  assert.notEqual(providerFooterAlignment.statusBorder, '0px');
  await page.getByRole('button', { name: '管理模型', exact: true }).first().click();
  await page.locator('.provider-model-row').first().waitFor();
  const nativeCheckbox = await page.locator('.provider-model-check input:checked').first().evaluate((input) => ({
    background: getComputedStyle(input).backgroundColor,
    mark: getComputedStyle(input, '::after').borderRightColor,
  }));
  assert.equal(nativeCheckbox.mark, 'rgb(255, 255, 255)');
  assert.notEqual(nativeCheckbox.background, 'rgba(0, 0, 0, 0)');
  const providerEditBox = await page.getByRole('button', { name: '编辑 MiniMax', exact: true }).evaluate((button) => ({
    width: button.getBoundingClientRect().width,
    height: button.getBoundingClientRect().height,
    scrollWidth: button.scrollWidth,
    clientWidth: button.clientWidth,
  }));
  assert.ok(providerEditBox.width > providerEditBox.height);
  assert.ok(providerEditBox.scrollWidth <= providerEditBox.clientWidth);
  await capture('12-provider-models');

  // 新增来源对话框：填写后取消，不能留下草稿卡片。
  await page.getByRole('button', { name: '添加模型来源', exact: true }).click();
  await capture('13-add-provider-dialog');
  assert.equal(await dialog.getAttribute('class'), 'settings-dialog is-backdropless');
  const providerDialogBackdrop = await dialog.evaluate((element) => {
    const style = getComputedStyle(element, '::backdrop');
    return { background: style.backgroundColor, backdrop: style.backdropFilter };
  });
  assert.equal(providerDialogBackdrop.background, 'rgba(0, 0, 0, 0)');
  assert.equal(providerDialogBackdrop.backdrop, 'none');
  assert.equal(await dialog.getByLabel('首个模型 ID', { exact: true }).count(), 0);
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

  // 7.3 来源内模型管理：模型归属固定，新增后在同一列表内编辑。
  await page.getByRole('button', { name: '添加模型', exact: true }).first().click();
  await dialog.getByLabel('模型 ID', { exact: true }).fill('new-model');
  await dialog.getByLabel('显示名称', { exact: true }).fill('New Model');
  await dialog.getByRole('checkbox', { name: /图片输入/ }).check();
  await dialog.getByRole('checkbox', { name: /推理模型/ }).check();
  const reasoningLevels = dialog.getByRole('group', { name: '可用推理等级' }).getByRole('checkbox');
  assert.equal(await reasoningLevels.count(), 7);
  for (const level of ['Off', 'Minimal', 'Low', 'Medium', 'High']) {
    assert.equal(await dialog.getByRole('checkbox', { name: level, exact: true }).getAttribute('aria-checked'), 'true');
  }
  for (const level of ['XHigh', 'Max']) {
    assert.equal(await dialog.getByRole('checkbox', { name: level, exact: true }).getAttribute('aria-checked'), 'false');
  }
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '编辑模型 New Model', exact: true }).click();
  await dialog.getByLabel('显示名称', { exact: true }).fill('Updated Model');
  const contextUnit = dialog.getByRole('button', { name: '上下文长度单位', exact: true });
  assert.match(await contextUnit.textContent(), /\bK\b/);
  await contextUnit.click();
  for (const unit of ['Tokens', 'K', 'M', 'B', 'T']) {
    await dialog.getByRole('option', { name: unit, exact: true }).waitFor();
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.settings-dialog').count(), 1, 'Escape in a unit menu must not close the model editor');
  await dialog.getByLabel('上下文长度', { exact: true }).fill('64');
  assert.equal(
    await dialog.locator('.model-token-exact').first().textContent(),
    '64,000 tokens',
  );
  await dialog.getByRole('checkbox', { name: 'Max', exact: true }).click();
  assert.equal(await dialog.getByRole('checkbox', { name: 'Max', exact: true }).getAttribute('aria-checked'), 'true');
  await capture('15-edit-model-dialog');
  await dialog.getByRole('button', { name: '保存更改', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '编辑模型 Updated Model', exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑模型 Updated Model', exact: true }).click();
  await dialog.getByRole('group', { name: '可用推理等级' }).waitFor();
  assert.equal(await dialog.getByLabel('上下文长度', { exact: true }).inputValue(), '64');
  assert.match(await dialog.getByRole('button', { name: '上下文长度单位', exact: true }).textContent(), /\bK\b/);
  assert.equal(
    await dialog.getByRole('checkbox', { name: 'Max', exact: true }).getAttribute('aria-checked'),
    'true',
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.provider-card').first().locator('.provider-model-row').count(), 3);

  // 7.3.1 第三方模型发现：先预览，再一次性导入缺失模型。
  await page.getByRole('button', { name: '获取模型', exact: true }).first().click();
  await page.getByText('发现 2 个模型', { exact: true }).waitFor();
  const fastDiscovery = page.getByRole('checkbox', { name: '选择模型 Discovered Fast', exact: true });
  const visionDiscovery = page.getByRole('checkbox', { name: '选择模型 Discovered Vision', exact: true });
  assert.equal(await fastDiscovery.isChecked(), false);
  assert.equal(await visionDiscovery.isChecked(), false);
  await visionDiscovery.check();
  await capture('15b-provider-model-selection');
  await page.getByRole('button', { name: '添加所选 1 个', exact: true }).click();
  await page.getByText('已添加并启用 1 个模型，可逐个调整能力与上下文。', { exact: true }).waitFor();
  assert.equal(await page.locator('.provider-card').first().locator('.provider-model-row').count(), 4);
  assert.equal(
    await page.getByRole('checkbox', { name: '停用模型 Discovered Vision', exact: true }).isChecked(),
    true,
  );
  const addedVision = page.getByRole('checkbox', { name: '已添加模型 Discovered Vision', exact: true });
  assert.equal(await addedVision.isChecked(), true);
  assert.match(await addedVision.locator('..').getAttribute('class'), /\bis-selected\b/);
  assert.equal(await addedVision.locator('..').getByText('已添加', { exact: true }).count(), 0);
  assert.equal(
    await page.locator('.provider-card').first().getByText('自定义', { exact: true }).count(),
    0,
  );
  await capture('15b-provider-model-discovery');
  await page.getByRole('button', { name: '全选未添加', exact: true }).click();
  assert.equal(await fastDiscovery.isChecked(), true);
  await page.getByRole('button', { name: '清空选择', exact: true }).click();
  assert.equal(await fastDiscovery.isChecked(), false);

  // 7.3.2 新来源可以先保持空模型目录；用户随后从来源内部添加第一个模型。
  await page.getByRole('button', { name: '添加模型来源', exact: true }).click();
  await dialog.getByLabel('来源 ID', { exact: true }).fill('empty-gateway');
  await dialog.getByLabel('显示名称', { exact: true }).fill('Empty Gateway');
  await dialog.getByLabel('服务地址', { exact: true }).fill('https://empty.example.test/v1');
  await dialog.getByLabel('模型列表地址', { exact: true }).fill('https://empty.example.test/v1/models');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.locator('.provider-model-head').getByText('这个来源还没有模型', { exact: true }).waitFor();
  assert.equal(await page.locator('.provider-model-empty').getByRole('button').count(), 0);
  assert.equal(await page.locator('.provider-card').count(), 4);
  await capture('15c-empty-provider');
  const fallbackIconAlignment = await page.locator('.provider-card', { hasText: 'Empty Gateway' }).locator('.provider-icon-letter').evaluate((letter) => {
    const icon = letter.parentElement;
    const letterBox = letter.getBoundingClientRect();
    const iconBox = icon.getBoundingClientRect();
    return {
      x: Math.abs((letterBox.left + letterBox.width / 2) - (iconBox.left + iconBox.width / 2)),
      y: Math.abs((letterBox.top + letterBox.height / 2) - (iconBox.top + iconBox.height / 2)),
    };
  });
  assert.ok(fallbackIconAlignment.x <= 1 && fallbackIconAlignment.y <= 1);

  // 来源操作固定在卡片上：启停可逆，删除先确认；详情和模型编辑不承担删除职责。
  const emptyGatewayCard = page.locator('.provider-card', { hasText: 'Empty Gateway' });
  await emptyGatewayCard.getByRole('switch', { name: '停用模型来源 Empty Gateway', exact: true }).click();
  await page.getByRole('switch', { name: '启用模型来源 Empty Gateway', exact: true }).waitFor();
  assert.match(await emptyGatewayCard.getAttribute('class'), /\bis-disabled\b/);
  await emptyGatewayCard.getByRole('switch', { name: '启用模型来源 Empty Gateway', exact: true }).click();
  await page.getByRole('switch', { name: '停用模型来源 Empty Gateway', exact: true }).waitFor();
  await emptyGatewayCard.getByRole('button', { name: '删除模型来源 Empty Gateway', exact: true }).click();
  await page.getByRole('dialog', { name: '删除模型来源？' }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.provider-card').count(), 4);
  await emptyGatewayCard.getByRole('button', { name: '删除模型来源 Empty Gateway', exact: true }).click();
  await page.getByRole('dialog', { name: '删除模型来源？' }).getByRole('button', { name: '删除来源', exact: true }).click();
  await page.locator('.provider-card', { hasText: 'Empty Gateway' }).waitFor({ state: 'detached' });
  assert.equal(await page.locator('.provider-card').count(), 3);

  // 7.4 MCP 服务器：切换分页后内容应回到顶部；新增时重名要展示行内错误，
  // 修改名称后可成功创建；编辑已有服务器应保留带空格的启动参数。
  await openSettingsSection('MCP 服务器');
  assert.equal(await page.locator('.settings-content').evaluate((element) => element.scrollTop), 0);
  await page.locator('.mcp-card').first().getByRole('button', { name: '查看详情', exact: true }).click();
  await capture('15d-mcp-detail');
  const mcpDetail = page.locator('.detail-dialog--small');
  await mcpDetail.waitFor();
  assert.equal(await mcpDetail.getByRole('button', { name: '删除', exact: true }).count(), 0);
  assert.equal(await mcpDetail.getByRole('button', { name: '编辑', exact: true }).count(), 0);
  await mcpDetail.getByRole('button', { name: '关闭', exact: true }).click();
  await mcpDetail.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '添加 MCP 服务器', exact: true }).click();
  await capture('16-add-mcp-dialog');
  assert.equal(await dialog.getAttribute('class'), 'settings-dialog is-backdropless');
  const mcpDialogBackdrop = await dialog.evaluate((element) => {
    const style = getComputedStyle(element, '::backdrop');
    return { background: style.backgroundColor, backdrop: style.backdropFilter };
  });
  assert.equal(mcpDialogBackdrop.background, 'rgba(0, 0, 0, 0)');
  assert.equal(mcpDialogBackdrop.backdrop, 'none');
  await dialog.getByLabel('名称', { exact: true }).fill('filesystem');
  await dialog.getByRole('button', { name: '传输方式', exact: true }).click();
  await page.getByRole('option', { name: 'Streamable HTTP', exact: true }).click();
  await dialog.locator('input[placeholder="https://example.com/mcp"]').waitFor();
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
  for (const [index, tab] of ['模型配置', '使用量', 'Agent 工具', '权限策略', 'Harness 配置', '子 Agent', 'MCP 服务器', '技能', '扩展', '关于'].entries()) {
    await openSettingsSection(tab);
    await capture(`21-compact-settings-${index}`);
  }
  await openSettingsSection('使用量');
  await page.getByRole('heading', { name: 'Token 使用量', exact: true }).waitFor();
  await page.getByRole('button', { name: '1 年', exact: true }).click();
  await page.getByRole('grid', { name: /365 天 Token 使用量/ }).waitFor();
  const compactUsageOverflow = await page.locator('.usage-heatmap-scroll').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  assert.ok(compactUsageOverflow.scrollWidth > compactUsageOverflow.clientWidth);
  await page.locator('.usage-heatmap-card').scrollIntoViewIfNeeded();
  await capture('21a-compact-usage-heatmap');

  // 技能与扩展导入对话框都提供统一的范围选择、错误展示和键盘关闭。
  await openSettingsSection('技能');
  assert.equal(await page.locator('.skill-source-head').count(), 4);
  assert.equal(await page.getByRole('heading', { name: /Studio 应用技能/ }).count(), 1);
  assert.equal(await page.getByRole('heading', { name: /^Agent Skills/ }).count(), 2);
  assert.equal(
    await page.locator('.skill-source-head code').first().innerText(),
    '/Users/demo/Library/Application Support/pi-studio/skills',
  );
  assert.equal(
    await page.locator('.skill-source-head code').nth(1).innerText(),
    '/Users/demo/.agents/skills',
  );
  assert.equal(
    await page.locator('.skill-source-head code').nth(2).innerText(),
    '/workspace/pi-studio/.pi-studio/skills',
  );
  assert.equal(
    await page.locator('.skill-source-head code').nth(3).innerText(),
    '/workspace/pi-studio/.agents/skills',
  );
  await page.locator('.skill-card', { hasText: 'code-review' }).locator('.skill-card-main').click();
  const skillDetail = page.locator('.skill-detail-dialog');
  await skillDetail.waitFor();
  const skillDetailOverlay = await page.locator('.detail-overlay').evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, backdrop: style.backdropFilter };
  });
  assert.equal(skillDetailOverlay.background, 'rgba(0, 0, 0, 0)');
  assert.equal(skillDetailOverlay.backdrop, 'none');
  assert.equal(await skillDetail.getByRole('button', { name: '删除技能', exact: true }).count(), 0);
  await skillDetail.getByRole('button', { name: '关闭', exact: true }).click();
  await skillDetail.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '删除技能 code-review', exact: true }).click();
  await page.getByRole('dialog', { name: '删除技能？' }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();

  await page.getByRole('button', { name: '添加技能', exact: true }).click();
  const skillDialogBackdrop = await dialog.evaluate((element) => {
    const style = getComputedStyle(element, '::backdrop');
    return { background: style.backgroundColor, backdrop: style.backdropFilter };
  });
  assert.equal(skillDialogBackdrop.background, 'rgba(0, 0, 0, 0)');
  assert.equal(skillDialogBackdrop.backdrop, 'none');
  await dialog.locator('input[type="radio"]').nth(1).check();
  await dialog.getByRole('button', { name: '项目技能工作区', exact: true }).click();
  await page.getByRole('option', { name: /design-system/ }).click();
  await capture('22-skill-import-dialog');
  await dialog.getByText('生效范围', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '选择文件夹并添加', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.__skillQa.added), [{
    scope: 'project',
    cwd: '/workspace/design-system',
  }]);

  await openSettingsSection('扩展');
  assert.deepEqual(await page.locator('.installed-extension-title strong').allTextContents(), ['workspace-tools', 'Studio 子 Agent']);
  assert.equal(await page.locator('.installed-extension-card').count(), 2);
  assert.equal(await page.locator('.installed-extension-row').count(), 0);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture('21-compact-extension-dark');
  const installedCard = page.locator('.installed-extension-card').first();
  const installedSurface = await installedCard.evaluate((card) => getComputedStyle(card).backgroundColor);
  await installedCard.hover();
  await page.waitForTimeout(200);
  assert.equal(await installedCard.evaluate((card) => getComputedStyle(card).backgroundColor), installedSurface);
  assert.equal(await installedCard.evaluate((card) => card.classList.contains('settings-resource-card')), true);
  const installedCardStyle = await installedCard.evaluate((card) => {
    const icon = card.querySelector('.extension-card-icon');
    const state = card.querySelector('.extension-card-state.is-ready');
    const toggle = card.querySelector('.switch');
    const thumb = toggle?.querySelector('span');
    const iconStyle = icon ? getComputedStyle(icon) : null;
    const stateStyle = state ? getComputedStyle(state) : null;
    const toggleBox = toggle?.getBoundingClientRect();
    const thumbBox = thumb?.getBoundingClientRect();
    return {
      iconColor: iconStyle?.color,
      iconBackground: iconStyle?.backgroundColor,
      stateColor: stateStyle?.color,
      stateBackground: stateStyle?.backgroundColor,
      toggleWidth: toggleBox?.width,
      toggleHeight: toggleBox?.height,
      toggleLeft: toggleBox?.left,
      toggleRight: toggleBox?.right,
      thumbLeft: thumbBox?.left,
      thumbRight: thumbBox?.right,
    };
  });
  assert.equal(installedCardStyle.stateColor, installedCardStyle.iconColor);
  assert.equal(installedCardStyle.stateBackground, installedCardStyle.iconBackground);
  assert.equal(installedCardStyle.toggleWidth, 38);
  assert.equal(installedCardStyle.toggleHeight, 22);
  assert.ok(installedCardStyle.thumbLeft >= installedCardStyle.toggleLeft);
  assert.ok(installedCardStyle.thumbRight <= installedCardStyle.toggleRight);
  const extensionDelete = page.getByRole('button', { name: '卸载 workspace-tools', exact: true });
  assert.equal(await extensionDelete.count(), 1);
  await extensionDelete.click();
  await page.getByRole('dialog', { name: '卸载扩展？' }).waitFor();
  const confirmIconRadius = await page.locator('.confirm-icon').evaluate((icon) => ({
    actual: getComputedStyle(icon).borderRadius,
    expected: getComputedStyle(document.documentElement).getPropertyValue('--radius-control').trim(),
  }));
  assert.equal(confirmIconRadius.actual, confirmIconRadius.expected);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.installed-extension-card').first().scrollIntoViewIfNeeded();
  await capture('21b-installed-extension-cards-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.getByRole('button', { name: '查看 workspace-tools 详情', exact: true }).click();
  const extensionDetail = page.locator('.extension-detail-dialog');
  await extensionDetail.waitFor();
  await extensionDetail.getByRole('heading', { name: 'workspace-tools', exact: true }).waitFor();
  await extensionDetail.getByText('Agent 工具', { exact: true }).waitFor();
  const extensionDetailOverlay = await page.locator('.detail-overlay').evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, backdrop: style.backdropFilter };
  });
  assert.equal(extensionDetailOverlay.background, 'rgba(0, 0, 0, 0)');
  assert.equal(extensionDetailOverlay.backdrop, 'none');
  assert.equal(await extensionDetail.getByRole('button', { name: '卸载', exact: true }).count(), 0);
  await capture('23-extension-detail');
  await extensionDetail.getByRole('button', { name: '关闭扩展详情', exact: true }).click();
  await extensionDetail.waitFor({ state: 'detached' });

  // StrictMode 会模拟一次挂载与卸载；安装预览令牌不能被这次模拟卸载销毁。
  // 这里走官方扩展的完整“准备 -> 确认 -> 安装”路径，并同时检查正文初始在顶部。
  const officialCard = page.locator('.official-extension-card', { hasText: '额度状态' });
  await officialCard.getByRole('button', { name: '安装', exact: true }).click();
  await dialog.waitFor();
  assert.equal(await dialog.getAttribute('class'), 'settings-dialog is-backdropless');
  await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(() => window.__extensionInstallQa.disposedTokens), []);
  assert.equal(await dialog.locator('.dialog-body').evaluate((element) => element.scrollTop), 0);
  await dialog.getByRole('button', { name: '安装 v0.1.0', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.__extensionInstallQa.installedTokens), ['official-quota-status-1']);
  assert.deepEqual(await page.evaluate(() => window.__extensionInstallQa.disposedTokens), []);

  await page.getByRole('button', { name: '安装扩展', exact: true }).click();
  await dialog.locator('.extension-scope-cards button').first().waitFor();
  assert.equal(await dialog.getAttribute('class'), 'settings-dialog is-backdropless');
  assert.equal(await dialog.locator('.extension-scope-cards button').count(), 2);
  assert.equal(await dialog.locator('.extension-scope-cards button').first().getAttribute('aria-pressed'), 'true');
  assert.equal(await dialog.locator('.dialog-body').evaluate((element) => element.scrollTop), 0);
  await capture('24-extension-import-dialog');
  await dialog.locator('.extension-source-tabs').waitFor();
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
  await page.getByRole('button', { name: /^(?:新对话默认模型|当前会话模型)$/ }).click();
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
  assert.equal(await page.locator('.chat-tabs:not(.is-placeholder)').count(), 0);

  // 没有模型来源时，新对话默认区必须显示可操作的引导空状态，
  // 而不是渲染禁用下拉框和仅有首字母的伪 Provider 图标。
  await page.evaluate(async () => {
    const current = await window.piApi.settings();
    for (const provider of current.providers) {
      await window.piApi.removeProvider({ providerId: provider.id });
    }
  });
  await page.locator('.bottom-row').click();
  await openSettingsSection('模型配置');
  const emptyDefaultModel = page.locator('.default-model-empty');
  await emptyDefaultModel.waitFor();
  assert.equal(await page.locator('.default-model-panel .provider-icon').count(), 0);
  assert.equal(await page.locator('.default-model-panel .pi-select-trigger').count(), 0);
  assert.equal(await emptyDefaultModel.getByRole('button', { name: '添加模型来源', exact: true }).count(), 1);
  await capture('30-models-empty-light');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture('30-models-empty-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await emptyDefaultModel.getByRole('button', { name: '添加模型来源', exact: true }).click();
  const addProviderDialog = page.getByRole('dialog', { name: '添加模型来源', exact: true });
  await addProviderDialog.waitFor();
  await addProviderDialog.getByRole('button', { name: '取消', exact: true }).click();
  await addProviderDialog.waitFor({ state: 'detached' });

  // 整个流程中浏览器不能有未捕获异常。
  assert.deepEqual(errors, [], 'Browser runtime errors');
  console.log(`UI checks passed; screenshots saved to ${output}`);
} finally { await browser.close(); }

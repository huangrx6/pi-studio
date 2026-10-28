const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } = require('electron');
const { execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { readConfig, writeConfig, updateMcp, updateProvider, updateCustomModel, visibleProviderIds } = require('./settings-config.cjs');

let pi;
let modelOptions;
let mainWindow;
async function loadPi() {
  pi = await import('@earendil-works/pi-coding-agent');
  modelOptions = await import('./model-options.mjs');
}
const DEV = process.env.PI_STUDIO_DEV === '1';
const SESSION_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');
const DEFAULT_CWD = process.env.PI_WORKSPACE ?? process.cwd();
let MODEL_REF = process.env.PI_MODEL_REF ?? 'minimax-cn/MiniMax-M3.1-Flash';
let thinkingPreferences = {};

const drafts = new Map();
const diskSessions = new Map();
const agentSessions = new Map();
let runtimePromise;

function runtime() {
  runtimePromise ??= (async () => {
    const agentDir = pi.getAgentDir();
    return pi.ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      allowModelNetwork: true,
      refreshOnCreate: true,
    });
  })();
  return runtimePromise;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function walkJsonl(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && target.endsWith('.jsonl')) files.push(target);
    }
  };
  try { visit(root); } catch { /* no sessions */ }
  return files;
}

function readHeader(file) {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    if (!first) return undefined;
    const value = JSON.parse(first);
    return typeof value.id === 'string' && typeof value.cwd === 'string'
      ? { id: value.id, cwd: value.cwd }
      : undefined;
  } catch { return undefined; }
}

async function indexSessions() {
  const cwds = new Set();
  for (const file of walkJsonl(SESSION_ROOT)) {
    const header = readHeader(file);
    if (header) cwds.add(header.cwd);
  }
  if (cwds.size === 0) cwds.add(DEFAULT_CWD);
  diskSessions.clear();
  for (const cwd of cwds) {
    let infos = [];
    try { infos = await pi.SessionManager.list(cwd); } catch { /* skip unreadable */ }
    for (const info of infos) {
      const title = (info.name || info.firstMessage.split('\n')[0] || '新会话').trim().slice(0, 80);
      diskSessions.set(info.id, {
        id: info.id,
        path: info.path,
        cwd: info.cwd || cwd,
        title,
        updatedAt: info.modified.getTime(),
        messageCount: info.messageCount,
      });
    }
  }
}

async function listWorkspaces() {
  await indexSessions();
  const byCwd = new Map();
  for (const session of diskSessions.values()) {
    const list = byCwd.get(session.cwd) || [];
    list.push(session);
    byCwd.set(session.cwd, list);
  }
  for (const draft of drafts.values()) {
    const list = byCwd.get(draft.cwd) || [];
    if (!list.some((item) => item.id === draft.manager.getSessionId())) {
      list.push({ id: draft.manager.getSessionId(), path: '', cwd: draft.cwd, title: '新会话', updatedAt: Date.now(), messageCount: 0 });
    }
    byCwd.set(draft.cwd, list);
  }
  if (byCwd.size === 0) byCwd.set(DEFAULT_CWD, []);
  return [...byCwd.entries()].map(([cwd, sessions]) => ({
    cwd,
    name: path.basename(cwd) || cwd,
    sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

async function modelInfo(cwd = DEFAULT_CWD) {
  const rt = await runtime();
  const [provider, ...parts] = MODEL_REF.split('/');
  const found = provider && parts.length > 0 ? rt.getModel(provider, parts.join('/')) : undefined;
  const selected = found || rt.getModels()[0];
  return { modelRef: found ? MODEL_REF : `${selected?.provider}/${selected?.id}`, label: selected?.name || MODEL_REF, ...reasoningFor(selected, cwd) };
}

function reasoningFor(model, cwd = DEFAULT_CWD) {
  const settings = pi.SettingsManager.create(cwd);
  return modelOptions.reasoningOptions(model, thinkingPreferences[`${model?.provider}/${model?.id}`], {
    defaultThinkingLevel: settings.getDefaultThinkingLevel(),
    modelThinkingLevels: settings.getAllModelThinkingLevels(),
  });
}

async function findManager(id) {
  const draft = drafts.get(id);
  if (draft) return { manager: draft.manager, cwd: draft.cwd };
  await indexSessions();
  const session = diskSessions.get(id);
  if (!session) return undefined;
  try { return { manager: pi.SessionManager.open(session.path, undefined, session.cwd), cwd: session.cwd }; }
  catch { return undefined; }
}

const BUILTIN_COMPOSER_COMMANDS = [
  { name: 'new', description: '开始一个新会话', source: 'builtin' },
  { name: 'model', description: '打开模型与账号设置', source: 'builtin' },
  { name: 'thinking', description: '调整模型的思考强度', source: 'builtin' },
  { name: 'settings', description: '打开设置', source: 'builtin' },
  { name: 'copy', description: '复制最后一条助理回复', source: 'builtin' },
];

async function composerResources({ sessionId, cwd }) {
  const commands = [...BUILTIN_COMPOSER_COMMANDS];
  let session;
  if (sessionId) {
    try {
      const found = await findManager(sessionId);
      if (found) session = await ensureAgent(sessionId, found.manager, found.cwd);
    } catch { /* fall back to global discovery */ }
  }
  if (session) {
    for (const command of session.extensionRunner.getRegisteredCommands()) {
      commands.push({ name: command.invocationName, description: command.description || '', source: 'extension' });
    }
    for (const template of session.promptTemplates) {
      commands.push({ name: template.name, description: template.description, source: 'prompt', argumentHint: template.argumentHint });
    }
    for (const skill of session.resourceLoader.getSkills().skills) {
      commands.push({ name: `skill:${skill.name}`, description: skill.description, source: 'skill' });
    }
  } else if (cwd) {
    try {
      const loaded = pi.loadSkills({
        cwd,
        agentDir: pi.getAgentDir(),
        skillPaths: [path.join(pi.getAgentDir(), 'skills'), path.join(os.homedir(), '.agents', 'skills')],
        includeDefaults: false,
      });
      for (const skill of loaded.skills) commands.push({ name: `skill:${skill.name}`, description: skill.description, source: 'skill' });
    } catch { /* no global skills available */ }
  }
  return { commands };
}

const SEARCH_IGNORED_DIRS = new Set(['.git', 'node_modules', '.pnpm-store', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache', 'target', 'vendor', '.venv', 'venv', 'release', '.DS_Store']);
async function searchWorkspaceFiles(cwd, query) {
  const root = path.resolve(cwd);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { files: [] };
  const files = [];
  const queue = [{ dir: root, rel: '' }];
  let scanned = 0;
  while (queue.length > 0 && scanned < 4000) {
    const current = queue.shift();
    let entries = [];
    try { entries = await fs.promises.readdir(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (scanned >= 4000) break;
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SEARCH_IGNORED_DIRS.has(entry.name)) queue.push({ dir: path.join(current.dir, entry.name), rel });
      } else if (entry.isFile()) {
        scanned += 1;
        files.push({ name: entry.name, path: rel });
      }
    }
  }
  const needle = String(query || '').toLowerCase();
  const ranked = files.map((file) => {
    const lowerName = file.name.toLowerCase();
    const lowerPath = file.path.toLowerCase();
    const rank = !needle ? 2 : lowerName.startsWith(needle) ? 0 : lowerName.includes(needle) ? 1 : lowerPath.includes(needle) ? 2 : -1;
    return { ...file, rank };
  }).filter((file) => file.rank >= 0).sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return { files: ranked.slice(0, 40) };
}

function serializeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text });
    else if (block.type === 'image' && typeof block.data === 'string') blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType || 'image/png' });
    else if (block.type === 'thinking') blocks.push({ type: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '', ...(block.redacted ? { redacted: true } : {}) });
    else if (block.type === 'toolCall') blocks.push({ type: 'toolCall', id: block.id, name: block.name, arguments: block.arguments && typeof block.arguments === 'object' ? block.arguments : {}, ...(block.namespace ? { namespace: block.namespace } : {}) });
  }
  return blocks;
}

function serializeMessage(message) {
  if (!message || !['user', 'assistant', 'toolResult'].includes(message.role)) return null;
  const result = { role: message.role, content: serializeContent(message.content), timestamp: message.timestamp };
  if (message.role === 'assistant') {
    result.stopReason = message.stopReason;
    result.errorMessage = message.errorMessage;
    result.model = message.responseModel || message.model;
    result.provider = message.provider;
    result.usage = message.usage;
    result.thinkingLevel = message.thinkingLevel;
  }
  if (message.role === 'toolResult') {
    result.toolCallId = message.toolCallId;
    result.toolName = message.toolName;
    result.isError = Boolean(message.isError);
    if (message.durationMs !== undefined) result.durationMs = message.durationMs;
  }
  return result;
}

async function detail(id) {
  const found = await findManager(id);
  if (!found) return undefined;
  const messages = found.manager.getEntries()
    .filter((entry) => entry.type === 'message')
    .map((entry) => serializeMessage(entry.message))
    .filter(Boolean);
  return { id, cwd: found.cwd, title: diskSessions.get(id)?.title || '新会话', messages };
}

async function ensureAgent(id, manager, cwd) {
  if (agentSessions.has(id)) {
    const session = agentSessions.get(id);
    session.setThinkingLevel(reasoningFor(session.model, cwd).effectiveThinkingLevel);
    return session;
  }
  const rt = await runtime();
  const [provider, ...parts] = MODEL_REF.split('/');
  const model = provider && parts.length > 0 ? rt.getModel(provider, parts.join('/')) : undefined;
  if (!model) throw new Error(`Pi 模型 ${MODEL_REF} 不在本机目录中`);
  const { session } = await pi.createAgentSession({
    cwd,
    model,
    thinkingLevel: reasoningFor(model, cwd).effectiveThinkingLevel,
    modelRuntime: rt,
    sessionManager: manager,
    tools: ['read', 'grep', 'find', 'ls'],
  });
  agentSessions.set(id, session);
  return session;
}

function resolveInWorkspace(root, requested) {
  const canonicalRoot = fs.realpathSync(root);
  const target = path.resolve(canonicalRoot, requested || '.');
  const canonical = fs.realpathSync(target);
  if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + path.sep)) throw new Error('outside workspace');
  return canonical;
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (typeof value.modelRef === 'string' && value.modelRef.includes('/')) MODEL_REF = value.modelRef;
    if (value.thinkingLevels && typeof value.thinkingLevels === 'object' && !Array.isArray(value.thinkingLevels)) thinkingPreferences = value.thinkingLevels;
  } catch { /* first launch */ }
}

function saveConfig(modelRef = MODEL_REF, thinkingLevels = thinkingPreferences) {
  writeConfig(configPath(), { ...readConfig(configPath(), {}), modelRef, thinkingLevels });
}

async function availableModels(cwd = DEFAULT_CWD) {
  const rt = await runtime();
  const auth = readAuth();
  const config = readJson(path.join(pi.getAgentDir(), 'settings.json'), {});
  const enabled = Array.isArray(config.enabledModels) ? config.enabledModels : [];
  const configured = readJson(modelsFile(), { providers: {} }).providers || {};
  const visible = visibleProviderIds(auth, configured, enabled, MODEL_REF, rt.getProviders().filter((provider) => rt.hasConfiguredAuth(provider.id)).map((provider) => provider.id));
  const providerNames = new Map(rt.getProviders().map((provider) => [provider.id, provider.name]));
  const models = rt.getModels()
    .filter((item) => visible.has(item.provider))
    .map((item) => ({ id: `${item.provider}/${item.id}`, provider: item.provider, providerName: providerNames.get(item.provider) || item.provider, model: item.id, name: item.name, contextWindow: item.contextWindow, maxTokens: item.maxTokens, supportsImages: Array.isArray(item.input) && item.input.includes('image'), reasoning: Boolean(item.reasoning) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { models, enabled, current: MODEL_REF, selection: await modelInfo(cwd) };
}

function authFile() {
  return path.join(pi.getAgentDir(), 'auth.json');
}
function envNameOf(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value.trim());
  return match ? (match[1] ?? match[2]) : undefined;
}

function readAuth() {
  try { return JSON.parse(fs.readFileSync(authFile(), 'utf8')); }
  catch { return {}; }
}

function readMcp() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(pi.getAgentDir(), 'mcp.json'), 'utf8'));
    return parsed && typeof parsed.mcpServers === 'object' ? parsed : { mcpServers: {} };
  } catch { return { mcpServers: {} }; }
}

async function settingsSnapshot(cwd = DEFAULT_CWD) {
  const rt = await runtime();
  const auth = readAuth();
  const allModels = rt.getModels();
  const configuredModels = readJson(modelsFile(), { providers: {} });
  const settings = readJson(path.join(pi.getAgentDir(), 'settings.json'), {});
  const enabledModels = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
  const visible = visibleProviderIds(auth, configuredModels.providers || {}, enabledModels, MODEL_REF, rt.getProviders().filter((provider) => rt.hasConfiguredAuth(provider.id)).map((provider) => provider.id));
  const providers = rt.getProviders()
    .filter((provider) => visible.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      authConfigured: auth[provider.id] !== undefined || rt.hasConfiguredAuth(provider.id),
      mode: auth[provider.id]?.type === 'oauth' ? 'oauth' : auth[provider.id]?.key?.startsWith('$') ? 'env' : 'key',
      icon: configuredModels.providers?.[provider.id]?.icon || '',
      envName: envNameOf(auth[provider.id]?.key),
      envAvailable: envNameOf(auth[provider.id]?.key) ? process.env[envNameOf(auth[provider.id]?.key)] !== undefined : false,
      models: allModels.filter((model) => model.provider === provider.id).length,
    }));
  const mcp = readMcp();
  const servers = Object.entries(mcp.mcpServers).map(([name, value]) => ({
    name,
    transport: value.type === 'stdio' || value.command ? 'stdio' : 'http',
    enabled: value.enabled !== false,
    target: value.command ? [value.command, ...(value.args || [])].join(' ') : value.url || '',
    description: value.description || '',
  }));
  let skills = [];
  try {
    const globalSkillPaths = [
      path.join(pi.getAgentDir(), 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
    ];
    const result = pi.loadSkills({
      cwd,
      agentDir: pi.getAgentDir(),
      skillPaths: globalSkillPaths,
      includeDefaults: false,
    });
    skills = result.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      scope: 'user',
    }));
  } catch { /* skill discovery is optional */ }
  const configuredPackages = Array.isArray(settings.packages) ? settings.packages : [];
  const extensions = listExtensions(cwd);
  let extensionData = [];
  try {
    extensionData = fs.readdirSync(path.join(pi.getAgentDir(), 'extensions-data'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch { /* none */ }
  return {
    providers,
    customModels: Object.entries(configuredModels.providers || {}).flatMap(([providerId, provider]) => (provider.models || []).map((model) => ({
      providerId, modelId: model.id, name: model.name || model.id, contextWindow: model.contextWindow,
      maxTokens: model.maxTokens, supportsImages: model.input?.includes('image') ?? false, reasoning: model.reasoning ?? false,
    }))),
    mcp: servers,
    skills,
    extensions: extensions.map((item) => ({ ...item, source: 'directory' })),
    packages: configuredPackages.map((source) => ({ source, name: source.replace(/^(npm:|git:)/, '') })),
    extensionData,
    enabledModels: Array.isArray(settings.enabledModels) ? settings.enabledModels : [],
    authPath: authFile(),
    mcpPath: path.join(pi.getAgentDir(), 'mcp.json'),
    modelsPath: modelsFile(),
    model: await modelInfo(cwd),
  };
}

function modelsFile() {
  return path.join(pi.getAgentDir(), 'models.json');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function providerExtensionRoots(cwd) {
  return [
    { scope: 'user', root: path.join(pi.getAgentDir(), 'extensions') },
    { scope: 'project', root: path.join(cwd, '.pi', 'extensions') },
  ];
}

function listExtensions(cwd) {
  const items = [];
  for (const { scope, root } of providerExtensionRoots(cwd)) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const target = path.join(root, entry.name);
      const isDirectory = entry.isDirectory();
      const entryFile = isDirectory
        ? ['index.ts', 'index.js'].map((name) => path.join(target, name)).find((value) => fs.existsSync(value))
        : target;
      if (!entryFile) continue;
      items.push({ name: entry.name, scope, path: target, kind: isDirectory ? 'directory' : 'file' });
    }
  }
  return items;
}

function makeMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ label: 'Pi Studio', submenu: [{ role: 'about' }, { type: 'separator' }, { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => mainWindow?.webContents.send('pi:open-settings') }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function applications() {
  const roots = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];
  const apps = new Map();
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
      const appPath = path.join(root, entry.name);
      const name = entry.name.slice(0, -4);
      if (!apps.has(name)) apps.set(name, { name, path: appPath });
    }
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function applicationsForFile(target) {
  return new Promise((resolve) => {
    const script = `ObjC.import('AppKit');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const apps = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL(url);
  return ObjC.unwrap(apps).map((item) => { const appPath = ObjC.unwrap(item.path); const displayName = ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(appPath)); return appPath + '\\t' + displayName; }).join('\\n');
}`;
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, target], { timeout: 6000 }, (error, stdout) => {
      if (error || !stdout) { resolve(applications()); return; }
      const seen = new Set();
      const apps = [];
      for (const raw of String(stdout).split('\n')) {
        const [appPath, displayName] = raw.trim().split('\t');
        if (!appPath || !appPath.endsWith('.app')) continue;
        const name = (displayName || path.basename(appPath, '.app')).replace(/\.app$/, '');
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        apps.push({ name, path: appPath });
      }
      resolve(apps.length > 0 ? apps : applications());
    });
  });
}

const appIconCache = new Map();
function applicationIcon(appPath) {
  if (appIconCache.has(appPath)) return appIconCache.get(appPath);
  try {
    const resources = path.join(appPath, 'Contents', 'Resources');
    const files = fs.readdirSync(resources).filter((file) => file.endsWith('.icns'));
    const preferred = ['AppIcon.icns', 'app.icns', 'icon.icns'];
    const file = preferred.map((name) => files.find((entry) => entry === name)).find(Boolean) ?? files[0];
    if (!file) return undefined;
    const png = path.join(os.tmpdir(), `pi-app-icon-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', '32', '32', path.join(resources, file), '--out', png], { stdio: 'ignore' });
    const data = `data:image/png;base64,${fs.readFileSync(png).toString('base64')}`;
    try { fs.unlinkSync(png); } catch { /* temp cleanup */ }
    appIconCache.set(appPath, data);
    return data;
  } catch {
    try {
      const image = nativeImage.createFromPath(appPath);
      if (!image.isEmpty()) {
        const data = image.resize({ width: 32, height: 32 }).toDataURL();
        appIconCache.set(appPath, data);
        return data;
      }
    } catch { /* no icon */ }
    appIconCache.set(appPath, undefined);
    return undefined;
  }
}

function workspaceFile(cwd, requested) {
  return resolveInWorkspace(cwd, requested);
}

function openWithApp(target, appPath) {
  if (!appPath) return shell.openPath(target).then((error) => { if (error) throw new Error(error); });
  if (!appPath.endsWith('.app') || !fs.existsSync(appPath)) throw new Error('应用程序不存在');
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', appPath, target], (error) => error ? reject(error) : resolve());
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#f7f8fa',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  if (DEV) void win.loadURL('http://127.0.0.1:5180');
  else void win.loadFile(path.join(__dirname, '..', 'web-dist', 'index.html'));
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  }
  await loadPi();
  loadConfig();
  ipcMain.handle('pi:state', async (_event, cwd) => ({ workspaces: await listWorkspaces(), model: await modelInfo(cwd || DEFAULT_CWD), cwd: DEFAULT_CWD }));
  ipcMain.handle('pi:session-create', async (_event, cwd) => {
    const manager = pi.SessionManager.create(cwd || DEFAULT_CWD);
    const id = manager.getSessionId();
    drafts.set(id, { manager, cwd: cwd || DEFAULT_CWD });
    return { id, cwd: cwd || DEFAULT_CWD, title: '新会话', messages: [] };
  });
  ipcMain.handle('pi:session', async (_event, id) => detail(id));
  ipcMain.handle('pi:composer-resources', async (_event, payload) => composerResources(payload || {}));
  ipcMain.handle('pi:search-files', async (_event, { cwd, query }) => searchWorkspaceFiles(cwd, query));
  ipcMain.handle('pi:file-actions', async (_event, { cwd, path: requested }) => {
    const target = workspaceFile(cwd, requested);
    if (!fs.existsSync(target)) throw new Error('文件不存在');
    const apps = await applicationsForFile(target);
    const withIcons = await Promise.all(apps.slice(0, 24).map(async (entry) => {
      try {
        const icon = applicationIcon(entry.path);
        if (icon) return { ...entry, icon };
        const image = await app.getFileIcon(entry.path, { size: 'normal' });
        return { ...entry, icon: image.toDataURL() };
      } catch { return entry; }
    }));
    return { apps: withIcons };
  });
  ipcMain.handle('pi:open-with', async (_event, { cwd, path: requested, appPath }) => {
    const target = workspaceFile(cwd, requested);
    await openWithApp(target, typeof appPath === 'string' ? appPath : undefined);
    return { ok: true };
  });
  ipcMain.handle('pi:open-external', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
    return { ok: true };
  });
  ipcMain.handle('pi:reveal-file', async (_event, { cwd, path: requested }) => {
    shell.showItemInFolder(workspaceFile(cwd, requested));
    return { ok: true };
  });
  ipcMain.handle('pi:files', async (_event, { cwd, path: requested }) => {
    const root = resolveInWorkspace(cwd, requested || '.');
    const entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => !['node_modules', '.git', '.next', 'dist'].includes(entry.name))
      .map((entry) => {
        const target = path.join(root, entry.name);
        return {
          name: entry.name,
          path: path.relative(fs.realpathSync(cwd), target),
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isFile() ? fs.statSync(target).size : 0,
        };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    return { path: path.relative(fs.realpathSync(cwd), root), entries };
  });
  ipcMain.handle('pi:file', async (_event, { cwd, path: requested }) => {
    const target = resolveInWorkspace(cwd, requested);
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error('不是文件');
    if (stat.size > 1_000_000) return { path: requested, size: stat.size, binary: true, text: '' };
    const buffer = fs.readFileSync(target);
    const binary = buffer.includes(0);
    return { path: requested, size: stat.size, binary, text: binary ? '' : buffer.toString('utf8') };
  });
  ipcMain.handle('pi:choose-workspace', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  });
async function fileReferenceContext(cwd, mentions) {
  const blocks = [];
  let budget = 240_000;
  const imageMimes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  for (const requested of [...new Set(Array.isArray(mentions) ? mentions : [])].slice(0, 12)) {
    if (typeof requested !== 'string' || !requested.trim()) continue;
    try {
      const target = resolveInWorkspace(cwd, requested);
      const stat = fs.statSync(target);
      if (!stat.isFile()) continue;
      const relative = path.relative(cwd, target).split(path.sep).join('/');
      const mime = imageMimes[path.extname(target).toLowerCase()];
      if (mime) {
        if (stat.size > 8_000_000) continue;
        blocks.push({ type: 'image', mimeType: mime, data: fs.readFileSync(target).toString('base64') });
        continue;
      }
      if (stat.size > budget) continue;
      const buffer = fs.readFileSync(target);
      if (buffer.includes(0)) continue;
      const content = buffer.toString('utf8');
      const clipped = content.length > budget ? content.slice(0, budget) : content;
      budget -= clipped.length;
      blocks.push({ type: 'text', text: `<file path="${relative}">\n${clipped}\n</file>` });
      if (budget <= 0) break;
    } catch { /* ignore missing or out-of-workspace paths */ }
  }
  return blocks;
}

  ipcMain.handle('pi:prompt', async (event, { sessionId, text, requestId, mentions }) => {
    const found = await findManager(sessionId);
    if (!found) throw new Error('会话不存在');
    const session = await ensureAgent(sessionId, found.manager, found.cwd);
    const referenceBlocks = await fileReferenceContext(found.cwd, mentions);
    if (referenceBlocks.length > 0) {
      try {
        await session.sendCustomMessage({
          customType: 'pi-studio:file-reference',
          content: [{ type: 'text', text: 'The user explicitly referenced the following workspace files. Treat them as primary context for this request.' }, ...referenceBlocks],
          display: false,
        }, { triggerTurn: false });
      } catch { /* file context is best-effort */ }
    }
    const send = (payload) => event.sender.send('pi:prompt-event', { requestId, ...payload });
    const unsubscribe = session.subscribe((piEvent) => {
      if (piEvent.type === 'message_start' || piEvent.type === 'message_update' || piEvent.type === 'message_end') {
        const message = serializeMessage(piEvent.message);
        if (message) send({ type: piEvent.type, message });
      }
    });
    try {
      await session.prompt(text);
      send({ type: 'done' });
      drafts.delete(sessionId);
    } catch (error) {
      send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      unsubscribe();
    }
  });
  ipcMain.handle('pi:remove-custom-model', async (_event, { providerId, modelId }) => {
    const config = readConfig(modelsFile(), { providers: {} });
    const provider = config.providers?.[providerId];
    if (!provider || !Array.isArray(provider.models)) throw new Error('模型不存在');
    provider.models = provider.models.filter((model) => model.id !== modelId);
    writeConfig(modelsFile(), config);
    const settingsPath = path.join(pi.getAgentDir(), 'settings.json');
    const settings = readConfig(settingsPath, {});
    settings.enabledModels = (settings.enabledModels || []).filter((id) => id !== `${providerId}/${modelId}`);
    writeConfig(settingsPath, settings);
    runtimePromise = undefined;
    agentSessions.clear();
    return settingsSnapshot(DEFAULT_CWD);
  });
  ipcMain.handle('pi:remove-mcp', async (_event, name) => {
    const file = path.join(pi.getAgentDir(), 'mcp.json');
    const config = readConfig(file, { mcpServers: {} });
    if (!Object.hasOwn(config.mcpServers || {}, name)) throw new Error('MCP 不存在');
    delete config.mcpServers[name];
    writeConfig(file, config);
    return settingsSnapshot(DEFAULT_CWD);
  });
  ipcMain.handle('pi:remove-skill', async (_event, skillPath) => {
    const target = path.resolve(String(skillPath || ''));
    const roots = [path.join(pi.getAgentDir(), 'skills'), path.join(os.homedir(), '.agents'), path.join(DEFAULT_CWD, '.pi', 'skills')];
    if (path.basename(target) !== 'SKILL.md') throw new Error('技能路径无效');
    const parent = path.dirname(target);
    const allowed = roots.some((root) => parent === root || parent.startsWith(root + path.sep)) || parent.includes(`${path.sep}.pi${path.sep}skills${path.sep}`);
    if (!allowed) throw new Error('不能删除这个位置的技能');
    if (!fs.existsSync(parent)) throw new Error('技能不存在');
    fs.rmSync(parent, { recursive: true, force: true });
    return settingsSnapshot(DEFAULT_CWD);
  });
  ipcMain.handle('pi:remove-extension', async (_event, extensionPath) => {
    const target = path.resolve(String(extensionPath || ''));
    const roots = [path.join(pi.getAgentDir(), 'extensions'), path.join(DEFAULT_CWD, '.pi', 'extensions')];
    if (!roots.some((root) => target === root || target.startsWith(root + path.sep)) && !target.includes(`${path.sep}.pi${path.sep}extensions${path.sep}`)) throw new Error('不能删除这个位置的扩展');
    if (!fs.existsSync(target)) throw new Error('扩展不存在');
    fs.rmSync(target, { recursive: true, force: true });
    return settingsSnapshot(DEFAULT_CWD);
  });
  ipcMain.handle('pi:add-skill', async (_event, { scope, cwd }) => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return undefined;
    const source = result.filePaths[0];
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error('所选目录缺少 SKILL.md');
    const base = scope === 'project' ? path.join(cwd || DEFAULT_CWD, '.pi', 'skills') : path.join(pi.getAgentDir(), 'skills');
    const target = path.join(base, path.basename(source));
    if (fs.existsSync(target)) throw new Error('同名技能已存在');
    fs.mkdirSync(base, { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    return settingsSnapshot(cwd || DEFAULT_CWD);
  });
  ipcMain.handle('pi:add-extension', async (_event, { scope, cwd }) => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'openFile'], filters: [{ name: 'Pi Extension', extensions: ['ts', 'js', 'mjs'] }] });
    if (result.canceled || !result.filePaths[0]) return undefined;
    const source = result.filePaths[0];
    const stat = fs.statSync(source);
    const base = scope === 'project' ? path.join(cwd || DEFAULT_CWD, '.pi', 'extensions') : path.join(pi.getAgentDir(), 'extensions');
    const target = path.join(base, path.basename(source));
    if (fs.existsSync(target)) throw new Error('同名扩展已存在');
    fs.mkdirSync(base, { recursive: true });
    if (stat.isDirectory()) {
      if (!['index.ts', 'index.js'].some((name) => fs.existsSync(path.join(source, name)))) throw new Error('扩展目录缺少 index.ts 或 index.js');
      fs.cpSync(source, target, { recursive: true });
    } else fs.copyFileSync(source, path.join(base, path.basename(source)));
    return settingsSnapshot(cwd || DEFAULT_CWD);
  });

  ipcMain.handle('pi:models', async (_event, cwd) => availableModels(cwd || DEFAULT_CWD));
  ipcMain.handle('pi:settings', async (_event, cwd) => settingsSnapshot(typeof cwd === 'string' ? cwd : DEFAULT_CWD));
  ipcMain.handle('pi:set-key', async (_event, { providerId, apiKey }) => {
    if (typeof providerId !== 'string' || typeof apiKey !== 'string' || apiKey.trim().length === 0) throw new Error('请输入 API Key 或环境变量引用');
    const value = apiKey.trim();
    if (value.startsWith('$') && !envNameOf(value)) throw new Error('环境变量格式应为 $NAME 或 ${NAME}');
    const auth = readAuth();
    auth[providerId] = { type: 'api_key', key: value };
    fs.mkdirSync(path.dirname(authFile()), { recursive: true });
    fs.writeFileSync(authFile(), JSON.stringify(auth, null, 2), { mode: 0o600 });
    runtimePromise = undefined;
    agentSessions.clear();
    return settingsSnapshot();
  });
  ipcMain.handle('pi:provider-config', async (_event, providerId) => {
    const rt = await runtime();
    const providers = readConfig(modelsFile(), { providers: {} }).providers || {};
    const defaults = rt.getModels().find((model) => model.provider === providerId);
    if (!Object.hasOwn(providers, providerId) && !defaults) throw new Error('模型来源不存在');
    const config = providers[providerId] || {};
    return { providerId, baseUrl: config.baseUrl || defaults?.baseUrl || '', api: config.api || defaults?.api || 'openai-completions', icon: config.icon || '' };
  });
  ipcMain.handle('pi:mcp-config', async (_event, name) => {
    const config = readConfig(path.join(pi.getAgentDir(), 'mcp.json'), { mcpServers: {} });
    if (!Object.hasOwn(config.mcpServers || {}, name)) throw new Error('MCP 不存在');
    const server = config.mcpServers[name];
    return { name, transport: server.command ? 'stdio' : 'http', command: server.command || '', args: server.args || [], url: server.url || '', description: server.description || '', env: Object.entries(server.env || {}).map(([key, value]) => `${key}=${value}`).join('\n') };
  });
  ipcMain.handle('pi:add-provider', async (_event, input) => {
    const rt = await runtime();
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (apiKey.startsWith('$') && !envNameOf(apiKey)) throw new Error('环境变量格式应为 $NAME 或 ${NAME}');
    const auth = readConfig(authFile(), {});
    const models = updateProvider(readConfig(modelsFile(), { providers: {} }), input, input.editing ? rt.getProviders().map((provider) => provider.id) : Object.keys(auth));
    writeConfig(modelsFile(), models);
    if (apiKey) writeConfig(authFile(), { ...auth, [input.providerId.trim()]: { type: 'api_key', key: apiKey } }, 0o600);
    runtimePromise = undefined;
    agentSessions.clear();
    return { settings: await settingsSnapshot(DEFAULT_CWD), models: await availableModels() };
  });
  ipcMain.handle('pi:add-mcp', async (_event, input) => {
    const file = path.join(pi.getAgentDir(), 'mcp.json');
    writeConfig(file, updateMcp(readConfig(file, { mcpServers: {} }), input));
    return settingsSnapshot(DEFAULT_CWD);
  });
  ipcMain.handle('pi:provider-models', async (_event, providerId) => {
    const rt = await runtime();
    const settings = readJson(path.join(pi.getAgentDir(), 'settings.json'), {});
    const enabled = new Set(Array.isArray(settings.enabledModels) ? settings.enabledModels : []);
    return {
      models: rt.getModels().filter((model) => model.provider === providerId).map((model) => ({
        id: `${model.provider}/${model.id}`,
        model: model.id,
        name: model.name,
        enabled: enabled.has(`${model.provider}/${model.id}`),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsImages: Array.isArray(model.input) && model.input.includes('image'),
      })),
    };
  });
  ipcMain.handle('pi:set-enabled-models', async (_event, models) => {
    if (!Array.isArray(models)) throw new Error('模型列表无效');
    const settingsPath = path.join(pi.getAgentDir(), 'settings.json');
    const settings = readJson(settingsPath, {});
    settings.enabledModels = models.filter((item) => typeof item === 'string');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return settingsSnapshot(DEFAULT_CWD);
  });
  ipcMain.handle('pi:add-custom-model', async (_event, input) => {
    const rt = await runtime();
    const config = readConfig(modelsFile(), { providers: {} });
    writeConfig(modelsFile(), updateCustomModel(config, input, rt.getProviders().map((provider) => provider.id)));
    runtimePromise = undefined;
    agentSessions.clear();
    return settingsSnapshot(DEFAULT_CWD);
  });
  ipcMain.handle('pi:add-package', async (_event, source) => {
    if (typeof source !== 'string' || !source.trim()) throw new Error('请输入包来源');
    const manager = new pi.DefaultPackageManager({
      cwd: DEFAULT_CWD,
      agentDir: pi.getAgentDir(),
      settingsManager: pi.SettingsManager.create(DEFAULT_CWD, pi.getAgentDir()),
    });
    await manager.installAndPersist(source.trim());
    return settingsSnapshot(DEFAULT_CWD);
  });
  ipcMain.handle('pi:remove-package', async (_event, source) => {
    if (typeof source !== 'string') throw new Error('来源无效');
    const manager = new pi.DefaultPackageManager({
      cwd: DEFAULT_CWD,
      agentDir: pi.getAgentDir(),
      settingsManager: pi.SettingsManager.create(DEFAULT_CWD, pi.getAgentDir()),
    });
    await manager.removeAndPersist(source);
    return settingsSnapshot(DEFAULT_CWD);
  });
  ipcMain.handle('pi:set-mcp-enabled', async (_event, { name, enabled }) => {
    if (typeof name !== 'string' || typeof enabled !== 'boolean') throw new Error('参数无效');
    const config = readMcp();
    if (!config.mcpServers[name]) throw new Error('MCP 不存在');
    config.mcpServers[name].enabled = enabled;
    fs.writeFileSync(path.join(pi.getAgentDir(), 'mcp.json'), JSON.stringify(config, null, 2));
    return settingsSnapshot();
  });
  ipcMain.handle('pi:set-model', async (_event, modelRef, cwd) => {
    if (typeof modelRef !== 'string' || !modelRef.includes('/')) throw new Error('模型格式无效');
    const [provider, ...parts] = modelRef.split('/');
    if (!(await runtime()).getModel(provider, parts.join('/'))) throw new Error('模型已不存在，请刷新后重试');
    saveConfig(modelRef);
    MODEL_REF = modelRef;
    agentSessions.clear();
    return modelInfo(cwd || DEFAULT_CWD);
  });
  ipcMain.handle('pi:set-thinking-level', async (_event, { modelRef, level, cwd }) => {
    if (modelRef !== MODEL_REF) throw new Error('当前模型已改变，请重新选择推理等级');
    const [provider, ...parts] = MODEL_REF.split('/');
    const model = (await runtime()).getModel(provider, parts.join('/'));
    if (!model) throw new Error('当前模型不存在');
    modelOptions.validateThinkingLevel(model, level);
    const preferences = { ...thinkingPreferences, [MODEL_REF]: level };
    saveConfig(MODEL_REF, preferences);
    thinkingPreferences = preferences;
    return modelInfo(cwd || DEFAULT_CWD);
  });
  makeMenu();
  createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

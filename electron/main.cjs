const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let pi;
async function loadPi() {
  pi = await import('@earendil-works/pi-coding-agent');
}
const DEV = process.env.PI_STUDIO_DEV === '1';
const SESSION_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');
const DEFAULT_CWD = process.env.PI_WORKSPACE ?? process.cwd();
const MODEL_REF = process.env.PI_MODEL_REF ?? 'minimax-cn/MiniMax-M3.1-Flash';

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

async function modelInfo() {
  const rt = await runtime();
  const [provider, ...parts] = MODEL_REF.split('/');
  const found = provider && parts.length > 0 ? rt.getModel(provider, parts.join('/')) : undefined;
  const selected = found || rt.getModels()[0];
  return { modelRef: found ? MODEL_REF : `${selected?.provider}/${selected?.id}`, label: selected?.name || MODEL_REF };
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

async function detail(id) {
  const found = await findManager(id);
  if (!found) return undefined;
  const messages = found.manager.getEntries()
    .filter((entry) => entry.type === 'message')
    .map((entry) => entry.message)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, text: textOf(message.content) }))
    .filter((message) => message.text.length > 0);
  return { id, cwd: found.cwd, title: diskSessions.get(id)?.title || '新会话', messages };
}

async function ensureAgent(id, manager, cwd) {
  if (agentSessions.has(id)) return agentSessions.get(id);
  const rt = await runtime();
  const [provider, ...parts] = MODEL_REF.split('/');
  const model = provider && parts.length > 0 ? rt.getModel(provider, parts.join('/')) : undefined;
  if (!model) throw new Error(`Pi 模型 ${MODEL_REF} 不在本机目录中`);
  const { session } = await pi.createAgentSession({
    cwd,
    model,
    thinkingLevel: 'medium',
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (DEV) void win.loadURL('http://127.0.0.1:5180');
  else void win.loadFile(path.join(__dirname, '..', 'web-dist', 'index.html'));
}

app.whenReady().then(async () => {
  await loadPi();
  ipcMain.handle('pi:state', async () => ({ workspaces: await listWorkspaces(), model: await modelInfo(), cwd: DEFAULT_CWD }));
  ipcMain.handle('pi:session-create', async (_event, cwd) => {
    const manager = pi.SessionManager.create(cwd || DEFAULT_CWD);
    const id = manager.getSessionId();
    drafts.set(id, { manager, cwd: cwd || DEFAULT_CWD });
    return { id, cwd: cwd || DEFAULT_CWD, title: '新会话', messages: [] };
  });
  ipcMain.handle('pi:session', async (_event, id) => detail(id));
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
  ipcMain.handle('pi:prompt', async (event, { sessionId, text, requestId }) => {
    const found = await findManager(sessionId);
    if (!found) throw new Error('会话不存在');
    const session = await ensureAgent(sessionId, found.manager, found.cwd);
    let collected = '';
    const send = (payload) => event.sender.send('pi:prompt-event', { requestId, ...payload });
    const unsubscribe = session.subscribe((piEvent) => {
      if (piEvent.type === 'message_update' && piEvent.assistantMessageEvent.type === 'text_delta') {
        collected += piEvent.assistantMessageEvent.delta;
        send({ type: 'delta', text: piEvent.assistantMessageEvent.delta });
      }
      if (piEvent.type === 'tool_execution_start') send({ type: 'tool', name: piEvent.toolName, status: 'running' });
      if (piEvent.type === 'tool_execution_end') send({ type: 'tool', name: piEvent.toolName, status: 'done' });
    });
    try {
      await session.prompt(text);
      send({ type: 'done', text: collected });
      drafts.delete(sessionId);
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      unsubscribe();
    }
  });
  createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

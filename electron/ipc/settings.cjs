/**
 * IPC：Pi 资源管理（MCP / 技能 / 扩展 / 包）。
 *
 * 这些操作会直接改动 ~/.pi/agent 下的文件或目录，所以每个删除入口都做了
 * 「路径必须位于允许的根目录内」的校验，避免误删用户其它文件。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dialog, ipcMain } = require('electron');
const {
  DEFAULT_CWD,
  piModule,
  agentDir,
  mcpFile,
  readConfig,
  writeConfig,
} = require('../core/state.cjs');
const { updateMcp } = require('../settings-config.cjs');
const { settingsSnapshot } = require('../services/settings.cjs');
const {
  agentToolCatalog,
  invalidateAgentToolCatalog,
  saveInstalledToolSelection,
} = require('../services/agent-tools.cjs');
const {
  saveSubagentSettings,
  subagentSettings,
} = require('../services/subagent-settings.cjs');

function registerSettingsIpc() {
  // 设置页全量快照
  ipcMain.handle('pi:settings', async (_event, cwd) => settingsSnapshot(typeof cwd === 'string' ? cwd : DEFAULT_CWD));

  // 当前工作区实际可加载的工具目录（只创建内存会话，不发送 prompt）
  ipcMain.handle('pi:agent-tool-catalog', async (_event, { cwd, refresh } = {}) => (
    agentToolCatalog(typeof cwd === 'string' ? cwd : DEFAULT_CWD, Boolean(refresh))
  ));

  // 持久化 Agent 工具白名单；来源快照随配置一起保留，扩展暂时卸载后可解释失效项。
  ipcMain.handle('pi:set-agent-tools', async (_event, { tools, cwd } = {}) => {
    saveInstalledToolSelection(tools);
    return settingsSnapshot(typeof cwd === 'string' ? cwd : DEFAULT_CWD);
  });

  // pi-subagents 的模型与 thinking 配置直接同步到 Pi 自己的 settings.json。
  ipcMain.handle('pi:subagent-settings', async (_event, cwd) => (
    subagentSettings(typeof cwd === 'string' ? cwd : DEFAULT_CWD)
  ));

  ipcMain.handle('pi:save-subagent-settings', async (_event, { cwd, scope, settings } = {}) => (
    saveSubagentSettings(
      typeof cwd === 'string' ? cwd : DEFAULT_CWD,
      scope,
      settings,
    )
  ));

  // 单个 MCP 的编辑数据
  ipcMain.handle('pi:mcp-config', async (_event, name) => {
    const config = readConfig(mcpFile(), { mcpServers: {} });
    if (!Object.hasOwn(config.mcpServers || {}, name)) throw new Error('MCP 不存在');
    const server = config.mcpServers[name];
    return {
      name,
      transport: server.command ? 'stdio' : 'http',
      command: server.command || '',
      args: server.args || [],
      url: server.url || '',
      description: server.description || '',
      env: Object.entries(server.env || {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    };
  });

  // 新增 / 编辑 MCP 服务器
  ipcMain.handle('pi:add-mcp', async (_event, input) => {
    writeConfig(mcpFile(), updateMcp(readConfig(mcpFile(), { mcpServers: {} }), input));
    return settingsSnapshot(DEFAULT_CWD);
  });

  // 删除 MCP 服务器
  ipcMain.handle('pi:remove-mcp', async (_event, name) => {
    const config = readConfig(mcpFile(), { mcpServers: {} });
    if (!Object.hasOwn(config.mcpServers || {}, name)) throw new Error('MCP 不存在');
    delete config.mcpServers[name];
    writeConfig(mcpFile(), config);
    return settingsSnapshot(DEFAULT_CWD);
  });

  // 启停 MCP 服务器
  ipcMain.handle('pi:set-mcp-enabled', async (_event, { name, enabled }) => {
    if (typeof name !== 'string' || typeof enabled !== 'boolean') throw new Error('参数无效');
    const config = readConfig(mcpFile(), { mcpServers: {} });
    if (!config.mcpServers[name]) throw new Error('MCP 不存在');
    config.mcpServers[name].enabled = enabled;
    fs.writeFileSync(mcpFile(), JSON.stringify(config, null, 2));
    return settingsSnapshot();
  });

  // 导入技能目录（目录里必须有 SKILL.md）
  ipcMain.handle('pi:add-skill', async (_event, { scope, cwd }) => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return undefined;
    const source = result.filePaths[0];
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error('所选目录缺少 SKILL.md');

    const base = scope === 'project' ? path.join(cwd || DEFAULT_CWD, '.pi', 'skills') : path.join(agentDir(), 'skills');
    const target = path.join(base, path.basename(source));
    if (fs.existsSync(target)) throw new Error('同名技能已存在');
    fs.mkdirSync(base, { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    return settingsSnapshot(cwd || DEFAULT_CWD);
  });

  // 删除技能：只允许删 SKILL.md 所在的技能目录
  ipcMain.handle('pi:remove-skill', async (_event, skillPath) => {
    const target = path.resolve(String(skillPath || ''));
    const roots = [path.join(agentDir(), 'skills'), path.join(os.homedir(), '.agents'), path.join(DEFAULT_CWD, '.pi', 'skills')];
    if (path.basename(target) !== 'SKILL.md') throw new Error('技能路径无效');
    const parent = path.dirname(target);
    const allowed =
      roots.some((root) => parent === root || parent.startsWith(root + path.sep)) ||
      parent.includes(`${path.sep}.pi${path.sep}skills${path.sep}`);
    if (!allowed) throw new Error('不能删除这个位置的技能');
    if (!fs.existsSync(parent)) throw new Error('技能不存在');
    fs.rmSync(parent, { recursive: true, force: true });
    return settingsSnapshot(DEFAULT_CWD);
  });

  // 导入扩展（目录需含 index.ts/index.js，或直接选单文件）
  ipcMain.handle('pi:add-extension', async (_event, { scope, cwd }) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'openFile'],
      filters: [{ name: 'Pi Extension', extensions: ['ts', 'js', 'mjs'] }],
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    const source = result.filePaths[0];
    const stat = fs.statSync(source);

    const base = scope === 'project' ? path.join(cwd || DEFAULT_CWD, '.pi', 'extensions') : path.join(agentDir(), 'extensions');
    const target = path.join(base, path.basename(source));
    if (fs.existsSync(target)) throw new Error('同名扩展已存在');
    fs.mkdirSync(base, { recursive: true });
    if (stat.isDirectory()) {
      if (!['index.ts', 'index.js'].some((name) => fs.existsSync(path.join(source, name)))) {
        throw new Error('扩展目录缺少 index.ts 或 index.js');
      }
      fs.cpSync(source, target, { recursive: true });
    } else {
      fs.copyFileSync(source, path.join(base, path.basename(source)));
    }
    invalidateAgentToolCatalog();
    return settingsSnapshot(cwd || DEFAULT_CWD);
  });

  // 删除扩展：路径必须位于扩展根目录内
  ipcMain.handle('pi:remove-extension', async (_event, extensionPath) => {
    const target = path.resolve(String(extensionPath || ''));
    const roots = [path.join(agentDir(), 'extensions'), path.join(DEFAULT_CWD, '.pi', 'extensions')];
    const allowed =
      roots.some((root) => target === root || target.startsWith(root + path.sep)) ||
      target.includes(`${path.sep}.pi${path.sep}extensions${path.sep}`);
    if (!allowed) throw new Error('不能删除这个位置的扩展');
    if (!fs.existsSync(target)) throw new Error('扩展不存在');
    fs.rmSync(target, { recursive: true, force: true });
    invalidateAgentToolCatalog();
    return settingsSnapshot(DEFAULT_CWD);
  });

  // 通过 Pi 的包管理器安装扩展包（npm / git 源）
  ipcMain.handle('pi:add-package', async (_event, source) => {
    if (typeof source !== 'string' || !source.trim()) throw new Error('请输入包来源');
    const pi = piModule();
    const manager = new pi.DefaultPackageManager({
      cwd: DEFAULT_CWD,
      agentDir: pi.getAgentDir(),
      settingsManager: pi.SettingsManager.create(DEFAULT_CWD, pi.getAgentDir()),
    });
    await manager.installAndPersist(source.trim());
    invalidateAgentToolCatalog();
    return settingsSnapshot(DEFAULT_CWD);
  });

  // 卸载扩展包
  ipcMain.handle('pi:remove-package', async (_event, source) => {
    if (typeof source !== 'string') throw new Error('来源无效');
    const pi = piModule();
    const manager = new pi.DefaultPackageManager({
      cwd: DEFAULT_CWD,
      agentDir: pi.getAgentDir(),
      settingsManager: pi.SettingsManager.create(DEFAULT_CWD, pi.getAgentDir()),
    });
    await manager.removeAndPersist(source);
    invalidateAgentToolCatalog();
    return settingsSnapshot(DEFAULT_CWD);
  });
}

module.exports = { registerSettingsIpc };

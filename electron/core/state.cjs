/**
 * 主进程共享状态。
 *
 * 整个主进程里「可变」的东西集中在这里，避免各模块互相引用形成环：
 *  - pi / modelOptions   异步加载的 Pi SDK 与模型选项工具
 *  - mainWindow          当前窗口（重建窗口时更新）
 *  - modelRef            当前选中的模型，形如 `provider/model`
 *  - thinkingPreferences 各模型的推理强度偏好（持久化在 config.json）
 *  - runtimePromise      ModelRuntime 单例，配置变更后置空重建
 *  - agentSessions       正在运行的 AgentSession 缓存
 *
 * 以及所有「路径 + 读写 JSON」的公共辅助函数。
 */

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readConfig, writeConfig } = require('../settings-config.cjs');
const { loadCredentialEnvironment, normalizeAuth } = require('../credential-env.cjs');

// 开发模式下渲染进程连 Vite dev server，而不是打包后的 web-dist
const DEV = process.env.PI_STUDIO_DEV === '1';
// Pi 的会话目录，所有 .jsonl 会话文件都在这里
const SESSION_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');
// 默认工作区，可用 PI_WORKSPACE 覆盖（测试与 CLI 启动时有用）
const DEFAULT_CWD = process.env.PI_WORKSPACE ?? process.cwd();

let pi;
let modelOptions;
let mainWindow;
let modelRef = process.env.PI_MODEL_REF ?? 'minimax-cn/MiniMax-M3.1-Flash';
let thinkingPreferences = {};
let runtimePromise;

/** 运行中的会话缓存：sessionId → AgentSession。 */
const agentSessions = new Map();

/**
 * 加载 Pi SDK。
 * 必须在 app.whenReady 之后调用：Pi 内部会读用户目录下的配置。
 */
async function loadPi() {
  pi = await import('@earendil-works/pi-coding-agent');
  modelOptions = await import('../model-options.mjs');
}

/** Pi SDK 模块（loadPi 之前调用会拿到 undefined）。 */
function piModule() {
  return pi;
}

/** model-options.mjs 模块（loadPi 之前调用会拿到 undefined）。 */
function modelOptionsModule() {
  return modelOptions;
}

/** 当前主窗口。 */
function getWindow() {
  return mainWindow;
}

/** 记录主窗口，窗口重建时由 window.cjs 调用。 */
function setWindow(win) {
  mainWindow = win;
}

/** 当前选中的模型引用。 */
function getModelRef() {
  return modelRef;
}

function setModelRef(next) {
  modelRef = next;
}

/** 推理强度偏好表。 */
function getThinkingPreferences() {
  return thinkingPreferences;
}

function setThinkingPreferences(next) {
  thinkingPreferences = next;
}

/**
 * 让模型运行时失效：下次 getRuntime() 会重新读取配置并重建。
 * 切换 API Key、增删提供方 / 模型后必须调用，同时清空运行中的会话。
 */
function invalidateModelRuntime() {
  runtimePromise = undefined;
  agentSessions.clear();
}

/**
 * Pi 运行时单例。
 *
 * 初始化时做三件事：
 *  1. 读取 auth.json 与 models.json 中配置的密钥 / 环境变量名；
 *  2. 从用户 shell 环境补齐这些变量（GUI 启动时拿不到 shell 里的变量）；
 *  3. 把旧格式的 auth.json 规范化后写回磁盘。
 */
async function getRuntime() {
  runtimePromise ??= createRuntime();
  return runtimePromise;
}

/** 真正创建 ModelRuntime 的实现。 */
async function createRuntime() {
  const dir = agentDir();
  const credentialsFile = path.join(dir, 'auth.json');
  const auth = readConfig(credentialsFile, {});
  const configured = readConfig(path.join(dir, 'models.json'), { providers: {} });
  await loadCredentialEnvironment([
    ...Object.values(auth).filter((value) => value?.type === 'api_key').map((value) => value.key),
    ...Object.values(configured.providers || {}).map((value) => value.apiKey),
  ]);
  // 等待环境变量期间用户可能刚保存了新密钥，这里重新读一次
  const latest = readConfig(credentialsFile, {});
  const normalized = normalizeAuth(latest);
  if (JSON.stringify(latest) !== JSON.stringify(normalized)) writeConfig(credentialsFile, normalized, 0o600);
  return pi.ModelRuntime.create({
    authPath: path.join(dir, 'auth.json'),
    modelsPath: path.join(dir, 'models.json'),
    allowModelNetwork: true,
    refreshOnCreate: true,
  });
}

/** Pi 的 agent 目录（默认 ~/.pi/agent）。loadPi 之后才能调用。 */
function agentDir() {
  return pi.getAgentDir();
}

function authFile() {
  return path.join(agentDir(), 'auth.json');
}

function modelsFile() {
  return path.join(agentDir(), 'models.json');
}

function mcpFile() {
  return path.join(agentDir(), 'mcp.json');
}

function settingsFile() {
  return path.join(agentDir(), 'settings.json');
}

/** 读 JSON，失败时返回 fallback（用于配置文件可缺失的场景）。 */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 读取 auth.json；不存在或损坏时返回空对象。 */
function readAuth() {
  return readJson(authFile(), {});
}

/** 读取 mcp.json，保证返回 `{ mcpServers }` 结构。 */
function readMcp() {
  const parsed = readJson(mcpFile(), { mcpServers: {} });
  return parsed && typeof parsed.mcpServers === 'object' ? parsed : { mcpServers: {} };
}

/** 应用自身的配置（模型选择、推理偏好、主题、侧边栏元数据）。 */
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

/** 启动时把持久化的模型与推理偏好读进内存。 */
function loadConfig() {
  const value = readJson(configPath(), {});
  if (typeof value.modelRef === 'string' && value.modelRef.includes('/')) modelRef = value.modelRef;
  if (value.thinkingLevels && typeof value.thinkingLevels === 'object' && !Array.isArray(value.thinkingLevels)) {
    thinkingPreferences = value.thinkingLevels;
  }
}

/**
 * 保存模型与推理偏好。
 * 注意：不动 config.json 里的其它字段（主题、侧边栏元数据由各自模块维护）。
 */
function saveConfig(nextModelRef = modelRef, levels = thinkingPreferences) {
  writeConfig(configPath(), { ...readJson(configPath(), {}), modelRef: nextModelRef, thinkingLevels: levels });
}

module.exports = {
  DEV,
  SESSION_ROOT,
  DEFAULT_CWD,
  loadPi,
  piModule,
  modelOptionsModule,
  getWindow,
  setWindow,
  getModelRef,
  setModelRef,
  getThinkingPreferences,
  setThinkingPreferences,
  invalidateModelRuntime,
  getRuntime,
  agentDir,
  authFile,
  modelsFile,
  mcpFile,
  settingsFile,
  readJson,
  readAuth,
  readMcp,
  readConfig,
  writeConfig,
  configPath,
  loadConfig,
  saveConfig,
  agentSessions,
};

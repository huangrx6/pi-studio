'use strict';

/**
 * Skill source adapters and installation service.
 *
 * Sources are declarative catalogs. Discovery never executes skill content.
 * Installation always snapshots the source into quarantine first, validates
 * Agent Skills metadata and the complete file graph, then atomically switches
 * the destination directory.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanupCommittedSkillDirectory, retryCommittedSkillCleanup } = require('./cleanup.cjs');
const {
  DEFAULT_ARCHIVE_LIMITS,
  extractZipArchive,
  sha256,
} = require('../../core/extension-archive.cjs');
const { normalizeSecureHttpUrl } = require('../../core/external-url.cjs');
const { systemFetch } = require('../../core/http-fetch.cjs');
const { githubRepository, createGithubSourceAdapter } = require('./github-source.cjs');
const { createLinkedSourceAdapter } = require('./linked-source.cjs');
const {
  getStudioDatabase,
} = require('../../core/studio-db.cjs');
const { userDataDirectory } = require('../../core/studio-paths.cjs');
const {
  directoryDetails,
  inspectSingleSkillDirectory,
  inspectSkillDirectory,
  projectSkillsDirectory,
  sharedUserSkillsDirectory,
  userSkillsDirectory,
} = require('./instructions.cjs');

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PREPARED_TTL_MS = 30 * 60_000;
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;
const MAX_REGISTRY_SKILLS = 20_000;
const MAX_REDIRECTS = 4;
const ARCHIVE_LIMITS = {
  ...DEFAULT_ARCHIVE_LIMITS,
  maxArchiveBytes: 20 * 1024 * 1024,
  maxExtractedBytes: 40 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxEntries: 1_000,
};

const catalogsBySource = new Map();
const refreshes = new Map();
const prepared = new Map();

const isRemote = (location) => /^https?:\/\//i.test(location);
const github = createGithubSourceAdapter(async (url, label, maximum) => {
  // Repository archives can take longer than a small JSON registry to transfer.
  const { response } = await fetchHttps(url, label, 60_000);
  if (response.status === 403 || response.status === 429) {
    await response.body?.cancel();
    throw new Error('GitHub 请求受限，请稍后重试');
  }
  if (response.status === 404) {
    await response.body?.cancel();
    throw new Error('找不到 GitHub 仓库；请确认地址正确且仓库公开可访问');
  }
  return readLimitedResponse(response, label, maximum);
});

const linked = createLinkedSourceAdapter({
  readUrl: async (url, label, maximum) => {
    const { response } = await fetchHttps(url, label, 30_000);
    return readLimitedResponse(response, label, maximum);
  },
  readJson: async (url, label) => {
    const { response } = await fetchHttps(url, label, 15_000);
    const bytes = await readLimitedResponse(response, label, 2 * 1024 * 1024);
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error(`${label}不是有效 JSON`);
    }
  },
});

function invalidateCatalog(id) {
  catalogsBySource.delete(id);
  refreshes.delete(id);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function quarantineRoot() {
  return path.join(userDataDirectory(), 'skill-quarantine');
}

function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') return os.homedir();
  if (text.startsWith(`~${path.sep}`)) return path.join(os.homedir(), text.slice(2));
  return text;
}

function sourceId(type, location) {
  return `skill-source-${sha256(Buffer.from(`${type}\0${location}`)).slice(0, 16)}`;
}

function normalizeLocation(type, rawLocation) {
  const value = String(rawLocation || '').trim();
  if (!value) throw new Error('请填写技能源地址');
  if (type === 'github') {
    const repository = githubRepository(value);
    if (!repository) throw new Error('请填写 GitHub 仓库首页地址，例如 https://github.com/anthropics/skills');
    return repository.location;
  }
  if (type === 'directory') {
    const directory = path.resolve(expandHome(value));
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error('技能源目录不存在');
    }
    return directory;
  }
  if (type === 'registry') {
    if (/^https:\/\//i.test(value) || /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) {
      return normalizeSecureHttpUrl(value, { label: '技能 registry 地址' });
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      throw new Error('registry 必须是 HTTPS 地址或本地 JSON 文件');
    }
    return path.resolve(expandHome(value));
  }
  throw new Error('技能源类型无效');
}

function listSkillSources() {
  return getStudioDatabase().listSkillSources();
}

function sourceDefinition(input = {}) {
  // A pasted repository URL takes precedence over the selected form type.
  const type = githubRepository(input.location) ? 'github' : input.type;
  if (!['directory', 'registry', 'github'].includes(type)) throw new Error('请选择有效的技能源类型');
  const location = normalizeLocation(type, input.location);
  if (type === 'registry' && !isRemote(location) && !fs.existsSync(location)) {
    throw new Error('registry JSON 文件不存在');
  }
  const duplicate = listSkillSources().find((source) => (
    (githubRepository(source.location)
      ? type === 'github' && githubRepository(source.location).location === location
      : source.type === type && source.location === location)
    && source.id !== input.id
  ));
  if (duplicate) throw new Error(`这个技能源已经添加为「${duplicate.name}」`);
  const fallbackName = type === 'github' ? new URL(location).pathname.slice(1) : type === 'directory'
    ? path.basename(location)
    : isRemote(location)
      ? path.basename(new URL(location).pathname || 'registry.json')
      : path.basename(location, path.extname(location));
  const name = String(input.name || fallbackName || '技能源').trim().slice(0, 120);
  const id = input.id || sourceId(type, location);
  return {
    id,
    name,
    type,
    location,
    enabled: input.enabled !== false,
  };
}

function saveSkillSource(input = {}) {
  const definition = sourceDefinition(input);
  invalidateCatalog(definition.id);
  return getStudioDatabase().upsertSkillSource(definition);
}

async function readSource(source) {
  // Also recognizes repository URLs saved by older versions as registry sources.
  if (githubRepository(source.location)) return github.read(source);
  return source.type === 'directory'
    ? directoryEntries(source)
    : readRegistry(source);
}

async function addSkillSource(input = {}) {
  const definition = sourceDefinition(input);
  const result = await readSource(definition);
  // Validate before persistence. Recheck duplicates after I/O, so simultaneous
  // submissions cannot overwrite one another or leave a failed source behind.
  const source = saveSkillSource(input);
  catalogsBySource.set(source.id, result);
  return getStudioDatabase().setSkillSourceStatus(source.id, {
    lastSyncedAt: Date.now(), itemCount: result.entries.length, lastError: '',
  });
}

function setSkillSourceEnabled(id, enabled) {
  invalidateCatalog(id);
  return getStudioDatabase().setSkillSourceEnabled(id, enabled === true);
}

function removeSkillSource(id) {
  getStudioDatabase().removeSkillSource(id);
  invalidateCatalog(id);
}

async function readLimitedResponse(response, label, maximum = MAX_REGISTRY_BYTES) {
  if (!response.ok) {
    await response.body?.cancel?.();
    throw new Error(`${label}请求失败（HTTP ${response.status}）`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel?.();
    throw new Error(`${label}超过 ${maximum} 字节`);
  }
  // Electron 的 net.fetch 返回 Web Stream，没有异步迭代器，用 reader 逐块读。
  const reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : null;
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maximum) throw new Error(`${label}超过 ${maximum} 字节`);
    return buffer;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new Error(`${label}超过 ${maximum} 字节`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function fetchHttps(url, label, timeoutMs = 15_000) {
  let current = normalizeSecureHttpUrl(url, { label });
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await systemFetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json, application/zip, application/octet-stream' },
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next) throw new Error(`${label}重定向缺少 Location`);
      current = normalizeSecureHttpUrl(new URL(next, current).toString(), { label });
      continue;
    }
    return { response, url: current };
  }
  throw new Error(`${label}重定向次数过多`);
}

async function readRegistry(source) {
  let bytes;
  let registryLocation = source.location;
  if (isRemote(source.location)) {
    const { response, url } = await fetchHttps(source.location, '技能 registry ');
    registryLocation = url;
    bytes = await readLimitedResponse(response, '技能 registry ');
  } else {
    const stat = fs.statSync(source.location);
    if (!stat.isFile()) throw new Error('registry 源不是文件');
    if (stat.size > MAX_REGISTRY_BYTES) throw new Error(`技能 registry 超过 ${MAX_REGISTRY_BYTES} 字节`);
    bytes = fs.readFileSync(source.location);
  }
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('技能 registry 不是有效 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('技能 registry 根节点必须是对象');
  }
  // schemaVersion 1 是带 sha256 的压缩包清单；没有版本号或 2 是只有地址的链接清单。
  if (data.schemaVersion === 1) return { entries: parseArchiveRegistry(data, registryLocation), diagnostics: [] };
  if (data.schemaVersion === 2 || data.schemaVersion === undefined) return parseLinkedRegistry(data);
  throw new Error(`技能 registry 仅支持 schemaVersion 1 或 2，当前为 ${String(data.schemaVersion)}`);
}

/** schemaVersion 1：每个技能自带压缩包地址与 sha256，安装前必须校验。 */
function parseArchiveRegistry(data, registryLocation) {
  if (!Array.isArray(data.skills)) throw new Error('技能 registry 缺少 skills 数组');
  if (data.skills.length > MAX_REGISTRY_SKILLS) {
    throw new Error(`技能 registry 最多包含 ${MAX_REGISTRY_SKILLS} 个技能`);
  }
  const seen = new Set();
  return data.skills.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`skills[${index}] 必须是对象`);
    }
    const name = String(entry.name || '').trim();
    if (!SKILL_NAME.test(name)) throw new Error(`skills[${index}].name 无效`);
    if (seen.has(name)) throw new Error(`技能 registry 包含重复名称：${name}`);
    seen.add(name);
    const description = String(entry.description || '').trim();
    if (!description) throw new Error(`技能 ${name} 缺少 description`);
    const version = String(entry.version || '').trim();
    if (!version) throw new Error(`技能 ${name} 缺少 version`);
    const expectedSha256 = String(entry.sha256 || '').trim().toLowerCase();
    if (!SHA256.test(expectedSha256)) throw new Error(`技能 ${name} 的 sha256 无效`);
    const rawDownload = String(entry.download || '').trim();
    if (!rawDownload) throw new Error(`技能 ${name} 缺少 download`);
    const download = isRemote(registryLocation) || /^[a-z][a-z0-9+.-]*:/i.test(rawDownload)
      ? normalizeSecureHttpUrl(new URL(rawDownload, isRemote(registryLocation) ? registryLocation : undefined).toString(), {
          label: `技能 ${name} 下载地址`,
        })
      : path.resolve(path.dirname(registryLocation), rawDownload);
    return {
      id: `registry:${name}`,
      name,
      description: description.slice(0, 4_000),
      version,
      invocation: entry.invocation === 'explicit' ? 'explicit' : 'automatic',
      repository: typeof entry.repository === 'string' ? entry.repository.slice(0, 2_000) : '',
      homepage: typeof entry.homepage === 'string' ? entry.homepage.slice(0, 2_000) : '',
      download,
      expectedSha256,
      declaredResources: Number.isFinite(entry.resourceCount) ? Math.max(0, Number(entry.resourceCount)) : undefined,
      promptTokens: Math.max(1, Math.ceil(Buffer.byteLength(
        `<skill><name>${name}</name><description>${description}</description><location>registry:${name}</location></skill>`,
        'utf8',
      ) / 4)),
    };
  });
}

/**
 * 链接清单：条目只有名称、说明和地址（例如 openclaw 那类索引站导出的 JSON）。
 * 这类清单动辄几千条且由第三方生成，所以单条无效只记一条诊断，不让整份清单失败。
 */
function parseLinkedRegistry(data) {
  if (!Array.isArray(data.skills)) throw new Error('技能 registry 缺少 skills 数组');
  if (data.skills.length > MAX_REGISTRY_SKILLS) {
    throw new Error(`技能 registry 最多包含 ${MAX_REGISTRY_SKILLS} 个技能`);
  }
  const entries = [];
  const diagnostics = [];
  const seen = new Set();
  data.skills.forEach((entry, index) => {
    const name = entry && typeof entry === 'object' ? String(entry.name || '').trim() : '';
    const skip = (message) => diagnostics.push({ path: `skills[${index}]${name ? `（${name}）` : ''}`, message });
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return skip('条目必须是对象');
    if (!SKILL_NAME.test(name)) return skip('名称无效，只能是小写字母、数字和连字符');
    if (seen.has(name)) return skip('名称重复，已跳过');
    const description = String(entry.description || entry.description_zh || '').trim();
    if (!description) return skip('缺少 description');
    const rawLink = String(entry.url || entry.homepage || '').trim();
    if (!rawLink) return skip('缺少 url');
    let link;
    try {
      link = normalizeSecureHttpUrl(rawLink, { label: `技能 ${name} 的地址` });
    } catch (error) {
      return skip(errorMessage(error));
    }
    seen.add(name);
    entries.push({
      id: `registry:${name}`,
      name,
      description: description.slice(0, 4_000),
      version: String(entry.version || '').trim().slice(0, 40),
      invocation: entry.invocation === 'explicit' ? 'explicit' : 'automatic',
      repository: typeof entry.repository === 'string' ? entry.repository.slice(0, 2_000) : '',
      homepage: link,
      // 链接型条目没有压缩包和 sha256，安装时按 link 取回内容。
      link,
      promptTokens: Math.max(1, Math.ceil(Buffer.byteLength(
        `<skill><name>${name}</name><description>${description}</description><location>registry:${name}</location></skill>`,
        'utf8',
      ) / 4)),
    });
    return undefined;
  });
  return { entries, diagnostics };
}

function directoryEntries(source) {
  const inspected = inspectSkillDirectory(source.location);
  return {
    entries: inspected.candidates.map((skill) => ({
      id: `directory:${skill.name}`,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      invocation: skill.disableModelInvocation ? 'explicit' : 'automatic',
      sourcePath: skill.baseDir,
      contentHash: directoryDetails(skill.baseDir).contentHash,
      resourceCount: skill.resourceCount,
      totalBytes: skill.totalBytes,
      promptTokens: skill.promptTokens,
    })),
    diagnostics: inspected.diagnostics,
  };
}

function catalogSnapshot() {
  const db = getStudioDatabase();
  const sources = db.listSkillSources();
  const installations = db.listSkillInstallations();
  const catalogs = sources.map((source) => {
    const cached = source.enabled ? catalogsBySource.get(source.id) : undefined;
    const items = (cached?.entries || []).map((item) => {
      const owned = installations.find((row) => row.sourceId === source.id && row.listingId === item.id);
      const installation = owned || installations.find((row) => row.name === item.name);
      return {
        id: `${source.id}:${item.id}`,
        listingId: item.id,
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
        name: item.name,
        description: item.description,
        version: item.version,
        invocation: item.invocation,
        repository: item.repository || '',
        homepage: item.homepage || '',
        resourceCount: item.resourceCount,
        totalBytes: item.totalBytes,
        promptTokens: item.promptTokens,
        installed: Boolean(installation),
        installedVersion: installation?.version,
        installedPath: installation?.path,
        updateAvailable: Boolean(owned && owned.version !== item.version),
      };
    });
    return { source, items, diagnostics: cached?.diagnostics || [], skipped: !source.enabled };
  });
  return { refreshedAt: Date.now(), sources, catalogs };
}

async function refreshSkillCatalog() {
  const db = getStudioDatabase();
  await Promise.all(db.listSkillSources().map(async (source) => {
    invalidateCatalog(source.id);
    if (!source.enabled) return;
    const generation = Symbol(source.id);
    refreshes.set(source.id, generation);
    const current = () => refreshes.get(source.id) === generation;
    try {
      const result = await readSource(source);
      // Editing/removing a source or starting a newer refresh invalidates this
      // request. Its delayed response must not repopulate the old catalog.
      if (!current()) return;
      db.setSkillSourceStatus(source.id, {
        lastSyncedAt: Date.now(), itemCount: result.entries.length, lastError: '',
      });
      catalogsBySource.set(source.id, result);
    } catch (error) {
      if (!current()) return;
      const message = errorMessage(error);
      db.setSkillSourceStatus(source.id, { lastError: message, itemCount: 0 });
      catalogsBySource.set(source.id, {
        entries: [], diagnostics: [{ path: source.location, message }],
      });
    }
  }));
  return catalogSnapshot();
}

function walkFiles(root) {
  const files = [];
  let bytes = 0;
  function visit(directory, depth) {
    if (depth > 16) throw new Error('技能目录超过 16 层');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        const real = fs.realpathSync(full);
        if (!path.relative(fs.realpathSync(root), real).startsWith('..')) {
          throw new Error(`暂不支持在技能包中使用符号链接：${path.relative(root, full)}`);
        }
        throw new Error(`技能包含指向外部的符号链接：${path.relative(root, full)}`);
      }
      if (stat.isDirectory()) visit(full, depth + 1);
      else if (stat.isFile()) {
        if (stat.size > ARCHIVE_LIMITS.maxFileBytes) throw new Error('技能单个文件大小超限');
        bytes += stat.size;
        files.push({
          path: path.relative(root, full).split(path.sep).join('/'),
          size: stat.size,
        });
        if (files.length > ARCHIVE_LIMITS.maxEntries) throw new Error('技能文件数量过多');
        if (bytes > ARCHIVE_LIMITS.maxExtractedBytes) throw new Error('技能目录总大小超限');
      }
    }
  }
  visit(root, 0);
  return { files, bytes };
}

function prepareToken() {
  return crypto.randomUUID();
}

function createPrepared(token, source, item, scope, cwd, contentRoot, details) {
  const value = {
    token,
    source,
    item,
    scope,
    cwd: scope === 'project' ? path.resolve(cwd) : '',
    contentRoot,
    expiresAt: Date.now() + PREPARED_TTL_MS,
    ...details,
  };
  prepared.set(token, value);
  return value;
}

function cleanupPrepared(token, removeDirectory = true) {
  const value = prepared.get(token);
  if (!value) return;
  prepared.delete(token);
  if (removeDirectory) fs.rmSync(path.dirname(value.contentRoot), { recursive: true, force: true });
}

async function downloadArchive(item) {
  let archive;
  if (isRemote(item.download)) {
    const { response } = await fetchHttps(item.download, `技能 ${item.name} 下载`);
    archive = await readLimitedResponse(response, '技能包', ARCHIVE_LIMITS.maxArchiveBytes);
  } else {
    const stat = fs.statSync(item.download);
    if (!stat.isFile()) throw new Error('技能包不是文件');
    if (stat.size > ARCHIVE_LIMITS.maxArchiveBytes) throw new Error('技能包过大');
    archive = fs.readFileSync(item.download);
  }
  const digest = sha256(archive);
  if (digest !== item.expectedSha256) {
    throw new Error(`技能包完整性校验失败：期望 ${item.expectedSha256}，实际 ${digest}`);
  }
  return archive;
}

/** 技能安装范围：Studio 应用目录、Agent 共享目录（~/.agents/skills）、项目目录。 */
const INSTALL_SCOPES = ['user', 'shared', 'project'];

function installRoot(scope, cwd) {
  if (scope === 'project') return projectSkillsDirectory(cwd);
  return scope === 'shared' ? sharedUserSkillsDirectory() : userSkillsDirectory();
}

async function prepareSkillInstall({ sourceId: requestedSourceId, listingId, scope, cwd } = {}) {
  if (!INSTALL_SCOPES.includes(scope)) throw new Error('技能安装范围无效');
  if (scope === 'project' && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) {
    throw new Error('项目技能需要选择工作区，且路径必须为绝对路径');
  }
  const source = getStudioDatabase().listSkillSources()
    .find((item) => item.id === requestedSourceId);
  if (!source) throw new Error('技能源不存在');
  if (!source.enabled) throw new Error('技能源已停用');
  const item = catalogsBySource.get(source.id)?.entries.find((entry) => entry.id === listingId);
  if (!item) throw new Error('技能目录已变化，请刷新技能源后重试');
  fs.mkdirSync(quarantineRoot(), { recursive: true, mode: 0o700 });
  const token = prepareToken();
  const staging = path.join(quarantineRoot(), token);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const contentRoot = path.join(staging, 'content');
  try {
    if (githubRepository(source.location)) {
      await github.stage(source, item, contentRoot, walkFiles);
    } else if (item.link) {
      await linked.stage(item, contentRoot);
    } else if (source.type === 'directory') {
      walkFiles(item.sourcePath);
      fs.cpSync(item.sourcePath, contentRoot, {
        recursive: true,
        errorOnExist: true,
        dereference: false,
        filter: (file) => !['.git', 'node_modules'].includes(path.basename(file)),
      });
    } else {
      const archive = await downloadArchive(item);
      extractZipArchive(archive, contentRoot, {
        limits: ARCHIVE_LIMITS,
        wrapperFile: 'SKILL.md',
      });
    }
    const skill = inspectSingleSkillDirectory(contentRoot);
    if (skill.name !== item.name) throw new Error(`技能包声明名称为 ${item.name}，SKILL.md 实际为 ${skill.name}`);
    if (source.type === 'directory' && directoryDetails(contentRoot).contentHash !== item.contentHash) {
      throw new Error('技能目录内容已变化，请刷新技能源后重试');
    }
    const walked = walkFiles(contentRoot);
    const value = createPrepared(token, source, item, scope, cwd, contentRoot, {
      token,
      skill: {
        name: skill.name,
        description: skill.description,
        version: item.version || skill.version || '0.0.0',
        invocation: item.invocation,
        resourceCount: Math.max(0, walked.files.length - 1),
        totalBytes: walked.bytes,
        promptTokens: item.promptTokens,
      },
      files: walked.files.slice(0, ARCHIVE_LIMITS.maxEntries),
      sha256: directoryDetails(contentRoot).contentHash,
    });
    const target = path.join(installRoot(scope, cwd), skill.name);
    const owned = getStudioDatabase().getSkillInstallation(target);
    return {
      token,
      sourceId: source.id,
      listingId: item.id,
      sourceName: source.name,
      sourceType: source.type,
      scope,
      requiresTrust: scope === 'project',
      canUpdate: Boolean(owned && owned.sourceId === source.id && owned.listingId === item.id),
      installedVersion: owned?.version || '',
      ...value.skill,
      files: value.files,
      sha256: value.sha256,
    };
  } catch (error) {
    prepared.delete(token);
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function installPreparedSkill({ token, cwd } = {}) {
  const pending = prepared.get(token);
  if (!pending || pending.expiresAt < Date.now()) {
    cleanupPrepared(token);
    throw new Error('技能安装预览已过期，请重新预览');
  }
  if (pending.scope === 'project' && cwd !== undefined && path.resolve(cwd) !== pending.cwd) {
    throw new Error('安装工作区与预览不一致，请重新预览');
  }
  const source = listSkillSources().find((item) => item.id === pending.source.id);
  if (!source?.enabled || source.type !== pending.source.type || source.location !== pending.source.location) {
    throw new Error('技能源已变化或停用，请重新预览');
  }
  const root = installRoot(pending.scope, pending.cwd);
  const target = path.join(root, pending.skill.name);
  const db = getStudioDatabase();
  const existing = db.listSkillInstallations().find((installation) => (
    path.resolve(installation.path) === path.resolve(target)
  ));
  if (
    existing
    && (
      existing.sourceId !== pending.source.id
      || existing.listingId !== pending.item.id
    )
  ) {
    throw new Error(`目标目录已由另一个技能源管理：${existing.name}`);
  }
  if (fs.existsSync(target) && !existing) {
    throw new Error(`同名技能目录已存在：${target}。请先确认它不是由技能源安装的。`);
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = path.join(root, `.${pending.skill.name}.${crypto.randomUUID()}.tmp`);
  const backup = path.join(root, `.${pending.skill.name}.${crypto.randomUUID()}.backup`);
  try {
    fs.cpSync(pending.contentRoot, temporary, {
      recursive: true,
      errorOnExist: true,
      dereference: false,
    });
    const copiedFingerprint = directoryDetails(temporary).contentHash;
    if (copiedFingerprint !== pending.sha256) throw new Error('技能安装暂存内容校验失败');
    let movedExisting = false;
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      movedExisting = true;
    }
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (movedExisting && !fs.existsSync(target) && fs.existsSync(backup)) {
        fs.renameSync(backup, target);
      }
      throw error;
    }
    let installation;
    try {
      installation = db.transaction(() => db.upsertSkillInstallation({
        path: target,
        sourceId: pending.source.id,
        listingId: pending.item.id,
        name: pending.skill.name,
        version: pending.skill.version,
        sha256: pending.sha256,
      }));
    } catch (error) {
      fs.rmSync(target, { recursive: true, force: true });
      if (movedExisting && fs.existsSync(backup)) fs.renameSync(backup, target);
      throw error;
    }
    // Installation and its SQLite receipt have committed. Consume the token
    // before best-effort housekeeping so cleanup cannot cause a duplicate install.
    prepared.delete(token);
    if (movedExisting) cleanupCommittedSkillDirectory(backup);
    cleanupCommittedSkillDirectory(path.dirname(pending.contentRoot));
    return {
      name: pending.skill.name,
      version: pending.skill.version,
      scope: pending.scope,
      path: path.join(target, 'SKILL.md'),
      baseDir: target,
      installation,
    };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function disposePreparedSkill(token) {
  cleanupPrepared(token);
  return { ok: true };
}

async function skillHubSnapshot({ refresh = false } = {}) {
  if (refresh || listSkillSources().some((source) => source.enabled && !catalogsBySource.has(source.id))) {
    return refreshSkillCatalog();
  }
  return catalogSnapshot();
}

function pruneSkillPrepared() {
  retryCommittedSkillCleanup();
  const now = Date.now();
  for (const [token, value] of prepared) {
    if (value.expiresAt < now) cleanupPrepared(token);
  }
  const root = quarantineRoot();
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || prepared.has(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      if (now - fs.statSync(directory).mtimeMs > PREPARED_TTL_MS) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    } catch {
      // A concurrent install may have just moved or removed the quarantine.
    }
  }
}

module.exports = {
  addSkillSource,
  disposePreparedSkill,
  installPreparedSkill,
  listSkillSources,
  prepareSkillInstall,
  pruneSkillPrepared,
  refreshSkillCatalog,
  removeSkillSource,
  saveSkillSource,
  setSkillSourceEnabled,
  skillHubSnapshot,
  __test: {
    normalizeLocation,
    readRegistry,
    readLimitedResponse,
    sourceId,
  },
};

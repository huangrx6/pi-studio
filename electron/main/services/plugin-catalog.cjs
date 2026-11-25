'use strict';

/**
 * Plugin marketplace catalog (D4).
 *
 * Sources:
 * - official: bundled assets/official-plugins (or process.resourcesPath)
 * - registry: user-added HTTPS or local JSON (settings)
 *
 * Install resolution returns a filesystem path for preparePluginInstall.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { studioDataDirectory } = require('../core/studio-paths.cjs');
const { normalizeSecureHttpUrl } = require('../core/external-url.cjs');
const { systemFetch } = require('../core/http-fetch.cjs');
const { pluginError } = require('../core/plugin-package.cjs');
const { readPluginIcon } = require('./plugin-icon.cjs');

const SOURCES_KEY = 'studio.pluginSources';
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_PLUGINS = 5_000;
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{1,127}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

const OFFICIAL_SOURCE = Object.freeze({
  id: 'official',
  name: '官方精选',
  type: 'official',
  location: 'official',
  enabled: true,
  builtin: true,
});

function catalogError(code, message, details = {}) {
  return pluginError(code, message, details);
}

function isRemote(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function officialPluginsRoot() {
  if (typeof process.env.PI_STUDIO_OFFICIAL_PLUGINS === 'string'
    && process.env.PI_STUDIO_OFFICIAL_PLUGINS.trim()) {
    return path.resolve(process.env.PI_STUDIO_OFFICIAL_PLUGINS.trim());
  }
  if (app?.isPackaged && typeof process.resourcesPath === 'string') {
    return path.join(process.resourcesPath, 'official-plugins');
  }
  const appRoot = typeof app?.getAppPath === 'function'
    ? app.getAppPath()
    : process.cwd();
  const bundled = path.join(appRoot, 'assets', 'official-plugins');
  if (fs.existsSync(path.join(bundled, 'registry.json'))) return bundled;
  // Dev fallback when running from package root without Electron app path.
  const repo = path.join(process.cwd(), 'assets', 'official-plugins');
  return repo;
}

function expandHome(value) {
  return path.resolve(String(value).replace(/^~(?=$|[/\\])/, os.homedir()));
}

function normalizeSources(raw) {
  const list = Array.isArray(raw?.sources) ? raw.sources : [];
  const sources = [];
  const seen = new Set(['official']);
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || RESERVED.has(id) || seen.has(id) || id === 'official') continue;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) continue;
    const type = item.type === 'directory' ? 'directory' : 'registry';
    const location = typeof item.location === 'string' ? item.location.trim() : '';
    if (!location) continue;
    const name = typeof item.name === 'string' && item.name.trim()
      ? item.name.trim().slice(0, 120)
      : id;
    sources.push({
      id,
      name,
      type,
      location,
      enabled: item.enabled !== false,
      builtin: false,
    });
    seen.add(id);
  }
  return { schemaVersion: 1, sources };
}

function readSourcesSetting() {
  try {
    return normalizeSources(getStudioDatabase().getSetting(SOURCES_KEY, { sources: [] }));
  } catch {
    return { schemaVersion: 1, sources: [] };
  }
}

function writeSourcesSetting(next) {
  const normalized = normalizeSources(next);
  getStudioDatabase().setSetting(SOURCES_KEY, normalized);
  return normalized;
}

function listPluginSources() {
  return [OFFICIAL_SOURCE, ...readSourcesSetting().sources];
}

function addPluginSource(input = {}) {
  const type = input.type === 'directory' ? 'directory' : 'registry';
  let location = typeof input.location === 'string' ? input.location.trim() : '';
  if (!location) throw catalogError('INVALID_SOURCE', '请填写源地址');
  if (type === 'registry') {
    if (isRemote(location)) {
      location = normalizeSecureHttpUrl(location, { label: '插件 registry 地址' });
    } else {
      location = expandHome(location);
      if (!fs.existsSync(location) || !fs.statSync(location).isFile()) {
        throw catalogError('SOURCE_NOT_FOUND', 'registry JSON 文件不存在');
      }
    }
  } else {
    location = expandHome(location);
    if (!fs.existsSync(location) || !fs.statSync(location).isDirectory()) {
      throw catalogError('SOURCE_NOT_FOUND', '插件目录不存在');
    }
  }
  const name = typeof input.name === 'string' && input.name.trim()
    ? input.name.trim().slice(0, 120)
    : (type === 'directory' ? path.basename(location) : '插件源');
  const idBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'source';
  let id = idBase;
  const existing = new Set(listPluginSources().map((item) => item.id));
  let n = 1;
  while (existing.has(id)) {
    id = `${idBase}-${n}`;
    n += 1;
  }
  const store = readSourcesSetting();
  store.sources.push({
    id,
    name,
    type,
    location,
    enabled: true,
    builtin: false,
  });
  writeSourcesSetting(store);
  return listPluginSources().find((item) => item.id === id);
}

function setPluginSourceEnabled(id, enabled) {
  if (id === 'official') throw catalogError('BUILTIN_SOURCE', '官方源不可停用');
  const store = readSourcesSetting();
  const source = store.sources.find((item) => item.id === id);
  if (!source) throw catalogError('SOURCE_NOT_FOUND', `插件源不存在：${id}`);
  source.enabled = enabled === true;
  writeSourcesSetting(store);
  return listPluginSources().find((item) => item.id === id);
}

function removePluginSource(id) {
  if (id === 'official') throw catalogError('BUILTIN_SOURCE', '官方源不可删除');
  const store = readSourcesSetting();
  const next = store.sources.filter((item) => item.id !== id);
  if (next.length === store.sources.length) {
    throw catalogError('SOURCE_NOT_FOUND', `插件源不存在：${id}`);
  }
  writeSourcesSetting({ sources: next });
  return { ok: true, id };
}

async function fetchHttps(url, label, timeoutMs = 20_000) {
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
      if (!next) throw catalogError('HTTP_REDIRECT', `${label}重定向缺少 Location`);
      current = normalizeSecureHttpUrl(new URL(next, current).toString(), { label });
      continue;
    }
    return { response, url: current };
  }
  throw catalogError('HTTP_REDIRECT', `${label}重定向次数过多`);
}

async function readLimitedResponse(response, label, maximum = MAX_REGISTRY_BYTES) {
  if (!response.ok) {
    throw catalogError('HTTP_ERROR', `${label}失败（HTTP ${response.status}）`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body || []) {
    total += chunk.length;
    if (total > maximum) {
      await response.body?.cancel();
      throw catalogError('PAYLOAD_TOO_LARGE', `${label}超过 ${maximum} 字节`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function countProvides(value) {
  if (Array.isArray(value)) return value.length;
  if (Number.isFinite(value)) return Math.max(0, Number(value));
  return 0;
}

function normalizeProvides(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    mcp: countProvides(source.mcp),
    skills: countProvides(source.skills),
    cli: countProvides(source.cli),
    extension: Boolean(source.extension),
    mcpNames: Array.isArray(source.mcp) ? source.mcp.map(String) : [],
    skillNames: Array.isArray(source.skills) ? source.skills.map(String) : [],
    cliNames: Array.isArray(source.cli) ? source.cli.map(String) : [],
  };
}

function pickLatestVersion(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  return versions[versions.length - 1];
}

function parseRegistry(data, registryLocation, source) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw catalogError('INVALID_REGISTRY', '插件 registry 根节点必须是对象');
  }
  if (data.schemaVersion !== 1 && data.schemaVersion !== undefined) {
    throw catalogError('INVALID_REGISTRY', `不支持的 registry schemaVersion：${data.schemaVersion}`);
  }
  if (!Array.isArray(data.plugins)) {
    throw catalogError('INVALID_REGISTRY', 'registry.plugins 必须是数组');
  }
  if (data.plugins.length > MAX_PLUGINS) {
    throw catalogError('INVALID_REGISTRY', `registry 最多 ${MAX_PLUGINS} 个插件`);
  }
  const baseDir = isRemote(registryLocation)
    ? ''
    : path.dirname(path.resolve(registryLocation));
  const seen = new Set();
  const plugins = [];
  const diagnostics = [];
  data.plugins.forEach((entry, index) => {
    try {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('条目必须是对象');
      }
      const id = String(entry.id || '').trim();
      if (!PLUGIN_ID.test(id)) throw new Error('id 无效');
      if (seen.has(id)) throw new Error(`id 重复：${id}`);
      seen.add(id);
      const name = String(entry.name || '').trim();
      if (!name) throw new Error('缺少 name');
      const publisher = String(entry.publisher || '').trim();
      if (!publisher) throw new Error('缺少 publisher');
      if (!Array.isArray(entry.versions) || entry.versions.length === 0) {
        throw new Error('缺少 versions');
      }
      const versions = entry.versions.map((version, vIndex) => {
        if (!version || typeof version !== 'object') throw new Error(`versions[${vIndex}] 无效`);
        const ver = String(version.version || '').trim();
        if (!ver) throw new Error(`versions[${vIndex}] 缺少 version`);
        const packagePath = typeof version.packagePath === 'string'
          ? version.packagePath.replace(/\\/g, '/').replace(/^\.\//, '').trim()
          : '';
        const download = typeof version.download === 'string' ? version.download.trim() : '';
        if (!packagePath && !download) {
          throw new Error(`versions[${vIndex}] 需要 packagePath 或 download`);
        }
        if (packagePath && (packagePath.startsWith('/') || packagePath.includes('..'))) {
          throw new Error(`versions[${vIndex}].packagePath 非法`);
        }
        const sha256 = typeof version.sha256 === 'string' ? version.sha256.trim().toLowerCase() : '';
        if (download && sha256 && !SHA256.test(sha256)) {
          throw new Error(`versions[${vIndex}].sha256 无效`);
        }
        let resolvedDownload = '';
        if (download) {
          if (isRemote(registryLocation) || /^[a-z][a-z0-9+.-]*:/i.test(download)) {
            resolvedDownload = normalizeSecureHttpUrl(
              new URL(download, isRemote(registryLocation) ? registryLocation : undefined).toString(),
              { label: `插件 ${id} 下载地址` },
            );
          } else if (baseDir) {
            resolvedDownload = path.resolve(baseDir, download);
          } else {
            resolvedDownload = download;
          }
        }
        let resolvedPackage = '';
        if (packagePath && baseDir) {
          resolvedPackage = path.resolve(baseDir, packagePath);
          if (!resolvedPackage.startsWith(baseDir + path.sep) && resolvedPackage !== baseDir) {
            throw new Error(`versions[${vIndex}].packagePath 越界`);
          }
        }
        return {
          version: ver,
          packagePath: packagePath || '',
          resolvedPackagePath: resolvedPackage,
          download: resolvedDownload,
          sha256: sha256 || '',
          size: Number.isFinite(version.size) ? Number(version.size) : 0,
          publishedAt: typeof version.publishedAt === 'string' ? version.publishedAt : '',
        };
      });
      const latest = pickLatestVersion(versions);
      const icon = String(entry.icon || '').trim().slice(0, 2_000);
      plugins.push({
        id,
        name,
        publisher,
        summary: String(entry.summary || entry.description || '').trim().slice(0, 280),
        description: String(entry.description || entry.summary || '').trim().slice(0, 4_000),
        category: String(entry.category || '').trim().slice(0, 64) || 'general',
        icon,
        iconDataUrl: baseDir && latest?.resolvedPackagePath
          ? readPluginIcon(latest.resolvedPackagePath, icon, baseDir) : '',
        homepage: String(entry.homepage || '').trim().slice(0, 2_000),
        repository: String(entry.repository || '').trim().slice(0, 2_000),
        keywords: Array.isArray(entry.keywords)
          ? entry.keywords.map((item) => String(item).trim()).filter(Boolean).slice(0, 32)
          : [],
        provides: normalizeProvides(entry.provides),
        versions,
        latestVersion: latest?.version || '',
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
      });
    } catch (error) {
      diagnostics.push({
        path: `plugins[${index}]`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return {
    name: typeof data.name === 'string' ? data.name : source.name,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    plugins,
    diagnostics,
  };
}

function readLocalRegistryFile(filePath) {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw catalogError('INVALID_REGISTRY', 'registry 源不是文件');
  if (stat.size > MAX_REGISTRY_BYTES) {
    throw catalogError('PAYLOAD_TOO_LARGE', `插件 registry 超过 ${MAX_REGISTRY_BYTES} 字节`);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    throw catalogError('INVALID_REGISTRY', '插件 registry 不是有效 JSON');
  }
  return { data, location: resolved };
}

async function loadRegistryForSource(source) {
  if (source.type === 'official') {
    const root = officialPluginsRoot();
    const file = path.join(root, 'registry.json');
    if (!fs.existsSync(file)) {
      return {
        name: source.name,
        updatedAt: '',
        plugins: [],
        diagnostics: [{ path: file, message: '官方插件目录不可用' }],
        location: file,
      };
    }
    const { data, location } = readLocalRegistryFile(file);
    return { ...parseRegistry(data, location, source), location };
  }
  if (source.type === 'directory') {
    const root = expandHome(source.location);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw catalogError('SOURCE_NOT_FOUND', `插件目录不存在：${root}`);
    }
    const plugins = [];
    const diagnostics = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      const manifestPath = path.join(dir, 'pi-studio.plugin.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const id = String(manifest.id || '').trim();
        if (!PLUGIN_ID.test(id)) throw new Error('manifest.id 无效');
        const provides = {
          mcp: Array.isArray(manifest.provides?.mcp) ? manifest.provides.mcp.map((item) => item.name || item).filter(Boolean) : [],
          skills: Array.isArray(manifest.provides?.skills) ? manifest.provides.skills.map((item) => item.path || item.name || item).filter(Boolean) : [],
          cli: Array.isArray(manifest.provides?.cli) ? manifest.provides.cli.map((item) => item.id || item.name || item).filter(Boolean) : [],
          extension: Boolean(manifest.provides?.extension),
        };
        plugins.push({
          id,
          name: String(manifest.name || id),
          publisher: String(manifest.publisher || ''),
          summary: String(manifest.description || '').slice(0, 280),
          description: String(manifest.description || ''),
          category: String(manifest.category || 'general'),
          icon: String(manifest.icon || ''),
          iconDataUrl: readPluginIcon(dir, String(manifest.icon || ''), root),
          homepage: String(manifest.homepage || ''),
          repository: '',
          keywords: [],
          provides: normalizeProvides(provides),
          versions: [{
            version: String(manifest.version || '0.0.0'),
            packagePath: entry.name,
            resolvedPackagePath: dir,
            download: '',
            sha256: '',
            size: 0,
            publishedAt: '',
          }],
          latestVersion: String(manifest.version || '0.0.0'),
          sourceId: source.id,
          sourceName: source.name,
          sourceType: source.type,
        });
      } catch (error) {
        diagnostics.push({
          path: dir,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      name: source.name,
      updatedAt: '',
      plugins,
      diagnostics,
      location: root,
    };
  }

  // registry type
  let location = source.location;
  let data;
  if (isRemote(location)) {
    const { response, url } = await fetchHttps(location, '插件 registry ');
    location = url;
    const bytes = await readLimitedResponse(response, '插件 registry ');
    try {
      data = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw catalogError('INVALID_REGISTRY', '插件 registry 不是有效 JSON');
    }
  } else {
    ({ data, location } = readLocalRegistryFile(expandHome(location)));
  }
  return { ...parseRegistry(data, location, source), location };
}

function installedMap() {
  try {
    const map = new Map();
    for (const plugin of getStudioDatabase().listPlugins()) {
      map.set(plugin.id, plugin);
    }
    return map;
  } catch {
    return new Map();
  }
}

function decorateWithInstallState(plugin, installed) {
  const current = installed.get(plugin.id);
  return {
    ...plugin,
    installed: Boolean(current),
    installedVersion: current?.version || null,
    installedEnabled: current ? current.enabled : null,
    updateAvailable: Boolean(
      current
      && plugin.latestVersion
      && current.version !== plugin.latestVersion,
    ),
  };
}

function matchesQuery(plugin, query) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    plugin.id,
    plugin.name,
    plugin.publisher,
    plugin.summary,
    plugin.description,
    plugin.category,
    ...(plugin.keywords || []),
    ...(plugin.provides?.mcpNames || []),
    ...(plugin.provides?.skillNames || []),
    ...(plugin.provides?.cliNames || []),
  ].join('\n').toLowerCase();
  return hay.includes(q);
}

async function pluginMarketSnapshot(options = {}) {
  const query = typeof options.query === 'string' ? options.query : '';
  const category = typeof options.category === 'string' ? options.category.trim() : '';
  const sourceId = typeof options.sourceId === 'string' ? options.sourceId.trim() : '';
  const sources = listPluginSources().filter((source) => (
    source.enabled && (!sourceId || source.id === sourceId)
  ));
  const installed = installedMap();
  const catalogs = [];
  const plugins = [];
  const errors = [];

  for (const source of listPluginSources()) {
    if (!source.enabled && sourceId !== source.id) {
      catalogs.push({
        source,
        count: 0,
        error: source.enabled ? '' : '已停用',
        plugins: [],
      });
      continue;
    }
    if (sourceId && source.id !== sourceId) continue;
    if (!source.enabled) continue;
    try {
      const loaded = await loadRegistryForSource(source);
      const items = loaded.plugins
        .map((plugin) => decorateWithInstallState(plugin, installed))
        .filter((plugin) => matchesQuery(plugin, query))
        .filter((plugin) => !category || plugin.category === category);
      catalogs.push({
        source,
        count: items.length,
        name: loaded.name,
        updatedAt: loaded.updatedAt,
        diagnostics: loaded.diagnostics,
        error: '',
        plugins: items,
      });
      plugins.push(...items);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      catalogs.push({
        source,
        count: 0,
        error: message,
        plugins: [],
      });
      errors.push({ sourceId: source.id, message });
    }
  }

  // De-dupe by plugin id (official wins first).
  const byId = new Map();
  for (const plugin of plugins) {
    if (!byId.has(plugin.id)) byId.set(plugin.id, plugin);
  }
  const unique = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const categories = [...new Set(unique.map((item) => item.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));

  return {
    sources: listPluginSources(),
    catalogs,
    plugins: unique,
    categories,
    errors,
    query,
    category,
    sourceId: sourceId || '',
    updatedAt: Date.now(),
  };
}

async function getMarketPlugin(id, options = {}) {
  const snapshot = await pluginMarketSnapshot(options);
  const plugin = snapshot.plugins.find((item) => item.id === id);
  if (!plugin) throw catalogError('NOT_FOUND', `市场中没有插件：${id}`);
  return plugin;
}

async function resolveMarketInstallSource(pluginId, options = {}) {
  const requestedVersion = typeof options.version === 'string' ? options.version.trim() : '';
  const sourceId = typeof options.sourceId === 'string' ? options.sourceId.trim() : '';
  const snapshot = await pluginMarketSnapshot({ sourceId });
  const plugin = snapshot.plugins.find((item) => item.id === pluginId);
  if (!plugin) throw catalogError('NOT_FOUND', `市场中没有插件：${pluginId}`);
  const version = requestedVersion
    ? plugin.versions.find((item) => item.version === requestedVersion)
    : pickLatestVersion(plugin.versions);
  if (!version) throw catalogError('VERSION_NOT_FOUND', `没有版本：${pluginId}@${requestedVersion || 'latest'}`);

  if (version.resolvedPackagePath) {
    if (!fs.existsSync(version.resolvedPackagePath)) {
      throw catalogError('PACKAGE_MISSING', `本地插件包不存在：${version.resolvedPackagePath}`);
    }
    return {
      source: version.resolvedPackagePath,
      kind: 'local-directory',
      pluginId: plugin.id,
      version: version.version,
      expectedSha256: version.sha256 || '',
    };
  }

  if (version.download && !isRemote(version.download) && fs.existsSync(version.download)) {
    return {
      source: version.download,
      kind: 'local-archive',
      pluginId: plugin.id,
      version: version.version,
      expectedSha256: version.sha256 || '',
    };
  }

  if (version.download && isRemote(version.download)) {
    const { response } = await fetchHttps(version.download, `插件 ${plugin.id} 下载`, 60_000);
    const bytes = await readLimitedResponse(response, '插件包', MAX_ARCHIVE_BYTES);
    if (version.sha256) {
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (hash !== version.sha256) {
        throw catalogError('INTEGRITY_MISMATCH', `插件包校验失败：期望 ${version.sha256}，实际 ${hash}`);
      }
    }
    const tempDir = path.join(studioDataDirectory(), 'plugin-quarantine', `dl-${crypto.randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const archivePath = path.join(tempDir, `${plugin.id}-${version.version}.zip`);
    fs.writeFileSync(archivePath, bytes, { mode: 0o600 });
    return {
      source: archivePath,
      kind: 'downloaded-archive',
      pluginId: plugin.id,
      version: version.version,
      expectedSha256: version.sha256 || '',
      cleanup: tempDir,
    };
  }

  throw catalogError('UNRESOLVABLE', `无法解析插件安装来源：${plugin.id}@${version.version}`);
}

module.exports = {
  SOURCES_KEY,
  OFFICIAL_SOURCE,
  officialPluginsRoot,
  listPluginSources,
  addPluginSource,
  setPluginSourceEnabled,
  removePluginSource,
  pluginMarketSnapshot,
  getMarketPlugin,
  resolveMarketInstallSource,
  parseRegistry,
  __test: {
    normalizeSources,
    normalizeProvides,
    matchesQuery,
  },
};

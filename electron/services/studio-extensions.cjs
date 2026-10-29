/**
 * Studio extension host.
 *
 * Agent extensions are trusted Node modules loaded into the Pi Durable
 * registry. UI extensions are declarative manifest data projected as JSON-safe
 * slots. The renderer never receives executable extension objects.
 *
 * Manifest: pi-studio.extension.json
 * User:     <userData>/extensions/<manifest-id>/
 * Project:  <workspace>/.pi-studio/extensions/<manifest-id>/
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const {
  normalizeManifest: normalizeCoreManifest,
} = require('../core/extension-manifest.cjs');
const {
  validateExtensionDirectory,
} = require('../core/extension-package.cjs');
const {
  normalizeContent: normalizeUiContent,
  normalizeContentList: normalizeUiContentList,
} = require('./studio-extension-ui.cjs');
const {
  createExtensionDistributionService,
} = require('./extension-distribution.cjs');
const {
  closeAllExtensionDataViewServices,
} = require('./extension-data-view.cjs');
const {
  createOfficialExtensionService,
} = require('./official-extensions.cjs');
const { normalizeExternalHttpUrl } = require('../core/external-url.cjs');

const MANIFEST_NAME = 'pi-studio.extension.json';
const API_VERSION = 1;
const MAX_EXTENSIONS = 128;
const COMMAND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTRIBUTION_PATTERN = /^(?:builtin|user|project):[a-z0-9][a-z0-9._-]{1,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const TIERS = new Set(['core', 'system', 'optional', 'user', 'project']);
const SETTINGS_PAGES = new Set([
  'general',
  'tools',
  'harness',
  'subagents',
  'permissions',
  'models',
  'usage',
  'archives',
  'mcp',
  'skills',
  'extensions',
  'about',
]);
const SCOPE_RANK = new Map([['builtin', 0], ['user', 1], ['project', 2]]);
const TIER_RANK = new Map([
  ['core', 0],
  ['system', 1],
  ['optional', 2],
  ['user', 3],
  ['project', 4],
]);
const PROTECTED_BUILTIN_TIERS = new Set(['core', 'optional']);
const EXTENSION_CLEANUP_TIMEOUT_MS = 2_000;

let host;
let distribution;
let officialCatalog;
let extensionRuntimeQueue = Promise.resolve();

function officialExtensionsRoot() {
  if (typeof process.env.PI_STUDIO_OFFICIAL_EXTENSIONS === 'string'
    && process.env.PI_STUDIO_OFFICIAL_EXTENSIONS) {
    return path.resolve(process.env.PI_STUDIO_OFFICIAL_EXTENSIONS);
  }
  if (app?.isPackaged && typeof process.resourcesPath === 'string') {
    return path.join(process.resourcesPath, 'official-extensions');
  }
  const appRoot = typeof app?.getAppPath === 'function'
    ? app.getAppPath()
    : process.cwd();
  return path.join(appRoot, 'extensions');
}

function extensionDistributionService() {
  if (!distribution) {
    distribution = createExtensionDistributionService({
      userDataPath: app.getPath('userData'),
      appVersion: typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0',
      officialRoot: officialExtensionsRoot(),
      normalizeManifest,
      dependencyResolver: (id) => Boolean(getStudioDatabase().getExtension(id)),
      allowInsecureLocalhost: true,
    });
  }
  return distribution;
}

function officialExtensionService() {
  if (!officialCatalog) {
    officialCatalog = createOfficialExtensionService({
      root: officialExtensionsRoot(),
      distribution: extensionDistributionService(),
      database: getStudioDatabase(),
      normalizeManifest,
    });
  }
  return officialCatalog;
}

function officialExtensionsSnapshot() {
  return officialExtensionService().snapshot();
}

async function autoUpdateOfficialExtensions() {
  return officialExtensionService().autoUpdate();
}

function setOfficialExtensionAutoUpdate(id, enabled) {
  return officialExtensionService().setAutoUpdate(id, enabled);
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}超时（${milliseconds}ms）`)),
      milliseconds,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function onceAsync(action) {
  let promise;
  return () => {
    if (!promise) promise = Promise.resolve().then(action);
    return promise;
  };
}

function serializeExtensionRuntime(operation) {
  const next = extensionRuntimeQueue.then(operation, operation);
  extensionRuntimeQueue = next.catch(() => {});
  return next;
}

function userExtensionsDirectory() {
  return path.join(app.getPath('userData'), 'extensions');
}

function projectExtensionsDirectory(cwd) {
  return path.join(path.resolve(cwd), '.pi-studio', 'extensions');
}

async function purgeProjectWorkspaceState(cwd, runtime) {
  const workspace = path.resolve(cwd);
  getStudioDatabase().removeProjectExtensionsForWorkspace(workspace);
  extensionDistributionService().purgeProjectWorkspace(workspace);
  if (runtime) await reloadStudioExtensions(runtime, '');
  else await closeAllExtensionDataViewServices();
}

function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function optionalText(value, maxLength, pattern) {
  const clean = text(value, maxLength);
  return clean && (!pattern || pattern.test(clean)) ? clean : undefined;
}

function hasPermission(permissions, permission) {
  return permissions.includes(permission);
}

function stableExtensionId(scope, manifestId) {
  return `${scope}:${manifestId}`;
}

function contributionId(rowOrManifest, scope, contributionId) {
  const manifestId = rowOrManifest?.manifest?.id || rowOrManifest?.id;
  const resolvedScope = rowOrManifest?.scope || scope;
  return `${resolvedScope}:${manifestId}/${contributionId}`;
}

function contributionReference(value, owner) {
  const clean = text(value, 220);
  if (CONTRIBUTION_PATTERN.test(clean)) return clean;
  if (clean && COMMAND_PATTERN.test(clean) && owner?.scope && owner?.manifestId) {
    return `${owner.scope}:${owner.manifestId}/${clean}`;
  }
  return undefined;
}

function normalizeUiAction(raw, owner) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const kind = text(raw.kind, 32);
  if (kind === 'openSettings') {
    if (raw.panel === undefined) return { kind };
    const panel = text(raw.panel, 32);
    if (!SETTINGS_PAGES.has(panel)) {
      throw new Error(`openSettings.panel 无效：${panel || '(empty)'}`);
    }
    return { kind, panel };
  }
  if (kind === 'openPanel') {
    const panelId = contributionReference(raw.panelId, owner);
    return panelId ? { kind, panelId } : undefined;
  }
  if (kind === 'sendPrompt') {
    const prompt = text(raw.text, 100_000);
    return prompt ? { kind, text: prompt, submit: raw.submit === true } : undefined;
  }
  if (kind === 'copyText') {
    const value = text(raw.text, 100_000);
    return value ? { kind, text: value } : undefined;
  }
  if (kind === 'openUrl') {
    return {
      kind,
      url: normalizeExternalHttpUrl(raw.url),
    };
  }
  if (kind === 'runCommand') {
    const commandId = contributionReference(raw.commandId, owner);
    return commandId ? { kind, commandId } : undefined;
  }
  return undefined;
}

function normalizeManifest(raw, source, scope) {
  return normalizeCoreManifest(raw, source, scope);
}

function readManifestFile(file, scope) {
  const base = path.dirname(file);
  if (!fs.existsSync(base) || !fs.existsSync(file) || !realpathContained(base, file)) {
    throw new Error(`${MANIFEST_NAME} 必须是扩展目录内真实存在的文件，不能通过符号链接越界`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 ${path.basename(file)}：${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeManifest(raw, base, scope);
}

function candidateManifests(root, scope) {
  if (!fs.existsSync(root)) return [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, MANIFEST_NAME))
    .filter((manifest) => fs.existsSync(manifest))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => ({ file, scope }));
}

function scanStudioExtensions(cwd) {
  const manifests = [];
  const errors = [];
  const installs = extensionDistributionService();
  const roots = [
    { root: userExtensionsDirectory(), scope: 'user', trusted: true },
    ...(cwd ? [{ root: projectExtensionsDirectory(cwd), scope: 'project', trusted: false }] : []),
  ];
  for (const source of roots) {
    const managedIds = new Set();
    let managedSnapshot;
    try {
      managedSnapshot = installs.listInstalledDetailed(source.scope, cwd);
    } catch (error) {
      managedSnapshot = {
        installed: [],
        errors: [{
          path: installs.stateDirectory(source.scope, cwd),
          message: error instanceof Error ? error.message : String(error),
        }],
      };
    }
    for (const error of managedSnapshot.errors) {
      errors.push({
        path: error.path,
        id: error.id,
        message: error.message,
      });
    }
    for (const installed of managedSnapshot.installed) {
      const manifestPath = path.join(installed.activeCodePath, MANIFEST_NAME);
      managedIds.add(stableExtensionId(source.scope, installed.id));
      try {
        const manifest = readManifestFile(manifestPath, source.scope);
        if (manifest.id !== installed.id || manifest.version !== installed.version) {
          throw new Error(
            `活动版本与安装状态不一致：${manifest.id}@${manifest.version} / ${installed.id}@${installed.version}`,
          );
        }
        manifests.push({
          ...manifest,
          path: manifestPath,
          trustedDefault: source.trusted,
          installation: installed,
        });
      } catch (error) {
        errors.push({
          path: manifestPath,
          id: stableExtensionId(source.scope, installed.id),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const candidate of candidateManifests(source.root, source.scope)) {
      const manifestId = path.basename(path.dirname(candidate.file));
      if (managedIds.has(stableExtensionId(source.scope, manifestId))) continue;
      try {
        const manifest = readManifestFile(candidate.file, candidate.scope);
        manifests.push({ ...manifest, path: candidate.file, trustedDefault: source.trusted });
      } catch (error) {
        errors.push({
          path: candidate.file,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { manifests: manifests.slice(0, MAX_EXTENSIONS), errors };
}

/**
 * User and project manifests with the same manifest id intentionally coexist.
 * Project rows may override user rows only at runtime, never in SQLite.
 */
function syncStudioExtensions(cwd) {
  const db = getStudioDatabase();
  const snapshot = scanStudioExtensions(cwd);
  const seen = new Set();
  const erroredIds = new Set(
    snapshot.errors.map((error) => error.id).filter(Boolean),
  );
  for (const manifest of snapshot.manifests) {
    const key = stableExtensionId(manifest.scope, manifest.id);
    if (seen.has(key)) {
      snapshot.errors.push({ path: manifest.path, message: `扩展 id 重复：${key}` });
      continue;
    }
    seen.add(key);
    const current = db.getExtension(key);
    let contentHash = '';
    if (manifest.scope === 'project') {
      try {
        contentHash = extensionContentFingerprint(manifest);
      } catch (error) {
        snapshot.errors.push({
          path: manifest.path,
          id: key,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const trustInvalidated = Boolean(
      manifest.scope === 'project'
      && current?.trusted
      && (!current.contentHash || current.contentHash !== contentHash),
    );
    db.upsertExtension({
      id: key,
      name: manifest.name,
      version: manifest.version,
      scope: manifest.scope,
      source: manifest.path,
      manifest,
      enabled: current?.enabled ?? true,
      trusted: trustInvalidated
        ? false
        : current?.trusted ?? manifest.trustedDefault,
      contentHash,
    });
  }
  for (const row of db.listExtensions().filter((item) => item.scope !== 'builtin')) {
    if (seen.has(row.id)) continue;
    if (row.scope === 'project' && row.trusted && erroredIds.has(row.id)) {
      // Invalid or tampered managed code must not retain consent for the last
      // valid snapshot merely because its old source path still exists.
      db.setExtensionTrusted(row.id, false, '');
    }
    if (fs.existsSync(row.source)) continue;
    db.removeExtension(row.id);
  }
  return { ...snapshot, rows: db.listExtensions() };
}

function installBuiltinExtension(db, input) {
  const manifestId = input.manifest?.id || input.id;
  const id = stableExtensionId('builtin', manifestId);
  const current = db.getExtension(id);
  return db.upsertExtension({
    ...input,
    id,
    scope: 'builtin',
    source: id,
    enabled: input.manifest?.tier === 'core' ? true : current?.enabled ?? true,
    trusted: true,
  });
}

function runtimeExtensionName(extensionId) {
  return `studio-extension:${extensionId}`;
}

function realpathContained(base, target) {
  const realBase = fs.realpathSync(base);
  const realTarget = fs.realpathSync(target);
  return realTarget === realBase || realTarget.startsWith(`${realBase}${path.sep}`);
}

function assertSymlinkTreeContained(root) {
  if (!fs.existsSync(root)) throw new Error('扩展目录不存在');
  const realRoot = fs.realpathSync(root);
  if (!fs.statSync(realRoot).isDirectory()) throw new Error('扩展来源必须是目录');
  const pending = [realRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = fs.realpathSync(absolute);
        } catch {
          throw new Error(`扩展目录包含失效的符号链接：${path.relative(realRoot, absolute)}`);
        }
        if (target !== realRoot && !target.startsWith(`${realRoot}${path.sep}`)) {
          throw new Error(`扩展目录包含越界符号链接：${path.relative(realRoot, absolute)}`);
        }
      } else if (entry.isDirectory()) {
        pending.push(absolute);
      }
    }
  }
  return realRoot;
}

function extensionContentFingerprint(manifest) {
  const directory = path.dirname(manifest.path);
  const managed = Boolean(manifest.installation);
  const validated = validateExtensionDirectory(directory, {
    scope: manifest.scope,
    integrity: managed ? 'required' : 'ignore',
    requirePublisher: managed,
    normalizeManifest,
  });
  if (managed && validated.treeSha256 !== manifest.installation.sha256) {
    throw new Error('扩展文件摘要与安装状态不一致，请重新安装或回滚');
  }
  return validated.treeSha256;
}

function installedExtension(row, cwd) {
  if (row.scope === 'builtin') return undefined;
  return extensionDistributionService().getInstalled(
    row.manifest.id,
    row.scope,
    cwd,
  );
}

function fingerprintForRow(row, cwd) {
  return extensionContentFingerprint({
    ...row.manifest,
    path: row.source,
    scope: row.scope,
    installation: installedExtension(row, cwd),
  });
}

function normalizedExtensionError(error, row) {
  return {
    path: row.source,
    id: row.id,
    code: 'integrity-error',
    severity: 'error',
    message: error instanceof Error ? error.message : String(error),
  };
}

function deduplicateExtensionErrors(errors) {
  const unique = new Map();
  for (const error of errors) {
    const key = [
      error?.path || '',
      error?.id || '',
      error?.message || '',
    ].join('\0');
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, error);
      continue;
    }
    unique.set(key, {
      ...previous,
      code: previous.code || error?.code || '',
      severity: previous.severity || error?.severity || '',
    });
  }
  return [...unique.values()];
}

function extensionRuntimeInventory(rows, cwd, initialErrors = []) {
  const errors = [...initialErrors];
  const fingerprints = new Map();
  const signatures = [];
  for (const row of rows) {
    let contentHash = '';
    if (row.scope !== 'builtin') {
      try {
        contentHash = fingerprintForRow(row, cwd);
        fingerprints.set(row.id, contentHash);
      } catch (error) {
        errors.push(normalizedExtensionError(error, row));
      }
    }
    signatures.push({
      id: row.id,
      scope: row.scope,
      version: row.version,
      enabled: Boolean(row.enabled),
      trusted: Boolean(row.trusted),
      contentHash,
    });
  }
  const normalizedErrors = deduplicateExtensionErrors(errors)
    .map((error) => ({
      id: error?.id || '',
      code: error?.code || '',
      severity: error?.severity || '',
      path: error?.path || '',
      message: error?.message || String(error),
    }))
    .sort((left, right) => (
      left.path.localeCompare(right.path)
      || left.id.localeCompare(right.id)
      || left.code.localeCompare(right.code)
      || left.message.localeCompare(right.message)
    ));
  signatures.sort((left, right) => left.id.localeCompare(right.id));
  return {
    errors: normalizedErrors,
    fingerprints,
    signature: JSON.stringify({
      cwd: cwd || '',
      rows: signatures,
      errors: normalizedErrors,
    }),
  };
}

function resolveEntry(row) {
  const entry = row.manifest?.runtime?.durableEntry;
  if (!entry) return undefined;
  const base = path.dirname(row.source);
  const resolved = path.resolve(base, entry);
  if (!fs.existsSync(base) || !fs.existsSync(resolved) || !realpathContained(base, resolved)) {
    throw new Error('扩展入口必须位于扩展目录内且真实存在');
  }
  return fs.realpathSync(resolved);
}

function commandHandlers(commands) {
  if (!commands) return new Map();
  if (commands instanceof Map) {
    return new Map([...commands].filter(([, value]) => typeof value === 'function'));
  }
  if (typeof commands !== 'object' || Array.isArray(commands)) return new Map();
  return new Map(Object.entries(commands).filter(([, value]) => typeof value === 'function'));
}

function assertRuntimeContributions(extension, row) {
  const permissions = row.manifest?.permissions || [];
  const declaredTools = new Set(
    (row.manifest?.contributes?.tools || []).map((tool) => tool.name),
  );
  const actualTools = new Set();
  for (const tool of extension.tools || []) {
    if (typeof tool?.name !== 'string' || !tool.name) {
      throw new Error('Durable extension 包含没有名称的工具');
    }
    if (actualTools.has(tool.name)) {
      throw new Error(`Durable extension 包含重复工具：${tool.name}`);
    }
    actualTools.add(tool.name);
    if (!declaredTools.has(tool.name)) {
      throw new Error(`工具 ${tool.name} 未在 manifest.contributes.tools 中声明`);
    }
  }
  for (const name of declaredTools) {
    if (!actualTools.has(name)) {
      throw new Error(`manifest 声明了工具 ${name}，但 Durable extension 没有提供它`);
    }
  }
  if ((extension.sections?.length || 0) > 0 && !hasPermission(permissions, 'agent.sections')) {
    throw new Error('Durable extension 提供 sections，但 manifest 未声明 agent.sections 权限');
  }
  if ((extension.hooks?.length || 0) > 0 && !hasPermission(permissions, 'agent.hooks')) {
    throw new Error('Durable extension 提供 hooks，但 manifest 未声明 agent.hooks 权限');
  }
  if ((extension.tasks?.length || 0) > 0 && !hasPermission(permissions, 'agent.tasks')) {
    throw new Error('Durable extension 提供 tasks，但 manifest 未声明 agent.tasks 权限');
  }
  for (const wrapper of extension.wraps || []) {
    const permission = wrapper.tool ? 'agent.tools' : 'agent.sections';
    if (!hasPermission(permissions, permission)) {
      throw new Error(`Durable extension 包含 wrapper，但 manifest 未声明 ${permission} 权限`);
    }
  }
}

function durableExtensionWithoutCommands(extension, row) {
  if (!extension || typeof extension !== 'object' || Array.isArray(extension)) {
    throw new Error('扩展没有返回有效的 Durable extension');
  }
  assertRuntimeContributions(extension, row);
  const { commands: _commands, ...durable } = extension;
  return {
    ...durable,
    name: runtimeExtensionName(row.id),
  };
}

function normalizeDataSources(value, row) {
  const declared = new Set(
    (row.manifest?.contributes?.dataSources || []).map((source) => source.id),
  );
  const raw = value instanceof Map
    ? Object.fromEntries(value)
    : value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  const providers = new Map();
  for (const [id, provider] of Object.entries(raw)) {
    if (!declared.has(id)) {
      throw new Error(`扩展提供了未声明的数据源：${id}`);
    }
    if (!provider || typeof provider !== 'object' || typeof provider.read !== 'function') {
      throw new Error(`数据源 ${id} 必须提供 read(context) 方法`);
    }
    if (provider.subscribe !== undefined && typeof provider.subscribe !== 'function') {
      throw new Error(`数据源 ${id} 的 subscribe 必须是函数`);
    }
    providers.set(id, provider);
  }
  const missing = [...declared].filter((id) => !providers.has(id));
  if (missing.length > 0) {
    throw new Error(`扩展缺少已声明的数据源：${missing.join(', ')}`);
  }
  return providers;
}

function extensionDataDirectory(row, cwd, extensionRoot) {
  const installs = extensionDistributionService();
  const installed = row.scope === 'builtin'
    ? undefined
    : installs.getInstalled(row.manifest.id, row.scope, cwd);
  const dataRoot = installed
    ? path.join(
      app.getPath('userData'),
      'extension-data',
      installs.scopeKey(row.scope, cwd),
    )
    : extensionRoot;
  const dataDirectory = installed?.dataPath || path.join(extensionRoot, '.data');
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  if (!realpathContained(dataRoot, dataDirectory)) {
    throw new Error('扩展数据目录通过符号链接越过了受管目录');
  }
  return fs.realpathSync(dataDirectory);
}

function providerCredentialCapability(row) {
  const permissions = row.manifest?.permissions || [];
  if (!hasPermission(permissions, 'provider.credentials')) return undefined;
  const allowedProviderIds = Object.freeze([
    ...new Set(row.manifest?.providerAccess || []),
  ]);
  if (allowedProviderIds.length === 0) {
    throw new Error('provider.credentials 权限缺少 providerAccess');
  }
  const allowed = new Set(allowedProviderIds);
  return Object.freeze({
    allowedProviderIds,
    async read(providerId, options = {}) {
      options?.signal?.throwIfAborted();
      const id = text(providerId, 64);
      if (!id || !allowed.has(id)) {
        throw new Error(`扩展没有被授权读取模型来源凭证：${id || '(empty)'}`);
      }
      const db = getStudioDatabase();
      const provider = db.getProvider(id);
      if (!provider) throw new Error(`模型来源不存在：${id}`);
      const credential = db.readCredential(id);
      options?.signal?.throwIfAborted();
      if (!credential || credential.type !== 'api_key' || typeof credential.key !== 'string') {
        return undefined;
      }
      return Object.freeze({
        providerId: id,
        type: 'api_key',
        apiKey: credential.key,
        baseUrl: provider.baseUrl || '',
      });
    },
  });
}

async function loadRuntimeExtension(row, cwd, options = {}) {
  const extensionRoot = path.dirname(row.source);
  let contentHash = typeof options.contentHash === 'string' ? options.contentHash : '';
  if (row.scope !== 'builtin') {
    if (!contentHash && (row.scope === 'project' || installedExtension(row, cwd))) {
      contentHash = fingerprintForRow(row, cwd);
    }
    if (row.scope === 'project' && row.trusted && row.contentHash !== contentHash) {
      getStudioDatabase().setExtensionTrusted(row.id, false, contentHash);
      throw new Error('项目扩展内容在信任后发生变化，已撤销信任，请重新审查');
    }
  }
  assertSymlinkTreeContained(extensionRoot);
  const entry = resolveEntry(row);
  if (!entry) return undefined;
  const moduleVersion = contentHash || row.updatedAt;
  const module = await import(`${pathToFileURL(entry).href}?v=${moduleVersion}`);
  let durableExtension;
  let commands;
  let dataSources;
  let activationContext;
  const cleanupActions = [];
  const cleanup = onceAsync(async () => {
    const actions = cleanupActions.splice(0).reverse();
    for (const action of actions) {
      try {
        await withTimeout(
          Promise.resolve().then(action.run),
          EXTENSION_CLEANUP_TIMEOUT_MS,
          action.label,
        );
      } catch (error) {
        console.warn(`Extension cleanup failed (${action.label}):`, error);
      }
    }
  });

  try {
    if (module.deactivate !== undefined && typeof module.deactivate !== 'function') {
      throw new Error('deactivate 必须是函数');
    }
    if (
      hasPermission(row.manifest?.permissions || [], 'provider.credentials')
      && typeof module.activate !== 'function'
    ) {
      throw new Error('provider.credentials 权限只能通过 activate(context) 获取，不能直接读取模块级能力');
    }
    if (typeof module.activate === 'function') {
      const dataDirectory = extensionDataDirectory(row, cwd, extensionRoot);
      const providerCredentials = providerCredentialCapability(row);
      activationContext = Object.freeze({
        apiVersion: API_VERSION,
        extensionId: row.id,
        manifestId: row.manifest.id,
        scope: row.scope,
        manifest: structuredClone(row.manifest),
        dataDirectory,
        ...(providerCredentials ? { providerCredentials } : {}),
      });
    }
    if (typeof module.deactivate === 'function') {
      cleanupActions.push({
        label: 'deactivate',
        run: () => module.deactivate(activationContext),
      });
    }
    if (typeof module.activate === 'function') {
      const activated = await module.activate(activationContext);
      if (!activated || typeof activated !== 'object' || Array.isArray(activated)) {
        throw new Error('activate() 必须返回扩展运行时对象');
      }
      if (activated.cleanup !== undefined && typeof activated.cleanup !== 'function') {
        throw new Error('activate().cleanup 必须是函数');
      }
      if (activated.cleanup) {
        cleanupActions.push({
          label: 'activate().cleanup',
          run: () => activated.cleanup(),
        });
      }
      durableExtension = activated.durableExtension;
      commands = activated.commands;
      dataSources = activated.dataSources;
    } else {
      durableExtension = module.durableExtension;
      commands = module.commands;
      dataSources = module.dataSources;
    }
    const handlers = commandHandlers(commands);
    const providers = normalizeDataSources(dataSources, row);
    if (
      (!durableExtension || typeof durableExtension !== 'object' || Array.isArray(durableExtension))
      && handlers.size === 0
      && providers.size === 0
    ) {
      throw new Error('扩展没有提供 Durable extension、命令处理器或实时数据源');
    }
    const declared = new Set((row.manifest.contributes.commands || [])
      .filter((command) => !command.action)
      .map((command) => command.id));
    const missing = [...declared].filter((commandId) => !handlers.has(commandId));
    if (missing.length > 0) {
      throw new Error(`扩展命令缺少处理器：${missing.join(', ')}`);
    }
    for (const commandId of handlers.keys()) {
      if (!declared.has(commandId)) handlers.delete(commandId);
    }
    return {
      extension: durableExtension
        ? durableExtensionWithoutCommands(durableExtension, row)
        : undefined,
      handlers,
      dataSources: providers,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function extensionTier(row) {
  const value = row?.manifest?.tier;
  if (TIERS.has(value)) return value;
  return TIERS.has(row?.scope) ? row.scope : 'user';
}

function requirementsForRow(row) {
  return Array.isArray(row?.manifest?.requires) ? row.manifest.requires : [];
}

/**
 * Build a dependency graph and detect every node that participates in a cycle.
 * Missing extensions remain in the requirements list but naturally have no
 * row in `byId`; the health pass reports them separately.
 */
function dependencyGraph(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const dependents = new Map(rows.map((row) => [row.id, []]));
  for (const row of rows) {
    for (const requirement of requirementsForRow(row)) {
      if (byId.has(requirement)) dependents.get(requirement).push(row.id);
    }
  }
  for (const items of dependents.values()) items.sort();

  const cycleIds = new Set();
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    const current = state.get(id) || 0;
    if (current === 2) return;
    if (current === 1) {
      const start = stack.indexOf(id);
      for (const cycleId of stack.slice(start)) cycleIds.add(cycleId);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const requirement of requirementsForRow(byId.get(id))) {
      if (byId.has(requirement)) visit(requirement);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const row of rows) visit(row.id);
  return { byId, dependents, cycleIds };
}

/**
 * Health is recursive: a dependent is unavailable whenever an active
 * dependency is missing, disabled, untrusted, cyclic, or failed to load.
 */
function extensionHealthForRows(rows, graph = dependencyGraph(rows), errors = []) {
  const errorsById = new Map();
  for (const item of errors) {
    if (!item?.id || item.severity === 'warning') continue;
    if (!errorsById.has(item.id)) errorsById.set(item.id, item.message);
  }
  const memo = new Map();

  const evaluate = (id, visiting = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    const row = graph.byId.get(id);
    if (!row) {
      return {
        available: false,
        health: 'missing',
        blockedReason: `扩展不存在：${id}`,
        missingDependencies: [],
        disabledDependencies: [],
        untrustedDependencies: [],
        unavailableDependencies: [],
        cycleDependencies: [],
      };
    }
    if (visiting.has(id)) {
      return {
        available: false,
        health: 'cycle',
        blockedReason: `扩展依赖形成循环：${id}`,
        missingDependencies: [],
        disabledDependencies: [],
        untrustedDependencies: [],
        unavailableDependencies: [],
        cycleDependencies: [id],
      };
    }

    const requirements = requirementsForRow(row);
    const missingDependencies = [];
    const disabledDependencies = [];
    const untrustedDependencies = [];
    const unavailableDependencies = [];
    const cycleDependencies = [];
    const blockers = [];
    const nextVisiting = new Set(visiting);
    nextVisiting.add(id);

    if (!row.enabled) {
      blockers.push({ code: 'disabled', message: `扩展已停用：${id}` });
    }
    if (!row.trusted) {
      blockers.push({ code: 'untrusted', message: `扩展尚未信任：${id}` });
    }
    if (graph.cycleIds.has(id)) {
      blockers.push({ code: 'cycle', message: `扩展依赖形成循环：${id}` });
    }
    const loadError = errorsById.get(id);
    if (loadError) {
      blockers.push({ code: 'error', message: `扩展加载失败：${loadError}` });
    }

    for (const requirement of requirements) {
      const dependency = graph.byId.get(requirement);
      if (!dependency) {
        missingDependencies.push(requirement);
        blockers.push({ code: 'missing', message: `缺少依赖扩展：${requirement}` });
        continue;
      }
      if (!dependency.enabled) {
        disabledDependencies.push(requirement);
      }
      if (!dependency.trusted) {
        untrustedDependencies.push(requirement);
      }
      if (graph.cycleIds.has(requirement)) {
        cycleDependencies.push(requirement);
      }
      const dependencyHealth = evaluate(requirement, nextVisiting);
      if (!dependencyHealth.available) {
        unavailableDependencies.push(requirement);
        blockers.push({
          code: 'dependency-unavailable',
          message: `依赖扩展 ${requirement} 不可用：${dependencyHealth.blockedReason}`,
        });
      }
    }

    let health = 'available';
    if (!row.enabled) health = 'disabled';
    else if (!row.trusted) health = 'untrusted';
    else if (loadError) health = 'error';
    else if (graph.cycleIds.has(id)) health = 'cycle';
    else if (blockers.length > 0) health = 'blocked';

    const result = {
      available: blockers.length === 0,
      health,
      blockedReason: blockers[0]?.message || '',
      missingDependencies,
      disabledDependencies: [...new Set(disabledDependencies)],
      untrustedDependencies: [...new Set(untrustedDependencies)],
      unavailableDependencies: [...new Set(unavailableDependencies)],
      cycleDependencies: [...new Set(cycleDependencies)],
    };
    memo.set(id, result);
    return result;
  };

  return new Map(rows.map((row) => [row.id, evaluate(row.id)]));
}

function dependencyOrder(rows, graph = dependencyGraph(rows)) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);
    const row = graph.byId.get(id);
    if (row) {
      for (const requirement of requirementsForRow(row)) {
        if (graph.byId.has(requirement)) visit(requirement);
      }
      ordered.push(row);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const row of rows) visit(row.id);
  return ordered;
}

function activeDependentsFor(row, graph) {
  return (graph.dependents.get(row.id) || [])
    .map((id) => graph.byId.get(id))
    .filter((candidate) => candidate?.enabled);
}

function managementState(row, graph) {
  const tier = extensionTier(row);
  const activeDependents = activeDependentsFor(row, graph);
  const dependentReason = activeDependents.length > 0
    ? `仍有启用的扩展依赖它：${activeDependents.map((item) => item.id).join(', ')}`
    : '';
  let disableBlockedReason = '';
  let removeBlockedReason = '';
  if (tier === 'core') {
    disableBlockedReason = '核心扩展不能停用';
    removeBlockedReason = '核心扩展不能删除';
  } else {
    disableBlockedReason = dependentReason;
    removeBlockedReason = dependentReason || '内置扩展不能删除';
  }
  const removable = tier === 'user' || tier === 'project';
  if (removable) removeBlockedReason = dependentReason;
  return {
    canDisable: !disableBlockedReason,
    canRemove: removable && !removeBlockedReason,
    activeDependents: activeDependents.map((item) => item.id),
    disableBlockedReason,
    removeBlockedReason,
    manageBlockedReason: disableBlockedReason || removeBlockedReason,
  };
}

function toolConflictDiagnostics(rows, diagnostics) {
  const owners = new Map();
  for (const row of rows) {
    for (const tool of row.manifest?.contributes?.tools || []) {
      const previous = owners.get(tool.name);
      if (!previous) {
        owners.set(tool.name, row);
        continue;
      }
      const previousTier = extensionTier(previous);
      const currentTier = extensionTier(row);
      const previousProtected = PROTECTED_BUILTIN_TIERS.has(previousTier);
      const currentProtected = PROTECTED_BUILTIN_TIERS.has(currentTier);
      const blocksOverride = previousProtected || currentProtected;
      const offender = previousProtected ? row : currentProtected ? previous : row;
      if (currentProtected && !previousProtected) owners.set(tool.name, row);
      diagnostics.push({
        id: offender.id,
        path: offender.source,
        code: 'tool-conflict',
        severity: blocksOverride ? 'error' : 'warning',
        message: blocksOverride
          ? `受保护的 core/optional 内置扩展贡献 ${tool.name}，普通扩展不能覆盖：${offender.id}`
          : `工具名称冲突：${tool.name}（${previous.id} 与 ${row.id}；按 core → system → user → project 顺序，后者覆盖前者）`,
      });
    }
  }
}

function runtimeRows(rows) {
  return [...rows].sort((left, right) => (
    TIER_RANK.get(extensionTier(left)) - TIER_RANK.get(extensionTier(right))
    || SCOPE_RANK.get(left.scope) - SCOPE_RANK.get(right.scope)
    || left.id.localeCompare(right.id)
  ));
}

async function reloadStudioExtensionsUnlocked(runtime, cwd, prepared = {}) {
  const effectiveCwd = cwd ? path.resolve(cwd) : '';
  await closeAllExtensionDataViewServices();
  const previousHost = host?.runtime === runtime ? host : undefined;
  const installed = previousHost?.installed || new Map();
  if (previousHost) host = undefined;
  await Promise.all([...installed.values()].map(async (item) => {
    try {
      if (typeof item.cleanup === 'function') await item.cleanup();
    } finally {
      if (!item.extension) return;
      try { runtime.registry.uninstall(item.extension); } catch { /* already replaced */ }
    }
  }));
  installed.clear();
  const synced = prepared.synced || syncStudioExtensions(effectiveCwd);
  const visibleRows = prepared.rows
    || synced.rows.filter((row) => rowVisibleForWorkspace(row, effectiveCwd));
  const rows = prepared.rows || runtimeRows(visibleRows);
  const inventory = prepared.inventory
    || extensionRuntimeInventory(rows, effectiveCwd, synced.errors);
  const errors = [...inventory.errors];
  toolConflictDiagnostics(rows, errors);
  const graph = dependencyGraph(rows);
  const initialHealth = extensionHealthForRows(rows, graph, errors);
  const loadUnavailable = new Set();
  const commands = new Map();
  const dataSources = new Map();
  for (const row of dependencyOrder(rows, graph)) {
    const health = initialHealth.get(row.id);
    if (!health?.available) continue;
    const unavailableDependency = requirementsForRow(row)
      .find((requirement) => loadUnavailable.has(requirement));
    if (unavailableDependency) {
      loadUnavailable.add(row.id);
      continue;
    }
    let loaded;
    try {
      if (row.scope === 'builtin') {
        const extension = runtime.builtinExtensions?.get(row.id);
        if (!extension) throw new Error(`内置扩展运行时尚未注册：${row.id}`);
        const providers = new Map();
        for (const source of row.manifest?.contributes?.dataSources || []) {
          const sourceId = contributionId(row, row.scope, source.id);
          const provider = runtime.extensionDataSources?.[sourceId];
          if (!provider || typeof provider.read !== 'function') {
            throw new Error(`内置扩展声明了不可用的数据源：${sourceId}`);
          }
          providers.set(source.id, provider);
        }
        loaded = { extension, handlers: new Map(), dataSources: providers };
      } else {
        if (!row.manifest?.runtime?.durableEntry) continue;
        loaded = await loadRuntimeExtension(row, effectiveCwd, {
          contentHash: inventory.fingerprints.get(row.id),
        });
      }
      if (!loaded) continue;
      if (loaded.extension) runtime.registry.install(loaded.extension);
      installed.set(row.id, loaded);
      for (const [commandId, handler] of loaded.handlers) {
        commands.set(contributionId(row, row.scope, commandId), handler);
      }
      for (const [sourceId, provider] of loaded.dataSources || []) {
        dataSources.set(contributionId(row, row.scope, sourceId), provider);
      }
    } catch (error) {
      try {
        if (typeof loaded?.cleanup === 'function') await loaded.cleanup();
        if (loaded?.extension) runtime.registry.uninstall(loaded.extension);
      } catch {
        // A failed activation must not prevent the remaining extensions from loading.
      }
      errors.push({
        path: row.source,
        id: row.id,
        code: 'load-error',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      loadUnavailable.add(row.id);
    }
  }
  host = {
    runtime,
    cwd: effectiveCwd,
    installed,
    commands,
    dataSources,
    errors,
    runtimeSignature: inventory.signature,
    syncedAt: Date.now(),
  };
  return extensionHostSnapshot();
}

async function reloadStudioExtensions(runtime, cwd) {
  return serializeExtensionRuntime(() => (
    reloadStudioExtensionsUnlocked(runtime, cwd)
  ));
}

/**
 * Verify the files that were actually loaded before a new run starts.
 *
 * Ordinary UI reads should not pay for a full tree hash. Submissions call this
 * immediately before runtimeSelection(), so direct edits, dependency changes,
 * and managed-package tampering cannot silently leave the previous module in
 * the registry. The operation shares a queue with explicit settings reloads.
 */
async function ensureStudioExtensionIntegrity(runtime, cwd) {
  return serializeExtensionRuntime(async () => {
    const effectiveCwd = cwd ? path.resolve(cwd) : '';
    const synced = syncStudioExtensions(effectiveCwd);
    const visibleRows = synced.rows.filter((row) => (
      rowVisibleForWorkspace(row, effectiveCwd)
    ));
    const rows = runtimeRows(visibleRows);
    const inventory = extensionRuntimeInventory(rows, effectiveCwd, synced.errors);
    const current = host?.runtime === runtime
      && host?.cwd === effectiveCwd
      && host?.runtimeSignature === inventory.signature;
    if (!current) {
      await reloadStudioExtensionsUnlocked(runtime, effectiveCwd, {
        synced,
        rows,
        inventory,
      });
    }
    return {
      reloaded: !current,
      runtimeSignature: inventory.signature,
      errors: inventory.errors,
      syncedAt: host?.syncedAt || 0,
    };
  });
}

async function uninstallStudioExtensionsUnlocked() {
  if (!host) return;
  const current = host;
  host = undefined;
  await Promise.all([...current.installed.values()].map(async (item) => {
    try {
      if (typeof item.cleanup === 'function') await item.cleanup();
    } finally {
      if (!item.extension) return;
      try { current.runtime.registry.uninstall(item.extension); } catch { /* runtime is closing */ }
    }
  }));
}

async function uninstallStudioExtensions() {
  return serializeExtensionRuntime(uninstallStudioExtensionsUnlocked);
}

function extensionDataSource(sourceId) {
  return host?.dataSources?.get(sourceId);
}

function managedRoot(scope, cwd) {
  if (scope === 'user') return userExtensionsDirectory();
  if (scope === 'project' && cwd) return projectExtensionsDirectory(cwd);
  throw new Error('扩展范围无效');
}

function assertManagedPath(target, scope, cwd) {
  const root = path.resolve(managedRoot(scope, cwd));
  const resolved = path.resolve(target);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('扩展路径必须位于 Pi Studio 的扩展目录内');
  }
  const existing = fs.existsSync(resolved) ? resolved : path.dirname(resolved);
  if (!fs.existsSync(root) || !fs.existsSync(existing) || !realpathContained(root, existing)) {
    throw new Error('扩展路径通过符号链接越过了受管目录');
  }
  return resolved;
}

function importStudioExtension(source, scope, cwd) {
  if (typeof source !== 'string' || !source) throw new Error('扩展来源无效');
  const root = managedRoot(scope, cwd);
  const stat = fs.statSync(source);
  if (!stat.isDirectory()) throw new Error('扩展必须是包含 pi-studio.extension.json 的目录');
  assertSymlinkTreeContained(source);
  const manifestFile = path.join(source, MANIFEST_NAME);
  if (!fs.existsSync(manifestFile)) throw new Error(`扩展目录缺少 ${MANIFEST_NAME}`);
  const manifest = readManifestFile(manifestFile, scope);
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, manifest.id);
  if (fs.existsSync(target)) throw new Error(`同名扩展已存在：${manifest.id}`);
  fs.cpSync(source, target, { recursive: true, errorOnExist: true, dereference: false });
  if (!realpathContained(root, target)) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error('导入后的扩展目录通过符号链接越界');
  }
  try {
    assertSymlinkTreeContained(target);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  syncStudioExtensions(cwd);
  return getStudioDatabase().getExtension(stableExtensionId(scope, manifest.id));
}

function extensionRowsForWorkspace(cwd) {
  const effectiveCwd = cwd || host?.cwd || '';
  return syncStudioExtensions(effectiveCwd).rows
    .filter((row) => rowVisibleForWorkspace(row, effectiveCwd));
}

function assertNoActiveDependents(row, cwd, action) {
  const rows = extensionRowsForWorkspace(cwd);
  const graph = dependencyGraph(rows);
  const activeDependents = activeDependentsFor(row, graph);
  if (activeDependents.length > 0) {
    throw new Error(
      `无法${action} ${row.id}，仍有启用的扩展依赖它：${activeDependents.map((item) => item.id).join(', ')}`,
    );
  }
}

function setStudioExtensionEnabled(id, enabled, cwd) {
  const row = extensionRowsForWorkspace(cwd).find((item) => item.id === id);
  if (!row) throw new Error('扩展不存在');
  const nextEnabled = Boolean(enabled);
  if (row.enabled === nextEnabled) return row;
  if (!nextEnabled) {
    if (extensionTier(row) === 'core') throw new Error(`核心扩展不能停用：${id}`);
    assertNoActiveDependents(row, cwd, '停用');
  }
  return getStudioDatabase().setExtensionEnabled(id, nextEnabled);
}

function setStudioExtensionTrusted(id, trusted, cwd) {
  const row = extensionRowsForWorkspace(cwd).find((item) => item.id === id);
  if (!row) throw new Error('扩展不存在');
  if (row.scope === 'builtin') return row;
  const nextTrusted = Boolean(trusted);
  if (!nextTrusted && row.trusted) assertNoActiveDependents(row, cwd, '撤销信任');
  const contentHash = nextTrusted
    ? extensionContentFingerprint({
      ...row.manifest,
      path: row.source,
      scope: row.scope,
      installation: extensionDistributionService().getInstalled(
        row.manifest.id,
        row.scope,
        cwd,
      ),
    })
    : '';
  return getStudioDatabase().setExtensionTrusted(id, nextTrusted, contentHash);
}

async function removeStudioExtension(id, cwd, options = {}) {
  const row = extensionRowsForWorkspace(cwd).find((item) => item.id === id);
  if (!row) return { removed: false };
  if (row.scope === 'builtin') throw new Error('Studio 内置扩展不能删除');
  assertNoActiveDependents(row, cwd, '删除');
  const installs = extensionDistributionService();
  const installed = installs.getInstalled(row.manifest.id, row.scope, cwd);
  if (installed) {
    const removed = await installs.uninstall(row.manifest.id, {
      scope: row.scope,
      cwd,
      preserveData: options.preserveData !== false,
      force: false,
    });
    getStudioDatabase().removeExtension(id);
    return removed;
  }
  const extensionDirectory = path.dirname(assertManagedPath(row.source, row.scope, cwd));
  getStudioDatabase().removeExtension(id);
  fs.rmSync(extensionDirectory, { recursive: true, force: true });
  return { removed: true };
}

function rowVisibleForWorkspace(row, cwd) {
  if (row.scope !== 'project') return true;
  if (!cwd) return false;
  const root = projectExtensionsDirectory(cwd);
  try {
    return fs.existsSync(root)
      && fs.existsSync(row.source)
      && realpathContained(root, row.source);
  } catch {
    // A concurrent uninstall or path replacement should hide the stale row,
    // never break every settings and conversation lookup.
    return false;
  }
}

function installationSnapshot(row, cwd) {
  if (row.scope === 'builtin') return undefined;
  let installed;
  try {
    installed = extensionDistributionService().getInstalled(
      row.manifest.id,
      row.scope,
      cwd,
    );
  } catch {
    return undefined;
  }
  if (!installed) return undefined;
  return {
    managed: true,
    version: installed.version,
    activeCodePath: installed.activeCodePath,
    dataPath: installed.dataPath,
    sha256: installed.sha256,
    source: installed.source,
    sourceKind: installed.sourceKind,
    resolvedRef: installed.resolvedRef,
    publisher: installed.publisher,
    signatureStatus: installed.signatureStatus,
    signaturePublisher: installed.signaturePublisher,
    signatureKeyId: installed.signatureKeyId,
    activeHistoryIndex: installed.activeHistoryIndex,
    canRollback: installed.history
      .slice(0, installed.activeHistoryIndex)
      .some((entry) => fs.existsSync(entry.codePath)),
    versions: installed.history.map((entry, index) => ({
      version: entry.version,
      sha256: entry.sha256,
      sourceKind: entry.sourceKind,
      resolvedRef: entry.resolvedRef,
      publisher: entry.publisher,
      signatureStatus: entry.signatureStatus,
      signaturePublisher: entry.signaturePublisher,
      signatureKeyId: entry.signatureKeyId,
      activatedAt: entry.activatedAt,
      active: index === installed.activeHistoryIndex,
    })),
  };
}

function extensionHostSnapshot() {
  const db = getStudioDatabase();
  const rows = db.listExtensions()
    .filter((row) => rowVisibleForWorkspace(row, host?.cwd))
    .sort((left, right) => (
      TIER_RANK.get(extensionTier(left)) - TIER_RANK.get(extensionTier(right))
      || SCOPE_RANK.get(left.scope) - SCOPE_RANK.get(right.scope)
      || left.name.localeCompare(right.name, 'zh-CN')
      || left.id.localeCompare(right.id)
    ));
  const graph = dependencyGraph(rows);
  const errors = host?.errors || [];
  const health = extensionHealthForRows(rows, graph, errors);
  return {
    extensions: rows.map((row) => {
      const rowHealth = health.get(row.id);
      const management = managementState(row, graph);
      const needsRuntime = row.scope === 'builtin'
        || Boolean(row.manifest?.runtime?.durableEntry);
      return {
        ...row,
        tier: extensionTier(row),
        runtimeName: row.scope === 'builtin'
          ? row.manifest?.runtimeName || row.id
          : runtimeExtensionName(row.id),
        runtimeNames: row.scope === 'builtin'
          ? row.manifest?.runtimeNames || [row.manifest?.runtimeName || row.id]
          : [runtimeExtensionName(row.id)],
        requirements: requirementsForRow(row),
        dependents: graph.dependents.get(row.id) || [],
        activeDependents: management.activeDependents,
        available: rowHealth.available && (!needsRuntime || Boolean(host?.installed?.has(row.id))),
        health: rowHealth.health,
        blockedReason: rowHealth.blockedReason,
        missingDependencies: rowHealth.missingDependencies,
        disabledDependencies: rowHealth.disabledDependencies,
        untrustedDependencies: rowHealth.untrustedDependencies,
        unavailableDependencies: rowHealth.unavailableDependencies,
        cycleDependencies: rowHealth.cycleDependencies,
        canDisable: management.canDisable,
        canRemove: management.canRemove,
        disableBlockedReason: management.disableBlockedReason,
        removeBlockedReason: management.removeBlockedReason,
        manageBlockedReason: management.manageBlockedReason,
        commandIds: (row.manifest?.contributes?.commands || [])
          .map((command) => contributionId(row, row.scope, command.id)),
        panelIds: (row.manifest?.contributes?.panels || [])
          .map((panel) => contributionId(row, row.scope, panel.id)),
        dataSourceIds: (row.manifest?.contributes?.dataSources || [])
          .map((source) => contributionId(row, row.scope, source.id)),
        installation: installationSnapshot(row, host?.cwd),
      };
    }),
    errors,
    syncedAt: host?.syncedAt || 0,
    apiVersion: API_VERSION,
  };
}

function extensionRowsForRuntime(cwd) {
  const effectiveCwd = cwd || host?.cwd || '';
  const rows = syncStudioExtensions(effectiveCwd).rows
    .filter((row) => rowVisibleForWorkspace(row, effectiveCwd));
  const graph = dependencyGraph(rows);
  const health = extensionHealthForRows(rows, graph, host?.errors || []);
  return runtimeRows(rows.filter((row) => health.get(row.id)?.available));
}

function extensionUiSnapshot() {
  const snapshot = extensionHostSnapshot();
  const items = [];
  let sourceOrder = 0;
  for (const row of snapshot.extensions) {
    if (!row.available || !hasPermission(row.manifest.permissions || [], 'ui.panels')) continue;
    for (const panel of row.manifest.contributes?.panels || []) {
      items.push({
        id: contributionId(row, row.scope, panel.id),
        extensionId: row.id,
        extensionName: row.name,
        scope: row.scope,
        contributionId: panel.id,
        title: panel.title,
        description: panel.description,
        slot: panel.slot,
        ...(panel.icon ? { icon: panel.icon } : {}),
        size: panel.size || 'regular',
        priority: panel.priority || 0,
        sourceOrder,
        content: structuredClone(panel.content || []),
      });
      sourceOrder += 1;
    }
    if (hasPermission(row.manifest.permissions || [], 'ui.settings')) {
      for (const setting of row.manifest.contributes?.settings || []) {
        items.push({
          id: contributionId(row, row.scope, setting.id),
          extensionId: row.id,
          extensionName: row.name,
          scope: row.scope,
          contributionId: setting.id,
          title: setting.title,
          description: setting.description,
          slot: 'settings.panel',
          size: 'regular',
          priority: 0,
          sourceOrder,
          content: structuredClone(setting.content || []),
        });
        sourceOrder += 1;
      }
    }
  }
  items.sort((left, right) => (
    right.priority - left.priority || left.sourceOrder - right.sourceOrder
  ));
  return {
    items,
    errors: snapshot.errors,
    syncedAt: snapshot.syncedAt,
    apiVersion: snapshot.apiVersion,
  };
}

function findManifestCommand(commandId) {
  for (const row of getStudioDatabase().listExtensions()) {
    for (const command of row.manifest?.contributes?.commands || []) {
      if (contributionId(row, row.scope, command.id) === commandId) return { row, command };
    }
  }
  return undefined;
}

function normalizeCommandResult(value, row) {
  if (typeof value === 'string') return { ok: true, message: value.slice(0, 4_000) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: true };
  const result = { ok: true };
  const message = text(value.message, 4_000);
  const promptText = text(value.promptText, 100_000);
  const panelId = text(value.panelId, 220);
  const settingsPage = text(value.settingsPage, 32);
  if (message) result.message = message;
  if (promptText) result.promptText = promptText;
  if (value.submit === true) result.submit = true;
  if (value.action !== undefined) {
    const action = normalizeUiAction(value.action, {
      manifestId: row.manifest.id,
      scope: row.scope,
    });
    if (!action) throw new Error('扩展命令返回了不受支持的 UI action');
    if (action.kind === 'openPanel') {
      const declared = hasPermission(row.manifest.permissions || [], 'ui.panels')
        && (row.manifest.contributes?.panels || [])
          .some((panel) => contributionId(row, row.scope, panel.id) === action.panelId);
      if (!declared) {
        throw new Error('扩展命令返回了未声明的 openPanel UI action');
      }
    }
    if (action.kind === 'runCommand') {
      const target = (row.manifest.contributes?.commands || [])
        .find((command) => contributionId(row, row.scope, command.id) === action.commandId);
      if (!hasPermission(row.manifest.permissions || [], 'ui.commands')
        || !target
        || target.action) {
        throw new Error('扩展命令返回的 runCommand UI action 必须指向本扩展的 runtime 命令');
      }
    }
    result.action = action;
  }
  if (panelId) {
    const declaredPanel = hasPermission(row.manifest.permissions || [], 'ui.panels')
      && (row.manifest.contributes?.panels || [])
        .some((panel) => contributionId(row, row.scope, panel.id) === panelId);
    if (!declaredPanel) {
      throw new Error('扩展命令返回了未在本扩展声明且具备 ui.panels 权限的 panelId');
    }
    result.panelId = panelId;
  }
  if (settingsPage) {
    if (!SETTINGS_PAGES.has(settingsPage)) {
      throw new Error(`扩展命令返回了未知设置页：${settingsPage}`);
    }
    result.settingsPage = settingsPage;
  }
  return result;
}

async function executeStudioExtensionCommand(payload = {}) {
  const commandId = text(payload.commandId, 220);
  const found = findManifestCommand(commandId);
  if (!found) throw new Error('扩展命令不存在');
  const { row, command } = found;
  const snapshot = extensionHostSnapshot().extensions.find((item) => item.id === row.id);
  if (!snapshot?.available) throw new Error('扩展当前不可用');
  if (command.action) return { ok: true, action: structuredClone(command.action) };
  const handler = host?.commands?.get(commandId);
  if (!handler) throw new Error('扩展没有注册这个命令的处理器');
  const value = await handler(Object.freeze({
    extensionId: row.id,
    manifestId: row.manifest.id,
    scope: row.scope,
    sessionId: optionalText(payload.sessionId, 100),
    cwd: optionalText(payload.cwd, 4_096),
    input: text(payload.input, 100_000),
  }));
  return normalizeCommandResult(value, row);
}

function composerCommandsFromSnapshot(snapshot) {
  const deduplicated = new Map();
  for (const row of snapshot.extensions || []) {
    if (!row.available || !hasPermission(row.manifest.permissions || [], 'ui.commands')) continue;
    const composer = (row.manifest.contributes?.composer || []).map((item) => ({
      id: contributionId(row, row.scope, item.id),
      commandId: contributionId(row, row.scope, item.action),
      name: item.id,
      title: item.title,
      description: item.description,
      argumentHint: item.argumentHint,
      extensionId: row.id,
      extensionName: row.name,
    }));
    const commands = (row.manifest.contributes?.commands || [])
      .filter((item) => item.placement === 'composer' || item.placement === 'command-menu')
      .map((item) => ({
        id: contributionId(row, row.scope, item.id),
        commandId: contributionId(row, row.scope, item.id),
        name: item.id,
        title: item.title,
        description: item.description,
        argumentHint: item.argumentHint,
        extensionId: row.id,
        extensionName: row.name,
      }));
    for (const command of [...composer, ...commands]) {
      if (!deduplicated.has(command.commandId)) deduplicated.set(command.commandId, command);
    }
  }
  return [...deduplicated.values()];
}

function extensionComposerCommands() {
  return composerCommandsFromSnapshot(extensionHostSnapshot());
}

module.exports = {
  API_VERSION,
  MANIFEST_NAME,
  assertSymlinkTreeContained,
  composerCommandsFromSnapshot,
  contributionId,
  dependencyGraph,
  dependencyOrder,
  ensureStudioExtensionIntegrity,
  executeStudioExtensionCommand,
  extensionComposerCommands,
  extensionDataSource,
  extensionDistributionService,
  extensionHealthForRows,
  extensionHostSnapshot,
  extensionRowsForRuntime,
  extensionTier,
  extensionUiSnapshot,
  importStudioExtension,
  installBuiltinExtension,
  loadRuntimeExtension,
  managementState,
  normalizeContent: normalizeUiContent,
  normalizeContentList: normalizeUiContentList,
  normalizeManifest,
  normalizeCommandResult,
  officialExtensionService,
  officialExtensionsRoot,
  officialExtensionsSnapshot,
  projectExtensionsDirectory,
  purgeProjectWorkspaceState,
  providerCredentialCapability,
  removeStudioExtension,
  reloadStudioExtensions,
  runtimeExtensionName,
  scanStudioExtensions,
  setStudioExtensionEnabled,
  setStudioExtensionTrusted,
  setOfficialExtensionAutoUpdate,
  stableExtensionId,
  syncStudioExtensions,
  toolConflictDiagnostics,
  uninstallStudioExtensions,
  userExtensionsDirectory,
  autoUpdateOfficialExtensions,
};

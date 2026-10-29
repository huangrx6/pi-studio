'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_ARCHIVE_LIMITS,
  extractZipArchive,
  sha256,
} = require('../core/extension-archive.cjs');
const {
  createExtensionPackage,
  integrityFromFiles,
  INTEGRITY_NAME,
  MANIFEST_NAME,
  normalizeIntegrity,
  readIntegrity,
  validateExtensionDirectory,
  verifyIntegrity,
  walkPackageFiles,
} = require('../core/extension-package.cjs');
const {
  normalizePublicKey,
  verifyExtensionDirectory,
} = require('../core/extension-signature.cjs');
const {
  ExtensionTrustStore,
} = require('../core/extension-trust.cjs');
const {
  compareSemver,
  isValidSemverRange,
  parseSemver,
  satisfiesSemver,
} = require('../core/extension-semver.cjs');

const INSTALL_STATE_VERSION = 1;
const REGISTRY_SCHEMA_VERSION = 1;
const PREPARED_TTL_MS = 30 * 60 * 1_000;
const MAX_REDIRECTS = 5;
const MAX_REGISTRY_BYTES = 3 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const MAX_GITHUB_JSON_BYTES = 4 * 1024 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SAFE_GITHUB_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const SAFE_GITHUB_REF = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const EXTENSION_REFERENCE_PATTERN = /^(?:builtin|user|project):[a-z0-9][a-z0-9._-]{1,63}$/;
const PUBLISHER_KEY_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const REGISTRY_ROOT_KEYS = new Set([
  '$schema',
  'schemaVersion',
  'name',
  'updatedAt',
  'extensions',
]);
const EXTENSION_METADATA_KEYS = new Set([
  'id',
  'name',
  'publisher',
  'publisherKey',
  'publisherKeyId',
  'summary',
  'repository',
  'homepage',
  'icon',
  'keywords',
  'versions',
]);
const VERSION_METADATA_KEYS = new Set([
  'version',
  'piStudio',
  'download',
  'sha256',
  'size',
  'permissions',
  'requires',
  'publishedAt',
  'deprecated',
  'minimumPiStudio',
]);
const VALID_PERMISSIONS = new Set([
  'agent.tools',
  'agent.sections',
  'agent.hooks',
  'agent.tasks',
  'ui.commands',
  'ui.panels',
  'ui.settings',
  'ui.data',
  'provider.credentials',
  'network',
]);

class ExtensionDistributionError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ExtensionDistributionError';
    this.code = code;
    this.details = details;
  }
}

function distributionError(code, message, details) {
  return new ExtensionDistributionError(code, message, details);
}

function assertSafeExtensionId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id)) {
    throw distributionError('INVALID_EXTENSION_ID', '扩展 ID 无效');
  }
  return id;
}

function normalizeSha256(value, label = 'SHA-256') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value.toLowerCase())) {
    throw distributionError('INVALID_INTEGRITY', `${label} 必须是 64 位十六进制字符串`);
  }
  return value.toLowerCase();
}

function normalizeMetadataText(value, label, maximum, required = false) {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > maximum
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw distributionError(
      'INVALID_REGISTRY',
      `${label} 必须是 1–${maximum} 个字符且不含控制字符的字符串`,
    );
  }
  return value.trim();
}

function normalizeDateTime(value, label, required = false) {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== 'string'
    || !value
    || value.length > 64
    || CONTROL_CHARACTER_PATTERN.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw distributionError('INVALID_REGISTRY', `${label} 必须是有效日期时间`);
  }
  return new Date(value).toISOString();
}

function normalizeHttpsMetadataUrl(value, label) {
  if (value === undefined) return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw distributionError('INVALID_REGISTRY', `${label} 不是 URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || value.length > 2_000) {
    throw distributionError('INVALID_REGISTRY', `${label} 必须是无凭据的 HTTPS URL`);
  }
  return parsed.toString();
}

function pathExists(value) {
  try {
    return fs.existsSync(value);
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
}

function isPathInside(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function ensureContainedDirectory(directory, boundary) {
  const resolvedBoundary = path.resolve(boundary);
  ensurePrivateDirectory(resolvedBoundary);
  const realBoundary = fs.realpathSync(resolvedBoundary);
  const resolvedTarget = path.resolve(directory);
  const relative = path.relative(resolvedBoundary, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw distributionError('UNSAFE_MANAGED_PATH', '受管扩展目录越过了应用或工作区边界');
  }
  let cursor = resolvedBoundary;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw distributionError('UNSAFE_MANAGED_PATH', `受管扩展目录不能包含符号链接：${cursor}`);
      }
      if (!stat.isDirectory()) {
        throw distributionError('UNSAFE_MANAGED_PATH', `受管扩展路径不是目录：${cursor}`);
      }
    } else {
      fs.mkdirSync(cursor, { mode: 0o700 });
    }
  }
  const realTarget = fs.realpathSync(resolvedTarget);
  if (!isPathInside(realBoundary, realTarget)) {
    throw distributionError('UNSAFE_MANAGED_PATH', '受管扩展目录通过符号链接越界');
  }
  return realTarget;
}

function assertManagedPathInside(base, target, label) {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  if (!isPathInside(resolvedBase, resolvedTarget)) {
    throw distributionError('UNSAFE_MANAGED_PATH', `${label}越过了受管目录`);
  }
  if (!fs.existsSync(resolvedBase)) return;
  const realBase = fs.realpathSync(resolvedBase);
  let cursor = resolvedBase;
  const relative = path.relative(resolvedBase, resolvedTarget);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw distributionError('UNSAFE_MANAGED_PATH', `${label}不能通过符号链接越界`);
    }
  }
  if (fs.existsSync(resolvedTarget)) {
    const realTarget = fs.realpathSync(resolvedTarget);
    if (!isPathInside(realBase, realTarget)) {
      throw distributionError('UNSAFE_MANAGED_PATH', `${label}通过符号链接越过了受管目录`);
    }
  }
}

function atomicWriteFile(file, content, mode = 0o600) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { flag: 'wx', mode });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function atomicWriteJson(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonFile(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw distributionError('INVALID_JSON', `无法读取 ${label}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw distributionError('INVALID_JSON', `${label} 必须是对象`);
  }
  return value;
}

function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function fileSizeWithin(file, maximum) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw distributionError('INVALID_SOURCE', '扩展包必须是普通文件');
  if (stat.size > maximum) throw distributionError('PACKAGE_TOO_LARGE', `扩展包超过 ${maximum} 字节上限`);
  return stat.size;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withInstallLock(lockPath, callback) {
  ensurePrivateDirectory(path.dirname(lockPath));
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // Another process may have released it between stat and read.
      }
      if (Date.now() >= deadline) {
        throw distributionError('INSTALL_BUSY', '另一个扩展安装操作仍在进行，请稍后重试');
      }
      await sleep(25);
    }
  }
  try {
    return await callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function parseChecksumFile(content, filename) {
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match && path.basename(match[2]) === path.basename(filename)) return match[1].toLowerCase();
  }
  return undefined;
}

function validateRegistry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw distributionError('INVALID_REGISTRY', 'registry 必须是对象');
  }
  for (const key of Object.keys(raw)) {
    if (!REGISTRY_ROOT_KEYS.has(key)) {
      throw distributionError('INVALID_REGISTRY', `registry 包含未知字段：${key}`);
    }
  }
  if (raw.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw distributionError('INVALID_REGISTRY', `不支持的 registry schemaVersion：${raw.schemaVersion}`);
  }
  if (!Array.isArray(raw.extensions)) throw distributionError('INVALID_REGISTRY', 'registry.extensions 必须是数组');
  if (raw.extensions.length > 5_000) {
    throw distributionError('INVALID_REGISTRY', 'registry.extensions 最多允许 5000 项');
  }
  if (
    raw.$schema !== undefined
    && (
      typeof raw.$schema !== 'string'
      || !raw.$schema
      || raw.$schema.length > 2_000
      || CONTROL_CHARACTER_PATTERN.test(raw.$schema)
    )
  ) {
    throw distributionError('INVALID_REGISTRY', 'registry.$schema 必须是有效字符串');
  }
  const registryName = raw.name === undefined
    ? undefined
    : normalizeMetadataText(raw.name, 'registry.name', 120);
  const updatedAt = normalizeDateTime(raw.updatedAt, 'registry.updatedAt');
  const ids = new Set();
  const extensions = raw.extensions.map((extension, extensionIndex) => {
    if (!extension || typeof extension !== 'object' || Array.isArray(extension)) {
      throw distributionError('INVALID_REGISTRY', `extensions[${extensionIndex}] 必须是对象`);
    }
    assertSafeExtensionId(extension.id);
    if (ids.has(extension.id)) throw distributionError('INVALID_REGISTRY', `registry 扩展 ID 重复：${extension.id}`);
    ids.add(extension.id);
    if (
      !Array.isArray(extension.versions)
      || extension.versions.length === 0
      || extension.versions.length > 1_000
    ) {
      throw distributionError('INVALID_REGISTRY', `${extension.id} 缺少 versions`);
    }
    if (typeof extension.publisher !== 'string' || !extension.publisher.trim()) {
      throw distributionError('INVALID_REGISTRY', `${extension.id} 缺少 publisher`);
    }
    for (const key of Object.keys(extension)) {
      if (!EXTENSION_METADATA_KEYS.has(key)) {
        throw distributionError('INVALID_REGISTRY', `${extension.id} 包含未知字段：${key}`);
      }
    }
    const name = normalizeMetadataText(extension.name, `${extension.id}.name`, 120, true);
    const publisher = normalizeMetadataText(
      extension.publisher,
      `${extension.id}.publisher`,
      80,
      true,
    );
    let publisherKey;
    let publisherKeyId;
    if (extension.publisherKey !== undefined) {
      try {
        const key = normalizePublicKey(extension.publisherKey);
        publisherKey = key.base64;
        publisherKeyId = key.keyId;
      } catch (error) {
        throw distributionError(
          'INVALID_REGISTRY',
          `${extension.id}.publisherKey 无效：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (extension.publisherKeyId !== undefined) {
      if (
        typeof extension.publisherKeyId !== 'string'
        || !PUBLISHER_KEY_ID_PATTERN.test(extension.publisherKeyId)
      ) {
        throw distributionError('INVALID_REGISTRY', `${extension.id}.publisherKeyId 无效`);
      }
      if (!publisherKeyId || publisherKeyId !== extension.publisherKeyId) {
        throw distributionError(
          'INVALID_REGISTRY',
          `${extension.id}.publisherKeyId 与 publisherKey 不一致`,
        );
      }
    }
    const keywords = extension.keywords === undefined ? undefined : extension.keywords;
    if (
      keywords !== undefined
      && (
        !Array.isArray(keywords)
        || keywords.length > 12
        || keywords.some((keyword) => (
          typeof keyword !== 'string'
          || keyword.length < 1
          || keyword.length > 32
          || CONTROL_CHARACTER_PATTERN.test(keyword)
        ))
        || new Set(keywords).size !== keywords.length
      )
    ) {
      throw distributionError('INVALID_REGISTRY', `${extension.id}.keywords 无效`);
    }
    const seenVersions = new Set();
    const versions = extension.versions.map((entry, versionIndex) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw distributionError('INVALID_REGISTRY', `${extension.id}.versions[${versionIndex}] 必须是对象`);
      }
      for (const key of Object.keys(entry)) {
        if (!VERSION_METADATA_KEYS.has(key)) {
          throw distributionError(
            'INVALID_REGISTRY',
            `${extension.id}.versions[${versionIndex}] 包含未知字段：${key}`,
          );
        }
      }
      let version;
      try {
        version = parseSemver(entry.version).raw;
      } catch (error) {
        throw distributionError('INVALID_REGISTRY', `${extension.id} 包含无效版本：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!isValidSemverRange(entry.piStudio)) {
        throw distributionError('INVALID_REGISTRY', `${extension.id}@${version} 的 piStudio 范围无效`);
      }
      let download;
      try {
        download = new URL(entry.download);
      } catch {
        throw distributionError('INVALID_REGISTRY', `${extension.id}@${version} 的 download 不是 URL`);
      }
      if (download.protocol !== 'https:' || download.username || download.password) {
        throw distributionError('INVALID_REGISTRY', `${extension.id}@${version} 的 download 必须是 HTTPS URL`);
      }
      if (seenVersions.has(version)) {
        throw distributionError('INVALID_REGISTRY', `${extension.id} 版本重复：${version}`);
      }
      seenVersions.add(version);
      if (
        entry.size !== undefined
        && (
          !Number.isSafeInteger(entry.size)
          || entry.size < 1
          || entry.size > DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes
        )
      ) {
        throw distributionError('INVALID_REGISTRY', `${extension.id}@${version} 的 size 无效`);
      }
      if (entry.deprecated !== undefined && typeof entry.deprecated !== 'boolean') {
        throw distributionError('INVALID_REGISTRY', `${extension.id}@${version} 的 deprecated 必须是布尔值`);
      }
      const permissions = entry.permissions === undefined ? [] : entry.permissions;
      if (!Array.isArray(permissions) || permissions.some((permission) => !VALID_PERMISSIONS.has(permission))) {
        throw distributionError('INVALID_REGISTRY', `${extension.id}@${version} 包含无效 permissions`);
      }
      const requires = entry.requires === undefined ? [] : entry.requires;
      if (!Array.isArray(requires) || requires.some((requirement) => !EXTENSION_REFERENCE_PATTERN.test(requirement))) {
        throw distributionError('INVALID_REGISTRY', `${extension.id}@${version} 包含无效 requires`);
      }
      const publishedAt = normalizeDateTime(
        entry.publishedAt,
        `${extension.id}@${version} publishedAt`,
      );
      let minimumPiStudio;
      if (entry.minimumPiStudio !== undefined) {
        try {
          minimumPiStudio = parseSemver(entry.minimumPiStudio).raw;
        } catch {
          throw distributionError(
            'INVALID_REGISTRY',
            `${extension.id}@${version} 的 minimumPiStudio 必须是有效版本`,
          );
        }
      }
      return {
        version,
        piStudio: entry.piStudio || '*',
        download: download.toString(),
        sha256: normalizeSha256(entry.sha256, `${extension.id}@${version} sha256`),
        ...(entry.size !== undefined ? { size: entry.size } : {}),
        permissions: [...new Set(permissions)],
        requires: [...new Set(requires)],
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        ...(entry.deprecated !== undefined ? { deprecated: entry.deprecated } : {}),
        ...(entry.minimumPiStudio !== undefined
          ? { minimumPiStudio }
          : {}),
      };
    });
    return {
      id: extension.id,
      name,
      publisher,
      ...(extension.summary !== undefined
        ? { summary: normalizeMetadataText(extension.summary, `${extension.id}.summary`, 1_200) }
        : {}),
      ...(extension.repository !== undefined
        ? { repository: normalizeHttpsMetadataUrl(extension.repository, `${extension.id}.repository`) }
        : {}),
      ...(extension.homepage !== undefined
        ? { homepage: normalizeHttpsMetadataUrl(extension.homepage, `${extension.id}.homepage`) }
        : {}),
      ...(extension.icon !== undefined
        ? { icon: normalizeHttpsMetadataUrl(extension.icon, `${extension.id}.icon`) }
        : {}),
      ...(keywords !== undefined ? { keywords: [...keywords] } : {}),
      ...(publisherKey ? { publisherKey, publisherKeyId } : {}),
      versions,
    };
  });
  return {
    ...(raw.$schema !== undefined ? { $schema: raw.$schema } : {}),
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    ...(registryName !== undefined ? { name: registryName } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    extensions,
  };
}

function selectRegistryVersion(registry, extensionId, requestedVersion, appVersion, options = {}) {
  const extension = registry.extensions.find((item) => item.id === extensionId);
  if (!extension) throw distributionError('REGISTRY_NOT_FOUND', `registry 中没有扩展：${extensionId}`);
  if (requestedVersion) {
    const entry = extension.versions.find((item) => item.version === requestedVersion);
    if (!entry) throw distributionError('REGISTRY_VERSION_NOT_FOUND', `registry 中没有 ${extensionId}@${requestedVersion}`);
    if (!satisfiesSemver(appVersion, entry.piStudio)) {
      throw distributionError(
        'INCOMPATIBLE_PI_STUDIO',
        `${extensionId}@${requestedVersion} 要求 Pi Studio ${entry.piStudio}，当前为 ${appVersion}`,
      );
    }
    return entry;
  }
  const candidates = extension.versions
    .filter((entry) => !entry.deprecated && satisfiesSemver(appVersion, entry.piStudio))
    .filter((entry) => options.allowPrerelease || parseSemver(entry.version).prerelease.length === 0)
    .sort((left, right) => compareSemver(right.version, left.version));
  if (candidates.length === 0) {
    throw distributionError('NO_COMPATIBLE_VERSION', `没有兼容 Pi Studio ${appVersion} 的 ${extensionId} 版本`);
  }
  return candidates[0];
}

class ExtensionDistributionService {
  constructor(options = {}) {
    if (typeof options.userDataPath !== 'string' || !options.userDataPath) {
      throw new Error('ExtensionDistributionService 需要 userDataPath');
    }
    this.userDataPath = path.resolve(options.userDataPath);
    ensurePrivateDirectory(this.userDataPath);
    this.userDataPath = fs.realpathSync(this.userDataPath);
    this.appVersion = options.appVersion || '0.0.0';
    parseSemver(this.appVersion);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('当前运行时不支持 fetch');
    this.registryUrl = options.registryUrl;
    this.officialRoot = typeof options.officialRoot === 'string' && options.officialRoot
      ? path.resolve(options.officialRoot)
      : undefined;
    this.githubApiBase = (options.githubApiBase || 'https://api.github.com').replace(/\/$/, '');
    this.githubToken = typeof options.githubToken === 'string' ? options.githubToken : undefined;
    this.allowInsecureLocalhost = options.allowInsecureLocalhost === true;
    this.requestTimeoutMs = options.requestTimeoutMs || 30_000;
    this.now = options.now || Date.now;
    this.maxHistory = Number.isSafeInteger(options.maxHistory) && options.maxHistory > 1
      ? Math.min(options.maxHistory, 128)
      : 32;
    this.normalizeManifest = options.normalizeManifest;
    this.dependencyResolver = options.dependencyResolver;
    this.trustStore = options.trustStore || new ExtensionTrustStore({
      userDataPath: this.userDataPath,
    });
    this.limits = { ...DEFAULT_ARCHIVE_LIMITS, ...(options.limits || {}) };
    this.prepared = new Map();
    this.claimedPrepared = new Set();
    this.quarantineRoot = path.join(this.userDataPath, 'extension-cache', 'quarantine');
    this.stateRoot = path.join(this.userDataPath, 'extension-state');
    this.dataRoot = path.join(this.userDataPath, 'extension-data');
  }

  scopeKey(scope, cwd) {
    if (scope === 'user') return 'user';
    if (scope !== 'project') throw distributionError('INVALID_SCOPE', '扩展 scope 只能是 user 或 project');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw distributionError('INVALID_WORKSPACE', '项目扩展需要绝对 cwd');
    }
    const workspace = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
    return `project-${sha256(Buffer.from(workspace)).slice(0, 24)}`;
  }

  installTarget(scopeValue, cwdValue) {
    const scope = scopeValue === undefined ? 'user' : scopeValue;
    if (scope === 'user') {
      return { scope: 'user', cwd: undefined };
    }
    if (scope !== 'project') {
      throw distributionError('INVALID_SCOPE', '扩展 scope 只能是 user 或 project');
    }
    if (typeof cwdValue !== 'string' || !path.isAbsolute(cwdValue)) {
      throw distributionError('INVALID_WORKSPACE', '项目扩展需要绝对 cwd');
    }
    if (!fs.existsSync(cwdValue)) {
      throw distributionError('INVALID_WORKSPACE', '项目工作区不存在');
    }
    return { scope, cwd: fs.realpathSync(cwdValue) };
  }

  codeRoot(scope, cwd) {
    if (scope === 'user') return path.join(this.userDataPath, 'extensions');
    if (scope !== 'project') throw distributionError('INVALID_SCOPE', '扩展 scope 只能是 user 或 project');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw distributionError('INVALID_WORKSPACE', '项目扩展需要绝对 cwd');
    }
    const workspace = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
    return path.join(workspace, '.pi-studio', 'extensions');
  }

  stateDirectory(scope, cwd) {
    return ensureContainedDirectory(
      path.join(this.stateRoot, this.scopeKey(scope, cwd)),
      this.userDataPath,
    );
  }

  stateFile(scope, cwd, id) {
    assertSafeExtensionId(id);
    return path.join(this.stateDirectory(scope, cwd), `${id}.json`);
  }

  dataDirectory(scope, cwd, id) {
    assertSafeExtensionId(id);
    return ensureContainedDirectory(
      path.join(this.dataRoot, this.scopeKey(scope, cwd), id),
      this.userDataPath,
    );
  }

  /**
   * Forget host-owned state for a project workspace. Extension code under the
   * workspace itself is intentionally left on disk; removing the workspace
   * from Studio must not delete the user's project.
   */
  purgeProjectWorkspace(cwd) {
    const key = this.scopeKey('project', cwd);
    for (const root of [this.stateRoot, this.dataRoot]) {
      const target = path.join(root, key);
      assertManagedPathInside(root, target, '项目扩展状态');
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  async request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    let currentUrl = String(url);
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        this.assertSecureUrl(currentUrl, '请求地址');
        const response = await this.fetchImpl(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'User-Agent': `Pi-Studio/${this.appVersion} extension-installer`,
            ...(options.headers || {}),
          },
          signal,
        });
        if (![301, 302, 303, 307, 308].includes(response?.status)) return response;
        if (redirects === MAX_REDIRECTS) {
          throw distributionError('TOO_MANY_REDIRECTS', `请求重定向超过 ${MAX_REDIRECTS} 次：${url}`);
        }
        const location = response.headers?.get?.('location');
        if (!location) {
          throw distributionError('INVALID_REDIRECT', `请求返回了没有 Location 的重定向：${currentUrl}`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        this.assertSecureUrl(currentUrl, '重定向地址');
      }
      throw distributionError('TOO_MANY_REDIRECTS', `请求重定向超过 ${MAX_REDIRECTS} 次：${url}`);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw distributionError('NETWORK_TIMEOUT', `请求超时：${url}`);
      }
      if (error instanceof ExtensionDistributionError) throw error;
      throw distributionError('NETWORK_ERROR', `请求失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async readResponse(response, maximum, label) {
    if (!response || typeof response !== 'object') {
      throw distributionError('INVALID_RESPONSE', `${label} 没有返回有效响应`);
    }
    if (!response.ok) {
      throw distributionError('HTTP_ERROR', `${label} 请求失败：HTTP ${response.status || 'unknown'}`);
    }
    const finalUrl = response.url || '';
    if (finalUrl && /^http:/i.test(finalUrl) && !this.isAllowedInsecureUrl(finalUrl)) {
      throw distributionError('INSECURE_REDIRECT', `${label} 被重定向到非 HTTPS 地址`);
    }
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maximum) {
      throw distributionError('RESPONSE_TOO_LARGE', `${label} 超过 ${maximum} 字节上限`);
    }
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maximum) {
          try { await reader.cancel(); } catch { /* ignore cancellation failure */ }
          throw distributionError('RESPONSE_TOO_LARGE', `${label} 超过 ${maximum} 字节上限`);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    if (typeof response.arrayBuffer === 'function') {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maximum) {
        throw distributionError('RESPONSE_TOO_LARGE', `${label} 超过 ${maximum} 字节上限`);
      }
      return buffer;
    }
    throw distributionError('INVALID_RESPONSE', `${label} 响应正文不可读取`);
  }

  isAllowedInsecureUrl(value) {
    if (!this.allowInsecureLocalhost) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:'
        && ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname);
    } catch {
      return false;
    }
  }

  assertSecureUrl(value, label = 'URL') {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw distributionError('INVALID_URL', `${label} 不是有效 URL`);
    }
    if (parsed.username || parsed.password) {
      throw distributionError('INVALID_URL', `${label} 不能包含用户名或密码`);
    }
    if (parsed.protocol !== 'https:' && !this.isAllowedInsecureUrl(parsed.toString())) {
      throw distributionError('INSECURE_URL', `${label} 必须使用 HTTPS`);
    }
    return parsed;
  }

  async fetchJson(url, label, headers = {}) {
    const response = await this.request(url, { headers });
    const body = await this.readResponse(response, MAX_GITHUB_JSON_BYTES, label);
    try {
      const value = JSON.parse(body.toString('utf8'));
      if (!value || typeof value !== 'object') throw new Error('不是对象');
      return value;
    } catch (error) {
      throw distributionError('INVALID_JSON', `${label} 返回了无效 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async loadRegistry(location, options = {}) {
    const registryLocation = location || this.registryUrl;
    if (!registryLocation) throw distributionError('REGISTRY_REQUIRED', '未配置扩展 registry URL');
    let raw;
    if (fs.existsSync(registryLocation)) {
      raw = readJsonFile(registryLocation, '扩展 registry');
    } else {
      const parsed = this.assertSecureUrl(registryLocation, 'registry URL');
      raw = await this.fetchJson(parsed.toString(), '扩展 registry');
    }
    return validateRegistry(raw);
  }

  parseGithubSource(source) {
    const match = /^github:([^/@]+)\/([^@]+)@(.+)$/.exec(source);
    if (!match || !SAFE_GITHUB_PART.test(match[1]) || !SAFE_GITHUB_PART.test(match[2]) || !SAFE_GITHUB_REF.test(match[3])) {
      throw distributionError(
        'INVALID_GITHUB_SOURCE',
        'GitHub 来源格式必须为 github:owner/repo@latest、tag 或 commit',
      );
    }
    return { owner: match[1], repo: match[2], ref: match[3] };
  }

  githubHeaders() {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.githubToken) headers.Authorization = `Bearer ${this.githubToken}`;
    return headers;
  }

  async resolveGithubCommit(owner, repo, ref) {
    const response = await this.request(
      `${this.githubApiBase}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
      { headers: this.githubHeaders() },
    );
    const body = await this.readResponse(response, MAX_GITHUB_JSON_BYTES, 'GitHub commit');
    let value;
    try { value = JSON.parse(body.toString('utf8')); } catch {
      throw distributionError('INVALID_GITHUB_RESPONSE', 'GitHub commit 返回了无效 JSON');
    }
    const commit = typeof value.sha === 'string' ? value.sha.toLowerCase() : '';
    if (!COMMIT_PATTERN.test(commit)) {
      throw distributionError('INVALID_GITHUB_RESPONSE', 'GitHub commit 没有返回固定 commit SHA');
    }
    return commit;
  }

  async resolveGithub(source, options = {}) {
    const { owner, repo, ref } = this.parseGithubSource(source);
    let release;
    try {
      release = await this.fetchJson(
        ref === 'latest'
          ? `${this.githubApiBase}/repos/${owner}/${repo}/releases/latest`
          : `${this.githubApiBase}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(ref)}`,
        ref === 'latest' ? 'GitHub latest Release' : 'GitHub Release',
        this.githubHeaders(),
      );
    } catch (error) {
      if (!/HTTP 404/.test(error?.message || '')) throw error;
    }
    if (release) {
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const archives = assets.filter((asset) => (
        typeof asset?.name === 'string'
        && /\.pi-extension\.zip$/i.test(asset.name)
        && typeof asset.browser_download_url === 'string'
      ));
      if (archives.length !== 1) {
        throw distributionError(
          'INVALID_GITHUB_RELEASE',
          `GitHub Release ${ref} 必须发布且只发布一个 .pi-extension.zip`,
        );
      }
      const archive = archives[0];
      let expectedSha256 = /^sha256:([a-f0-9]{64})$/i.exec(archive.digest || '')?.[1]?.toLowerCase();
      const checksumAssets = assets.filter((asset) => (
        typeof asset?.name === 'string'
        && /^(?:sha256sums|checksums)(?:\.txt)?$/i.test(asset.name)
        && typeof asset.browser_download_url === 'string'
      ));
      if (!expectedSha256 && checksumAssets.length > 0) {
        for (const checksumAsset of checksumAssets) {
          const response = await this.request(checksumAsset.browser_download_url);
          const body = await this.readResponse(response, MAX_CHECKSUM_BYTES, 'GitHub checksums');
          const hash = parseChecksumFile(body.toString('utf8'), archive.name);
          if (hash) {
            expectedSha256 = hash;
            break;
          }
        }
      }
      if (!expectedSha256) {
        throw distributionError(
          'MISSING_REMOTE_INTEGRITY',
          `GitHub Release ${ref} 的扩展包缺少 SHA-256 digest 或 checksums 文件`,
        );
      }
      return {
        kind: 'github-release',
        uri: archive.browser_download_url,
        resolvedRef: release.tag_name || ref,
        stableSource: source,
        expectedSha256,
        needsDownload: true,
        requireIntegrity: true,
        publisher: release.author?.login || owner,
      };
    }

    if (ref === 'latest') {
      throw distributionError(
        'INVALID_GITHUB_RELEASE',
        `GitHub 仓库 ${owner}/${repo} 没有可用的 latest Release`,
      );
    }
    const commit = COMMIT_PATTERN.test(ref)
      ? ref
      : await this.resolveGithubCommit(owner, repo, ref);
    return {
      kind: 'github-commit',
      uri: `https://codeload.github.com/${owner}/${repo}/zip/${commit}`,
      resolvedRef: commit,
      stableSource: source,
      needsDownload: true,
      requireIntegrity: false,
      publisher: owner,
    };
  }

  async resolveRegistry(source, options = {}) {
    const match = /^registry:([a-z0-9][a-z0-9._-]{1,63})(?:@(.+))?$/.exec(source);
    if (!match) throw distributionError('INVALID_REGISTRY_SOURCE', 'registry 来源格式必须为 registry:id@version');
    const registry = await this.loadRegistry(options.registryUrl, options);
    const requestedVersion = match[2] ? parseSemver(match[2]).raw : undefined;
    const entry = selectRegistryVersion(
      registry,
      match[1],
      requestedVersion,
      this.appVersion,
      options,
    );
    return {
      kind: 'registry',
      uri: entry.download,
      resolvedRef: `${match[1]}@${entry.version}`,
      stableSource: `registry:${match[1]}`,
      expectedSha256: entry.sha256,
      expectedSize: entry.size,
      needsDownload: true,
      requireIntegrity: true,
      publisher: registry.extensions.find((item) => item.id === match[1])?.publisher,
      publisherKey: registry.extensions.find((item) => item.id === match[1])?.publisherKey,
      publisherKeyId: registry.extensions.find((item) => item.id === match[1])?.publisherKeyId,
    };
  }

  resolveOfficial(source) {
    const match = /^official:([a-z0-9][a-z0-9._-]{1,63})$/.exec(source);
    if (!match) {
      throw distributionError('INVALID_OFFICIAL_SOURCE', '官方扩展来源格式必须为 official:id');
    }
    if (!this.officialRoot) {
      throw distributionError('OFFICIAL_CATALOG_UNAVAILABLE', '当前构建没有提供官方扩展目录');
    }
    const id = assertSafeExtensionId(match[1]);
    const directory = path.join(this.officialRoot, id);
    if (!pathExists(directory) || !fs.lstatSync(directory).isDirectory()) {
      throw distributionError('OFFICIAL_EXTENSION_NOT_FOUND', `官方扩展目录中不存在：${id}`);
    }
    const realRoot = fs.realpathSync(this.officialRoot);
    const realDirectory = fs.realpathSync(directory);
    if (!isPathInside(realRoot, realDirectory)) {
      throw distributionError('UNSAFE_MANAGED_PATH', '官方扩展目录越过了应用资源边界');
    }
    return {
      id,
      directory: realDirectory,
      stableSource: source,
    };
  }

  directHttpsSource(source, options) {
    const parsed = this.assertSecureUrl(source, '扩展下载 URL');
    const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const fragmentHash = fragment.get('sha256');
    const expected = options.expectedSha256 || fragmentHash;
    if (!expected) {
      throw distributionError(
        'MISSING_REMOTE_INTEGRITY',
        'HTTPS 扩展 URL 必须通过 expectedSha256 或 #sha256=<digest> 提供外部摘要',
      );
    }
    if (options.expectedSha256 && fragmentHash
      && normalizeSha256(options.expectedSha256) !== normalizeSha256(fragmentHash)) {
      throw distributionError('INVALID_INTEGRITY', 'URL 与 expectedSha256 给出了不同的摘要');
    }
    parsed.hash = '';
    return {
      kind: 'https',
      uri: parsed.toString(),
      resolvedRef: parsed.toString(),
      stableSource: source,
      expectedSha256: normalizeSha256(expected),
      needsDownload: true,
      requireIntegrity: true,
    };
  }

  async downloadSource(source, options = {}) {
    const response = await this.request(source.uri, { signal: options.signal });
    const archive = await this.readResponse(response, this.limits.maxArchiveBytes, '扩展包');
    if (source.expectedSize !== undefined && archive.length !== source.expectedSize) {
      throw distributionError(
        'INTEGRITY_MISMATCH',
        `扩展包长度不一致：期望 ${source.expectedSize}，实际 ${archive.length}`,
      );
    }
    const digest = sha256(archive);
    if (source.expectedSha256 && digest !== source.expectedSha256) {
      throw distributionError(
        'INTEGRITY_MISMATCH',
        `扩展包 SHA-256 不一致：期望 ${source.expectedSha256}，实际 ${digest}`,
      );
    }
    return { archive, digest };
  }

  copyDirectoryToQuarantine(sourceDirectory, destination, scope = 'user') {
    const validated = validateExtensionDirectory(sourceDirectory, {
      scope,
      integrity: 'ignore',
      requirePublisher: false,
      normalizeManifest: this.normalizeManifest,
      limits: this.limits,
    });
    ensurePrivateDirectory(destination);
    for (const file of validated.files) {
      const target = path.join(destination, ...file.path.split('/'));
      ensurePrivateDirectory(path.dirname(target));
      fs.copyFileSync(file.absolute, target, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
    }
    return validated;
  }

  writeGeneratedIntegrity(directory) {
    const files = walkPackageFiles(directory, { limits: this.limits });
    const integrity = integrityFromFiles(directory, files);
    atomicWriteJson(path.join(directory, INTEGRITY_NAME), integrity);
    return integrity;
  }

  checkCompatibility(manifest) {
    const range = manifest.engines?.piStudio;
    if (range && !satisfiesSemver(this.appVersion, range)) {
      throw distributionError(
        'INCOMPATIBLE_PI_STUDIO',
        `${manifest.name} ${manifest.version} 要求 Pi Studio ${range}，当前为 ${this.appVersion}`,
      );
    }
  }

  inspectSignature(directory, scope, resolved) {
    const result = verifyExtensionDirectory(directory, {
      scope,
      normalizeManifest: this.normalizeManifest,
      expectedPublicKey: resolved.publisherKey,
      expectedPublisher: resolved.publisherKey ? resolved.publisher : undefined,
      required: Boolean(resolved.publisherKey),
    });
    if (result.status === 'unsigned') {
      return {
        status: 'unsigned',
        identityTrusted: false,
        requiresTrust: false,
        verification: result,
      };
    }
    const signature = result.signature;
    const trustedKey = this.trustStore.lookup(signature.publisher, signature.keyId);
    if (trustedKey?.status === 'revoked') {
      throw distributionError(
        'REVOKED_PUBLISHER_KEY',
        `发布者 ${signature.publisher} 的公钥已被本机撤销：${signature.keyId}`,
        {
          publisher: signature.publisher,
          keyId: signature.keyId,
        },
      );
    }
    const identityTrusted = trustedKey?.status === 'trusted';
    return {
      status: identityTrusted ? 'trusted' : 'valid',
      publisher: signature.publisher,
      keyId: signature.keyId,
      publicKey: signature.publicKey,
      identityTrusted,
      requiresTrust: !identityTrusted,
      verification: result,
    };
  }

  assertPreparedPublisherTrust(prepared, options = {}) {
    const signature = prepared.signature;
    if (!signature || signature.status === 'unsigned') return signature;
    const checked = this.inspectSignature(
      prepared.packageDirectory,
      prepared.validated.manifest.scope || prepared.target.scope,
      prepared.archiveSource,
    );
    if (checked.status === 'unsigned') {
      throw distributionError(
        'SIGNATURE_CHANGED',
        '扩展包在安装预览后丢失了发布者签名，请重新校验来源',
      );
    }
    if (checked.keyId !== signature.keyId || checked.publisher !== signature.publisher) {
      throw distributionError(
        'SIGNATURE_CHANGED',
        '扩展包在安装预览后更换了发布者签名，请重新校验来源',
      );
    }
    if (checked.requiresTrust) {
      if (options.acceptedPublisherKey !== true) {
        throw distributionError(
          'PUBLISHER_TRUST_REQUIRED',
          `请先确认发布者公钥指纹：${checked.keyId}`,
          {
            publisher: checked.publisher,
            keyId: checked.keyId,
          },
        );
      }
      this.trustStore.trust({
        publisher: checked.publisher,
        publicKey: checked.publicKey,
        keyId: checked.keyId,
        source: prepared.summary.source,
      });
    }
    return {
      ...signature,
      status: 'trusted',
      identityTrusted: true,
      requiresTrust: false,
    };
  }

  permissionDiff(previousPermissions, nextPermissions) {
    const previous = new Set(previousPermissions || []);
    return [...new Set(nextPermissions || [])].filter((permission) => !previous.has(permission));
  }

  stringListDiff(previousValues, nextValues) {
    const previous = new Set(previousValues || []);
    return [...new Set(nextValues || [])].filter((value) => !previous.has(value));
  }

  capabilityChanges(previousManifest, nextManifest) {
    const previous = previousManifest || {};
    const next = nextManifest || {};
    return {
      addedPermissions: this.permissionDiff(previous.permissions, next.permissions),
      addedProviderAccess: this.stringListDiff(previous.providerAccess, next.providerAccess),
      addedRequirements: this.stringListDiff(previous.requires, next.requires),
      executableExpansion: Boolean(
        previousManifest
        && !previous.runtime?.durableEntry
        && next.runtime?.durableEntry
      ),
    };
  }

  validateInstalledManifest(installed, scope) {
    if (!installed) return undefined;
    return validateExtensionDirectory(installed.activeCodePath, {
      scope,
      integrity: 'required',
      requirePublisher: true,
      normalizeManifest: this.normalizeManifest,
      limits: this.limits,
    }).manifest;
  }

  /**
   * Read only the capability fields needed to authorize an upgrade.
   *
   * An extension installed by an older Studio may no longer satisfy the current
   * manifest schema. That must not prevent a newer, fully validated package
   * from repairing it. In that case verify the old package and integrity, then
   * read the capability fields from its raw manifest. If even that fails, use
   * the metadata recorded at install time and force a conservative consent
   * check for fields the metadata cannot prove.
   */
  installedCapabilityBaseline(installed, scope) {
    if (!installed) return { manifest: undefined, complete: true };
    try {
      return {
        manifest: this.validateInstalledManifest(installed, scope),
        complete: true,
      };
    } catch {
      try {
        const legacy = validateExtensionDirectory(installed.activeCodePath, {
          scope,
          integrity: 'required',
          requirePublisher: false,
          normalizeManifest(raw) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
              throw new Error('扩展 manifest 必须是对象');
            }
            return raw;
          },
          limits: this.limits,
        });
        if (legacy.treeSha256 !== installed.sha256) {
          throw new Error('旧版扩展内容与安装校验值不一致');
        }
        if (
          legacy.raw.id !== installed.id
          || legacy.raw.version !== installed.version
        ) {
          throw new Error('旧版扩展 manifest 与安装状态不一致');
        }
        return {
          manifest: {
            permissions: legacy.raw.permissions,
            providerAccess: legacy.raw.providerAccess,
            requires: legacy.raw.requires,
            runtime: legacy.raw.runtime,
          },
          complete: true,
        };
      } catch {
        return {
          manifest: {
            permissions: installed.permissions,
            providerAccess: installed.providerAccess,
            requires: installed.requires,
            runtime: installed.runtime,
          },
          complete: false,
        };
      }
    }
  }

  capabilityChangesFromInstalled(installed, scope, nextManifest) {
    const baseline = this.installedCapabilityBaseline(installed, scope);
    const changes = this.capabilityChanges(baseline.manifest, nextManifest);
    if (!baseline.complete) {
      changes.addedProviderAccess = [...new Set(nextManifest.providerAccess || [])];
      changes.executableExpansion = Boolean(nextManifest.runtime?.durableEntry);
    }
    return changes;
  }

  getInstalledCapabilityManifest(id, scope = 'user', cwd = undefined) {
    return this.installedCapabilityBaseline(
      this.getInstalled(id, scope, cwd),
      scope,
    ).manifest;
  }

  dependencyInstalled(requirement, scope, cwd) {
    const separator = requirement.indexOf(':');
    const dependencyScope = requirement.slice(0, separator);
    const dependencyId = requirement.slice(separator + 1);
    if (dependencyScope === 'builtin') {
      return typeof this.dependencyResolver === 'function'
        && this.dependencyResolver(requirement) === true;
    }
    if (dependencyScope === 'user') return Boolean(this.getInstalled(dependencyId, 'user'));
    if (dependencyScope === 'project' && scope === 'project') {
      return Boolean(this.getInstalled(dependencyId, 'project', cwd));
    }
    return false;
  }

  dependencyState(manifest, scope, cwd) {
    const requirements = manifest.requires || [];
    const missing = requirements.filter((requirement) => !this.dependencyInstalled(requirement, scope, cwd));
    const nodes = new Map();
    const readNode = (requirement) => {
      const separator = requirement.indexOf(':');
      const dependencyScope = requirement.slice(0, separator);
      const dependencyId = requirement.slice(separator + 1);
      if (dependencyScope === 'builtin') return { requires: [] };
      const installed = dependencyScope === 'project'
        ? this.getInstalled(dependencyId, 'project', cwd)
        : this.getInstalled(dependencyId, 'user');
      return installed ? { requires: installed.requires || [] } : undefined;
    };
    nodes.set(`${scope}:${manifest.id}`, { requires: requirements });
    for (const requirement of requirements) {
      if (nodes.has(requirement)) continue;
      const node = readNode(requirement);
      if (node) nodes.set(requirement, node);
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (id, stack) => {
      if (visiting.has(id)) {
        const cycle = [...stack, id];
        throw distributionError(
          'DEPENDENCY_CYCLE',
          `扩展依赖形成循环：${cycle.join(' → ')}`,
          { cycle },
        );
      }
      if (visited.has(id)) return;
      visiting.add(id);
      if (!nodes.has(id)) {
        const loaded = readNode(id);
        if (loaded) nodes.set(id, loaded);
      }
      const node = nodes.get(id);
      for (const requirement of node?.requires || []) {
        if (nodes.has(requirement)) visit(requirement, [...stack, id]);
      }
      visiting.delete(id);
      visited.add(id);
    };
    visit(`${scope}:${manifest.id}`, []);
    return {
      requires: requirements,
      missing,
    };
  }

  async prepare(source, options = {}) {
    await this.prunePrepared();
    if (typeof source !== 'string' || !source.trim()) {
      throw distributionError('INVALID_SOURCE', '扩展来源不能为空');
    }
    const target = this.installTarget(options.scope, options.cwd);
    const { scope, cwd } = target;
    const token = crypto.randomUUID();
    const quarantine = path.join(this.quarantineRoot, token);
    const packageDirectory = path.join(quarantine, 'package');
    let resolved;
    let sourceDigest;
    let sourceKind;
    try {
      ensureContainedDirectory(quarantine, this.userDataPath);
      ensureContainedDirectory(packageDirectory, this.userDataPath);
      if (source.startsWith('official:')) {
        if (scope !== 'user') {
          throw distributionError(
            'OFFICIAL_USER_SCOPE_REQUIRED',
            'Pi Studio 官方目录扩展只能安装到全局范围',
          );
        }
        sourceKind = 'official';
        const official = this.resolveOfficial(source);
        this.copyDirectoryToQuarantine(official.directory, packageDirectory, scope);
        this.writeGeneratedIntegrity(packageDirectory);
        resolved = {
          kind: 'official',
          uri: `official:${official.id}`,
          resolvedRef: `official:${official.id}`,
          stableSource: `official:${official.id}`,
          requireIntegrity: true,
          publisher: 'Pi Studio',
        };
      } else if (source.startsWith('github:')) {
        resolved = await this.resolveGithub(source, options);
      } else if (source.startsWith('registry:')) {
        resolved = await this.resolveRegistry(source, options);
      } else if (/^https:\/\//i.test(source) || /^http:\/\//i.test(source)) {
        resolved = this.directHttpsSource(source, options);
      } else {
        const local = path.resolve(source.replace(/^~(?=$|\/)/, os.homedir()));
        if (!pathExists(local)) throw distributionError('SOURCE_NOT_FOUND', `扩展来源不存在：${local}`);
        const stat = fs.lstatSync(local);
        if (stat.isSymbolicLink()) throw distributionError('SYMLINK_NOT_ALLOWED', '扩展来源不能是符号链接');
        if (stat.isDirectory()) {
          sourceKind = 'local-directory';
          this.copyDirectoryToQuarantine(local, packageDirectory, scope);
          this.writeGeneratedIntegrity(packageDirectory);
          resolved = {
            kind: sourceKind,
            uri: null,
            resolvedRef: null,
            stableSource: local,
            requireIntegrity: true,
            publisher: undefined,
          };
        } else if (stat.isFile()) {
          sourceKind = 'archive';
          fileSizeWithin(local, this.limits.maxArchiveBytes);
          const archive = fs.readFileSync(local);
          sourceDigest = sha256(archive);
          if (options.expectedSha256 && sourceDigest !== normalizeSha256(options.expectedSha256)) {
            throw distributionError('INTEGRITY_MISMATCH', '本地扩展包 SHA-256 不一致');
          }
          extractZipArchive(archive, packageDirectory, { limits: this.limits });
          resolved = {
            kind: sourceKind,
            uri: local,
            resolvedRef: null,
            stableSource: local,
            needsDownload: false,
            requireIntegrity: true,
            publisher: undefined,
          };
        } else {
          throw distributionError('INVALID_SOURCE', '扩展来源必须是目录或 .pi-extension.zip');
        }
      }

      if (resolved.needsDownload) {
        sourceKind = resolved.kind;
        const downloaded = await this.downloadSource(resolved, options);
        sourceDigest = downloaded.digest;
        extractZipArchive(downloaded.archive, packageDirectory, { limits: this.limits });
      }

      if (resolved.requireIntegrity === false) this.writeGeneratedIntegrity(packageDirectory);
      const validated = validateExtensionDirectory(packageDirectory, {
        scope,
        integrity: 'required',
        requirePublisher: true,
        normalizeManifest: this.normalizeManifest,
        limits: this.limits,
      });
      this.checkCompatibility(validated.manifest);
      if (
        resolved.kind === 'registry'
        && resolved.publisher
        && validated.manifest.publisher
        && resolved.publisher.toLocaleLowerCase('en-US')
          !== validated.manifest.publisher.toLocaleLowerCase('en-US')
      ) {
        throw distributionError(
          'PUBLISHER_MISMATCH',
          `registry publisher 与扩展 manifest publisher 不一致：${resolved.publisher} / ${validated.manifest.publisher}`,
        );
      }
      const signature = this.inspectSignature(packageDirectory, scope, resolved);
      const existing = this.getInstalled(validated.manifest.id, scope, cwd);
      if (resolved.kind === 'official' && existing && existing.sourceKind !== 'official') {
        throw distributionError(
          'OFFICIAL_SOURCE_CONFLICT',
          `扩展 ${validated.manifest.id} 已由 ${existing.sourceKind} 来源安装；请先卸载该版本，再安装官方目录版本`,
        );
      }
      if (
        existing
        && !options.allowDowngrade
        && compareSemver(validated.manifest.version, existing.version) < 0
      ) {
        throw distributionError(
          'VERSION_DOWNGRADE',
          `不允许从 ${existing.version} 降级安装 ${validated.manifest.version}；如需降级请使用回滚`,
        );
      }
      if (
        existing?.version === validated.manifest.version
        && existing.sha256 !== validated.treeSha256
      ) {
        throw distributionError(
          'VERSION_COLLISION',
          `${validated.manifest.id}@${validated.manifest.version} 已安装但内容不同；请提升扩展版本号`,
        );
      }
      const dependencies = this.dependencyState(validated.manifest, scope, cwd);
      const changes = this.capabilityChangesFromInstalled(
        existing,
        scope,
        validated.manifest,
      );
      const integrity = readIntegrity(packageDirectory);
      const prepared = {
        token,
        target,
        packageDirectory,
        archiveSource: resolved,
        sourceDigest: sourceDigest || validated.treeSha256,
        sourceKind,
        validated,
        existing,
        createdAt: this.now(),
        expiresAt: this.now() + PREPARED_TTL_MS,
        summary: {
          token,
          scope,
          id: validated.manifest.id,
          name: validated.manifest.name,
          version: validated.manifest.version,
          publisher: validated.manifest.publisher,
          description: validated.manifest.description,
          permissions: validated.manifest.permissions,
          providerAccess: validated.manifest.providerAccess,
          requires: validated.manifest.requires,
          addedRequirements: changes.addedRequirements,
          missingDependencies: dependencies.missing,
          addedPermissions: changes.addedPermissions,
          addedProviderAccess: changes.addedProviderAccess,
          executable: Boolean(validated.manifest.runtime?.durableEntry),
          executableExpansion: changes.executableExpansion,
          sourceKind,
          source: resolved.stableSource || resolved.uri || source,
          resolvedRef: resolved.resolvedRef || null,
          archiveSha256: sourceDigest || null,
          treeSha256: validated.treeSha256,
          integrityFileSha256: sha256(
            Buffer.from(`${JSON.stringify(integrity, null, 2)}\n`),
          ),
          signatureStatus: signature.status,
          signaturePublisher: signature.publisher,
          signatureKeyId: signature.keyId,
          publisherTrust: signature.status === 'unsigned'
            ? 'not-applicable'
            : signature.identityTrusted
              ? 'trusted'
              : 'untrusted',
          requiresPublisherTrust: signature.requiresTrust,
          upgrade: Boolean(
            existing
            && compareSemver(validated.manifest.version, existing.version) > 0
          ),
          alreadyInstalled: Boolean(
            existing?.version === validated.manifest.version
            && existing.sha256 === validated.treeSha256
          ),
          installedVersion: existing?.version,
          requiresPermissionConsent: changes.addedPermissions.length > 0,
          requiresCapabilityConsent: changes.addedPermissions.length > 0
            || changes.addedProviderAccess.length > 0
            || changes.addedRequirements.length > 0
            || changes.executableExpansion
            || signature.requiresTrust,
        },
        signature,
      };
      this.prepared.set(token, prepared);
      return structuredClone(prepared.summary);
    } catch (error) {
      fs.rmSync(quarantine, { recursive: true, force: true });
      throw error;
    }
  }

  disposePrepared(token, options = {}) {
    const prepared = this.prepared.get(token);
    if (prepared) {
      if (this.claimedPrepared.has(token) && options.allowClaimed !== true) {
        return false;
      }
      fs.rmSync(path.dirname(prepared.packageDirectory), { recursive: true, force: true });
      this.prepared.delete(token);
    }
    if (options.allowClaimed === true || !prepared) this.claimedPrepared.delete(token);
    return true;
  }

  takePrepared(token) {
    const prepared = this.prepared.get(token);
    if (!prepared) throw distributionError('PREPARED_NOT_FOUND', '扩展安装预览已失效，请重新选择来源');
    if (prepared.expiresAt < this.now()) {
      this.disposePrepared(token);
      throw distributionError('PREPARED_EXPIRED', '扩展安装预览已过期，请重新选择来源');
    }
    if (this.claimedPrepared.has(token)) {
      throw distributionError('PREPARED_CLAIMED', '扩展安装预览正在被另一个安装操作使用');
    }
    this.claimedPrepared.add(token);
    return prepared;
  }

  assertPermissionConsent(permissions, acceptedPermissions) {
    const accepted = new Set(Array.isArray(acceptedPermissions) ? acceptedPermissions : []);
    const missing = permissions.filter((permission) => !accepted.has(permission));
    if (missing.length > 0) {
      throw distributionError(
        'PERMISSION_CONSENT_REQUIRED',
        `扩展新增权限需要确认：${missing.join(', ')}`,
        { permissions: missing },
      );
    }
  }

  assertCapabilityConsent(changes, options = {}) {
    if ((changes.addedRequirements || []).length > 0 && options.acceptedRequirements !== true) {
      throw distributionError(
        'REQUIREMENTS_CONSENT_REQUIRED',
        `扩展新增依赖需要确认：${changes.addedRequirements.join(', ')}`,
        { requirements: changes.addedRequirements },
      );
    }
    const acceptedProviderAccess = new Set(
      Array.isArray(options.acceptedProviderAccess) ? options.acceptedProviderAccess : [],
    );
    const missingProviderAccess = (changes.addedProviderAccess || [])
      .filter((providerId) => !acceptedProviderAccess.has(providerId));
    if (missingProviderAccess.length > 0) {
      throw distributionError(
        'PROVIDER_ACCESS_CONSENT_REQUIRED',
        `扩展新增模型来源凭证访问需要确认：${missingProviderAccess.join(', ')}`,
        { providerAccess: missingProviderAccess },
      );
    }
    if (changes.executableExpansion && options.acceptedExecution !== true) {
      throw distributionError(
        'EXECUTION_CONSENT_REQUIRED',
        '扩展将从纯声明式 UI 变为可执行 Agent 代码，需要重新确认',
      );
    }
  }

  readState(scope, cwd, id) {
    const raw = readJsonFile(this.stateFile(scope, cwd, id), '扩展安装状态');
    if (!raw) return undefined;
    if (raw.schemaVersion !== INSTALL_STATE_VERSION || raw.id !== id || raw.scope !== scope) {
      throw distributionError('INVALID_INSTALL_STATE', `扩展安装状态损坏：${id}`);
    }
    return raw;
  }

  hydrateState(state, scope = 'user', cwd = undefined) {
    if (!state) return undefined;
    if (
      state.schemaVersion !== INSTALL_STATE_VERSION
      || !Number.isSafeInteger(state.activeHistoryIndex)
      || !Array.isArray(state.history)
      || state.history.length === 0
      || state.activeHistoryIndex < 0
      || state.activeHistoryIndex >= state.history.length
    ) {
      throw distributionError('INVALID_INSTALL_STATE', `扩展安装状态损坏：${state.id || '(unknown)'}`);
    }
    const codeParent = path.join(this.codeRoot(scope, cwd), state.id);
    const expectedDataPath = path.join(this.dataRoot, this.scopeKey(scope, cwd), state.id);
    if (path.resolve(state.dataPath || '') !== path.resolve(expectedDataPath)) {
      throw distributionError('INVALID_INSTALL_STATE', `扩展数据目录不在受管位置：${state.id}`);
    }
    const versions = new Set();
    for (const entry of state.history) {
      if (!entry || typeof entry !== 'object' || typeof entry.version !== 'string') {
        throw distributionError('INVALID_INSTALL_STATE', `扩展安装历史损坏：${state.id}`);
      }
      if (versions.has(entry.version)) {
        throw distributionError('INVALID_INSTALL_STATE', `扩展安装历史版本重复：${state.id}@${entry.version}`);
      }
      versions.add(entry.version);
      const expectedCodePath = path.join(codeParent, entry.version);
      if (path.resolve(entry.codePath || '') !== path.resolve(expectedCodePath)) {
        throw distributionError('INVALID_INSTALL_STATE', `扩展代码目录不在受管位置：${state.id}@${entry.version}`);
      }
      assertManagedPathInside(codeParent, entry.codePath, `扩展 ${state.id}@${entry.version} 代码目录`);
      if (!fs.existsSync(entry.codePath)) {
        throw distributionError('INVALID_INSTALL_STATE', `扩展版本目录不存在：${state.id}@${entry.version}`);
      }
    }
    assertManagedPathInside(this.dataRoot, state.dataPath, `扩展 ${state.id} 数据目录`);
    const active = state.history[state.activeHistoryIndex];
    return {
      ...state,
      ...active,
      activeCodePath: active.codePath,
      dataPath: state.dataPath,
    };
  }

  getInstalled(id, scope = 'user', cwd = undefined) {
    assertSafeExtensionId(id);
    return this.hydrateState(this.readState(scope, cwd, id), scope, cwd);
  }

  getInstalledManifest(id, scope = 'user', cwd = undefined) {
    return this.validateInstalledManifest(this.getInstalled(id, scope, cwd), scope);
  }

  publisherTrustSnapshot() {
    const store = this.trustStore.list();
    return {
      schemaVersion: store.schemaVersion,
      publishers: store.publishers.map((publisher) => ({
        publisher: publisher.publisher,
        keys: publisher.keys.map((key) => ({
          keyId: key.keyId,
          status: key.status,
          source: key.source,
          createdAt: key.createdAt,
          updatedAt: key.updatedAt,
          revokedAt: key.revokedAt,
        })),
      })),
    };
  }

  revokePublisherKey({ publisher, keyId } = {}) {
    if (typeof keyId !== 'string' || !PUBLISHER_KEY_ID_PATTERN.test(keyId)) {
      throw distributionError('INVALID_PUBLISHER_KEY', '发布者公钥指纹无效');
    }
    this.trustStore.revoke({ publisher, keyId });
    return this.publisherTrustSnapshot();
  }

  resolveActiveDirectory(id, scope = 'user', cwd = undefined) {
    return this.getInstalled(id, scope, cwd)?.activeCodePath;
  }

  listInstalled(scope = 'user', cwd = undefined) {
    const directory = this.stateDirectory(scope, cwd);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .map((name) => this.getInstalled(name.slice(0, -5), scope, cwd))
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }

  listInstalledDetailed(scope = 'user', cwd = undefined) {
    const directory = this.stateDirectory(scope, cwd);
    if (!fs.existsSync(directory)) return { installed: [], errors: [] };
    const installed = [];
    const errors = [];
    for (const name of fs.readdirSync(directory).filter((entry) => (
      entry.endsWith('.json') && !entry.startsWith('.')
    ))) {
      const id = name.slice(0, -5);
      try {
        const item = this.getInstalled(id, scope, cwd);
        if (item) installed.push(item);
      } catch (error) {
        errors.push({
          id,
          path: path.join(directory, name),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    installed.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    return { installed, errors };
  }

  copyValidatedPackage(source, destination) {
    ensurePrivateDirectory(destination);
    for (const file of walkPackageFiles(source, { limits: this.limits })) {
      const relative = file.path.split('/');
      const target = path.join(destination, ...relative);
      ensurePrivateDirectory(path.dirname(target));
      fs.copyFileSync(file.absolute, target, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
    }
    const integritySource = path.join(source, INTEGRITY_NAME);
    if (fs.existsSync(integritySource)) {
      const integrityTarget = path.join(destination, INTEGRITY_NAME);
      fs.copyFileSync(integritySource, integrityTarget, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(integrityTarget, 0o600); } catch { /* best effort */ }
    }
  }

  async installPrepared(token, options = {}) {
    const prepared = this.takePrepared(token);
    try {
      const target = this.installTarget(options.scope, options.cwd);
      if (
        target.scope !== prepared.target.scope
        || target.cwd !== prepared.target.cwd
      ) {
        throw distributionError(
          'TARGET_MISMATCH',
          '安装预览的生效范围或工作区已经变化，请重新校验扩展',
        );
      }
      const { scope, cwd } = target;
      const id = prepared.summary.id;
      const version = prepared.summary.version;
      this.assertPermissionConsent(prepared.summary.addedPermissions, options.acceptedPermissions);
      this.assertCapabilityConsent(prepared.summary, options);
      const verifiedSignature = this.assertPreparedPublisherTrust(prepared, options);
      const lock = path.join(this.stateDirectory(scope, cwd), `.${id}.lock`);
      return await withInstallLock(lock, async () => {
      const dependencies = this.dependencyState(prepared.validated.manifest, scope, cwd);
      if (dependencies.missing.length > 0) {
        throw distributionError(
          'MISSING_DEPENDENCY',
          `请先安装依赖扩展：${dependencies.missing.join(', ')}`,
          { dependencies: dependencies.missing },
        );
      }
      const existingState = this.readState(scope, cwd, id);
      let existing;
      if (existingState) existing = this.hydrateState(existingState, scope, cwd);
      if (
        prepared.sourceKind === 'official'
        && existing
        && existing.sourceKind !== 'official'
      ) {
        throw distributionError(
          'OFFICIAL_SOURCE_CONFLICT',
          `扩展 ${id} 已由 ${existing.sourceKind} 来源安装；请先卸载该版本，再安装官方目录版本`,
        );
      }
      const contentChanged = !existing || existing.sha256 !== prepared.validated.treeSha256;
      const currentChanges = this.capabilityChangesFromInstalled(
        existing,
        scope,
        prepared.validated.manifest,
      );
      this.assertPermissionConsent(
        currentChanges.addedPermissions,
        options.acceptedPermissions,
      );
      this.assertCapabilityConsent(currentChanges, options);
      if (existing && !options.allowDowngrade && compareSemver(version, existing.version) < 0) {
        throw distributionError(
          'VERSION_DOWNGRADE',
          `不允许从 ${existing.version} 降级安装 ${version}；如需降级请明确允许或使用回滚`,
        );
      }
      if (existing && version === existing.version && prepared.validated.treeSha256 !== existing.sha256) {
        throw distributionError(
          'VERSION_COLLISION',
          `${id}@${version} 已安装但内容不同；请提升扩展版本号`,
        );
      }

      const workspaceBoundary = scope === 'project' ? cwd : this.userDataPath;
      const codeRoot = ensureContainedDirectory(this.codeRoot(scope, cwd), workspaceBoundary);
      const codeParent = path.join(codeRoot, id);
      const versionPath = path.join(codeParent, version);
      const staging = path.join(codeParent, `.staging-${crypto.randomUUID()}`);
      ensureContainedDirectory(codeParent, workspaceBoundary);
      for (const entry of fs.readdirSync(codeParent, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('.staging-')) {
          fs.rmSync(path.join(codeParent, entry.name), { recursive: true, force: true });
        }
      }
      this.copyValidatedPackage(prepared.packageDirectory, staging);
      const staged = validateExtensionDirectory(staging, {
        scope,
        integrity: 'required',
        requirePublisher: true,
        normalizeManifest: this.normalizeManifest,
        limits: this.limits,
      });
      if (
        staged.manifest.id !== id
        || staged.manifest.version !== version
        || staged.treeSha256 !== prepared.validated.treeSha256
      ) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw distributionError('PACKAGE_CHANGED', '安装预览后扩展包内容发生变化');
      }

      let newVersionCreated = false;
      const stateFile = this.stateFile(scope, cwd, id);
      const currentFile = path.join(codeParent, 'current.json');
      const previousPointer = fs.existsSync(currentFile) ? fs.readFileSync(currentFile) : undefined;
      const previousState = existingState;
      let stateUpdated = false;
      let pointerUpdated = false;
      try {
        if (fs.existsSync(versionPath)) {
          const installed = validateExtensionDirectory(versionPath, {
            scope,
            integrity: 'required',
            requirePublisher: true,
            normalizeManifest: this.normalizeManifest,
            limits: this.limits,
          });
          if (installed.treeSha256 !== staged.treeSha256) {
            throw distributionError(
              'VERSION_COLLISION',
              `${id}@${version} 已存在且内容不同；请提升扩展版本号`,
            );
          }
          fs.rmSync(staging, { recursive: true, force: true });
        } else {
          fs.renameSync(staging, versionPath);
          newVersionCreated = true;
        }

        const dataPath = this.dataDirectory(scope, cwd, id);
        const now = this.now();
        const history = (existingState?.history || [])
          .filter((entry) => entry.version !== version);
        history.push({
          version,
          sha256: staged.treeSha256,
          source: prepared.summary.source,
          archiveSource: prepared.archiveSource.uri || null,
          sourceKind: prepared.sourceKind,
          resolvedRef: prepared.archiveSource.resolvedRef || null,
          publisher: staged.manifest.publisher,
          signatureStatus: verifiedSignature.status,
          signaturePublisher: verifiedSignature.publisher,
          signatureKeyId: verifiedSignature.keyId,
          permissions: staged.manifest.permissions,
          providerAccess: staged.manifest.providerAccess,
          requires: staged.manifest.requires,
          runtime: staged.manifest.runtime,
          trusted: options.trusted === true,
          codePath: versionPath,
          activatedAt: now,
        });
        const trimmed = history.slice(-this.maxHistory);
        const state = {
          schemaVersion: INSTALL_STATE_VERSION,
          id,
          name: staged.manifest.name,
          scope,
          workspace: scope === 'project' ? fs.realpathSync(cwd) : undefined,
          dataPath,
          activeHistoryIndex: trimmed.length - 1,
          history: trimmed,
          installedAt: existingState?.installedAt || now,
          updatedAt: now,
        };
        atomicWriteJson(stateFile, state);
        stateUpdated = true;
        atomicWriteJson(currentFile, {
          schemaVersion: INSTALL_STATE_VERSION,
          version,
          sha256: staged.treeSha256,
          updatedAt: now,
        });
        pointerUpdated = true;
        const retainedPaths = new Set(trimmed.map((entry) => path.resolve(entry.codePath)));
        for (const entry of fs.readdirSync(codeParent, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const candidate = path.resolve(codeParent, entry.name);
          if (!retainedPaths.has(candidate)) {
            try { fs.rmSync(candidate, { recursive: true, force: true }); } catch { /* retry on next install */ }
          }
        }
        this.disposePrepared(token, { allowClaimed: true });
        return {
          ...this.hydrateState(state, scope, cwd),
          contentChanged,
        };
      } catch (error) {
        const recoveryErrors = [];
        const recover = (action) => {
          try {
            action();
          } catch (recoveryError) {
            recoveryErrors.push(
              recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
            );
          }
        };
        if (stateUpdated) {
          recover(() => (
            previousState
              ? atomicWriteJson(stateFile, previousState)
              : fs.rmSync(stateFile, { force: true })
          ));
        }
        if (pointerUpdated) {
          recover(() => (
            previousPointer
              ? atomicWriteFile(currentFile, previousPointer)
              : fs.rmSync(currentFile, { force: true })
          ));
        }
        recover(() => fs.rmSync(staging, { recursive: true, force: true }));
        if (newVersionCreated) {
          recover(() => fs.rmSync(versionPath, { recursive: true, force: true }));
        }
        if (recoveryErrors.length > 0) {
          throw distributionError(
            'TRANSACTION_RECOVERY_FAILED',
            '扩展安装失败，且旧版本状态未能完整恢复；请重启应用并检查扩展安装状态',
            {
              operation: error instanceof Error ? error.message : String(error),
              recoveryErrors,
            },
          );
        }
        throw error;
      }
      });
    } catch (error) {
      // Consent or dependency errors can be corrected without rebuilding the
      // quarantine. A concurrent caller must still wait for this claim.
      this.claimedPrepared.delete(token);
      throw error;
    }
  }

  async rollback(id, options = {}) {
    assertSafeExtensionId(id);
    const { scope, cwd } = this.installTarget(options.scope, options.cwd);
    const lock = path.join(this.stateDirectory(scope, cwd), `.${id}.lock`);
    return withInstallLock(lock, async () => {
      const state = this.readState(scope, cwd, id);
      if (!state) throw distributionError('EXTENSION_NOT_INSTALLED', `扩展未安装：${id}`);
      this.hydrateState(state, scope, cwd);
      let targetIndex = state.activeHistoryIndex - 1;
      while (targetIndex >= 0 && !fs.existsSync(state.history[targetIndex].codePath)) targetIndex -= 1;
      if (targetIndex < 0) throw distributionError('NO_ROLLBACK_VERSION', `没有可回滚的 ${id} 版本`);
      const target = state.history[targetIndex];
      const dependencies = this.dependencyState({
        id,
        requires: target.requires || [],
      }, scope, cwd);
      if (dependencies.missing.length > 0) {
        throw distributionError(
          'MISSING_DEPENDENCY',
          `回滚目标缺少依赖：${dependencies.missing.join(', ')}`,
          { dependencies: dependencies.missing },
        );
      }
      const next = {
        ...state,
        activeHistoryIndex: targetIndex,
        updatedAt: this.now(),
      };
      const stateFile = this.stateFile(scope, cwd, id);
      const workspaceBoundary = scope === 'project' ? cwd : this.userDataPath;
      const codeDirectory = ensureContainedDirectory(
        path.join(this.codeRoot(scope, cwd), id),
        workspaceBoundary,
      );
      const currentFile = path.join(codeDirectory, 'current.json');
      const previousPointer = fs.existsSync(currentFile)
        ? fs.readFileSync(currentFile)
        : undefined;
      let stateUpdated = false;
      let pointerUpdated = false;
      try {
        atomicWriteJson(stateFile, next);
        stateUpdated = true;
        atomicWriteJson(currentFile, {
          schemaVersion: INSTALL_STATE_VERSION,
          version: target.version,
          sha256: target.sha256,
          updatedAt: next.updatedAt,
        });
        pointerUpdated = true;
        return {
          ...this.hydrateState(next, scope, cwd),
          contentChanged: true,
        };
      } catch (error) {
        const recoveryErrors = [];
        const recover = (action) => {
          try {
            action();
          } catch (recoveryError) {
            recoveryErrors.push(
              recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
            );
          }
        };
        if (stateUpdated) recover(() => atomicWriteJson(stateFile, state));
        if (pointerUpdated) {
          recover(() => (
            previousPointer
              ? atomicWriteFile(currentFile, previousPointer)
              : fs.rmSync(currentFile, { force: true })
          ));
        }
        if (recoveryErrors.length > 0) {
          throw distributionError(
            'TRANSACTION_RECOVERY_FAILED',
            '扩展回滚失败，且旧版本状态未能完整恢复；请重启应用并检查扩展安装状态',
            {
              operation: error instanceof Error ? error.message : String(error),
              recoveryErrors,
            },
          );
        }
        throw error;
      }
    });
  }

  async uninstall(id, options = {}) {
    assertSafeExtensionId(id);
    const { scope, cwd } = this.installTarget(options.scope, options.cwd);
    const lock = path.join(this.stateDirectory(scope, cwd), `.${id}.lock`);
    return withInstallLock(lock, async () => {
      const state = this.readState(scope, cwd, id);
      if (!state) return { removed: false, dataPreserved: false };
      this.hydrateState(state, scope, cwd);
      const preserveData = options.preserveData !== false;
      const stableId = `${scope}:${id}`;
      const dependents = this.listInstalled(scope, cwd)
        .filter((item) => item.id !== id && (item.requires || []).includes(stableId))
        .map((item) => item.id);
      if (dependents.length > 0 && options.force !== true) {
        throw distributionError(
          'EXTENSION_REQUIRED_BY',
          `扩展仍被依赖：${dependents.join(', ')}`,
          { dependents },
        );
      }
      const workspaceBoundary = scope === 'project'
        ? (fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd))
        : this.userDataPath;
      const codeDirectory = path.join(this.codeRoot(scope, cwd), id);
      if (fs.existsSync(codeDirectory)) {
        ensureContainedDirectory(codeDirectory, workspaceBoundary);
      }
      fs.rmSync(codeDirectory, { recursive: true, force: true });
      fs.rmSync(this.stateFile(scope, cwd, id), { force: true });
      if (!preserveData) fs.rmSync(state.dataPath, { recursive: true, force: true });
      return {
        removed: true,
        dataPreserved: preserveData && fs.existsSync(state.dataPath),
        dataPath: state.dataPath,
      };
    });
  }

  async checkUpdates(options = {}) {
    const { scope, cwd } = this.installTarget(options.scope, options.cwd);
    const installed = this.listInstalledDetailed(scope, cwd);
    const queue = installed.installed.filter((item) => (
      typeof item.source === 'string'
      && (
        item.source.startsWith('registry:')
        || item.source.startsWith('github:')
        || item.source.startsWith('official:')
        || /^https:\/\//i.test(item.source)
      )
    ));
    const updates = [];
    let index = 0;
    const worker = async () => {
      while (index < queue.length) {
        const currentIndex = index;
        index += 1;
        const item = queue[currentIndex];
        try {
          const preview = await this.prepare(item.source, {
            scope,
            cwd,
            registryUrl: options.registryUrl,
            allowPrerelease: options.allowPrerelease === true,
          });
          try {
            const available = compareSemver(preview.version, item.version) > 0;
            updates[currentIndex] = {
              id: item.id,
              name: item.name,
              installedVersion: item.version,
              latestVersion: preview.version,
              source: item.source,
              status: available ? 'update-available' : 'current',
              updateAvailable: available,
              requiresCapabilityConsent: preview.requiresCapabilityConsent,
              addedPermissions: preview.addedPermissions,
              addedProviderAccess: preview.addedProviderAccess,
              addedRequirements: preview.addedRequirements,
              executableExpansion: preview.executableExpansion,
            };
          } finally {
            this.disposePrepared(preview.token, { allowClaimed: true });
          }
        } catch (error) {
          updates[currentIndex] = {
            id: item.id,
            name: item.name,
            installedVersion: item.version,
            source: item.source,
            status: 'error',
            updateAvailable: false,
            message: error instanceof Error ? error.message : String(error),
            code: error?.code,
          };
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(3, queue.length) },
      () => worker(),
    ));
    return {
      scope,
      checkedAt: this.now(),
      updates: updates.filter(Boolean),
      errors: installed.errors,
      skipped: installed.installed
        .filter((item) => !queue.some((candidate) => candidate.id === item.id))
        .map((item) => ({
          id: item.id,
          installedVersion: item.version,
          reason: '这个安装来源不能自动检查更新',
        })),
    };
  }

  async pack(sourceDirectory, options = {}) {
    return createExtensionPackage(sourceDirectory, {
      ...options,
      normalizeManifest: this.normalizeManifest,
      limits: this.limits,
    });
  }

  async prunePrepared() {
    const now = this.now();
    for (const [token, prepared] of this.prepared) {
      if (prepared.expiresAt < now) this.disposePrepared(token);
    }
    if (!fs.existsSync(this.quarantineRoot)) return;
    for (const entry of fs.readdirSync(this.quarantineRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || this.prepared.has(entry.name)) continue;
      const candidate = path.join(this.quarantineRoot, entry.name);
      try {
        const stat = fs.statSync(candidate);
        if (now - stat.mtimeMs > PREPARED_TTL_MS) fs.rmSync(candidate, { recursive: true, force: true });
      } catch {
        // A concurrent installer may have just moved or removed the quarantine.
      }
    }
  }
}

function createExtensionDistributionService(options) {
  return new ExtensionDistributionService(options);
}

module.exports = {
  ExtensionDistributionError,
  ExtensionDistributionService,
  INSTALL_STATE_VERSION,
  REGISTRY_SCHEMA_VERSION,
  createExtensionDistributionService,
  EXTENSION_METADATA_KEYS,
  parseChecksumFile,
  selectRegistryVersion,
  VERSION_METADATA_KEYS,
  validateRegistry,
};

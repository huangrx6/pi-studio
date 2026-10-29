'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  createZipArchive,
  DEFAULT_ARCHIVE_LIMITS,
  sha256,
} = require('./extension-archive.cjs');
const { normalizeManifest: normalizeCoreManifest } = require('./extension-manifest.cjs');

const MANIFEST_NAME = 'pi-studio.extension.json';
const INTEGRITY_NAME = 'integrity.json';
const INTEGRITY_SCHEMA_VERSION = 1;
const DISTRIBUTION_API_VERSION = 1;
const IGNORED_NAMES = new Set([
  '.DS_Store',
  '.git',
  '.svn',
  '.hg',
  '.pi-studio',
  '.pi-studio-data',
  '.data',
  'release',
  'SHA256SUMS',
  'node_modules/.cache',
  'integrity.json',
]);
const IGNORED_DIRECTORIES = new Set([
  '.pi-studio-signing',
]);
const SENSITIVE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  'auth.json',
  'credentials.json',
  'publisher-private.pem',
]);
const SENSITIVE_SUFFIXES = [
  '.private.pem',
  '.private.key',
  '-private.pem',
  '-private.key',
];
function normalizePathForPackage(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('包内路径无效');
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`包内路径不能是绝对路径：${value}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`包内路径越界：${value}`);
  }
  return segments.join('/');
}

function rejectSensitivePackageFile(absolute, relative) {
  const basename = path.basename(relative).toLocaleLowerCase('en-US');
  if (SENSITIVE_NAMES.has(basename)
    || SENSITIVE_SUFFIXES.some((suffix) => basename.endsWith(suffix))) {
    throw new Error(`扩展包不能包含凭据或签名私钥：${relative}`);
  }
  const descriptor = fs.openSync(absolute, 'r');
  const prefix = Buffer.alloc(256);
  let length = 0;
  try {
    length = fs.readSync(descriptor, prefix, 0, prefix.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(prefix.subarray(0, length).toString('utf8'))) {
    throw new Error(`扩展包不能包含 PEM 私钥：${relative}`);
  }
}

function safePublisher(value) {
  if (typeof value !== 'string') return false;
  const clean = value.trim();
  return clean.length >= 1
    && clean.length <= 80
    && !/[\0-\x1f\x7f]/.test(clean);
}

function loadHostNormalizer() {
  return normalizeCoreManifest;
}

function normalizeDistributionManifest(raw, source, scope = 'user', options = {}) {
  const normalizeManifest = options.normalizeManifest || loadHostNormalizer();
  const normalized = normalizeManifest(raw, source, scope);
  const publisher = normalized.publisher;
  if (options.requirePublisher !== false && !safePublisher(publisher)) {
    throw new Error('扩展必须提供 1–80 字符的安全 publisher，或提供同样格式的 author');
  }
  return normalized;
}

function readManifest(directory, scope = 'user', options = {}) {
  const file = path.join(directory, MANIFEST_NAME);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`扩展目录缺少 ${MANIFEST_NAME}`);
  }
  if (!stat.isFile()) throw new Error(`${MANIFEST_NAME} 必须是普通文件`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法解析 ${MANIFEST_NAME}：${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    raw,
    manifest: normalizeDistributionManifest(raw, directory, scope, options),
  };
}

function packageRelativeName(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function walkPackageFiles(root, options = {}) {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...(options.limits || {}) };
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) throw new Error('扩展目录不存在');
  if (!fs.lstatSync(resolvedRoot).isDirectory()) throw new Error('扩展来源必须是目录');
  const files = [];
  let totalBytes = 0;
  const pending = [resolvedRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = packageRelativeName(resolvedRoot, absolute);
      if (IGNORED_NAMES.has(relative)
        || IGNORED_NAMES.has(entry.name)
        || entry.name.endsWith('.pi-extension.zip')) continue;
      if (entry.isSymbolicLink()) throw new Error(`扩展包不能包含符号链接：${relative}`);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || IGNORED_NAMES.has(entry.name)) continue;
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error(`扩展包包含不支持的条目：${relative}`);
      rejectSensitivePackageFile(absolute, relative);
      const stat = fs.statSync(absolute);
      if (stat.size > limits.maxFileBytes) {
        throw new Error(`扩展文件超过 ${limits.maxFileBytes} 字节上限：${relative}`);
      }
      totalBytes += stat.size;
      if (totalBytes > limits.maxExtractedBytes) {
        throw new Error(`扩展内容超过 ${limits.maxExtractedBytes} 字节上限`);
      }
      files.push({
        path: relative,
        absolute,
        size: stat.size,
      });
      if (files.length > limits.maxEntries) {
        throw new Error(`扩展文件数超过 ${limits.maxEntries} 项上限`);
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function fileDigest(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function integrityFromFiles(root, files) {
  return {
    schemaVersion: INTEGRITY_SCHEMA_VERSION,
    algorithm: 'sha256',
    files: files.map((file) => ({
      path: normalizePathForPackage(file.path),
      sha256: file.sha256 || fileDigest(path.join(root, ...file.path.split('/'))),
      size: file.size ?? fs.statSync(path.join(root, ...file.path.split('/'))).size,
    })),
  };
}

function normalizeIntegrity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('integrity.json 必须是对象');
  for (const key of Object.keys(raw)) {
    if (!['schemaVersion', 'algorithm', 'files'].includes(key)) {
      throw new Error(`integrity.json 包含未知字段：${key}`);
    }
  }
  if (raw.schemaVersion !== INTEGRITY_SCHEMA_VERSION) throw new Error('不支持的 integrity schemaVersion');
  if (raw.algorithm !== 'sha256') throw new Error('integrity.json 只支持 sha256');
  if (!Array.isArray(raw.files) || raw.files.length === 0) throw new Error('integrity.files 不能为空');
  const files = raw.files.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`integrity.files[${index}] 必须是对象`);
    }
    if (!Number.isSafeInteger(item.size) || item.size < 0) {
      throw new Error(`integrity.files[${index}].size 无效`);
    }
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error(`integrity.files[${index}].sha256 无效`);
    }
    return {
      path: normalizePathForPackage(item.path),
      sha256: item.sha256,
      size: item.size,
    };
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const paths = new Set();
  for (const file of files) {
    if (paths.has(file.path)) throw new Error(`integrity.files 路径重复：${file.path}`);
    paths.add(file.path);
  }
  return { schemaVersion: INTEGRITY_SCHEMA_VERSION, algorithm: 'sha256', files };
}

function readIntegrity(directory) {
  const file = path.join(directory, INTEGRITY_NAME);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) throw new Error('integrity.json 必须是普通文件');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法解析 integrity.json：${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeIntegrity(raw);
}

function verifyIntegrity(directory, integrity, options = {}) {
  const expected = normalizeIntegrity(integrity);
  const actualFiles = walkPackageFiles(directory, options);
  const expectedPaths = new Set(expected.files.map((file) => file.path));
  const actualPaths = new Set(actualFiles.map((file) => file.path));
  for (const file of expected.files) {
    if (!actualPaths.has(file.path)) throw new Error(`扩展包缺少 integrity 清单中的文件：${file.path}`);
    const actual = actualFiles.find((item) => item.path === file.path);
    if (actual.size !== file.size) throw new Error(`扩展文件长度与 integrity 不一致：${file.path}`);
    const digest = fileDigest(actual.absolute);
    if (digest !== file.sha256) throw new Error(`扩展文件 SHA-256 不一致：${file.path}`);
  }
  for (const file of actualFiles) {
    if (!expectedPaths.has(file.path)) throw new Error(`扩展包包含 integrity 未声明的文件：${file.path}`);
  }
  return {
    files: actualFiles.map((file) => ({
      path: file.path,
      sha256: expected.files.find((item) => item.path === file.path).sha256,
      size: file.size,
    })),
  };
}

function validateExtensionDirectory(directory, options = {}) {
  const scope = options.scope === 'project' ? 'project' : 'user';
  const { raw, manifest } = readManifest(directory, scope, options);
  const files = walkPackageFiles(directory, options);
  if (!files.some((file) => file.path === MANIFEST_NAME)) {
    throw new Error(`扩展包缺少 ${MANIFEST_NAME}`);
  }
  if (manifest.runtime?.durableEntry) {
    const entryPath = normalizePathForPackage(manifest.runtime.durableEntry);
    const entry = files.find((file) => file.path === entryPath);
    if (!entry) throw new Error(`runtime.durableEntry 不存在：${entryPath}`);
    if (!/\.(?:mjs|js)$/.test(entryPath)) throw new Error('runtime.durableEntry 必须是 .mjs 或 .js 文件');
  }
  for (const field of ['icon', 'readme']) {
    const relative = manifest[field];
    if (relative && !files.some((file) => file.path === relative)) {
      throw new Error(`manifest.${field} 指向的文件不存在：${relative}`);
    }
  }
  let integrity;
  let verified;
  if (options.integrity !== 'ignore'
    && (options.integrity === 'required' || fs.existsSync(path.join(directory, INTEGRITY_NAME)))) {
    integrity = readIntegrity(directory);
    if (!integrity) {
      if (options.integrity === 'required') throw new Error('扩展包缺少 integrity.json');
    } else {
      verified = verifyIntegrity(directory, integrity, options);
    }
  }
  return {
    raw,
    manifest,
    files,
    integrity,
    verified: Boolean(verified),
    treeSha256: integrityTreeDigest(verified?.files || files.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: fileDigest(file.absolute),
    }))),
  };
}

function integrityTreeDigest(files) {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const content = sorted.map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`).join('');
  return crypto.createHash('sha256').update(content).digest('hex');
}

function createExtensionPackage(sourceDirectory, options = {}) {
  const validated = validateExtensionDirectory(sourceDirectory, {
    ...options,
    integrity: 'ignore',
    requirePublisher: options.requirePublisher ?? true,
  });
  const files = validated.files.map((file) => ({
    path: file.path,
    content: fs.readFileSync(file.absolute),
  }));
  const hashes = files.map((file) => ({
    path: file.path,
    sha256: sha256(file.content),
    size: file.content.length,
  }));
  const integrity = integrityFromFiles(sourceDirectory, hashes);
  const integrityBuffer = Buffer.from(`${JSON.stringify(integrity, null, 2)}\n`);
  const archive = createZipArchive([
    ...files,
    { path: INTEGRITY_NAME, content: integrityBuffer },
  ], options);
  return {
    archive,
    archiveSha256: sha256(archive),
    integrity,
    treeSha256: integrityTreeDigest(integrity.files),
    manifest: validated.manifest,
  };
}

function recommendedArchiveName(manifest) {
  const safeId = manifest.id.replace(/[^a-z0-9._-]/g, '-');
  return `${safeId}-${manifest.version}.pi-extension.zip`;
}

module.exports = {
  DISTRIBUTION_API_VERSION,
  INTEGRITY_NAME,
  INTEGRITY_SCHEMA_VERSION,
  MANIFEST_NAME,
  createExtensionPackage,
  integrityFromFiles,
  normalizeDistributionManifest,
  normalizeIntegrity,
  normalizePathForPackage,
  readIntegrity,
  readManifest,
  recommendedArchiveName,
  validateExtensionDirectory,
  verifyIntegrity,
  walkPackageFiles,
};

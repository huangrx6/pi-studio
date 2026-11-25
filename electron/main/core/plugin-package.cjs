/**
 * Plugin package validation (pi-studio.plugin.json).
 *
 * Plugins package MCP / Skill / Extension / CLI primitives. Protocols stay
 * independent; this module only validates packaging and normalizes provides.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST_NAME = 'pi-studio.plugin.json';
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

function pluginError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRelativePath(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw pluginError('INVALID_PATH', `${field} 不能为空`);
  }
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) {
    throw pluginError('INVALID_PATH', `${field} 必须是包内相对路径：${value}`);
  }
  return normalized;
}

function resolvePackagePath(root, relative, field) {
  const normalized = normalizeRelativePath(relative, field);
  const absolute = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (absolute !== rootResolved && !absolute.startsWith(`${rootResolved}${path.sep}`)) {
    throw pluginError('PATH_ESCAPE', `${field} 越出插件包：${relative}`);
  }
  return { relative: normalized, absolute };
}

function walkFiles(directory, root = directory, files = [], bytes = { total: 0 }) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw pluginError('SYMLINK_NOT_ALLOWED', `插件包不能包含符号链接：${path.relative(root, absolute)}`);
    }
    if (entry.isDirectory()) {
      walkFiles(absolute, root, files, bytes);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = fs.statSync(absolute);
    bytes.total += stat.size;
    files.push({
      path: path.relative(root, absolute).split(path.sep).join('/'),
      absolute,
      size: stat.size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
    });
  }
  return { files, bytes: bytes.total };
}

function treeSha256(files) {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const payload = sorted.map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`).join('');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function readManifestFile(directory) {
  const manifestPath = path.join(directory, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw pluginError('MANIFEST_MISSING', `缺少 ${MANIFEST_NAME}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw pluginError('MANIFEST_INVALID', `${MANIFEST_NAME} 不是合法 JSON`);
  }
  if (!isPlainObject(raw)) throw pluginError('MANIFEST_INVALID', `${MANIFEST_NAME} 必须是对象`);
  return raw;
}

function normalizeMcpEntry(entry, index) {
  if (!isPlainObject(entry)) throw pluginError('INVALID_PROVIDES', `provides.mcp[${index}] 必须是对象`);
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!MCP_NAME_PATTERN.test(name)) {
    throw pluginError('INVALID_MCP', `provides.mcp[${index}].name 无效`);
  }
  const transport = entry.transport === 'http' ? 'http' : 'stdio';
  const command = typeof entry.command === 'string' ? entry.command.trim() : '';
  const args = Array.isArray(entry.args) ? entry.args.map((item) => String(item)) : [];
  const url = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (transport === 'stdio' && !command) {
    throw pluginError('INVALID_MCP', `provides.mcp[${index}] stdio 需要 command`);
  }
  if (transport === 'http' && !url) {
    throw pluginError('INVALID_MCP', `provides.mcp[${index}] http 需要 url`);
  }
  return {
    name,
    transport,
    command: transport === 'stdio' ? command : '',
    args: transport === 'stdio' ? args : [],
    url: transport === 'http' ? url : '',
    description: typeof entry.description === 'string' ? entry.description.trim().slice(0, 1_200) : '',
    cwd: typeof entry.cwd === 'string' ? entry.cwd.trim() : '',
    exposure: ['direct', 'deferred', 'hidden'].includes(entry.exposure) ? entry.exposure : 'deferred',
    envKeys: Array.isArray(entry.envKeys)
      ? entry.envKeys.map((item) => String(item).trim()).filter(Boolean)
      : [],
  };
}

function normalizeSkillEntry(entry, index, root) {
  if (!isPlainObject(entry)) throw pluginError('INVALID_PROVIDES', `provides.skills[${index}] 必须是对象`);
  const resolved = resolvePackagePath(root, entry.path, `provides.skills[${index}].path`);
  if (!fs.existsSync(resolved.absolute) || !fs.statSync(resolved.absolute).isDirectory()) {
    throw pluginError('SKILL_MISSING', `技能目录不存在：${resolved.relative}`);
  }
  const skillMd = path.join(resolved.absolute, 'SKILL.md');
  if (!fs.existsSync(skillMd) || !fs.statSync(skillMd).isFile()) {
    throw pluginError('SKILL_MISSING', `技能缺少 SKILL.md：${resolved.relative}`);
  }
  return { path: resolved.relative, absolute: resolved.absolute };
}

function normalizeCliEntry(entry, index, root) {
  if (!isPlainObject(entry)) throw pluginError('INVALID_PROVIDES', `provides.cli[${index}] 必须是对象`);
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!ID_PATTERN.test(id)) throw pluginError('INVALID_CLI', `provides.cli[${index}].id 无效`);
  const name = typeof entry.name === 'string' && entry.name.trim()
    ? entry.name.trim()
    : id;
  const binRelative = typeof entry.bin === 'string' ? entry.bin.trim() : '';
  const command = typeof entry.command === 'string' ? entry.command.trim() : '';
  let bin = '';
  let absoluteBin = '';
  let kind = 'system';
  if (binRelative) {
    const resolved = resolvePackagePath(root, binRelative, `provides.cli[${index}].bin`);
    if (!fs.existsSync(resolved.absolute) || !fs.statSync(resolved.absolute).isFile()) {
      throw pluginError('CLI_MISSING', `CLI 文件不存在：${resolved.relative}`);
    }
    bin = resolved.relative;
    absoluteBin = resolved.absolute;
    kind = 'bundled';
  } else if (command) {
    bin = command;
    kind = 'system';
  } else {
    throw pluginError('INVALID_CLI', `provides.cli[${index}] 需要 bin 或 command`);
  }
  return {
    id,
    name,
    bin,
    absoluteBin,
    command: kind === 'system' ? command : '',
    kind,
    description: typeof entry.description === 'string' ? entry.description.trim().slice(0, 1_200) : '',
    pathEnv: entry.pathEnv === true,
    version: typeof entry.version === 'string' ? entry.version.trim() : '',
    optional: entry.optional === true,
    envKeys: Array.isArray(entry.envKeys)
      ? entry.envKeys.map((item) => String(item).trim()).filter(Boolean)
      : [],
    commands: Array.isArray(entry.commands)
      ? entry.commands
        .filter((item) => isPlainObject(item))
        .map((item) => ({
          summary: typeof item.summary === 'string' ? item.summary.trim().slice(0, 200) : '',
          example: typeof item.example === 'string' ? item.example.trim().slice(0, 400) : '',
        }))
        .filter((item) => item.summary || item.example)
        .slice(0, 32)
      : [],
    platform: Array.isArray(entry.platform)
      ? entry.platform.map((item) => String(item).trim()).filter(Boolean)
      : [],
  };
}

function normalizeExtension(entry, root) {
  if (entry == null) return undefined;
  if (!isPlainObject(entry)) throw pluginError('INVALID_PROVIDES', 'provides.extension 必须是对象');
  const resolved = resolvePackagePath(root, entry.path || 'extension', 'provides.extension.path');
  if (!fs.existsSync(resolved.absolute) || !fs.statSync(resolved.absolute).isDirectory()) {
    throw pluginError('EXTENSION_MISSING', `扩展目录不存在：${resolved.relative}`);
  }
  const manifest = path.join(resolved.absolute, 'pi-studio.extension.json');
  if (!fs.existsSync(manifest)) {
    throw pluginError('EXTENSION_MISSING', `扩展缺少 pi-studio.extension.json：${resolved.relative}`);
  }
  return { path: resolved.relative, absolute: resolved.absolute };
}

function normalizeProvides(rawProvides, root) {
  if (!isPlainObject(rawProvides)) {
    throw pluginError('INVALID_PROVIDES', 'provides 必须是对象');
  }
  const mcp = Array.isArray(rawProvides.mcp)
    ? rawProvides.mcp.map((entry, index) => normalizeMcpEntry(entry, index))
    : [];
  const skills = Array.isArray(rawProvides.skills)
    ? rawProvides.skills.map((entry, index) => normalizeSkillEntry(entry, index, root))
    : [];
  const cli = Array.isArray(rawProvides.cli)
    ? rawProvides.cli.map((entry, index) => normalizeCliEntry(entry, index, root))
    : [];
  const extension = normalizeExtension(rawProvides.extension, root);
  if (!mcp.length && !skills.length && !cli.length && !extension) {
    throw pluginError('EMPTY_PROVIDES', 'provides 至少需要 MCP、Skill、CLI 或 Extension 之一');
  }
  const mcpNames = new Set();
  for (const item of mcp) {
    if (mcpNames.has(item.name)) throw pluginError('DUPLICATE_MCP', `重复的 MCP name：${item.name}`);
    mcpNames.add(item.name);
  }
  const cliIds = new Set();
  for (const item of cli) {
    if (cliIds.has(item.id)) throw pluginError('DUPLICATE_CLI', `重复的 CLI id：${item.id}`);
    cliIds.add(item.id);
  }
  return { mcp, skills, cli, extension };
}

function normalizeManifest(raw, root) {
  if (raw.kind != null && raw.kind !== 'plugin') {
    throw pluginError('INVALID_KIND', 'kind 必须是 plugin');
  }
  const format = Number(raw.format) || 1;
  if (format !== 1) throw pluginError('UNSUPPORTED_FORMAT', `不支持的插件 format：${format}`);
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_PATTERN.test(id)) throw pluginError('INVALID_ID', '插件 id 无效');
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw pluginError('INVALID_VERSION', '插件 version 需要 semver');
  }
  let icon = '';
  if (typeof raw.icon === 'string' && raw.icon.trim()) {
    const resolved = resolvePackagePath(root, raw.icon, 'icon');
    if (!fs.existsSync(resolved.absolute) || !fs.statSync(resolved.absolute).isFile()) {
      throw pluginError('ICON_MISSING', `图标不存在：${resolved.relative}`);
    }
    icon = resolved.relative;
  }
  const provides = normalizeProvides(raw.provides || {}, root);
  return {
    format,
    kind: 'plugin',
    id,
    name,
    version,
    publisher: typeof raw.publisher === 'string' ? raw.publisher.trim() : '',
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 2_000) : '',
    icon,
    category: typeof raw.category === 'string' ? raw.category.trim().slice(0, 64) : '',
    homepage: typeof raw.homepage === 'string' ? raw.homepage.trim().slice(0, 500) : '',
    provides,
  };
}

function validatePluginDirectory(directory, options = {}) {
  const root = path.resolve(directory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw pluginError('SOURCE_NOT_FOUND', `插件目录不存在：${root}`);
  }
  const raw = readManifestFile(root);
  const manifest = normalizeManifest(raw, root);
  const walked = options.skipWalk
    ? { files: [], bytes: 0 }
    : walkFiles(root);
  return {
    root,
    raw,
    manifest,
    files: walked.files,
    totalBytes: walked.bytes,
    contentHash: walked.files.length ? treeSha256(walked.files) : '',
    summary: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      publisher: manifest.publisher,
      description: manifest.description,
      category: manifest.category,
      mcp: manifest.provides.mcp.map((item) => item.name),
      skills: manifest.provides.skills.map((item) => item.path),
      cli: manifest.provides.cli.map((item) => ({ id: item.id, name: item.name, kind: item.kind })),
      extension: manifest.provides.extension?.path || null,
    },
  };
}

module.exports = {
  MANIFEST_NAME,
  pluginError,
  readManifestFile,
  validatePluginDirectory,
  walkFiles,
  treeSha256,
};

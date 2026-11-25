/**
 * Local plugin package install / uninstall.
 *
 * Installs provides (MCP, Skill, CLI, optional Extension) in one SQLite
 * transaction with ownership fields. Marketplace (D4) builds on this.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PLUGIN_INSTALL_DIRECTORY, studioDataDirectory } = require('../core/studio-paths.cjs');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const {
  MANIFEST_NAME,
  pluginError,
  validatePluginDirectory,
} = require('../core/plugin-package.cjs');
const { extractZipArchive } = require('../core/extension-archive.cjs');
const { MANIFEST_NAME: EXTENSION_MANIFEST, validateExtensionDirectory } = require('../core/extension-package.cjs');
const { readPluginIcon } = require('./plugin-icon.cjs');

const PREPARED_TTL_MS = 15 * 60 * 1_000;
const prepared = new Map();

function pluginsRoot() {
  return path.join(studioDataDirectory(), PLUGIN_INSTALL_DIRECTORY);
}

function quarantineRoot() {
  return path.join(studioDataDirectory(), 'plugin-quarantine');
}

function installRootFor(id, version) {
  return path.join(pluginsRoot(), id, version);
}

function skillInstallRoot(pluginId) {
  return path.join(pluginsRoot(), pluginId, 'skills');
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function copyTree(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    dereference: false,
    filter: (file) => {
      const base = path.basename(file);
      return !['.git', 'node_modules', '.DS_Store'].includes(base);
    },
  });
}

function readSkillName(skillDirectory) {
  const skillMd = fs.readFileSync(path.join(skillDirectory, 'SKILL.md'), 'utf8');
  const match = /^---\s*[\s\S]*?^name:\s*["']?([^"'\n]+)["']?/m.exec(skillMd)
    || /^name:\s*["']?([^"'\n]+)/m.exec(skillMd);
  if (match?.[1]) return match[1].trim();
  // Fallback: first heading
  const heading = /^#\s+(.+)$/m.exec(skillMd);
  if (heading?.[1]) return heading[1].trim().toLowerCase().replace(/\s+/g, '-').slice(0, 64);
  return path.basename(skillDirectory);
}

function directoryHash(directory) {
  const { walkFiles, treeSha256 } = require('../core/plugin-package.cjs');
  const walked = walkFiles(directory);
  return treeSha256(walked.files);
}

function validateBundledExtension(directory, manifest) {
  if (!manifest.provides.extension) return undefined;
  const appVersion = require('electron').app?.getVersion?.() || require('../../../package.json').version;
  return validateExtensionDirectory(path.join(directory, manifest.provides.extension.path), { scope: 'user', appVersion });
}

function resourceCollisions(db, manifest, extension) {
  const collisions = [];
  for (const mcp of manifest.provides.mcp) {
    const current = db.getMcpServer(mcp.name);
    if (current && !(current.origin === 'plugin' && current.ownerPluginId === manifest.id)) {
      collisions.push({ kind: 'mcp', name: mcp.name, origin: current.origin, ownerPluginId: current.ownerPluginId });
    }
  }
  if (extension) {
    const current = db.getExtension(`user:${extension.manifest.id}`);
    if (current && current.ownerPluginId !== manifest.id) {
      collisions.push({ kind: 'extension', name: extension.manifest.name, origin: current.origin, ownerPluginId: current.ownerPluginId });
    }
  }
  return collisions;
}

function withIcon(plugin) {
  return { ...plugin, iconDataUrl: readPluginIcon(plugin.installPath, plugin.icon) };
}

function serializeProvides(manifest, extension) {
  return {
    mcp: manifest.provides.mcp.map((item) => ({
      name: item.name,
      transport: item.transport,
      command: item.command,
      args: item.args,
      url: item.url,
      description: item.description,
      exposure: item.exposure,
      envKeys: item.envKeys,
    })),
    skills: manifest.provides.skills.map((item) => ({
      path: item.path,
      name: readSkillName(item.absolute),
    })),
    cli: manifest.provides.cli.map((item) => ({
      id: item.id,
      name: item.name,
      bin: item.bin,
      command: item.command,
      kind: item.kind,
      description: item.description,
      pathEnv: item.pathEnv,
      version: item.version,
      optional: item.optional,
      envKeys: item.envKeys,
      commands: item.commands,
      platform: item.platform,
    })),
    extension: extension
      ? { path: manifest.provides.extension.path, tools: extension.manifest.contributes.tools.map(tool => tool.name) }
      : null,
  };
}

function syncPluginTools(db, row, added, removed) {
  if (!added.length && !removed.length) return;
  const { matches, readAgentToolSelection, saveInstalledToolSelection } = require('../runtime/tool-selection.cjs');
  const selection = readAgentToolSelection(db);
  const enabled = selection.enabled.filter(name => !(removed.includes(name) && selection.sources[name]?.source === row.id));
  const sources = { ...selection.sources };
  for (const name of added) {
    if (enabled.some(pattern => matches(pattern, name))) continue;
    enabled.push(name);
    sources[name] = { source: row.id, label: row.name, scope: 'user', path: row.source, baseDir: path.dirname(row.source) };
  }
  saveInstalledToolSelection({ enabled, sources }, db, { inTransaction: true });
}

function cleanupPrepared(token) {
  const pending = prepared.get(token);
  prepared.delete(token);
  if (pending?.quarantine) {
    fs.rmSync(pending.quarantine, { recursive: true, force: true });
  }
}

function prunePrepared() {
  const now = Date.now();
  for (const [token, pending] of prepared.entries()) {
    if (pending.expiresAt < now) cleanupPrepared(token);
  }
}

async function preparePluginInstall(source, options = {}) {
  prunePrepared();
  if (typeof source !== 'string' || !source.trim()) {
    throw pluginError('INVALID_SOURCE', '插件来源不能为空');
  }
  const token = crypto.randomUUID();
  const quarantine = path.join(quarantineRoot(), token);
  const packageDirectory = path.join(quarantine, 'package');
  ensureDir(packageDirectory);
  let sourceKind = 'local-directory';
  try {
    const local = path.resolve(source.replace(/^~(?=$|[/\\])/, os.homedir()));
    if (!fs.existsSync(local)) throw pluginError('SOURCE_NOT_FOUND', `插件来源不存在：${local}`);
    const stat = fs.lstatSync(local);
    if (stat.isSymbolicLink()) throw pluginError('SYMLINK_NOT_ALLOWED', '插件来源不能是符号链接');
    if (stat.isDirectory()) {
      copyTree(local, packageDirectory);
      sourceKind = 'local-directory';
    } else if (stat.isFile()) {
      sourceKind = 'archive';
      const archive = fs.readFileSync(local);
      extractZipArchive(archive, packageDirectory, {
        limits: {
          maxEntries: 8_000,
          maxTotalBytes: 200 * 1024 * 1024,
          maxEntryBytes: 80 * 1024 * 1024,
        },
      });
    } else {
      throw pluginError('INVALID_SOURCE', '插件来源必须是目录或 zip');
    }

    const validated = validatePluginDirectory(packageDirectory);
    const expectedSha256 = typeof options.expectedSha256 === 'string'
      ? options.expectedSha256.trim().toLowerCase()
      : '';
    if (expectedSha256) {
      if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
        throw pluginError('INVALID_HASH', '期望的 sha256 无效');
      }
      if (validated.contentHash !== expectedSha256) {
        throw pluginError(
          'INTEGRITY_MISMATCH',
          `插件内容校验失败：期望 ${expectedSha256}，实际 ${validated.contentHash}`,
        );
      }
    }
    const extension = validateBundledExtension(packageDirectory, validated.manifest);
    const db = getStudioDatabase();
    const existing = db.getPlugin(validated.manifest.id);
    const collisions = resourceCollisions(db, validated.manifest, extension);
    const preview = {
      token,
      sourceKind,
      source: local,
      id: validated.manifest.id,
      name: validated.manifest.name,
      version: validated.manifest.version,
      publisher: validated.manifest.publisher,
      description: validated.manifest.description,
      category: validated.manifest.category,
      icon: validated.manifest.icon,
      iconDataUrl: readPluginIcon(packageDirectory, validated.manifest.icon),
      contentHash: validated.contentHash,
      provides: serializeProvides(validated.manifest, extension),
      existingVersion: existing?.version || null,
      upgrade: Boolean(existing && existing.version !== validated.manifest.version),
      alreadyInstalled: Boolean(
        existing
        && existing.version === validated.manifest.version
        && existing.contentHash === validated.contentHash,
      ),
      collisions,
      canInstall: collisions.length === 0,
    };
    prepared.set(token, {
      token,
      quarantine,
      packageDirectory,
      validated,
      extension,
      source: local,
      sourceKind,
      expiresAt: Date.now() + PREPARED_TTL_MS,
      preview,
    });
    return preview;
  } catch (error) {
    fs.rmSync(quarantine, { recursive: true, force: true });
    throw error;
  }
}

function installPreparedPlugin(token, options = {}) {
  const pending = prepared.get(token);
  if (!pending || pending.expiresAt < Date.now()) {
    cleanupPrepared(token);
    throw pluginError('PREVIEW_EXPIRED', '插件安装预览已过期，请重新选择');
  }
  const { validated, packageDirectory, extension } = pending;
  const manifest = validated.manifest;
  const target = installRootFor(manifest.id, manifest.version);
  const db = getStudioDatabase();
  const conflicts = resourceCollisions(db, manifest, extension);
  if (conflicts.length) {
    throw pluginError(conflicts[0].kind === 'mcp' ? 'MCP_COLLISION' : 'EXTENSION_COLLISION',
      '已存在同名的 MCP 或扩展资源，安装已取消');
  }

  ensureDir(path.dirname(target));
  const staging = `${target}.${crypto.randomUUID()}.tmp`;
  copyTree(packageDirectory, staging);
  const stagedHash = directoryHash(staging);
  if (stagedHash !== validated.contentHash) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw pluginError('INTEGRITY_MISMATCH', '插件安装暂存校验失败');
  }

  const previous = db.getPlugin(manifest.id);
  const previousPath = previous?.installPath || '';
  const enabled = options.enabled ?? previous?.enabled ?? true;
  const replacement = fs.existsSync(target) ? `${staging}.backup` : null;
  if (replacement) fs.renameSync(target, replacement);
  try {
    fs.renameSync(staging, target);
  } catch (error) {
    if (replacement) fs.renameSync(replacement, target);
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  const provides = {
    mcp: manifest.provides.mcp.map((item) => ({
      name: item.name,
      transport: item.transport,
      command: item.command,
      args: item.args,
      url: item.url,
      description: item.description,
      exposure: item.exposure,
      envKeys: item.envKeys,
    })),
    skills: manifest.provides.skills.map((skill) => {
      const absolute = path.join(target, skill.path);
      return { path: skill.path, name: readSkillName(absolute) };
    }),
    cli: manifest.provides.cli.map((cli) => ({
      id: cli.id,
      name: cli.name,
      bin: cli.bin,
      command: cli.command,
      kind: cli.kind,
      description: cli.description,
      pathEnv: cli.pathEnv,
      version: cli.version,
      optional: cli.optional,
      envKeys: cli.envKeys,
      commands: cli.commands,
      platform: cli.platform,
      absoluteBin: cli.kind === 'bundled' ? path.join(target, cli.bin) : '',
    })),
    extension: extension
      ? { path: manifest.provides.extension.path, tools: extension.manifest.contributes.tools.map(tool => tool.name) }
      : null,
  };

  const installedSkills = [];
  const installedMcp = [];
  const installedExtension = [];
  const previousExtensions = db.listExtensions().filter(item => item.ownerPluginId === manifest.id && item.managed);
  const nextExtensionId = extension ? `user:${extension.manifest.id}` : '';

  try {
    db.transaction(() => {
      // Remove previous managed resources owned by this plugin when upgrading.
      if (previous) {
        for (const server of db.listMcpServers()) {
          if (server.ownerPluginId === manifest.id && server.managed && !server.userOverride) {
            db.removeMcpServer(server.name);
          }
        }
        for (const skill of db.listSkillInstallations()) {
          if (skill.ownerPluginId === manifest.id && skill.managed && !skill.userOverride) {
            const skillPath = skill.path;
            db.removeSkillInstallation(skillPath);
            fs.rmSync(skillPath, { recursive: true, force: true });
          }
        }
        for (const extension of db.listExtensions()) {
          if (extension.ownerPluginId === manifest.id && extension.managed && !extension.userOverride) {
            db.removeExtension(extension.id);
            if (extension.id !== nextExtensionId) {
              syncPluginTools(db, extension, [], extension.manifest.contributes?.tools?.map(tool => tool.name) || []);
            }
          }
        }
      }

      db.upsertPlugin({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        publisher: manifest.publisher,
        description: manifest.description,
        icon: manifest.icon,
        category: manifest.category,
        homepage: manifest.homepage,
        sourcePath: pending.source,
        installPath: target,
        provides,
        enabled,
        contentHash: validated.contentHash,
      });

      for (const mcp of manifest.provides.mcp) {
        const args = (mcp.args || []).map((item) => {
          const value = String(item);
          if (value.includes('${PLUGIN_ROOT}')) {
            return value.split('${PLUGIN_ROOT}').join(target);
          }
          // Relative script paths inside the package become absolute.
          if (mcp.transport === 'stdio' && !path.isAbsolute(value) && /[.][cm]?js$/.test(value)) {
            return path.join(target, value);
          }
          return value;
        });
        let command = mcp.command;
        if (mcp.transport === 'stdio' && command && !path.isAbsolute(command) && command.includes(path.sep)) {
          command = path.join(target, command);
        }
        const row = db.upsertMcpServer({
          name: mcp.name,
          transport: mcp.transport,
          command,
          args,
          cwd: target,
          url: mcp.url,
          description: mcp.description || `${manifest.name} 提供`,
          exposure: mcp.exposure,
          enabled,
          origin: 'plugin',
          ownerPluginId: manifest.id,
          managed: true,
          userOverride: false,
        });
        installedMcp.push(row.name);
      }

      const skillRoot = skillInstallRoot(manifest.id);
      ensureDir(skillRoot);
      for (const skill of manifest.provides.skills) {
        const sourceSkill = path.join(target, skill.path);
        const skillName = readSkillName(sourceSkill);
        const dest = path.join(skillRoot, skillName);
        fs.rmSync(dest, { recursive: true, force: true });
        copyTree(sourceSkill, dest);
        const hash = directoryHash(dest);
        db.upsertSkillInstallation({
          path: dest,
          sourceId: `plugin:${manifest.id}`,
          listingId: skill.path,
          name: skillName,
          version: manifest.version,
          sha256: hash,
          origin: 'plugin',
          ownerPluginId: manifest.id,
          managed: true,
          userOverride: false,
        });
        installedSkills.push({ name: skillName, path: dest });
      }

      if (extension) {
        const source = path.join(target, manifest.provides.extension.path, EXTENSION_MANIFEST);
        const row = db.upsertExtension({
          id: nextExtensionId,
          name: extension.manifest.name,
          version: extension.manifest.version,
          scope: 'user',
          source,
          manifest: { ...extension.manifest, path: source },
          enabled,
          trusted: true,
          contentHash: extension.treeSha256,
          origin: 'plugin',
          ownerPluginId: manifest.id,
          managed: true,
          userOverride: false,
        });
        installedExtension.push(nextExtensionId);
        const oldNames = previousExtensions.find(item => item.id === row.id)?.manifest.contributes?.tools?.map(tool => tool.name) || [];
        const names = provides.extension.tools;
        syncPluginTools(db, row, names.filter(name => !oldNames.includes(name)), oldNames.filter(name => !names.includes(name)));
      }
    });
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    if (replacement) fs.renameSync(replacement, target);
    throw error;
  }

  prepared.delete(token);
  fs.rmSync(pending.quarantine, { recursive: true, force: true });
  if (replacement) fs.rmSync(replacement, { recursive: true, force: true });

  // Drop older version directory when id/version path changed.
  if (previousPath && path.resolve(previousPath) !== path.resolve(target) && fs.existsSync(previousPath)) {
    fs.rmSync(previousPath, { recursive: true, force: true });
  }

  return {
    plugin: withIcon(db.getPlugin(manifest.id)),
    installed: {
      mcp: installedMcp,
      skills: installedSkills,
      extension: installedExtension,
      cli: provides.cli.map((item) => item.id),
    },
  };
}

function uninstallPlugin(id, options = {}) {
  const db = getStudioDatabase();
  const plugin = db.getPlugin(id);
  if (!plugin) throw pluginError('NOT_FOUND', `插件未安装：${id}`);
  const keepOverrides = options.keepOverrides !== false;
  const removed = { mcp: [], skills: [], extension: [], skipped: [] };

  db.transaction(() => {
    for (const server of db.listMcpServers()) {
      if (server.ownerPluginId !== id) continue;
      if (server.managed && !(keepOverrides && server.userOverride)) {
        db.removeMcpServer(server.name);
        removed.mcp.push(server.name);
      } else {
        removed.skipped.push({ kind: 'mcp', name: server.name });
      }
    }
    for (const skill of db.listSkillInstallations()) {
      if (skill.ownerPluginId !== id) continue;
      if (skill.managed && !(keepOverrides && skill.userOverride)) {
        db.removeSkillInstallation(skill.path);
        fs.rmSync(skill.path, { recursive: true, force: true });
        removed.skills.push(skill.name);
      } else {
        removed.skipped.push({ kind: 'skill', name: skill.name });
      }
    }
    for (const extension of db.listExtensions()) {
      if (extension.ownerPluginId !== id) continue;
      if (extension.managed && !(keepOverrides && extension.userOverride)) {
        db.removeExtension(extension.id);
        syncPluginTools(db, extension, [], extension.manifest.contributes?.tools?.map(tool => tool.name) || []);
        removed.extension.push(extension.id);
      } else {
        removed.skipped.push({ kind: 'extension', id: extension.id });
      }
    }
    db.removePlugin(id);
  });

  if (plugin.installPath && fs.existsSync(plugin.installPath)) {
    fs.rmSync(plugin.installPath, { recursive: true, force: true });
  }
  const idRoot = path.join(pluginsRoot(), id);
  if (fs.existsSync(idRoot)) {
    // remove empty version parents
    try {
      const entries = fs.readdirSync(idRoot);
      if (entries.length === 0 || (entries.length === 1 && entries[0] === 'skills')) {
        fs.rmSync(idRoot, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }
  return { id, removed };
}

function setPluginEnabled(id, enabled) {
  const db = getStudioDatabase();
  const plugin = db.setPluginEnabled(id, enabled);
  if (!plugin) throw pluginError('NOT_FOUND', `插件未安装：${id}`);
  // Soft disable: disable managed MCP; skills stay on disk but can be filtered later.
  for (const server of db.listMcpServers()) {
    if (server.ownerPluginId === id && server.managed && !server.userOverride) {
      db.setMcpEnabled(server.name, enabled);
    }
  }
  for (const extension of db.listExtensions()) {
    if (extension.ownerPluginId === id && extension.managed && !extension.userOverride) {
      db.setExtensionEnabled(extension.id, enabled);
    }
  }
  return withIcon(plugin);
}

function listInstalledPlugins() {
  return getStudioDatabase().listPlugins().map(withIcon);
}

function pluginPathEnvPrefixes() {
  const prefixes = [];
  for (const plugin of getStudioDatabase().listPlugins()) {
    if (!plugin.enabled) continue;
    for (const cli of plugin.provides?.cli || []) {
      if (!cli.pathEnv) continue;
      if (cli.kind === 'bundled' && cli.absoluteBin) {
        prefixes.push(path.dirname(cli.absoluteBin));
      }
    }
  }
  return [...new Set(prefixes.filter(Boolean))];
}

function disposePreparedPlugin(token) {
  if (typeof token === 'string' && token) cleanupPrepared(token);
  return { ok: true };
}

module.exports = {
  preparePluginInstall,
  installPreparedPlugin,
  uninstallPlugin,
  setPluginEnabled,
  listInstalledPlugins,
  pluginPathEnvPrefixes,
  disposePreparedPlugin,
  pluginsRoot,
  MANIFEST_NAME,
};

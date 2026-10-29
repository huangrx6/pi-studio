'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateExtensionDirectory } = require('../core/extension-package.cjs');
const { compareSemver } = require('../core/extension-semver.cjs');

const SETTINGS_KEY = 'studio.officialExtensions';
const PREFERENCES_VERSION = 1;

function stringListDiff(previousValues, nextValues) {
  const previous = new Set(previousValues || []);
  return [...new Set(nextValues || [])].filter((value) => !previous.has(value));
}

function installedCapabilities(distribution, id) {
  try {
    const installed = distribution.getInstalled(id, 'user');
    if (!installed) return undefined;
    const readManifest = typeof distribution.getInstalledCapabilityManifest === 'function'
      ? distribution.getInstalledCapabilityManifest.bind(distribution)
      : distribution.getInstalledManifest?.bind(distribution);
    if (readManifest) {
      const manifest = readManifest(id, 'user');
      return manifest ? { ...installed, ...manifest } : installed;
    }
    return installed;
  } catch {
    return undefined;
  }
}

function normalizePreferences(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const autoUpdate = {};
  for (const [id, enabled] of Object.entries(source.autoUpdate || {})) {
    if (
      /^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)
      && typeof enabled === 'boolean'
    ) {
      autoUpdate[id] = enabled;
    }
  }
  return {
    schemaVersion: PREFERENCES_VERSION,
    autoUpdate,
  };
}

function catalogEntries(root, normalizeManifest) {
  if (!root || !fs.existsSync(root)) {
    return { entries: [], errors: [] };
  }
  const entries = [];
  const errors = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const directory = path.join(root, item.name);
    try {
      const validated = validateExtensionDirectory(directory, {
        scope: 'user',
        integrity: 'required',
        requirePublisher: true,
        normalizeManifest,
      });
      if (validated.manifest.id !== item.name) {
        throw new Error(`官方目录名 ${item.name} 与 manifest id ${validated.manifest.id} 不一致`);
      }
      entries.push({
        directory,
        manifest: validated.manifest,
        sha256: validated.treeSha256,
      });
    } catch (error) {
      errors.push({
        id: item.name,
        path: directory,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { entries, errors };
}

class OfficialExtensionService {
  constructor(options = {}) {
    if (!options.distribution) throw new Error('OfficialExtensionService 需要 extension distribution');
    if (!options.database) throw new Error('OfficialExtensionService 需要 Studio database');
    if (typeof options.normalizeManifest !== 'function') {
      throw new Error('OfficialExtensionService 需要 manifest normalizer');
    }
    this.distribution = options.distribution;
    this.database = options.database;
    this.normalizeManifest = options.normalizeManifest;
    this.root = options.root ? path.resolve(options.root) : '';
  }

  preferences() {
    return normalizePreferences(this.database.getSetting(SETTINGS_KEY, undefined));
  }

  savePreferences(preferences) {
    return this.database.setSetting(SETTINGS_KEY, normalizePreferences(preferences));
  }

  scan() {
    return catalogEntries(this.root, this.normalizeManifest);
  }

  snapshot() {
    const preferences = this.preferences();
    const scanned = this.scan();
    const extensions = scanned.entries.map(({ manifest, sha256 }) => {
      const installed = installedCapabilities(this.distribution, manifest.id);
      const officialManaged = installed?.sourceKind === 'official';
      const installedVersion = installed?.version;
      const updateAvailable = Boolean(
        officialManaged
        && installedVersion
        && compareSemver(manifest.version, installedVersion) > 0,
      );
      const previousManifest = officialManaged && installed?.permissions ? installed : undefined;
      const addedPermissions = previousManifest
        ? stringListDiff(previousManifest.permissions, manifest.permissions)
        : manifest.permissions;
      const addedProviderAccess = previousManifest
        ? stringListDiff(previousManifest.providerAccess, manifest.providerAccess)
        : [...(manifest.providerAccess || [])];
      const addedRequirements = previousManifest
        ? stringListDiff(previousManifest.requires, manifest.requires)
        : [...(manifest.requires || [])];
      const executableExpansion = Boolean(
        previousManifest
        && !previousManifest.runtime?.durableEntry
        && manifest.runtime?.durableEntry
      );
      const requiresCapabilityConsent = updateAvailable && (
        addedPermissions.length > 0
        || addedProviderAccess.length > 0
        || addedRequirements.length > 0
        || executableExpansion
      );
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        publisher: manifest.publisher,
        author: manifest.author,
        repository: manifest.repository,
        homepage: manifest.homepage,
        keywords: manifest.keywords,
        permissions: manifest.permissions,
        providerAccess: manifest.providerAccess,
        requires: manifest.requires,
        executable: Boolean(manifest.runtime?.durableEntry),
        sha256,
        installed: Boolean(installed),
        officialManaged,
        installedVersion,
        updateAvailable,
        autoUpdate: preferences.autoUpdate[manifest.id] ?? true,
        requiresPermissionConsent: updateAvailable && addedPermissions.length > 0,
        requiresCapabilityConsent,
        addedPermissions,
        addedProviderAccess,
        addedRequirements,
        executableExpansion,
      };
    });
    return {
      extensions,
      errors: scanned.errors,
      updatedAt: Date.now(),
    };
  }

  setAutoUpdate(id, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('自动更新设置必须是布尔值');
    const catalog = this.scan().entries.find((entry) => entry.manifest.id === id);
    if (!catalog) throw new Error(`官方扩展不存在：${id}`);
    const preferences = this.preferences();
    preferences.autoUpdate[id] = enabled;
    this.savePreferences(preferences);
    return this.snapshot().extensions.find((item) => item.id === id);
  }

  prepare(id) {
    const catalog = this.scan().entries.find((entry) => entry.manifest.id === id);
    if (!catalog) throw new Error(`官方扩展不存在：${id}`);
    return this.distribution.prepare(`official:${id}`, {
      scope: 'user',
    });
  }

  async autoUpdate() {
    const preferences = this.preferences();
    const results = [];
    for (const item of this.snapshot().extensions) {
      if (
        !item.updateAvailable
        || !item.officialManaged
        || !(preferences.autoUpdate[item.id] ?? true)
      ) continue;
      const preview = await this.prepare(item.id);
      try {
        if (
          preview.addedPermissions.length > 0
          || (preview.addedProviderAccess || []).length > 0
          || (preview.addedRequirements || []).length > 0
          || preview.executableExpansion === true
          || preview.missingDependencies.length > 0
          || preview.requiresCapabilityConsent
        ) {
          results.push({
            id: item.id,
            status: 'consent-required',
            version: preview.version,
            permissions: preview.addedPermissions,
            providerAccess: preview.addedProviderAccess,
            requirements: preview.addedRequirements,
            executableExpansion: preview.executableExpansion,
            missingDependencies: preview.missingDependencies,
          });
          continue;
        }
        const installed = await this.distribution.installPrepared(preview.token, {
          scope: 'user',
          acceptedPermissions: [],
          acceptedProviderAccess: [],
          acceptedRequirements: false,
          acceptedExecution: false,
          trusted: true,
        });
        results.push({
          id: item.id,
          status: 'updated',
          version: installed.version,
        });
      } finally {
        this.distribution.disposePrepared(preview.token, {
          allowClaimed: true,
        });
      }
    }
    return {
      results,
      updated: results.filter((item) => item.status === 'updated').map((item) => item.id),
    };
  }
}

function createOfficialExtensionService(options) {
  return new OfficialExtensionService(options);
}

module.exports = {
  OfficialExtensionService,
  SETTINGS_KEY,
  createOfficialExtensionService,
  normalizePreferences,
};

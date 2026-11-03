/**
 * Same-version rebuild detection for electron-updater.
 *
 * electron-updater compares semver before exposing its provider result and
 * deliberately treats equal versions as "up to date". Studio still uses that
 * updater for signed downloads and installation, but wraps its availability
 * decision with a build id comparison from the app resources and latest YAML.
 */

const fs = require('node:fs');
const path = require('node:path');

const BUILD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,79}$/i;

function validBuildId(value) {
  return typeof value === 'string' && BUILD_ID_PATTERN.test(value.trim())
    ? value.trim()
    : undefined;
}

function normalizeVersion(value) {
  return typeof value === 'string' ? value.trim().replace(/^v/i, '') : '';
}

function readInstalledBuildIdentity(resourcesPath) {
  if (typeof resourcesPath !== 'string' || !resourcesPath) return {};
  const file = path.join(resourcesPath, 'pi-studio-build.json');
  try {
    const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      buildId: validBuildId(identity.buildId),
      commit: typeof identity.commit === 'string' ? identity.commit : undefined,
      version: typeof identity.version === 'string' ? identity.version : undefined,
    };
  } catch {
    // Builds created before build-aware updates have no local identity. The
    // first stamped release deliberately prompts them once.
    return {};
  }
}

function isSameVersionBuildUpdate(info, currentVersion, currentBuildId) {
  const remoteVersion = normalizeVersion(info?.version);
  const remoteBuildId = validBuildId(info?.buildId);
  const localVersion = normalizeVersion(currentVersion);
  const localBuildId = validBuildId(currentBuildId);
  return Boolean(
    remoteVersion
    && remoteVersion === localVersion
    && remoteBuildId
    && remoteBuildId !== localBuildId,
  );
}

function attachBuildAwareUpdateCheck(updater, {
  currentVersion,
  getCurrentBuildId = () => undefined,
  log = () => {},
} = {}) {
  const standardIsUpdateAvailable = updater.isUpdateAvailable.bind(updater);
  updater.isUpdateAvailable = async (info) => {
    if (await standardIsUpdateAvailable(info)) return true;
    const sameVersionBuild = isSameVersionBuildUpdate(
      info,
      currentVersion,
      getCurrentBuildId(),
    );
    if (sameVersionBuild) {
      // electron-updater returns before platform and rollout checks when semver
      // is equal, so preserve those safeguards for a same-version rebuild.
      if (typeof updater.isUpdateSupported === 'function'
        && !(await Promise.resolve(updater.isUpdateSupported(info)))) {
        return false;
      }
      if (typeof updater.isUserWithinRollout === 'function'
        && !(await Promise.resolve(updater.isUserWithinRollout(info)))) {
        return false;
      }
      log(`same-version rebuild ${info.buildId} is available for ${info.version}`);
    }
    return sameVersionBuild;
  };
  return updater;
}

module.exports = {
  BUILD_ID_PATTERN,
  attachBuildAwareUpdateCheck,
  isSameVersionBuildUpdate,
  normalizeVersion,
  readInstalledBuildIdentity,
  validBuildId,
};

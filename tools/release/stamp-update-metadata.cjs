/**
 * Add the distribution build id to electron-builder's updater manifest.
 * electron-updater preserves unknown YAML keys in UpdateInfo, and the Studio
 * updater reads this field after its normal semver comparison.
 */

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { ensureBuildIdentity, validBuildId } = require('./build-identity.cjs');

function stampUpdateMetadata(source, buildId) {
  const normalized = validBuildId(buildId);
  if (!normalized) throw new Error('更新构建标识无效');
  const document = YAML.parseDocument(source);
  if (document.errors.length > 0) throw document.errors[0];
  document.set('buildId', normalized);
  return document.toString({ lineWidth: 0 });
}

function packagedBuildId(root) {
  const candidates = [
    path.join(root, 'release', 'mac-arm64', 'Pi Studio.app', 'Contents', 'Resources', 'pi-studio-build.json'),
    path.join(root, 'release', 'mac', 'Pi Studio.app', 'Contents', 'Resources', 'pi-studio-build.json'),
  ];
  for (const candidate of candidates) {
    try {
      const identity = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const buildId = validBuildId(identity.buildId);
      if (buildId) return buildId;
    } catch {
      // Fall through to the other architecture or the explicit environment id.
    }
  }
  return undefined;
}

function stampUpdateMetadataFiles(root = process.cwd(), explicitBuildId) {
  const releaseDirectory = path.join(root, 'release');
  const buildId = validBuildId(explicitBuildId)
    || validBuildId(process.env.PI_STUDIO_BUILD_ID)
    || packagedBuildId(root)
    || ensureBuildIdentity(root).buildId;
  const files = fs.readdirSync(releaseDirectory)
    .filter((name) => /^latest.*\.ya?ml$/i.test(name))
    .map((name) => path.join(releaseDirectory, name));
  if (files.length === 0) throw new Error('没有找到 electron-builder 更新元数据');
  for (const file of files) {
    fs.writeFileSync(file, stampUpdateMetadata(fs.readFileSync(file, 'utf8'), buildId));
  }
  return { buildId, files };
}

if (require.main === module) {
  const result = stampUpdateMetadataFiles();
  for (const file of result.files) process.stdout.write(`Stamped ${file} with build ${result.buildId}\n`);
}

module.exports = {
  packagedBuildId,
  stampUpdateMetadata,
  stampUpdateMetadataFiles,
};

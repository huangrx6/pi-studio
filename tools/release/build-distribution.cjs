/**
 * Build both macOS architectures with one build id, then stamp updater
 * metadata so the same-version update check can compare future rebuilds.
 */

const { spawnSync } = require('node:child_process');
const { ensureBuildIdentity } = require('./build-identity.cjs');
const { stampUpdateMetadataFiles } = require('./stamp-update-metadata.cjs');

const root = process.cwd();
const identity = ensureBuildIdentity(root);
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(
  command,
  ['exec', 'electron-builder', '--mac', '--arm64', '--x64', '--publish', 'never'],
  {
    cwd: root,
    env: {
      ...process.env,
      PI_STUDIO_BUILD_ID: identity.buildId,
      PI_STUDIO_BUILD_NUMBER: identity.buildNumber,
      BUILD_NUMBER: identity.buildNumber,
    },
    stdio: 'inherit',
  },
);
if (result.status !== 0) process.exit(result.status || 1);
stampUpdateMetadataFiles(root, identity.buildId);

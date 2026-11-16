const { Arch, Platform, build } = require('electron-builder');
const { ensureBuildIdentity } = require('./build-identity.cjs');
const { stampUpdateMetadataFiles } = require('./stamp-update-metadata.cjs');

async function buildDistribution() {
  const root = process.cwd();
  const identity = ensureBuildIdentity(root);
  const windows = process.platform === 'win32';
  await build({
    targets: windows
      ? Platform.WINDOWS.createTarget('nsis', Arch.x64)
      : Platform.MAC.createTarget(null, Arch.arm64, Arch.x64),
    publish: 'never',
    config: windows ? {
      // node-pty ships Windows x64 Node-API binaries and ConPTY with the pinned package.
      npmRebuild: false,
      // Each Windows version component is 16-bit. Studio keeps the full build ID in resources.
      buildNumber: '0',
      win: {
        icon: 'assets/icon.png',
        artifactName: 'Pi-Studio-${version}-Windows-${arch}-Setup.${ext}',
      },
    } : undefined,
  });
  stampUpdateMetadataFiles(root, identity.buildId, windows ? 'win32' : 'darwin');
}

buildDistribution().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

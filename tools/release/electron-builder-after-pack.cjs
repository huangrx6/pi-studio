const fs = require('node:fs');
const path = require('node:path');
const { signAsync } = require('@electron/osx-sign');
const { ensurePtyHelpers } = require('../pty/ensure-executable.cjs');
const { ensureBuildIdentity } = require('./build-identity.cjs');

/**
 * Sign both architectures after Electron Builder has assembled their bundles.
 * The stable self-signed identity is deliberately supplied to osx-sign instead
 * of Electron Builder's certificate importer, which requires macOS to report
 * the identity as globally trusted before Squirrel.Mac needs it.
 */
exports.default = async function signPackagedMacApp(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const signingIdentity = process.env.PI_STUDIO_CODESIGN_IDENTITY || 'Pi Studio Self Signed';
  const keychain = process.env.PI_STUDIO_SIGNING_KEYCHAIN;
  if (!keychain) {
    throw new Error('PI_STUDIO_SIGNING_KEYCHAIN is required for a signed macOS package.');
  }

  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const buildIdentity = ensureBuildIdentity(process.cwd());
  fs.writeFileSync(
    path.join(app, 'Contents', 'Resources', 'pi-studio-build.json'),
    `${JSON.stringify({
      version: context.packager.appInfo.version,
      buildId: buildIdentity.buildId,
      buildNumber: buildIdentity.buildNumber,
      nativeBuildVersion: context.packager.appInfo.buildVersion,
      commit: buildIdentity.commit,
    }, null, 2)}\n`,
  );
  ensurePtyHelpers(path.join(
    app,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
  ));

  await signAsync({
    app,
    identity: signingIdentity,
    keychain,
    platform: 'darwin',
    type: 'development',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: false,
    timestamp: 'none',
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
  });
};

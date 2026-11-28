const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { signAsync } = require('@electron/osx-sign');
const { ensurePtyHelpers } = require('../pty/ensure-executable.cjs');
const { ensureBuildIdentity } = require('./build-identity.cjs');

/**
 * Store the identity used by the platform's update feed in the finished app.
 * On macOS, sign the complete bundle with the stable Squirrel.Mac identity.
 */
exports.default = async function preparePackagedApp(context) {
  const platform = context.electronPlatformName;
  if (platform !== 'darwin' && platform !== 'win32') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = platform === 'win32'
    ? path.join(context.appOutDir, 'resources')
    : path.join(app, 'Contents', 'Resources');
  const buildIdentity = ensureBuildIdentity(process.cwd());
  fs.writeFileSync(
    path.join(resources, 'pi-studio-build.json'),
    `${JSON.stringify({
      version: context.packager.appInfo.version,
      buildId: buildIdentity.buildId,
      buildNumber: buildIdentity.buildNumber,
      nativeBuildVersion: context.packager.appInfo.buildVersion,
      commit: buildIdentity.commit,
    }, null, 2)}\n`,
  );
  if (platform === 'win32') return;

  const signingIdentity = process.env.PI_STUDIO_CODESIGN_IDENTITY || 'Pi Studio Self Signed';
  const keychain = process.env.PI_STUDIO_SIGNING_KEYCHAIN;
  if (!keychain) {
    throw new Error('PI_STUDIO_SIGNING_KEYCHAIN is required for a signed macOS package.');
  }
  ensurePtyHelpers(path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty'));

  const targetArch = path.basename(context.appOutDir).includes('arm64')
    ? 'arm64'
    : (path.basename(context.appOutDir) === 'mac' ? 'x64' : (process.arch === 'x64' ? 'x64' : 'arm64'));
  const helpersDir = path.join(app, 'Contents', 'Helpers');
  fs.mkdirSync(helpersDir, { recursive: true });
  execFileSync(
    process.execPath,
    [
      path.join(process.cwd(), 'scripts', 'build', 'build-computer-use-helper.mjs'),
      '--out', helpersDir,
      '--arch', targetArch,
      '--force',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        PI_STUDIO_CODESIGN_IDENTITY: signingIdentity,
        PI_STUDIO_SIGNING_KEYCHAIN: keychain,
      },
    },
  );

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

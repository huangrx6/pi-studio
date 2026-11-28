#!/usr/bin/env node
/**
 * Build and sign the standalone macOS "Pi Studio Computer Use.app" helper bundle.
 *
 * Used in both local dev (`pnpm dev` / `pnpm start`) and macOS release packaging so
 * TCC permissions (Screen Recording & Accessibility) always bind to the dedicated
 * `dev.pi.studio.computer-use` helper instead of the entire Electron app.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const HELPER_APP_NAME = 'Pi Studio Computer Use.app';
const HELPER_DISPLAY_NAME = 'Pi Studio Computer Use';
const HELPER_EXECUTABLE_NAME = 'PiStudioComputerUse';
const HELPER_BUNDLE_ID = 'dev.pi.studio.computer-use';

const SOURCE_FILES = ['main.swift', 'WindowRestoration.swift'].map(name => path.join(__dirname, 'computer-use-helper', name));
const ICON_FILE = path.join(REPO_ROOT, 'assets', 'icon.icns');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'dist', 'computer-use');

function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    arch: process.arch === 'x64' ? 'x64' : 'arm64',
    force: false,
    quiet: false,
    skipSign: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      options.outDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--arch' && argv[i + 1]) {
      const value = argv[i + 1].trim().toLowerCase();
      if (value === 'x64' || value === 'x86_64') options.arch = 'x64';
      else if (value === 'arm64') options.arch = 'arm64';
      i += 1;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--skip-sign') {
      options.skipSign = true;
    }
  }
  return options;
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    return String(pkg.version || '0.0.1');
  } catch {
    return '0.0.1';
  }
}

function resolveLocalSelfSignedMaterial() {
  const identity = process.env.PI_STUDIO_CODESIGN_IDENTITY || 'Pi Studio Self Signed';
  const keychain = process.env.PI_STUDIO_SIGNING_KEYCHAIN || '';
  if (keychain) {
    return { mode: 'keychain', identity, keychain };
  }
  const certPath = path.resolve(
    REPO_ROOT,
    process.env.PI_STUDIO_SIGNING_CERTIFICATE || '.release-signing/pi-studio-self-signed.p12',
  );
  const passwordPath = path.resolve(
    REPO_ROOT,
    process.env.PI_STUDIO_SIGNING_PASSWORD_FILE || '.release-signing/pi-studio-self-signed-password.txt',
  );
  if (fs.existsSync(certPath) && fs.existsSync(passwordPath)) {
    return { mode: 'p12', identity, certPath, passwordPath };
  }
  return { mode: 'adhoc', identity: '-' };
}

function computeInputFingerprint(arch, version, signing) {
  const hash = crypto.createHash('sha256');
  hash.update(`arch:${arch}\n`);
  hash.update(`version:${version}\n`);
  hash.update(`bundleId:${HELPER_BUNDLE_ID}\n`);
  hash.update(`signing:${signing.mode}:${signing.identity}\n`);
  for (const file of SOURCE_FILES) hash.update(fs.readFileSync(file));
  if (fs.existsSync(ICON_FILE)) {
    hash.update(fs.readFileSync(ICON_FILE));
  }
  if (signing.mode === 'p12' && signing.certPath && fs.existsSync(signing.certPath)) {
    hash.update(fs.readFileSync(signing.certPath));
  }
  return hash.digest('hex');
}

function isExistingBuildValid(appBundlePath, expectedFingerprint, skipSign) {
  const stampPath = path.join(appBundlePath, 'Contents', 'Resources', 'helper-build.json');
  const execPath = path.join(appBundlePath, 'Contents', 'MacOS', HELPER_EXECUTABLE_NAME);
  if (!fs.existsSync(stampPath) || !fs.existsSync(execPath)) return false;
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    if (stamp.fingerprint !== expectedFingerprint) return false;
  } catch {
    return false;
  }
  if (skipSign) return true;
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundlePath], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function renderInfoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>${HELPER_DISPLAY_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${HELPER_EXECUTABLE_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${HELPER_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${HELPER_DISPLAY_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSScreenCaptureUsageDescription</key>
  <string>Pi Studio Computer Use 需要屏幕录制权限，用于截取你授权的应用窗口。</string>
  <key>NSAccessibilityUsageDescription</key>
  <string>Pi Studio Computer Use 需要辅助功能权限，用于读取已授权应用的界面结构并执行点击与输入操作。</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>Pi Studio Computer Use 需要自动化权限，用于通过系统事件观察和操作你授权的应用窗口。</string>
</dict>
</plist>
`;
}

function signBundle(appBundlePath, signing) {
  if (signing.mode === 'keychain') {
    execFileSync('/usr/bin/codesign', [
      '--force',
      '--deep',
      '--sign', signing.identity,
      '--keychain', signing.keychain,
      '--timestamp=none',
      appBundlePath,
    ], { stdio: 'pipe' });
    return;
  }

  if (signing.mode === 'p12') {
    const certPassword = fs.readFileSync(signing.passwordPath, 'utf8').replace(/[\r\n]+$/g, '');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-helper-sign-'));
    const tempKeychain = path.join(tempDir, 'helper-signing.keychain-db');
    const keychainPassword = crypto.randomBytes(24).toString('hex');
    const previousKeychains = execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);

    try {
      execFileSync('/usr/bin/security', ['create-keychain', '-p', keychainPassword, tempKeychain], { stdio: 'pipe' });
      execFileSync('/usr/bin/security', ['unlock-keychain', '-p', keychainPassword, tempKeychain], { stdio: 'pipe' });
      execFileSync('/usr/bin/security', ['set-keychain-settings', '-lut', '3600', tempKeychain], { stdio: 'pipe' });
      execFileSync('/usr/bin/security', [
        'import', signing.certPath,
        '-f', 'pkcs12',
        '-k', tempKeychain,
        '-P', certPassword,
        '-T', '/usr/bin/codesign',
      ], { stdio: 'pipe' });
      execFileSync('/usr/bin/security', [
        'set-key-partition-list',
        '-S', 'apple-tool:,apple:,codesign:',
        '-s',
        '-k', keychainPassword,
        tempKeychain,
      ], { stdio: 'pipe' });
      execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', tempKeychain, ...previousKeychains], { stdio: 'pipe' });
      execFileSync('/usr/bin/codesign', [
        '--force',
        '--deep',
        '--sign', signing.identity,
        '--keychain', tempKeychain,
        '--timestamp=none',
        appBundlePath,
      ], { stdio: 'pipe' });
    } finally {
      try {
        if (previousKeychains.length > 0) {
          execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...previousKeychains], { stdio: 'ignore' });
        }
      } catch {
        /* best effort */
      }
      try {
        execFileSync('/usr/bin/security', ['delete-keychain', tempKeychain], { stdio: 'ignore' });
      } catch {
        /* best effort */
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return;
  }

  // Ad-hoc fallback when no self-signed release certificate is present yet.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundlePath], { stdio: 'pipe' });
}

export function buildComputerUseHelper(rawOptions = {}) {
  if (process.platform !== 'darwin') {
    return { skipped: true, reason: 'non-darwin' };
  }

  const options = {
    outDir: DEFAULT_OUT_DIR,
    arch: process.arch === 'x64' ? 'x64' : 'arm64',
    force: false,
    quiet: false,
    skipSign: false,
    ...rawOptions,
  };

  const version = readPackageVersion();
  const signing = resolveLocalSelfSignedMaterial();
  const appBundlePath = path.join(options.outDir, HELPER_APP_NAME);
  const fingerprint = computeInputFingerprint(options.arch, version, signing);

  if (!options.force && isExistingBuildValid(appBundlePath, fingerprint, options.skipSign)) {
    return {
      built: false,
      appBundlePath,
      signingMode: signing.mode,
      identity: signing.identity,
    };
  }

  const contentsDir = path.join(appBundlePath, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const executablePath = path.join(macOsDir, HELPER_EXECUTABLE_NAME);

  fs.rmSync(appBundlePath, { recursive: true, force: true });
  fs.mkdirSync(macOsDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  const swiftTarget = options.arch === 'x64' ? 'x86_64-apple-macosx13.0' : 'arm64-apple-macosx13.0';
  const moduleCachePath = path.join(os.tmpdir(), 'pi-studio-swift-module-cache');
  fs.mkdirSync(moduleCachePath, { recursive: true });
  execFileSync('/usr/bin/swiftc', [
    '-O',
    '-target', swiftTarget,
    '-module-cache-path', moduleCachePath,
    '-framework', 'Foundation',
    '-framework', 'AppKit',
    '-framework', 'CoreGraphics',
    '-framework', 'ApplicationServices',
    '-framework', 'ImageIO',
    '-framework', 'UniformTypeIdentifiers',
    '-framework', 'ScreenCaptureKit',
    ...SOURCE_FILES,
    '-o', executablePath,
  ], {
    stdio: options.quiet ? 'pipe' : 'inherit',
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: moduleCachePath,
    },
  });
  fs.chmodSync(executablePath, 0o755);

  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), renderInfoPlist(version), 'utf8');
  if (fs.existsSync(ICON_FILE)) {
    fs.copyFileSync(ICON_FILE, path.join(resourcesDir, 'AppIcon.icns'));
  }
  fs.writeFileSync(
    path.join(resourcesDir, 'helper-build.json'),
    `${JSON.stringify({
      name: HELPER_DISPLAY_NAME,
      bundleId: HELPER_BUNDLE_ID,
      arch: options.arch,
      version,
      signingMode: signing.mode,
      identity: signing.identity,
      fingerprint,
    }, null, 2)}\n`,
    'utf8',
  );

  if (!options.skipSign) {
    signBundle(appBundlePath, signing);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundlePath], { stdio: 'pipe' });
  }

  if (!options.quiet) {
    console.log(`[computer-use] Built ${appBundlePath} (${options.arch}, sign=${signing.mode})`);
  }

  return {
    built: true,
    appBundlePath,
    signingMode: signing.mode,
    identity: signing.identity,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    buildComputerUseHelper(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`[computer-use] Build failed: ${error && error.message ? error.message : error}`);
    process.exit(1);
  }
}

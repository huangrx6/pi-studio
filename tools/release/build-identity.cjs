/**
 * Stable identity for one distribution build.
 *
 * The semantic version intentionally stays user-facing. A unique build id
 * lets the updater distinguish a rebuild of the same version while preserving
 * electron-builder's standard signed ZIP / Squirrel.Mac installation path.
 */

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BUILD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,79}$/i;
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

function validBuildId(value) {
  return typeof value === 'string' && BUILD_ID_PATTERN.test(value.trim())
    ? value.trim()
    : undefined;
}

function gitText(root, args, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd: root,
    encoding,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sourceTreeHash(root) {
  const head = String(gitText(root, ['rev-parse', 'HEAD'])).trim();
  const diff = gitText(root, ['diff', 'HEAD', '--binary', '--no-ext-diff'], 'buffer');
  const untracked = String(gitText(root, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean)
    .sort();
  const hash = createHash('sha256');
  hash.update(head);
  hash.update('\0');
  hash.update(diff);
  for (const relativePath of untracked) {
    const absolutePath = path.resolve(root, relativePath);
    const withinRoot = path.relative(root, absolutePath);
    if (withinRoot.startsWith('..') || path.isAbsolute(withinRoot)) continue;
    hash.update('\0');
    hash.update(relativePath);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(absolutePath));
    } catch {
      hash.update('[unreadable]');
    }
  }
  return { head, sourceHash: hash.digest('hex') };
}

function buildNumberAt(now) {
  return new Date(now).toISOString().replace(/\D/g, '').slice(0, 14);
}

function computeBuildIdentity(root = process.cwd(), { now = Date.now() } = {}) {
  const { head, sourceHash } = sourceTreeHash(root);
  // Every published build is unique even when the same source commit is
  // packaged again. The id is not a security boundary; artifact sha512 and
  // code signing remain the integrity checks.
  const buildId = createHash('sha256')
    .update(`${head}\0${sourceHash}\0${now}`)
    .digest('hex')
    .slice(0, 16);
  const buildNumber = buildNumberAt(now);
  return {
    buildId,
    buildNumber,
    commit: head.slice(0, 12),
    sourceHash: sourceHash.slice(0, 16),
  };
}

function ensureBuildIdentity(root = process.cwd()) {
  const explicit = validBuildId(process.env.PI_STUDIO_BUILD_ID);
  const explicitBuildNumber = /^\d{1,18}$/.test(process.env.PI_STUDIO_BUILD_NUMBER || '')
    ? process.env.PI_STUDIO_BUILD_NUMBER
    : undefined;
  if (explicit) {
    const commit = sourceTreeHash(root).head.slice(0, 12);
    const buildNumber = explicitBuildNumber || buildNumberAt(Date.now());
    process.env.PI_STUDIO_BUILD_ID = explicit;
    process.env.PI_STUDIO_BUILD_NUMBER = buildNumber;
    process.env.BUILD_NUMBER = buildNumber;
    return { buildId: explicit, buildNumber, commit };
  }
  const identity = computeBuildIdentity(root);
  process.env.PI_STUDIO_BUILD_ID = identity.buildId;
  process.env.PI_STUDIO_BUILD_NUMBER = identity.buildNumber;
  process.env.BUILD_NUMBER = identity.buildNumber;
  return identity;
}

if (require.main === module) {
  process.stdout.write(computeBuildIdentity().buildId);
}

module.exports = {
  BUILD_ID_PATTERN,
  buildNumberAt,
  computeBuildIdentity,
  ensureBuildIdentity,
  sourceTreeHash,
  validBuildId,
};

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  readManifest,
  walkPackageFiles,
} = require('./extension-package.cjs');

const SIGNATURE_NAME = 'signature.json';
const SIGNATURE_SCHEMA_VERSION = 1;
const SIGNATURE_ALGORITHM = 'ed25519';
const MAX_SIGNATURE_FILE_BYTES = 16 * 1024;
const KEY_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const EXCLUDED_SIGNING_FILES = new Set([
  SIGNATURE_NAME,
  'integrity.json',
]);

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function decodeBase64(value, label) {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
    throw new Error(`${label} 必须是标准 Base64`);
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0 || buffer.toString('base64') !== value) {
    throw new Error(`${label} 不是规范 Base64`);
  }
  return buffer;
}

function normalizePublicKey(value) {
  let key;
  try {
    if (value?.key?.type === 'public' && value.key.asymmetricKeyType === 'ed25519') {
      key = value.key;
    } else if (value?.type === 'public' && value?.asymmetricKeyType === 'ed25519') {
      key = value;
    } else if (value?.der || value?.base64) {
      key = value.der
        ? crypto.createPublicKey({ key: value.der, format: 'der', type: 'spki' })
        : normalizePublicKey(value.base64).key;
    } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      const buffer = Buffer.from(value);
      key = buffer.toString('utf8').includes('-----BEGIN PUBLIC KEY-----')
        ? crypto.createPublicKey(buffer)
        : crypto.createPublicKey({ key: buffer, format: 'der', type: 'spki' });
    } else if (typeof value === 'string') {
      key = value.includes('-----BEGIN PUBLIC KEY-----')
        ? crypto.createPublicKey(value)
        : crypto.createPublicKey({
          key: decodeBase64(value, '扩展发布者公钥'),
          format: 'der',
          type: 'spki',
        });
    } else {
      throw new Error('扩展发布者公钥格式无效');
    }
  } catch (error) {
    if (error?.message?.includes('扩展发布者公钥')) throw error;
    throw new Error(`无法解析扩展发布者公钥：${error instanceof Error ? error.message : String(error)}`);
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('扩展发布者公钥必须是 Ed25519 公钥');
  }
  const der = key.export({ format: 'der', type: 'spki' });
  if (der.length > 4_096) throw new Error('扩展发布者公钥长度异常');
  return {
    key,
    der,
    base64: der.toString('base64'),
    keyId: `sha256:${crypto.createHash('sha256').update(der).digest('hex')}`,
  };
}

function normalizePrivateKey(value) {
  let key;
  try {
    key = value?.type === 'private' ? value : crypto.createPrivateKey(value);
  } catch (error) {
    throw new Error(`无法解析扩展签名私钥：${error instanceof Error ? error.message : String(error)}`);
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('扩展签名私钥必须是 Ed25519 私钥');
  }
  return key;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function signingFiles(root, options = {}) {
  return walkPackageFiles(root, options)
    .filter((file) => !EXCLUDED_SIGNING_FILES.has(file.path))
    .map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256 || sha256File(file.absolute),
    }));
}

function signingTreeDigest(files) {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return crypto.createHash('sha256').update(sorted.map((file) => (
    `${file.path}\0${file.size}\0${file.sha256}\n`
  )).join('')).digest('hex');
}

function signaturePayload({
  manifest,
  treeSha256,
  publicKey,
}) {
  const normalizedKey = normalizePublicKey(publicKey);
  return {
    schemaVersion: SIGNATURE_SCHEMA_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    extension: {
      id: manifest.id,
      version: manifest.version,
    },
    publisher: manifest.publisher,
    treeSha256,
    keyId: normalizedKey.keyId,
    publicKey: normalizedKey.base64,
  };
}

function createSignature({
  manifest,
  files,
  privateKey,
}) {
  const key = normalizePrivateKey(privateKey);
  const publicKey = crypto.createPublicKey(key);
  const treeSha256 = signingTreeDigest(files);
  const payload = signaturePayload({ manifest, treeSha256, publicKey });
  const message = Buffer.from(stableJson(payload));
  const signature = crypto.sign(null, message, key).toString('base64');
  return {
    ...payload,
    signature,
  };
}

function normalizeSignature(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('signature.json 必须是对象');
  }
  const allowed = new Set([
    'schemaVersion',
    'algorithm',
    'extension',
    'publisher',
    'treeSha256',
    'keyId',
    'publicKey',
    'signature',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`signature.json 包含未知字段：${key}`);
  }
  if (raw.schemaVersion !== SIGNATURE_SCHEMA_VERSION) {
    throw new Error(`不支持的 signature schemaVersion：${raw.schemaVersion}`);
  }
  if (raw.algorithm !== SIGNATURE_ALGORITHM) {
    throw new Error(`signature.algorithm 只支持 ${SIGNATURE_ALGORITHM}`);
  }
  if (!raw.extension || typeof raw.extension !== 'object' || Array.isArray(raw.extension)) {
    throw new Error('signature.extension 必须是对象');
  }
  for (const key of Object.keys(raw.extension)) {
    if (!['id', 'version'].includes(key)) {
      throw new Error(`signature.extension 包含未知字段：${key}`);
    }
  }
  if (typeof raw.extension.id !== 'string' || typeof raw.extension.version !== 'string') {
    throw new Error('signature.extension 必须包含 id 与 version');
  }
  if (typeof raw.publisher !== 'string' || !raw.publisher.trim()) {
    throw new Error('signature.publisher 不能为空');
  }
  if (typeof raw.treeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.treeSha256)) {
    throw new Error('signature.treeSha256 必须是 64 位十六进制字符串');
  }
  if (typeof raw.keyId !== 'string' || !KEY_ID_PATTERN.test(raw.keyId)) {
    throw new Error('signature.keyId 无效');
  }
  const publicKey = normalizePublicKey(raw.publicKey);
  if (publicKey.keyId !== raw.keyId) {
    throw new Error('signature.keyId 与公钥指纹不一致');
  }
  const signature = decodeBase64(raw.signature, 'extension signature.signature');
  if (signature.length !== 64) throw new Error('Ed25519 签名必须是 64 字节');
  return {
    schemaVersion: SIGNATURE_SCHEMA_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    extension: {
      id: raw.extension.id,
      version: raw.extension.version,
    },
    publisher: raw.publisher,
    treeSha256: raw.treeSha256,
    keyId: raw.keyId,
    publicKey: publicKey.base64,
    signature: signature.toString('base64'),
  };
}

function verifySignature({
  manifest,
  files,
  rawSignature,
  expectedPublicKey,
  expectedPublisher,
}) {
  const signature = normalizeSignature(rawSignature);
  if (signature.extension.id !== manifest.id || signature.extension.version !== manifest.version) {
    throw new Error('签名绑定的扩展 ID 或版本与 manifest 不一致');
  }
  if (signature.publisher !== manifest.publisher) {
    throw new Error('签名绑定的发布者与 manifest publisher 不一致');
  }
  if (expectedPublisher && signature.publisher !== expectedPublisher) {
    throw new Error('签名发布者与来源声明的 publisher 不一致');
  }
  const actualTreeSha256 = signingTreeDigest(files);
  if (signature.treeSha256 !== actualTreeSha256) {
    throw new Error('扩展内容与签名绑定的 tree SHA-256 不一致');
  }
  const publicKey = normalizePublicKey(signature.publicKey);
  let identityTrusted = false;
  if (expectedPublicKey !== undefined) {
    const expected = normalizePublicKey(expectedPublicKey);
    if (expected.keyId !== publicKey.keyId) {
      throw new Error('扩展签名公钥与受信任发布者公钥不一致');
    }
    identityTrusted = true;
  }
  const payload = signaturePayload({
    manifest,
    treeSha256: signature.treeSha256,
    publicKey,
  });
  const valid = crypto.verify(
    null,
    Buffer.from(stableJson(payload)),
    publicKey.key,
    Buffer.from(signature.signature, 'base64'),
  );
  if (!valid) throw new Error('扩展 Ed25519 签名无效');
  return {
    valid: true,
    identityTrusted,
    publisher: signature.publisher,
    keyId: signature.keyId,
    treeSha256: signature.treeSha256,
  };
}

function readSignature(directory) {
  const file = path.join(directory, SIGNATURE_NAME);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) throw new Error(`${SIGNATURE_NAME} 必须是普通文件`);
  if (stat.size > MAX_SIGNATURE_FILE_BYTES) {
    throw new Error(`${SIGNATURE_NAME} 超过 ${MAX_SIGNATURE_FILE_BYTES} 字节上限`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法解析 ${SIGNATURE_NAME}：${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeSignature(raw);
}

function writeSignature(directory, signature) {
  const normalized = normalizeSignature(signature);
  const file = path.join(directory, SIGNATURE_NAME);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o644,
  });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return normalized;
}

function signExtensionDirectory(directory, options = {}) {
  const scope = options.scope === 'project' ? 'project' : 'user';
  const { manifest } = readManifest(directory, scope, {
    requirePublisher: true,
    normalizeManifest: options.normalizeManifest,
  });
  const files = signingFiles(directory, options);
  const signature = createSignature({
    manifest,
    files,
    privateKey: options.privateKey,
  });
  writeSignature(directory, signature);
  return {
    signature,
    manifest,
    files,
    treeSha256: signature.treeSha256,
  };
}

function verifyExtensionDirectory(directory, options = {}) {
  const scope = options.scope === 'project' ? 'project' : 'user';
  const { manifest } = readManifest(directory, scope, {
    requirePublisher: true,
    normalizeManifest: options.normalizeManifest,
  });
  const rawSignature = readSignature(directory);
  if (!rawSignature) {
    if (options.required === true) throw new Error('扩展包缺少 signature.json');
    return {
      status: 'unsigned',
      manifest,
    };
  }
  const verification = verifySignature({
    manifest,
    files: signingFiles(directory, options),
    rawSignature,
    expectedPublicKey: options.expectedPublicKey,
    expectedPublisher: options.expectedPublisher,
  });
  return {
    status: verification.identityTrusted ? 'trusted' : 'valid',
    manifest,
    signature: rawSignature,
    verification,
  };
}

function publicKeyFingerprint(value) {
  return normalizePublicKey(value).keyId;
}

module.exports = {
  MAX_SIGNATURE_FILE_BYTES,
  SIGNATURE_ALGORITHM,
  SIGNATURE_NAME,
  SIGNATURE_SCHEMA_VERSION,
  createSignature,
  normalizePrivateKey,
  normalizePublicKey,
  normalizeSignature,
  publicKeyFingerprint,
  readSignature,
  signExtensionDirectory,
  signingFiles,
  signingTreeDigest,
  stableJson,
  verifyExtensionDirectory,
  verifySignature,
  writeSignature,
};

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizePublicKey,
} = require('./extension-signature.cjs');

const TRUST_STORE_VERSION = 1;
const TRUST_STORE_NAME = 'extension-publishers.json';
const MAX_PUBLISHERS = 512;
const MAX_KEYS_PER_PUBLISHER = 16;

class ExtensionTrustError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ExtensionTrustError';
    this.code = code;
    this.details = details;
  }
}

function trustError(code, message, details) {
  return new ExtensionTrustError(code, message, details);
}

function safePublisher(value) {
  if (typeof value !== 'string') return false;
  const clean = value.trim();
  return clean.length >= 1
    && clean.length <= 80
    && !/[\0-\x1f\x7f]/.test(clean);
}

function publisherKey(value) {
  if (!safePublisher(value)) throw trustError('INVALID_PUBLISHER', '扩展发布者名称无效');
  return value.trim().toLocaleLowerCase('en-US');
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function normalizeTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizeTrustStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw trustError('INVALID_TRUST_STORE', '扩展发布者信任库必须是对象');
  }
  for (const key of Object.keys(raw)) {
    if (!['schemaVersion', 'publishers'].includes(key)) {
      throw trustError('INVALID_TRUST_STORE', `信任库包含未知字段：${key}`);
    }
  }
  if (raw.schemaVersion !== TRUST_STORE_VERSION) {
    throw trustError('INVALID_TRUST_STORE', '扩展发布者信任库版本不受支持');
  }
  if (!Array.isArray(raw.publishers)) {
    throw trustError('INVALID_TRUST_STORE', 'trust.publishers 必须是数组');
  }
  if (raw.publishers.length > MAX_PUBLISHERS) {
    throw trustError('INVALID_TRUST_STORE', `信任库最多记录 ${MAX_PUBLISHERS} 个发布者`);
  }
  const publishers = new Map();
  for (const [publisherIndex, item] of raw.publishers.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw trustError('INVALID_TRUST_STORE', `publishers[${publisherIndex}] 必须是对象`);
    }
    for (const key of Object.keys(item)) {
      if (!['publisher', 'keys'].includes(key)) {
        throw trustError('INVALID_TRUST_STORE', `publishers[${publisherIndex}] 包含未知字段：${key}`);
      }
    }
    if (!safePublisher(item.publisher)) {
      throw trustError('INVALID_TRUST_STORE', `publishers[${publisherIndex}].publisher 无效`);
    }
    const normalizedPublisher = item.publisher.trim();
    const normalizedPublisherKey = publisherKey(normalizedPublisher);
    if (publishers.has(normalizedPublisherKey)) {
      throw trustError('INVALID_TRUST_STORE', `发布者重复：${normalizedPublisher}`);
    }
    if (!Array.isArray(item.keys) || item.keys.length === 0) {
      throw trustError('INVALID_TRUST_STORE', `发布者缺少公钥：${normalizedPublisher}`);
    }
    if (item.keys.length > MAX_KEYS_PER_PUBLISHER) {
      throw trustError(
        'INVALID_TRUST_STORE',
        `发布者最多记录 ${MAX_KEYS_PER_PUBLISHER} 个公钥：${normalizedPublisher}`,
      );
    }
    const keys = new Map();
    for (const [keyIndex, entry] of item.keys.entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw trustError('INVALID_TRUST_STORE', `${normalizedPublisher} keys[${keyIndex}] 必须是对象`);
      }
      for (const key of Object.keys(entry)) {
        if (![
          'keyId',
          'publicKey',
          'status',
          'source',
          'createdAt',
          'updatedAt',
          'revokedAt',
        ].includes(key)) {
          throw trustError(
            'INVALID_TRUST_STORE',
            `${normalizedPublisher} keys[${keyIndex}] 包含未知字段：${key}`,
          );
        }
      }
      let key;
      try {
        key = normalizePublicKey(entry.publicKey);
      } catch (error) {
        throw trustError(
          'INVALID_TRUST_STORE',
          `${normalizedPublisher} keys[${keyIndex}] 公钥无效：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (entry.keyId !== key.keyId) {
        throw trustError('INVALID_TRUST_STORE', `${normalizedPublisher} keys[${keyIndex}] keyId 不匹配`);
      }
      if (entry.status !== 'trusted' && entry.status !== 'revoked') {
        throw trustError('INVALID_TRUST_STORE', `${normalizedPublisher} keys[${keyIndex}] status 无效`);
      }
      if (entry.source !== undefined && (typeof entry.source !== 'string' || entry.source.length > 2_000)) {
        throw trustError('INVALID_TRUST_STORE', `${normalizedPublisher} keys[${keyIndex}] source 无效`);
      }
      if (keys.has(key.keyId)) {
        throw trustError('INVALID_TRUST_STORE', `${normalizedPublisher} 公钥重复：${key.keyId}`);
      }
      keys.set(key.keyId, {
        keyId: key.keyId,
        publicKey: key.base64,
        status: entry.status,
        source: entry.source,
        createdAt: normalizeTimestamp(entry.createdAt),
        updatedAt: normalizeTimestamp(entry.updatedAt),
        revokedAt: entry.status === 'revoked' ? normalizeTimestamp(entry.revokedAt) : undefined,
      });
    }
    publishers.set(normalizedPublisherKey, {
      publisher: normalizedPublisher,
      keys: [...keys.values()],
    });
  }
  return {
    schemaVersion: TRUST_STORE_VERSION,
    publishers: [...publishers.values()],
  };
}

class ExtensionTrustStore {
  constructor(options = {}) {
    if (typeof options.userDataPath !== 'string' || !path.isAbsolute(options.userDataPath)) {
      throw new Error('ExtensionTrustStore 需要绝对 userDataPath');
    }
    this.userDataPath = path.resolve(options.userDataPath);
    this.file = path.join(this.userDataPath, TRUST_STORE_NAME);
    this.now = options.now || Date.now;
    fs.mkdirSync(this.userDataPath, { recursive: true, mode: 0o700 });
  }

  read() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { schemaVersion: TRUST_STORE_VERSION, publishers: [] };
      }
      throw trustError(
        'INVALID_TRUST_STORE',
        `无法读取扩展发布者信任库：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return normalizeTrustStore(raw);
  }

  write(store) {
    const normalized = normalizeTrustStore(store);
    atomicWriteJson(this.file, normalized);
    return normalized;
  }

  list() {
    return structuredClone(this.read());
  }

  lookup(publisher, keyId) {
    const normalizedPublisher = publisherKey(publisher);
    const entry = this.read().publishers.find((item) => (
      publisherKey(item.publisher) === normalizedPublisher
    ));
    if (!entry) return undefined;
    return structuredClone(
      entry.keys.find((key) => key.keyId === keyId),
    );
  }

  assertAllowed(publisher, keyId) {
    const key = this.lookup(publisher, keyId);
    if (!key) {
      throw trustError(
        'UNTRUSTED_PUBLISHER_KEY',
        `发布者 ${publisher} 的公钥尚未受信任：${keyId}`,
        { publisher, keyId },
      );
    }
    if (key.status === 'revoked') {
      throw trustError(
        'REVOKED_PUBLISHER_KEY',
        `发布者 ${publisher} 的公钥已被撤销：${keyId}`,
        { publisher, keyId },
      );
    }
    return key;
  }

  trust({
    publisher,
    publicKey,
    keyId,
    source,
  }) {
    const normalizedPublisher = publisherKey(publisher);
    const normalizedKey = normalizePublicKey(publicKey);
    if (keyId && keyId !== normalizedKey.keyId) {
      throw trustError('PUBLISHER_KEY_MISMATCH', '待信任公钥与 keyId 不一致');
    }
    const store = this.read();
    let entry = store.publishers.find((item) => (
      publisherKey(item.publisher) === normalizedPublisher
    ));
    if (!entry) {
      entry = { publisher: String(publisher).trim(), keys: [] };
      store.publishers.push(entry);
    }
    let key = entry.keys.find((item) => item.keyId === normalizedKey.keyId);
    if (key?.status === 'revoked') {
      throw trustError('REVOKED_PUBLISHER_KEY', '不能重新信任已撤销的发布者公钥');
    }
    const now = this.now();
    if (key) {
      key.status = 'trusted';
      key.updatedAt = now;
      if (source) key.source = source;
    } else {
      if (entry.keys.length >= MAX_KEYS_PER_PUBLISHER) {
        throw trustError(
          'TOO_MANY_PUBLISHER_KEYS',
          `发布者最多记录 ${MAX_KEYS_PER_PUBLISHER} 个公钥`,
        );
      }
      key = {
        keyId: normalizedKey.keyId,
        publicKey: normalizedKey.base64,
        status: 'trusted',
        source,
        createdAt: now,
        updatedAt: now,
      };
      entry.keys.push(key);
    }
    this.write(store);
    return structuredClone(key);
  }

  revoke({
    publisher,
    keyId,
  }) {
    const store = this.read();
    const entry = store.publishers.find((item) => (
      publisherKey(item.publisher) === publisherKey(publisher)
    ));
    const key = entry?.keys.find((item) => item.keyId === keyId);
    if (!key) throw trustError('PUBLISHER_KEY_NOT_FOUND', '找不到要撤销的发布者公钥');
    const now = this.now();
    key.status = 'revoked';
    key.updatedAt = now;
    key.revokedAt = now;
    this.write(store);
    return structuredClone(key);
  }
}

module.exports = {
  ExtensionTrustError,
  ExtensionTrustStore,
  MAX_KEYS_PER_PUBLISHER,
  MAX_PUBLISHERS,
  TRUST_STORE_NAME,
  TRUST_STORE_VERSION,
  normalizeTrustStore,
  publisherKey,
};

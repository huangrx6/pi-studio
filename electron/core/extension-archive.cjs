'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const MAX_ZIP_COMMENT = 0xffff;

const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 50 * 1024 * 1024,
  maxExtractedBytes: 100 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  maxEntries: 2_048,
});

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeArchivePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error('压缩包包含空文件名');
  }
  if (value.includes('\\')) throw new Error(`压缩包路径不能包含反斜杠：${value}`);
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new Error(`压缩包不能使用绝对路径：${value}`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`压缩包包含越界路径：${value}`);
  }
  const normalized = segments.join('/');
  if (normalized.length > 240) throw new Error(`压缩包路径过长：${value}`);
  return normalized;
}

function decodeZipName(buffer) {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    for (const character of value) {
      const code = character.codePointAt(0);
      if (code < 0x20 || code === 0x7f) throw new Error('控制字符');
    }
    return value;
  } catch {
    throw new Error('压缩包文件名不是合法 UTF-8');
  }
}

function findEndOfCentralDirectory(archive) {
  const minimum = Math.max(0, archive.length - MAX_ZIP_COMMENT - 22);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new Error('不是有效的 ZIP 扩展包，未找到中央目录');
}

function normalizeRelativeFileSet(files) {
  const normalized = new Map();
  for (const [rawName, file] of files) {
    const name = safeArchivePath(rawName.replace(/\/$/, ''));
    if (normalized.has(name)) throw new Error(`压缩包包含重复路径：${name}`);
    normalized.set(name, file);
  }
  return normalized;
}

function stripSingleWrapperDirectory(files) {
  if (files.has('pi-studio.extension.json')) return files;
  const roots = new Set();
  for (const name of files.keys()) roots.add(name.split('/')[0]);
  if (roots.size !== 1) return files;
  const [root] = roots;
  const wrapped = [...files.keys()].every((name) => name.startsWith(`${root}/`));
  if (!wrapped) return files;
  const stripped = new Map();
  for (const [name, file] of files) stripped.set(name.slice(root.length + 1), file);
  if (!stripped.has('pi-studio.extension.json')) {
    throw new Error('扩展包缺少 pi-studio.extension.json');
  }
  return normalizedFileMap(stripped);
}

function normalizedFileMap(files) {
  return normalizeRelativeFileSet(files);
}

function assertNoFileDirectoryConflicts(files) {
  const names = new Set(files.keys());
  for (const name of names) {
    const segments = name.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join('/');
      if (names.has(prefix)) throw new Error(`压缩包路径同时作为文件和目录：${prefix}`);
    }
  }
}

function inspectZipEntries(archive, options = {}) {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...(options.limits || {}) };
  if (!Buffer.isBuffer(archive)) throw new Error('压缩包内容必须是 Buffer');
  if (archive.length > limits.maxArchiveBytes) {
    throw new Error(`扩展包超过 ${limits.maxArchiveBytes} 字节上限`);
  }
  const endOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('不支持分卷 ZIP 扩展包');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 扩展包，请用 Pi Studio 打包工具生成');
  }
  if (entryCount > limits.maxEntries) {
    throw new Error(`扩展包文件数超过 ${limits.maxEntries} 项上限`);
  }
  if (centralOffset + centralSize > endOffset) throw new Error('ZIP 中央目录越界');

  const files = new Map();
  let cursor = centralOffset;
  let extractedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || archive.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY) {
      throw new Error(`ZIP 中央目录第 ${index + 1} 项无效`);
    }
    const madeBy = archive.readUInt16LE(cursor + 4);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize) throw new Error('ZIP 中央目录条目越界');
    const rawName = decodeZipName(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    const isDirectory = rawName.endsWith('/');
    const hostSystem = madeBy >>> 8;
    const unixMode = hostSystem === 3 ? (externalAttributes >>> 16) : 0;
    const fileType = unixMode & 0xf000;
    if (flags & ZIP_ENCRYPTED_FLAG) throw new Error(`不支持加密的 ZIP 文件：${rawName}`);
    if (fileType === 0xa000) throw new Error(`压缩包不能包含符号链接：${rawName}`);
    if (fileType !== 0 && fileType !== 0x4000 && fileType !== 0x8000) {
      throw new Error(`压缩包包含不支持的条目类型：${rawName}`);
    }
    const metadataName = rawName.replace(/\/$/, '');
    if (metadataName === '__MACOSX'
      || metadataName.startsWith('__MACOSX/')
      || metadataName.split('/').at(-1) === '.DS_Store') {
      cursor = next;
      continue;
    }
    if (isDirectory) {
      safeArchivePath(rawName.replace(/\/$/, ''));
      cursor = next;
      continue;
    }
    const name = safeArchivePath(rawName);
    if (files.has(name)) throw new Error(`压缩包包含重复路径：${name}`);
    if (uncompressedSize > limits.maxFileBytes) {
      throw new Error(`扩展包文件超过 ${limits.maxFileBytes} 字节上限：${name}`);
    }
    extractedBytes += uncompressedSize;
    if (extractedBytes > limits.maxExtractedBytes) {
      throw new Error(`扩展包解压总量超过 ${limits.maxExtractedBytes} 字节上限`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`扩展包使用了不支持的压缩算法 ${method}：${name}`);
    }
    if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE) {
      throw new Error(`扩展包本地文件头无效：${name}`);
    }
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localName = decodeZipName(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== rawName || localMethod !== method) {
      throw new Error(`扩展包本地文件头与中央目录不一致：${name}`);
    }
    if ((localFlags ^ flags) & (ZIP_ENCRYPTED_FLAG | ZIP_DATA_DESCRIPTOR_FLAG)) {
      throw new Error(`扩展包文件标志不一致：${name}`);
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > centralOffset) throw new Error(`扩展包文件数据越界：${name}`);
    const compressed = archive.subarray(dataOffset, dataEnd);
    let content;
    try {
      content = method === 0
        ? Buffer.from(compressed)
        : zlib.inflateRawSync(compressed, { maxOutputLength: limits.maxFileBytes });
    } catch (error) {
      throw new Error(`无法解压 ${name}：${error instanceof Error ? error.message : String(error)}`);
    }
    if (content.length !== uncompressedSize) throw new Error(`扩展包文件长度不一致：${name}`);
    if (crc32(content) !== expectedCrc) throw new Error(`扩展包文件 CRC 校验失败：${name}`);
    files.set(name, {
      directory: false,
      content,
      sha256: sha256(content),
    });
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('ZIP 中央目录长度不一致');
  assertNoFileDirectoryConflicts(files);
  return stripSingleWrapperDirectory(files);
}

function extractZipArchive(archive, destination, options = {}) {
  const files = inspectZipEntries(archive, options);
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  const rootReal = fs.realpathSync(root);
  for (const [name, file] of files) {
    const target = path.resolve(rootReal, ...name.split('/'));
    if (target !== rootReal && !target.startsWith(`${rootReal}${path.sep}`)) {
      throw new Error(`压缩包路径越过解压目录：${name}`);
    }
    if (file.directory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, { flag: 'wx', mode: 0o600 });
  }
  return {
    files: [...files.entries()]
      .filter(([, file]) => !file.directory)
      .map(([name, file]) => ({ path: name, size: file.content.length, sha256: file.sha256 })),
    archiveSha256: sha256(archive),
  };
}

function zipDosDateTime() {
  return {
    time: 0,
    date: (1 << 5) | 1,
  };
}

function zipLocalHeader(name, method, crc, compressedSize, size) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const { time, date } = zipDosDateTime();
  const header = Buffer.alloc(30);
  header.writeUInt32LE(ZIP_LOCAL_FILE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuffer]);
}

function zipCentralHeader(name, method, crc, compressedSize, size, localOffset) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const { time, date } = zipDosDateTime();
  const header = Buffer.alloc(46);
  header.writeUInt32LE(ZIP_CENTRAL_DIRECTORY, 0);
  header.writeUInt16LE((3 << 8) | 20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(localOffset, 42);
  return Buffer.concat([header, nameBuffer]);
}

function createZipArchive(entries, options = {}) {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...(options.limits || {}) };
  const names = new Set();
  const normalized = entries.map((entry) => {
    const name = safeArchivePath(entry.path);
    if (/\/$/.test(entry.path)) throw new Error('打包文件路径不能以斜杠结尾');
    if (names.has(name)) throw new Error(`打包文件路径重复：${name}`);
    names.add(name);
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    if (content.length > limits.maxFileBytes) throw new Error(`文件超过上限：${name}`);
    return { name, content };
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'));
  assertNoFileDirectoryConflicts(new Map(normalized.map((entry) => [entry.name, entry])));
  if (normalized.length > limits.maxEntries) throw new Error(`打包文件数超过 ${limits.maxEntries}`);
  const total = normalized.reduce((sum, entry) => sum + entry.content.length, 0);
  if (total > limits.maxExtractedBytes) throw new Error(`打包内容超过 ${limits.maxExtractedBytes} 字节`);

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of normalized) {
    const compressed = zlib.deflateRawSync(entry.content, { level: 9 });
    const checksum = crc32(entry.content);
    const local = zipLocalHeader(entry.name, 8, checksum, compressed.length, entry.content.length);
    centralParts.push(zipCentralHeader(
      entry.name,
      8,
      checksum,
      compressed.length,
      entry.content.length,
      offset,
    ));
    localParts.push(local, compressed);
    offset += local.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(normalized.length, 8);
  end.writeUInt16LE(normalized.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

module.exports = {
  DEFAULT_ARCHIVE_LIMITS,
  createZipArchive,
  crc32,
  extractZipArchive,
  inspectZipEntries,
  safeArchivePath,
  sha256,
};

#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createExtensionPackage,
  integrityFromFiles,
  INTEGRITY_NAME,
  recommendedArchiveName,
  validateExtensionDirectory,
  walkPackageFiles,
} = require('../../electron/core/extension-package.cjs');
const {
  publicKeyFingerprint,
  signExtensionDirectory,
  verifyExtensionDirectory,
} = require('../../electron/core/extension-signature.cjs');
const { inspectZipEntries, sha256 } = require('../../electron/core/extension-archive.cjs');

const BOOLEAN_FLAGS = new Set([
  'allow-dirty',
  'dry-run',
  'force',
  'help',
  'json',
]);

function usage() {
  return `Pi Studio Extension Toolkit

用法：
  pi-studio-extension validate <目录> [--scope user|project] [--json]
  pi-studio-extension keygen [--out <目录>] [--force] [--json]
  pi-studio-extension sign <目录> --private-key <文件> [--scope user|project] [--json]
  pi-studio-extension verify <目录> [--public-key <文件>] [--publisher <名称>] [--json]
  pi-studio-extension seal <目录> [--scope user|project] [--json]
  pi-studio-extension seal-official <官方扩展根目录> [--json]
  pi-studio-extension pack <目录> [--scope user|project] [--out <文件|目录>] [--force] [--json]
  pi-studio-extension checksum <扩展包>
  pi-studio-extension entry <目录|扩展包> --download-url <HTTPS URL> [--scope user|project]
      [--out <文件>] [--json]
  pi-studio-extension publish <目录> [--scope user|project] [--tag <tag>] [--repo owner/repo]
      [--out <目录>]
      [--notes <文件>] [--allow-dirty] [--dry-run] [--json]
  pi-studio-extension init <目录> [--template ui|agent] [--id <id>] [--name <名称>]
      [--publisher <发布者>]

说明：
  - pack 生成确定性 .pi-extension.zip，并在包内生成逐文件 SHA-256。
  - sign 使用 Ed25519 私钥把扩展 ID、版本、发布者和内容树绑定到 signature.json。
  - verify 不带 --public-key 时只验证包内自洽；带公钥时才确认发布者身份。
  - seal 在开发目录内重建 integrity.json；官方目录在打包前必须重新 seal。
  - publish 同时上传扩展包和 SHA256SUMS，并要求工作区干净。
  - registry entry 只生成可合并到 registry.extensions 的条目。
  - init 默认生成声明式 UI 扩展；--template agent 同时生成 Durable 工具与 cleanup 示例。
`;
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (BOOLEAN_FLAGS.has(name)) {
      if (equals !== -1) throw new Error(`--${name} 不接受值`);
      flags[name] = true;
      continue;
    }
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (!value || value.startsWith('--')) throw new Error(`--${name} 需要值`);
    flags[name] = value;
  }
  return { flags, positionals };
}

function print(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    process.stdout.write(`${key}: ${typeof item === 'object' ? JSON.stringify(item) : item}\n`);
  }
}

function requirePositional(positionals, index, label) {
  const value = positionals[index];
  if (!value) throw new Error(`缺少${label}`);
  return value;
}

function validatedSummary(directory, scope) {
  return validateExtensionDirectory(directory, {
    scope,
    integrity: 'optional',
    requirePublisher: true,
  });
}

function selectedScope(flags) {
  if (flags.scope === undefined) return 'user';
  if (flags.scope !== 'user' && flags.scope !== 'project') {
    throw new Error('--scope 只能是 user 或 project');
  }
  return flags.scope;
}

function validateCommand(positionals, flags) {
  const directory = path.resolve(requirePositional(positionals, 0, '扩展目录'));
  const scope = selectedScope(flags);
  const summary = validatedSummary(directory, scope);
  const signature = verifyExtensionDirectory(directory, { scope });
  const result = {
    valid: true,
    id: summary.manifest.id,
    name: summary.manifest.name,
    version: summary.manifest.version,
    publisher: summary.manifest.publisher,
    files: summary.files.length,
    integrity: summary.verified,
    signatureStatus: signature.status,
    signatureKeyId: signature.signature?.keyId,
    signaturePublisher: signature.signature?.publisher,
    treeSha256: summary.treeSha256,
    permissions: summary.manifest.permissions,
    providerAccess: summary.manifest.providerAccess,
    runtime: summary.manifest.runtime,
  };
  print(flags.json ? result : [
    `有效扩展：${result.id}@${result.version}`,
    `文件：${result.files}`,
    `integrity：${result.integrity ? '已校验' : '未包含'}`,
    `signature：${result.signatureStatus === 'unsigned' ? '未签名' : `有效（${result.signatureKeyId}）`}`,
    `tree SHA-256：${result.treeSha256}`,
  ].join('\n'), flags.json);
}

function keygenCommand(positionals, flags) {
  const outputDirectory = path.resolve(flags.out || path.join(process.cwd(), '.pi-studio-signing'));
  const privateFile = path.join(outputDirectory, 'publisher-private.pem');
  const publicFile = path.join(outputDirectory, 'publisher-public.pem');
  if (fs.existsSync(outputDirectory) && !fs.statSync(outputDirectory).isDirectory()) {
    throw new Error(`keygen 输出路径不是目录：${outputDirectory}`);
  }
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  if (flags.force !== true) {
    for (const file of [privateFile, publicFile]) {
      if (fs.existsSync(file)) throw new Error(`密钥文件已存在：${file}；使用 --force 覆盖`);
    }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' });
  fs.writeFileSync(privateFile, privatePem, { mode: 0o600 });
  try { fs.chmodSync(privateFile, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  fs.writeFileSync(publicFile, publicPem, { mode: 0o644 });
  const result = {
    privateKey: privateFile,
    publicKey: publicFile,
    keyId: publicKeyFingerprint(publicPem),
  };
  print(flags.json ? result : [
    `已生成 Ed25519 发布者密钥：${outputDirectory}`,
    `私钥：${privateFile}（只保存在本机，永远不要提交或打进扩展包）`,
    `公钥：${publicFile}`,
    `公钥指纹：${result.keyId}`,
  ].join('\n'), flags.json);
  return result;
}

function assertOutsideDirectory(directory, file, label) {
  const relative = path.relative(directory, file);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`${label}不能位于扩展目录内`);
  }
}

function signCommand(positionals, flags) {
  const directory = path.resolve(requirePositional(positionals, 0, '扩展目录'));
  const privateKeyOption = flags['private-key'] || process.env.PI_STUDIO_EXTENSION_PRIVATE_KEY;
  if (!privateKeyOption) {
    throw new Error('缺少 --private-key，或设置 PI_STUDIO_EXTENSION_PRIVATE_KEY');
  }
  const privateFile = path.resolve(privateKeyOption);
  assertOutsideDirectory(directory, privateFile, '签名私钥');
  if (!fs.existsSync(privateFile) || !fs.statSync(privateFile).isFile()) {
    throw new Error(`签名私钥不存在：${privateFile}`);
  }
  const scope = selectedScope(flags);
  const result = signExtensionDirectory(directory, {
    scope,
    privateKey: fs.readFileSync(privateFile),
  });
  // A signature is part of the distributable tree. Refresh integrity after it
  // is written so ZIP installations and direct directory installs validate the
  // same exact files.
  sealDirectory(directory, scope);
  const output = {
    id: result.manifest.id,
    version: result.manifest.version,
    publisher: result.manifest.publisher,
    keyId: result.signature.keyId,
    treeSha256: result.treeSha256,
    signatureFile: path.join(directory, 'signature.json'),
  };
  print(flags.json ? output : [
    `已签名：${output.id}@${output.version}`,
    `发布者：${output.publisher}`,
    `公钥指纹：${output.keyId}`,
    `tree SHA-256：${output.treeSha256}`,
  ].join('\n'), flags.json);
  return output;
}

function verifyCommand(positionals, flags) {
  const directory = path.resolve(requirePositional(positionals, 0, '扩展目录'));
  let expectedPublicKey;
  if (flags['public-key']) {
    const file = path.resolve(flags['public-key']);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`发布者公钥不存在：${file}`);
    }
    expectedPublicKey = fs.readFileSync(file);
  }
  const result = verifyExtensionDirectory(directory, {
    scope: selectedScope(flags),
    expectedPublicKey,
    expectedPublisher: flags.publisher,
  });
  const output = {
    status: result.status,
    id: result.manifest.id,
    version: result.manifest.version,
    publisher: result.signature?.publisher || result.manifest.publisher,
    keyId: result.signature?.keyId,
    identityTrusted: result.verification?.identityTrusted === true,
    treeSha256: result.signature?.treeSha256,
  };
  print(flags.json ? output : [
    `签名状态：${output.status}`,
    `扩展：${output.id}@${output.version}`,
    `发布者：${output.publisher}`,
    `公钥指纹：${output.keyId || '无'}`,
    `发布者身份：${output.identityTrusted ? '已由指定公钥确认' : '未与外部受信任公钥核对'}`,
  ].join('\n'), flags.json);
  return output;
}

function sealDirectory(directory, scope = 'user') {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`扩展目录不存在：${directory}`);
  }
  validateExtensionDirectory(directory, {
    scope,
    integrity: 'ignore',
    requirePublisher: true,
  });
  const files = walkPackageFiles(directory);
  const integrity = integrityFromFiles(directory, files);
  const target = path.join(directory, INTEGRITY_NAME);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(integrity, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o644,
  });
  fs.renameSync(temporary, target);
  const verified = validateExtensionDirectory(directory, {
    scope,
    integrity: 'required',
    requirePublisher: true,
  });
  return {
    directory,
    id: verified.manifest.id,
    version: verified.manifest.version,
    files: verified.files.length,
    integrity: verified.verified,
    treeSha256: verified.treeSha256,
  };
}

function sealCommand(positionals, flags) {
  const directory = path.resolve(requirePositional(positionals, 0, '扩展目录'));
  const result = sealDirectory(directory, selectedScope(flags));
  print(flags.json ? result : [
    `已写入 integrity：${path.join(directory, INTEGRITY_NAME)}`,
    `扩展：${result.id}@${result.version}`,
    `tree SHA-256：${result.treeSha256}`,
  ].join('\n'), flags.json);
  return result;
}

function sealOfficialCommand(positionals, flags) {
  const root = path.resolve(requirePositional(positionals, 0, '官方扩展根目录'));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`官方扩展根目录不存在：${root}`);
  }
  const results = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => sealDirectory(path.join(root, entry.name), 'user'));
  print(flags.json ? { root, extensions: results } : [
    `已 seal ${results.length} 个官方扩展`,
    ...results.map((item) => `${item.id}@${item.version}  ${item.treeSha256}`),
  ].join('\n'), flags.json);
  return { root, extensions: results };
}

function outputPathFor(sourceDirectory, flags, archiveName) {
  const requested = flags.out ? path.resolve(flags.out) : process.cwd();
  if (fs.existsSync(requested) && fs.statSync(requested).isDirectory()) {
    return path.join(requested, archiveName);
  }
  if (flags.out && (/[\\/]$/.test(flags.out) || path.extname(requested) === '')) {
    return path.join(requested, archiveName);
  }
  if (!flags.out) return path.join(requested, archiveName);
  return requested;
}

function writeArchive(file, archive, force) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !force) throw new Error(`输出文件已存在：${file}；使用 --force 覆盖`);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, archive, { flag: 'wx', mode: 0o644 });
  fs.renameSync(temporary, file);
}

function packCommand(positionals, flags) {
  const directory = path.resolve(requirePositional(positionals, 0, '扩展目录'));
  const scope = selectedScope(flags);
  const signature = verifyExtensionDirectory(directory, { scope });
  const packed = createExtensionPackage(directory, { scope });
  const archiveName = recommendedArchiveName(packed.manifest);
  const file = outputPathFor(directory, flags, archiveName);
  writeArchive(file, packed.archive, flags.force === true);
  const result = {
    valid: true,
    id: packed.manifest.id,
    version: packed.manifest.version,
    publisher: packed.manifest.publisher,
    signatureStatus: signature.status,
    signatureKeyId: signature.signature?.keyId,
    file,
    bytes: packed.archive.length,
    sha256: packed.archiveSha256,
    treeSha256: packed.treeSha256,
  };
  print(flags.json ? result : [
    `已打包：${file}`,
    `大小：${result.bytes} bytes`,
    `签名：${result.signatureStatus === 'unsigned' ? '未签名' : `有效（${result.signatureKeyId}）`}`,
    `SHA-256：${result.sha256}`,
    `tree SHA-256：${result.treeSha256}`,
  ].join('\n'), flags.json);
  return result;
}

function checksumCommand(positionals, flags) {
  const file = path.resolve(requirePositional(positionals, 0, '扩展包路径'));
  if (!fs.statSync(file).isFile()) throw new Error('checksum 需要文件');
  const digest = sha256(fs.readFileSync(file));
  print(flags.json ? { file, sha256: digest } : `${digest}  ${path.basename(file)}`, flags.json);
  return { file, sha256: digest };
}

function entryCommand(positionals, flags) {
  const input = path.resolve(requirePositional(positionals, 0, '扩展目录或包'));
  const scope = selectedScope(flags);
  const downloadUrl = flags['download-url'];
  if (!downloadUrl) throw new Error('缺少 --download-url');
  const parsed = new URL(downloadUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('--download-url 必须是无凭据的 HTTPS URL');
  }
  let manifest;
  let digest;
  let size;
  let signature;
  if (fs.statSync(input).isDirectory()) {
    signature = verifyExtensionDirectory(input, { scope });
    const packed = createExtensionPackage(input, { scope });
    manifest = packed.manifest;
    digest = packed.archiveSha256;
    size = packed.archive.length;
  } else {
    const buffer = fs.readFileSync(input);
    digest = sha256(buffer);
    size = buffer.length;
    const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pi-studio-entry-'));
    try {
      for (const [name, file] of inspectZipEntries(buffer)) {
        const target = path.join(temporary, ...name.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, { flag: 'wx' });
      }
      manifest = validatedSummary(temporary, scope).manifest;
      signature = verifyExtensionDirectory(temporary, { scope });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  const entry = {
    id: manifest.id,
    name: manifest.name,
    publisher: manifest.publisher,
    ...(signature?.signature ? {
      publisherKey: signature.signature.publicKey,
      publisherKeyId: signature.signature.keyId,
    } : {}),
    ...(manifest.description ? { summary: manifest.description } : {}),
    ...(manifest.repository ? { repository: manifest.repository } : {}),
    versions: [{
      version: manifest.version,
      piStudio: manifest.engines?.piStudio || '*',
      download: parsed.toString(),
      sha256: digest,
      size,
      permissions: manifest.permissions,
      ...(manifest.requires?.length ? { requires: manifest.requires } : {}),
    }],
  };
  const output = `${JSON.stringify(entry, null, 2)}\n`;
  if (flags.out) {
    const file = path.resolve(flags.out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, output, { flag: flags.force ? 'w' : 'wx' });
    print(flags.json ? { file, entry } : `registry entry 已写入：${file}`, flags.json);
  } else {
    process.stdout.write(output);
  }
  return entry;
}

function runGit(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function repositoryFromManifest(manifest) {
  if (!manifest.repository) return undefined;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(manifest.repository);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function publishCommand(positionals, flags) {
  const directory = path.resolve(requirePositional(positionals, 0, '扩展目录'));
  const scope = selectedScope(flags);
  const packed = createExtensionPackage(directory, { scope });
  const tag = flags.tag || `v${packed.manifest.version}`;
  if (!/^[A-Za-z0-9._/-]+$/.test(tag) || tag.startsWith('-') || tag.includes('..')) {
    throw new Error('release tag 无效');
  }
  const outputDirectory = path.resolve(flags.out || path.join(directory, 'release'));
  const archiveFile = path.join(outputDirectory, recommendedArchiveName(packed.manifest));
  const checksumFile = path.join(outputDirectory, 'SHA256SUMS');

  const status = runGit(['status', '--porcelain'], directory);
  if (status.status !== 0) throw new Error(`无法读取 Git 状态：${status.stderr.trim()}`);
  if (status.stdout.trim() && flags['allow-dirty'] !== true) {
    throw new Error('工作区有未提交改动；提交后再发布，或明确传入 --allow-dirty');
  }
  const head = runGit(['rev-parse', 'HEAD'], directory);
  if (head.status !== 0) throw new Error(`无法读取 Git HEAD：${head.stderr.trim()}`);
  const target = head.stdout.trim();
  const repo = flags.repo || repositoryFromManifest(packed.manifest);
  const args = [
    'release',
    'create',
    tag,
    archiveFile,
    checksumFile,
    '--target',
    target,
    '--title',
    `${packed.manifest.name} ${packed.manifest.version}`,
  ];
  if (repo) args.push('--repo', repo);
  if (flags.notes) args.push('--notes-file', path.resolve(flags.notes));
  else args.push('--generate-notes');
  const result = {
    tag,
    target,
    repo: repo || '(current)',
    archiveFile,
    checksumFile,
    sha256: packed.archiveSha256,
    command: ['gh', ...args],
  };
  if (flags['dry-run']) {
    print(flags.json ? { dryRun: true, ...result } : result.command.map((item) => (
      /\s/.test(item) ? JSON.stringify(item) : item
    )).join(' '), flags.json);
    return result;
  }
  writeArchive(archiveFile, packed.archive, flags.force === true);
  fs.writeFileSync(checksumFile, `${packed.archiveSha256}  ${path.basename(archiveFile)}\n`, {
    flag: flags.force ? 'w' : 'wx',
    mode: 0o644,
  });
  const published = spawnSync('gh', args, { cwd: directory, encoding: 'utf8' });
  if (published.error) throw new Error(`无法启动 GitHub CLI：${published.error.message}`);
  if (published.status !== 0) {
    throw new Error(`gh release create 失败：${(published.stderr || published.stdout).trim()}`);
  }
  result.url = published.stdout.trim().split(/\r?\n/).at(-1);
  print(flags.json ? result : `已发布：${result.url}`, flags.json);
  return result;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function initCommand(positionals, flags) {
  const directory = path.resolve(requirePositional(positionals, 0, '目标目录'));
  if (fs.existsSync(directory) && fs.readdirSync(directory).length > 0) {
    throw new Error(`目标目录不是空目录：${directory}`);
  }
  const template = flags.template || 'ui';
  if (template !== 'ui' && template !== 'agent') {
    throw new Error('--template 只能是 ui 或 agent');
  }
  const name = flags.name || path.basename(directory);
  const id = slug(flags.id || name);
  if (id.length < 2) throw new Error('扩展 ID 至少需要 2 个字符，请用 --id 指定');
  const publisher = flags.publisher || process.env.USER || 'extension-author';
  const author = publisher;
  const agent = template === 'agent';
  const manifest = {
    format: 1,
    id,
    name,
    version: '0.1.0',
    description: `${name} extension for Pi Studio`,
    publisher,
    author,
    license: 'MIT',
    engines: { piStudio: '>=0.0.3 <0.2.0' },
    permissions: agent
      ? ['agent.tools', 'ui.commands', 'ui.panels']
      : ['ui.commands', 'ui.panels'],
    ...(agent ? { runtime: { durableEntry: 'extension.mjs' } } : {}),
    contributes: {
      ...(agent
        ? {
          tools: [{
            name: 'extension_echo',
            description: `Echo text through ${name}.`,
          }],
        }
        : {}),
      commands: agent
        ? [{
          id: 'hello',
          title: `Run ${name}`,
          description: 'Call the generated Durable command handler.',
          placement: 'command-menu',
        }]
        : [{
          id: 'hello',
          title: `Open ${name}`,
          description: 'Open the starter panel.',
          placement: 'command-menu',
          action: { kind: 'openPanel', panelId: 'overview' },
        }],
      panels: [{
        id: 'overview',
        title: `${name} is ready`,
        description: agent
          ? 'A declarative panel for the generated Agent extension.'
          : 'A declarative extension panel.',
        slot: 'panel.side',
        content: [
          { kind: 'heading', text: name },
          {
            kind: 'text',
            text: agent
              ? 'Edit extension.mjs for trusted Node runtime code. Keep UI in pi-studio.extension.json.'
              : 'Edit pi-studio.extension.json to build your declarative extension.',
          },
          {
            kind: 'notice',
            tone: agent ? 'warning' : 'success',
            text: agent
              ? 'Agent extensions execute in the trusted main process. Review every dependency and runtime change.'
              : 'This UI is rendered by Pi Studio using the shared design tokens.',
          },
        ],
      }],
    },
  };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'pi-studio.extension.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (agent) {
    fs.writeFileSync(path.join(directory, 'extension.mjs'), `import {
  defineExtension,
  defineTool,
  Type,
} from '@earendil-works/pi-durable';

const echo = defineTool({
  name: 'extension_echo',
  description: ${JSON.stringify(`Echo text through ${name}.`)},
  parameters: Type.Object({
    text: Type.String({ maxLength: 4_000 }),
  }),
  replay: 'safe',
  async execute(args) {
    return {
      output: [{ type: 'text', text: args.text }],
    };
  },
});

export async function activate(context) {
  let active = true;
  return {
    durableExtension: defineExtension({
      name: 'studio-extension:${id}',
      tools: [echo],
    }),
    commands: {
      async hello() {
        if (!active) throw new Error('Extension is no longer active');
        return { message: 'Extension command ran in ' + context.extensionId };
      },
    },
    cleanup() {
      active = false;
    },
  };
}
`);
  }
  fs.writeFileSync(path.join(directory, 'README.md'), `# ${name}

Pi Studio extension starter generated by \`pi-studio-extension init\`.

Template: \`${template}\`

## Develop

Validate and package the extension:

\`\`\`sh
node /path/to/pi-studio/tools/cli/pi-studio-extension.mjs validate . --scope user
node /path/to/pi-studio/tools/cli/pi-studio-extension.mjs pack . --scope user --out release
\`\`\`

Commit the source, then publish a signed-in GitHub release:

\`\`\`sh
node /path/to/pi-studio/tools/cli/pi-studio-extension.mjs keygen --out ~/.pi-studio/keys
node /path/to/pi-studio/tools/cli/pi-studio-extension.mjs sign . --private-key ~/.pi-studio/keys/publisher-private.pem --scope user
node /path/to/pi-studio/tools/cli/pi-studio-extension.mjs verify . --public-key ~/.pi-studio/keys/publisher-public.pem --scope user
node /path/to/pi-studio/tools/cli/pi-studio-extension.mjs publish . --repo owner/repository --notes RELEASE.md --scope user
\`\`\`

The release uploads the deterministic \`.pi-extension.zip\` and a \`SHA256SUMS\` file.
Install or update it in Pi Studio through the same reviewed quarantine flow.
${agent ? '\nAgent extensions execute trusted Node code in the Pi Studio main process. Package signatures prove integrity and publisher identity; they do not sandbox runtime code.\n' : ''}
`);
  fs.writeFileSync(path.join(directory, '.gitignore'), 'release/\n.pi-studio-signing/\n');
  validateExtensionDirectory(directory, {
    scope: 'user',
    integrity: 'ignore',
    requirePublisher: true,
  });
  const result = { directory, id, name, publisher, template };
  print(flags.json ? result : `已创建 ${template} 扩展：${directory}`, flags.json);
  return result;
}

function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  if (flags.help || positionals.length === 0 || positionals[0] === 'help') {
    process.stdout.write(usage());
    return;
  }
  const [command, ...rest] = positionals;
  if (command === 'validate') validateCommand(rest, flags);
  else if (command === 'keygen') keygenCommand(rest, flags);
  else if (command === 'sign') signCommand(rest, flags);
  else if (command === 'verify') verifyCommand(rest, flags);
  else if (command === 'seal') sealCommand(rest, flags);
  else if (command === 'seal-official') sealOfficialCommand(rest, flags);
  else if (command === 'pack') packCommand(rest, flags);
  else if (command === 'checksum') checksumCommand(rest, flags);
  else if (command === 'entry') entryCommand(rest, flags);
  else if (command === 'publish') publishCommand(rest, flags);
  else if (command === 'init') initCommand(rest, flags);
  else throw new Error(`未知命令：${command}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

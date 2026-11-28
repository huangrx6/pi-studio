#!/usr/bin/env node
/**
 * Pi Studio Plugin Toolkit — validate local plugin packages.
 */

import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MANIFEST_NAME,
  validatePluginDirectory,
} = require('../../electron/main/core/plugin-package.cjs');

function usage() {
  return `Pi Studio Plugin Toolkit

用法：
  pi-studio-plugin validate <目录> [--json]
  pi-studio-plugin help

说明：
  校验 pi-studio.plugin.json 与 provides（MCP / Skill / CLI / Extension）。
  安装请在应用「设置 → 插件」中从目录或 zip 安装。
`;
}

function parseArgs(argv) {
  const args = [...argv];
  const flags = new Set();
  const positionals = [];
  while (args.length) {
    const item = args.shift();
    if (item === '--json') flags.add('json');
    else if (item === '--help' || item === '-h') flags.add('help');
    else positionals.push(item);
  }
  return { flags, positionals };
}

function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  const command = positionals[0] || 'help';
  if (flags.has('help') || command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command !== 'validate') {
    process.stderr.write(`未知命令：${command}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }
  const directory = path.resolve(positionals[1] || '.');
  try {
    const result = validatePluginDirectory(directory);
    if (flags.has('json')) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        manifest: result.manifest,
        summary: result.summary,
        contentHash: result.contentHash,
        totalBytes: result.totalBytes,
        fileCount: result.files.length,
      }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`✓ ${MANIFEST_NAME}\n`);
    process.stdout.write(`  id: ${result.manifest.id}\n`);
    process.stdout.write(`  name: ${result.manifest.name}\n`);
    process.stdout.write(`  version: ${result.manifest.version}\n`);
    process.stdout.write(`  mcp: ${result.summary.mcp.join(', ') || '—'}\n`);
    process.stdout.write(`  skills: ${result.summary.skills.join(', ') || '—'}\n`);
    process.stdout.write(`  cli: ${(result.summary.cli.map((item) => item.id).join(', ')) || '—'}\n`);
    process.stdout.write(`  extension: ${result.summary.extension || '—'}\n`);
    process.stdout.write(`  files: ${result.files.length}  contentHash: ${result.contentHash.slice(0, 12)}…\n`);
  } catch (error) {
    if (flags.has('json')) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code }, null, 2)}\n`);
    } else {
      process.stderr.write(`✗ ${error.message}\n`);
    }
    process.exitCode = 1;
  }
}

main();

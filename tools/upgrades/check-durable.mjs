#!/usr/bin/env node
/**
 * 检查 Pi Durable 家族是否有新版本，并打印从锁定版本到最新版本之间的
 * CHANGELOG 条目。
 *
 *   node tools/upgrades/check-durable.mjs           # 只报告
 *   node tools/upgrades/check-durable.mjs --check   # 有更新时退出码 1
 *   node tools/upgrades/check-durable.mjs --json    # 机器可读
 *
 * 上游按周发版且 minor 带破坏性变更，所以升级前必须先读这份摘要，再按
 * docs/upgrades/README.md 的流程走。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE_PREFIX = '@earendil-works/';
const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const strict = args.has('--check');

function readPinnedVersions() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pinned = {};
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] || {})) {
      if (!name.startsWith(PACKAGE_PREFIX)) continue;
      pinned[name] = String(range).replace(/^[^\d]*/, '');
    }
  }
  return pinned;
}

function run(command, argv, options = {}) {
  return execFileSync(command, argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function latestVersions(names) {
  const out = {};
  for (const name of names) {
    try {
      const tags = JSON.parse(run('npm', ['view', name, 'dist-tags', '--json']));
      out[name] = typeof tags.latest === 'string' ? tags.latest : undefined;
    } catch (error) {
      out[name] = undefined;
      out[`${name}#error`] = error instanceof Error ? error.message : String(error);
    }
  }
  return out;
}

function compareVersions(left, right) {
  const a = String(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 把 CHANGELOG 切成 `## [x.y.z]` 开头的段落。 */
function splitChangelog(text) {
  const sections = [];
  let current;
  for (const line of text.split(/\r?\n/)) {
    const match = /^##\s+\[([^\]]+)\]/.exec(line);
    if (match) {
      if (current) sections.push(current);
      current = { version: match[1], lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

function readChangelog(name, version) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-upgrade-'));
  try {
    run('npm', ['pack', `${name}@${version}`, '--pack-destination', directory]);
    const tarball = fs.readdirSync(directory).find((file) => file.endsWith('.tgz'));
    if (!tarball) return undefined;
    run('tar', ['-xzf', path.join(directory, tarball), '-C', directory]);
    const changelog = path.join(directory, 'package', 'CHANGELOG.md');
    return fs.existsSync(changelog) ? fs.readFileSync(changelog, 'utf8') : undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function summarize(name, pinned, latest) {
  const entry = {
    package: name,
    pinned,
    latest,
    updated: false,
    sections: [],
    notes: [],
  };
  if (latest === undefined) {
    entry.notes.push('无法读取 npm dist-tags');
    return entry;
  }
  if (compareVersions(latest, pinned) <= 0) return entry;

  entry.updated = true;
  const changelog = readChangelog(name, latest);
  if (changelog === undefined) {
    entry.notes.push('包内没有 CHANGELOG.md');
    return entry;
  }
  for (const section of splitChangelog(changelog)) {
    if (compareVersions(section.version, pinned) > 0
      && compareVersions(section.version, latest) <= 0) {
      entry.sections.push({ version: section.version, text: section.lines.join('\n').trimEnd() });
    }
  }
  if (entry.sections.length === 0) entry.notes.push('CHANGELOG 中没有对应版本的条目');
  return entry;
}

const pinned = readPinnedVersions();
const names = Object.keys(pinned).sort();
const latest = latestVersions(names);
const results = names.map((name) => summarize(name, pinned[name], latest[name]));
const updated = results.filter((entry) => entry.updated);

if (asJson) {
  console.log(JSON.stringify({ results, updatedCount: updated.length }, null, 2));
} else {
  console.log('Pi Durable 家族版本检查\n');
  for (const entry of results) {
    const state = entry.updated ? `→ ${entry.latest}（有新版本）` : '已是最新';
    console.log(`  ${entry.package.padEnd(34)} ${String(entry.pinned).padEnd(10)} ${state}`);
    for (const note of entry.notes) console.log(`      ! ${note}`);
  }

  if (updated.length === 0) {
    console.log('\n没有需要处理的更新。');
  } else {
    console.log(`\n${updated.length} 个包有更新。以下是 CHANGELOG 摘要：\n`);
    for (const entry of updated) {
      console.log('='.repeat(72));
      console.log(`${entry.package}  ${entry.pinned} → ${entry.latest}`);
      console.log('='.repeat(72));
      for (const section of entry.sections) {
        console.log(`\n${section.text}\n`);
      }
    }
    console.log('='.repeat(72));
    console.log('\n下一步：按 docs/upgrades/README.md 盘点影响面，');
    console.log('先在隔离副本里装配新版本量出失败面，再分阶段落地。');
  }
}

if (strict && updated.length > 0) process.exitCode = 1;

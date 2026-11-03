#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createZipArchive, sha256 } from '../../electron/core/extension-archive.cjs';
import { inspectSingleSkillDirectory } from '../../electron/services/studio-skills.cjs';

function print(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function flags(argv) {
  const values = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      values._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values[key] = next;
      index += 1;
    } else {
      values[key] = true;
    }
  }
  return values;
}

function walkFiles(root) {
  const output = [];
  function visit(directory, depth) {
    if (depth > 16) throw new Error('技能目录超过 16 层');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`技能包不接受符号链接：${path.relative(root, full)}`);
      if (stat.isDirectory()) visit(full, depth + 1);
      else if (stat.isFile()) {
        output.push({
          path: path.relative(root, full).split(path.sep).join('/'),
          content: fs.readFileSync(full),
        });
      }
    }
  }
  visit(root, 0);
  return output;
}

function pack(flagsValue) {
  const source = path.resolve(String(flagsValue._[0] || ''));
  if (!source || !fs.existsSync(source)) throw new Error('用法：pi-studio-skill pack <技能目录> [--out file.zip] [--download URL]');
  const skill = inspectSingleSkillDirectory(source);
  if (path.basename(source) !== skill.name) {
    throw new Error(`目录名必须与 frontmatter name 一致：${skill.name}`);
  }
  const output = path.resolve(String(
    flagsValue.out || `${skill.name}-${skill.version}.zip`,
  ));
  const files = walkFiles(source);
  const archive = createZipArchive(files.map((file) => ({
    path: `${skill.name}/${file.path}`,
    content: file.content,
  })));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, archive, { flag: 'wx' });
  const digest = sha256(archive);
  const entry = {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    invocation: skill.disableModelInvocation ? 'explicit' : 'automatic',
    ...(flagsValue.download ? { download: String(flagsValue.download) } : { download: path.basename(output) }),
    sha256: digest,
    resourceCount: Math.max(0, files.length - 1),
  };
  return {
    file: output,
    sha256: digest,
    size: archive.length,
    entry,
  };
}

try {
  const parsed = flags(process.argv.slice(2));
  const command = parsed._.shift();
  if (command !== 'pack') {
    throw new Error('命令：pi-studio-skill pack <技能目录> [--out file.zip] [--download URL] [--json]');
  }
  const result = pack(parsed);
  print(
    parsed.json
      ? result
      : [
          `技能包：${result.file}`,
          `SHA-256：${result.sha256}`,
          `大小：${result.size} bytes`,
          '',
          JSON.stringify(result.entry, null, 2),
        ].join('\n'),
    parsed.json === true,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

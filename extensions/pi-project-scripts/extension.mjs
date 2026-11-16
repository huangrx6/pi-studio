import { open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const MAX_PACKAGE_BYTES = 512 * 1024;
const commonScripts = ['dev', 'start', 'build', 'test', 'lint', 'check'];
const locks = [
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm'],
];

async function projectScripts({ cwd }) {
  if (!cwd || !path.isAbsolute(cwd)) return { message: '请打开一个工作区。' };
  let file;
  try {
    file = await open(path.join(cwd, 'package.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) return { message: '无法读取此项目清单，支持 512 KB 以内的普通文件。' };
    const parts = [];
    let total = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      total += chunk.length;
      if (total > MAX_PACKAGE_BYTES) return { message: '项目清单超过 512 KB。' };
      parts.push(chunk);
    }
    const manifest = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const scripts = manifest?.scripts;
    const names = scripts && typeof scripts === 'object' && !Array.isArray(scripts)
      ? Object.keys(scripts).filter(name => typeof scripts[name] === 'string' && /^[\p{L}\p{N}_.:@/][\p{L}\p{N}_.:@/ -]{0,119}$/u.test(name)) : [];
    if (!names.length) return { message: '此项目没有可展示的 scripts 条目。' };
    let manager = /^(npm|yarn|pnpm|bun)(?:@|$)/.exec(manifest.packageManager || '')?.[1];
    if (!manager) {
      const entries = new Set(await readdir(cwd));
      manager = locks.find(([lock]) => entries.has(lock))?.[1] || 'npm';
    }
    return { manager, names: names.sort((a, b) => a.localeCompare(b)) };
  } catch (error) {
    return { message: error.code === 'ENOENT' ? '工作区根目录没有 package.json。' : '无法读取工作区的 package.json。' };
  } finally { await file?.close(); }
}

function command(manager, name) {
  return `${manager} run ${name.includes(' ') ? `'${name}'` : name}`;
}

export function activate() {
  return { dataSources: {
    summary: { async read(context) {
      const result = await projectScripts(context);
      return [{ kind: 'text', text: result.message ?? `${result.manager} · ${result.names.length} 个脚本` }];
    } },
    scripts: { async read(context) {
      const { manager, names, message } = await projectScripts(context);
      if (message) return [{ kind: 'notice', tone: 'info', text: message }];
      const frequent = commonScripts.filter(name => names.includes(name));
      return [
        ...(frequent.length ? [{ kind: 'actions', buttons: frequent.map(name => ({
          id: `copy-${name}`, label: `复制 ${name}`, action: { kind: 'copyText', text: command(manager, name) },
        })) }] : []),
        { kind: 'table', title: `${manager} · ${names.length} 个脚本`,
          columns: [{ key: 'script', label: '脚本' }, { key: 'run', label: '运行命令' }],
          rows: names.slice(0, 200).map(name => ({ script: name, run: command(manager, name) })),
        },
        ...(names.length > 200 ? [{ kind: 'text', text: '已显示前 200 个脚本。' }] : []),
      ];
    } },
  } };
}

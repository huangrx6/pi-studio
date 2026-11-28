const { spawn } = require('node:child_process');
const { realpath } = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { SEARCH_IGNORED_DIRS } = require('./workspace.cjs');

const MATCH_LIMIT = 300;
const CONTEXT_BYTES = 64;

function snippet(bytes, from, to) {
  // ripgrep reports byte offsets. Keep context cuts on UTF-8 character boundaries.
  while (from > 0 && (bytes[from] & 0xc0) === 0x80) from--;
  while (to < bytes.length && (bytes[to] & 0xc0) === 0x80) to++;
  return bytes.toString('utf8', from, to);
}

function appendLine(group, data, matches) {
  const bytes = data.lines.text !== undefined ? Buffer.from(data.lines.text) : Buffer.from(data.lines.bytes, 'base64');
  let end = bytes.length;
  if (end && bytes[end - 1] === 10) end--;
  if (end && bytes[end - 1] === 13) end--;
  let row, cursor = 0, first = 0;
  for (const { start, end: stop } of matches) {
    if (!row || start - cursor > CONTEXT_BYTES * 2 || start - first > 200) {
      if (row) row.parts.push({ text: snippet(bytes, cursor, Math.min(cursor + CONTEXT_BYTES, end)) + '…' });
      row = { line: data.line_number, parts: [] };
      group.rows.push(row);
      first = start;
      cursor = Math.max(0, start - CONTEXT_BYTES);
      if (cursor) row.parts.push({ text: '…' });
    }
    if (cursor < start) row.parts.push({ text: snippet(bytes, cursor, start) });
    const text = snippet(bytes, start, Math.min(stop, start + 200));
    row.parts.push({ text: text + (stop - start > 200 ? '…' : ''), match: true });
    cursor = stop;
  }
  if (row) row.parts.push({ text: snippet(bytes, cursor, Math.min(end, cursor + CONTEXT_BYTES)) + (end > cursor + CONTEXT_BYTES ? '…' : '') });
}

async function searchFileContents(cwd, query, options = {}, signal) {
  const result = { files: [], count: 0, truncated: false };
  if (typeof query !== 'string' || !query.length) return result;
  const root = await realpath(cwd);
  const { rgPath } = await import('@vscode/ripgrep');
  signal?.throwIfAborted();
  const args = ['--no-config', '--json', '--hidden', '--no-require-git', '--color=never', '--max-filesize', '1M',
    options.caseSensitive ? '--case-sensitive' : '--ignore-case'];
  if (!options.regex) args.push('--fixed-strings');
  if (options.wholeWord) args.push('--word-regexp');
  for (const name of SEARCH_IGNORED_DIRS) args.push('--glob', '!' + name);
  if (options.exclude) args.push('--glob', '!' + options.exclude);
  args.push('-e', query, '--', '.');

  const rg = spawn(rgPath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2'), args, {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal,
  });
  let error = '';
  rg.stderr.setEncoding('utf8').on('data', chunk => { if (error.length < 4096) error += chunk; });
  // Install process listeners before reading stdout so cancellation and spawn failures settle both paths.
  const closed = new Promise((resolve, reject) => {
    rg.once('error', reject);
    rg.once('close', resolve);
  });
  const groups = new Map();
  async function read() {
    const lines = createInterface({ input: rg.stdout, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const { type, data } = JSON.parse(line);
        if (type !== 'match' || !data.path.text) continue;
        const file = path.normalize(data.path.text);
        if (options.include) {
          const rel = file.split(path.sep).join('/');
          const subject = options.include.includes('/') ? rel : path.posix.basename(rel);
          if (!path.posix.matchesGlob(subject, options.include)) continue;
        }
        const remaining = MATCH_LIMIT - result.count;
        const matches = data.submatches.slice(0, remaining);
        if (matches.length) {
          let group = groups.get(file);
          if (!group) groups.set(file, group = { path: file, count: 0, rows: [] });
          appendLine(group, data, matches);
          group.count += matches.length;
          result.count += matches.length;
        }
        if (data.submatches.length > remaining) {
          result.truncated = true;
          rg.kill();
          break;
        }
      }
    } finally {
      lines.close();
    }
  }
  try {
    const [code] = await Promise.all([closed, read()]);
    if (!result.truncated && code !== 0 && code !== 1) throw new Error(error.trim() || '搜索进程异常退出');
    result.files = [...groups.values()].sort((a, b) => a.path.localeCompare(b.path));
    return result;
  } finally {
    if (rg.exitCode === null && rg.signalCode === null) rg.kill();
  }
}

module.exports = { searchFileContents };

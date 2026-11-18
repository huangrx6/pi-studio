'use strict';

/**
 * 链接型 registry 条目的取回逻辑。
 *
 * 这类清单只给出一个地址（通常是 GitHub 上的 SKILL.md），没有压缩包，也没有
 * sha256。安装时先按地址取回 SKILL.md，再尽力把同目录下的引用文件一起取回；
 * 取不到引用文件时退回单文件，由预览里的文件列表如实展示。
 */

const fs = require('node:fs');
const path = require('node:path');

const LIMITS = {
  maxFiles: 60,
  maxDepth: 2,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxRefAttempts: 3,
};

/** 解析 https://github.com/<owner>/<repo>/(tree|blob)/<ref...>/<path>。 */
function parseGithubLink(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com'
    || url.port || url.username || url.password) return null;
  const match = /^\/([a-z0-9-]+)\/([a-z0-9_.-]+?)\/(?:tree|blob)\/(.+?)\/?$/i.exec(url.pathname);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  const rest = match[3].split('/').filter(Boolean);
  if (rest.length < 2) return null;
  return { owner, repo, rest };
}

function withDirectory(target) {
  const value = target.replace(/\/+$/, '');
  return value.toLowerCase().endsWith('/skill.md') ? value : `${value}/SKILL.md`;
}

function encodePath(value) {
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function createLinkedSourceAdapter({ readUrl, readJson }) {
  const isNotFound = (error) => /HTTP 404/.test(error instanceof Error ? error.message : String(error));

  async function readDirectory(link, ref, directory, depth) {
    if (depth > LIMITS.maxDepth) return [];
    const listing = await readJson(
      `https://api.github.com/repos/${link.owner}/${link.repo}/contents/${encodePath(directory)}?ref=${encodeURIComponent(ref)}`,
      '技能目录内容',
    );
    if (!Array.isArray(listing)) return [];
    const files = [];
    for (const entry of listing) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type === 'dir') {
        if (files.length + 1 > LIMITS.maxFiles) break;
        files.push(...await readDirectory(link, ref, entry.path, depth + 1));
        continue;
      }
      if (entry.type !== 'file' || typeof entry.download_url !== 'string') continue;
      if (!/^https:\/\/raw\.githubusercontent\.com\//i.test(entry.download_url)) continue;
      if (Number(entry.size) > LIMITS.maxFileBytes) continue;
      files.push({ path: entry.path, url: entry.download_url });
      if (files.length > LIMITS.maxFiles) break;
    }
    return files;
  }

  async function stageGithub(link, destination) {
    const target = withDirectory(link.rest.join('/'));
    const directory = path.posix.dirname(target);
    // 分支名可能自带斜杠，按“最像分支名”的顺序逐个尝试。
    const attempts = Math.min(LIMITS.maxRefAttempts, link.rest.length - 1);
    let ref = '';
    let relative = '';
    for (let index = 1; index <= attempts; index += 1) {
      const candidateRef = link.rest.slice(0, index).join('/');
      const candidatePath = link.rest.slice(index).join('/');
      const file = withDirectory(candidatePath);
      const raw = `https://raw.githubusercontent.com/${link.owner}/${link.repo}/${encodePath(candidateRef)}/${encodePath(file)}`;
      try {
        const bytes = await readUrl(raw, `技能 ${target}`, LIMITS.maxFileBytes);
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, 'SKILL.md'), bytes);
        ref = candidateRef;
        relative = path.posix.dirname(file);
        break;
      } catch (error) {
        if (!isNotFound(error) || index === attempts) {
          if (isNotFound(error)) throw new Error(`技能地址返回 404，链接可能已失效：${link.rest.join('/')}`);
          throw error;
        }
      }
    }
    if (!ref) return;
    const directoryPath = relative || directory;
    // 引用文件按 GitHub 目录列表补齐；接口受限或没有目录时保持单文件安装。
    let listing = [];
    try {
      listing = await readDirectory(link, ref, directoryPath, 0);
    } catch {
      listing = [];
    }
    let total = 0;
    for (const entry of listing.slice(0, LIMITS.maxFiles)) {
      const name = entry.path.slice(directoryPath.length).replace(/^\/+/, '');
      if (!name || name.includes('..')) continue;
      if (name.toLowerCase() === 'skill.md') continue;
      if (total >= LIMITS.maxTotalBytes) break;
      const bytes = await readUrl(entry.url, `技能文件 ${name}`, LIMITS.maxFileBytes);
      total += bytes.length;
      if (total > LIMITS.maxTotalBytes) throw new Error('技能引用文件总大小超限');
      const target2 = path.join(destination, ...name.split('/'));
      if (!target2.startsWith(`${destination}${path.sep}`)) throw new Error('技能文件越出目标目录');
      fs.mkdirSync(path.dirname(target2), { recursive: true });
      fs.writeFileSync(target2, bytes);
    }
  }

  async function stageSingleFile(item, destination) {
    const bytes = await readUrl(item.link, `技能 ${item.name}`, LIMITS.maxFileBytes);
    if (!/^https:\/\//i.test(item.link)) throw new Error('链接型技能只支持 HTTPS 地址');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'SKILL.md'), bytes);
  }

  async function stage(item, destination) {
    const link = parseGithubLink(item.link);
    if (link) return stageGithub(link, destination);
    return stageSingleFile(item, destination);
  }

  return { stage };
}

module.exports = { createLinkedSourceAdapter, parseGithubLink };

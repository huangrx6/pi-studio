'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { extractZipArchive, DEFAULT_ARCHIVE_LIMITS } = require('../../core/extension-archive.cjs');
const { studioDataDirectory } = require('../../core/studio-paths.cjs');
const { inspectSkillDirectory, directoryDetails } = require('./instructions.cjs');

// Repository budgets are separate from the smaller, per-skill install limits.
const LIMITS = {
  ...DEFAULT_ARCHIVE_LIMITS,
  maxArchiveBytes: 40 * 1024 * 1024,
  maxExtractedBytes: 100 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxEntries: 10_000,
};

function githubRepository(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com'
    || url.port || url.username || url.password) return null;
  const match = /^\/([a-z0-9-]+)\/([a-z0-9_.-]+?)\/?$/i.exec(url.pathname);
  if (!match) return null;
  const owner = match[1].toLowerCase();
  const repo = match[2].replace(/\.git$/i, '').toLowerCase();
  if (!repo || repo === '.' || repo === '..') return null;
  return { owner, repo, location: `https://github.com/${owner}/${repo}` };
}

// Networking stays in the source service so redirects, timeouts and streaming
// limits are identical for JSON registries and GitHub repositories.
function createGithubSourceAdapter(readUrl) {
  async function withRepository(repository, commit, callback) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('GitHub 返回了无效的提交标识');
    const bytes = await readUrl(
      `https://codeload.github.com/${repository.owner}/${repository.repo}/zip/${commit}`,
      'GitHub 技能仓库', LIMITS.maxArchiveBytes,
    );
    const parent = path.join(studioDataDirectory(), 'skill-quarantine');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const staging = fs.mkdtempSync(path.join(parent, 'github-'));
    try {
      extractZipArchive(bytes, staging, { limits: LIMITS, stripWrapper: false });
      const roots = fs.readdirSync(staging, { withFileTypes: true });
      if (roots.length !== 1 || !roots[0].isDirectory()) throw new Error('GitHub 仓库压缩包结构无效');
      return await callback(path.join(staging, roots[0].name));
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  async function read(source) {
    const repository = githubRepository(source.location);
    if (!repository) throw new Error('请填写 GitHub 仓库首页地址');
    // HEAD resolves the default branch without assuming main or master.
    const response = await readUrl(
      `https://api.github.com/repos/${repository.owner}/${repository.repo}/commits/HEAD`,
      'GitHub 仓库信息', 3 * 1024 * 1024,
    );
    const commit = JSON.parse(response.toString('utf8')).sha;
    return withRepository(repository, commit, (root) => {
      const inspected = inspectSkillDirectory(root);
      const entries = inspected.candidates.map((skill) => {
        const relative = path.relative(root, skill.baseDir).split(path.sep).join('/');
        const contentHash = directoryDetails(skill.baseDir).contentHash;
        return {
          id: `github:${relative || '.'}`,
          name: skill.name,
          description: skill.description,
          version: `${skill.version}+${contentHash.slice(0, 12)}`,
          invocation: skill.disableModelInvocation ? 'explicit' : 'automatic',
          repository: repository.location,
          homepage: `${repository.location}/tree/${commit}/${relative}`,
          commit,
          relative,
          contentHash,
          resourceCount: skill.resourceCount,
          totalBytes: skill.totalBytes,
          promptTokens: skill.promptTokens,
        };
      });
      if (!entries.length) throw new Error('仓库中没有可安装的 SKILL.md 技能，请确认仓库包含技能文件，而不只是链接列表');
      return {
        entries,
        diagnostics: inspected.diagnostics.map((item) => ({
          ...item, path: path.relative(root, item.path).split(path.sep).join('/'),
        })),
      };
    });
  }

  async function stage(source, item, destination, validateFiles) {
    const repository = githubRepository(source.location);
    // Fetch the commit discovered in the catalog, never a moving branch at install time.
    return withRepository(repository, item.commit, (root) => {
      const directory = path.resolve(root, item.relative);
      if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) throw new Error('技能目录越出仓库');
      validateFiles(directory);
      fs.cpSync(directory, destination, { recursive: true, errorOnExist: true, dereference: false });
      if (directoryDetails(destination).contentHash !== item.contentHash) throw new Error('技能内容与目录预览不一致，请刷新后重试');
    });
  }

  return { read, stage };
}

module.exports = { githubRepository, createGithubSourceAdapter };

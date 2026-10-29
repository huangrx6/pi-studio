/**
 * Studio-owned Agent Skills discovery.
 *
 * This follows Pi's Agent Skills behavior: directories are scanned recursively,
 * a directory containing SKILL.md is a skill root, only metadata enters the
 * system prompt, and the model reads SKILL.md through the normal file tool when
 * needed. Project skills are executable project resources and therefore require
 * a trust record bound to the complete directory fingerprint.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse: parseYaml } = require('yaml');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { userDataDirectory } = require('../core/studio-paths.cjs');

const SKILL_FILE = 'SKILL.md';
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_TREE_ENTRIES = 2_000;
const MAX_TREE_DEPTH = 16;
const MAX_FINGERPRINT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FINGERPRINT_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FINGERPRINT_CACHE_ENTRIES = 512;
const SKIPPED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules']);
const NAME_PATTERN = /^[a-z0-9-]+$/;
const fingerprintCache = new Map();

function userSkillsDirectory() {
  return path.join(userDataDirectory(), 'skills');
}

function sharedUserSkillsDirectory() {
  return path.join(os.homedir(), '.agents', 'skills');
}

function projectSkillsDirectory(cwd) {
  return path.join(path.resolve(cwd), '.pi-studio', 'skills');
}

function sharedProjectSkillsDirectory(cwd) {
  return path.join(path.resolve(cwd), '.agents', 'skills');
}

function projectSkillRoots(cwd) {
  return [
    projectSkillsDirectory(cwd),
    sharedProjectSkillsDirectory(cwd),
  ];
}

function containedBy(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Parse frontmatter with the same YAML implementation Pi uses. Invalid YAML
 * must fail the skill instead of producing a partially parsed instruction file.
 */
function parseFrontmatter(source) {
  const normalized = String(source || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) return { fields: {}, body: normalized };
  const parsed = parseYaml(match[1]);
  const fields = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : {};
  return { fields, body: match[2].trim() };
}

function validateSkillMetadata({
  name,
  description,
  fields,
  baseDir,
}) {
  const errors = [];
  if (typeof fields.name !== 'string' || !fields.name.trim()) {
    errors.push('frontmatter 缺少 name，已使用目录名');
  }
  if (!description || !String(description).trim()) errors.push('description 必填');
  if (String(description || '').length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description 不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符`);
  }
  if (!name || name.length > MAX_NAME_LENGTH) {
    errors.push(`name 长度必须为 1–${MAX_NAME_LENGTH}`);
  }
  if (!NAME_PATTERN.test(name)) errors.push('name 只能包含小写字母、数字和连字符');
  if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
    errors.push('name 不能以连字符开头或结尾，也不能包含连续连字符');
  }
  if (baseDir && name !== path.basename(baseDir)) {
    errors.push(`name「${name}」必须与技能目录名「${path.basename(baseDir)}」一致`);
  }
  const compatibility = fields.compatibility;
  if (
    compatibility !== undefined
    && (
      typeof compatibility !== 'string'
      || compatibility.trim().length === 0
      || compatibility.length > 500
    )
  ) {
    errors.push('compatibility 必须是 1–500 个字符的字符串');
  }
  const metadata = fields.metadata;
  if (
    metadata !== undefined
    && (
      !metadata
      || typeof metadata !== 'object'
      || Array.isArray(metadata)
      || Object.values(metadata).some((value) => typeof value !== 'string')
    )
  ) {
    errors.push('metadata 必须是字符串键值映射');
  }
  if (fields['allowed-tools'] !== undefined && typeof fields['allowed-tools'] !== 'string') {
    errors.push('allowed-tools 必须是空格分隔的字符串');
  }
  return errors;
}

function directoryStatSignature(root) {
  const absoluteRoot = path.resolve(root);
  const realRoot = fs.realpathSync(absoluteRoot);
  const hash = crypto.createHash('sha256');
  let entries = 0;
  let totalBytes = 0;
  const activeDirectories = new Set();
  const visitedDirectories = new Set();

  function addFileStat(relative, stat) {
    const size = Number(stat.size);
    if (size > MAX_FINGERPRINT_FILE_BYTES) {
      throw new Error(`技能文件超过 ${MAX_FINGERPRINT_FILE_BYTES} 字节：${relative}`);
    }
    totalBytes += size;
    if (totalBytes > MAX_FINGERPRINT_TOTAL_BYTES) {
      throw new Error(`技能目录总大小超过 ${MAX_FINGERPRINT_TOTAL_BYTES} 字节`);
    }
    hash.update([
      relative,
      stat.mode,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join('\0'));
    hash.update('\0');
  }

  function visit(directory, logicalDirectory, depth) {
    if (depth > MAX_TREE_DEPTH) throw new Error(`技能目录超过 ${MAX_TREE_DEPTH} 层`);
    const realDirectory = fs.realpathSync(directory);
    if (!containedBy(realRoot, realDirectory)) {
      throw new Error(`技能目录包含指向外部的符号链接：${logicalDirectory}`);
    }
    if (activeDirectories.has(realDirectory)) {
      const relative = path.relative(absoluteRoot, logicalDirectory).split(path.sep).join('/');
      hash.update(`cycle:${relative}\0`);
      return;
    }
    if (visitedDirectories.has(realDirectory)) {
      const relative = path.relative(absoluteRoot, logicalDirectory).split(path.sep).join('/');
      hash.update(`visited:${relative}\0${realDirectory}\0`);
      return;
    }
    activeDirectories.add(realDirectory);
    visitedDirectories.add(realDirectory);
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (child.isDirectory() && SKIPPED_DIRECTORIES.has(child.name)) continue;
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) throw new Error(`技能目录超过 ${MAX_TREE_ENTRIES} 项`);
      const full = path.join(directory, child.name);
      const logicalFull = path.join(logicalDirectory, child.name);
      const relative = path.relative(absoluteRoot, logicalFull).split(path.sep).join('/');
      const stat = fs.lstatSync(full, { bigint: true });
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(full);
        const target = fs.realpathSync(full);
        if (!containedBy(realRoot, target)) {
          throw new Error(`技能目录包含指向外部的符号链接：${relative}`);
        }
        const targetStat = fs.statSync(target, { bigint: true });
        hash.update(`link\0${relative}\0${link}\0${path.relative(realRoot, target)}\0`);
        if (targetStat.isDirectory()) {
          hash.update(`directory\0${targetStat.mode}\0${targetStat.mtimeNs}\0${targetStat.ctimeNs}\0`);
          visit(target, logicalFull, depth + 1);
        } else if (targetStat.isFile()) {
          addFileStat(relative, targetStat);
        } else {
          hash.update(`special\0${relative}\0${targetStat.mode}\0`);
        }
      } else if (stat.isDirectory()) {
        hash.update(`directory\0${relative}\0${stat.mode}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`);
        visit(full, logicalFull, depth + 1);
      } else if (stat.isFile()) {
        addFileStat(relative, stat);
      } else {
        hash.update(`special\0${relative}\0${stat.mode}\0`);
      }
    }
    activeDirectories.delete(realDirectory);
  }

  visit(absoluteRoot, absoluteRoot, 0);
  return hash.digest('hex');
}

function hashDirectoryFingerprint(root) {
  const absoluteRoot = path.resolve(root);
  const realRoot = fs.realpathSync(absoluteRoot);
  const hash = crypto.createHash('sha256');
  let entries = 0;
  let totalBytes = 0;
  const activeDirectories = new Set();
  const visitedDirectories = new Set();

  function visit(directory, logicalDirectory, depth) {
    if (depth > MAX_TREE_DEPTH) throw new Error(`技能目录超过 ${MAX_TREE_DEPTH} 层`);
    const realDirectory = fs.realpathSync(directory);
    if (!containedBy(realRoot, realDirectory)) {
      throw new Error(`技能目录包含指向外部的符号链接：${logicalDirectory}`);
    }
    if (activeDirectories.has(realDirectory)) {
      const relative = path.relative(absoluteRoot, logicalDirectory).split(path.sep).join('/');
      hash.update(`cycle:${relative}\0`);
      return;
    }
    if (visitedDirectories.has(realDirectory)) {
      const relative = path.relative(absoluteRoot, logicalDirectory).split(path.sep).join('/');
      hash.update(`visited:${relative}\0${realDirectory}\0`);
      return;
    }
    activeDirectories.add(realDirectory);
    visitedDirectories.add(realDirectory);
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    const hashFile = (file, relative) => {
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error(`技能目录项不是普通文件：${relative}`);
      if (stat.size > MAX_FINGERPRINT_FILE_BYTES) {
        throw new Error(`技能文件超过 ${MAX_FINGERPRINT_FILE_BYTES} 字节：${relative}`);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_FINGERPRINT_TOTAL_BYTES) {
        throw new Error(`技能目录总大小超过 ${MAX_FINGERPRINT_TOTAL_BYTES} 字节`);
      }
      hash.update('file\0');
      const descriptor = fs.openSync(file, 'r');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      try {
        let offset = 0;
        while (true) {
          const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
      } finally {
        fs.closeSync(descriptor);
      }
      hash.update('\0');
    };
    for (const child of children) {
      if (child.isDirectory() && SKIPPED_DIRECTORIES.has(child.name)) continue;
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) throw new Error(`技能目录超过 ${MAX_TREE_ENTRIES} 项`);
      const full = path.join(directory, child.name);
      const logicalFull = path.join(logicalDirectory, child.name);
      const relative = path.relative(absoluteRoot, logicalFull).split(path.sep).join('/');
      const stat = fs.lstatSync(full);
      hash.update(`${relative}\0${stat.mode}\0`);
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(full);
        const target = fs.realpathSync(full);
        if (!containedBy(realRoot, target)) {
          throw new Error(`技能目录包含指向外部的符号链接：${relative}`);
        }
        hash.update(`link:${link}\0target:${path.relative(realRoot, target)}\0`);
        const targetStat = fs.statSync(target);
        if (targetStat.isDirectory()) {
          visit(target, logicalFull, depth + 1);
        } else if (targetStat.isFile()) {
          hashFile(target, relative);
        } else {
          hash.update(`special:${targetStat.mode}\0`);
        }
      } else if (stat.isDirectory()) {
        hash.update('directory\0');
        visit(full, logicalFull, depth + 1);
      } else if (stat.isFile()) {
        hashFile(full, relative);
      } else {
        hash.update(`special:${stat.mode}\0`);
      }
    }
    activeDirectories.delete(realDirectory);
  }

  visit(absoluteRoot, absoluteRoot, 0);
  return hash.digest('hex');
}

/**
 * Directory contents remain the trust source of truth. The metadata signature
 * avoids rereading potentially large Skill assets on every model loop turn;
 * any normal file, directory, permission, timestamp, or symlink change falls
 * back to a full content hash.
 */
function directoryFingerprint(root) {
  const realRoot = fs.realpathSync(path.resolve(root));
  const signature = directoryStatSignature(realRoot);
  const cached = fingerprintCache.get(realRoot);
  if (cached?.signature === signature) return cached.contentHash;
  const contentHash = hashDirectoryFingerprint(realRoot);
  fingerprintCache.delete(realRoot);
  fingerprintCache.set(realRoot, { signature, contentHash });
  while (fingerprintCache.size > MAX_FINGERPRINT_CACHE_ENTRIES) {
    fingerprintCache.delete(fingerprintCache.keys().next().value);
  }
  return contentHash;
}

function trustForProjectSkill(cwd, baseDir, fingerprint) {
  const workspace = path.resolve(cwd);
  const record = getStudioDatabase().getProjectResourceTrust(
    workspace,
    'skill',
    path.resolve(baseDir),
  );
  if (!record?.trusted) return { trusted: false, changed: false };
  return {
    trusted: record.contentHash === fingerprint,
    changed: record.contentHash !== fingerprint,
  };
}

function skillFromFile(filePath, scope, cwd, origin, fingerprint) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_SKILL_BYTES) throw new Error(`SKILL.md 超过 ${MAX_SKILL_BYTES} 字节`);
  const parsed = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
  const baseDir = path.dirname(filePath);
  const name = typeof parsed.fields.name === 'string' && parsed.fields.name.trim()
    ? parsed.fields.name.trim()
    : path.basename(baseDir);
  const description = typeof parsed.fields.description === 'string'
    ? parsed.fields.description.trim()
    : '';
  const warnings = validateSkillMetadata({
    name,
    description,
    fields: parsed.fields,
    baseDir,
  });
  if (!description) throw new Error('SKILL.md frontmatter 缺少 description');
  const projectFingerprint = scope === 'project'
    ? fingerprint || directoryFingerprint(baseDir)
    : '';
  const trust = scope === 'user'
    ? { trusted: true, changed: false }
    : trustForProjectSkill(cwd, baseDir, projectFingerprint);
  return {
    name,
    description,
    path: filePath,
    baseDir,
    scope,
    origin,
    bytes: stat.size,
    fingerprint: projectFingerprint,
    trusted: trust.trusted,
    trustChanged: trust.changed,
    available: scope === 'user' || trust.trusted,
    disableModelInvocation: parsed.fields['disable-model-invocation'] === true,
    warnings,
  };
}

function discoverRoot(root, scope, cwd, output, safetyRoot, origin) {
  if (!fs.existsSync(root)) return;
  const realDirectories = new Set();
  let budget = MAX_TREE_ENTRIES;

  function visit(directory, depth) {
    if (depth > MAX_TREE_DEPTH || budget <= 0) return;
    let realDirectory;
    try {
      realDirectory = fs.realpathSync(directory);
    } catch {
      return;
    }
    if (safetyRoot && !containedBy(safetyRoot, realDirectory)) {
      output.diagnostics.push({
        path: directory,
        message: '项目技能路径通过符号链接越出工作区，已忽略',
      });
      return;
    }
    if (realDirectories.has(realDirectory)) return;
    realDirectories.add(realDirectory);

    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      output.diagnostics.push({ path: directory, message: errorMessage(error) });
      return;
    }
    budget -= entries.length;

    for (const entry of entries) {
      if (entry.name === SKILL_FILE) {
        const file = path.join(directory, entry.name);
        try {
          if (!fs.statSync(file).isFile()) continue;
          if (safetyRoot && !containedBy(safetyRoot, fs.realpathSync(file))) {
            output.diagnostics.push({
              path: file,
              message: '项目技能文件通过符号链接越出工作区，已忽略',
            });
            return;
          }
          output.candidates.push(skillFromFile(file, scope, cwd, origin));
        } catch (error) {
          output.diagnostics.push({ path: file, message: errorMessage(error) });
        }
        // Official Agent Skills discovery stops at a SKILL.md directory.
        return;
      }
    }

    for (const entry of entries) {
      if (budget <= 0) {
        output.diagnostics.push({ path: root, message: `技能目录超过 ${MAX_TREE_ENTRIES} 项，扫描已停止` });
        return;
      }
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = fs.statSync(full).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDirectory) visit(full, depth + 1);
    }
  }

  visit(root, 0);
}

function discoverSkills(cwd) {
  const realCwd = typeof cwd === 'string' && cwd ? path.resolve(cwd) : '';
  let realWorkspace = '';
  if (realCwd) {
    try {
      realWorkspace = fs.realpathSync(realCwd);
    } catch {
      realWorkspace = '';
    }
  }
  // Agent Skills uses project-over-user precedence. Studio's native project
  // directory wins over the shared project directory, and the same order is
  // used for user skills.
  const roots = [
    ...(realCwd
      ? [{
          scope: 'project',
          root: projectSkillsDirectory(realCwd),
          safetyRoot: realWorkspace,
          origin: 'studio',
        }, {
          scope: 'project',
          root: sharedProjectSkillsDirectory(realCwd),
          safetyRoot: realWorkspace,
          origin: 'agents',
        }]
      : []),
    {
      scope: 'user',
      root: userSkillsDirectory(),
      safetyRoot: '',
      origin: 'studio',
    },
    {
      scope: 'user',
      root: sharedUserSkillsDirectory(),
      safetyRoot: '',
      origin: 'agents',
    },
  ];
  const output = { candidates: [], diagnostics: [] };
  for (const source of roots) {
    discoverRoot(
      source.root,
      source.scope,
      realCwd,
      output,
      source.safetyRoot,
      source.origin,
    );
  }

  const seenFiles = new Set();
  const byName = new Map();
  for (const skill of output.candidates) {
    let realFile;
    try {
      realFile = fs.realpathSync(skill.path);
    } catch {
      realFile = skill.path;
    }
    if (seenFiles.has(realFile)) continue;
    const existing = byName.get(skill.name);
    if (existing) {
      output.diagnostics.push({
        path: skill.path,
        message: `技能名「${skill.name}」与 ${existing.path} 冲突；先发现的技能生效`,
      });
      continue;
    }
    seenFiles.add(realFile);
    byName.set(skill.name, skill);
  }

  for (const skill of byName.values()) {
    for (const warning of skill.warnings) {
      output.diagnostics.push({ path: skill.path, message: warning });
    }
    if (skill.trustChanged) {
      output.diagnostics.push({
        path: skill.path,
        message: '项目技能内容已变化，之前的信任已失效',
      });
    }
  }
  return {
    skills: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    errors: output.diagnostics,
  };
}

/**
 * Pi puts only routing metadata in the prompt. The body stays on disk and is
 * read by the model through its file tools when the description matches.
 */
function skillInstructions(cwd, offeredTools) {
  const visible = discoverSkills(cwd).skills.filter((skill) => (
    skill.available && !skill.disableModelInvocation
  ));
  if (visible.length === 0) return undefined;
  // `undefined` preserves the official default for direct service callers.
  // The Harness passes the actual request tool list so a disabled read/bash
  // tool never leaves the model with an instruction it cannot execute.
  const toolNames = Array.isArray(offeredTools)
    ? new Set(offeredTools.map((tool) => (
        typeof tool === 'string' ? tool : tool?.name
      )).filter(Boolean))
    : new Set(['read']);
  const fileReader = toolNames.has('read')
    ? 'read'
    : toolNames.has('bash')
      ? 'bash'
      : '';
  if (!fileReader) return undefined;
  return [
    'The following skills provide specialized instructions for specific tasks.',
    fileReader === 'read'
      ? 'Use the read tool to load a skill\'s SKILL.md file when the task matches its description.'
      : 'Use bash to read a skill\'s SKILL.md file when the task matches its description.',
    'When a skill file references a relative path, resolve it against the skill directory (the parent of SKILL.md) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
    ...visible.flatMap((skill) => [
      '  <skill>',
      `    <name>${xml(skill.name)}</name>`,
      `    <description>${xml(skill.description)}</description>`,
      `    <location>${xml(skill.path)}</location>`,
      '  </skill>',
    ]),
    '</available_skills>',
  ].join('\n');
}

function expandSkillCommand(text, cwd) {
  const source = String(text || '');
  if (!source.startsWith('/skill:')) return source;
  const space = source.indexOf(' ');
  const name = space === -1 ? source.slice(7) : source.slice(7, space);
  const args = space === -1 ? '' : source.slice(space + 1).trim();
  const skill = discoverSkills(cwd).skills.find((item) => item.name === name);
  if (!skill) return source;
  if (!skill.available) throw new Error(`项目技能「${name}」尚未信任或内容已经变化`);
  const outer = fs.readFileSync(skill.path, 'utf8');
  const body = parseFrontmatter(outer).body.trim();
  if (!body) throw new Error(`技能「${name}」没有可用正文`);
  const block = [
    `<skill name="${xml(skill.name)}" location="${xml(skill.path)}">`,
    `References are relative to ${skill.baseDir}.`,
    '',
    body,
    '</skill>',
  ].join('\n');
  return args ? `${block}\n\n${args}` : block;
}

function composerSkills(cwd) {
  return discoverSkills(cwd).skills
    .filter((skill) => skill.available)
    .map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: 'skill',
    }));
}

function setSkillTrusted(skillPath, cwd, trusted) {
  if (!cwd) throw new Error('项目技能需要当前工作区');
  const workspace = path.resolve(cwd);
  const roots = projectSkillRoots(workspace);
  const resolved = path.resolve(String(skillPath || ''));
  if (
    path.basename(resolved) !== SKILL_FILE
    || !roots.some((root) => containedBy(root, resolved))
  ) {
    throw new Error('只能信任或撤销当前项目的技能');
  }
  const skill = discoverSkills(workspace).skills.find((item) => item.path === resolved);
  if (!skill) throw new Error('技能不存在');
  if (trusted) {
    return getStudioDatabase().setProjectResourceTrust({
      workspace,
      kind: 'skill',
      resourcePath: skill.baseDir,
      contentHash: directoryFingerprint(skill.baseDir),
      trusted: true,
    });
  }
  getStudioDatabase().removeProjectResourceTrust(workspace, 'skill', skill.baseDir);
  return undefined;
}

function importSkill(sourcePath, scope, cwd) {
  if (!['user', 'project'].includes(scope)) throw new Error('技能范围无效');
  if (scope === 'project' && !cwd) throw new Error('项目技能需要当前工作区');
  const source = path.resolve(String(sourcePath || ''));
  const sourceFile = path.join(source, SKILL_FILE);
  if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
    throw new Error('所选目录必须直接包含 SKILL.md');
  }
  const parsed = parseFrontmatter(fs.readFileSync(sourceFile, 'utf8'));
  const declaredName = typeof parsed.fields.name === 'string' && parsed.fields.name.trim()
    ? parsed.fields.name.trim()
    : path.basename(source);
  const description = typeof parsed.fields.description === 'string'
    ? parsed.fields.description.trim()
    : '';
  if (!description) throw new Error('SKILL.md frontmatter 缺少 description');
  validateSkillMetadata({
    name: declaredName,
    description,
    fields: parsed.fields,
    baseDir: source,
  });
  const root = scope === 'project' ? projectSkillsDirectory(cwd) : userSkillsDirectory();
  const target = path.join(root, path.basename(source));
  if (!containedBy(root, target)) throw new Error('技能目录名无效');
  if (fs.existsSync(target)) throw new Error('同名技能目录已存在');
  const current = discoverSkills(cwd).skills.find((skill) => skill.name === declaredName);
  if (current) throw new Error(`技能名「${declaredName}」已经被 ${current.path} 使用`);
  fs.mkdirSync(root, { recursive: true });
  try {
    // Project skills are executable project content. Validate the complete
    // source graph before copying so an external symlink cannot be imported.
    if (scope === 'project') directoryFingerprint(source);
    fs.cpSync(source, target, { recursive: true, errorOnExist: true, dereference: false });
    if (scope === 'project') directoryFingerprint(target);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return target;
}

function removeSkill(skillFile, cwd) {
  const resolved = path.resolve(String(skillFile || ''));
  if (path.basename(resolved) !== SKILL_FILE) throw new Error('技能路径无效');
  const skillDirectory = path.dirname(resolved);
  const roots = [
    userSkillsDirectory(),
    sharedUserSkillsDirectory(),
    ...(cwd ? projectSkillRoots(cwd) : []),
  ];
  if (!roots.some((root) => containedBy(root, skillDirectory))) {
    throw new Error('不能删除这个位置的技能');
  }
  const stat = fs.lstatSync(skillDirectory);
  if (stat.isSymbolicLink()) throw new Error('不能删除符号链接形式的技能');
  if (!fs.existsSync(resolved)) throw new Error('技能不存在');
  fs.rmSync(skillDirectory, { recursive: true, force: true });
  if (
    cwd
    && projectSkillRoots(cwd).some((root) => containedBy(root, skillDirectory))
  ) {
    getStudioDatabase().removeProjectResourceTrust(
      path.resolve(cwd),
      'skill',
      skillDirectory,
    );
  }
}

module.exports = {
  composerSkills,
  directoryFingerprint,
  discoverSkills,
  expandSkillCommand,
  importSkill,
  parseFrontmatter,
  projectSkillRoots,
  projectSkillsDirectory,
  removeSkill,
  setSkillTrusted,
  sharedProjectSkillsDirectory,
  sharedUserSkillsDirectory,
  skillInstructions,
  userSkillsDirectory,
};

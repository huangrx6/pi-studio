/**
 * Studio's coding harness prompt.
 *
 * Durable deliberately does not carry the coding-agent SDK's default prompt.
 * Studio therefore owns an explicit, inspectable prompt contract. Every
 * section has a stable identity and can be enabled independently so changes
 * remain cache-friendly and can later be overridden by agent profiles or
 * extensions.
 */

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getHarnessProfile } = require('../core/app-settings.cjs');
const { globalInstructionFile } = require('../core/studio-paths.cjs');

const MAX_INSTRUCTION_FILES = 8;
const MAX_INSTRUCTION_BYTES = 256 * 1024;
const MAX_INSTRUCTION_FILE_BYTES = 128 * 1024;
const MAX_DOCUMENT_NAMES = 48;
const PROJECT_MARKERS = ['.git', '.pi-studio'];

const PREAMBLE = [
  'You are Pi Studio, an expert coding agent operating inside the user\'s workspace.',
  'Work from evidence: inspect the repository and current state before changing code, and use tools rather than guessing.',
  'Carry work through implementation, focused verification, and a clear result. Do not stop at analysis or a proposal when the user asked for a change.',
  'Treat user changes as intentional. Preserve unrelated work and explain any unavoidable tradeoff.',
  'Reply in the user\'s language. Keep progress messages concise and make the final answer explain what changed, how it was verified, and any material limitation.',
].join('\n');

const CODING_RULES = [
  'Engineering rules:',
  '- Read the relevant files before editing. Search for all call sites and tests that define the behavior.',
  '- Batch independent inspection, search, and read calls in one tool round. Keep dependent steps in later rounds; Durable may execute independent calls concurrently.',
  '- Prefer the smallest coherent change. Keep edits local, use exact replacements, and do not rewrite unrelated code.',
  '- Keep modules and interfaces explicit. Avoid compatibility shims, duplicate sources of truth, and dead fallback paths.',
  '- Preserve public behavior unless the request or tests require a change. Add a focused check only when it materially reduces a concrete risk.',
  '- Run the narrowest relevant checks first, then broaden only when a remaining risk or required gate justifies it.',
  '- Never claim a command, test, or build passed unless it actually ran and passed. Report skipped verification honestly.',
  '- Do not discard user changes, rewrite Git history, publish, deploy, or delete remote resources unless the user explicitly requested it.',
  '- Never print secrets or credentials. Do not add secrets to source, fixtures, logs, or commits.',
  '- Resolve blockers internally where possible. If a required external fact or approval is missing, state exactly what is needed.',
].join('\n');

const TOOL_GUIDANCE = Object.freeze({
  read: 'Inspect files with the ranges needed for the task. Do not infer contents from filenames or stale memory.',
  write: 'Create or replace a file only when a complete write is clearer than a local edit.',
  edit: 'Use the smallest unique replacement. Combine adjacent changes, keep enough context to disambiguate, and re-read after a failed or ambiguous edit.',
  bash: 'Use non-interactive commands. Do not edit source through shell redirection when edit/write is available. Check exit status and retained output; use Git and tests to verify state.',
  ls: 'Use directory listings to orient before opening files.',
  find: 'Locate files by name when the path is unknown, then read the relevant matches.',
  grep: 'Search definitions and call sites before changing an API or shared behavior.',
  todo: 'For multi-step work, create a compact plan before implementation, keep one task in progress, and complete it immediately after verification. Skip this tool for simple one-step requests.',
  subagent: 'Delegate only self-contained work. Give the child complete context and incorporate its verified result.',
});

function profileFor(cwd) {
  return getHarnessProfile(cwd || '');
}

function sectionEnabled(cwd, section) {
  return profileFor(cwd).sections[section] !== false;
}

function sectionOverride(cwd, section) {
  const value = profileFor(cwd).sectionOverrides?.[section];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function renderSection(input, section, fallback) {
  const cwd = input?.env?.cwd || input?.agent?.cwd;
  const profile = profileFor(cwd);
  if (profile.sections[section] === false) return undefined;
  const override = profile.sectionOverrides?.[section];
  if (typeof override === 'string' && override.trim()) return override.trim();
  return fallback(profile, input);
}

function toolGuidance(input, profile = profileFor(input?.agent?.cwd)) {
  const tools = Array.isArray(input?.agent?.tools) ? input.agent.tools : [];
  if (tools.length === 0) {
    return [
      'No coding tools are offered in this request.',
      'Answer only from the supplied conversation context and say when verification would require a workspace tool.',
    ].join('\n');
  }
  return [
    'Tools offered in this request:',
    ...tools.slice(0, 64).map((tool) => {
      const name = String(tool?.name || '').slice(0, 120);
      if (!name) return '';
      const description = String(tool?.description || '').trim().slice(0, 600);
      const guidance = profile?.toolGuidance?.[name] || TOOL_GUIDANCE[name];
      const detail = [description, guidance].filter(Boolean).join(' ');
      return `- ${name}${detail ? `: ${detail}` : ''}`;
    }).filter(Boolean),
    'Issue several independent tool calls in the same round when they do not depend on each other. A later step that needs an earlier result must wait for that result.',
    'Use the available tools directly. A tool failure is evidence to inspect, not permission to invent a result.',
  ].join('\n');
}

function directoriesFromRoot(root, cwd) {
  const relative = path.relative(root, cwd);
  const parts = relative ? relative.split(path.sep) : [];
  const rows = [];
  let current = root;
  rows.push(current);
  for (const part of parts) {
    current = path.join(current, part);
    rows.push(current);
  }
  return rows;
}

async function readableText(file, limit = MAX_INSTRUCTION_FILE_BYTES) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > limit) return undefined;
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

async function hasProjectMarker(directory) {
  for (const marker of PROJECT_MARKERS) {
    try {
      await fs.stat(path.join(directory, marker));
      return true;
    } catch {
      // Keep looking for another marker or a parent project boundary.
    }
  }
  return false;
}

async function projectRoot(cwd) {
  if (!cwd) return undefined;
  const resolved = path.resolve(cwd);
  let current = resolved;
  while (true) {
    if (await hasProjectMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

function projectInstructionCandidates(cwd, root) {
  const candidates = [];
  for (const directory of directoriesFromRoot(root, cwd)) {
    candidates.push({
      file: path.join(directory, 'AGENTS.md'),
      scope: 'project',
    });
    candidates.push({
      file: path.join(directory, '.pi-studio', 'AGENTS.md'),
      scope: 'project',
    });
  }
  return candidates;
}

async function instructionFiles(candidates) {
  const files = [];
  const seen = new Set();
  let bytes = 0;
  for (const candidate of candidates) {
    if (files.length >= MAX_INSTRUCTION_FILES) break;
    const file = path.resolve(candidate.file);
    if (seen.has(file)) continue;
    seen.add(file);
    const body = await readableText(file);
    if (!body) continue;
    const size = Buffer.byteLength(body);
    if (bytes + size > MAX_INSTRUCTION_BYTES) continue;
    bytes += size;
    files.push({ file, body, scope: candidate.scope });
  }
  return files;
}

async function projectInstructionFiles(cwd) {
  if (!cwd) return [];
  const resolved = path.resolve(cwd);
  const root = await projectRoot(resolved);
  return instructionFiles(projectInstructionCandidates(resolved, root));
}

async function agentInstructionFiles(cwd) {
  return instructionFiles([
    { file: globalInstructionFile(), scope: 'global' },
    ...(cwd
      ? projectInstructionCandidates(
          path.resolve(cwd),
          await projectRoot(cwd),
        )
      : []),
  ]);
}

function escapedAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function projectContext(cwd) {
  const files = await agentInstructionFiles(cwd);
  if (files.length === 0) return undefined;
  return [
    'Agent instruction files are ordered from global to project-specific. Later project files override earlier files when instructions conflict.',
    ...files.map(({ file, body, scope }) => {
      const label = scope === 'global'
        ? file
        : path.relative(path.resolve(cwd), file) || file;
      return `<agent-instructions scope="${scope}" path="${escapedAttribute(label)}">\n${body}\n</agent-instructions>`;
    }),
  ].join('\n\n');
}

async function listMarkdown(directory, relativeRoot, rows) {
  if (rows.length >= MAX_DOCUMENT_NAMES) return;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (rows.length >= MAX_DOCUMENT_NAMES) break;
    const full = path.join(directory, entry.name);
    if (entry.isFile() && /\.(?:md|mdx)$/i.test(entry.name)) {
      rows.push(path.relative(relativeRoot, full));
    }
  }
}

async function repositoryDocs(cwd) {
  if (!cwd) return undefined;
  const rows = [];
  await listMarkdown(cwd, cwd, rows);
  await listMarkdown(path.join(cwd, 'docs'), cwd, rows);
  await listMarkdown(path.join(cwd, '.pi-studio'), cwd, rows);
  if (rows.length === 0) return undefined;
  return [
    'Repository documentation is available. Read the relevant source instead of relying on memory or assumptions:',
    ...[...new Set(rows)].slice(0, MAX_DOCUMENT_NAMES).map((file) => `- ${file}`),
  ].join('\n');
}

function cwdText(cwd) {
  if (!cwd) return undefined;
  const home = os.homedir();
  const display = cwd.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, cwd)}` : cwd;
  return [
    `Primary workspace: ${display}`,
    'Treat this as the default root for file operations. Access outside it only when the user request clearly requires that.',
  ].join('\n');
}

function addendumText(profile) {
  const value = String(profile?.customInstructions || '').trim();
  return value || undefined;
}

function createStudioHarnessExtension(durable) {
  return durable.defineExtension({
    name: 'studio-harness',
    sections: [
      durable.section('preamble', (input) => (
        renderSection(input, 'preamble', () => PREAMBLE)
      )),
      durable.section('studio-tools', (input) => (
        renderSection(input, 'tools', (profile) => toolGuidance(input, profile))
      )),
      durable.section('coding-rules', (input) => (
        renderSection(input, 'rules', () => CODING_RULES)
      )),
      durable.section('repository-docs', async (input) => (
        renderSection(input, 'repositoryDocs', (_profile, value) => repositoryDocs(value.agent?.cwd))
      )),
      durable.section('project-context', async (input) => (
        renderSection(input, 'projectContext', (_profile, value) => projectContext(value.agent?.cwd))
      )),
      durable.section('cwd', (input) => (
        renderSection(input, 'cwd', (_profile, value) => cwdText(value.agent?.cwd))
      )),
      durable.section('addendum', (input) => (
        renderSection(input, 'addendum', (profile) => addendumText(profile))
      )),
    ],
  });
}

module.exports = {
  CODING_RULES,
  PREAMBLE,
  TOOL_GUIDANCE,
  addendumText,
  agentInstructionFiles,
  createStudioHarnessExtension,
  cwdText,
  globalInstructionFile,
  projectContext,
  projectInstructionFiles,
  projectRoot,
  renderSection,
  repositoryDocs,
  sectionEnabled,
  sectionOverride,
  toolGuidance,
};

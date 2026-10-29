/**
 * Permission policy for Durable tool hooks.
 *
 * The policy is intentionally data-only: no regular expressions, JavaScript,
 * shell evaluation, or renderer callbacks are accepted. Tool names may use `*`
 * glob wildcards. Command rules support literal prefixes or exact commands and
 * file rules resolve paths relative to the active workspace.
 */

const path = require('node:path');
const os = require('node:os');

const PERMISSION_MODES = Object.freeze(['ask', 'smart', 'full']);
const PERMISSION_DECISIONS = Object.freeze(['allow', 'ask', 'deny']);
const PRESET_DEFAULTS = Object.freeze({
  ask: 'ask',
  smart: 'ask',
  full: 'allow',
});
const SAFE_TOOLS = new Set(['read', 'ls', 'find', 'grep', 'tool_search']);
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'find', 'grep']);
const MAX_TOOL_ENTRIES = 256;
const MAX_RULES = 128;
const MAX_WORKSPACE_POLICIES = 512;
const MAX_SESSION_POLICIES = 2_000;
const MAX_PATTERN_LENGTH = 200;
const MAX_RULE_LABEL = 120;
const TOOL_PATTERN = /^[A-Za-z0-9_.:*-]{1,160}$/;
const RULE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const SHELL_CONTROL = new Set([';', '&&', '||', '|', '&', '\n']);
const SHELL_REDIRECT = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const SHELL_WRAPPERS = new Set([
  'command', 'builtin', 'env', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'timeout',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);
const SCRIPT_RUNNERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'php', 'pwsh', 'powershell']);
const GIT_MUTATING_COMMANDS = new Set([
  'add', 'am', 'apply', 'branch', 'checkout', 'clean', 'clone', 'commit', 'config',
  'fetch', 'gc', 'init', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore',
  'rm', 'stash', 'switch', 'tag', 'update-ref', 'worktree',
]);
const DANGEROUS_SHELL_COMMANDS = new Set([
  'sudo', 'su', 'shutdown', 'reboot', 'halt', 'poweroff', 'mkfs', 'mkfs.ext4',
]);
const ALL_PATH_WRITES = new Set([
  'chmod', 'chown', 'mkdir', 'rm', 'rmdir', 'tee', 'touch', 'truncate',
]);
const DESTINATION_WRITES = new Set(['cp', 'install', 'ln', 'mv']);

function presetDefault(mode) {
  return PRESET_DEFAULTS[mode] || PRESET_DEFAULTS.smart;
}

function defaultPolicy(mode = 'smart') {
  const preset = PERMISSION_MODES.includes(mode) ? mode : 'smart';
  return {
    version: 1,
    preset,
    default: presetDefault(preset),
    tools: {},
    rules: [],
  };
}

function normalizeToolPattern(value) {
  if (typeof value !== 'string') return '';
  const pattern = value.trim();
  if (!TOOL_PATTERN.test(pattern)) return '';
  // A wildcard is allowed, arbitrary regex syntax is not.
  if (/[^A-Za-z0-9_.:*-]/.test(pattern)) return '';
  return pattern;
}

function wildcardToMatcher(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}

function toolMatches(pattern, name) {
  return Boolean(pattern && name && wildcardToMatcher(pattern).test(name));
}

function safeString(value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : '';
}

function normalizePathPattern(value) {
  return safeString(value, MAX_PATTERN_LENGTH)
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
}

function normalizeRule(value, index, strict) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw new Error(`权限规则 ${index + 1} 必须是对象`);
    return undefined;
  }
  const decision = PERMISSION_DECISIONS.includes(value.decision) ? value.decision : '';
  const tool = normalizeToolPattern(value.match?.tool || value.tool);
  if (!decision || !tool) {
    if (strict) throw new Error(`权限规则 ${index + 1} 需要有效的 tool 和 decision`);
    return undefined;
  }
  const commandPrefix = safeString(value.match?.commandPrefix, MAX_PATTERN_LENGTH).trim();
  const commandExact = safeString(value.match?.commandExact, MAX_PATTERN_LENGTH).trim();
  const pathGlob = normalizePathPattern(value.match?.pathGlob);
  const pathExact = normalizePathPattern(value.match?.pathExact);
  const pathWithin = value.match?.pathWithin === 'workspace' ? 'workspace' : '';
  if (commandPrefix && commandExact) {
    if (strict) throw new Error(`权限规则 ${index + 1} 不能同时设置 commandPrefix 和 commandExact`);
    return undefined;
  }
  if ([pathGlob, pathExact, pathWithin].filter(Boolean).length > 1) {
    if (strict) throw new Error(`权限规则 ${index + 1} 只能设置一种路径条件`);
    return undefined;
  }
  const id = typeof value.id === 'string' && RULE_ID.test(value.id)
    ? value.id
    : `rule-${index + 1}`;
  const label = safeString(value.label, MAX_RULE_LABEL).trim();
  return {
    id,
    label,
    decision,
    match: {
      tool,
      ...(commandPrefix ? { commandPrefix } : {}),
      ...(commandExact ? { commandExact } : {}),
      ...(pathGlob ? { pathGlob } : {}),
      ...(pathExact ? { pathExact } : {}),
      ...(pathWithin ? { pathWithin } : {}),
    },
  };
}

function normalizePolicy(value, options = {}) {
  const strict = options.strict === true;
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const preset = PERMISSION_MODES.includes(source.preset)
    ? source.preset
    : strict
      ? undefined
      : 'smart';
  if (!preset && strict) throw new Error('无效的权限模式');
  const fallback = preset || 'smart';
  if (strict && source.default !== undefined && !PERMISSION_DECISIONS.includes(source.default)) {
    throw new Error('无效的默认权限决定');
  }
  const defaultDecision = PERMISSION_DECISIONS.includes(source.default)
    ? source.default
    : presetDefault(fallback);
  if (strict && source.tools !== undefined && (
    !source.tools
    || typeof source.tools !== 'object'
    || Array.isArray(source.tools)
  )) {
    throw new Error('工具权限必须是对象');
  }
  const rawTools = source.tools && typeof source.tools === 'object' && !Array.isArray(source.tools)
    ? source.tools
    : {};
  const tools = {};
  for (const [rawPattern, rawDecision] of Object.entries(rawTools).slice(0, MAX_TOOL_ENTRIES)) {
    const pattern = normalizeToolPattern(rawPattern);
    if (!pattern || !PERMISSION_DECISIONS.includes(rawDecision)) {
      if (strict) throw new Error(`无效的工具权限：${rawPattern}`);
      continue;
    }
    tools[pattern] = rawDecision;
  }
  if (strict && source.rules !== undefined && !Array.isArray(source.rules)) {
    throw new Error('权限规则必须是数组');
  }
  const rawRules = Array.isArray(source.rules) ? source.rules.slice(0, MAX_RULES) : [];
  const rules = rawRules
    .map((rule, index) => normalizeRule(rule, index, strict))
    .filter(Boolean);
  const ids = new Set();
  for (const rule of rules) {
    let suffix = 2;
    while (ids.has(rule.id)) rule.id = `${rule.id}-${suffix++}`;
    ids.add(rule.id);
  }
  return {
    version: 1,
    preset: fallback,
    default: defaultDecision,
    tools,
    rules,
  };
}

function normalizePolicyStore(value, options = {}) {
  const strict = options.strict === true;
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const workspaces = {};
  const workspaceEntries = Object.entries(
    source.workspaces && typeof source.workspaces === 'object' && !Array.isArray(source.workspaces)
      ? source.workspaces
      : {},
  ).filter(([cwd]) => typeof cwd === 'string' && cwd.trim());
  for (const [cwd, policy] of workspaceEntries.slice(-MAX_WORKSPACE_POLICIES)) {
    try {
      workspaces[cwd] = normalizePolicy(policy, { strict });
    } catch (error) {
      if (strict) throw error;
    }
  }
  const sessions = {};
  const sessionEntries = Object.entries(
    source.sessions && typeof source.sessions === 'object' && !Array.isArray(source.sessions)
      ? source.sessions
      : {},
  ).filter(([sessionId]) => typeof sessionId === 'string' && sessionId.trim());
  for (const [sessionId, policy] of sessionEntries.slice(-MAX_SESSION_POLICIES)) {
    try {
      sessions[sessionId] = normalizePolicy(policy, { strict });
    } catch (error) {
      if (strict) throw error;
    }
  }
  return {
    version: 1,
    user: normalizePolicy(source.user, { strict }),
    workspaces,
    sessions,
  };
}

function normalizeCommand(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
}

function pushShellToken(tokens, value) {
  if (value) tokens.push(value);
}

/**
 * A deliberately small shell lexer for static path inspection. It understands
 * quoting, escapes, pipelines and redirections, but it is not a shell parser
 * and must never be treated as a process sandbox.
 */
function tokenizeShell(command) {
  const tokens = [];
  let value = '';
  let quote = '';
  let index = 0;
  const flush = () => {
    pushShellToken(tokens, value);
    value = '';
  };
  while (index < command.length) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = '';
      } else if (character === '\\' && quote === '"' && index + 1 < command.length) {
        value += command[index + 1];
        index += 1;
      } else {
        value += character;
      }
      index += 1;
      continue;
    }
    if (character === '\'' || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (character === '\\' && index + 1 < command.length) {
      value += command[index + 1];
      index += 2;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      if (character === '\n') tokens.push('\n');
      index += 1;
      continue;
    }
    if (character === '&' && command[index + 1] === '>') {
      flush();
      const operator = command[index + 2] === '>' ? '&>>' : '&>';
      tokens.push(operator);
      index += operator.length;
      continue;
    }
    if (character === '>') {
      flush();
      const operator = command[index + 1] === '>'
        ? '>>'
        : command[index + 1] === '|'
          ? '>|'
          : '>';
      tokens.push(operator);
      index += operator.length;
      continue;
    }
    if (character === '<') {
      flush();
      const operator = command[index + 1] === '>' ? '<>' : '<';
      tokens.push(operator);
      index += operator.length;
      continue;
    }
    if (character === '&') {
      if (/[0-9]/.test(command[index + 1] || '')) {
        let descriptor = '&';
        index += 1;
        while (/[0-9-]/.test(command[index] || '')) {
          descriptor += command[index];
          index += 1;
        }
        value += descriptor;
        continue;
      }
      flush();
      const operator = command[index + 1] === '&' ? '&&' : '&';
      tokens.push(operator);
      index += operator.length;
      continue;
    }
    if (character === '|') {
      flush();
      const operator = command[index + 1] === '|' ? '||' : '|';
      tokens.push(operator);
      index += operator.length;
      continue;
    }
    if (character === ';') {
      flush();
      tokens.push(';');
      index += 1;
      continue;
    }
    value += character;
    index += 1;
  }
  flush();
  return tokens;
}

function parseShell(command) {
  const tokens = tokenizeShell(command);
  const segments = [];
  const separators = [];
  const redirects = [];
  let segment = [];
  let pendingSeparator = '';
  const finish = () => {
    if (segment.length > 0) {
      segments.push(segment);
      separators.push(pendingSeparator);
      pendingSeparator = '';
    }
    segment = [];
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (SHELL_CONTROL.has(token)) {
      finish();
      pendingSeparator = token;
      continue;
    }
    if (SHELL_REDIRECT.has(token)) {
      if (/^\d+$/.test(segment.at(-1) || '')) segment.pop();
      const target = tokens[index + 1];
      if (target && !SHELL_CONTROL.has(target) && !SHELL_REDIRECT.has(target) && target !== '<') {
        redirects.push({
          operator: token,
          target,
          segmentIndex: segments.length,
        });
        index += 1;
      }
      continue;
    }
    if (token === '<') {
      index += 1;
      continue;
    }
    segment.push(token);
  }
  finish();
  return { tokens, segments, separators, redirects };
}

function shellCommandName(tokens) {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  return path.basename(tokens[index] || '').toLowerCase();
}

function shellPathState(value, context = {}) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw === '-' || /^&\d*$/.test(raw)) return { state: 'safe' };
  if (
    raw === '/dev/null'
    || raw === '/dev/stdout'
    || raw === '/dev/stderr'
    || raw.startsWith('/dev/fd/')
    || raw.toUpperCase() === 'NUL'
  ) return { state: 'safe' };
  if (/[$`*?[\]{}]/.test(raw) || raw.includes('$(') || raw.startsWith('~+') || raw.startsWith('~-')) {
    return { state: 'ambiguous', raw };
  }
  if (context.dynamicCwd && !path.isAbsolute(raw) && !raw.startsWith('~')) {
    return { state: 'ambiguous', raw };
  }
  const cwd = path.resolve(context.cwd || process.cwd());
  let requested = raw;
  if (requested === '~') requested = context.homeDir || os.homedir();
  else if (requested.startsWith('~/')) requested = path.join(context.homeDir || os.homedir(), requested.slice(2));
  else if (requested.startsWith('~')) return { state: 'ambiguous', raw };
  const boundary = path.resolve(context.boundaryCwd || cwd);
  const absolute = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(cwd, requested);
  if (absolute === boundary || absolute.startsWith(`${boundary}${path.sep}`)) {
    return { state: 'inside', raw, absolute };
  }
  return { state: 'outside', raw, absolute };
}

function commandWithoutPrefix(tokens) {
  let selected = tokens;
  while (selected.length > 0) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(selected[0])) {
      selected = selected.slice(1);
      continue;
    }
    const name = shellCommandName(selected);
    if (name !== 'command' && name !== 'builtin') break;
    let index = 1;
    while (index < selected.length && selected[index].startsWith('-')) index += 1;
    selected = selected.slice(index);
  }
  return selected;
}

function updateShellCwd(tokens, context) {
  const selected = commandWithoutPrefix(tokens);
  const name = shellCommandName(selected);
  if (name === 'popd') {
    context.dynamicCwd = true;
    return;
  }
  if (name !== 'cd' && name !== 'pushd') return;
  const target = selected.slice(1).find((token) => !token.startsWith('-'));
  if (!target || target === '-') {
    context.dynamicCwd = true;
    return;
  }
  const resolved = shellPathState(target, context);
  if (resolved.state === 'inside' || resolved.state === 'outside') {
    context.cwd = resolved.absolute;
    context.dynamicCwd = false;
  } else {
    context.dynamicCwd = true;
  }
}

function positionalArguments(tokens) {
  const values = [];
  let options = true;
  for (const token of tokens) {
    if (options && token === '--') {
      options = false;
      continue;
    }
    if (options && token.startsWith('-') && token !== '-') continue;
    values.push(token);
  }
  return values;
}

function optionValue(tokens, shortName, longName) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === shortName || token === longName) return tokens[index + 1];
    if (longName && token.startsWith(`${longName}=`)) return token.slice(longName.length + 1);
  }
  return undefined;
}

function shellDestinationCandidates(tokens) {
  const name = shellCommandName(tokens);
  const commandIndex = tokens.findIndex((token) => path.basename(token).toLowerCase() === name);
  const args = commandIndex >= 0 ? tokens.slice(commandIndex + 1) : [];
  if (DESTINATION_WRITES.has(name)) {
    const target = optionValue(args, '-t', '--target-directory');
    if (target) return [target];
    const operands = positionalArguments(args);
    if (name === 'mv') return operands;
    return operands.length > 1 ? [operands.at(-1)] : [];
  }
  if (name === 'dd') {
    return args
      .filter((token) => token.startsWith('of='))
      .map((token) => token.slice(3))
      .filter(Boolean);
  }
  if (ALL_PATH_WRITES.has(name)) {
    const operands = positionalArguments(args);
    if (name === 'chmod' || name === 'chown') return operands.slice(1);
    return operands;
  }
  return [];
}

function inspectGitWrites(tokens, context, add) {
  if (shellCommandName(tokens) !== 'git') return;
  const candidates = [];
  let subcommand = '';
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (['-C', '--git-dir', '--work-tree'].includes(token)) {
      const value = tokens[index + 1];
      if (value) candidates.push(value);
      index += 1;
      continue;
    }
    if (token.startsWith('-C') && token.length > 2) {
      candidates.push(token.slice(2));
      continue;
    }
    if (token.startsWith('--git-dir=') || token.startsWith('--work-tree=')) {
      candidates.push(token.slice(token.indexOf('=') + 1));
      continue;
    }
    if (token === '-c' || token === '--config-env') {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    subcommand = token.toLowerCase();
    break;
  }
  if (!GIT_MUTATING_COMMANDS.has(subcommand)) return;
  for (const candidate of candidates) add(candidate);
}

function runnerInlineFlag(name, tokens) {
  const flags = SHELLS.has(name)
    ? []
    : name === 'python' || name === 'python3'
      ? ['-c', '-m', '--command']
      : ['-c', '-e', '--command', '--eval', '-p', '--print'];
  return tokens.findIndex((token) => flags.includes(token));
}

function runnerScript(tokens) {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') return tokens[index + 1];
    if (!token.startsWith('-')) return token;
  }
  return undefined;
}

function inspectShellWrites(tokens, context = {}, depth = 0) {
  if (depth > 3 || tokens.length === 0) return { external: [], ambiguous: [] };
  const name = shellCommandName(tokens);
  const result = { external: [], ambiguous: [] };
  const add = (target) => {
    const selected = shellPathState(target, context);
    if (selected.state === 'outside') result.external.push(selected);
    else if (selected.state === 'ambiguous') result.ambiguous.push(selected);
  };
  if (SHELL_WRAPPERS.has(name)) {
    const wrapped = wrapperCommandIndex(name, tokens);
    const nested = inspectShellWrites(tokens.slice(wrapped.index), context, depth + 1);
    result.external.push(...nested.external);
    result.ambiguous.push(...nested.ambiguous);
    return result;
  }
  if (name === 'eval') {
    const nestedCommand = tokens.slice(1).join(' ');
    const nested = parseShell(nestedCommand);
    for (const redirect of nested.redirects) add(redirect.target);
    for (const segment of nested.segments) {
      const inspected = inspectShellWrites(segment, context, depth + 1);
      result.external.push(...inspected.external);
      result.ambiguous.push(...inspected.ambiguous);
    }
    return result;
  }
  inspectGitWrites(tokens, context, add);
  if (SHELLS.has(name) || SCRIPT_RUNNERS.has(name)) {
    const inlineFlag = SHELLS.has(name) ? -1 : runnerInlineFlag(name, tokens);
    const inline = SHELLS.has(name)
      ? shellInlineCommand(tokens)
      : inlineFlag >= 0
        ? tokens[inlineFlag + 1]
        : undefined;
    if (inline) {
      if (!SHELLS.has(name)) {
        result.ambiguous.push({ state: 'ambiguous', raw: `${name} inline code` });
        return result;
      }
      const nested = parseShell(inline);
      let nestedContext = { ...context };
      for (let index = 0; index < nested.segments.length; index += 1) {
        const segment = nested.segments[index];
        for (const redirect of nested.redirects.filter((item) => item.segmentIndex === index)) {
          const selected = shellPathState(redirect.target, nestedContext);
          if (selected.state === 'outside') result.external.push(selected);
          else if (selected.state === 'ambiguous') result.ambiguous.push(selected);
        }
        const inspected = inspectShellWrites(segment, nestedContext, depth + 1);
        result.external.push(...inspected.external);
        result.ambiguous.push(...inspected.ambiguous);
        const nextSeparator = nested.separators[index + 1] ?? '';
        if (['', ';', '&&', '\n'].includes(nextSeparator)) {
          updateShellCwd(segment, nestedContext);
        }
      }
      return result;
    }
    const script = runnerScript(tokens);
    if (script) {
      const selected = shellPathState(script, context);
      if (selected.state === 'outside') result.external.push(selected);
      else result.ambiguous.push({
        state: 'ambiguous',
        raw: `${name} ${script}`,
      });
    } else if (!tokens.some((token) => [
      '-h', '--help', '-v', '--version', '-V',
    ].includes(token))) {
      result.ambiguous.push({
        state: 'ambiguous',
        raw: `${name} stdin or interactive execution`,
      });
    }
  }
  for (const target of shellDestinationCandidates(tokens)) add(target);
  return result;
}

function inspectShellCommand(command, context = {}) {
  const parsed = parseShell(command);
  const external = [];
  const ambiguous = [];
  const shellContext = {
    ...context,
    boundaryCwd: path.resolve(context.cwd || process.cwd()),
  };
  const usedRedirects = new Set();
  for (let index = 0; index < parsed.segments.length; index += 1) {
    const segment = parsed.segments[index];
    for (const redirect of parsed.redirects) {
      if (redirect.segmentIndex !== index) continue;
      usedRedirects.add(redirect);
      const selected = shellPathState(redirect.target, shellContext);
      if (selected.state === 'outside') external.push(selected);
      else if (selected.state === 'ambiguous') ambiguous.push(selected);
    }
    const inspected = inspectShellWrites(segment, shellContext);
    external.push(...inspected.external);
    ambiguous.push(...inspected.ambiguous);
    const nextSeparator = parsed.separators[index + 1] ?? '';
    if (['', ';', '&&', '\n'].includes(nextSeparator)) {
      updateShellCwd(segment, shellContext);
    }
  }
  for (const redirect of parsed.redirects) {
    if (usedRedirects.has(redirect)) continue;
    const selected = shellPathState(redirect.target, context);
    if (selected.state === 'outside') external.push(selected);
    else if (selected.state === 'ambiguous') ambiguous.push(selected);
  }
  return { external, ambiguous };
}

function shellInlineCommand(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--command') return tokens[index + 1];
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token)) return tokens[index + 1];
  }
  return undefined;
}

function wrapperCommandIndex(name, tokens) {
  let index = 1;
  if (name === 'env') {
    while (index < tokens.length) {
      const token = tokens[index];
      if (['-u', '--unset', '-C', '--chdir'].includes(token)) {
        index += 2;
        continue;
      }
      if (token === '-S' || token === '--split-string') {
        return { index: index + 1, splitString: true };
      }
      if (token.startsWith('--unset=') || token.startsWith('--chdir=')) {
        index += 1;
        continue;
      }
      if (token.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index += 1;
        continue;
      }
      break;
    }
    return { index, splitString: false };
  }
  if (name === 'timeout') {
    while (index < tokens.length) {
      const token = tokens[index];
      if (token === '--') {
        index += 1;
        break;
      }
      if (token.startsWith('-')) {
        index += 1;
        continue;
      }
      index += 1;
      break;
    }
    return { index, splitString: false };
  }
  const valueOptions = {
    nice: new Set(['-n', '--adjustment']),
    ionice: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']),
    stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  };
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (valueOptions[name]?.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }
  while (index < tokens.length && tokens[index].startsWith('-')) index += 1;
  return { index, splitString: false };
}

function dangerousShellCommand(command, depth = 0) {
  if (depth > 4) return true;
  const parsed = parseShell(command);
  for (const original of parsed.segments) {
    let tokens = original;
    for (let unwrapDepth = 0; unwrapDepth < 5; unwrapDepth += 1) {
      while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
        tokens = tokens.slice(1);
      }
      const name = shellCommandName(tokens);
      if (!name) break;
      if (DANGEROUS_SHELL_COMMANDS.has(name)) return true;
      if (name === 'eval') {
        if (dangerousShellCommand(tokens.slice(1).join(' '), depth + 1)) return true;
        break;
      }
      if (SHELLS.has(name)) {
        const inline = shellInlineCommand(tokens);
        if (inline && dangerousShellCommand(inline, depth + 1)) return true;
        break;
      }
      if (name === 'find') {
        const marker = tokens.findIndex((token) => token === '-exec' || token === '-execdir');
        if (marker >= 0 && dangerousShellCommand(tokens.slice(marker + 1).join(' '), depth + 1)) {
          return true;
        }
        break;
      }
      if (!SHELL_WRAPPERS.has(name)) break;
      const wrapped = wrapperCommandIndex(name, tokens);
      if (wrapped.splitString && tokens[wrapped.index]) {
        if (dangerousShellCommand(tokens[wrapped.index], depth + 1)) return true;
      }
      tokens = tokens.slice(wrapped.index);
    }
  }
  const substitutions = command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g);
  for (const match of substitutions) {
    if (dangerousShellCommand(match[1] || match[2] || '', depth + 1)) return true;
  }
  return false;
}

function bashExternalWriteProtection(call, context = {}) {
  if (call?.name !== 'bash') return undefined;
  const command = normalizeCommand(call.arguments?.command);
  if (!command || command.length > 100_000) return undefined;
  const inspection = inspectShellCommand(command, context);
  if (inspection.external.length === 0) return undefined;
  const targets = [...new Set(inspection.external.map((item) => item.absolute || item.raw))];
  return {
    title: '受保护的 Bash 工作区边界',
    detail: `命令包含可识别的、指向工作区之外的写入：${targets.slice(0, 4).join(', ')}。这是静态检查，不是 OS 沙箱。`,
  };
}

function bashStaticBoundary(call, context = {}) {
  if (call?.name !== 'bash') return undefined;
  const command = normalizeCommand(call.arguments?.command);
  if (!command || command.length > 100_000) return undefined;
  const inspection = inspectShellCommand(command, context);
  if (inspection.external.length > 0 || inspection.ambiguous.length === 0) return undefined;
  return {
    decision: 'ask',
    scope: 'workspace',
    source: 'bash-static-boundary',
    pattern: call.name,
    message: `命令包含无法静态确认写入边界的操作：${inspection.ambiguous[0].raw}。这是静态检查，不是 OS 沙箱。`,
  };
}

function hardProtection(call, context = {}) {
  const name = safeString(call?.name, 160);
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  const command = normalizeCommand(args.command);
  if (name === 'bash') {
    const text = command.toLowerCase();
    const dangerous =
      dangerousShellCommand(command)
      || /\bdiskutil\s+erase\b/.test(text)
      || /\bdd\b[^\n]*\bof\s*=\s*\/dev\//.test(text)
      || /\brm\s+(?:-[^\s]+\s+)*(?:\/(?:\s|$)|\.\.(?:\/|\s|$)|~(?:\s|$)|\$home(?:\s|$))/.test(text)
      || /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command);
    if (dangerous) {
      return {
        title: '受保护的系统命令',
        detail: '该命令可能影响工作区之外的文件或系统服务，已由 Studio 安全边界拦截。',
      };
    }
    const shellWrite = bashExternalWriteProtection(call, context);
    if (shellWrite) return shellWrite;
  }
  if (['write', 'edit'].includes(name) && typeof args.path === 'string' && args.path.trim()) {
    const cwd = path.resolve(context.cwd || process.cwd());
    const home = path.resolve(context.homeDir || os.homedir());
    let requested = args.path.trim();
    if (requested.startsWith('~')) {
      requested = path.join(home, requested.slice(1));
    }
    const absolute = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(cwd, requested);
    if (
      absolute !== cwd
      && !absolute.startsWith(`${cwd}${path.sep}`)
    ) {
      return {
        title: '受保护的工作区边界',
        detail: '该文件操作超出了当前工作区，已由 Studio 安全边界拦截。',
      };
    }
  }
  return undefined;
}

function matchingPath(call, context = {}) {
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  if (!PATH_TOOLS.has(call?.name) || typeof args.path !== 'string' || !args.path.trim()) return undefined;
  const cwd = path.resolve(context.cwd || process.cwd());
  let requested = args.path.trim();
  if (requested.startsWith('~')) {
    requested = path.join(context.homeDir || os.homedir(), requested.slice(1));
  }
  const absolute = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(cwd, requested);
  const relative = absolute === cwd
    ? '.'
    : absolute.startsWith(`${cwd}${path.sep}`)
      ? path.relative(cwd, absolute)
      : '';
  return { absolute, relative: relative.replaceAll('\\', '/') };
}

function workspaceBoundary(call, context = {}) {
  if (!PATH_TOOLS.has(call?.name)) return undefined;
  const selected = matchingPath(call, context);
  if (!selected || selected.absolute === path.resolve(context.cwd || process.cwd())) return undefined;
  if (selected.relative) return undefined;
  return {
    decision: 'ask',
    scope: 'workspace',
    source: 'boundary',
    pattern: call.name,
    message: '该读取操作位于当前工作区之外，需要明确批准。',
  };
}

function globMatches(pattern, value) {
  if (!pattern || !value) return false;
  const normalized = value.replaceAll('\\', '/');
  const source = pattern.replaceAll('\\', '/');
  let expression = '^';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '*') {
      if (source[index + 1] === '*') {
        if (source[index + 2] === '/') {
          expression += '(?:.*/)?';
          index += 2;
        } else {
          expression += '.*';
          index += 1;
        }
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(character)) {
      expression += `\\${character}`;
    } else {
      expression += character;
    }
  }
  return new RegExp(`${expression}$`).test(normalized);
}

function ruleMatches(rule, call, context) {
  if (!toolMatches(rule.match?.tool, call?.name)) return false;
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  if (rule.match.commandPrefix) {
    const command = normalizeCommand(args.command);
    const prefix = normalizeCommand(rule.match.commandPrefix);
    if (!command || !prefix || command !== prefix && !command.startsWith(`${prefix} `)) return false;
  }
  if (rule.match.commandExact) {
    if (normalizeCommand(args.command) !== normalizeCommand(rule.match.commandExact)) return false;
  }
  const selectedPath = matchingPath(call, context);
  if (rule.match.pathExact) {
    if (!selectedPath) return false;
    const expected = rule.match.pathExact.replaceAll('\\', '/');
    if (selectedPath.relative !== expected && selectedPath.absolute.replaceAll('\\', '/') !== expected) return false;
  }
  if (rule.match.pathGlob) {
    if (!selectedPath) return false;
    if (
      !globMatches(rule.match.pathGlob, selectedPath.relative)
      && !globMatches(rule.match.pathGlob, selectedPath.absolute)
    ) return false;
  }
  if (rule.match.pathWithin === 'workspace' && (!selectedPath || !selectedPath.relative)) return false;
  return true;
}

function riskFor(call) {
  const name = safeString(call?.name, 160);
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  if (name === 'bash') {
    return {
      level: 'high',
      title: '执行本机命令',
      detail: normalizeCommand(args.command).slice(0, 500),
    };
  }
  if (name === 'write' || name === 'edit') {
    return {
      level: 'medium',
      title: '修改工作区文件',
      detail: safeString(args.path, 500),
    };
  }
  if (name.startsWith('mcp__')) {
    return {
      level: 'medium',
      title: '调用外部工具',
      detail: name,
    };
  }
  return {
    level: SAFE_TOOLS.has(name) ? 'low' : 'medium',
    title: SAFE_TOOLS.has(name) ? '读取工具' : '工具调用',
    detail: name,
  };
}

function explicitDecisions(layers, call, context) {
  const found = [];
  for (const layer of layers) {
    const policy = normalizePolicy(layer.policy);
    for (const [pattern, decision] of Object.entries(policy.tools)) {
      if (!toolMatches(pattern, call?.name)) continue;
      found.push({
        decision,
        scope: layer.scope || 'user',
        source: 'tool',
        pattern,
      });
    }
    for (const rule of policy.rules) {
      if (!ruleMatches(rule, call, context)) continue;
      found.push({
        decision: rule.decision,
        scope: layer.scope || 'user',
        source: 'rule',
        ruleId: rule.id,
        label: rule.label,
        pattern: rule.match.tool,
      });
    }
  }
  return found;
}

function explainDecision(result) {
  if (result.hardProtection) return result.hardProtection.detail;
  if (result.matched?.source === 'boundary') return result.matched.message;
  if (result.matched?.source === 'bash-static-boundary') return result.matched.message;
  if (result.matched?.source === 'rule') {
    return `${result.decision === 'allow' ? '规则允许' : result.decision === 'deny' ? '规则拒绝' : '规则要求确认'}：${result.matched.label || result.matched.ruleId}`;
  }
  if (result.matched?.source === 'tool') {
    return `工具规则：${result.matched.pattern}`;
  }
  return result.decision === 'ask' ? '当前模式要求确认' : result.decision === 'allow' ? '当前模式允许执行' : '当前模式拒绝执行';
}

function evaluatePermission(policies, call, context = {}) {
  const layers = (Array.isArray(policies) ? policies : [policies])
    .filter(Boolean)
    .map((entry) => (entry.policy ? entry : { scope: 'user', policy: entry }));
  const protectedResult = hardProtection(call, context);
  const decisions = explicitDecisions(layers, call, context);
  const byDecision = (decision) => decisions.find((item) => item.decision === decision);
  const deny = byDecision('deny');
  const ask = byDecision('ask');
  const allow = byDecision('allow');
  const boundary = workspaceBoundary(call, context);
  const shellBoundary = bashStaticBoundary(call, context);
  const effective = [...layers].reverse().find((layer) => (
    normalizePolicy(layer.policy).default
  ));
  const policy = normalizePolicy(effective?.policy);
  let matched;
  let decision;
  if (protectedResult) {
    decision = 'deny';
  } else if (deny) {
    decision = 'deny';
    matched = deny;
  } else if (ask) {
    decision = 'ask';
    matched = ask;
  } else if (allow) {
    decision = 'allow';
    matched = allow;
  } else if (boundary || shellBoundary) {
    const selectedBoundary = boundary || shellBoundary;
    decision = selectedBoundary.decision;
    matched = selectedBoundary;
  } else {
    const safePreset = policy.preset === 'smart' || policy.preset === 'full';
    decision = safePreset && SAFE_TOOLS.has(call?.name) ? 'allow' : policy.default;
    matched = {
      decision,
      scope: effective?.scope || 'user',
      source: safePreset && SAFE_TOOLS.has(call?.name) ? 'tool' : 'preset',
      pattern: policy.preset,
    };
  }
  const result = {
    decision,
    matched,
    matches: decisions,
    risk: riskFor(call),
    context: {
      tool: safeString(call?.name, 160),
      command: normalizeCommand(call?.arguments?.command).slice(0, 2_000),
      path: matchingPath(call, context)?.relative,
    },
    hardProtection: protectedResult,
    shellBoundary,
  };
  return { ...result, explanation: explainDecision(result) };
}

function approvalScopesFor(call, context = {}) {
  if (!call) return ['once'];
  if (call.name === 'bash') {
    return normalizeCommand(call.arguments?.command).length <= MAX_PATTERN_LENGTH
      ? ['once', 'session']
      : ['once'];
  }
  if (PATH_TOOLS.has(call.name)) {
    const selected = call.arguments?.path;
    if (!selected || String(selected).length > MAX_PATTERN_LENGTH) return ['once'];
    const resolved = matchingPath(call, context);
    if (!resolved?.relative) return ['once', 'session'];
    return ['once', 'session', 'workspace', 'always'];
  }
  return ['once', 'session'];
}

function narrowApprovalRule(call, context = {}, label = '') {
  const name = safeString(call?.name, 160);
  if (!normalizeToolPattern(name)) throw new Error('无法为未知工具创建批准规则');
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  const match = { tool: name };
  if (name === 'bash' && normalizeCommand(args.command)) {
    const command = normalizeCommand(args.command);
    if (command.length > MAX_PATTERN_LENGTH) throw new Error('命令过长，无法创建安全的一键批准规则');
    match.commandExact = command;
  } else if (PATH_TOOLS.has(name)) {
    const selected = matchingPath(call, context);
    const exactPath = selected?.relative || selected?.absolute.replaceAll('\\', '/') || '';
    if (exactPath && exactPath.length <= MAX_PATTERN_LENGTH) {
      match.pathExact = exactPath;
    } else {
      throw new Error('路径无效或过长，无法创建安全的一键批准规则');
    }
  }
  return {
    id: `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label: safeString(label, MAX_RULE_LABEL),
    decision: 'allow',
    match,
  };
}

module.exports = {
  MAX_PATTERN_LENGTH,
  PERMISSION_DECISIONS,
  PERMISSION_MODES,
  PRESET_DEFAULTS,
  approvalScopesFor,
  defaultPolicy,
  evaluatePermission,
  globMatches,
  hardProtection,
  inspectShellCommand,
  matchingPath,
  narrowApprovalRule,
  normalizePolicy,
  normalizePolicyStore,
  normalizeToolPattern,
  presetDefault,
  ruleMatches,
  toolMatches,
  workspaceBoundary,
  wildcardToMatcher,
};

/**
 * Studio's MCP integration for Pi Durable.
 *
 * Each enabled server is one native Durable extension. Server definitions live
 * in Studio SQLite; connection state and tool catalogs are ephemeral. Refreshing
 * a server reconnects only that server and replaces its registry entry, so the
 * next model request sees the change without interrupting unrelated clients or
 * an in-flight tool call.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { normalizeSecureHttpUrl } = require('../core/external-url.cjs');

const RUNTIME_PREFIX = 'studio-mcp:';
const CATALOG_RUNTIME = 'studio-mcp-catalog';
const CATALOG_SECTION = 'mcp_servers';
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_SERVER_SUMMARY_LENGTH = 250;
const MAX_SERVERS_SECTION_LENGTH = 4_096;
const MAX_MCP_OUTPUT_BYTES = 20 * 1024;
const MAX_MCP_DIAGNOSTIC_BYTES = 8 * 1024;
const MCP_CLOSE_TIMEOUT_MS = 2_000;
const MCP_STDIO_CLOSE_TIMEOUT_MS = 750;
const MCP_RECONNECT_DELAY_MS = 1_000;
const EXPOSURES = new Set(['direct', 'deferred', 'hidden']);
const INHERITED_ENV_KEYS = new Set([
  'APPDATA',
  'COMSPEC',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMPUTERNAME',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'LOGNAME',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PUBLIC',
  'SHELL',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'WINDIR',
]);

let state;
let reloadChain = Promise.resolve();
const pendingDisposals = new Set();

function runtimeName(serverName) {
  return `${RUNTIME_PREFIX}${serverName}`;
}

function safeServerPart(value) {
  return String(value || '').replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Match Pi's provider-facing MCP names: sanitize to letters, digits and `_`;
 * use a deterministic hash suffix when the name is too long or collides.
 */
function toolName(serverName, name, isTaken = () => false) {
  const candidate = `mcp__${safeServerPart(serverName)}__${safeServerPart(name)}`;
  if (candidate.length <= MAX_TOOL_NAME_LENGTH && !isTaken(candidate)) return candidate;
  const hash = crypto
    .createHash('sha256')
    .update(`${serverName}\0${name}`)
    .digest('hex')
    .slice(0, 8);
  return `${candidate.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toolPatternMatches(pattern, name) {
  if (!pattern.includes('*')) return pattern === name;
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(name);
}

function toolExposureFor(server, name) {
  const overrides = server.toolExposure && typeof server.toolExposure === 'object'
    ? server.toolExposure
    : {};
  if (EXPOSURES.has(overrides[name])) return overrides[name];
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes('*') && toolPatternMatches(pattern, name) && EXPOSURES.has(exposure)) {
      return exposure;
    }
  }
  return EXPOSURES.has(server.exposure) ? server.exposure : 'deferred';
}

function sortedMap(value) {
  return Object.fromEntries(
    Object.entries(value || {})
      .filter(([, entry]) => typeof entry === 'string')
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function connectionSignature(server) {
  return JSON.stringify({
    transport: server.transport,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    url: server.url,
    env: sortedMap(server.env),
    headers: sortedMap(server.headers),
    timeoutSeconds: server.timeoutSeconds,
  });
}

function withTimeout(promise, message, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function positiveTimeout(value, fallback) {
  return Number.isFinite(value) ? Math.max(20, Math.min(30_000, value)) : fallback;
}

async function closeClientResources(client, transport, options = {}) {
  const timeoutMs = positiveTimeout(options.closeTimeoutMs, MCP_CLOSE_TIMEOUT_MS);
  const operations = [];
  if (client && typeof client.close === 'function') {
    operations.push(withTimeout(
      Promise.resolve().then(() => client.close()),
      'MCP 客户端关闭超时',
      timeoutMs,
    ));
  }
  if (transport && typeof transport.close === 'function') {
    operations.push(withTimeout(
      Promise.resolve().then(() => transport.close()),
      'MCP 传输关闭超时',
      timeoutMs,
    ));
  }
  await Promise.allSettled(operations);
}

function expandHome(value) {
  const text = String(value || '');
  if (text === '~') return os.homedir();
  if (text.startsWith(`~${path.sep}`)) return path.join(os.homedir(), text.slice(2));
  return text;
}

function expandEnvironmentValue(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`MCP 引用的环境变量 ${name} 未设置`);
    return resolved;
  });
}

function expandEnvironmentMap(value, label) {
  const source = sortedMap(value);
  const expanded = {};
  for (const [key, entry] of Object.entries(source)) {
    try {
      expanded[key] = expandEnvironmentValue(entry);
    } catch (error) {
      throw new Error(`${label} ${key}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return expanded;
}

/**
 * MCP child processes receive only runtime variables needed to locate tools and
 * write temporary files. Application secrets from Studio or the user's shell
 * must be referenced explicitly through `${ENV_VAR}` in the server config.
 */
function mcpClientEnvironment(configured = {}) {
  const inherited = {};
  for (const [key, entry] of Object.entries(process.env)) {
    if (typeof entry === 'string' && INHERITED_ENV_KEYS.has(key.toUpperCase())) {
      inherited[key] = entry;
    }
  }
  return {
    ...inherited,
    ...sortedMap(configured),
  };
}

function redactDiagnostic(value, secrets) {
  let text = String(value || '');
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.replaceAll(secret, '[redacted]');
  }
  return text;
}

function diagnosticTail(transport, server, secrets = []) {
  const text = typeof transport?.stderr === 'string' ? transport.stderr.trim() : '';
  if (!text) return '';
  return redactDiagnostic(utf8Suffix(text, MAX_MCP_DIAGNOSTIC_BYTES), secrets);
}

function failureWithDiagnostics(error, transport, server, secrets) {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics = diagnosticTail(transport, server, secrets);
  return new Error(diagnostics ? `${message}\n\nstderr:\n${diagnostics}` : message);
}

async function createClient(server, Mcp) {
  const timeoutMs = Math.max(1, Number(server.timeoutSeconds) || 60) * 1_000;
  const configuredEnv = expandEnvironmentMap(server.env, '环境变量');
  const env = mcpClientEnvironment(configuredEnv);
  const headers = expandEnvironmentMap(server.headers, 'Header');
  const secrets = [...Object.values(configuredEnv), ...Object.values(headers)];
  // MCP connections are application-scoped. A packaged Electron process's cwd
  // can be the app bundle, so the stable fallback is Studio's data directory.
  const cwd = expandHome(server.cwd || '') || path.dirname(getStudioDatabase().filename);
  const client = new Mcp.McpClient({
    name: 'Pi Studio',
    version: '1.0.0',
    requestTimeoutMs: timeoutMs,
    roots: [{ uri: pathToFileURL(cwd).href, name: path.basename(cwd) || cwd }],
  });
  const transport = server.transport === 'http'
    ? new Mcp.StreamableHttpTransport({
        url: server.url,
        headers,
      })
    : new Mcp.StdioTransport({
        command: expandHome(server.command),
        args: server.args.map(expandHome),
        cwd,
        env,
        inheritEnv: false,
        stderr: 'pipe',
        closeTimeoutMs: MCP_STDIO_CLOSE_TIMEOUT_MS,
      });
  try {
    await withTimeout(
      client.connect(transport),
      `MCP「${server.name}」连接超时`,
      timeoutMs,
    );
  } catch (error) {
    // A timed-out connect can still finish later. Close the client now so a
    // slow child process cannot remain attached to the Electron main process.
    await closeClientResources(client, transport);
    throw failureWithDiagnostics(error, transport, server, secrets);
  }
  return {
    client,
    transport,
    diagnostics: () => diagnosticTail(transport, server, secrets),
  };
}

async function saveFullMcpOutput(text) {
  const file = path.join(os.tmpdir(), `pi-studio-mcp-${crypto.randomUUID()}.txt`);
  await fsp.writeFile(file, text, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return file;
}

function utf8Prefix(text, maxBytes) {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function utf8Suffix(text, maxBytes) {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

async function boundedMcpOutput(content) {
  const text = content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_MCP_OUTPUT_BYTES) return { content };
  let fullPath = '';
  try {
    fullPath = await saveFullMcpOutput(text);
  } catch {
    // The bounded result is still useful if the temporary file cannot be saved.
  }
  // Reserve room for the marker, including a long temporary path. Splitting by
  // UTF-8 byte boundaries avoids inflating CJK output past the provider budget.
  const contentBudget = Math.max(0, MAX_MCP_OUTPUT_BYTES - 256);
  const head = utf8Prefix(text, Math.floor(contentBudget / 2));
  const tail = utf8Suffix(
    text,
    Math.max(0, contentBudget - Buffer.byteLength(head)),
  );
  const omitted = Math.max(0, bytes - Buffer.byteLength(head) - Buffer.byteLength(tail));
  const marker = `\n\n…${omitted} bytes truncated${fullPath ? `; full output: ${fullPath}` : ''}…\n\n`;
  return {
    content: [
      { type: 'text', text: `${head}${marker}${tail}` },
      ...content.filter((block) => block?.type === 'image'),
    ],
    ...(fullPath ? { fullOutputPath: fullPath } : {}),
  };
}

function mcpToolRegistration(entry, rawTool, registeredName, exposure, durable, piAi, Mcp) {
  const { server } = entry;
  return durable.defineTool({
    name: registeredName,
    label: `${server.name}/${rawTool.name}`,
    description: rawTool.description?.trim()
      || rawTool.title
      || `MCP tool ${rawTool.name} from server ${server.name}`,
    parameters: piAi.Type.Unsafe({
      ...(rawTool.inputSchema || {}),
      type: rawTool.inputSchema?.type || 'object',
      properties: rawTool.inputSchema?.properties || {},
    }),
    ...(exposure === 'deferred' ? { deferred: true } : {}),
    ...(exposure === 'hidden' ? { callers: ['tools'] } : {}),
    async execute(args, api, context) {
      entry.activeCalls += 1;
      try {
        const result = await entry.client.callTool(rawTool.name, args || {}, {
          signal: context.abortSignal,
          timeoutMs: Math.max(1, Number(server.timeoutSeconds) || 60) * 1_000,
          onProgress: (progress) => {
            const total = progress.total === undefined ? '' : `/${progress.total}`;
            const message = progress.message || `Progress ${progress.progress}${total}`;
            if (typeof api.output === 'function') api.output(`${message}\n`);
          },
        });
        const bounded = await boundedMcpOutput(Mcp.toLlmContent(result));
        return {
          output: bounded.content,
          details: {
            server: server.name,
            tool: rawTool.name,
            exposure,
            isError: result.isError === true,
            ...(bounded.fullOutputPath ? { fullOutputPath: bounded.fullOutputPath } : {}),
            ...(result.structuredContent === undefined
              ? {}
              : { structuredContent: result.structuredContent }),
          },
          ...(result.isError === true ? { isError: true } : {}),
        };
      } finally {
        entry.activeCalls -= 1;
        if (entry.retired && entry.activeCalls === 0) {
          entry.retiredSet?.delete(entry);
          entry.retiredSet = undefined;
          await closeEntry(entry);
        }
      }
    },
  });
}

function serverSummary(entry) {
  const text = entry.server.description?.trim() || entry.instructions?.trim() || '';
  const firstLine = text.split('\n', 1)[0].trim();
  return firstLine.length <= MAX_SERVER_SUMMARY_LENGTH
    ? firstLine
    : `${firstLine.slice(0, MAX_SERVER_SUMMARY_LENGTH - 1).trimEnd()}…`;
}

function renderMcpServersSection(entries, deferredNames) {
  const list = [...entries.values()]
    .filter((entry) => entry.registeredTools.some((tool) => (
      tool.exposure === 'deferred' && (!deferredNames || deferredNames.has(tool.name))
    )))
    .sort((left, right) => left.server.name.localeCompare(right.server.name));
  if (list.length === 0) return undefined;
  const intro = [
    'MCP servers whose tools are not declared to you.',
    'Use `tool_search` to discover and load their tools; loaded tools become callable on the next model request.',
  ].join(' ');
  const lines = list.map((entry) => {
    const namespace = `mcp__${safeServerPart(entry.server.name)}`;
    const summary = serverSummary(entry);
    return `- ${namespace} (deferred)${summary ? `: ${summary}` : ''}`;
  });
  let kept = lines.length;
  const build = () => [intro, ...lines.slice(0, kept), ...(kept < lines.length
    ? [`- … ${lines.length - kept} more server${lines.length - kept === 1 ? '' : 's'}`]
    : [])].join('\n');
  while (kept > 0 && build().length > MAX_SERVERS_SECTION_LENGTH) kept -= 1;
  return build();
}

function catalogExtension(durable, entries) {
  return durable.defineExtension({
    name: CATALOG_RUNTIME,
    sections: [
      durable.section(CATALOG_SECTION, (input) => renderMcpServersSection(
        entries,
        new Set((input.agent?.deferred || []).map((tool) => tool.name)),
      )),
    ],
  });
}

function rebuildRegistry(current, durable, piAi, Mcp) {
  const priorExtensions = current.extensions;
  const extensions = new Map();
  const catalogTools = [];
  const usedNames = new Set();

  for (const entry of [...current.entries.values()].sort((left, right) => (
    left.server.name.localeCompare(right.server.name)
  ))) {
    const registrations = [];
    entry.registeredTools = [];
    for (const tool of [...entry.tools].sort((left, right) => left.name.localeCompare(right.name))) {
      const exposure = toolExposureFor(entry.server, tool.name);
      const registeredName = toolName(entry.server.name, tool.name, (candidate) => usedNames.has(candidate));
      usedNames.add(registeredName);
      registrations.push(mcpToolRegistration(
        entry,
        tool,
        registeredName,
        exposure,
        durable,
        piAi,
        Mcp,
      ));
      catalogTools.push({
        name: registeredName,
        originalName: tool.name,
        description: tool.description || tool.title || tool.name,
        server: entry.server.name,
        exposure,
      });
      entry.registeredTools.push({ name: registeredName, originalName: tool.name, exposure });
    }
    const extension = durable.defineExtension({
      name: runtimeName(entry.server.name),
      tools: registrations,
    });
    current.runtime.registry.install(extension);
    extensions.set(entry.server.name, extension);
  }

  const catalog = catalogExtension(durable, current.entries);
  if (renderMcpServersSection(current.entries)) {
    current.runtime.registry.install(catalog);
    current.catalogExtension = catalog;
  } else {
    if (current.catalogExtension) {
      try { current.runtime.registry.uninstall(current.catalogExtension); } catch { /* already gone */ }
    }
    current.catalogExtension = undefined;
  }

  for (const [serverName, extension] of priorExtensions) {
    if (!extensions.has(serverName)) {
      try { current.runtime.registry.uninstall(extension); } catch { /* already replaced */ }
    }
  }
  current.extensions = extensions;
  current.tools = catalogTools.sort((left, right) => left.name.localeCompare(right.name));
}

function setServerError(current, serverName, message) {
  const remaining = current.errors.filter((item) => item.server !== serverName);
  if (message) remaining.push({ server: serverName, message });
  current.errors = remaining.sort((left, right) => left.server.localeCompare(right.server));
}

function closeEntry(entry) {
  if (!entry) return Promise.resolve();
  if (entry.closePromise) return entry.closePromise;
  entry.closing = true;
  entry.closed = true;
  clearTimeout(entry.refreshTimer);
  clearTimeout(entry.reconnectTimer);
  entry.refreshTimer = undefined;
  entry.reconnectTimer = undefined;
  entry.closePromise = closeClientResources(entry.client, entry.transport)
    .catch(() => {})
    .finally(() => {
      entry.closed = true;
    });
  return entry.closePromise;
}

async function retireEntry(current, entry) {
  if (entry.retired) return;
  entry.retired = true;
  entry.closing = true;
  clearTimeout(entry.refreshTimer);
  clearTimeout(entry.reconnectTimer);
  if (entry.activeCalls === 0) {
    await closeEntry(entry);
  } else {
    entry.retiredSet = current.retiredEntries;
    current.retiredEntries.add(entry);
  }
}

async function updateServerTools(runtime, serverName, client, listed) {
  const current = state;
  const entry = current?.runtime === runtime ? current.entries.get(serverName) : undefined;
  if (!entry || entry.client !== client || entry.closing) return;
  entry.tools = Array.isArray(listed) ? listed : [];
  entry.instructions = client.instructions?.trim() || entry.instructions;
  const modules = await Promise.all([
    import('@earendil-works/pi-durable'),
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-mcp'),
  ]);
  if (
    state !== current
    || current.closing
    || current.entries.get(serverName) !== entry
    || entry.client !== client
    || entry.closing
  ) {
    return;
  }
  rebuildRegistry(current, modules[0], modules[1], modules[2]);
  setServerError(current, serverName, '');
  current.refreshedAt = Date.now();
}

function isCurrentState(current) {
  return state === current && !current.closing;
}

function scheduleReconnect(current, runtime, serverName) {
  if (!isCurrentState(current)) return;
  const previous = current.reconnectTimers.get(serverName);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    current.reconnectTimers.delete(serverName);
    if (!isCurrentState(current)) return;
    void reloadMcpServers(runtime).catch(() => {});
  }, MCP_RECONNECT_DELAY_MS);
  timer.unref?.();
  current.reconnectTimers.set(serverName, timer);
  const entry = current.entries.get(serverName);
  if (entry) entry.reconnectTimer = timer;
}

function clearReconnect(current, serverName) {
  const timer = current.reconnectTimers.get(serverName);
  if (timer) clearTimeout(timer);
  current.reconnectTimers.delete(serverName);
  const entry = current.entries.get(serverName);
  if (entry) entry.reconnectTimer = undefined;
}

function watchClient(current, runtime, serverName, client, Mcp) {
  client.onNotification('notifications/tools/list_changed', () => {
    const entry = current.entries.get(serverName);
    if (!entry || entry.client !== client || entry.closing) return;
    clearTimeout(entry.refreshTimer);
    entry.refreshTimer = setTimeout(() => {
      const active = state;
      if (!active || active !== current || entry.client !== client || entry.closing) return;
      const timeoutMs = Math.max(1, Number(entry.server.timeoutSeconds) || 60) * 1_000;
      void client.listTools({ timeoutMs })
        .then((listed) => updateServerTools(runtime, serverName, client, listed))
        .catch((error) => {
          if (!isCurrentState(current) || !entryIsCurrent(current, serverName, client)) return;
          setServerError(current, serverName, error instanceof Error ? error.message : String(error));
        });
    }, 100);
    entry.refreshTimer.unref?.();
  });
  client.onError((error) => {
    if (!entryIsCurrent(current, serverName, client)) return;
    setServerError(current, serverName, error.message);
  });
  client.onClose(() => {
    if (!entryIsCurrent(current, serverName, client) || current.closing) return;
    const entry = current.entries.get(serverName);
    if (!entry) return;
    entry.closed = true;
    current.entries.delete(serverName);
    current.closingEntries.add(entry);
    void closeEntry(entry).finally(() => current.closingEntries.delete(entry));
    setServerError(current, serverName, '连接已断开，正在重连');
    const modulesPromise = Promise.all([
      import('@earendil-works/pi-durable'),
      import('@earendil-works/pi-ai'),
      import('@earendil-works/pi-mcp'),
    ]);
    void modulesPromise.then(([durable, piAi, McpModule]) => {
      if (!isCurrentState(current)) return;
      rebuildRegistry(current, durable, piAi, McpModule);
      if (!current.entries.has(serverName)) {
        scheduleReconnect(current, runtime, serverName);
      }
    }).catch(() => {});
  });
}

function entryIsCurrent(current, serverName, client) {
  return current?.entries.get(serverName)?.client === client;
}

async function connectServer(current, server, Mcp) {
  const {
    client,
    transport,
    diagnostics,
  } = await createClient(server, Mcp);
  try {
    const timeoutMs = Math.max(1, Number(server.timeoutSeconds) || 60) * 1_000;
    const tools = client.serverCapabilities?.tools
      ? await client.listTools({ timeoutMs })
      : [];
    return {
      server,
      client,
      transport,
      diagnostics,
      tools,
      instructions: client.instructions?.trim() || '',
      signature: connectionSignature(server),
      registeredTools: [],
      activeCalls: 0,
      closing: false,
      closed: false,
      closePromise: undefined,
      retired: false,
      retiredSet: undefined,
      refreshTimer: undefined,
      reconnectTimer: undefined,
    };
  } catch (error) {
    await closeClientResources(client, transport);
    throw error;
  }
}

async function performReload(runtime) {
  const [
    durable,
    piAi,
    Mcp,
  ] = await Promise.all([
    import('@earendil-works/pi-durable'),
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-mcp'),
  ]);
  if (state && state.runtime !== runtime) await disposeMcpState(state);
  if (!state) {
    state = {
      runtime,
      entries: new Map(),
      extensions: new Map(),
      catalogExtension: undefined,
      tools: [],
      errors: [],
      reconnectTimers: new Map(),
      retiredEntries: new Set(),
      closingEntries: new Set(),
      refreshedAt: 0,
      closing: false,
      closePromise: undefined,
    };
  }
  const current = state;
  current.closing = false;
  const listed = getStudioDatabase()
    .listMcpServers({ includeSecrets: true })
    .filter((server) => server.enabled);
  const invalid = new Map();
  const servers = [];
  for (const server of listed) {
    try {
      servers.push(server.transport === 'http'
        ? {
            ...server,
            url: normalizeSecureHttpUrl(server.url, {
              label: `MCP「${server.name}」地址`,
            }),
          }
        : server);
    } catch (error) {
      invalid.set(server.name, error instanceof Error ? error.message : String(error));
    }
  }
  const desired = new Map(servers.map((server) => [server.name, server]));

  for (const [serverName, entry] of [...current.entries]) {
    const next = desired.get(serverName);
    if (next && entry.signature === connectionSignature(next)) {
      // Exposure, descriptions and per-tool overrides affect the registry but
      // do not require reconnecting the MCP client.
      entry.server = next;
      clearReconnect(current, serverName);
    } else {
      current.entries.delete(serverName);
      clearReconnect(current, serverName);
      setServerError(current, serverName, '');
      await retireEntry(current, entry);
    }
  }

  const pending = servers.filter((server) => !current.entries.has(server.name));
  await Promise.all(pending.map(async (server) => {
    try {
      const entry = await connectServer(current, server, Mcp);
      if (entry.signature !== connectionSignature(server)) {
        await retireEntry(current, entry);
        return;
      }
      current.entries.set(server.name, entry);
      clearReconnect(current, server.name);
      setServerError(current, server.name, '');
      watchClient(current, runtime, server.name, entry.client, Mcp);
    } catch (error) {
      setServerError(current, server.name, error instanceof Error ? error.message : String(error));
    }
  }));

  for (const serverName of desired.keys()) {
    const error = current.errors.find((item) => item.server === serverName);
    if (!current.entries.has(serverName) && !error) {
      setServerError(current, serverName, '连接失败');
    }
  }
  for (const [serverName, message] of invalid) {
    setServerError(current, serverName, message);
  }
  rebuildRegistry(current, durable, piAi, Mcp);
  current.refreshedAt = Date.now();
  return mcpSnapshot();
}

function reloadMcpServers(runtime) {
  const task = reloadChain.then(
    () => performReload(runtime),
    () => performReload(runtime),
  );
  reloadChain = task.catch(() => {});
  return task;
}

function mcpSnapshot() {
  return {
    runtimeNames: state
      ? [
          ...state.extensions.keys()].map(runtimeName).concat(
            state.catalogExtension ? [CATALOG_RUNTIME] : [],
          )
      : [],
    catalogRuntimeName: CATALOG_RUNTIME,
    tools: state?.tools || [],
    errors: state?.errors || [],
    servers: state
      ? [...state.entries.values()]
          .map((entry) => ({
            name: entry.server.name,
            exposure: entry.server.exposure,
            connected: entry.client.connectionState === 'connected',
            toolCount: entry.tools.length,
            instructions: entry.instructions,
            stderr: entry.diagnostics?.() || '',
          }))
          .sort((left, right) => left.name.localeCompare(right.name))
      : [],
    refreshedAt: state?.refreshedAt || 0,
  };
}

function disposeMcpState(current) {
  if (!current) return Promise.resolve();
  if (current.closePromise) return current.closePromise;
  current.closing = true;
  if (state === current) state = undefined;
  pendingDisposals.add(current);
  current.closePromise = (async () => {
    for (const timer of current.reconnectTimers.values()) clearTimeout(timer);
    current.reconnectTimers.clear();
    for (const extension of current.extensions.values()) {
      try { current.runtime.registry.uninstall(extension); } catch { /* runtime may already be closed */ }
    }
    if (current.catalogExtension) {
      try { current.runtime.registry.uninstall(current.catalogExtension); } catch { /* already gone */ }
    }
    const entries = new Set([
      ...current.entries.values(),
      ...current.retiredEntries,
      ...current.closingEntries,
    ]);
    await Promise.allSettled([...entries].map((entry) => closeEntry(entry)));
    current.entries.clear();
    current.retiredEntries.clear();
    current.closingEntries.clear();
  })().finally(() => {
    pendingDisposals.delete(current);
  });
  return current.closePromise;
}

async function closeMcpRuntime() {
  await reloadChain.catch(() => {});
  while (state || pendingDisposals.size > 0) {
    const closing = new Set(pendingDisposals);
    if (state) closing.add(state);
    await Promise.allSettled([...closing].map((current) => disposeMcpState(current)));
  }
}

module.exports = {
  CATALOG_RUNTIME,
  closeMcpRuntime,
  mcpSnapshot,
  reloadMcpServers,
  runtimeName,
  toolExposureFor,
  toolName,
  __test: {
    boundedMcpOutput,
    closeClientResources,
    closeEntry,
    connectionSignature,
    currentState: () => state,
    diagnosticTail,
    disposeMcpState,
    failureWithDiagnostics,
    mcpClientEnvironment,
    mcpToolRegistration,
    retireEntry,
    scheduleReconnect,
    updateServerTools,
    utf8Prefix,
    utf8Suffix,
    watchClient,
  },
};

/**
 * Discovery and bounded lifecycle control for TCP listeners.
 *
 * The panel answers "what did this task start?" without claiming certainty it
 * cannot prove. Studio child processes and processes whose cwd is inside the
 * active workspace are labelled with their evidence; everything else remains
 * visible as a local listener rather than being presented as agent-owned.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const COMMAND_TIMEOUT_MS = 4_000;
const COMMAND_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_LISTENERS = 120;
const PROCESS_TERM_GRACE_MS = 1_200;
const PROCESS_TERM_POLL_MS = 100;

function executeFile(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(String(stdout || ''));
      },
    );
  });
}

function processIsAlive(pid, killProcess = process.kill.bind(process)) {
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Stop a listener process gracefully, then force it after a short bounded
 * grace period. Windows uses taskkill's process tree because individual Node
 * children often do not propagate termination to their helper processes.
 */
async function terminateProcess(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('终止服务的进程标识无效');
  const platform = options.platform || process.platform;
  const execute = options.execute || executeFile;
  const killProcess = options.killProcess || process.kill.bind(process);
  const isAlive = options.isAlive || ((targetPid) => processIsAlive(targetPid, killProcess));
  const wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  if (platform === 'win32') {
    await execute('taskkill', ['/PID', String(pid), '/T', '/F']);
    return { forced: true };
  }

  try {
    killProcess(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') return { forced: false };
    throw error;
  }
  for (let waited = 0; waited < PROCESS_TERM_GRACE_MS; waited += PROCESS_TERM_POLL_MS) {
    await wait(PROCESS_TERM_POLL_MS);
    if (!isAlive(pid)) return { forced: false };
  }

  try {
    killProcess(pid, 'SIGKILL');
  } catch (error) {
    if (error?.code === 'ESRCH') return { forced: true };
    throw error;
  }
  await wait(PROCESS_TERM_POLL_MS);
  if (isAlive(pid)) throw new Error(`无法终止 PID ${pid}，请检查进程权限`);
  return { forced: true };
}

function parseElapsedSeconds(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(value || '').trim());
  if (!match) return undefined;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return (((days * 24) + hours) * 60 + minutes) * 60 + seconds;
}

function redactCommand(command) {
  return String(command || '')
    .replace(
      /(--?(?:api[-_]?key|token|secret|password|passwd)(?:=|\s+))([^\s]+)/gi,
      '$1[redacted]',
    )
    .replace(
      /\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,}|github_pat_[a-z0-9_]{8,})\b/gi,
      '[redacted]',
    );
}

function parseProcessTable(raw, now = Date.now()) {
  const processes = new Map();
  for (const line of String(raw || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const elapsedSeconds = parseElapsedSeconds(match[4]);
    processes.set(pid, {
      pid,
      ppid: Number(match[2]),
      uid: Number(match[3]),
      elapsedSeconds,
      startedAt: elapsedSeconds === undefined ? undefined : now - elapsedSeconds * 1000,
      command: redactCommand(match[5]).slice(0, 2_000),
    });
  }
  return processes;
}

function parseListenAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  let host;
  let portText;
  if (raw.startsWith('[')) {
    const match = /^\[([^\]]+)]:(\d+)$/.exec(raw);
    if (!match) return undefined;
    host = match[1];
    portText = match[2];
  } else {
    const index = raw.lastIndexOf(':');
    if (index <= 0) return undefined;
    host = raw.slice(0, index);
    portText = raw.slice(index + 1);
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  if (host === '*') host = '0.0.0.0';
  const scope = host === '0.0.0.0' || host === '::' ? 'all' : 'local';
  return { address: raw, host, port, scope };
}

function dedupeListeners(records) {
  const unique = new Map();
  for (const record of records) {
    if (!Number.isInteger(record.pid) || !record.pid || !record.port) continue;
    // A process commonly binds the same port on IPv4 and IPv6. The user thinks
    // in services/ports, so one row is enough; a wildcard binding wins because
    // it is the more useful address to expose.
    const key = `${record.pid}:${record.protocol}:${record.port}`;
    const existing = unique.get(key);
    if (!existing || (existing.scope === 'local' && record.scope === 'all')) {
      unique.set(key, record);
    }
    if (unique.size >= MAX_LISTENERS) break;
  }
  return [...unique.values()];
}

function parseLsofListeners(raw) {
  const listeners = [];
  let current;
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      current = { pid: Number(value), processName: '' };
      continue;
    }
    if (field === 'c' && current) {
      current.processName = value;
      continue;
    }
    if (field !== 'n' || !current) continue;
    const parsed = parseListenAddress(value);
    if (parsed) listeners.push({ ...current, ...parsed, protocol: 'tcp' });
  }
  return dedupeListeners(listeners);
}

function parseSsListeners(raw) {
  const listeners = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || parts[0] !== 'LISTEN') continue;
    const parsed = parseListenAddress(parts[3]);
    if (!parsed) continue;
    const process = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    listeners.push({
      ...parsed,
      pid: process ? Number(process[2]) : undefined,
      processName: process?.[1] || '',
      protocol: 'tcp',
    });
  }
  return dedupeListeners(listeners);
}

function parseNetstatListeners(raw) {
  const listeners = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || String(parts[3]).toUpperCase() !== 'LISTENING') continue;
    const parsed = parseListenAddress(parts[1]);
    if (!parsed) continue;
    listeners.push({
      ...parsed,
      pid: Number(parts[parts.length - 1]),
      processName: '',
      protocol: 'tcp',
    });
  }
  return dedupeListeners(listeners);
}

function parseLsofCwdOutput(raw) {
  const directories = new Map();
  let pid;
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && Number.isInteger(pid)) directories.set(pid, line.slice(1));
  }
  return directories;
}

function descendantsOf(rootPid, processes) {
  const children = new Map();
  for (const processInfo of processes.values()) {
    const list = children.get(processInfo.ppid) || [];
    list.push(processInfo.pid);
    children.set(processInfo.ppid, list);
  }
  const descendants = new Set();
  const pending = [rootPid];
  while (pending.length) {
    const pid = pending.pop();
    for (const child of children.get(pid) || []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      pending.push(child);
    }
  }
  return descendants;
}

function normalizeRoots(cwd, roots = []) {
  return [...new Set([cwd, ...roots]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => path.resolve(value))
    .slice(0, 12))];
}

function selectRegisteredRoots(requested = [], registered = []) {
  const registry = new Set(normalizeRoots(undefined, registered));
  return normalizeRoots(undefined, requested).filter((root) => registry.has(root));
}

function pathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function classifyOwnership({ pid, processInfo, processCwd, descendantPids, roots, studioPid }) {
  const evidence = [];
  if (pid === studioPid) {
    evidence.push('Studio 主进程');
    return { kind: 'app', evidence };
  }
  if (descendantPids.has(pid)) evidence.push('Studio 子进程');
  if (processCwd && roots.some((root) => pathWithin(processCwd, root))) evidence.push('当前工作区');
  if (evidence.length > 0) {
    return {
      kind: evidence.includes('Studio 子进程') ? 'agent' : 'workspace',
      evidence,
    };
  }
  if (!processInfo) evidence.push('进程信息不可读');
  return { kind: 'other', evidence };
}

function localUrl(record) {
  if (record.scope !== 'local') return `http://localhost:${record.port}`;
  if (record.host === '::1') return `http://[::1]:${record.port}`;
  if (record.host === '0.0.0.0') return `http://localhost:${record.port}`;
  return `http://${record.host}:${record.port}`;
}

function displayAddress(record) {
  if (record.scope === 'all') return `*:${record.port}`;
  if (record.host === '::1') return `[::1]:${record.port}`;
  return `${record.host}:${record.port}`;
}

function stopBlockedReason(pid, processes, studioPid, userId) {
  if (pid <= 1) return '系统进程不可终止';
  if (pid === studioPid) return '不能终止 Studio 主进程';
  const info = processes.get(pid);
  // Ownership answers where the process came from. Stop eligibility instead
  // uses OS ownership, so an independently started local dev server is actionable.
  if (!info || !Number.isFinite(info.startedAt)) return '无法核实进程身份';
  if (info.uid === 0 || userId === undefined || info.uid !== userId) return '无权终止其他用户或系统的进程';
  const ancestors = new Set();
  let parent = processes.get(studioPid)?.ppid;
  while (parent && !ancestors.has(parent)) {
    ancestors.add(parent);
    parent = processes.get(parent)?.ppid;
  }
  if (ancestors.has(pid)) return '不能终止启动 Studio 的进程';
  if (descendantsOf(studioPid, processes).has(pid) && /(?:^|\s)--type=/.test(info.command)) {
    return 'Studio 内部进程不可终止';
  }
  return '';
}

function createRuntimeServiceScanner(options = {}) {
  const execute = options.execute || executeFile;
  const platform = options.platform || process.platform;
  const studioPid = options.processId || process.pid;
  const userId = options.userId ?? process.getuid?.();
  const now = options.now || Date.now;
  const stopProcess = options.stopProcess || ((pid) => terminateProcess(pid, { platform, execute }));
  const seen = new Map();
  let initialized = false;

  async function cwdMapFor(records) {
    const pids = [...new Set(records.map((record) => record.pid).filter(Boolean))].slice(0, 80);
    if (pids.length === 0) return new Map();
    if (platform === 'linux') {
      const entries = await Promise.all(pids.map(async (pid) => {
        try {
          return [pid, await fs.promises.readlink(`/proc/${pid}/cwd`)];
        } catch {
          return undefined;
        }
      }));
      return new Map(entries.filter(Boolean));
    }
    if (platform !== 'darwin') return new Map();
    try {
      const output = await execute('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn']);
      return parseLsofCwdOutput(output);
    } catch {
      return new Map();
    }
  }

  async function discover() {
    let listeners;
    let processTable = new Map();
    if (platform === 'darwin') {
      const [listenerResult, processResult] = await Promise.allSettled([
        execute('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpcPn']),
        execute('ps', ['-axo', 'pid=,ppid=,uid=,etime=,command=']),
      ]);
      if (listenerResult.status === 'rejected') {
        if (Number(listenerResult.reason?.code) !== 1) throw listenerResult.reason;
        // lsof uses exit code 1 for "no matches" and can still emit partial
        // results when some processes are permission-restricted.
        listeners = parseLsofListeners(listenerResult.reason?.stdout || '');
      } else {
        listeners = parseLsofListeners(listenerResult.value);
      }
      if (processResult.status === 'fulfilled') {
        processTable = parseProcessTable(processResult.value, now());
      }
    } else if (platform === 'linux') {
      const [listenerResult, processResult] = await Promise.allSettled([
        execute('ss', ['-H', '-ltnp']),
        execute('ps', ['-axo', 'pid=,ppid=,uid=,etime=,command=']),
      ]);
      if (listenerResult.status === 'rejected') throw listenerResult.reason;
      listeners = parseSsListeners(listenerResult.value);
      if (processResult.status === 'fulfilled') {
        processTable = parseProcessTable(processResult.value, now());
      }
    } else if (platform === 'win32') {
      listeners = parseNetstatListeners(await execute('netstat', ['-ano', '-p', 'tcp']));
    } else {
      return {
        supported: false,
        warning: `当前平台（${platform}）暂不支持监听端口扫描`,
        services: [],
      };
    }
    return { listeners, processTable };
  }

  async function scan({ cwd, roots = [] } = {}) {
    const scannedAt = now();
    const discovery = await discover();
    if (discovery.supported === false) {
      return {
        scannedAt,
        supported: false,
        warning: discovery.warning,
        services: [],
        summary: { total: 0, related: 0, agent: 0, workspace: 0, other: 0 },
      };
    }
    const cwdByPid = await cwdMapFor(discovery.listeners);
    const descendants = descendantsOf(studioPid, discovery.processTable);
    const workspaceRoots = normalizeRoots(cwd, roots);
    const currentKeys = new Set();
    const services = discovery.listeners.map((record) => {
      const info = discovery.processTable.get(record.pid);
      const processCwd = cwdByPid.get(record.pid);
      const ownership = classifyOwnership({
        pid: record.pid,
        processInfo: info,
        processCwd,
        descendantPids: descendants,
        roots: workspaceRoots,
        studioPid,
      });
      const key = `${record.pid}:${record.protocol}:${record.address}`;
      const wasSeen = seen.has(key);
      const firstObservedAt = seen.get(key) || scannedAt;
      const stopReason = stopBlockedReason(record.pid, discovery.processTable, studioPid, userId);
      currentKeys.add(key);
      if (!wasSeen) seen.set(key, scannedAt);
      return {
        id: key,
        port: record.port,
        protocol: record.protocol,
        address: displayAddress(record),
        host: record.host,
        scope: record.scope,
        url: localUrl(record),
        pid: record.pid,
        processName: record.processName || info?.command.split(/\s+/)[0] || `PID ${record.pid}`,
        command: info?.command || '',
        cwd: processCwd,
        elapsedSeconds: info?.elapsedSeconds,
        startedAt: info?.startedAt,
        ownership: ownership.kind,
        canStop: !stopReason,
        stopBlockedReason: stopReason,
        evidence: ownership.evidence,
        firstObservedAt,
        isNew: initialized && !wasSeen,
      };
    });
    const summary = services.reduce((counts, service) => {
      counts.total += 1;
      if (service.ownership === 'agent' || service.ownership === 'workspace') counts.related += 1;
      if (service.ownership === 'agent') counts.agent += 1;
      if (service.ownership === 'workspace') counts.workspace += 1;
      if (service.ownership === 'other') counts.other += 1;
      return counts;
    }, { total: 0, related: 0, agent: 0, workspace: 0, other: 0 });
    initialized = true;
    for (const key of [...seen.keys()]) if (!currentKeys.has(key)) seen.delete(key);
    services.sort((left, right) => {
      const rank = { agent: 0, workspace: 1, app: 2, other: 3 };
      return rank[left.ownership] - rank[right.ownership] || left.port - right.port;
    });
    return { scannedAt, supported: true, warning: '', services, summary };
  }

  async function stop({ pid, port, startedAt } = {}) {
    if (!Number.isInteger(pid) || pid <= 1) throw new Error('终止服务的进程标识无效');
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('终止服务的端口无效');
    if (pid === studioPid) throw new Error('不能终止 Studio 主进程');
    if (!Number.isFinite(startedAt)) throw new Error('进程身份已过期，请刷新后重试');

    const discovery = await discover();
    if (discovery.supported === false) throw new Error(discovery.warning);
    const target = discovery.listeners.find((record) => record.pid === pid && record.port === port);
    if (!target) throw new Error('服务已结束，或监听端口已经变化');

    const reason = stopBlockedReason(pid, discovery.processTable, studioPid, userId);
    if (reason) throw new Error(reason);
    // ps elapsed time is rounded to seconds; allow that rounding, but reject a
    // recycled PID even when the replacement has bound the same port.
    if (Math.abs(discovery.processTable.get(pid).startedAt - startedAt) > 2_000) {
      throw new Error('监听进程已经变化，请刷新后重新确认');
    }

    const affectedPorts = [...new Set(
      discovery.listeners.filter((record) => record.pid === pid).map((record) => record.port),
    )].sort((left, right) => left - right);
    const result = await stopProcess(pid);
    return {
      ok: true,
      pid,
      port,
      affectedPorts,
      forced: Boolean(result?.forced),
    };
  }

  return { scan, stop };
}

module.exports = {
  classifyOwnership,
  createRuntimeServiceScanner,
  descendantsOf,
  parseElapsedSeconds,
  parseListenAddress,
  parseLsofListeners,
  parseNetstatListeners,
  parseProcessTable,
  parseSsListeners,
  pathWithin,
  processIsAlive,
  redactCommand,
  selectRegisteredRoots,
  terminateProcess,
};

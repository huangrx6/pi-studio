/**
 * Optional Studio metrics extension runtime.
 *
 * Collection lives in the host and consumes only Pi's content-free telemetry
 * vocabulary. Conversation events are read for lifecycle and numeric usage
 * only. Transcript entries, prompts, generated text, tool arguments, and tool
 * results never enter the metrics model exposed to the renderer.
 */

const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const METRICS_EXTENSION_ID = 'builtin:studio-metrics';
const METRICS_SOURCE_ID = 'builtin:studio-metrics/live';
const METRICS_FOOTER_SOURCE_ID = 'builtin:studio-metrics/summary';
const CARRIER_KEY = 'pi-studio-metrics';

const MAX_SESSIONS = 64;
const MAX_RECENT_RUNS = 8;
const MAX_TPS_SAMPLES = 48;
const MAX_ACTIVE_SPANS = 256;
const MAX_TRACE_ANCHORS = 512;
const MAX_DATA_SOURCE_SUBSCRIPTIONS = 64;
const DATA_SOURCE_THROTTLE_MS = 100;

const SAFE_PHASE_ATTRIBUTES = new Set([
  'conversation.id',
  'task.id',
  'task.name',
  'phase',
  'kind',
  'attempt',
  'resumed',
  'outcome',
  'tool.name',
]);
const SAFE_AI_ATTRIBUTES = new Set([
  'provider',
  'api',
  'model',
  'reasoning',
  'stop',
  'usage.input',
  'usage.output',
  'usage.cache_read',
  'usage.cache_write',
  'cost.total',
]);
const SAFE_REQUEST_METRIC_ATTRIBUTES = new Set([
  'provider',
  'model',
  'stop',
  'kind',
]);
const SAFE_TASK_METRIC_ATTRIBUTES = new Set(['task', 'phase', 'outcome']);

function finiteNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value) {
  return Math.max(0, finiteNumber(value));
}

function boundedText(value, length = 120) {
  return typeof value === 'string' ? value.trim().slice(0, length) : '';
}

function conversationId(value) {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : '';
}

function runtimeConversationId(context) {
  return conversationId(context?.durableSessionId)
    || conversationId(context?.sessionId);
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(nonNegative(value) * factor) / factor;
}

function decimal(value, places = 1) {
  return String(round(value, places)).replace(/\.0+$/, '');
}

function compactCount(value) {
  const amount = nonNegative(value);
  if (amount < 1_000) return String(Math.round(amount));
  for (const [scale, unit] of [
    [1_000_000_000_000, 'T'],
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ]) {
    if (amount >= scale) {
      const scaled = amount / scale;
      return `${decimal(scaled, scaled < 100 ? 1 : 0)}${unit}`;
    }
  }
  return String(Math.round(amount));
}

function compactRate(value) {
  const amount = nonNegative(value);
  return {
    value: amount < 1_000 ? decimal(amount, 1) : compactCount(amount),
    unit: 'tok/s',
  };
}

function compactDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return { value: '—', unit: 'ms' };
  }
  if (milliseconds < 1_000) {
    return {
      value: decimal(milliseconds, milliseconds < 10 ? 1 : 0),
      unit: 'ms',
    };
  }
  if (milliseconds < 60_000) {
    return {
      value: decimal(milliseconds / 1_000, milliseconds < 10_000 ? 2 : 1),
      unit: 's',
    };
  }
  if (milliseconds < 3_600_000) {
    return { value: decimal(milliseconds / 60_000, 1), unit: 'm' };
  }
  return { value: decimal(milliseconds / 3_600_000, 1), unit: 'h' };
}

function compactFooterDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return '— s';
  }
  if (milliseconds < 60_000) {
    return `${decimal(milliseconds / 1_000, milliseconds < 10_000 ? 2 : 1)} s`;
  }
  const totalSeconds = Math.round(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function compactCost(value) {
  const amount = nonNegative(value);
  if (amount === 0) return '$0';
  if (amount < 0.000001) return '<$0.000001';
  if (amount < 0.01) return `$${decimal(amount, 6)}`;
  if (amount < 1) return `$${decimal(amount, 4)}`;
  return `$${decimal(amount, 2)}`;
}

function elapsedMs(startedAtMonotonic, endedAtMonotonic = performance.now()) {
  return Math.max(0, endedAtMonotonic - startedAtMonotonic);
}

function clockLabel(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function copyAttributes(attributes, allowed) {
  const output = {};
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return output;
  for (const key of allowed) {
    const value = attributes[key];
    if (typeof value === 'string') output[key] = boundedText(value, 160);
    else if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
    else if (typeof value === 'boolean') output[key] = value;
  }
  return output;
}

function usageTotals(usage) {
  const output = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  const models = usage?.models && typeof usage.models === 'object'
    ? usage.models
    : {};
  for (const value of Object.values(models)) {
    if (!value || typeof value !== 'object') continue;
    output.input += nonNegative(value.input);
    output.output += nonNegative(value.output);
    output.cacheRead += nonNegative(value.cacheRead);
    output.cacheWrite += nonNegative(value.cacheWrite);
    output.cost += nonNegative(value.cost?.total);
  }
  return output;
}

function totalsTotal(value) {
  return value.input + value.output + value.cacheRead + value.cacheWrite;
}

function createRun(startedAt = Date.now()) {
  return {
    requestId: undefined,
    startedAt,
    provider: '',
    model: '',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    requests: 0,
    usageDelta: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    status: 'running',
    finishedAt: undefined,
    tps: 0,
    ttftMs: undefined,
    durationMs: undefined,
  };
}

function createSession(id) {
  return {
    id,
    revision: 0,
    updatedAt: Date.now(),
    running: false,
    stage: '空闲',
    currentRun: createRun(),
    recentRuns: [],
    activeTasks: new Map(),
    currentRequest: undefined,
    lastRequest: undefined,
    tpsSamples: [],
    usageTotal: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    usageBaseline: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  };
}

function requestRate(request) {
  if (!request || !request.output) return 0;
  const generationMs = Math.max(
    1,
    nonNegative(request.durationMs) - nonNegative(request.ttftMs),
  );
  return request.output / (generationMs / 1_000);
}

function createInstrument(runtime, name, kind) {
  if (kind === 'histogram') {
    return {
      record(value, attributes, context) {
        runtime.recordMetric(name, nonNegative(value), attributes, context);
      },
    };
  }
  return {
    add(value, attributes) {
      runtime.recordMetric(name, finiteNumber(value), attributes);
    },
  };
}

class MetricsTelemetryContext {
  constructor(runtime) {
    this.runtime = runtime;
    this.metrics = Object.freeze({
      counter: (name) => createInstrument(runtime, name, 'counter'),
      upDownCounter: (name) => createInstrument(runtime, name, 'upDownCounter'),
      histogram: (name) => createInstrument(runtime, name, 'histogram'),
    });
    this.propagation = Object.freeze({
      inject: (context) => runtime.inject(context),
      extract: (carrier) => runtime.extract(carrier),
    });
    runtime.contextMetadata.set(this, { traceId: undefined, conversationId: undefined });
  }

  startSpan(options, callback) {
    return this.runtime.startSpan(this, options, callback);
  }
}

class MetricsSpan {
  constructor(runtime, context, record) {
    this.runtime = runtime;
    this.context = context;
    this.record = record;
    this.metrics = runtime.telemetry.metrics;
    this.propagation = runtime.telemetry.propagation;
  }

  startSpan(options, callback) {
    return this.runtime.startSpan(this, options, callback);
  }

  addLink() {
    // Links are useful to exporters, but the live Studio projection only needs
    // the explicit parent/child path used by Durable's task carriers.
  }

  addEvent(name, attributes) {
    this.runtime.recordEvent(this.record, name, attributes);
  }

  setAttributes(attributes) {
    this.runtime.mergeSpanAttributes(this.record, attributes);
  }

  setStatus(status) {
    this.record.status = status?.status === 'error' ? 'error' : 'ok';
  }
}

class ExtractedMetricsContext {
  constructor(runtime, metadata) {
    this.runtime = runtime;
    this.metrics = runtime.telemetry.metrics;
    this.propagation = runtime.telemetry.propagation;
    runtime.contextMetadata.set(this, metadata);
  }

  startSpan(options, callback) {
    return this.runtime.startSpan(this, options, callback);
  }
}

class MetricsRuntime {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.now = typeof options.now === 'function' ? options.now : () => performance.now();
    this.clock = typeof options.clock === 'function' ? options.clock : Date.now;
    this.idFactory = typeof options.idFactory === 'function'
      ? options.idFactory
      : () => crypto.randomUUID();
    this.onRequestCompleted = typeof options.onRequestCompleted === 'function'
      ? options.onRequestCompleted
      : undefined;
    this.loadMetricRequests = typeof options.loadMetricRequests === 'function'
      ? options.loadMetricRequests
      : undefined;
    this.noopContext = options.noopContext;
    this.sessions = new Map();
    this.loadedMetricSessionIds = new Set();
    this.contextMetadata = new WeakMap();
    this.traceAnchors = new Map();
    this.activeSpans = new Map();
    this.requestsByModel = new Map();
    this.taskConversation = new Map();
    this.providerSubscriptions = new Map();
    this.nextSpanId = 1;
    this.telemetry = new MetricsTelemetryContext(this);
    this.provider = Object.freeze({
      read: (context) => this.readDataSource(context),
      subscribe: (context, emit) => this.subscribeDataSource(context, emit),
    });
    if (Array.isArray(options.initialMetricRequests)) {
      this.hydrateMetricRequests(options.initialMetricRequests);
    }
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.enabled === next) return;
    this.enabled = next;
    if (!next) this.clear();
  }

  clear() {
    for (const subscription of this.providerSubscriptions.values()) {
      if (subscription.timer) clearTimeout(subscription.timer);
    }
    this.providerSubscriptions.clear();
    this.sessions.clear();
    this.loadedMetricSessionIds.clear();
    this.activeSpans.clear();
    this.requestsByModel.clear();
    this.taskConversation.clear();
    this.traceAnchors.clear();
  }

  close() {
    this.enabled = false;
    this.clear();
  }

  touchSession(id) {
    let session = this.sessions.get(id);
    if (!session) {
      session = createSession(id);
      this.sessions.set(id, session);
    } else {
      this.sessions.delete(id);
      this.sessions.set(id, session);
    }
    session.updatedAt = this.clock();
    this.pruneSessions();
    return session;
  }

  pruneSessions() {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const subscribed = new Set(
      [...this.providerSubscriptions.values()].map((item) => item.context.sessionId).filter(Boolean),
    );
    for (const id of this.sessions.keys()) {
      if (this.sessions.size <= MAX_SESSIONS) break;
      if (!subscribed.has(id)) this.sessions.delete(id);
    }
  }

  markChanged(session) {
    if (!session) return;
    session.revision += 1;
    session.updatedAt = this.clock();
    this.notifyDataSource(session.id);
  }

  ensurePersistedMetricSession(id) {
    if (!id || this.loadedMetricSessionIds.has(id)) return;
    this.loadedMetricSessionIds.add(id);
    if (!this.enabled || !this.loadMetricRequests) return;
    try {
      const rows = this.loadMetricRequests(id);
      if (Array.isArray(rows) && rows.length > 0) {
        this.hydrateMetricRequests(rows);
      }
    } catch {
      // Metrics history is optional; live telemetry must still work.
    }
  }

  hydrateMetricRequests(rows) {
    const grouped = new Map();
    for (const row of rows) {
      const id = conversationId(row?.conversationId);
      if (!id || !row?.requestId) continue;
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(row);
    }
    for (const [id, requests] of grouped) {
      const session = this.touchSession(id);
      requests.sort((left, right) => (
        nonNegative(right.finishedAt) - nonNegative(left.finishedAt)
        || String(right.requestId).localeCompare(String(left.requestId))
      ));
      for (const row of requests) {
        if (session.recentRuns.some((run) => run.requestId === row.requestId)) continue;
        const run = createRun(nonNegative(row.startedAt) || nonNegative(row.finishedAt));
        const input = nonNegative(row.input);
        const output = nonNegative(row.output);
        const cacheRead = nonNegative(row.cacheRead);
        const cacheWrite = nonNegative(row.cacheWrite);
        const cost = nonNegative(row.cost);
        run.requestId = row.requestId;
        run.provider = boundedText(row.providerId, 160);
        run.model = boundedText(row.modelId, 240);
        run.status = row.status === 'failed' ? 'failed' : 'done';
        run.finishedAt = nonNegative(row.finishedAt) || run.startedAt;
        run.tps = nonNegative(row.tps);
        run.ttftMs = Number.isFinite(row.ttftMs) ? nonNegative(row.ttftMs) : undefined;
        run.durationMs = nonNegative(row.durationMs);
        run.input = input + cacheRead + cacheWrite;
        run.output = output;
        run.cacheRead = cacheRead;
        run.cacheWrite = cacheWrite;
        run.cost = cost;
        run.requests = 1;
        run.usageDelta = { input, output, cacheRead, cacheWrite, cost };
        session.recentRuns.push(run);
      }
      session.recentRuns.sort((left, right) => (
        nonNegative(right.finishedAt) - nonNegative(left.finishedAt)
      ));
      if (session.recentRuns.length > MAX_RECENT_RUNS) {
        session.recentRuns.length = MAX_RECENT_RUNS;
      }
      const latest = session.recentRuns[0];
      if (latest) {
        session.lastRequest = {
          id: latest.requestId,
          startedAt: latest.startedAt,
          startedAtMonotonic: this.now() - nonNegative(latest.durationMs),
          provider: latest.provider,
          model: latest.model,
          input: latest.input,
          output: latest.output,
          cacheRead: latest.cacheRead,
          cacheWrite: latest.cacheWrite,
          cost: latest.cost,
          liveTps: latest.tps,
          ttftMs: latest.ttftMs,
          durationMs: latest.durationMs,
          completed: true,
        };
        session.stage = latest.status === 'done' ? '本轮完成' : '本轮失败';
        session.usageTotal = {
          input: latest.input,
          output: latest.output,
          cacheRead: latest.cacheRead,
          cacheWrite: latest.cacheWrite,
          cost: latest.cost,
        };
      }
      session.revision += 1;
      session.updatedAt = this.clock();
      this.loadedMetricSessionIds.add(id);
    }
  }

  contextRecord(context) {
    return this.contextMetadata.get(context);
  }

  startSpan(parentContext, options, callback) {
    const callbackFn = typeof callback === 'function' ? callback : () => undefined;
    if (!this.enabled) {
      if (this.noopContext) return this.noopContext.startSpan(options, callbackFn);
      const span = {
        metrics: undefined,
        propagation: undefined,
        startSpan(_nextOptions, nextCallback) {
          return Promise.resolve().then(() => nextCallback(span));
        },
        addLink() {},
        addEvent() {},
        setAttributes() {},
        setStatus() {},
      };
      try {
        return Promise.resolve(callbackFn(span));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    const parent = this.contextRecord(parentContext) || {};
    const startAttributes = copyAttributes(
      options?.attributes,
      options?.name?.startsWith('pi.ai.')
        ? SAFE_AI_ATTRIBUTES
        : SAFE_PHASE_ATTRIBUTES,
    );
    const explicitConversation = conversationId(startAttributes['conversation.id']);
    const taskId = Number.isSafeInteger(startAttributes['task.id'])
      ? String(startAttributes['task.id'])
      : undefined;
    const traceId = parent.traceId || this.idFactory();
    const spanId = `${traceId}.${this.nextSpanId}`;
    this.nextSpanId += 1;
    const record = {
      id: spanId,
      name: boundedText(options?.name, 120),
      traceId,
      parentId: parent.spanId,
      startedAt: this.clock(),
      startedAtMonotonic: this.now(),
      settledAtMonotonic: undefined,
      conversationId: explicitConversation
        || (taskId && this.taskConversation.get(taskId))
        || parent.conversationId,
      taskId,
      attributes: startAttributes,
      status: 'ok',
      settled: false,
      request: undefined,
      session: undefined,
    };
    const span = new MetricsSpan(this, parentContext, record);
    this.contextMetadata.set(span, {
      traceId,
      spanId,
      conversationId: record.conversationId,
    });

    if (record.conversationId) {
      this.ensurePersistedMetricSession(record.conversationId);
      record.session = this.touchSession(record.conversationId);
      if (record.name === 'pi.durable.phase') {
        record.session.running = true;
        if (record.session.currentRun.status !== 'running') {
          record.session.currentRun = createRun(record.startedAt);
        }
        record.session.stage = boundedText(
          startAttributes.phase || startAttributes['task.name'] || '运行中',
          120,
        );
      }
    }
    if (taskId && record.conversationId) this.taskConversation.set(taskId, record.conversationId);
    if (record.name === 'pi.ai.request' || record.name === 'pi.ai.poll') {
      this.beginRequest(record);
    }
    if (record.name === 'pi.durable.phase' && record.session) {
      record.session.activeTasks.set(taskId || spanId, {
        taskId: taskId || spanId,
        task: boundedText(startAttributes['task.name'] || 'task', 80),
        phase: boundedText(startAttributes.phase || 'running', 80),
        startedAt: record.startedAt,
        status: 'active',
      });
    }

    this.activeSpans.set(spanId, record);
    this.pruneActiveSpans();
    this.pruneTraceAnchors();
    if (record.session) this.markChanged(record.session);

    let value;
    try {
      value = callbackFn(span);
    } catch (error) {
      this.settleSpan(record, error);
      return Promise.reject(error);
    }
    return Promise.resolve(value).then(
      (result) => {
        this.settleSpan(record);
        return result;
      },
      (error) => {
        this.settleSpan(record, error);
        throw error;
      },
    );
  }

  pruneActiveSpans() {
    while (this.activeSpans.size > MAX_ACTIVE_SPANS) {
      const oldest = this.activeSpans.keys().next().value;
      const record = this.activeSpans.get(oldest);
      this.activeSpans.delete(oldest);
      if (record) this.settleSpan(record, new Error('active span capacity exceeded'));
    }
  }

  pruneTraceAnchors() {
    while (this.traceAnchors.size > MAX_TRACE_ANCHORS) {
      this.traceAnchors.delete(this.traceAnchors.keys().next().value);
    }
  }

  requestModelKey(attributes) {
    const provider = boundedText(attributes?.provider, 160);
    const model = boundedText(attributes?.model, 160);
    return provider && model ? `${provider}\0${model}` : '';
  }

  beginRequest(record) {
    const session = record.session;
    const startedAt = Date.now();
    const request = {
      id: record.id,
      provider: boundedText(record.attributes.provider, 120),
      model: boundedText(record.attributes.model, 120),
      startedAt,
      startedAtMonotonic: record.startedAtMonotonic,
      ttftMs: undefined,
      durationMs: undefined,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      outputChars: 0,
      liveTps: 0,
      stop: undefined,
      completed: false,
    };
    record.request = request;
    if (session) {
      session.currentRequest = request;
      session.stage = '模型请求';
    }
    const key = this.requestModelKey(record.attributes);
    if (key) {
      const requests = this.requestsByModel.get(key) || [];
      requests.push(record);
      if (requests.length > 8) {
        const removed = requests.shift();
        if (removed?.request) removed.request.completed = true;
      }
      this.requestsByModel.set(key, requests);
    }
  }

  latestRequestFor(attributes) {
    const key = this.requestModelKey(attributes);
    const requests = key ? this.requestsByModel.get(key) : undefined;
    if (!requests) return undefined;
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const record = requests[index];
      if (record && !record.settled) return record;
    }
    return undefined;
  }

  mergeSpanAttributes(record, attributes) {
    if (!this.enabled || record.settled) return;
    const allowed = record.name.startsWith('pi.ai.')
      ? SAFE_AI_ATTRIBUTES
      : SAFE_PHASE_ATTRIBUTES;
    Object.assign(record.attributes, copyAttributes(attributes, allowed));
    if (record.request) this.mergeRequestAttributes(record.request, record.attributes);
    if (record.name === 'pi.durable.phase' && record.taskId && record.session) {
      const task = record.session.activeTasks.get(record.taskId);
      if (task && record.attributes.outcome) {
        task.status = record.status === 'error' ? 'error' : 'neutral';
      }
    }
    if (record.session) this.markChanged(record.session);
  }

  mergeRequestAttributes(request, attributes) {
    if (!request || !attributes) return;
    request.input = Math.max(request.input, nonNegative(attributes['usage.input']));
    request.output = Math.max(request.output, nonNegative(attributes['usage.output']));
    request.cacheRead = Math.max(request.cacheRead, nonNegative(attributes['usage.cache_read']));
    request.cacheWrite = Math.max(request.cacheWrite, nonNegative(attributes['usage.cache_write']));
    request.cost = Math.max(request.cost, nonNegative(attributes['cost.total']));
    request.stop = boundedText(attributes.stop, 40) || request.stop;
    request.durationMs = Math.max(
      nonNegative(request.durationMs),
      elapsedMs(request.startedAtMonotonic),
    );
  }

  recordEvent(record, name, attributes) {
    if (!this.enabled || record.settled) return;
    if (name === 'pi.ai.first_chunk' && record.request) {
      const request = record.request;
      request.ttftMs = elapsedMs(request.startedAtMonotonic);
      request.durationMs = request.ttftMs;
      if (record.session) {
        record.session.stage = '生成中';
        this.markChanged(record.session);
      }
      return;
    }
    if (name === 'pi.ai.block' && record.request) {
      const chars = nonNegative(attributes?.chars);
      const request = record.request;
      request.outputChars += chars;
      const generationMs = Math.max(
        100,
        elapsedMs(request.startedAtMonotonic) - nonNegative(request.ttftMs),
      );
      request.liveTps = (request.outputChars / 4) / (generationMs / 1_000);
      if (record.session) {
        record.session.stage = attributes?.type === 'thinking' ? '思考中' : '生成中';
        this.pushTpsSample(record.session, request.liveTps);
        this.markChanged(record.session);
      }
      return;
    }
    if (name === 'pi.durable.checkpoint' && record.name === 'pi.durable.phase') {
      const phase = boundedText(attributes?.phase, 80) || record.attributes.phase;
      record.attributes.phase = phase;
      if (record.session && record.taskId) {
        const task = record.session.activeTasks.get(record.taskId);
        if (task) task.phase = phase;
        record.session.stage = phase || record.session.stage;
        this.markChanged(record.session);
      }
      return;
    }
    if (name === 'pi.durable.submission' && record.session) {
      const status = boundedText(attributes?.status, 40);
      if (status === 'done' || status === 'unanswered') {
        this.finishRun(record.session, status === 'done' ? 'done' : 'failed');
      }
    }
  }

  recordMetric(name, value, attributes, context) {
    if (!this.enabled) return;
    const safeAttributes = copyAttributes(
      attributes,
      name.startsWith('pi.ai.')
        ? SAFE_REQUEST_METRIC_ATTRIBUTES
        : SAFE_TASK_METRIC_ATTRIBUTES,
    );
    let record = context ? this.contextRecord(context) : undefined;
    let request = record?.request || this.latestRequestFor(safeAttributes)?.request;
    if (name === 'pi.ai.first_chunk.duration' && request) {
      request.ttftMs = nonNegative(value);
      request.durationMs = Math.max(nonNegative(request.durationMs), request.ttftMs);
      if (record?.session) this.markChanged(record.session);
      return;
    }
    if (name === 'pi.ai.request.duration' && request) {
      request.durationMs = nonNegative(value);
      request.stop = boundedText(safeAttributes.stop, 40) || request.stop;
      if (record?.session) this.markChanged(record.session);
      return;
    }
    if (name === 'pi.ai.tokens' && request) {
      if (safeAttributes.kind === 'input') request.input = nonNegative(value);
      if (safeAttributes.kind === 'output') request.output = nonNegative(value);
      if (safeAttributes.kind === 'cache_read') request.cacheRead = nonNegative(value);
      if (safeAttributes.kind === 'cache_write') request.cacheWrite = nonNegative(value);
      return;
    }
    if (name === 'pi.ai.cost' && request) {
      request.cost = nonNegative(value);
    }
  }

  settleSpan(record, error) {
    if (!record || record.settled) return;
    record.settled = true;
    record.settledAtMonotonic = this.now();
    this.activeSpans.delete(record.id);
    if (error) record.status = 'error';
    if (record.request) {
      this.mergeRequestAttributes(record.request, record.attributes);
      this.completeRequest(record);
    }
    if (record.taskId) {
      this.taskConversation.delete(record.taskId);
      if (record.session) {
        record.session.activeTasks.delete(record.taskId);
        if (record.session.activeTasks.size === 0 && record.session.running) {
          record.session.stage = '收尾中';
        }
      }
    }
    if (record.session) {
      this.markChanged(record.session);
    }
  }

  completeRequest(record) {
    const request = record.request;
    if (!request || request.completed) return;
    request.completed = true;
    request.durationMs = Math.max(
      nonNegative(request.durationMs),
      elapsedMs(request.startedAtMonotonic, record.settledAtMonotonic),
    );
    request.ttftMs = request.ttftMs === undefined
      ? undefined
      : Math.min(request.ttftMs, request.durationMs);
    const actualTps = requestRate(request);
    if (actualTps > 0) {
      request.liveTps = actualTps;
    }

    if (this.onRequestCompleted) {
      try {
        this.onRequestCompleted({
          requestId: request.id,
          at: request.startedAt,
          finishedAt: request.startedAt + request.durationMs,
          conversationId: record.session?.id || record.conversationId || '',
          status: record.status === 'error' ? 'failed' : 'done',
          providerId: request.provider,
          modelId: request.model,
          tps: actualTps || request.liveTps,
          ttftMs: request.ttftMs,
          durationMs: request.durationMs,
          input: request.input,
          output: request.output,
          cacheRead: request.cacheRead,
          cacheWrite: request.cacheWrite,
          cost: request.cost,
        });
      } catch {
        // Analytics persistence must never interrupt an Agent request.
      }
    }

    const key = this.requestModelKey(request);
    const requests = key ? this.requestsByModel.get(key) : undefined;
    if (requests) {
      const remaining = requests.filter((item) => item !== record && !item.settled);
      if (remaining.length > 0) this.requestsByModel.set(key, remaining);
      else this.requestsByModel.delete(key);
    }

    const session = record.session;
    if (!session) return;
    const run = session.currentRun.status === 'running'
      ? session.currentRun
      : (session.currentRun = createRun());
    run.input += request.input + request.cacheRead + request.cacheWrite;
    run.output += request.output;
    run.cacheRead += request.cacheRead;
    run.cacheWrite += request.cacheWrite;
    run.cost += request.cost;
    run.requests += 1;
    run.tps = actualTps || request.liveTps;
    if (request.ttftMs !== undefined) run.ttftMs = request.ttftMs;
    run.durationMs = request.durationMs;
    session.lastRequest = { ...request };
    session.currentRequest = session.currentRequest === request ? undefined : session.currentRequest;
    if (request.liveTps > 0) this.pushTpsSample(session, request.liveTps);
  }

  pushTpsSample(session, value) {
    if (!Number.isFinite(value) || value <= 0) return;
    const samples = session.tpsSamples;
    samples.push(round(value, 1));
    if (samples.length > MAX_TPS_SAMPLES) samples.splice(0, samples.length - MAX_TPS_SAMPLES);
  }

  ensureRun(session) {
    if (!session.currentRun || session.currentRun.status !== 'running') {
      session.currentRun = createRun();
      session.usageBaseline = { ...session.usageTotal };
    }
    session.running = true;
    return session.currentRun;
  }

  recordConversationEvent(event) {
    if (!this.enabled || !event || typeof event !== 'object') return;
    const id = conversationId(event.conversationId);
    if (!id) return;
    this.ensurePersistedMetricSession(id);
    const session = this.touchSession(id);
    if (event.type === 'run.started' || event.type === 'run_start') {
      if (!session.running || session.currentRun.status !== 'running') {
        session.currentRun = createRun(this.clock());
        session.usageBaseline = { ...session.usageTotal };
        session.tpsSamples = [];
      }
      session.running = true;
      session.stage = '运行开始';
      this.markChanged(session);
      return;
    }
    if (event.type === 'run.completed' || event.type === 'run_end') {
      this.finishRun(session, 'done');
      return;
    }
    if (event.type === 'run.failed') {
      this.finishRun(session, 'failed');
      return;
    }
    if (event.type === 'snapshot') {
      const running = Boolean(event.payload?.run);
      if (running && !session.running) {
        this.ensureRun(session);
        session.stage = '恢复运行';
      } else if (!running && session.running && session.activeTasks.size === 0) {
        this.finishRun(session, 'done');
      }
      this.markChanged(session);
      return;
    }
    if (event.type === 'usage.updated') {
      const total = usageTotals(event.payload?.usage);
      if (totalsTotal(total) === 0 && total.cost === 0) return;
      session.usageTotal = total;
      const run = session.currentRun.status === 'running'
        ? session.currentRun
        : session.recentRuns[0];
      if (run) {
        const usageDelta = {
          input: Math.max(0, total.input - session.usageBaseline.input),
          output: Math.max(0, total.output - session.usageBaseline.output),
          cacheRead: Math.max(0, total.cacheRead - session.usageBaseline.cacheRead),
          cacheWrite: Math.max(0, total.cacheWrite - session.usageBaseline.cacheWrite),
          cost: Math.max(0, total.cost - session.usageBaseline.cost),
        };
        run.usageDelta = usageDelta;
        run.input = Math.max(
          run.input,
          usageDelta.input + usageDelta.cacheRead + usageDelta.cacheWrite,
        );
        run.output = Math.max(run.output, usageDelta.output);
        run.cost = Math.max(run.cost, usageDelta.cost);
      }
      this.markChanged(session);
    }
  }

  finishRun(session, status) {
    if (!session || !session.running) return;
    const run = session.currentRun;
    const usageDelta = run.usageDelta || {};
    run.input = Math.max(
      run.input,
      usageDelta.input + usageDelta.cacheRead + usageDelta.cacheWrite,
    );
    run.output = Math.max(run.output, usageDelta.output);
    run.cost = Math.max(run.cost, usageDelta.cost);
    run.status = status;
    run.finishedAt = this.clock();
    session.running = false;
    session.stage = status === 'done' ? '本轮完成' : '本轮失败';
    session.recentRuns.unshift({ ...run });
    if (session.recentRuns.length > MAX_RECENT_RUNS) {
      session.recentRuns.length = MAX_RECENT_RUNS;
    }
    session.currentRun = createRun();
    session.currentRequest = undefined;
    this.markChanged(session);
  }

  inject(context) {
    if (!this.enabled) return undefined;
    const metadata = this.contextMetadata.get(context);
    if (!metadata?.traceId) return undefined;
    const token = metadata.spanId || `${metadata.traceId}.root`;
    this.traceAnchors.set(token, {
      traceId: metadata.traceId,
      spanId: metadata.spanId,
      conversationId: metadata.conversationId,
    });
    this.pruneTraceAnchors();
    return { [CARRIER_KEY]: token };
  }

  extract(carrier) {
    if (!this.enabled) return this.noopContext || this.telemetry;
    const token = carrier?.[CARRIER_KEY];
    if (typeof token !== 'string' || token.length > 240) return this.telemetry;
    const saved = this.traceAnchors.get(token);
    const traceId = saved?.traceId || token.split('.')[0];
    if (!traceId || traceId.length > 128) return this.telemetry;
    return new ExtractedMetricsContext(this, {
      traceId,
      spanId: saved?.spanId,
      conversationId: saved?.conversationId,
    });
  }

  readDataSource(context = {}) {
    if (!this.enabled) return [];
    const id = runtimeConversationId(context);
    if (!id) return [];
    this.ensurePersistedMetricSession(id);
    const session = this.sessions.get(id);
    if (!session) return [];
    if (context.sourceId === METRICS_FOOTER_SOURCE_ID) {
      return this.renderFooterContent(session);
    }
    return this.renderContent(session);
  }

  subscribeDataSource(context = {}, emit) {
    if (!this.enabled || typeof emit !== 'function') {
      throw new Error('studio-metrics 数据源当前不可用');
    }
    if (this.providerSubscriptions.size >= MAX_DATA_SOURCE_SUBSCRIPTIONS) {
      throw new Error('studio-metrics 数据源订阅数量已达到上限');
    }
    const id = crypto.randomUUID();
    const subscription = {
      id,
      context: Object.freeze({
        sourceId: context.sourceId,
        sessionId: runtimeConversationId(context),
        cwd: boundedText(context.cwd, 4_096),
      }),
      emit,
      timer: undefined,
      closed: false,
      lastRevision: -1,
    };
    this.providerSubscriptions.set(id, subscription);
    return () => {
      if (subscription.closed) return;
      subscription.closed = true;
      if (subscription.timer) clearTimeout(subscription.timer);
      this.providerSubscriptions.delete(id);
    };
  }

  notifyDataSource(sessionId) {
    for (const subscription of this.providerSubscriptions.values()) {
      if (subscription.closed) continue;
      if (subscription.context.sessionId && subscription.context.sessionId !== sessionId) continue;
      if (subscription.timer) continue;
      subscription.timer = setTimeout(() => {
        subscription.timer = undefined;
        if (subscription.closed || !this.enabled) return;
        const session = this.sessions.get(sessionId);
        const revision = session?.revision || 0;
        if (subscription.lastRevision === revision) return;
        subscription.lastRevision = revision;
        subscription.emit(this.readDataSource(subscription.context));
      }, DATA_SOURCE_THROTTLE_MS);
      subscription.timer.unref?.();
    }
  }

  renderContent(session) {
    const run = session.running ? session.currentRun : session.recentRuns[0];
    const request = session.currentRequest || session.lastRequest;
    if (!run && !request) return [];

    const tps = session.running
      ? (request?.liveTps || run?.tps || 0)
      : (run?.tps || requestRate(request));
    const ttft = request?.ttftMs
      ?? run?.ttftMs;
    const duration = session.running
      ? (request ? elapsedMs(request.startedAtMonotonic) : 0)
      : (request?.durationMs ?? run?.durationMs);
    const input = run?.input || 0;
    const output = run?.output || 0;
    const cost = run?.cost || 0;
    const model = request
      ? `${request.provider || 'unknown'}/${request.model || 'unknown'}`
      : '';
    const tpsMetric = compactRate(tps);
    const ttftMetric = compactDuration(ttft);
    const durationMetric = compactDuration(duration);
    const inputMetric = compactCount(input);
    const outputMetric = compactCount(output);
    const costMetric = compactCost(cost);
    const inputDetail = run && (run.cacheRead || run.cacheWrite)
      ? `缓存读 ${compactCount(run.cacheRead)} · 写 ${compactCount(run.cacheWrite)}`
      : '累计输入 token';

    const tasks = [...session.activeTasks.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, 6);
    const statusItems = tasks.length > 0
      ? tasks.map((task, index) => ({
        id: `task-${index + 1}`,
        label: `${task.task} · ${task.phase}`,
        detail: clockLabel(task.startedAt),
        status: 'active',
      }))
      : [{
        id: 'current-state',
        label: session.stage,
        detail: session.running ? '正在采集指标' : '最近一轮已结束',
        status: session.running ? 'active' : 'success',
      }];

    const recentItems = session.recentRuns.slice(0, 6).map((item, index) => {
      const itemTps = compactRate(item.tps || 0);
      const itemTtft = compactDuration(item.ttftMs);
      const itemDuration = compactDuration(item.durationMs || 0);
      const completed = item.status === 'done';
      return {
        id: `recent-${index + 1}`,
        label: `${clockLabel(item.finishedAt || item.startedAt)} · ${completed ? '完成' : '失败'}`,
        detail: [
          `TPS ${itemTps.value} ${itemTps.unit}`,
          `TTFT ${itemTtft.value} ${itemTtft.unit}`,
          `耗时 ${itemDuration.value} ${itemDuration.unit}`,
          `Token ${compactCount(item.input)} / ${compactCount(item.output)}`,
          compactCost(item.cost),
        ].join(' · '),
        status: completed ? 'success' : 'error',
      };
    });

    const content = [{
      kind: 'metricGrid',
      columns: 3,
      metrics: [
        {
          id: 'live-tps',
          label: '实时 TPS',
          value: tpsMetric.value,
          unit: tpsMetric.unit,
          detail: model
            ? `${model}${session.running ? ' · 流式估算' : ''}`
            : (session.running ? '流式估算' : '最近请求'),
          tone: tps > 0 ? 'success' : 'neutral',
        },
        {
          id: 'ttft',
          label: 'TTFT',
          value: ttftMetric.value,
          unit: ttftMetric.unit,
          detail: '首个流事件',
        },
        {
          id: 'request-duration',
          label: '请求耗时',
          value: durationMetric.value,
          unit: durationMetric.unit,
          detail: session.running ? '当前请求' : '最近请求',
        },
        {
          id: 'input-tokens',
          label: '输入 Token',
          value: inputMetric,
          detail: inputDetail,
        },
        {
          id: 'output-tokens',
          label: '输出 Token',
          value: outputMetric,
          detail: session.running ? '本轮累计' : '最近一轮',
        },
        {
          id: 'cost',
          label: '成本',
          value: costMetric,
          detail: session.running ? '本轮累计' : '最近一轮',
        },
      ],
    }, {
      kind: 'statusList',
      title: session.running ? '当前任务与阶段' : '运行状态',
      items: statusItems,
    }];

    if (session.tpsSamples.length > 1) {
      content.push({
        kind: 'sparkline',
        label: 'TPS 采样',
        values: [...session.tpsSamples],
        unit: 'tok/s',
        tone: 'success',
      });
    }

    if (recentItems.length > 0) {
      content.push({
        kind: 'statusList',
        title: '最近结果',
        items: recentItems,
      });
    }
    return content;
  }

  renderFooterContent(session) {
    const run = session.running ? session.currentRun : session.recentRuns[0];
    const request = session.currentRequest || session.lastRequest;
    if (!run && !request) return [];
    const tps = session.running
      ? (request?.liveTps || run?.tps || 0)
      : (run?.tps || requestRate(request));
    const ttft = request?.ttftMs ?? run?.ttftMs;
    const tpsMetric = compactRate(tps);
    return [{
      kind: 'text',
      text: [
        session.running ? (session.stage || '执行中') : '最近请求',
        `${tpsMetric.value} ${tpsMetric.unit}`,
        `TTFT ${compactFooterDuration(ttft)}`,
      ].join(' · '),
    }];
  }

  diagnostics() {
    return {
      enabled: this.enabled,
      sessions: this.sessions.size,
      activeSpans: this.activeSpans.size,
      traceAnchors: this.traceAnchors.size,
      dataSourceSubscriptions: this.providerSubscriptions.size,
      recentRuns: Math.max(0, ...Array.from(this.sessions.values(), (session) => (
        session.recentRuns.length
      ))),
      max: {
        sessions: MAX_SESSIONS,
        activeSpans: MAX_ACTIVE_SPANS,
        traceAnchors: MAX_TRACE_ANCHORS,
        recentRuns: MAX_RECENT_RUNS,
        tpsSamples: MAX_TPS_SAMPLES,
        dataSourceSubscriptions: MAX_DATA_SOURCE_SUBSCRIPTIONS,
      },
    };
  }
}

function createMetricsRuntime(options = {}) {
  return new MetricsRuntime(options);
}

module.exports = {
  DATA_SOURCE_THROTTLE_MS,
  MAX_ACTIVE_SPANS,
  MAX_DATA_SOURCE_SUBSCRIPTIONS,
  MAX_RECENT_RUNS,
  MAX_SESSIONS,
  MAX_TRACE_ANCHORS,
  MAX_TPS_SAMPLES,
  METRICS_EXTENSION_ID,
  METRICS_FOOTER_SOURCE_ID,
  METRICS_SOURCE_ID,
  compactFooterDuration,
  createMetricsRuntime,
  usageTotals,
};

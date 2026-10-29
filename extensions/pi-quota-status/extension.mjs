import { adapterForProvider } from './quota/adapters.mjs';
import { createMonitor } from './quota/monitor.mjs';
import { quotaSummary } from './quota/ui.mjs';

const monitors = new Map();

function providerId(context) {
  const modelRef = context?.model?.modelRef;
  if (typeof modelRef !== 'string') return '';
  const slash = modelRef.indexOf('/');
  return slash > 0 ? modelRef.slice(0, slash) : '';
}

function monitorFor(context, credentials) {
  const provider = providerId(context);
  const adapter = adapterForProvider(provider);
  if (!provider || !adapter) return undefined;
  const existing = monitors.get(provider);
  if (existing) return existing;
  const monitor = createMonitor({
    provider,
    adapter,
    credentials,
  });
  monitors.set(provider, monitor);
  return monitor;
}

async function readQuota(context, credentials) {
  const monitor = monitorFor(context, credentials);
  if (!monitor) return [{
    kind: 'notice',
    tone: 'info',
    title: '当前来源没有额度适配器',
    text: '额度扩展只查询明确支持的套餐与余额接口，不会按模型名称猜测账户。',
  }];
  await monitor.refresh(context);
  return monitor.content();
}

async function readQuotaSummary(context, credentials) {
  const monitor = monitorFor(context, credentials);
  if (!monitor) {
    return quotaSummary({}, undefined);
  }
  await monitor.refresh(context);
  return quotaSummary(monitor.state, monitor.state.adapter);
}

function subscribeQuota(context, credentials, publish, summary = false) {
  const monitor = monitorFor(context, credentials);
  if (!monitor) return () => {};
  return monitor.subscribe(context, () => {
    publish(summary
      ? quotaSummary(monitor.state, monitor.state.adapter)
      : monitor.content());
  });
}

export async function activate(context) {
  if (!context.providerCredentials) {
    throw new Error('额度扩展缺少 provider.credentials 能力');
  }
  const credentials = context.providerCredentials;
  return {
    dataSources: {
      live: {
        read: (sourceContext) => readQuota(sourceContext, credentials),
        subscribe: (sourceContext, publish) => subscribeQuota(
          sourceContext,
          credentials,
          publish,
        ),
      },
      summary: {
        read: (sourceContext) => readQuotaSummary(sourceContext, credentials),
        subscribe: (sourceContext, publish) => subscribeQuota(
          sourceContext,
          credentials,
          publish,
          true,
        ),
      },
    },
    cleanup() {
      for (const monitor of monitors.values()) monitor.dispose();
      monitors.clear();
    },
  };
}

export function deactivate() {
  for (const monitor of monitors.values()) monitor.dispose();
  monitors.clear();
}

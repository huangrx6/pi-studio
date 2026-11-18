'use strict';

/**
 * Studio 的 fetch 请求统一走这里（模型、OAuth、目录与远程下载）。
 *
 * Node 自带的 fetch 不使用系统代理：只配了系统代理的 VPN（macOS 上最常见的
 * Clash/Surge 模式）会让主进程直连 GitHub，结果就是超时或十几秒才连上。
 * Electron 的 net.fetch 跑在 Chromium 网络栈上，会读取系统代理与 PAC，
 * 应用启动后由 network 服务安装带代理设置的 Chromium session.fetch；
 * 独立使用时优先 net.fetch，其余场景（单元测试、纯 Node 工具）回退到
 * 运行时自带的 fetch。不会替换 Node http/https 或 WebSocket。
 */

function resolveTransport() {
  try {
    // 测试环境里 require('electron') 只返回可执行文件路径，没有 net。
    const electron = require('electron');
    const netFetch = electron?.net?.fetch;
    if (typeof netFetch !== 'function') return null;
    if (typeof electron.app?.isReady === 'function' && !electron.app.isReady()) return null;
    return (url, init) => netFetch.call(electron.net, url, init);
  } catch {
    return null;
  }
}

let transport;
let configuredTransport;
let runtimeFetch;

function systemFetch(url, init) {
  if (configuredTransport) return configuredTransport(url, init);
  if (transport === undefined) transport = resolveTransport();
  // A call before app.ready must not permanently disable Chromium transport.
  if (!transport) transport = undefined;
  return transport ? transport(url, init) : (runtimeFetch || globalThis.fetch)(url, init);
}

/** Install once the app is ready, before any provider SDK captures fetch. */
function installSystemFetch(fetcher) {
  if (typeof fetcher !== 'function' || fetcher === systemFetch) throw new Error('网络传输无效');
  if (globalThis.fetch !== systemFetch) runtimeFetch = globalThis.fetch;
  configuredTransport = fetcher;
  globalThis.fetch = systemFetch;
}

/** 让下一次调用重新探测底层实现；仅供测试和诊断使用。 */
function resetSystemFetch() {
  if (globalThis.fetch === systemFetch && runtimeFetch) globalThis.fetch = runtimeFetch;
  transport = undefined;
  configuredTransport = undefined;
  runtimeFetch = undefined;
}

module.exports = { systemFetch, installSystemFetch, resetSystemFetch };

'use strict';

/**
 * 远程下载统一走这里。
 *
 * Node 自带的 fetch 不使用系统代理：只配了系统代理的 VPN（macOS 上最常见的
 * Clash/Surge 模式）会让主进程直连 GitHub，结果就是超时或十几秒才连上。
 * Electron 的 net.fetch 跑在 Chromium 网络栈上，会读取系统代理与 PAC，
 * 所以主进程里可用时优先用它，其余场景（单元测试、纯 Node 工具）回退到
 * 运行时自带的 fetch。
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

function systemFetch(url, init) {
  if (transport === undefined) transport = resolveTransport();
  return transport ? transport(url, init) : globalThis.fetch(url, init);
}

/** 让下一次调用重新探测底层实现；仅供测试和诊断使用。 */
function resetSystemFetch() {
  transport = undefined;
}

module.exports = { systemFetch, resetSystemFetch };

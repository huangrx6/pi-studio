/** Wraps resource-details DTOs. All mutations and recovery receipts live only in memory. */
export function installExtensionMutationFixture() {
  const base = window.piApi, clone = value => structuredClone(value);
  const calls = [], holds = new Set(), failures = new Set(), pending = new Map(), receipts = new Map();
  let extensions, sequence = 0;
  const settings = async cwd => {
    const snapshot = await base.settings(cwd);
    extensions ||= clone(snapshot.extensions);
    return { ...snapshot, extensions: clone(extensions), extensionErrors: [] };
  };
  async function gate(method, input) {
    calls.push({ method, input: clone(input) });
    const failed = failures.delete(method);
    if (holds.has(method)) await new Promise(resolve => { const list = pending.get(method) || []; list.push(resolve); pending.set(method, list); });
    if (failed) throw new Error(`QA ${method} 读取失败`);
  }
  async function mutate(method, input) {
    await settings(input.cwd);
    const item = extensions.find(item => item.id === input.id);
    if (!item) throw new Error('QA missing extension');
    if (method === 'removeExtension') extensions = extensions.filter(item => item.id !== input.id);
    if (method === 'setExtensionEnabled') Object.assign(item, { enabled: input.enabled, available: input.enabled && item.trusted });
    if (method === 'setExtensionTrusted') Object.assign(item, { trusted: input.trusted, available: input.trusted && item.enabled, health: 'ready', blockedReason: '' });
    if (method === 'rollbackExtension') { item.version = '1.0.0'; item.installation.version = '1.0.0'; }
    const token = `qa-receipt-${++sequence}`;
    const result = { committed: true, recoveryToken: token, projection: { status: 'error', message: '扩展操作已完成，但运行时刷新失败。' }, ...(method === 'rollbackExtension' ? { installed: { id: item.id, version: item.version, contentChanged: true, trustRevoked: false } } : {}) };
    receipts.set(token, { cwd: input.cwd, result });
    await gate(method, input); return clone(result);
  }
  window.__extensionMutationQa = {
    calls,
    hold(method) { holds.add(method); }, fail(method) { failures.add(method); },
    pending(method) { return pending.get(method)?.length || 0; },
    release(method) { holds.delete(method); for (const resolve of pending.get(method) || []) resolve(); pending.delete(method); },
    open(id) { window.__resourceDetailsQa.open(id); },
    receipts() { return [...receipts].map(([token, value]) => ({ token, cwd: value.cwd })); },
  };
  window.piApi = new Proxy({
    settings: async cwd => { await gate('settings', { cwd }); return settings(cwd); },
    removeExtension: input => mutate('removeExtension', input),
    setExtensionEnabled: input => mutate('setExtensionEnabled', input),
    setExtensionTrusted: input => mutate('setExtensionTrusted', input),
    rollbackExtension: input => mutate('rollbackExtension', input),
    refreshExtensionMutation: async token => {
      const receipt = receipts.get(token); if (!receipt) throw new Error('QA invalid receipt');
      await gate('refreshExtensionMutation', { token, cwd: receipt.cwd });
      receipt.result = { ...receipt.result, projection: { status: 'ready', value: await settings(receipt.cwd) } };
      return clone(receipt.result);
    },
    disposeExtensionMutationRecovery: async token => { calls.push({ method: 'disposeExtensionMutationRecovery', input: { token } }); receipts.delete(token); },
  }, { get(target, key) { return key in target ? target[key] : base[key]; } });
}

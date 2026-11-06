/** Synthetic cross-workspace file service. Never reads host files or opens apps. */
export function installPanelFilesFixture() {
  const base = window.piApi;
  const roots = { a: '/qa/synthetic/workspace-a', b: '/qa/synthetic/workspace-b' };
  const clone = value => JSON.parse(JSON.stringify(value));
  const calls = [], holds = new Set(), failures = new Set(), pending = new Map(), versions = new Map(), payloadChars = new Map(), listeners = new Set();
  const keyOf = (method, cwd, path = '') => JSON.stringify([method, cwd, path]);
  let serial = 0;
  const letter = cwd => cwd === roots.a ? 'A' : 'B';
  function body(cwd, path) { return `WORKSPACE ${letter(cwd)} · ${path} · version ${versions.get(keyOf('filePreview', cwd, path)) || 1}\n\nThis is isolated synthetic file content.\n原始工作区：${cwd}\n${path === 'shared.txt' ? Array.from({ length: 32 }, (_, index) => `预览滚动检查 ${index + 1}：内容保持在所属工作区。`).join('\n') : ''}`; }
  async function respond(method, cwd, path, value) {
    const key = keyOf(method, cwd, path), id = ++serial;
    calls.push({ id, method, cwd, path, ...(method === 'filePreview' ? { payloadChars: payloadChars.get(key) || 0 } : {}) });
    const response = clone(value);
    if (failures.delete(key)) throw new Error(`QA ${letter(cwd)} ${method} ${path || '/'} 读取失败`);
    if (holds.has(key)) await new Promise((resolve, reject) => pending.set(id, { resolve, reject, key, method, cwd, path }));
    return response;
  }
  const names = ['budget-large.txt', 'budget-0.txt', 'budget-1.txt', 'budget-2.txt', 'shared.txt', 'late.txt', 'closed.txt', 'reopen.txt', 'error.txt', ...Array.from({ length: 10 }, (_, i) => `cache-${i}.txt`)];
  const snapshot = async id => ({ ...(await base.conversationSnapshot(id)), cwd: roots[id === 'perf-0' ? 'a' : 'b'], title: id === 'perf-0' ? '文件会话 A' : '文件会话 B' });
  window.__panelFilesQa = {
    roots, calls,
    hold(method, owner, path = '') { holds.add(keyOf(method, roots[owner], path)); },
    unhold(method, owner, path = '') { holds.delete(keyOf(method, roots[owner], path)); },
    fail(method, owner, path = '') { failures.add(keyOf(method, roots[owner], path)); },
    payload(owner, path, chars) { payloadChars.set(keyOf('filePreview', roots[owner], path), chars); },
    version(owner, path, value) { versions.set(keyOf('filePreview', roots[owner], path), value); },
    pending() { return [...pending].map(([id, item]) => ({ id, method: item.method, cwd: item.cwd, path: item.path })); },
    release(id, reject = false) { const entry = pending.get(id); if (!entry) throw new Error(`No held request ${id}`); pending.delete(id); if (reject) entry.reject(new Error('QA delayed read failure')); else entry.resolve(); },
    open(owner) { for (const listener of listeners) listener({ id: owner === 'a' ? 'perf-0' : 'perf-1', cwd: roots[owner] }); },
  };
  localStorage.setItem('pi-studio:expanded-workspaces', JSON.stringify(Object.values(roots)));
  window.piApi = new Proxy({
    state: async () => {
      const value = await base.state(); const sessions = value.workspaces[0].sessions;
      return { ...value, workspaces: Object.entries(roots).map(([owner, cwd], index) => ({ cwd, name: `文件工作区 ${owner.toUpperCase()}`, sessions: [{ ...sessions[index], cwd, title: `文件会话 ${owner.toUpperCase()}` }] })) };
    },
    conversationPage: async input => ({ ...(await base.conversationPage(input)), ...(await snapshot(input.id)) }),
    conversationSnapshot: snapshot, subscribeConversation: snapshot,
    onOpenSession: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    files: async (cwd, path = '') => respond('files', cwd, path, {
      cwd, path,
      entries: path ? [{ name: `${letter(cwd)}-nested.txt`, path: `${path}/nested.txt`, type: 'file', size: 100 }] : [
        { name: `${letter(cwd)}-folder`, path: 'folder', type: 'directory', size: 0 },
        ...names.map(name => ({ name, path: name, type: 'file', size: 160 })),
      ],
    }),
    filePreview: async (cwd, path) => {
      const chars = payloadChars.get(keyOf('filePreview', cwd, path)) || 0;
      // Deliberately unused by the text renderer: exercise retained payload size
      // without decoding media or constructing a multi-megabyte text DOM.
      return respond('filePreview', cwd, path, {
        path, name: path.split('/').at(-1), size: 160, mimeType: 'text/plain', kind: 'text',
        text: chars ? `${body(cwd, path)}END OF COMPLETE ${letter(cwd)} ${path}` : body(cwd, path),
        ...(chars ? { dataUrl: `data:application/octet-stream;base64,${'A'.repeat(chars)}` } : {}),
      });
    },
    fileActions: async input => { calls.push({ id: ++serial, method: 'fileActions', ...clone(input) }); return { apps: [{ name: 'Synthetic Editor', path: '/qa/apps/editor' }] }; },
    openWith: async input => { calls.push({ id: ++serial, method: 'openWith', ...clone(input) }); return { ok: true }; },
    revealFile: async input => { calls.push({ id: ++serial, method: 'revealFile', ...clone(input) }); return { ok: true }; },
    runtimeServices: async () => ({ services: [], summary: { related: 0 } }),
    conversationSubmit: async () => { calls.push({ method: 'conversationSubmit' }); throw new Error('QA forbids model requests'); },
  }, { get(target, key) { return key in target ? target[key] : base[key]; } });
}

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PanelTabBar } from '../../../web/src/shell/right-panel/PanelTabBar';
import { TerminalPanel } from '../../../web/src/features/terminal/TerminalPanel';
import { BrowserPanel } from '../../../web/src/shell/right-panel/BrowserPanel';
import '../../../web/src/styles/tokens.css';
import '../../../web/src/styles/palette.css';
import '../../../web/src/app.css';
import '../../../web/src/shell/right-panel/right-panel.css';
const fixture = window as any;
fixture.__panelQa = { loads: [], additions: 0, removals: 0, navigations: [], terminalCreates: [], terminalResizes: [], terminalPending: [], terminalEvents: new Set(), terminalClosed: 0 };
fixture.piApi = {
  terminalCreate: (input: any) => { fixture.__panelQa.terminalCreates.push(input); return new Promise((resolve, reject) => fixture.__panelQa.terminalPending.push({ resolve, reject, input })); },
  terminalResize: async (...args: any[]) => { fixture.__panelQa.terminalResizes.push(args); },
  terminalWrite: async () => {},
  terminalClose: async () => { fixture.__panelQa.terminalClosed++; },
  onTerminalEvent: (listener: any) => { fixture.__panelQa.terminalEvents.add(listener); return () => fixture.__panelQa.terminalEvents.delete(listener); },
};
fixture.__panelQa.resolveTerminal = () => { const { resolve, input } = fixture.__panelQa.terminalPending.shift(); resolve({ id: input.id, cwd: input.cwd, title: 'QA terminal', shell: 'synthetic', status: 'running', sequence: 0, replay: { cols: input.cols, rows: input.rows, steps: [{ type: 'data', data: 'Synthetic terminal snapshot\r\n' }], truncated: false } }); };
fixture.__panelQa.rejectTerminal = () => fixture.__panelQa.terminalPending.shift().reject(new Error('QA synthetic connection failed'));
const originalAdd = HTMLElement.prototype.addEventListener;
const originalRemove = HTMLElement.prototype.removeEventListener;
HTMLElement.prototype.addEventListener = function(type: any, listener: any, options: any) { if (this.tagName === 'WEBVIEW') fixture.__panelQa.additions++; return originalAdd.call(this, type, listener, options); };
HTMLElement.prototype.removeEventListener = function(type: any, listener: any, options: any) { if (this.tagName === 'WEBVIEW') fixture.__panelQa.removals++; return originalRemove.call(this, type, listener, options); };
Object.assign(HTMLElement.prototype, { canGoBack() { return false; }, canGoForward() { return false; }, loadURL(url: string) { fixture.__panelQa.loads.push(url); return Promise.reject(new Error('synthetic load rejection')); }, reload() {}, goBack() {}, goForward() {} });
const noop = () => {};
function Fixture() {
  const [tabs, setTabs] = useState(Array.from({ length: 12 }, (_, index) => ({ id: `tab-${index}`, kind: 'file' as const, title: `file-${index}.md` })));
  const [activeId, setActive] = useState('tab-0'); const [width, setWidth] = useState(440); const [, rerender] = useState(0);
  const [terminal, setTerminal] = useState(false);
  const [browser, setBrowser] = useState(true); const [url, setUrl] = useState('http://127.0.0.1:9999/initial');
  fixture.__panelQa.setUrl = setUrl;
  return <main><button onClick={() => rerender(value => value + 1)}>刷新父组件</button><button onClick={() => setWidth(600)}>扩大标签栏</button><button onClick={() => setBrowser(value => !value)}>切换浏览器挂载</button><input aria-label="其他输入" /><button onClick={() => setTerminal(value => !value)}>切换终端挂载</button>
    <div style={{ width }}><PanelTabBar tabs={tabs} activeId={activeId} workspaceName="QA" fullscreen={false} split={false} resizing={false}
      toolActions={[{ id: 'files', label: '文件', onSelect: noop }, { id: 'terminal', label: '终端', disabled: true, onSelect: noop }, { id: 'browser', label: '浏览器', onSelect: noop }]}
      onActivate={tab => setActive(tab.id)} onClose={id => setTabs(items => items.filter(item => item.id !== id))} onReorder={noop} onContextMenu={noop} onToggleSplit={noop} onToggleFullscreen={noop} onCollapse={noop} onMakeDragPreview={noop} onClearDragPreview={noop} /></div>
    {terminal && <div style={{ width: 600, height: 300 }}><TerminalPanel id="qa-terminal" cwd="/qa/synthetic" onNewTerminal={noop} /></div>}
    {browser && <div style={{ width: 600, height: 300 }}><BrowserPanel url={url} onUrlChange={next => fixture.__panelQa.navigations.push(next)} /></div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

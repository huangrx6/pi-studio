import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalPanel } from '../../../web/src/features/terminal/TerminalPanel';
import { BrowserPanel } from '../../../web/src/features/browser/BrowserPanel';
import '../../../web/src/styles/tokens.css';
import '../../../web/src/styles/palette.css';
import '../../../web/src/styles/app.css';
const fixture = window as any;
fixture.__panelQa = { loads: [], additions: 0, removals: 0, navigations: [], terminalCreates: [], terminalResizes: [], terminalPending: [], terminalEvents: new Set(), terminalClosed: 0 };
fixture.piApi = {
  terminalCreate: (input: any) => { fixture.__panelQa.terminalCreates.push(input); return new Promise((resolve, reject) => fixture.__panelQa.terminalPending.push({ resolve, reject, input })); },
  onBrowserCommand: () => () => {}, onBrowserEvent: () => () => {},
  browserControlState: async () => ({}), browserTabRegister: async () => ({}), browserTabUpdate: async () => ({}), browserTabUnregister: async () => true,
  browserExternalSessions: async () => ({sessions:[]}), browserAdvancedSettings: async () => ({showFullUrl:true}), browserDownloads: async () => ({downloads:[]}), browserSitePolicies: async () => ({policies:[]}),
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
Object.assign(HTMLElement.prototype, { getWebContentsId() { return 123; }, canGoBack() { return false; }, canGoForward() { return false; }, loadURL(url: string) { fixture.__panelQa.loads.push(url); return Promise.reject(new Error('synthetic load rejection')); }, reload() {}, goBack() {}, goForward() {} });
const noop = () => {};
function Fixture() {
  const [, rerender] = useState(0);
  const [terminal, setTerminal] = useState(false);
  const [browser, setBrowser] = useState(true); const [url, setUrl] = useState('http://127.0.0.1:9999/initial');
  fixture.__panelQa.setUrl = setUrl;
  return <main><button onClick={() => rerender(value => value + 1)}>刷新父组件</button><button onClick={() => setBrowser(value => !value)}>切换浏览器挂载</button><input aria-label="其他输入" /><button onClick={() => setTerminal(value => !value)}>切换终端挂载</button>
    {terminal && <div style={{ width: 600, height: 300 }}><TerminalPanel id="qa-terminal" cwd="/qa/synthetic" appearance={{fontSize: 12, fontFamily: "", lineHeight: 1.25, cursorStyle: "bar", themeId:"studio"}} shellIntegration={false} onFontSizeChange={noop} onNewTerminal={noop} /></div>}
    {browser && <div style={{ width: 600, height: 300 }}><BrowserPanel id="fixture-browser" visible onNewTab={() => {}} url={url} onUrlChange={next => fixture.__panelQa.navigations.push(next)} /></div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

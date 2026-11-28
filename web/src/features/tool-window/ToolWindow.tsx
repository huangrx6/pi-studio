import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type Ref } from 'react';
import { AppWindow, Globe, House, Maximize2, Minus, Minimize2, Plus, SquareTerminal } from 'lucide-react';
import { ActionMenu, type MenuAction } from '../../shared/ActionMenu';
import { TabActionsButton } from '../../shared/ScrollableTabList';
import { tabCloseActions } from '../../shared/tab-close-actions';
import { desktopPlatform } from '../../shared/desktop-platform';
import { trackDismissFocus } from '../../shared/keyboard-navigation';
import { useSettingsToast } from '../../shared/SettingsToast';
import { errorText } from '../../shared/error-text';
import { SurfaceActiveContext } from '../../shared/surface-visibility';
import { applyWindowAppearance, loadPreferences, savePreferences, setActivePreferences, type Preferences } from '../../shared/preferences';
import type { ToolTab, ToolWindowCommand, ToolWindowGroup, ToolWindowState } from '../../types/tool-window';
import type { ExtensionUiSnapshot } from '../../types/extension-types';
import { useExtensionUiSnapshot } from '../extensions/use-extension-ui';
import type { ExtensionNotice } from '../extensions/ExtensionSlot';
import { ToolWindowFrame } from './ToolWindowFrame';
import { ToolTabList } from './ToolTabList';
import './styles/tool-window.css';

const TerminalPanel = lazy(() => import('../terminal/TerminalPanel').then(module => ({ default: module.TerminalPanel })));
const BrowserPanel = lazy(() => import('../browser/BrowserPanel').then(module => ({ default: module.BrowserPanel })));
const ExtensionSlot = lazy(() => import('../extensions/ExtensionSlot').then(module => ({ default: module.ExtensionSlot })));
const ExtensionViewPanel = lazy(() => import('../extensions/ExtensionViewPanel').then(module => ({ default: module.ExtensionViewPanel })));
const isMac = desktopPlatform() === 'darwin';

function Shortcut({ keys }: { keys: string[] }) {
  return <span className="tool-shortcut" aria-hidden="true">
    {keys.map(key => <kbd key={key}>{key}</kbd>)}
  </span>;
}

type WindowPreferences = {
  preferences: Preferences;
  onFontSizeChange: (size: number) => void;
};
type ToolMenu = { kind: 'add'; anchor: HTMLButtonElement } | { kind: 'tabs'; anchor: HTMLButtonElement; tabId: string };

export function ToolWindow() {
  const [state, setState] = useState<ToolWindowState>();
  const [preferences, setPreferences] = useState(loadPreferences);
  const toast = useSettingsToast();
  useEffect(trackDismissFocus, []);
  useEffect(() => {
    let live = true;
    let received = false;
    const off = window.toolWindowApi.onState(next => { received = true; setState(next); });
    void window.toolWindowApi.state().then(next => { if (live && !received) setState(next); })
      .catch(error => { if (live) toast(errorText(error), 'error'); });
    const refresh = () => setPreferences(loadPreferences());
    window.addEventListener('storage', refresh);
    return () => { live = false; off(); window.removeEventListener('storage', refresh); };
  }, [toast]);
  useEffect(() => {
    setActivePreferences(preferences);
    const apply = () => applyWindowAppearance(preferences);
    apply();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preferences]);
  const onFontSizeChange = useCallback((size: number) => {
    const next = { ...loadPreferences(), terminalFontSize: size };
    if (!savePreferences(next)) toast('终端字号保存失败', 'error');
    setPreferences(next);
  }, [toast]);
  return <ToolWindowFrame>{state?.groups.map(group =>
    <ToolGroup key={group.mountId} group={group} selected={group.context.key === state.key}
      visible={state.visible} maximized={state.maximized} preferences={preferences} onFontSizeChange={onFontSizeChange} />
  )}</ToolWindowFrame>;
}

function ToolGroup({ group, selected, visible, maximized, ...appearance }: WindowPreferences & {
  group: ToolWindowGroup; selected: boolean; visible: boolean; maximized: boolean;
}) {
  const { tabs, active, context } = group;
  const [menu, setMenu] = useState<ToolMenu | null>(null);
  const tabMenuButton = useRef<HTMLButtonElement>(null);
  const tabMenuExpanded = menu?.kind === 'tabs' && menu.anchor === tabMenuButton.current;
  const menuId = useId();
  const focusTerminal = useRef<() => void>(() => {});
  const returnTab = useRef('');
  const toast = useSettingsToast();
  const shown = selected && visible;
  const { snapshot } = useExtensionUiSnapshot(context.cwd, shown || tabs.some(tab => tab.kind === 'extension'));
  const command = useCallback((value: ToolWindowCommand) => {
    void window.toolWindowApi.command(context.key, value).catch(error => toast(errorText(error), 'error'));
  }, [context.key, toast]);
  useEffect(() => { setMenu(null); }, [active, shown, tabs.length]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, [menu]);
  useEffect(() => {
    if (!selected) return;
    document.title = context.title + ' · 工具面板';
  }, [context.title, selected]);
  useEffect(() => {
    if (!selected || !visible) return;
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
      if (event.key !== 'Escape') return;
      if (active && event.target instanceof Element &&
        (event.target.closest('.xterm, input, textarea, [contenteditable="true"]') || document.querySelector('.tool-content:not([hidden]) .browser-popover'))) return;
      if (!active && tabs.some(tab => tab.id === returnTab.current)) command({ kind: 'activate', id: returnTab.current });
      else command({ kind: 'hide' });
      event.preventDefault();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [active, command, selected, tabs, visible]);

  const tools: MenuAction[] = [
    { id: 'terminal', label: '新终端', icon: SquareTerminal, shortcut: [isMac ? '⌘' : 'Ctrl', 'T'],
      run: () => command({ kind: 'open', request: { kind: 'terminal' } }) },
    { id: 'browser', label: '新浏览器标签页', icon: Globe, shortcut: [isMac ? '⌘' : 'Ctrl', isMac ? '⇧' : 'Shift', 'B'],
      run: () => command({ kind: 'open', request: { kind: 'browser' } }) },
    ...snapshot.items.filter(item => item.slot === 'tool.view' && (item.view?.scope !== 'session' || context.sessionId))
      .map(item => ({ id: item.id, label: item.title, icon: AppWindow, iconUrl: item.iconDataUrl,
        run: () => command({ kind: 'open', request: { kind: 'extension', panelId: item.id, title: item.title } }) })),
  ];
  const tabActions = menu?.kind === 'tabs' ? tabCloseActions(tabs, menu.tabId,
    (ids, keepId) => command({ kind: 'close-tabs', ids, keepId })) : [];
  return <section className="tool-group" hidden={!selected} aria-label={context.title} data-menu-open={menu ? true : undefined}>
    <header className="tool-tabs" data-tool-drag={maximized ? undefined : 'move'}
      onDoubleClick={event => { if (!(event.target as Element).closest('button, .tool-tab')) command({ kind: 'maximize' }); }}>
      <ToolTabList tabs={tabs} active={active} visible={shown} onClose={id => command({ kind: 'close', id })}
        onMenu={(tabId, anchor) => setMenu({ kind: 'tabs', tabId, anchor })}
        onSelect={tab => {
          if (tab.kind === 'terminal' && active === tab.id) focusTerminal.current?.();
          command({ kind: 'activate', id: tab.id });
        }} />
      {tabs.length > 1 && <TabActionsButton buttonRef={tabMenuButton} expanded={tabMenuExpanded} menuId={menuId}
        onOpen={anchor => setMenu({ kind: 'tabs', tabId: active, anchor })} onClose={() => setMenu(null)} />}
      <button type="button" className="icon-button" title="新建工具标签页" aria-label="新建工具标签页" aria-haspopup="menu"
        aria-expanded={menu?.kind === 'add'} aria-controls={menu?.kind === 'add' ? menuId : undefined}
        onClick={event => setMenu(menu?.kind === 'add' ? null : { kind: 'add', anchor: event.currentTarget })}
        onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setMenu({ kind: 'add', anchor: event.currentTarget }); } }}><Plus/></button>
      {shown && menu && <ActionMenu id={menuId} className={menu.kind === 'tabs' ? 'tool-tabs-menu tab-close-menu' : 'tool-tabs-menu'} placement="below" anchor={menu.anchor}
        label={menu.kind === 'add' ? '新建工具标签页' : '标签页操作'} onClose={() => setMenu(null)} items={menu.kind === 'tabs' ? tabActions : [...tools, {
          id: 'start', label: '打开起始页', icon: House, dividerBefore: true,
          run: () => { if (active) returnTab.current = active; command({ kind: 'start' }); },
        }]} />}
      <div className="tool-window-controls">
        <button className="icon-button" title={maximized ? '还原面板大小' : '放大工具面板'} aria-pressed={maximized}
          onClick={() => command({ kind: 'maximize' })}>{maximized ? <Minimize2/> : <Maximize2/>}</button>
        <button className="icon-button" title="收起工具面板" aria-label="收起工具面板" onClick={() => command({ kind: 'hide' })}><Minus/></button>
      </div>
    </header>
    {!active && <section className="tool-picker" aria-label="工具起始页">
      <div className="tool-picker-list">
        {tools.map(({ id, label, icon: Icon, iconUrl, shortcut, run }) => <button key={id} onClick={run}>
          {iconUrl ? <img src={iconUrl} alt=""/> : Icon && <Icon/>}{label}{shortcut && <Shortcut keys={shortcut}/>}
        </button>)}
        <button onClick={() => command({ kind: 'hide' })}><Minus/>收起面板<Shortcut keys={[isMac ? '⌘' : 'Ctrl', 'W']}/></button>
      </div>
    </section>}
    {tabs.map(tab => <ToolContent key={tab.id} tab={tab} context={context} snapshot={snapshot}
      active={shown && active === tab.id} command={command} focusTerminal={focusTerminal} {...appearance}/>)}
  </section>;
}

function ToolContent({ context, tab, snapshot, active, command, preferences: p, onFontSizeChange, focusTerminal }: WindowPreferences & {
  context: ToolWindowGroup['context']; tab: ToolTab; snapshot: ExtensionUiSnapshot; focusTerminal: Ref<() => void>;
  active: boolean; command: (value: ToolWindowCommand) => void;
}) {
  const visited = useRef(false);
  useEffect(() => { if (active || tab.loadGuest) visited.current = true; }, [active, tab.loadGuest]);
  const toast = useSettingsToast();
  const title = useCallback((title: string) => command({ kind: 'update', id: tab.id, title }), [command, tab.id]);
  const url = useCallback((url: string) => command({ kind: 'update', id: tab.id, url }), [command, tab.id]);
  const acknowledged = useCallback((requestId: string) => command({ kind: 'update', id: tab.id, acknowledged: requestId }), [command, tab.id]);
  const close = () => command({ kind: 'close', id: tab.id });
  const browser = (url?: string) => command({ kind: 'open', request: { kind: 'browser', url } });
  const notify = (notice: ExtensionNotice) => toast(notice.message, notice.tone === 'error' ? 'error' : notice.tone === 'success' ? 'success' : 'info');
  const prompt = (text: string, submit: boolean) => command({ kind: 'action', action: { kind: 'prompt', text, submit } });
  const panel = tab.kind === 'extension' ? snapshot.items.find(item => item.slot === 'tool.view' && item.id === tab.panelId) : undefined;
  useEffect(() => { if (panel?.title) title(panel.title); }, [panel?.title, title]);
  if (!visited.current && !active && !tab.loadGuest) return null;
  return <div className="tool-content" hidden={!active}>
    <SurfaceActiveContext.Provider value={active}><Suspense fallback={<div className="tool-message" role="status">正在打开工具…</div>}>
      {tab.kind === 'terminal' && <TerminalPanel id={tab.id} cwd={context.cwd || ''} active={active} focusRef={active ? focusTerminal : undefined} onTitle={title}
        appearance={{ fontSize: p.terminalFontSize, fontFamily: p.terminalFontFamily, lineHeight: p.terminalLineHeight,
          cursorStyle: p.terminalCursorStyle, themeId: p.terminalTheme }}
        shellIntegration={p.terminalShellIntegration} onFontSizeChange={onFontSizeChange}
        onNewTerminal={() => command({ kind: 'open', request: { kind: 'terminal' } })}
        onRestartTerminal={() => command({ kind: 'restart', id: tab.id })}
        onOpenFile={path => command({ kind: 'action', action: { kind: 'file', path } })} onOpenUrl={browser}/>}
      {tab.kind === 'browser' && <BrowserPanel id={tab.id} url={tab.url || 'about:blank'} visible={active}
        onTitleChange={title} onUrlChange={url} onNewTab={browser} onClose={close}
        libraryRequest={tab.libraryRequest} onLibraryOpened={acknowledged}/>}
      {tab.kind === 'extension' && (panel?.view ? <ExtensionViewPanel view={panel.view} title={panel.title}
        cwd={context.cwd} sessionId={context.sessionId} workspaces={context.workspaces || []} generation={snapshot.syncedAt}
        onSendPrompt={prompt} onNotify={notify} onClose={close}
        onOpenTemporaryChat={options => command({ kind: 'action', action: { kind: 'temporary', options: options || {} } })}/>
        : panel ? <ExtensionSlot slot="tool.view" snapshot={snapshot} selectedItemId={panel.id} cwd={context.cwd}
          sessionId={context.sessionId} presentation="page" onSendPrompt={prompt} onNotify={notify}
          onOpenSettings={page => command({ kind: 'action', action: { kind: 'settings', page: page || 'extensions' } })}
          onOpenPanel={panelId => {
            const detail = snapshot.items.find(item => item.id === panelId && item.slot === 'status.detail');
            command(detail ? { kind: 'status-detail', panelId } : { kind: 'open', request: { kind: 'extension', panelId } });
          }}/>
          : <div className="tool-message" role="status">{snapshot.syncedAt ? '此插件在当前会话中不可用' : '正在读取插件…'}</div>)}
    </Suspense></SurfaceActiveContext.Provider>
  </div>;
}

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, ChevronUp, LoaderCircle } from 'lucide-react';
import { thinkingLabels, type ModelCatalog, type ModelOption, type ModelSelection, type ThinkingLevel } from '../model-types';

type View = 'main' | 'models' | 'thinking';

export function ModelPicker({ selection, disabled, hidden, loadCatalog, onSelectModel, onSelectThinking, onManage }: {
  selection: ModelSelection;
  disabled: boolean;
  hidden: boolean;
  loadCatalog: () => Promise<ModelCatalog>;
  onSelectModel: (id: string) => Promise<void>;
  onSelectThinking: (level: ThinkingLevel) => Promise<void>;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('main');
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placement, setPlacement] = useState({ below: false, height: 420 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const panelId = useId();
  const supportsThinking = selection.thinkingLevels.length > 1;

  function close(restoreFocus = true) {
    requestRef.current += 1;
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  async function show() {
    if (open) { close(); return; }
    setOpen(true); setView('main'); setQuery(''); setError(null); setLoading(true);
    const request = ++requestRef.current;
    try {
      const next = await loadCatalog();
      if (request === requestRef.current) setCatalog(next);
    } catch (error) {
      if (request === requestRef.current) setError(error instanceof Error ? error.message : String(error));
    } finally { if (request === requestRef.current) setLoading(false); }
  }

  async function choose(action: () => Promise<void>) {
    if (saving) return;
    setSaving(true); setError(null);
    try { await action(); close(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  useEffect(() => { if (hidden || disabled) { setOpen(false); requestRef.current += 1; } }, [hidden, disabled]);
  useEffect(() => () => { requestRef.current += 1; }, []);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const above = rect.top - 20;
      const below = window.innerHeight - rect.bottom - 20;
      const useBelow = above < 300 && below > above;
      setPlacement({ below: useBelow, height: Math.min(480, useBelow ? below : above) });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open, view]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      const target = view === 'models' ? panel?.querySelector<HTMLInputElement>('input') : panel?.querySelector<HTMLButtonElement>('[aria-checked="true"], button:not(:disabled)');
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, view]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (view === 'main') close(); else { setView('main'); setError(null); }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement && ['Home', 'End'].includes(event.key)) return;
    const items = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  const enabled = catalog?.enabled ?? [];
  const options = (catalog?.models ?? []).filter((item) => (!enabled.length || enabled.includes(item.id) || item.id === selection.modelRef)
    && `${item.name} ${item.id} ${item.providerName}`.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = new Map<string, { name: string; models: ModelOption[] }>();
  for (const model of options) {
    const group = groups.get(model.provider) ?? { name: model.providerName || model.provider, models: [] };
    group.models.push(model); groups.set(model.provider, group);
  }

  return <div className="model-control" ref={rootRef} onBlur={(event) => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) close(false);
  }}>
    <button ref={triggerRef} className={`model-label ${open ? 'is-active' : ''}`} disabled={disabled || hidden} aria-label="模型与推理设置" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} title={`${selection.label} · ${selection.modelRef}`} onClick={() => void show()}>
      <span>{selection.label || '选择模型'}</span>{supportsThinking && <span className="thinking-label">{thinkingLabels[selection.thinkingLevel]}</span>}<ChevronUp className={open ? 'is-open' : ''} />
    </button>
    {open && <div ref={panelRef} id={panelId} className={`model-popover model-popover--${view} ${placement.below ? 'is-below' : ''}`} style={{ maxHeight: placement.height }} role="dialog" aria-label={view === 'main' ? '模型与推理设置' : view === 'models' ? '选择模型' : '推理等级'} aria-busy={saving} onKeyDown={onKeyDown}>
      {view === 'main' && <div role="menu" aria-label="模型设置">
        <button className="model-menu-row" role="menuitem" disabled={saving} onClick={() => setView('models')}><span>模型</span><span className="menu-value">{selection.label || '选择模型'}</span><ChevronRight /></button>
        <button className="model-menu-row" role="menuitem" disabled={saving || loading || !supportsThinking} title={!supportsThinking ? '此模型不支持调整推理等级' : undefined} onClick={() => setView('thinking')}><span>推理等级</span><span className="menu-value">{supportsThinking ? thinkingLabels[selection.thinkingLevel] : '不支持'}</span><ChevronRight /></button>
      </div>}
      {view === 'models' && <>
        <div className="model-search-bar"><button className="icon-button" aria-label="返回模型设置" onClick={() => setView('main')}><ChevronLeft /></button><input aria-label="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型…" /></div>
        <div className="model-list" role="menu" aria-label="常用模型">
          {loading ? <div className="model-picker-note" role="status"><LoaderCircle className="spin" />正在读取模型…</div> : [...groups].map(([provider, group]) => <div className="model-group" role="group" aria-label={group.name} key={provider}>
            <div className="model-group-name" title={provider}>{group.name}</div>
            {group.models.map((item) => <button role="menuitemradio" aria-checked={item.id === selection.modelRef} disabled={saving} key={item.id} title={item.id} className={`model-option ${item.id === selection.modelRef ? 'is-selected' : ''}`} onClick={() => void choose(() => onSelectModel(item.id))}><span>{item.name}</span>{item.id === selection.modelRef && <Check />}</button>)}
          </div>)}
          {!loading && !options.length && <div className="model-picker-note">{query ? '没有匹配的模型' : '暂无可用模型，请在设置中配置来源。'}</div>}
        </div>
        <button className="model-manage" onClick={() => { close(false); onManage(); }}>管理常用模型<ChevronRight /></button>
      </>}
      {view === 'thinking' && <>
        <div className="model-list" role="menu" aria-label="推理等级">
          {selection.thinkingLevels.map((level) => <button key={level} role="menuitemradio" aria-checked={selection.thinkingLevel === level} disabled={saving} className={`model-option ${selection.thinkingLevel === level ? 'is-selected' : ''}`} onClick={() => void choose(() => onSelectThinking(level))}><span>{thinkingLabels[level]}</span>{selection.thinkingLevel === level && <Check />}</button>)}
        </div>
        <div className="model-picker-footnote">Default 跟随 Pi 配置，当前为 {thinkingLabels[selection.defaultThinkingLevel]}。</div>
      </>}
      {error && <div className="model-picker-error" role="alert">{error}</div>}
      {saving && <div className="model-picker-note" role="status">正在应用…</div>}
    </div>}
  </div>;
}

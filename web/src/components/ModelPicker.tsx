/**
 * 模型与推理等级选择器（输入框下方的模型胶囊）。
 *
 * 三层视图共用一个小浮层：
 * - main：入口菜单（模型 / 推理等级）；
 * - models：搜索 + 按来源分组的模型列表；
 * - thinking：该模型可选的推理等级。
 *
 * 数据与写入都通过 props 交给 App：打开时调用 loadCatalog()（内部是
 * `piApi.models`），选择后调用 onSelectModel / onSelectThinking（内部是
 * `piApi.setModel` / `piApi.setThinkingLevel`），本组件不直接碰 IPC。
 *
 * 两个容易出问题的点：
 * - 请求竞态：快速开关或切换视图时旧请求可能后返回，用 requestRef 序号丢弃过期结果；
 * - 弹出方向：浮层默认在按钮上方展开，靠近窗口顶部时切换为向下并限制高度。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, ChevronUp, LoaderCircle, TriangleAlert } from 'lucide-react';
import { thinkingLabels, type ModelCatalog, type ModelOption, type ModelSelection, type ThinkingLevel } from '../types/model-types';

/** 浮层当前显示的视图。 */
type View = 'main' | 'models' | 'thinking';

/** App 通过斜杠命令请求选择器直接打开某个子视图。 */
export type ModelPickerRequest = {
  /** 单调递增；相同请求不会重复打开。 */
  id: number;
  /** 要直接进入的视图。 */
  view: Exclude<View, 'main'>;
};

/**
 * 模型选择器。
 *
 * @param selection 当前模型与推理等级快照（由主进程返回）
 * @param disabled 会话运行中或状态加载中时禁用
 * @param hidden 设置面板打开时隐藏（避免两个浮层叠加）
 * @param loadCatalog 读取模型目录；打开面板时调用
 * @param onSelectModel 应用模型，返回 Promise 以便展示保存中/失败
 * @param onSelectThinking 应用推理等级
 * @param onManage 跳转到设置里的模型管理页
 * @param request 斜杠命令发起的外部打开请求
 * @param onRequestHandled 请求已被组件接收后通知 App 清空
 */
export function ModelPicker({ selection, scope, disabled, hidden, loadCatalog, onSelectModel, onSelectThinking, onManage, request = null, onRequestHandled }: {
  selection: ModelSelection;
  /** 当前选择属于一条历史会话，还是新对话的全局默认。 */
  scope: 'session' | 'default';
  disabled: boolean;
  hidden: boolean;
  loadCatalog: () => Promise<ModelCatalog>;
  onSelectModel: (id: string) => Promise<void>;
  onSelectThinking: (level: ThinkingLevel) => Promise<void>;
  onManage: () => void;
  request?: ModelPickerRequest | null;
  onRequestHandled?: () => void;
}) {
  // 会话恢复与模型目录加载可能短暂交错。选择器必须始终能渲染触发按钮，
  // 不能因一个不完整的 IPC 快照让整个会话页面白屏。
  if (!selection || !Array.isArray(selection.thinkingLevels)) {
    selection = {
      modelRef: '',
      label: '加载模型…',
      thinkingLevel: 'default',
      thinkingLevels: ['default'],
      effectiveThinkingLevel: 'off',
      defaultThinkingLevel: 'off',
    };
  }
  /** 浮层是否打开。 */
  const [open, setOpen] = useState(false);
  /** 当前视图；每次打开都回到 main。 */
  const [view, setView] = useState<View>('main');
  /** 模型目录；null 表示还没加载过。 */
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  /** 模型搜索关键字。 */
  const [query, setQuery] = useState('');
  /** 正在读取目录。 */
  const [loading, setLoading] = useState(false);
  /** 正在把选择写回主进程；期间禁用选项防止连点。 */
  const [saving, setSaving] = useState(false);
  /** 读取或保存失败的信息，显示在浮层底部。 */
  const [error, setError] = useState<string | null>(null);
  /** 浮层展开方向与最大高度（见下方 placement effect）。 */
  const [placement, setPlacement] = useState({ below: false, height: 420 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /**
   * 请求序号。每次打开/关闭/失焦都会自增：异步回调只有在序号仍然相等时
   * 才允许写状态，从而丢弃“打开又关闭后旧目录才返回”这类过期结果。
   */
  const requestRef = useRef(0);
  /** 斜杠命令请求只处理一次；App 清理状态前可能还有一帧重渲染。 */
  const handledRequestRef = useRef(0);
  const panelId = useId();
  const supportsThinking = selection.thinkingLevels.length > 1;
  const scopeTitle = scope === 'session' ? '当前会话模型' : '新对话默认模型';
  const scopeHint = selection.pending
    ? '已排到下一轮；当前回复继续使用原模型'
    : scope === 'session'
      ? '只修改这条会话，不会改动新对话默认值'
      : '修改后会应用到之后创建的新对话';

  /**
   * 关闭浮层。
   * requestRef 自增让进行中的 loadCatalog 结果失效；restoreFocus 默认归还焦点，
   * 但点击外部关闭时应传 false，避免把焦点从用户刚点的控件抢回来。
   */
  function close(restoreFocus = true) {
    requestRef.current += 1;
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  /**
   * 从指定视图打开并异步加载目录。
   * 先记下本次请求序号，await 后只有仍是最新请求才写入 catalog / loading / error。
   */
  async function openAt(nextView: View) {
    setOpen(true); setView(nextView); setQuery(''); setError(null); setLoading(true);
    const request = ++requestRef.current;
    try {
      const next = await loadCatalog();
      if (request === requestRef.current) setCatalog(next);
    } catch (error) {
      if (request === requestRef.current) setError(error instanceof Error ? error.message : String(error));
    } finally { if (request === requestRef.current) setLoading(false); }
  }

  /** 点击底部模型胶囊：已打开则关闭，否则从主视图打开。 */
  async function show() {
    if (open) { close(); return; }
    await openAt('main');
  }

  /**
   * 执行一次保存动作（选模型或选等级）。
   * saving 期间忽略重复点击；成功后关闭浮层，失败则保留浮层并展示错误，
   * 让用户能直接换一个模型重试。
   */
  async function choose(action: () => Promise<void>) {
    if (saving) return;
    setSaving(true); setError(null);
    try { await action(); close(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  // 外部弹窗打开或控件被禁用时强制收起，并作废仍在飞行中的目录请求。
  useEffect(() => { if (hidden || disabled) { setOpen(false); requestRef.current += 1; } }, [hidden, disabled]);
  // `/model`、`/thinking` 与菜单点击共用这个入口，避免命令再跳去设置页。
  useEffect(() => {
    if (!request || handledRequestRef.current === request.id) return;
    handledRequestRef.current = request.id;
    if (disabled || hidden) {
      onRequestHandled?.();
      return;
    }
    void openAt(request.view).finally(() => onRequestHandled?.());
  }, [request?.id, disabled, hidden]);
  // 卸载时同样作废请求，避免对已卸载组件 setState。
  useEffect(() => () => { requestRef.current += 1; }, []);
  // 点击浮层与触发按钮之外关闭；不抢焦点（false），尊重用户的新点击目标。
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  // 计算展开方向：above/below 是触发按钮上方/下方的可用高度（各留 20px 边距）。
  // 浮层默认样式在按钮上方；只有上方明显不够（< 300）且下方更宽裕时才向下，
  // 高度取可用空间并封顶 480，确保面板始终留在视口内。
  // 依赖 view 是因为切换视图会改变面板内容高度，需要重新评估。
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

  // 打开或切换视图后聚焦：模型页聚焦搜索框方便直接输入；
  // 其他页优先当前勾选项，没有则第一个可用按钮。等一帧等浮层挂载。
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      const target = view === 'models' ? panel?.querySelector<HTMLInputElement>('input') : panel?.querySelector<HTMLButtonElement>('[aria-checked="true"], button:not(:disabled)');
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, view]);

  /**
   * 浮层键盘处理：
   * - Esc：主视图直接关闭，子视图先返回主视图（符合层级返回预期）；
   * - 上下/Home/End：只在 menuitem 之间循环；输入框里的 Home/End 留给光标移动。
   */
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

  // 启用的模型通常才展示，但当前选中项必须始终保留：
  // 否则用户改过启用列表后，当前模型会从选择器里“消失”。
  const enabled = catalog?.enabled ?? [];
  const options = (catalog?.models ?? []).filter((item) => (!enabled.length || enabled.includes(item.id) || item.id === selection.modelRef)
    && `${item.name} ${item.id} ${item.providerName}`.toLowerCase().includes(query.trim().toLowerCase()));
  // 按 provider 分组；Map 保留模型目录中的首次出现顺序，不额外排序。
  const groups = new Map<string, { name: string; models: ModelOption[] }>();
  for (const model of options) {
    const group = groups.get(model.provider) ?? { name: model.providerName || model.provider, models: [] };
    group.models.push(model); groups.set(model.provider, group);
  }

  // onBlur 兜底键盘 Tab 离开：焦点移出整个控件时关闭（鼠标点击已由 pointerdown 处理）。
  return <div className="model-control" ref={rootRef} onBlur={(event) => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) close(false);
  }}>
    {/* 触发按钮：title 展示“模型 · modelRef”，支持推理时额外显示当前等级。 */}
    <button ref={triggerRef} className={`model-label ${open ? 'is-active' : ''} ${selection.pending ? 'is-pending' : ''} ${selection.unavailable ? 'is-unavailable' : ''}`} disabled={disabled || hidden} aria-label={selection.pending ? `${scopeTitle}，下一轮生效` : scopeTitle} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} title={`${scopeTitle}：${selection.label} · ${selection.modelRef}${selection.pending ? ' · 下一轮生效' : ''}`} onClick={() => void show()}>
      {selection.unavailable && <TriangleAlert aria-hidden="true" />}<span>{selection.label || '选择模型'}</span>{selection.pending && <span className="model-pending-label">下轮生效</span>}{supportsThinking && <span className="thinking-label">{thinkingLabels[selection.thinkingLevel]}</span>}<ChevronUp className={open ? 'is-open' : ''} />
    </button>
    {/* 浮层方向由 is-below 切换，maxHeight 为上方/下方可用空间的较小值。 */}
    {open && <div ref={panelRef} id={panelId} className={`model-popover model-popover--${view} ${placement.below ? 'is-below' : ''}`} style={{ maxHeight: placement.height }} role="dialog" aria-label={view === 'main' ? '模型与推理设置' : view === 'models' ? '选择模型' : '推理等级'} aria-busy={saving} onKeyDown={onKeyDown}>
      {/* 主菜单：模型页加载中也允许进入；推理页要求模型支持多等级。 */}
      {view === 'main' && <div role="menu" aria-label="模型设置">
        <div className={`model-picker-scope ${selection.pending ? 'is-pending' : ''} ${selection.unavailable ? 'is-unavailable' : ''}`}><strong>{scopeTitle}</strong><small>{scopeHint}</small></div>
        {selection.unavailable && <div className="model-picker-warning" role="alert"><TriangleAlert />{selection.unavailableReason || '这个会话原来的模型已不可用，请重新选择。'}</div>}
        <button className="model-menu-row" role="menuitem" disabled={saving} onClick={() => setView('models')}><span>{scope === 'session' ? '切换会话模型' : '修改默认模型'}</span><span className="menu-value">{selection.label || '选择模型'}</span><ChevronRight /></button>
        <button className="model-menu-row" role="menuitem" disabled={saving || loading || !supportsThinking} title={!supportsThinking ? '此模型不支持调整推理等级' : undefined} onClick={() => setView('thinking')}><span>{scope === 'session' ? '会话思考强度' : '默认思考强度'}</span><span className="menu-value">{supportsThinking ? thinkingLabels[selection.thinkingLevel] : '不支持'}</span><ChevronRight /></button>
      </div>}
      {/* 模型页：搜索 + 按来源分组；loading 期间列表整体替换为状态行。 */}
      {view === 'models' && <>
        <div className="model-search-bar"><button className="icon-button" aria-label="返回模型设置" onClick={() => setView('main')}><ChevronLeft /></button><input aria-label="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型…" /></div>
        <div className="model-list" role="menu" aria-label="常用模型">
          {loading ? <div className="model-picker-note" role="status"><LoaderCircle className="spin" />正在读取模型…</div> : [...groups].map(([provider, group]) => <div className="model-group" role="group" aria-label={group.name} key={provider}>
            <div className="model-group-name" title={provider}>{group.name}</div>
            {group.models.map((item) => <button role="menuitemradio" aria-checked={item.id === selection.modelRef} disabled={saving} key={item.id} title={item.id} className={`model-option ${item.id === selection.modelRef ? 'is-selected' : ''}`} onClick={() => void choose(() => onSelectModel(item.id))}><span>{item.name}</span>{item.id === selection.modelRef && <Check />}</button>)}
          </div>)}
          {!loading && !options.length && <div className="model-picker-note">{query ? '没有匹配的模型' : '暂无可用模型，请在设置中配置来源。'}</div>}
        </div>
        {/* 管理入口：先关闭浮层（不归还焦点），再打开设置面板的模型页。 */}
        <button className="model-manage" onClick={() => { close(false); onManage(); }}>管理常用模型<ChevronRight /></button>
      </>}
      {/* 推理等级：只展示当前模型允许的等级，Default 的含义在页脚解释。 */}
      {view === 'thinking' && <>
        <div className="model-list" role="menu" aria-label="推理等级">
          {selection.thinkingLevels.map((level) => <button key={level} role="menuitemradio" aria-checked={selection.thinkingLevel === level} disabled={saving} className={`model-option ${selection.thinkingLevel === level ? 'is-selected' : ''}`} onClick={() => void choose(() => onSelectThinking(level))}><span>{thinkingLabels[level]}</span>{selection.thinkingLevel === level && <Check />}</button>)}
        </div>
        <div className="model-picker-footnote">Default 跟随 Pi 配置，当前为 {thinkingLabels[selection.defaultThinkingLevel]}。</div>
      </>}
      {/* 错误与保存中状态固定在浮层底部，不遮挡上面的列表。 */}
      {error && <div className="model-picker-error" role="alert">{error}</div>}
      {saving && <div className="model-picker-note" role="status">正在应用…</div>}
    </div>}
  </div>;
}

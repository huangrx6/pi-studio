import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, CircleAlert, CircleCheck, Info, Trash2, TriangleAlert, X } from 'lucide-react';
import { errorText } from '../shared/error-text';
import {
  notificationMessagePresentation,
  type AppNotification,
  type NotificationTone,
} from './notification-state';
import './notification-center.css';

export type {
  AppNotification,
  AppNotificationAction,
  NotificationTone,
} from './notification-state';

function NotificationIcon({ tone }: { tone: NotificationTone }) {
  if (tone === 'success') return <CircleCheck />;
  if (tone === 'warning') return <TriangleAlert />;
  if (tone === 'error') return <CircleAlert />;
  return <Info />;
}

function notificationTime(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function NotificationCenter({
  items,
  onMarkAllRead,
  onClear,
  onOpenSession,
  onRunAction,
}: {
  items: AppNotification[];
  onMarkAllRead: () => void;
  onClear: () => void;
  onOpenSession?: (id: string) => Promise<void>;
  onRunAction?: (item: AppNotification) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [runningActionId, setRunningActionId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mountedRef = useRef(false);
  const pendingRef = useRef(false);
  const itemsRef = useRef(items);
  const openRef = useRef(open);
  const panelId = useId();
  const headingId = useId();
  const unread = items.filter((item) => !item.read).length;
  itemsRef.current = items;
  openRef.current = open;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    setErrors((current) => {
      const remaining = Object.fromEntries(Object.entries(current).filter(([id]) => items.some((item) => item.id === id)));
      return Object.keys(remaining).length === Object.keys(current).length ? current : remaining;
    });
  }, [items]);

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (open) headingRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const isInside = (target: EventTarget | null) => target instanceof Node
      && rootRef.current?.contains(target);
    const outside = (event: PointerEvent) => { if (!isInside(event.target)) close(); };
    // A non-modal popup must not stay above a newly focused settings page.
    const focusOutside = (event: FocusEvent) => { if (!isInside(event.target)) close(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', focusOutside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', focusOutside);
    };
  }, [open]);

  function toggle() {
    if (open) { close(true); return; }
    if (unread > 0) onMarkAllRead();
    setOpen(true);
  }

  async function openSession(item: AppNotification) {
    if (!item.sessionId || !onOpenSession || pendingRef.current) return;
    pendingRef.current = true;
    setOpeningId(item.id);
    setErrors((current) => { const next = { ...current }; delete next[item.id]; return next; });
    try {
      await onOpenSession(item.sessionId);
      if (!mountedRef.current) return;
      // Successful navigation may already focus the new conversation. Only
      // recover the bell when focus would otherwise disappear with this panel.
      const restore = Boolean(panelRef.current?.contains(document.activeElement));
      if (openRef.current) close(restore);
    } catch (cause) {
      if (mountedRef.current && itemsRef.current.some((candidate) => candidate.id === item.id)) {
        setErrors((current) => ({ ...current, [item.id]: errorText(cause) }));
      }
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setOpeningId(null);
    }
  }

  async function runAction(item: AppNotification) {
    if (!item.action || !onRunAction || pendingRef.current) return;
    pendingRef.current = true;
    setRunningActionId(item.id);
    setErrors((current) => { const next = { ...current }; delete next[item.id]; return next; });
    try {
      await onRunAction(item);
      if (!mountedRef.current || !openRef.current) return;
      // Success normally removes this item. Keep keyboard focus in the open
      // notification panel instead of dropping it to the document body.
      headingRef.current?.focus({ preventScroll: true });
    } catch (cause) {
      if (mountedRef.current && itemsRef.current.some((candidate) => candidate.id === item.id)) {
        setErrors((current) => ({ ...current, [item.id]: errorText(cause) }));
      }
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setRunningActionId(null);
    }
  }

  function markAllRead() {
    onMarkAllRead();
    headingRef.current?.focus({ preventScroll: true });
  }

  function clearAll() {
    onClear();
    headingRef.current?.focus({ preventScroll: true });
  }

  return <div className="notification-center" ref={rootRef}>
    <button
      ref={triggerRef}
      type="button"
      className={`icon-button notification-trigger ${unread ? 'has-unread' : ''} ${open ? 'is-active' : ''}`}
      aria-label={unread ? `通知，${unread} 条未读` : '通知'}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      title="通知"
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); close(true);
        }
      }}
    >
      <Bell aria-hidden="true" />
      {unread > 0 && <span className="notification-count" aria-hidden="true">{unread}</span>}
    </button>
    {open && <section
      id={panelId}
      ref={panelRef}
      className="notification-panel"
      role="dialog"
      aria-label="通知中心"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); close(true); return;
        }
        if (event.key !== 'Tab') return;
        const buttons = [...panelRef.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const active = document.activeElement;
        const first = buttons[0];
        const last = buttons.at(-1);
        if (event.shiftKey && (active === first || active === headingRef.current)) {
          event.preventDefault(); event.stopPropagation(); close(true);
        } else if (!event.shiftKey && (active === last || !first)) {
          event.stopPropagation();
          close(true);
          // Allow native Tab to continue after the trigger, not at body end.
        } else if (!event.shiftKey && active === headingRef.current) {
          event.preventDefault(); first?.focus();
        }
      }}
    >
      <header className="notification-panel-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>通知</h2>
        <div>
          {unread > 0 && <button type="button" title="全部标为已读" aria-label="全部标为已读" onClick={markAllRead}><CheckCheck aria-hidden="true" /></button>}
          {items.length > 0 && <button type="button" title="清空通知" aria-label="清空通知" onClick={clearAll}><Trash2 aria-hidden="true" /></button>}
          <button type="button" title="关闭通知" aria-label="关闭通知" onClick={() => close(true)}><X aria-hidden="true" /></button>
        </div>
      </header>
      <div className="notification-list">
        {items.length === 0
          ? <p className="notification-empty">暂无通知</p>
          : items.map((item) => {
            const message = notificationMessagePresentation(item.message);
            return <article
              className={`notification-item is-${item.tone} ${item.read ? '' : 'is-unread'}`}
              key={item.id}
              aria-busy={openingId === item.id || runningActionId === item.id || undefined}
            >
              <span className="notification-item-icon" aria-hidden="true"><NotificationIcon tone={item.tone} /></span>
              <div className="notification-item-copy">
                <div className="notification-item-heading"><strong>{item.title}</strong><time>{notificationTime(item.updatedAt ?? item.createdAt)}</time></div>
                <p className="notification-item-message">{message.summary}</p>
                {message.details && <details className="notification-item-details">
                  <summary>查看详情</summary>
                  <pre>{message.details}</pre>
                </details>}
                {item.action && onRunAction && <button
                  type="button"
                  className="notification-session-link"
                  aria-disabled={openingId !== null || runningActionId !== null}
                  onClick={() => void runAction(item)}
                >{runningActionId === item.id ? item.action.pendingLabel : item.action.label}</button>}
                {item.sessionId && onOpenSession && !item.action?.hideSessionLink && <button
                  type="button"
                  className="notification-session-link"
                  // Keep focus on the launching action while awaiting navigation;
                  // pendingRef guards clicks instead of disabling the focused DOM node.
                  aria-disabled={openingId !== null || runningActionId !== null}
                  onClick={() => void openSession(item)}
                >{openingId === item.id ? '正在打开…' : '查看会话'}</button>}
                {errors[item.id] && <p className="notification-item-error" role="alert">{errors[item.id]}</p>}
              </div>
            </article>;
          })}
      </div>
    </section>}
  </div>;
}

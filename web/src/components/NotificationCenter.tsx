import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  Info,
  Trash2,
  TriangleAlert,
} from 'lucide-react';

export type NotificationTone = 'info' | 'success' | 'warning' | 'error';

export type AppNotification = {
  id: string;
  title: string;
  message: string;
  tone: NotificationTone;
  createdAt: number;
  read: boolean;
};

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
}: {
  items: AppNotification[];
  onMarkAllRead: () => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const unread = items.filter((item) => !item.read).length;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  function toggle() {
    setOpen((current) => {
      const next = !current;
      if (next && unread > 0) onMarkAllRead();
      return next;
    });
  }

  return <div className="notification-center" ref={rootRef}>
    <button
      type="button"
      className={`icon-button notification-trigger ${unread ? 'has-unread' : ''} ${open ? 'is-active' : ''}`}
      aria-label={unread ? `通知，${unread} 条未读` : '通知'}
      aria-haspopup="dialog"
      aria-expanded={open}
      title="通知"
      onClick={toggle}
    >
      <Bell size={16} />
      {unread > 0 && <span className="notification-count">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <section className="notification-panel" role="dialog" aria-label="通知中心">
      <header className="notification-panel-head">
        <span><strong>通知</strong><small>{items.length ? `${items.length} 条消息` : '运行消息与操作结果会出现在这里'}</small></span>
        <div>
          {unread > 0 && <button type="button" title="全部标为已读" aria-label="全部标为已读" onClick={onMarkAllRead}><CheckCheck /></button>}
          {items.length > 0 && <button type="button" title="清空通知" aria-label="清空通知" onClick={onClear}><Trash2 /></button>}
        </div>
      </header>
      <div className="notification-list">
        {items.length === 0
          ? <div className="notification-empty">
            <Bell />
            <strong>暂无通知</strong>
            <span>扩展操作、更新和运行提示都会归档在这里。</span>
          </div>
          : items.map((item) => <article className={`notification-item is-${item.tone} ${item.read ? '' : 'is-unread'}`} key={item.id}>
            <span className="notification-item-icon"><NotificationIcon tone={item.tone} /></span>
            <span className="notification-item-copy">
              <span><strong>{item.title}</strong><time>{notificationTime(item.createdAt)}</time></span>
              <p>{item.message}</p>
            </span>
          </article>)}
      </div>
    </section>}
  </div>;
}

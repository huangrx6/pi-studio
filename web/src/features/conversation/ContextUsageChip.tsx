/**
 * 上下文用量指示器：输入区内置的“已用 / 窗口”百分比。
 *
 * 只读取两类已有数据：会话里最新的用量读数（`contextUsage`）与主进程返回的当前
 * 模型窗口和自动压缩阈值（`pi:context-policy`）。因此这里不产生新的状态来源，
 * 也不重复 Durable 的压缩判断：真正的压缩发生在 Durable，界面只展示与手动触发。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Gauge, LoaderCircle, Minimize2, Settings2 } from 'lucide-react';
import type { ContextUsage } from './context-usage';
import { compactTokens } from './context-usage';
import { contextUsagePresentation, type ContextPolicy } from './context-usage';
export type { ContextPolicy } from './context-usage';
import { InfoHint } from '../../shared/InfoHint';
import { PopoverSurface } from '../../shared/PopoverSurface';

const RING_RADIUS = 7;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export function ContextUsageChip({
  usage,
  policy,
  compacting,
  disabled,
  onCompact,
  onOpenSettings,
}: {
  usage: ContextUsage | null;
  policy: ContextPolicy | null;
  compacting: boolean;
  disabled: boolean;
  onCompact: () => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  const headingId = useId();
  function close(restore = false) {
    setOpen(false);
    if (restore && host.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    if (open) heading.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);

  const { known, used, percent, tone, label, detail, compactionHint } = contextUsagePresentation(usage, policy);

  return <div className="context-usage" ref={host}>
    <button
      ref={trigger}
      type="button"
      className={`context-usage-trigger is-${tone} ${open ? 'is-open' : ''}`}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      title={usage ? `${label}：${detail}` : label}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); }
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); }
      }}
    >
      <svg className="context-usage-ring" viewBox="0 0 18 18" aria-hidden="true">
        <circle className="context-usage-ring-track" cx="9" cy="9" r={RING_RADIUS} />
        <circle
          className="context-usage-ring-value"
          cx="9"
          cy="9"
          r={RING_RADIUS}
          strokeDasharray={`${Math.max(0, Math.min(100, percent)) / 100 * RING_LENGTH} ${RING_LENGTH}`}
        />
      </svg>
      <span>{known ? `${percent}%` : '—'}</span>
    </button>

    {open && <PopoverSurface
      ref={panel}
      id={panelId}
      className="context-usage-panel"
      role="dialog"
      aria-labelledby={headingId}
      heading={<><Gauge /><span id={headingId} ref={heading} tabIndex={-1}>上下文用量</span><InfoHint label={compactionHint} /></>}
      closeLabel="关闭上下文用量"
      onClose={() => close(true)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); close(true); return;
        }
        if (event.key !== 'Tab') return;
        const buttons = [...panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const active = document.activeElement;
        if (event.shiftKey && (active === heading.current || active === buttons[0])) {
          event.preventDefault(); event.stopPropagation(); close(true);
        } else if (!event.shiftKey && active === buttons.at(-1)) {
          event.stopPropagation(); close(true);
          // Native Tab continues after the trigger; the popover is non-modal.
        } else if (!event.shiftKey && active === heading.current) {
          event.preventDefault(); buttons[0]?.focus();
        }
      }}
    >
      <div className="context-usage-body">
        <strong>{known ? `${percent}%` : usage ? compactTokens(used) : '暂无读数'}</strong>
        <span>{detail}</span>
        {usage && <span>最近一次请求的估算，之后新增内容尚未计入。</span>}
        <div className="context-usage-actions">
          <button
            type="button"
            className="settings-outline"
            disabled={compacting || disabled}
            onClick={() => { close(true); onCompact(); }}
          >
            {compacting ? <LoaderCircle className="spin" /> : <Minimize2 />}
            立即压缩
          </button>
          <button type="button" className="text-button" onClick={() => { setOpen(false); onOpenSettings(); }}>
            <Settings2 />
            自动压缩设置
          </button>
        </div>
      </div>
    </PopoverSurface>}
  </div>;
}

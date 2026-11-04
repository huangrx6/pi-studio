/**
 * 上下文用量指示器：输入区内置的“已用 / 窗口”百分比。
 *
 * 只读取两类已有数据：会话里最新的用量读数（`contextUsage`）与主进程返回的当前
 * 模型窗口和自动压缩阈值（`pi:context-policy`）。因此这里不产生新的状态来源，
 * 也不重复 Durable 的压缩判断：真正的压缩发生在 Durable，界面只展示与手动触发。
 */
import { useEffect, useRef, useState } from 'react';
import { Gauge, LoaderCircle, Minimize2, Settings2 } from 'lucide-react';
import type { ContextUsage } from './context-usage';
import { compactTokens } from './context-usage';
import { InfoHint } from '../../shared/InfoHint';
import { PopoverSurface } from '../../shared/PopoverSurface';

const RING_RADIUS = 7;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export type ContextPolicy = {
  modelRef: string;
  contextWindow: number;
  autoCompactPercent: number;
  compactAtTokens: number | null;
};

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

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const percent = usage?.percent ?? 0;
  const window = policy?.contextWindow || usage?.contextWindow || 0;
  const threshold = policy?.autoCompactPercent ?? 0;
  // 阈值前 10 个百分点开始提醒；达到阈值用危险色，和压缩行为对齐。
  const tone = !usage || !threshold || window <= 0
    ? 'neutral'
    : percent >= threshold
      ? 'critical'
      : percent >= Math.max(0, threshold - 10)
        ? 'warning'
        : 'neutral';
  const known = Boolean(usage) && window > 0;
  const remaining = known ? Math.max(0, window - (usage?.usedTokens || 0)) : 0;
  // 窗口未知时不给百分比，避免把“不知道”显示成 0%。
  const label = !usage
    ? '上下文用量尚未统计'
    : known
      ? `上下文已用 ${percent}%`
      : `上下文已用 ${compactTokens(usage.usedTokens)} tokens`;
  const detail = usage && window > 0
    ? `${compactTokens(usage.usedTokens)} / ${compactTokens(window)} tokens · 剩余 ${compactTokens(remaining)}`
    : usage
      ? `已用 ${compactTokens(usage.usedTokens)} tokens`
      : '尚无上下文读数';
  const compactionHint = policy?.compactAtTokens
    ? `用到 ${threshold}%（约 ${compactTokens(policy.compactAtTokens)} tokens）时自动压缩；压缩期间当前请求暂停，完成后继续。`
    : threshold && window > 0
      ? `阈值 ${threshold}%；该模型未配置窗口，暂不生效。`
      : '自动压缩已关闭。';

  return <div className="context-usage" ref={host}>
    <button
      ref={trigger}
      type="button"
      className={`context-usage-trigger is-${tone} ${open ? 'is-open' : ''}`}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={usage ? `${label}：${detail}` : label}
      onClick={() => setOpen((value) => !value)}
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
      className="context-usage-panel"
      role="dialog"
      aria-label="上下文用量"
      heading={<><Gauge />上下文<InfoHint label={compactionHint} /></>}
      onClose={() => setOpen(false)}
    >
      <div className="context-usage-body">
        <strong>{known ? `${percent}%` : usage ? compactTokens(usage.usedTokens) : '暂无读数'}</strong>
        <span>{detail}</span>
        <div className="context-usage-actions">
          <button
            type="button"
            className="settings-outline"
            disabled={compacting || disabled}
            onClick={() => { setOpen(false); onCompact(); }}
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

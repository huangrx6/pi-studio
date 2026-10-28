/**
 * 应用内的确认弹窗。
 *
 * 两个用途：
 *  1. 扩展请求的工具确认（pi-mode-switcher 在风险操作时触发）：
 *     把操作类型、命令或目标路径结构化展示，并给出「取消 / 允许」。
 *  2. 启用「完全权限」前的风险确认：必须勾选已知风险才能继续。
 *
 * 确认结果通过 window.piApi.confirmResponse 回传主进程；
 * 弹窗本身不做任何权限判断，只负责呈现与收集选择。
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, FilePenLine, Globe2, Terminal, X } from 'lucide-react';

export type ConfirmRequest = { id: string; sessionId?: string; title: string; message: string };

type ConfirmKind = 'command' | 'file' | 'network' | 'tool';

type ParsedConfirm = { kind: ConfirmKind; tool?: string; detail: string };

const KIND_META: Record<ConfirmKind, { label: string; icon: ReactNode; acceptLabel: string }> = {
  command: { label: '执行命令', icon: <Terminal />, acceptLabel: '允许执行' },
  file: { label: '修改文件', icon: <FilePenLine />, acceptLabel: '允许写入' },
  network: { label: '访问网络', icon: <Globe2 />, acceptLabel: '允许访问' },
  tool: { label: '工具调用', icon: <Terminal />, acceptLabel: '允许' },
};

/**
 * 解析扩展传来的描述文本。
 * pi-mode-switcher 的格式：
 *  - `执行命令 · <command>`
 *  - `<tool> → <path|url|query>`
 */
function parseConfirmMessage(message: string): ParsedConfirm {
  const text = message.trim();
  if (text.startsWith('执行命令')) return { kind: 'command', detail: text.replace(/^执行命令\s*·\s*/, '') };
  const arrow = /^([\w.-]+)\s*→\s*([\s\S]+)$/.exec(text);
  if (arrow) return { kind: /^https?:/i.test(arrow[2]) ? 'network' : 'file', tool: arrow[1], detail: arrow[2] };
  return { kind: 'tool', detail: text };
}

/** 命令着色：首词、参数、路径/引号内容分别取不同语义色，便于快速扫读。 */
function CommandPreview({ command }: { command: string }) {
  const parts = command.split(/(\s+)/);
  return <pre className="confirm-command">{parts.map((part, index) => {
    if (!part.trim()) return part;
    let tone = 'is-arg';
    if (index === 0) tone = 'is-command';
    else if (/^-{1,2}[\w-]/.test(part)) tone = 'is-flag';
    else if (part.includes('/') || /^["'`]/.test(part)) tone = 'is-path';
    return <span className={`confirm-token ${tone}`} key={index}>{part}</span>;
  })}</pre>;
}

/** 弹窗外壳：Esc 关闭、点击遮罩关闭、打开时聚焦卡片。 */
function ConfirmShell({ onCancel, label, children }: { onCancel: () => void; label: string; children: ReactNode }) {
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    cardRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return <div className="confirm-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="confirm-card" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={cardRef}>
      {children}
    </div>
  </div>;
}

/** 工具操作确认。 */
export function ToolConfirmDialog({ request, onRespond }: { request: ConfirmRequest; onRespond: (accepted: boolean) => void }) {
  const parsed = parseConfirmMessage(request.message);
  const meta = KIND_META[parsed.kind];
  return <ConfirmShell label={request.title} onCancel={() => onRespond(false)}>
    <header className="confirm-head">
      <span className={`confirm-icon is-${parsed.kind}`}>{meta.icon}</span>
      <div className="confirm-heading">
        <span className="confirm-eyebrow">{meta.label}</span>
        <h2>{request.title}</h2>
      </div>
      <button type="button" className="confirm-close" aria-label="关闭确认" onClick={() => onRespond(false)}><X /></button>
    </header>

    <div className="confirm-body">
      {parsed.kind === 'command'
        ? <CommandPreview command={parsed.detail} />
        : parsed.kind === 'tool'
          ? <p className="confirm-text">{parsed.detail}</p>
          : <div className="confirm-target">
            {parsed.tool && <span className="confirm-tool">{parsed.tool}</span>}
            <code title={parsed.detail}>{parsed.detail}</code>
          </div>}
    </div>

    <footer className="confirm-actions">
      <button type="button" className="confirm-cancel" onClick={() => onRespond(false)}>取消</button>
      <button type="button" className="confirm-accept" onClick={() => onRespond(true)}>{meta.acceptLabel}</button>
    </footer>
  </ConfirmShell>;
}

/** 启用完全权限前的风险确认；必须勾选后才可继续。 */
export function FullPermissionDialog({ acknowledged, onAcknowledgedChange, onConfirm, onCancel }: {
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return <ConfirmShell label="确认启用完全权限" onCancel={onCancel}>
    <header className="confirm-head">
      <span className="confirm-icon is-danger"><AlertTriangle /></span>
      <div className="confirm-heading">
        <span className="confirm-eyebrow">高级权限</span>
        <h2>确认启用完全权限？</h2>
      </div>
      <button type="button" className="confirm-close" aria-label="关闭确认" onClick={onCancel}><X /></button>
    </header>

    <div className="confirm-body">
      <p className="confirm-text">启用完全权限后，智能体将减少确认步骤，并可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。</p>
      <label className="confirm-check">
        <input type="checkbox" checked={acknowledged} onChange={(event) => onAcknowledgedChange(event.target.checked)} />
        <span>我已了解风险，并愿意继续</span>
      </label>
    </div>

    <footer className="confirm-actions">
      <button type="button" className="confirm-cancel" onClick={onCancel}>取消</button>
      <button type="button" className="confirm-accept is-danger" disabled={!acknowledged} onClick={onConfirm}>启用完全权限</button>
    </footer>
  </ConfirmShell>;
}

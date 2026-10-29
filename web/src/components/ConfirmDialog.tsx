/**
 * 应用内的确认弹窗。
 *
 * 两个用途：
 *  1. Studio 权限守卫在策略要求确认时触发的工具确认：
 *     把操作类型、命令或目标路径结构化展示，并给出「取消 / 允许」。
 *  2. 启用「完全权限」前的风险确认：必须勾选已知风险才能继续。
 *
 * 确认结果通过 window.piApi.confirmResponse 回传主进程；
 * 弹窗本身不做任何权限判断，只负责呈现与收集选择。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, FilePenLine, FileSearch, Globe2, Terminal, X } from 'lucide-react';
import type {
  PermissionConfirmRequest,
  PermissionConfirmResponse,
  PermissionRememberScope,
} from '../types/permission-types';
import { Select } from './Select';
import '../styles/permission-policy.css';

export type ConfirmRequest = PermissionConfirmRequest;
export type ConfirmResult = Omit<PermissionConfirmResponse, 'id'>;

export type ActionConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
};

type ConfirmKind = 'command' | 'read' | 'file' | 'network' | 'tool';

type ParsedConfirm = { kind: ConfirmKind; tool?: string; detail: string; explanation?: string; risk?: string };

const KIND_META: Record<ConfirmKind, { label: string; icon: ReactNode; acceptLabel: string }> = {
  command: { label: '执行命令', icon: <Terminal />, acceptLabel: '允许执行' },
  read: { label: '读取文件', icon: <FileSearch />, acceptLabel: '允许读取' },
  file: { label: '修改文件', icon: <FilePenLine />, acceptLabel: '允许写入' },
  network: { label: '访问网络', icon: <Globe2 />, acceptLabel: '允许访问' },
  tool: { label: '工具调用', icon: <Terminal />, acceptLabel: '允许' },
};

function kindForTool(tool: string, detail?: string): ConfirmKind {
  if (tool === 'bash') return 'command';
  if (['read', 'ls', 'find', 'grep'].includes(tool)) return 'read';
  if (['write', 'edit'].includes(tool)) return 'file';
  if (tool.startsWith('mcp__')) return 'network';
  if (detail && /^https?:/i.test(detail)) return 'network';
  return 'tool';
}

/**
 * 解析权限守卫传来的描述文本：
 *  - `执行命令 · <command>`
 *  - `<tool> → <path|url|query>`
 */
function parseConfirmMessage(request: ConfirmRequest): ParsedConfirm {
  const text = request.message.trim();
  // The command or target is already rendered in full above. Repeating its 500
  // character risk detail here made long approvals grow horizontally and added
  // no useful information.
  const riskLabel = request.risk?.level === 'high'
    ? '高风险'
    : request.risk?.level === 'medium'
      ? '中风险'
      : '低风险';
  const risk = request.risk ? `${riskLabel} · ${request.risk.title}` : undefined;
  if (request.tool) {
    const detail = request.tool === 'bash'
      ? text.replace(/^执行命令\s*·\s*/, '')
      : text.includes('→')
        ? text.slice(text.indexOf('→') + 1).trim()
        : text;
    return {
      kind: kindForTool(request.tool, detail),
      tool: request.tool,
      detail,
      explanation: request.explanation,
      risk,
    };
  }
  if (text.startsWith('执行命令')) return { kind: 'command', detail: text.replace(/^执行命令\s*·\s*/, '') };
  const arrow = /^([\w.-]+)\s*→\s*([\s\S]+)$/.exec(text);
  if (arrow) return { kind: kindForTool(arrow[1], arrow[2]), tool: arrow[1], detail: arrow[2] };
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

/**
 * 通用产品操作确认：删除、撤销信任、丢弃草稿和切换风险模式统一使用同一套
 * 视觉与键盘行为，避免各页面退回浏览器原生 confirm。
 */
export function ActionConfirmDialog({
  title,
  description,
  confirmLabel = '继续',
  cancelLabel = '取消',
  tone = 'default',
  onCancel,
  onConfirm,
}: ActionConfirmOptions & { onCancel: () => void; onConfirm: () => void }) {
  return <ConfirmShell label={title} onCancel={onCancel}>
    <header className="confirm-head">
      <span className={`confirm-icon ${tone === 'danger' ? 'is-danger' : 'is-tool'}`}><AlertTriangle /></span>
      <div className="confirm-heading">
        <span className="confirm-eyebrow">{tone === 'danger' ? '不可逆操作' : '确认操作'}</span>
        <h2>{title}</h2>
      </div>
      <button type="button" className="confirm-close" aria-label="关闭确认" onClick={onCancel}><X /></button>
    </header>
    {description && <div className="confirm-body"><p className="confirm-text">{description}</p></div>}
    <footer className="confirm-actions">
      <button type="button" className="confirm-cancel" onClick={onCancel}>{cancelLabel}</button>
      <button type="button" className={`confirm-accept ${tone === 'danger' ? 'is-danger' : ''}`} onClick={onConfirm}>{confirmLabel}</button>
    </footer>
  </ConfirmShell>;
}

/**
 * Promise 化的应用内确认。调用方可以自然使用
 * `if (!(await confirmation.confirm(...))) return;`，并把 `dialog` 渲染在当前页面。
 */
export function useActionConfirmation() {
  const [request, setRequest] = useState<(ActionConfirmOptions & { resolve: (accepted: boolean) => void }) | null>(null);
  const pending = useRef<(ActionConfirmOptions & { resolve: (accepted: boolean) => void }) | null>(null);

  const confirm = useCallback((options: ActionConfirmOptions) => new Promise<boolean>((resolve) => {
    pending.current?.resolve(false);
    const next = { ...options, resolve };
    pending.current = next;
    setRequest(next);
  }), []);

  function settle(accepted: boolean) {
    request?.resolve(accepted);
    pending.current = null;
    setRequest(null);
  }

  return {
    confirm,
    dialog: request && <ActionConfirmDialog
      title={request.title}
      description={request.description}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      tone={request.tone}
      onCancel={() => settle(false)}
      onConfirm={() => settle(true)}
    />,
  };
}

/** 工具操作确认。 */
export function ToolConfirmDialog({ request, onRespond }: { request: ConfirmRequest; onRespond: (result: ConfirmResult) => void }) {
  const parsed = parseConfirmMessage(request);
  const meta = KIND_META[parsed.kind];
  const rememberOptions = (request.rememberScopes || []).filter((scope): scope is Exclude<PermissionRememberScope, 'once'> => scope !== 'once');
  const [remember, setRemember] = useState<Exclude<PermissionRememberScope, 'once'> | ''>('');
  const respond = (accepted: boolean) => onRespond({
    accepted,
    ...(accepted && remember ? { remember } : {}),
  });
  return <ConfirmShell label={request.title} onCancel={() => respond(false)}>
    <header className="confirm-head">
      <span className={`confirm-icon is-${parsed.kind}`}>{meta.icon}</span>
      <div className="confirm-heading">
        <span className="confirm-eyebrow">{meta.label}</span>
        <h2>{request.title}</h2>
      </div>
      <button type="button" className="confirm-close" aria-label="关闭确认" onClick={() => respond(false)}><X /></button>
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
      {parsed.explanation && <p className="confirm-explanation">{parsed.explanation}</p>}
      {parsed.risk && <p className="confirm-risk"><AlertTriangle aria-hidden="true" /><span>{parsed.risk}</span></p>}
      {rememberOptions.length > 0 && <div className="confirm-remember">
        <span>允许后记住这次选择</span>
        <Select
          className="confirm-remember-select"
          label="记住选择范围"
          value={remember}
          options={[
            { value: '', label: '仅本次' },
            ...rememberOptions.map((scope) => ({
              value: scope,
              label: scope === 'session'
                ? '本会话中相同操作'
                : scope === 'workspace'
                  ? '当前工作区中相同操作'
                  : '所有工作区中的相同操作',
            })),
          ]}
          onChange={(value) => setRemember(value as typeof remember)}
        />
      </div>}
    </div>

    <footer className="confirm-actions">
      <button type="button" className="confirm-cancel" onClick={() => respond(false)}>取消</button>
      <button type="button" className="confirm-accept" onClick={() => respond(true)}>{meta.acceptLabel}</button>
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
      <p className="confirm-text">启用完全权限后，普通工具、跨工作区操作和无法静态确认的脚本会直接执行。你显式设置为“询问/拒绝”的规则仍会生效；明显的删除与系统破坏命令始终拦截。仅建议在你信任当前任务时使用。</p>
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

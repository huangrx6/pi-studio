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

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, FilePenLine, FileSearch, Globe2, Monitor, Save, ShieldAlert, Terminal, Trash2, X } from 'lucide-react';
import type {
  PermissionConfirmRequest,
  PermissionConfirmResponse,
  PermissionRememberScope,
} from '../types/permission-types';
import { Select } from './Select';
import { useModalDialog, type ModalDismiss } from './useModalDialog';
import './styles/confirm-shell.css';

export type ConfirmRequest = PermissionConfirmRequest;
export type ConfirmResult = Omit<PermissionConfirmResponse, 'id'>;

export type ActionConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  cardClassName?: string;
  /** Visual intent for the leading icon. Defaults from tone/labels when omitted. */
  kind?: 'delete' | 'discard' | 'save' | 'risk' | 'default';
};

type ConfirmKind = 'command' | 'read' | 'file' | 'network' | 'sensitive' | 'tool';

type ParsedConfirm = { kind: ConfirmKind; tool?: string; detail: string; explanation?: string; risk?: string };

const KIND_META: Record<ConfirmKind, { icon: ReactNode; acceptLabel: string }> = {
  command: { icon: <Terminal />, acceptLabel: '允许执行' },
  read: { icon: <FileSearch />, acceptLabel: '允许读取' },
  file: { icon: <FilePenLine />, acceptLabel: '允许写入' },
  network: { icon: <Globe2 />, acceptLabel: '允许访问' },
  sensitive: { icon: <ShieldAlert />, acceptLabel: '仍然发送' },
  tool: { icon: <Terminal />, acceptLabel: '允许' },
};

function kindForTool(tool: string, detail?: string): ConfirmKind {
  if (tool === 'sensitive-input') return 'sensitive';
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

/** 弹窗打开时聚焦指定控件或卡片，支持 Esc 和点击遮罩取消。 */
export function ConfirmShell({
  onCancel,
  label,
  cardClassName,
  initialFocusRef,
  role = 'dialog',
  children,
}: {
  onCancel: () => void;
  label: string;
  cardClassName?: string;
  initialFocusRef?: RefObject<HTMLElement>;
  role?: 'dialog' | 'alertdialog';
  children: ReactNode | ((dismiss: ModalDismiss) => ReactNode);
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { dialogRef, onKeyDown, dismiss } = useModalDialog();
  const cancel = () => void dismiss(onCancel);
  useLayoutEffect(() => {
    (initialFocusRef?.current ?? cardRef.current)?.focus({ preventScroll: true });
  }, [initialFocusRef]);

  return createPortal(<dialog
    ref={dialogRef}
    className="confirm-overlay confirm-native-dialog native-dialog-motion"
    role={role}
    aria-modal="true"
    aria-label={label}
    onKeyDown={onKeyDown}
    onCancel={(event) => { event.preventDefault(); cancel(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}
  >
    <div
      className={`confirm-card${cardClassName ? ` ${cardClassName}` : ''}`}
      tabIndex={-1}
      ref={cardRef}
    >
      {typeof children === 'function' ? children(dismiss) : children}
    </div>
  </dialog>, document.body);
}

/**
 * 通用产品操作确认：删除、撤销信任、丢弃草稿和切换风险模式统一使用同一套
 * 视觉与键盘行为，避免各页面退回浏览器原生 confirm。
 */
function actionConfirmKind(options: ActionConfirmOptions): NonNullable<ActionConfirmOptions['kind']> {
  if (options.kind) return options.kind;
  const label = `${options.title}${options.confirmLabel || ''}`;
  if (/删除|移除|卸载|清除|清空/.test(label)) return 'delete';
  if (/丢弃/.test(label)) return 'discard';
  if (/保存|启用|开启/.test(label) && options.tone !== 'danger') return 'save';
  if (options.tone === 'danger' || /风险|危险|完全权限|CDP|外接/.test(label)) return 'risk';
  return 'default';
}

export function ActionConfirmDialog({
  title,
  description,
  confirmLabel = '继续',
  cancelLabel = '取消',
  tone = 'default',
  kind,
  cardClassName = '',
  onCancel,
  onConfirm,
}: ActionConfirmOptions & { onCancel: () => void; onConfirm: () => void }) {
  const resolvedKind = actionConfirmKind({ title, confirmLabel, tone, kind });
  const icon = resolvedKind === 'delete' || resolvedKind === 'discard'
    ? <Trash2 />
    : resolvedKind === 'save'
      ? <Save />
      : <AlertTriangle />;
  const iconTone = resolvedKind === 'save' ? 'is-tool' : (tone === 'danger' || resolvedKind !== 'default' ? 'is-danger' : 'is-tool');
  return <ConfirmShell
    label={title}
    cardClassName={`is-action is-${resolvedKind} ${cardClassName}`.trim()}
    role={tone === 'danger' ? 'alertdialog' : 'dialog'}
    onCancel={onCancel}
  >
    {(dismiss) => <>
    <header className="confirm-head">
      <span className={`confirm-icon ${iconTone}`}>{icon}</span>
      <div className="confirm-heading">
        <h2>{title}</h2>
      </div>
      <button type="button" className="confirm-close" aria-label="关闭确认" onClick={() => void dismiss(onCancel)}><X /></button>
    </header>
    {description && <div className="confirm-body"><p className="confirm-text">{description}</p></div>}
    <footer className="confirm-actions">
      <button type="button" className="confirm-cancel" onClick={() => void dismiss(onCancel)} autoFocus={tone === 'danger' || undefined}>{cancelLabel}</button>
      <button type="button" className={`confirm-accept ${tone === 'danger' ? 'is-danger' : ''}`} onClick={() => void dismiss(onConfirm)} autoFocus={tone !== 'danger' || undefined}>{confirmLabel}</button>
    </footer>
    </>}
  </ConfirmShell>;
}

/**
 * Promise 化的应用内确认。调用方可以自然使用
 * `if (!(await confirmation.confirm(...))) return;`，并把 `dialog` 渲染在当前页面。
 */
export function useActionConfirmation(cardClassName?: string) {
  const [request, setRequest] = useState<(ActionConfirmOptions & { resolve: (accepted: boolean) => void }) | null>(null);
  const pending = useRef<(ActionConfirmOptions & { resolve: (accepted: boolean) => void }) | null>(null);

  const confirm = useCallback((options: ActionConfirmOptions) => new Promise<boolean>((resolve) => {
    pending.current?.resolve(false);
    const next = { ...options, resolve };
    pending.current = next;
    setRequest(next);
  }), []);

  useEffect(() => () => {
    pending.current?.resolve(false);
    pending.current = null;
  }, []);

  function settle(accepted: boolean) {
    pending.current?.resolve(accepted);
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
      kind={request.kind}
      cardClassName={request.cardClassName ?? cardClassName}
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
  const respond = (accepted: boolean, explicitRemember?: Exclude<PermissionRememberScope, 'once'>) => {
    const chosen = explicitRemember || remember || undefined;
    onRespond({
      accepted,
      ...(accepted && chosen ? { remember: chosen } : {}),
    });
  };

  if (request.tool === 'desktop_control_app') {
    return <ConfirmShell label={request.title} cardClassName="confirm-card-desktop" onCancel={() => respond(false)}>
      {(dismiss) => <>
      <header className="confirm-desktop-head">
        <span className="confirm-desktop-badge" aria-hidden="true"><Monitor /></span>
        <span className="confirm-desktop-kicker">Computer Use</span>
        <button type="button" className="confirm-close" aria-label="关闭确认" onClick={() => void dismiss(() => respond(false))}><X /></button>
      </header>
      <div className="confirm-desktop-body">
        <h2>{request.title}</h2>
        {parsed.explanation && <p className="confirm-explanation">{parsed.explanation}</p>}
      </div>
      <footer className="confirm-desktop-actions">
        <button
          type="button"
          className="confirm-desktop-always"
          onClick={() => void dismiss(() => respond(true, 'always'))}
        >
          始终允许
        </button>
        <div className="confirm-desktop-right">
          <button type="button" className="confirm-cancel" onClick={() => void dismiss(() => respond(false))}>拒绝</button>
          <button
            type="button"
            className="confirm-accept"
            onClick={() => void dismiss(() => respond(true, 'session'))}
          >
            允许此对话
          </button>
        </div>
      </footer>
      </>}
    </ConfirmShell>;
  }

  return <ConfirmShell label={request.title} onCancel={() => respond(false)}>
    {(dismiss) => <>
    <header className="confirm-head">
      <span className={`confirm-icon is-${parsed.kind}`}>{meta.icon}</span>
      <div className="confirm-heading">
        <h2>{request.title}</h2>
      </div>
      <button type="button" className="confirm-close" aria-label="关闭确认" onClick={() => void dismiss(() => respond(false))}><X /></button>
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
      <button type="button" className="confirm-cancel" onClick={() => void dismiss(() => respond(false))}>取消</button>
      <button type="button" className="confirm-accept" onClick={() => void dismiss(() => respond(true))}>{meta.acceptLabel}</button>
    </footer>
    </>}
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
    {(dismiss) => <>
    <header className="confirm-head">
      <span className="confirm-icon is-danger"><AlertTriangle /></span>
      <div className="confirm-heading">
        <h2>确认启用完全权限？</h2>
      </div>
      <button type="button" className="confirm-close" aria-label="关闭确认" onClick={() => void dismiss(onCancel)}><X /></button>
    </header>

    <div className="confirm-body">
      <p className="confirm-text">启用完全权限后，普通工具、跨工作区操作和无法静态确认的脚本会直接执行。你显式设置为“询问/拒绝”的规则仍会生效；明显的删除与系统破坏命令始终拦截。仅建议在你信任当前任务时使用。</p>
      <label className="confirm-check">
        <input type="checkbox" checked={acknowledged} onChange={(event) => onAcknowledgedChange(event.target.checked)} />
        <span>我已了解风险，并愿意继续</span>
      </label>
    </div>

    <footer className="confirm-actions">
      <button type="button" className="confirm-cancel" onClick={() => void dismiss(onCancel)}>取消</button>
      <button type="button" className="confirm-accept is-danger" disabled={!acknowledged} onClick={() => void dismiss(onConfirm)}>启用完全权限</button>
    </footer>
    </>}
  </ConfirmShell>;
}

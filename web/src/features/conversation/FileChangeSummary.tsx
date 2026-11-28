/**
 * 一轮对话的文件变更汇总。
 *
 * 数据有两个来源：
 *  - Git 快照（主进程在回合前后用临时 index 对比工作树）：完整覆盖 bash、
 *    脚本、删除/新增等改动，并带统一 diff；
 *  - 工具参数（write/edit）：用于非 Git 仓库，或 Git 仓库之外的临时文件。
 *
 * 两者按绝对路径合并，Git 优先。点击文件会在当前会话打开变更标签页。
 */

import { useState } from 'react';
import { AlertTriangle, ChevronDown, Undo2 } from 'lucide-react';
import type { TurnDiff, TurnDiffFile } from '../../types/chat-types';
import type { FileChange } from './file-changes';
import { sameChangePath, toolFilePatch, toolResultDiff } from './file-changes';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { FileKindIcon } from '../../shared/FileKindIcon';
import './styles/file-change-summary.css';

type DisplayFile = {
  path: string;
  label: string;
  added: number;
  removed: number;
  complete: boolean;
  status: 'added' | 'modified' | 'deleted' | 'written';
  /** Whole-file write length, available even when no diff exists. */
  lines?: number;
  patch?: string;
  binary?: boolean;
  truncated?: boolean;
};

const STATUS_MARK: Record<DisplayFile['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  written: '写入',
};

function counts(added: number, removed: number) {
  return <span className="file-change-counts" aria-label={`增加 ${added} 行，删除 ${removed} 行`}><span>+{added}</span><span>−{removed}</span></span>;
}

function statusLabel(file: DisplayFile) {
  if (file.status === 'deleted') return '已删除';
  if (file.binary) return '二进制文件';
  if (file.lines !== undefined) return `/ ${file.lines} 行`;
  if (file.status === 'written') return '已写入';
  return '';
}

/** 把 Git 文件与工具文件合并；同一路径以 Git 数据为准。 */
function mergeFiles(git: TurnDiff | undefined, toolFiles: FileChange[]): DisplayFile[] {
  const merged = new Map<string, DisplayFile>();
  for (const file of git?.files ?? []) {
    merged.set(file.path, {
      path: file.path,
      label: file.label,
      added: file.added,
      removed: file.removed,
      complete: file.completeCounts !== false,
      status: file.status,
      patch: file.patch,
      binary: file.binary,
      truncated: file.truncated,
    });
  }
  for (const file of toolFiles) {
    const patch = toolFilePatch(file);
    const existing = [...merged.values()].find((item) => sameChangePath(item, file));
    if (existing) {
      // Git 优先保留路径/状态；缺补丁时用工具 diff 或整文件写入内容补上。
      if (!existing.patch && patch) {
        existing.patch = patch;
        if (!existing.complete || (existing.added === 0 && existing.removed === 0)) {
          const counted = countPatch(patch);
          if (counted) {
            existing.added = counted.added;
            existing.removed = counted.removed;
            existing.complete = true;
          } else if (file.lines !== undefined) {
            existing.lines = file.lines;
          }
        }
      } else if (!existing.complete && existing.lines === undefined && file.lines !== undefined) {
        existing.lines = file.lines;
      }
      continue;
    }
    const counted = patch ? countPatch(patch) : undefined;
    merged.set(file.path, {
      path: file.path,
      label: file.label,
      added: counted?.added ?? file.added,
      removed: counted?.removed ?? file.removed,
      complete: counted ? true : file.completeCounts,
      status: counted && counted.removed === 0 && /\/dev\/null/.test(patch || '') ? 'added' : 'written',
      lines: file.lines,
      patch,
    });
  }
  return [...merged.values()];
}

function countPatch(patch: string) {
  const delta = toolResultDiff({ details: { patch } } as import('../../types/chat-types').ChatMessage);
  return delta ? { added: delta.added, removed: delta.removed } : undefined;
}

export function FileChangeSummary({ files, gitDiff, onUndo, onOpenDiff, onOpenFile }: {
  files: FileChange[];
  gitDiff?: TurnDiff;
  onUndo?: (at: number) => Promise<void>;
  onOpenDiff?: (file: TurnDiffFile | undefined, turn: TurnDiff) => void;
  /** 打开文件预览；返回 false 表示文件已不可读（被移动或删除）。 */
  onOpenFile?: (path: string) => Promise<boolean> | boolean | void;
}) {
  const confirmation = useActionConfirmation();
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState('');
  const [expanded, setExpanded] = useState(false);
  /** 已在磁盘上消失的文件：点过一次就记下来，不再反复失败。 */
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const display = mergeFiles(gitDiff, files);
  if (display.length === 0) return null;
  const complete = display.every((file) => file.complete);
  const hasCounts = display.some((file) => file.complete);
  const added = display.reduce((sum, file) => sum + file.added, 0);
  const removed = display.reduce((sum, file) => sum + file.removed, 0);
  const review: TurnDiff = { ...gitDiff, at: gitDiff?.at ?? 0, totalAdded: added, totalRemoved: removed, files: display.map(file => ({ ...file, status: file.status === 'written' ? 'modified' : file.status, completeCounts: file.complete })) };
  const visible = expanded ? display : display.slice(0, 4);
  const missingCount = display.filter((file) => missing.has(file.path)).length;
  const sourceHint = gitDiff
    ? '基于本轮 Git 工作树快照；点击文件在右侧查看本轮变更。'
    : '仅汇总工具确认的写入；非 Git 仓库无法统计命令产生的文件。';

  /** 打开预览；文件已经不在了就把这一行标记为失效，而不是让错误弹到主界面。 */
  async function openPreview(path: string) {
    if (missing.has(path)) return;
    let available = true;
    try {
      available = (await onOpenFile?.(path)) !== false;
    } catch {
      available = false;
    }
    if (!available) setMissing((current) => new Set(current).add(path));
  }

  const names = display.map(file => file.label.split(/[\\/]/).pop() || file.label);
  const canUndo = gitDiff?.snapshot && !gitDiff.truncated && gitDiff.files.length === display.length && onUndo;
  async function undo() {
    if (!gitDiff || !onUndo || undoBusy) return;
    if (!await confirmation.confirm({
      title: '撤销本轮文件变更？',
      description: `将这 ${display.length} 个文件恢复到本轮开始时的内容。本轮新增的文件会从工作区移除。`,
      confirmLabel: '撤销变更', tone: 'danger',
    })) return;
    setUndoBusy(true);
    setUndoError('');
    try { await onUndo(gitDiff.at); }
    catch (error) { setUndoError(error instanceof Error ? error.message : '撤销失败，请重试。'); }
    finally { setUndoBusy(false); }
  }

  return <section className="file-change-summary" aria-label="本轮文件变更">
    <header>
      <button type="button" className="file-change-heading" aria-label="查看变更" title={sourceHint}
        disabled={!onOpenDiff} onClick={() => onOpenDiff?.(undefined, review)}>
        <strong>{display.length} 个文件变更</strong>
        {hasCounts && counts(added, removed)}
      </button>
      {(canUndo || gitDiff?.undone) && <button type="button" className="file-change-undo"
        disabled={undoBusy || gitDiff?.undone} onClick={() => void undo()}>
        {gitDiff?.undone ? '已撤销' : undoBusy ? '正在撤销' : '撤销'}<Undo2 aria-hidden="true" />
      </button>}
      {display.length > 4 && <button type="button" className="file-change-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        {expanded ? '收起' : '展开全部'}
        <ChevronDown aria-hidden="true" />
      </button>}
    </header>
    {confirmation.dialog}
    {undoError && <p className="file-change-missing-note" role="alert">{undoError}</p>}

    <div className="file-change-list">{visible.map((file, index) => {
      // 只要本轮有变更记录，就进「变更」页；没有 onOpenDiff 时再退回文件预览。
      const gone = missing.has(file.path);
      const canDiff = Boolean(onOpenDiff);
      const canView = Boolean(onOpenFile && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(file.path));
      const openable = !gone && (canDiff || canView);
      return <button
        type="button"
        className={`file-change-item ${openable ? 'is-openable' : ''} ${gone ? 'is-missing' : ''}`}
        key={file.path}
        title={`${STATUS_MARK[file.status]} · ${file.path}${gone ? '\n文件已不在磁盘上（可能被移动或删除）' : ''}`}
        disabled={!openable}
        onClick={() => {
          if (!openable) return;
          if (canDiff) {
            onOpenDiff?.(review.files.find(item => item.path === file.path) || {
              path: file.path,
              label: file.label,
              status: file.status === 'written' ? 'modified' : file.status,
              added: file.added,
              removed: file.removed,
              completeCounts: file.complete,
              patch: file.patch,
              binary: file.binary,
              truncated: file.truncated,
            }, review);
            return;
          }
          void openPreview(file.path);
        }}
      >
        <FileKindIcon path={file.path} />
        <span className="sr-only">{STATUS_MARK[file.status]} </span>
        <span className="file-change-path">{names.indexOf(names[index]) === names.lastIndexOf(names[index]) ? names[index] : file.label}</span>
        {gone
          ? <small className="file-change-missing">已移出磁盘</small>
          : file.complete
            ? counts(file.added, file.removed)
            : <small>{statusLabel(file)}</small>}
      </button>;
    })}</div>

    {missingCount > 0 && <p className="file-change-missing-note" role="status">
      {missingCount} 个文件已不在磁盘上（可能被移动或删除），已从可打开列表中移除。
    </p>}

    {gitDiff?.truncated && <p className="file-change-incomplete-note">文件较多，仅显示已记录的部分，行数为小计。</p>}
    {!complete && hasCounts && <p className="file-change-incomplete-note" role="status">
      <AlertTriangle />
      部分文件未提供差异，行数可能不完整。
    </p>}
  </section>;
}

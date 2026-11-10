/**
 * 一轮对话的文件变更汇总。
 *
 * 数据有两个来源：
 *  - Git 快照（主进程在回合前后用临时 index 对比工作树）：完整覆盖 bash、
 *    脚本、删除/新增等改动，并带统一 diff；
 *  - 工具参数（write/edit）：用于非 Git 仓库，或 Git 仓库之外的临时文件。
 *
 * 两者按绝对路径合并，Git 优先。点击有补丁的文件会在右栏打开 diff 标签页。
 */

import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FileDiff } from 'lucide-react';
import type { TurnDiff, TurnDiffFile } from '../../types/chat-types';
import type { FileChange } from './file-changes';
import { InfoHint } from '../../shared/InfoHint';

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

/** Git-style marker: A added, M modified, D deleted. */
/* 状态用文字标签，不再用 A/M/D/W 这类需要记忆的字母。 */
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
  if (file.lines) return `/ ${file.lines} 行`;
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
  const labels = new Set([...merged.values()].map((file) => file.label));
  for (const file of toolFiles) {
    // Git 路径与工具路径可能因符号链接写法不同，标签相同也视为同一文件。
    if (merged.has(file.path) || labels.has(file.label)) continue;
    const patch = file.operations.map((operation) => operation.diff).filter(Boolean).join('\n');
    merged.set(file.path, {
      path: file.path,
      label: file.label,
      added: file.added,
      removed: file.removed,
      complete: file.completeCounts,
      status: 'written',
      lines: file.lines,
      patch: patch || undefined,
    });
  }
  return [...merged.values()];
}

export function FileChangeSummary({ files, gitDiff, onOpenDiff, onOpenFile }: {
  files: FileChange[];
  gitDiff?: TurnDiff;
  onOpenDiff?: (file: TurnDiffFile | undefined, turn: TurnDiff) => void;
  /** 打开文件预览；返回 false 表示文件已不可读（被移动或删除）。 */
  onOpenFile?: (path: string) => Promise<boolean> | boolean | void;
}) {
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
    ? '基于本轮 Git 工作树快照；有补丁的文件查看 diff，其余文件打开预览。'
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

  return <section className="file-change-summary" aria-label="本轮文件变更">
    <header>
      <span className="file-change-icon"><FileDiff aria-hidden="true" /></span>
      <div>
        <span className="file-change-heading">
          <strong>已编辑 {display.length} 个文件</strong>
          <InfoHint label={sourceHint} />
        </span>
        {hasCounts && counts(added, removed)}
      </div>
      <button type="button" onClick={() => onOpenDiff?.(undefined, review)}>查看变更</button>
    </header>

    <div className="file-change-list">{visible.map((file) => {
      // 有补丁先看 diff；没有补丁但路径可读时，直接打开右侧文件预览。
      const gone = missing.has(file.path);
      const canDiff = Boolean(file.patch && onOpenDiff);
      const canView = Boolean(onOpenFile && file.path.startsWith('/'));
      const openable = !gone && (canDiff || canView);
      return <button
        type="button"
        className={`file-change-item ${openable ? 'is-openable' : ''} ${gone ? 'is-missing' : ''}`}
        key={file.path}
        title={gone ? `${file.path}\n文件已不在磁盘上（可能被移动或删除）` : file.path}
        disabled={!openable}
        onClick={() => {
          if (!openable) return;
          if (!canDiff) { void openPreview(file.path); return; }
          onOpenDiff?.(review.files.find(item => item.path === file.path), review);
        }}
      >
        <span className={`file-change-mark is-${file.status}`} aria-hidden="true">{STATUS_MARK[file.status]}</span>
        <span className="file-change-path">{file.label}</span>
        {gone
          ? <small className="file-change-missing">已移出磁盘</small>
          : file.complete
            ? counts(file.added, file.removed)
            : <small>{statusLabel(file)}</small>}
        {openable && <ChevronRight className="file-change-open" aria-hidden="true" />}
      </button>;
    })}</div>

    {display.length > 4 && <button type="button" className="file-change-more" onClick={() => setExpanded((value) => !value)}>
      {expanded ? '收起' : `全部 ${display.length} 个文件`}
      <ChevronDown aria-hidden="true" />
    </button>}

    {missingCount > 0 && <p className="file-change-missing-note" role="status">
      {missingCount} 个文件已不在磁盘上（可能被移动或删除），已从可打开列表中移除。
    </p>}

    {!complete && hasCounts && <p className="file-change-incomplete-note" role="status">
      <AlertTriangle />
      部分文件未提供差异，行数可能不完整。
    </p>}
  </section>;
}

/**
 * 单个文件的统一 diff 视图。
 *
 * 右栏标签页复用：顶部显示路径与增删行数，正文按 @@ hunk 渲染，
 * 左侧两列分别是旧/新行号，新增/删除行使用语义色背景。
 */

import { useMemo } from 'react';
import { FileDiff } from 'lucide-react';
import type { TurnDiffFile } from '../chat-types';

type DiffRow = { kind: 'meta' | 'hunk' | 'add' | 'del' | 'ctx'; text: string; oldNo?: number; newNo?: number };

/** 解析 git 统一 diff；文件头（diff --git / index / --- / +++）收进 meta 行。 */
function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split('\n')) {
    // 文件头不是内容行，跳过，避免把 ---/+++ 当成删除/新增。
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')
      || line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('old mode') || line.startsWith('new mode')) continue;
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) { oldNo = Number(match[1]); newNo = Number(match[2]); }
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    else if (line.startsWith(' ')) rows.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    else if (line.startsWith('\\')) rows.push({ kind: 'meta', text: line });
  }
  return rows;
}

export function DiffView({ file }: { file: TurnDiffFile }) {
  const rows = useMemo(() => parsePatch(file.patch || ''), [file.patch]);
  return <div className="diff-view">
    <div className="diff-view-head">
      <span className="diff-view-icon"><FileDiff /></span>
      <div className="diff-view-title">
        <strong title={file.path}>{file.label}</strong>
        <span>{file.status === 'added' ? '新增文件' : file.status === 'deleted' ? '删除文件' : '修改文件'}</span>
      </div>
      {file.completeCounts !== false && <span className="diff-view-counts"><span>+{file.added}</span><span>−{file.removed}</span></span>}
    </div>
    {rows.length > 0 ? <div className="diff-view-body">{rows.map((row, index) => (
      <div className={`diff-row is-${row.kind}`} key={index}>
        <span className="diff-gutter" aria-hidden="true">{row.kind === 'add' ? '' : row.oldNo ?? ''}</span>
        <span className="diff-gutter" aria-hidden="true">{row.kind === 'del' ? '' : row.newNo ?? ''}</span>
        <span className="diff-code">{row.text || ' '}</span>
      </div>
    ))}</div> : <div className="diff-empty">
      <FileDiff />
      <strong>{file.binary ? '二进制文件' : '没有可展示的文本差异'}</strong>
      <span>{file.binary ? '该文件无法以文本方式比较。' : '工具没有提供这个文件的补丁内容。'}</span>
    </div>}
    {file.truncated && <p className="diff-note">补丁过大，仅显示前 80,000 个字符。</p>}
  </div>;
}

import { useState } from 'react';
import { ChevronDown, FileDiff, FileText } from 'lucide-react';
import type { FileChange } from '../file-changes';

export function FileChangeSummary({ files }: { files: FileChange[] }) {
  const [expanded, setExpanded] = useState(false);
  const [review, setReview] = useState(false);
  const complete = files.every(file => file.completeCounts);
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const counts = (add: number, remove: number) => <span className="file-change-counts" aria-label={`增加 ${add} 行，删除 ${remove} 行`}><span>+{add}</span><span>−{remove}</span></span>;
  return <section className="file-change-summary" aria-label="本轮文件变更">
    <header><FileDiff aria-hidden="true" /><div><strong>已修改 {files.length} 个文件</strong>{complete && counts(added, removed)}</div><button onClick={() => { setReview(!review); setExpanded(true); }}>{review ? '收起变更' : '查看变更'}</button></header>
    <div className="file-change-list">{(expanded ? files : files.slice(0, 3)).map(file => <details className="file-change-item" key={file.path} open={review || undefined}>
      <summary><FileText aria-hidden="true" /><span title={file.path}>{file.label}</span>{file.completeCounts ? counts(file.added, file.removed) : <small>已写入</small>}<ChevronDown /></summary>
      <div className="file-change-diffs">{file.operations.map((operation, index) => <div key={operation.id}>
        <div className="file-change-caption">{file.operations.length > 1 ? `第 ${index + 1} 次修改 · ` : ''}{operation.diff ? '工具返回的变更' : operation.content !== undefined ? '写入内容 · 未提供修改前快照' : '工具未提供差异详情'}</div>
        {operation.diff ? <pre>{operation.diff.split('\n').map((line, row) => <span className={line.startsWith('+') && !line.startsWith('+++') ? 'is-added' : line.startsWith('-') && !line.startsWith('---') ? 'is-removed' : undefined} key={row}>{line}{'\n'}</span>)}</pre> : operation.content !== undefined ? <pre>{operation.content}</pre> : null}
      </div>)}</div>
    </details>)}</div>
    {files.length > 3 && <button className="file-change-more" onClick={() => { setExpanded(!expanded); setReview(false); }}>{expanded ? '收起文件列表' : `再显示 ${files.length - 3} 个文件`}<ChevronDown /></button>}
    <p className="file-change-footnote">仅汇总工具确认的修改{complete ? '，行数按各次操作累计' : '；未提供差异的文件不统计行数'}。</p>
  </section>;
}

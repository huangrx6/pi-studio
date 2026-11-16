import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, GitBranch, GitCommitHorizontal, GitMerge, Search, Tag } from 'lucide-react';
import { FileKindIcon } from '../../shared/FileKindIcon';
import type { GitHistoryRow } from '../../types/git-types';
import { useGitRead } from './useGitTools';
import { GitFileDiff } from './GitFileDiff';
import { GitFileList } from './GitFileList';
import './styles/git-history.css';

const lanes = ['color-mix(in srgb, var(--accent) 75%, var(--text))', 'var(--info)', 'var(--warning)', 'var(--success)', 'var(--text-2)'];
const rowHeight = 48;
const connectorHeight = 12;
const columnStep = 8;
const listDate = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const detailDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'short' });
const changeNames: Record<string, string> = { A: '新增', D: '删除', M: '修改', R: '重命名', C: '复制', T: '类型变更' };

// Every row shares the same lane scale, including the connector lines between merges.
function CommitGraph({ row, width, first, last }: { row: GitHistoryRow; width: number; first: boolean; last: boolean }) {
  const height = rowHeight + row.connectors.length * connectorHeight;
  return <svg aria-hidden="true" focusable="false" viewBox={'0 0 ' + width + ' ' + height} style={{ height }}
    preserveAspectRatio="none" className="git-commit-graph">
    {[row.graph, ...row.connectors].map((line, i) => {
      const top = i ? rowHeight + (i - 1) * connectorHeight : 0;
      const bottom = i ? top + connectorHeight : rowHeight;
      const middle = (top + bottom) / 2;
      return [...line.trimEnd()].map((ch, j) => {
        if (ch === ' ') return null;
        const x = j * columnStep + 6;
        const color = lanes[Math.round(j / 2) % lanes.length];
        const start = first && ch === '*' ? middle : top;
        const end = last && ch === '*' && !row.connectors.length ? middle : bottom;
        let d = 'M' + x + ' ' + start + 'V' + end;
        if (ch === '/' || ch === '\\') {
          const step = ch === '/' ? -columnStep : columnStep;
          d = 'M' + (x - step) + ' ' + top + 'C' + (x - step) + ' ' + middle + ' ' + (x + step) + ' ' + middle + ' ' + (x + step) + ' ' + bottom;
        } else if (ch === '-' || ch === '_' || ch === '.') {
          d = 'M' + (x - columnStep / 2) + ' ' + middle + 'h' + columnStep;
        }
        return <g key={i + '-' + j}>
          <path d={d} stroke={color} fill="none" strokeWidth="1.5" />
          {ch === '*' && <circle cx={x} cy={middle} r="3.5" fill="var(--surface)" stroke={color} strokeWidth="2" />}
        </g>;
      });
    })}
  </svg>;
}

function CommitRefs({ refs }: { refs: string }) {
  const entries = refs.split(', ');
  const first = entries[0];
  const current = first === 'HEAD' || first.startsWith('HEAD -> ');
  const tag = first.startsWith('tag: ');
  const Icon = tag ? Tag : GitBranch;
  return <span className="git-history-refs" aria-label={refs} title={refs}>
    <span className="git-history-ref" data-kind={current ? 'current' : tag ? 'tag' : 'branch'}>
      <Icon aria-hidden="true" /><span>{first.replace(/^(HEAD -> |tag: )/, '')}</span>
    </span>
    {entries.length > 1 && <small>+{entries.length - 1}</small>}
  </span>;
}

function CommitDetail({ sessionId, hash, revision, back }: { sessionId: string; hash: string; revision: number; back: () => void }) {
  const { data, error } = useGitRead(sessionId, 'detail', { hash }, revision);
  const [picked, setPicked] = useState('');
  const selected = (picked && data?.files.find(file => file.path === picked)) || data?.files[0];
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { backButton.current?.focus(); }, []);
  return <section className="git-commit-detail" aria-label="提交详情">
    <div className="git-detail-navigation">
      <button ref={backButton} type="button" className="git-back" onClick={back}><ArrowLeft />提交历史</button>
      <span className="git-commit-id"><GitCommitHorizontal aria-hidden="true" /><code className="git-full-hash" title={hash}>{hash}</code></span>
    </div>
    {!data ? <p className="git-history-feedback" role={error ? 'alert' : 'status'}>{error || '正在读取提交…'}</p> : <>
      <header className="git-detail-heading">
        <h3>{data.message.split('\n')[0] || '无提交说明'}</h3>
        <div className="git-detail-byline">
          <span className="git-detail-author">{data.author}</span>
          {data.email && <span className="git-detail-email">{data.email}</span>}
          <time dateTime={data.date}>{detailDate.format(new Date(data.date))}</time>
        </div>
      </header>
      {data.message.includes('\n') && <p className="git-message-body">{data.message.slice(data.message.indexOf('\n')).trim()}</p>}
      {data.parents.length > 1 && <p className="git-detail-parents"><GitMerge aria-hidden="true" />合并提交 · 相对第一父提交 <code>{data.parents[0].slice(0, 8)}</code></p>}
      <div className="git-commit-files">
        <section className="git-detail-paths" aria-label="变更文件">
          <h4>变更文件 <small>{data.files.length}</small></h4>
          {!data.files.length && <p className="git-history-feedback">这次提交没有文件变更。</p>}
          <GitFileList files={data.files} className="git-detail-file-list">{file => {
            const split = file.path.lastIndexOf('/');
            const directory = file.path.slice(0, split + 1);
            const status = file.code[0];
            return <button key={file.path} className="git-history-file" type="button" aria-pressed={selected?.path === file.path}
              title={file.previousPath ? file.previousPath + ' → ' + file.path : file.path} onClick={() => setPicked(file.path)}>
              <FileKindIcon path={file.path} />
              <span className="git-detail-path"><strong>{file.path.slice(split + 1)}</strong>
                {(file.previousPath || directory) && <small>{file.previousPath ? '原路径 ' + file.previousPath : directory}</small>}
              </span>
              <span className="git-detail-change" data-change={status} title={file.code}>{changeNames[status] || file.code}</span>
            </button>;
          }}</GitFileList>
        </section>
        {selected && <GitFileDiff sessionId={sessionId} source={{ layer: 'commit', hash, path: selected.path, previousPath: selected.previousPath || '' }} revision={revision} />}
      </div>
    </>}
  </section>;
}

export function GitHistory({ sessionId, revision }: { sessionId: string; revision: number }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [jump, setJump] = useState('');
  const [hash, setHash] = useState('');
  const returnTo = useRef('');
  useEffect(() => {
    const timeout = setTimeout(() => { setOffset(0); setJump(''); setSearch(query.trim()); }, 180);
    return () => clearTimeout(timeout);
  }, [query]);
  const { data, error } = useGitRead(hash ? undefined : sessionId, 'history', { query: search, offset }, revision);
  if (hash) return <CommitDetail sessionId={sessionId} hash={hash} key={hash} revision={revision}
    back={() => { returnTo.current = hash; setHash(''); }} />;
  let graphColumns = 1;
  for (const row of data?.rows || []) {
    for (const line of [row.graph, ...row.connectors]) graphColumns = Math.max(graphColumns, line.trimEnd().length);
  }
  const graphWidth = (graphColumns - 1) * columnStep + 14;
  const pages = data ? Math.ceil(data.total / data.pageSize) : 0;
  const page = data ? Math.floor(data.offset / data.pageSize) + 1 : 0;
  function go(value: number) {
    if (!data || !Number.isInteger(value) || value < 1 || value > pages) return;
    setJump('');
    setOffset((value - 1) * data.pageSize);
  }
  return <section className="git-history" aria-label="提交历史">
    <label className="git-search"><Search aria-hidden="true" /><input type="search" value={query} aria-label="搜索提交" placeholder="搜索提交说明或哈希"
      onChange={e => setQuery(e.target.value)} /></label>
    {error && <p className="git-history-feedback" role="alert">{error}</p>}
    {!error && !data && <p className="git-history-feedback" role="status">正在读取历史…</p>}
    {data && !data.rows.length && <p className="git-history-feedback">{search ? '没有匹配的提交' : '还没有提交'}</p>}
    {data && data.rows.length > 0 && <div className="git-history-list" style={{
      '--git-graph-width': graphWidth + 'px',
      '--git-history-row-height': rowHeight + 'px',
    } as CSSProperties}>
      {data.rows.map((row, i) => <button type="button" key={row.hash} className="git-history-row" onClick={() => setHash(row.hash)}
        ref={button => { if (button && returnTo.current === row.hash) { returnTo.current = ''; button.focus(); } }}>
        <CommitGraph row={row} width={graphWidth} first={!data.offset && i === 0} last={!data.more && i === data.rows.length - 1} />
        <span className="git-history-subject"><strong title={row.subject}>{row.subject || '无提交说明'}</strong>
          <span className="git-history-meta"><span className="git-author">{row.author}</span><span aria-hidden="true">·</span>
            <time dateTime={row.date}>{listDate.format(new Date(row.date))}</time></span>
        </span>
        <span className="git-history-aside">{row.refs && <CommitRefs refs={row.refs} />}<code>{row.hash.slice(0, 8)}</code></span>
      </button>)}
    </div>}
    {data && pages > 0 && <nav className="git-pages" aria-label="提交历史分页">
      <span>第 {page} / {pages} 页 · 共 {data.total} 次提交</span>
      {pages > 1 && <><button type="button" disabled={page <= 1} onClick={() => go(page - 1)}><ChevronLeft />上一页</button>
        <button type="button" disabled={!data.more} onClick={() => go(page + 1)}>下一页<ChevronRight /></button>
        <form onSubmit={e => { e.preventDefault(); go(Number(jump)); }}>
          <input type="number" min={1} max={pages} required aria-label="跳转页码" placeholder="页码" value={jump} onChange={e => setJump(e.target.value)} />
          <button type="submit" disabled={!jump}>跳转</button>
        </form></>}
    </nav>}
  </section>;
}

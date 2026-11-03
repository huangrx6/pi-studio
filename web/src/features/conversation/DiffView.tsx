import { useEffect, useMemo, useRef, useState } from 'react';
import { Columns2, Rows3, FileCode2 } from 'lucide-react';
import type { TurnDiffFile } from '../../types/chat-types';
import { splitPatch, changedRange, type DiffLine } from './diff-rows';

// Small lexical renderer. React escapes every token, including untrusted source text.
function Code({ text, range }: { text: string; range: [number, number] | null }) {
  const tokens = text.match(/(?:\/\/|#).*|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(?:const|let|var|function|return|if|else|await|async|import|from|export|def|class|try|catch|for|while|in|raise|throw|new|None|True|False|null|true|false)\b|\b\d+(?:\.\d+)?\b|\w+|[^\w]/g) || [];
  let position = 0;
  return <>{tokens.map((token, i) => {
    const start = position; position += token.length;
    const tone = /^(\/\/|#)/.test(token) ? 'comment' : /^["'`]/.test(token) ? 'string' : /^\d/.test(token) ? 'number' : /^(const|let|var|function|return|if|else|await|async|import|from|export|def|class|try|catch|for|while|in|raise|throw|new|None|True|False|null|true|false)$/.test(token) ? 'keyword' : '';
    const a = range ? Math.max(0, range[0]-start) : token.length, b = range ? Math.min(token.length, range[1]-start) : 0;
    return <span className={tone ? `diff-syntax-${tone}` : undefined} key={i}>{a < b ? <>{token.slice(0,a)}<mark>{token.slice(a,b)}</mark>{token.slice(b)}</> : token}</span>;
  })}</>;
}
function Line({ line, side, other, wordDiff = true }: { line?: DiffLine; side: 'left' | 'right'; other?: DiffLine; wordDiff?: boolean }) {
  return <div className={`diff-line ${!line ? 'is-empty' : line.changed ? side === 'left' ? 'is-del' : 'is-add' : ''}`}>
    <span className="diff-gutter">{line?.number}</span>
    <code className="diff-code">{line && <Code text={line.text || ' '} range={line.changed && wordDiff ? changedRange(line.text,other?.text) : null} />}</code>
  </div>;
}
export type DiffOptions = { layout: 'auto' | 'split' | 'unified'; wrap: boolean; wordDiff: boolean; hideImports: boolean };
/** Horizontal scrollers of one file: a single unified list or one per split pane. */
type Channel = 'unified' | 'left' | 'right';
export function DiffView({ file, options, embedded = false }: { file: TurnDiffFile; options?: DiffOptions; embedded?: boolean }) {
  const rows = useMemo(() => splitPatch(file.patch || '').filter(row => row.gap || !options?.hideImports || ![row.left, row.right].filter(Boolean).every(line => /^(?:import\s.+(?:;|['"])$|from\s+\S+\s+import\s+[^()]+$|(?:const|let|var)\s+.+require\(.+\);?$)/.test(line!.text.trim()))), [file.patch, options?.hideImports]);
  const [localSplit, setSplit] = useState(true);
  const host = useRef<HTMLDivElement>(null);
  const scrollers = useRef<Partial<Record<Channel, HTMLDivElement | null>>>({});
  const mirrors = useRef<Partial<Record<Channel, HTMLDivElement | null>>>({});
  const [tracks, setTracks] = useState<Partial<Record<Channel, number>>>({});
  const [wide, setWide] = useState(false);
  useEffect(() => { const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 760)); if (host.current) observer.observe(host.current); return () => observer.disconnect(); }, []);
  const split = options ? options.layout === 'split' || (options.layout === 'auto' && wide) : localSplit;
  const wordDiff = options?.wordDiff !== false;
  const channels: Channel[] = split ? (options?.wrap ? [] : ['left', 'right']) : ['unified'];
  // A round of changes shares one vertical surface, so a diff's own horizontal
  // bar would only appear at the end of a long file. The bar is mirrored into a
  // copy pinned to the visible bottom edge instead, and scrolling inside that
  // copy drives the rows back.
  useEffect(() => {
    if (!embedded) { setTracks({}); return; }
    const nodes = channels.map(name => scrollers.current[name]).filter((node): node is HTMLDivElement => Boolean(node));
    if (!nodes.length) { setTracks({}); return; }
    const measure = () => {
      const next: Partial<Record<Channel, number>> = {};
      for (const name of channels) {
        const node = scrollers.current[name], mirror = mirrors.current[name];
        if (!node) continue;
        if (node.scrollWidth > node.clientWidth + 1) next[name] = node.scrollWidth;
        if (mirror && mirror.scrollLeft !== node.scrollLeft) mirror.scrollLeft = node.scrollLeft;
      }
      setTracks(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [embedded, rows, split, options?.wrap]);
  const mirror = (name: Channel) => { const node = scrollers.current[name], bar = mirrors.current[name]; if (node && bar && bar.scrollLeft !== node.scrollLeft) bar.scrollLeft = node.scrollLeft; };
  const drive = (name: Channel) => { const node = scrollers.current[name], bar = mirrors.current[name]; if (node && bar && node.scrollLeft !== bar.scrollLeft) node.scrollLeft = bar.scrollLeft; };
  return <div ref={host} className={`diff-view ${embedded ? 'is-embedded' : ''} ${options?.wrap ? 'is-wrapped' : ''}`}>
    {!embedded && <div className="diff-view-head"><FileCode2 /><strong title={file.path}>{file.label}</strong>
      {file.completeCounts !== false && <span className="diff-view-counts"><span>+{file.added}</span><span>−{file.removed}</span></span>}
      <button type="button" className="icon-button" aria-label={split ? '切换为单列差异' : '切换为左右对照'} title={split ? '单列差异' : '左右对照'} onClick={() => setSplit(!split)}>{split ? <Rows3 /> : <Columns2 />}</button>
    </div>}
    {rows.length ? <div className="diff-view-body">
      {split && options?.wrap ? <div className="diff-paired"><div className="diff-pair"><div className="diff-column-title">修改前</div><div className="diff-column-title">修改后</div></div>{rows.map((row,i) => row.gap ? <div className="diff-gap" key={i}>{row.gap}</div> : <div className="diff-pair" key={i}><Line wordDiff={wordDiff} line={row.left} other={row.right} side="left" /><Line wordDiff={wordDiff} line={row.right} other={row.left} side="right" /></div>)}</div> : split ? <div className="diff-columns">{(['left','right'] as const).map(side => <div className="diff-pane" key={side} ref={node => { scrollers.current[side] = node; }} onScroll={() => mirror(side)}>
        <div className="diff-column-title">{side === 'left' ? '修改前' : '修改后'}</div>
        {rows.map((row,i) => row.gap ? <div className="diff-gap" key={i}>{row.gap}</div> : <Line wordDiff={wordDiff} key={i} line={row[side]} other={row[side === 'left' ? 'right' : 'left']} side={side} />)}
      </div>)}</div> : <div className="diff-unified" ref={node => { scrollers.current.unified = node; }} onScroll={() => mirror('unified')}>{rows.map((row,i) => row.gap ? <div className="diff-gap" key={i}>{row.gap}</div> : <div key={i}>
        {row.left?.changed && <Line wordDiff={wordDiff} line={row.left} other={row.right} side="left" />}
        {row.right ? <Line wordDiff={wordDiff} line={row.right} other={row.left} side="right" /> : !row.left?.changed && <Line wordDiff={wordDiff} line={row.left} side="left" />}
      </div>)}</div>}
    </div> : <div className="diff-empty"><FileCode2 /><strong>{file.binary ? '二进制文件' : '没有可展示的文本差异'}</strong>{!file.binary && <span>当前记录未提供补丁内容。</span>}</div>}
    {file.truncated && <p className="diff-note">补丁过大，仅显示部分内容。</p>}
    {embedded && channels.some(name => tracks[name]) && (split && !options?.wrap
      ? <div className="diff-hscroll-row">{channels.map(name => <div className="diff-hscroll" key={name} ref={node => { mirrors.current[name] = node; }} onScroll={() => drive(name)} aria-hidden="true">{tracks[name] ? <div style={{ width: tracks[name] }} /> : null}</div>)}</div>
      : <div className="diff-hscroll" ref={node => { mirrors.current.unified = node; }} onScroll={() => drive('unified')} aria-hidden="true">{tracks.unified ? <div style={{ width: tracks.unified }} /> : null}</div>)}
  </div>;
}

import { ChevronDown, Globe } from 'lucide-react';
import { useContext, useId, useState, type ReactNode } from 'react';
import { siGithub, siMdnwebdocs, siNodedotjs, siPython, siReact, siTypescript } from 'simple-icons';
import { MarkdownActions } from '../../shared/markdown-actions';
import { getActivePreferences } from '../../shared/preferences';
import type { WebSource } from './web-sources';

const marks = new Map([
  ['developer.mozilla.org', siMdnwebdocs], ['github.com', siGithub], ['docs.github.com', siGithub],
  ['nodejs.org', siNodedotjs], ['docs.python.org', siPython], ['react.dev', siReact],
  ['www.typescriptlang.org', siTypescript],
]);

export function WebSources({ sources, fetched, status, tools }: { sources: WebSource[]; fetched: boolean; status: ReactNode; tools: ReactNode }) {
  const [open, setOpen] = useState(true);
  const id = useId();
  const { openLink } = useContext(MarkdownActions);
  return <>
    <div className="web-source-heading">
      <button type="button" className="turn-trace-toggle web-source-toggle" aria-expanded={open} aria-controls={id}
        onClick={() => setOpen(value => !value)}>
        <Globe /><strong>{fetched ? '已读取' : '搜索到'} {sources.length} 个网站</strong>{status}<ChevronDown />
      </button>
      {tools}
    </div>
    <div className="web-source-list" id={id} hidden={!open}>
      {sources.map(site => {
        const mark = marks.get(site.host);
        return <a key={site.host} className="web-source-chip" href={site.href} title={site.title ? site.title + '\n' + site.href : site.href}
          onClick={event => {
            event.preventDefault();
            if (openLink) openLink(site.href);
            else void window.piApi.openLink(site.href, getActivePreferences().linkOpen);
          }}>
          <span aria-hidden="true" className="web-source-mark">{mark
            ? <svg viewBox="0 0 24 24" fill="currentColor"><path d={mark.path} /></svg>
            : site.host.replace(/^www\./, '').slice(0, 1).toUpperCase()}</span>
          <span>{site.host.replace(/^www\./, '')}</span>
        </a>;
      })}
    </div>
  </>;
}

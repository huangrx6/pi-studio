import { ArrowUpRight, Globe, X } from 'lucide-react';
import { useContext, useState } from 'react';
import { siGithub, siMdnwebdocs, siNodedotjs, siPython, siReact, siTypescript } from 'simple-icons';
import { DetailDialog } from '../../shared/DetailDialog';
import { MarkdownActions } from '../../shared/markdown-actions';
import { getActivePreferences } from '../../shared/preferences';
import type { WebSource } from './web-sources';
import './styles/web-sources.css';

const marks = new Map([
  ['developer.mozilla.org', siMdnwebdocs], ['github.com', siGithub], ['docs.github.com', siGithub],
  ['nodejs.org', siNodedotjs], ['docs.python.org', siPython], ['react.dev', siReact],
  ['www.typescriptlang.org', siTypescript],
]);

export function WebSources({ sources }: { sources: WebSource[] }) {
  const [open, setOpen] = useState(false);
  const { openLink } = useContext(MarkdownActions);
  const label = `网页来源（${sources.length} 个网站）`;
  return <>
    <button type="button" className="message-action web-sources-trigger" aria-haspopup="dialog"
      aria-label={label} title={label} onClick={() => setOpen(true)}><Globe aria-hidden="true" /></button>
    {open && <DetailDialog className="web-sources-dialog" onClose={() => setOpen(false)}>
      <header className="web-sources-header">
        <span className="web-sources-emblem" aria-hidden="true"><Globe /></span>
        <div><h2>网页来源</h2><p>{sources.length} 个网站</p></div>
        <button type="button" className="icon-button" aria-label="关闭网页来源" onClick={() => setOpen(false)}><X /></button>
      </header>
      <ul className="web-sources-list">
        {sources.map(site => {
          const mark = marks.get(site.host);
          const host = site.host.replace(/^www\./, '');
          const title = site.title?.trim();
          const address = site.href.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
          return <li key={site.host}><a href={site.href} title={site.href} onClick={event => {
            event.preventDefault();
            setOpen(false);
            if (openLink) openLink(site.href);
            else void window.piApi.openLink(site.href, getActivePreferences().linkOpen);
          }}>
            <span className="web-source-mark" aria-hidden="true">{mark
              ? <svg viewBox="0 0 24 24" fill="currentColor"><path d={mark.path} /></svg>
              : host.slice(0, 1).toUpperCase()}</span>
            <span className="web-source-caption"><strong>{title || host}</strong>
              {address !== (title || host) && <small>{address}</small>}
            </span>
            <ArrowUpRight className="web-source-arrow" aria-hidden="true" />
          </a></li>;
        })}
      </ul>
    </DetailDialog>}
  </>;
}

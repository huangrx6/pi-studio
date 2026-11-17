import { ChevronDown, Globe } from 'lucide-react';
import { useContext, useId, useState } from 'react';
import { siGithub, siMdnwebdocs, siNodedotjs, siPython, siReact, siTypescript } from 'simple-icons';
import { MarkdownActions } from '../../shared/markdown-actions';
import { getActivePreferences } from '../../shared/preferences';
import type { WebSource } from './web-sources';

const marks = new Map([
  ['developer.mozilla.org', siMdnwebdocs], ['github.com', siGithub], ['docs.github.com', siGithub],
  ['nodejs.org', siNodedotjs], ['docs.python.org', siPython], ['react.dev', siReact],
  ['www.typescriptlang.org', siTypescript],
]);

export function WebSources({ sources }: { sources: WebSource[] }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const { openLink } = useContext(MarkdownActions);
  const visible = all ? sources : sources.slice(0, 3);
  return <section className="turn-sources" aria-label="网页来源">
    <div className="web-source-heading"><Globe aria-hidden="true" /><span>网页来源</span><span>{sources.length}</span></div>
    <div className="web-source-list" id={listId}>
      {visible.map(site => {
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
    {sources.length > 3 && <button type="button" className="web-source-more" aria-expanded={all} aria-controls={listId}
      onClick={() => setAll(!all)}>{all ? '收起' : '另 ' + (sources.length - 3) + ' 个'}<ChevronDown aria-hidden="true" /></button>}
  </section>;
}

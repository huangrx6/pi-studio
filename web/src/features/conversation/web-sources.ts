import type { ChatMessage, ToolCallBlock } from '../../types/chat-types';

export type WebSource = { host: string; href: string; title?: string };
type WebAction = 'search' | 'fetch';

export function webAction(call: ToolCallBlock): WebAction | undefined {
  const name = call.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replaceAll('-', '_');
  const parts = name.split('__');
  const tool = parts.at(-1);
  if (!tool) return;
  if (/^(?:(?:brave_|google_|bing_|exa_|tavily_)?web_search(?:_exa)?|search_web|(?:brave|tavily|exa|firecrawl|google|bing|duckduckgo)_search)$/.test(tool)) return 'search';
  if (tool === 'search' && /(?:brave|tavily|exa|firecrawl|duckduckgo|searx|web_search)/.test(parts[1] || call.namespace || '')) return 'search';
  if (/^(?:web_fetch|webfetch|fetch_webpage|fetch_url|read_url|open_url|firecrawl_scrape)$/.test(tool)) return 'fetch';
  if (tool === 'fetch' && (parts[1] === 'fetch' || typeof call.arguments?.url === 'string')) return 'fetch';
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
}

function source(value: unknown, title?: unknown): WebSource | undefined {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.username || url.password) return;
    return { host: url.host, href: url.href, title: typeof title === 'string' ? title : undefined };
  } catch { return; }
}

/** Read result records, never URLs mentioned inside a page body or snippet. */
function collectRecords(value: unknown, add: (source?: WebSource) => void, depth = 0) {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, add, depth + 1);
    return;
  }
  const item = record(value);
  if (!item) { add(source(value)); return; }
  add(source(item.url ?? item.href ?? item.link ?? item.uri, item.title ?? item.name));
  for (const key of ['results', 'sources', 'citations', 'items', 'web', 'webPages', 'value', 'data', 'organic', 'metadata']) {
    if (item[key] !== undefined) collectRecords(item[key], add, depth + 1);
  }
}

const searchCache = new WeakMap<ChatMessage, WebSource[]>();

function searchSources(result: ChatMessage) {
  const cached = searchCache.get(result);
  if (cached) return cached;
  const sites = new Map<string, WebSource>();
  const add = (item?: WebSource) => { if (item && !sites.has(item.host)) sites.set(item.host, item); };
  const details = record(result.details);
  collectRecords(details?.structuredContent ?? details, add);
  if (!sites.size) {
    for (const block of result.content) {
      if (block.type !== 'text') continue;
      const text = block.text.trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        try { collectRecords(JSON.parse(text), add); continue; } catch { /* Markdown results can also start with [. */ }
      }
      for (const line of text.split('\n')) {
        // Common plain-text MCP output is "URL: …", a bare URL or a linked result title.
        const resultLine = line.trim().replace(/^(?:[-*]|\d+[.)])\s+/, '');
        const link = resultLine.match(/^(?:#{1,6}\s+)?\[([^\]]+)\]\((https?:\/\/[^\s]+)\)(?:\s|$)/i);
        if (link) add(source(link[2], link[1]));
        else add(source(resultLine.match(/^(?:URL|Link|链接|网址)\s*[:：]\s*(\S+)$/i)?.[1] ?? resultLine));
      }
    }
  }
  const sources = [...sites.values()];
  searchCache.set(result, sources);
  return sources;
}

export function webSources(calls: ToolCallBlock[], results: Map<string, ChatMessage>) {
  const sites = new Map<string, WebSource>();
  for (const call of calls) {
    const result = results.get(call.id);
    const action = webAction(call);
    if (!action || !result || result.isError) continue;
    let sources: (WebSource | undefined)[];
    if (action === 'fetch') {
      const details = record(result.details);
      const fetched = record(details?.structuredContent) ?? details;
      sources = [source(fetched?.finalUrl ?? fetched?.url) ?? source(call.arguments?.url)];
    } else sources = searchSources(result);
    for (const item of sources) if (item && !sites.has(item.host)) sites.set(item.host, item);
  }
  return [...sites.values()];
}

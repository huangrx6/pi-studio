import { useId, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronLeft, Search, X } from 'lucide-react';
import { isComposingKey, menuFocusIndex } from '../shared/keyboard-navigation';
import './settings-navigation.css';

/** A settings page entry used by the shared settings shell. */
export type SettingsNavigationPage = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Optional group label. Ungrouped entries stay in their original order. */
  group?: string;
  /** Search aliases supplied by the page registry, without rendering extra copy. */
  keywords?: readonly string[];
};

export type SettingsNavigationProps = {
  pages: readonly SettingsNavigationPage[];
  activeId: string;
  onSelect: (id: string) => void;
  onBack: () => void;
  title?: string;
  backLabel?: string;
  ariaLabel?: string;
};

type SettingsNavigationGroup = {
  label?: string;
  pages: SettingsNavigationPage[];
};

const PAGE_SEARCH_ALIASES: Record<string, readonly string[]> = {
  general: ['外观', '主题', '字体', '字号', '背景', '圆角', '颜色', '深色', '浅色', '菜单栏'],
  shortcuts: ['快捷键', '键盘', '热键', 'shortcut'],
  models: ['API', '密钥', '供应商', '模型来源', 'provider', 'thinking', '推理'],
  usage: ['统计', '费用', '成本', 'token', '用量'],
  archives: ['历史', '恢复', '归档'],
  tools: ['工具', '命令', 'bash', '终端'],
  permissions: ['授权', '批准', '安全', '权限', '凭据', '密钥'],
  harness: ['提示词', '指令', 'prompt', 'AGENTS', '上下文', '重试', '超时', '压缩'],
  subagents: ['子代理', '多智能体', '并行', 'agent'],
  mcp: ['连接', '服务器', '集成', 'OAuth', '授权', 'API'],
  skills: ['技能', 'skill', '安装'],
  extensions: ['插件', '扩展', 'extension', '安装'],
  about: ['版本', '更新', '帮助'],
};

/**
 * Shared navigation for the full-screen settings surface.
 *
 * The component deliberately owns only navigation semantics and markup. The
 * parent remains responsible for the page registry and the active tab state,
 * so settings pages can be added without coupling them to this shell.
 */
export function SettingsNavigation({
  pages,
  activeId,
  onSelect,
  onBack,
  title = '设置',
  backLabel = '返回对话',
  ariaLabel = '设置导航',
}: SettingsNavigationProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const pagesRef = useRef<HTMLElement>(null);
  const navigationId = useId();
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  const visiblePages = terms.length === 0 ? pages : pages.filter((page) => {
    const searchable = normalizeSearch([
      page.label,
      page.id,
      page.group || '',
      ...(PAGE_SEARCH_ALIASES[page.id] || []),
      ...(page.keywords || []),
    ].join(' '));
    return terms.every((term) => searchable.includes(term));
  });
  const groups = groupPages(visiblePages);
  const focusablePageId = visiblePages.some((page) => page.id === activeId)
    ? activeId
    : visiblePages[0]?.id;

  function clearSearch() {
    setQuery('');
    searchRef.current?.focus();
  }

  function pageButtons() {
    return Array.from(pagesRef.current?.querySelectorAll<HTMLButtonElement>('[data-settings-page]') || []);
  }

  function focusPageAt(index: number) {
    pageButtons()[index]?.focus();
  }

  return (
    <aside className="settings-nav settings-navigation" aria-label={ariaLabel}>
      <div className="settings-nav-head"><span>{title}</span></div>
      <div className="settings-search settings-navigation-search" role="search" aria-label="搜索设置">
        <Search aria-hidden="true" />
        <input
          ref={searchRef}
          autoFocus
          type="search"
          aria-label="搜索设置"
          aria-controls={navigationId}
          placeholder="搜索设置…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (isComposingKey(event.nativeEvent)) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              if (query) clearSearch(); else onBack();
              return;
            }
            if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && pageButtons().length > 0) {
              event.preventDefault();
              event.stopPropagation();
              focusPageAt(event.key === 'ArrowDown' ? 0 : -1);
            }
          }}
        />
        {query && <button type="button" className="icon-button" aria-label="清除设置搜索" title="清除搜索" onClick={clearSearch}><X aria-hidden="true" /></button>}
      </div>
      <nav ref={pagesRef} id={navigationId} className="settings-navigation-pages" aria-label={ariaLabel}>
        {groups.map((group, groupIndex) => (
          <div className="settings-nav-group" key={group.label || `ungrouped-${groupIndex}`}>
            {group.label && <div className="nav-section-label">{group.label}</div>}
            {group.pages.map((page) => {
              const Icon = page.icon;
              const active = activeId === page.id;
              return (
                <button
                  key={page.id}
                  type="button"
                  className={`settings-nav-row ${active ? 'is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  data-settings-page={page.id}
                  tabIndex={page.id === focusablePageId ? 0 : -1}
                  onClick={() => onSelect(page.id)}
                  onKeyDown={(event) => {
                    if (isComposingKey(event.nativeEvent)) return;
                    const buttons = pageButtons();
                    const next = menuFocusIndex(event.key, buttons.indexOf(event.currentTarget), buttons.length, true);
                    if (next === null) return;
                    event.preventDefault();
                    focusPageAt(next);
                  }}
                >
                  <Icon aria-hidden="true" />
                  <span>{page.label}</span>
                </button>
              );
            })}
          </div>
        ))}
        {groups.length === 0 && <p className="settings-navigation-empty">没有匹配的设置，请换个关键词。</p>}
      </nav>
      <span className="sr-only" role="status" aria-live="polite">{terms.length > 0 ? `找到 ${visiblePages.length} 个设置页面` : ''}</span>
      <div className="settings-nav-bottom">
        <button type="button" className="settings-back-button" onClick={onBack}>
          <ChevronLeft aria-hidden="true" />
          <span>{backLabel}</span>
        </button>
      </div>
    </aside>
  );
}

/** Groups follow their first registry occurrence; pages retain order within each group. */
function groupPages(pages: readonly SettingsNavigationPage[]): SettingsNavigationGroup[] {
  const groups: SettingsNavigationGroup[] = [];
  const indexByLabel = new Map<string, number>();

  for (const page of pages) {
    const label = page.group?.trim() || undefined;
    const key = label || '__ungrouped__';
    let index = indexByLabel.get(key);
    if (index === undefined) {
      index = groups.length;
      indexByLabel.set(key, index);
      groups.push({ label, pages: [] });
    }
    groups[index].pages.push(page);
  }

  return groups;
}

function normalizeSearch(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

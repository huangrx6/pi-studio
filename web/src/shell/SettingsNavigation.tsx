import { useEffect, useId, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Search, X } from 'lucide-react';
import { isComposingKey, menuFocusIndex } from '../shared/keyboard-navigation';
import { isTextEntry, matchesShortcut } from '../shared/shortcuts';
import './styles/settings-navigation.css';

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
  searchPages?: readonly SettingsNavigationPage[];
  activeId: string;
  searchActiveId?: string;
  searchShortcut: string;
  onSelect: (id: string) => void;
  onPreload?: (id: string) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  ariaLabel?: string;
};

type SettingsNavigationGroup = {
  label?: string;
  pages: SettingsNavigationPage[];
};

const PAGE_SEARCH_ALIASES: Record<string, readonly string[]> = {
  general: ['外观', '主题', '字体', '字号', '背景', '壁纸', '圆角', '颜色', '深色', '浅色', '菜单栏', '托盘', '终端', '透明度', '柔化', '遮罩', '链接'],
  shortcuts: ['快捷键', '键盘', '热键', 'shortcut'],
  models: ['API', '密钥', '供应商', '模型来源', 'provider', 'thinking', '推理'],
  usage: ['统计', '费用', '成本', 'token', '用量', 'Metrics', '采集', '已移除', '项目'],
  tools: ['工具', '命令', 'bash', '终端', '工具方案', '扩展', 'MCP', '临时对话'],
  permissions: ['授权', '批准', '安全', '权限', '策略', '工具覆盖', '高级规则', '权限方案', '临时对话'],
  harness: ['提示词', '指令', 'prompt', 'AGENTS', '上下文', '重试', '超时', '压缩', '临时对话'],
  agents: ['主对话', '临时对话', '子智能体', '子代理', '多智能体', '并行', 'agent', '装配'],
  plugins: ['集成', 'Plugin', '市场', '安装'],
  git: ['Git', '仓库', '分支', '工作树', 'worktree', '差异'],
  network: ['proxy', '代理', '网络', 'VPN', '连接', 'HTTP', 'SOCKS', '超时'],
  browser: ['浏览器', 'Browser', 'CDP', 'Chrome', '下载', '历史', '网站权限', 'webview', '内嵌', '扩展'],
  'desktop-control': ['电脑操控', 'Desktop', 'Computer Use', '屏幕', '辅助功能', '窗口', '截图', '应用映射', '扩展'],
  archives: ['历史', '恢复', '归档'],
  about: ['版本', '更新', '帮助', '许可', '诊断'],
};

/**
 * Settings categories in the second column of the application sidebar.
 *
 * The component deliberately owns only navigation semantics and markup. The
 * parent remains responsible for the page registry and the active tab state,
 * so settings pages can be added without coupling them to this shell.
 */
export function SettingsNavigation({
  pages,
  searchPages = [],
  activeId,
  searchActiveId,
  searchShortcut,
  onSelect,
  onPreload,
  collapsed,
  onCollapsedChange,
  ariaLabel = '设置导航',
}: SettingsNavigationProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const focusSearchOnExpand = useRef(false);
  const pagesRef = useRef<HTMLDivElement>(null);
  const navigationId = useId();
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  const visiblePages = terms.length === 0 ? pages : [...pages, ...searchPages].filter((page) => {
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
  const currentId = terms.length ? (searchActiveId ?? activeId) : activeId;
  const focusablePageId = visiblePages.some((page) => page.id === currentId)
    ? currentId
    : visiblePages[0]?.id;

  // Normal expansion leaves search one Tab away.
  useEffect(() => {
    if (collapsed) return;
    const target = focusSearchOnExpand.current ? searchRef.current : navigationRef.current;
    focusSearchOnExpand.current = false;
    target?.focus({ preventScroll: true });
  }, [collapsed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesShortcut(event, searchShortcut)) return;
      if (isTextEntry(event.target) && !event.metaKey && !event.ctrlKey) return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (collapsed) {
        focusSearchOnExpand.current = true;
        onCollapsedChange(false);
      } else {
        searchRef.current?.focus({ preventScroll: true });
      }
    };
    // A custom shortcut can use a key handled by the navigation itself.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [collapsed, onCollapsedChange, searchShortcut]);

  function clearSearch() {
    setQuery('');
    searchRef.current?.focus();
  }

  function pageButtons() {
    return Array.from(pagesRef.current?.querySelectorAll<HTMLButtonElement>('[data-settings-page]') || []);
  }

  function focusPageAt(index: number) {
    pageButtons().at(index)?.focus();
  }

  return (
    <nav ref={navigationRef} className="sidebar-secondary settings-nav settings-navigation" aria-label={ariaLabel} tabIndex={-1}>
      <div className="settings-search settings-navigation-search" role="search" aria-label="搜索设置">
        <Search aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          aria-label="搜索设置"
          aria-controls={navigationId}
          placeholder="搜索设置…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (isComposingKey(event.nativeEvent)) return;
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              event.stopPropagation();
              clearSearch();
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
      <div ref={pagesRef} id={navigationId} className="settings-navigation-pages">
        {groups.map((group, groupIndex) => (
          <div className="settings-nav-group" key={group.label || `ungrouped-${groupIndex}`}>
            {group.label && <div className="nav-section-label">{group.label}</div>}
            {group.pages.map((page) => {
              const Icon = page.icon;
              const active = currentId === page.id;
              return (
                <button
                  key={page.id}
                  type="button"
                  className={`settings-nav-row ${active ? 'is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  data-settings-page={page.id}
                  tabIndex={page.id === focusablePageId ? 0 : -1}
                  onMouseEnter={() => onPreload?.(page.id)}
                  onFocus={() => onPreload?.(page.id)}
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
      </div>
      <span className="sr-only" role="status" aria-live="polite">{terms.length > 0 ? `找到 ${visiblePages.length} 个设置页面` : ''}</span>
    </nav>
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

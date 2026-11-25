import { SubagentAvatar } from '../subagents/SubagentAvatar';
import { FileKindIcon } from '../../shared/FileKindIcon';
import { ChevronLeft, ChevronRight, Command, FileText, Folder, Package, Plug, Sparkles } from 'lucide-react';
import type { MouseEvent } from 'react';
import { LoadingState } from '../../shared/LoadingState';
import type { ComposerCommand, ComposerCommandSource, ComposerMentionOption } from '../../types/chat-types';
import type { ComposerMenuState } from './useComposerSuggestions';
import { composerCapabilityCategories, type MentionCategory } from './composer-menu';

type ComposerSuggestionsProps = {
  menu: ComposerMenuState;
  commandOptions: ComposerCommand[];
  mentionOptions: ComposerMentionOption[];
  loading: boolean;
  error: string;
  activeIndex: number;
  workspace: string;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  onCategory: (category: MentionCategory) => void;
  onBack: () => void;
  onOpenMethods: (index: number) => void;
  onRetry: () => void;
};

const categories = [
  { key: 'file', label: '文件', sigil: '@' }, { key: 'agent', label: '智能体', sigil: '#' },
  { key: 'capability', label: '能力', sigil: '$' },
] as const;
const categoryIcons = { skill: Sparkles, mcp: Plug, plugin: Package };

function ComposerSourceIcon({ source }: { source: ComposerCommandSource }) {
  if (source === 'skill') return <Sparkles />;
  if (source === 'prompt') return <FileText />;
  if (source === 'extension') return <Plug />;
  return <Command />;
}

export function ComposerSuggestions({
  menu,
  commandOptions,
  mentionOptions,
  loading,
  error,
  activeIndex,
  workspace,
  onHover,
  onSelect,
  onCategory,
  onBack,
  onOpenMethods,
  onRetry,
}: ComposerSuggestionsProps) {
  const capabilityCategory = composerCapabilityCategories.find(category => category.type === menu.capabilityType);
  const choosingCategory = menu.kind === 'capability' && !capabilityCategory;
  const serverPicker = menu.capabilityType === 'mcp' && !menu.mcpServer;
  const backLabel = menu.mcpServer ? '返回 MCP 服务列表' : '返回引用类别';
  const optionCount = menu.kind === 'slash' ? commandOptions.length : mentionOptions.length;
  const optionProps = (index: number) => ({
    type: 'button' as const,
    role: 'option',
    id: `composer-suggestion-${index}`,
    tabIndex: -1,
    'aria-selected': index === activeIndex,
    className: `composer-option${index === activeIndex ? ' is-active' : ''}`,
    onMouseMove: () => onHover(index),
    onMouseDown: (event: MouseEvent<HTMLButtonElement>) => event.preventDefault(),
    onClick: () => onSelect(index),
  });
  return (
    <div className="composer-picker">
      {menu.kind === 'slash' ? <div className="composer-picker-head"><span>命令与技能</span>
        {loading ? <LoadingState>正在加载…</LoadingState> : <span>输入以筛选</span>}
      </div> : menu.kind === 'capability' ? <div className="composer-picker-head">
        {capabilityCategory ? <button type="button" className="composer-picker-back" aria-label={backLabel} title={backLabel}
          onMouseDown={event => event.preventDefault()} onClick={onBack}>
          <ChevronLeft aria-hidden="true" />{menu.mcpServer?.name ?? (serverPicker ? 'MCP 服务' : capabilityCategory.label)}
        </button> : <span>选择引用类别</span>}
      </div> : <div className="composer-reference-categories" role="group" aria-label="引用类别">
        {categories.map(({ key, label, sigil }) => <button type="button" key={key}
          aria-pressed={menu.kind === key}
          onMouseDown={event => event.preventDefault()} onClick={() => onCategory(key)}>
          <span aria-hidden="true">{sigil}</span>{label}</button>)}
      </div>}
      <div
        className="composer-picker-scroll"
        id="composer-suggestions"
        role="listbox"
        aria-label={menu.kind === 'slash' ? '命令与技能' : choosingCategory ? '引用类别' : '引用建议'}
        aria-busy={loading}
      >
        {menu.kind === 'slash' && ([
          { source: 'builtin', label: '命令' },
          { source: 'skill', label: '技能' },
          { source: 'prompt', label: '提示模板' },
          { source: 'extension', label: '扩展命令' },
        ] as const).map((group) => {
          const items = commandOptions.filter((command) => command.source === group.source);
          if (items.length === 0) return null;
          return <div className="composer-picker-group" key={group.source}>
            <div className="composer-picker-label">{group.label}<span>{items.length}</span></div>
            {items.map((command) => {
              const index = commandOptions.indexOf(command);
              return <button key={`${command.source}:${command.name}`} {...optionProps(index)}>
                <span className={`composer-option-icon is-${command.source}`}><ComposerSourceIcon source={command.source} /></span>
                <span className="composer-option-main"><strong>/{command.name}</strong><span>{command.description || '没有描述'}</span></span>
                {command.argumentHint && <code>{command.argumentHint}</code>}
              </button>;
            })}
          </div>;
        })}
        {choosingCategory && composerCapabilityCategories.map(({ type, label }, index) => {
          const Icon = categoryIcons[type];
          return <button key={type} {...optionProps(index)}>
            <span className="composer-option-icon"><Icon aria-hidden="true" /></span>
            <span className="composer-option-main"><strong>{label}</strong></span>
            <ChevronRight className="composer-option-next" aria-hidden="true" />
          </button>;
        })}
        {menu.kind !== 'slash' && !choosingCategory && mentionOptions.length > 0 && <div className="composer-picker-group">
          {menu.kind !== 'capability' && <div className="composer-picker-label">{menu.kind === 'file' ? '工作区文件与目录' : '智能体'}<span>{mentionOptions.length}</span></div>}
          {mentionOptions.map((item, index) => {
            if (item.type === 'mcp-server') return <div className="composer-mcp-server-row" key={item.id}>
              <button {...optionProps(index)} aria-label={`引用 MCP 服务 ${item.name}`} title={`引用整个 ${item.name} 服务`}>
                <span className="composer-option-icon"><Plug aria-hidden="true" /></span>
                <span className="composer-option-main"><strong>{item.name}</strong>
                  <span title={item.description || item.source}>{item.description || item.source}</span></span>
                {item.description && <span className="composer-option-origin" title={item.source}>{item.source}</span>}
              </button>
              <button type="button" className="composer-mcp-methods" tabIndex={-1}
                aria-label={`查看 ${item.name} 的方法`}
                onMouseDown={event => event.preventDefault()} onClick={() => onOpenMethods(index)}>
                {item.methodCount} 个方法<ChevronRight aria-hidden="true" />
              </button>
            </div>;
            return <button key={'path' in item ? item.path : item.id} {...optionProps(index)}>
              <span className={`composer-option-icon is-${item.type}`}>{item.type === 'agent' ? <SubagentAvatar id={item.avatarId} />
                : item.type === 'skill' ? <Sparkles /> : item.type === 'mcp' ? <Plug />
                : item.type === 'plugin' ? (item.iconDataUrl ? <img src={item.iconDataUrl} alt="" /> : <Package />)
                : item.type === 'directory' ? <Folder /> : <FileKindIcon path={item.path} />}</span>
              <span className="composer-option-main"><strong>{item.name}{item.type === 'directory' ? '/' : ''}</strong>
                <span title={'source' in item ? item.originalDescription || item.description : undefined}>
                  {'path' in item ? item.path + (item.type === 'directory' ? '/' : '') : item.type === 'mcp' ? item.originalDescription || item.description : item.description}</span></span>
              {'source' in item && !menu.mcpServer && <span className="composer-option-origin" title={item.source + (item.type === 'mcp' ? ' · ' + item.server : '')}>
                {item.source}{item.type === 'mcp' && <> · {item.server}</>}</span>}
            </button>;
          })}
        </div>}
        {loading && menu.kind !== 'slash' && <div className="composer-picker-empty"><LoadingState>正在读取引用…</LoadingState></div>}
        {!choosingCategory && !loading && !error && optionCount === 0 && <div className="composer-picker-empty">{menu.kind === 'slash' ? '没有匹配的命令'
          : menu.kind === 'file' ? workspace ? '没有匹配的文件或目录' : '选择工作区后即可引用文件'
          : menu.kind === 'agent' ? '没有匹配的子智能体'
          : menu.capabilityType === 'plugin' ? '没有匹配的可用插件'
          : menu.mcpServer ? '这个服务里没有匹配的方法' : serverPicker ? menu.query ? '没有匹配的 MCP 服务或方法' : '没有可引用的 MCP 服务' : '没有匹配的可用技能'}</div>}
      </div>
      {error && <div className="composer-picker-empty" role="alert"><span>建议读取失败：{error}</span><button type="button" className="settings-text-button" onClick={onRetry}>重试建议</button></div>}
      <div className="composer-picker-foot"><span>↑↓ 选择</span><span>{choosingCategory ? '↵ 进入' : serverPicker ? '↵ 引用' : '↵ 确认'}</span>
        {serverPicker && mentionOptions[activeIndex]?.type === 'mcp-server' && <span>→ 查看方法</span>}
        <span>{capabilityCategory ? 'Esc 返回' : 'Esc 关闭'}</span></div>
    </div>
  );
}

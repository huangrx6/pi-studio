import { Command, FileText, Folder, Plug, Sparkles } from 'lucide-react';
import type { ComposerCommand, ComposerCommandSource, ComposerFile } from '../../types/chat-types';
import type { ComposerMenuState } from './useComposerSuggestions';

type ComposerSuggestionsProps = {
  menu: ComposerMenuState;
  commandOptions: ComposerCommand[];
  fileOptions: ComposerFile[];
  loading: boolean;
  error: string;
  activeIndex: number;
  workspace: string;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  onRetry: () => void;
};

function ComposerSourceIcon({ source }: { source: ComposerCommandSource }) {
  if (source === 'skill') return <Sparkles />;
  if (source === 'prompt') return <FileText />;
  if (source === 'extension') return <Plug />;
  return <Command />;
}

export function ComposerSuggestions({
  menu,
  commandOptions,
  fileOptions,
  loading,
  error,
  activeIndex,
  workspace,
  onHover,
  onSelect,
  onRetry,
}: ComposerSuggestionsProps) {
  const optionCount = menu.kind === 'slash' ? commandOptions.length : fileOptions.length;
  return (
    <div className="composer-picker">
      <div className="composer-picker-head">
        <span>{menu.kind === 'slash' ? '命令与技能' : '引用工作区文件或目录'}</span>
        <span>{loading ? '正在加载…' : menu.kind === 'slash' ? '输入以筛选' : '↑↓ 选择文件或目录'}</span>
      </div>
      <div
        className="composer-picker-scroll"
        id="composer-suggestions"
        role="listbox"
        aria-label={menu.kind === 'slash' ? '命令与技能' : '工作区文件与目录'}
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
              return <button
                type="button"
                role="option"
                id={`composer-suggestion-${index}`}
                tabIndex={-1}
                aria-selected={index === activeIndex}
                key={`${command.source}:${command.name}`}
                className={`composer-option ${index === activeIndex ? 'is-active' : ''}`}
                onMouseEnter={() => onHover(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(index)}
              >
                <span className={`composer-option-icon is-${command.source}`}><ComposerSourceIcon source={command.source} /></span>
                <span className="composer-option-main"><strong>/{command.name}</strong><span>{command.description || '没有描述'}</span></span>
                {command.argumentHint && <code>{command.argumentHint}</code>}
              </button>;
            })}
          </div>;
        })}
        {menu.kind === 'file' && <div className="composer-picker-group">
          <div className="composer-picker-label">工作区文件与目录<span>{fileOptions.length}</span></div>
          {fileOptions.map((file, index) => <button
            type="button"
            role="option"
            id={`composer-suggestion-${index}`}
            tabIndex={-1}
            aria-selected={index === activeIndex}
            key={`${file.type}:${file.path}`}
            className={`composer-option ${index === activeIndex ? 'is-active' : ''}`}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(index)}
          >
            <span className={`composer-option-icon ${file.type === 'directory' ? 'is-directory' : 'is-file'}`}>{file.type === 'directory' ? <Folder /> : <FileText />}</span>
            <span className="composer-option-main"><strong>{file.name}{file.type === 'directory' ? '/' : ''}</strong><span>{file.path}{file.type === 'directory' ? '/' : ''}</span></span>
          </button>)}
        </div>}
        {!loading && !error && optionCount === 0 && <div className="composer-picker-empty">{menu.kind === 'slash' ? '没有匹配的命令' : workspace ? '没有匹配的文件或目录' : '请先选择一个工作区'}</div>}
      </div>
      {error && <div className="composer-picker-empty" role="alert"><span>建议读取失败：{error}</span><button type="button" className="settings-text-button" onClick={onRetry}>重试建议</button></div>}
      <div className="composer-picker-foot"><span>↑↓ 选择</span><span>↵ 确认</span><span>Esc 关闭</span></div>
    </div>
  );
}

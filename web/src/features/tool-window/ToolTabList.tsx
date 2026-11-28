import { useLayoutEffect, useRef } from 'react';
import { Blocks, Globe, SquareTerminal, X } from 'lucide-react';
import { ScrollableTabList } from '../../shared/ScrollableTabList';
import type { ToolTab } from '../../types/tool-window';

const icons = { browser: Globe, terminal: SquareTerminal, extension: Blocks };

export function ToolTabList({ tabs, active, visible, onSelect, onClose, onMenu }: {
  tabs: ToolTab[]; active: string; visible: boolean;
  onSelect: (tab: ToolTab) => void; onClose: (id: string) => void;
  onMenu: (id: string, anchor: HTMLButtonElement) => void;
}) {
  const activeSlot = useRef<HTMLDivElement>(null);
  const previousTabs = useRef(tabs);

  useLayoutEffect(() => {
    const previous = previousTabs.current;
    previousTabs.current = tabs;
    if (visible && active && !previous.some(tab => tab.id === active) && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      activeSlot.current?.classList.add('is-entering');
    }
  }, [active, tabs, visible]);

  return <ScrollableTabList activeId={active} visible={visible} className="tool-tab-list" role="navigation" label="工具标签页">
    {tabs.map(tab => {
      const Icon = icons[tab.kind];
      const current = active === tab.id;
      return <div className="tool-tab-slot" key={tab.id} ref={current ? activeSlot : undefined} data-current-tab={current || undefined}
        onAnimationEnd={event => event.currentTarget.classList.remove('is-entering')}>
        <div className="tool-tab" data-active={current}
          onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
          onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }}
          onContextMenu={event => {
            event.preventDefault();
            onMenu(tab.id, event.currentTarget.querySelector('button')!);
          }}>
          <button type="button" title={tab.title} aria-current={current ? 'page' : undefined} aria-keyshortcuts="Shift+F10"
            onClick={() => onSelect(tab)} onKeyDown={event => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault(); onMenu(tab.id, event.currentTarget);
              }
            }}>
            <Icon/><span>{tab.title}</span>
          </button>
          <button type="button" className="tool-tab-close" aria-label={'关闭 ' + tab.title} onClick={() => onClose(tab.id)}><X/></button>
        </div>
      </div>;
    })}
  </ScrollableTabList>;
}

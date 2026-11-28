import { Ellipsis, Settings } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { sidebarSections, type SidebarSection } from './app-shell-config';
import { HintButton } from '../shared/HintButton';

const sections = Object.keys(sidebarSections) as SidebarSection[];
const optional: SidebarSection[] = sections.filter(id => id !== 'conversations' && id !== 'temporary');
const storageKey = 'pi-studio:sidebar-pinned-sections';

function readPins(): SidebarSection[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return optional.filter(id => Array.isArray(stored) && stored.includes(id));
  } catch { return []; }
}

export function SidebarRail({ section, hidden, onSelect, onSettings }: {
  section: SidebarSection | 'settings'; hidden: boolean;
  onSelect: (id: SidebarSection) => void; onSettings: () => void;
}) {
  const [pins, setPins] = useState(readPins);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const overflowActive = section !== 'settings' && optional.includes(section) && !pins.includes(section);
  useEffect(() => { panel.current?.hidePopover(); }, [hidden, section]);

  function togglePin(key: SidebarSection) {
    const next = pins.includes(key) ? pins.filter(item => item !== key) : [...pins, key];
    setPins(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep window preference in memory. */ }
  }

  return <nav className="sidebar-rail" aria-label="主导航">
    <div className="sidebar-rail-sections">
      {sections.filter(key => !optional.includes(key) || pins.includes(key)).map(key => {
        const { label, icon: Icon } = sidebarSections[key];
        return <HintButton key={key} placement="right" data-sidebar-section={key}
          className={`icon-button sidebar-rail-button${section === key ? ' is-active' : ''}`}
          aria-current={section === key ? 'page' : undefined} aria-label={label} onClick={() => onSelect(key)}>
          <Icon aria-hidden="true" />
        </HintButton>;
      })}
      <HintButton placement="right" aria-label="更多" hint={overflowActive ? `当前栏目为${sidebarSections[section].label}，点此切换或固定栏目` : '打开更多栏目，或将常用栏目固定到侧边栏'}
        className={`icon-button sidebar-rail-button${overflowActive ? ' is-active' : ''}`}
        {...{ popovertarget: id }} aria-controls={id}>
        <Ellipsis aria-hidden="true" />
      </HintButton>
      <div ref={panel} id={id} {...{ popover: 'auto' }} role="group" aria-label="更多栏目" className="sidebar-more">
        <div className="sidebar-more-heading" aria-hidden="true"><span>打开栏目</span><span>固定</span></div>
        {optional.map(key => {
          const { label, icon: Icon } = sidebarSections[key];
          return <div key={key} className="sidebar-more-row">
            <button type="button" aria-current={section === key ? 'page' : undefined}
              onClick={() => { panel.current?.hidePopover(); onSelect(key); }}>
              <Icon aria-hidden="true" /><span>{label}</span>
            </button>
            <label title={pins.includes(key) ? '取消固定' : '固定到侧边栏'}>
              <input type="checkbox" aria-label={`固定${label}到侧边栏`} checked={pins.includes(key)} onChange={() => togglePin(key)} />
            </label>
          </div>;
        })}
      </div>
    </div>
    <div className="sidebar-bottom">
      <HintButton placement="right" className={`icon-button sidebar-rail-button bottom-row${section === 'settings' ? ' is-active' : ''}`}
        aria-label="设置" aria-current={section === 'settings' ? 'page' : undefined}
        onClick={section === 'settings' ? undefined : onSettings}><Settings aria-hidden="true" /></HintButton>
    </div>
  </nav>;
}

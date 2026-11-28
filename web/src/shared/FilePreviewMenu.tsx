import { useEffect, useId, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { ActionMenu, type MenuAction } from './ActionMenu';

export type FileOpenWith = {
  loadApplications: () => Promise<MenuAction[]>;
  openDefault: () => void;
  reveal: MenuAction;
};

function ApplicationsMenu({ anchor, id, openWith, onBack, onClose }: {
  anchor: HTMLButtonElement; id: string; openWith: FileOpenWith; onBack: () => void; onClose: () => void;
}) {
  const [apps, setApps] = useState<MenuAction[]>([]);
  const [message, setMessage] = useState('正在读取应用…');
  const { loadApplications } = openWith;
  useEffect(() => {
    let current = true;
    setApps([]);
    setMessage('正在读取应用…');
    void loadApplications().then(list => {
      if (!current) return;
      setApps(list);
      setMessage('没有其他可用应用');
    }, () => { if (current) setMessage('无法读取其他应用'); });
    return () => { current = false; };
  }, [loadApplications]);
  return <ActionMenu anchor={anchor} placement="below" align="end" className="file-actions-menu" id={id}
    label="打开方式" initialFocus="default" onClose={onClose} items={[
      { label: '返回文件操作', navigation: 'back', run: onBack },
      { id: 'default', label: '用默认应用打开', dividerBefore: true, run: openWith.openDefault },
      ...(apps.length ? apps : [{ label: message, disabled: true, run() {} }]),
    ]} />;
}

export function FilePreviewMenu({ items, openWith }: { items: MenuAction[]; openWith?: FileOpenWith }) {
  const id = useId();
  const [menu, setMenu] = useState<{ anchor: HTMLButtonElement; page: 'file' | 'applications'; initialFocus?: string }>();
  if (!items.length && !openWith) return null;
  const close = () => setMenu(undefined);
  const actions = openWith ? [...items,
    { id: 'open-with', label: '打开方式', navigation: 'forward' as const, dividerBefore: true,
      run: () => { if (menu) setMenu({ anchor: menu.anchor, page: 'applications' }); } },
    openWith.reveal,
  ] : items;
  return <>
    <button type="button" className="icon-button" aria-label="文件操作" title="更多文件操作" aria-haspopup="menu"
      aria-expanded={Boolean(menu)} aria-controls={menu ? id : undefined}
      onClick={event => setMenu(menu ? undefined : { anchor: event.currentTarget, page: 'file' })}><MoreHorizontal aria-hidden="true" /></button>
    {menu && (menu.page === 'applications' && openWith
      ? <ApplicationsMenu anchor={menu.anchor} id={id} openWith={openWith}
        onBack={() => setMenu({ anchor: menu.anchor, page: 'file', initialFocus: 'open-with' })} onClose={close} />
      : <ActionMenu anchor={menu.anchor} placement="below" align="end" id={id} className="file-actions-menu" items={actions}
        initialFocus={menu.initialFocus} onClose={close} />)}
  </>;
}

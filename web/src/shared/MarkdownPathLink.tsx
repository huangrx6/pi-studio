/**
 * A local path rendered as an in-text link.
 *
 * Left click asks the host to open the file preview; right click offers the same
 * actions the file panel already exposes (Finder, applications, copy path).
 * Paths resolve against the conversation working directory, so relative
 * deliverables such as `travel/一周旅游计划.md` open where the model meant.
 */
import { useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { ActionMenu, type MenuAction } from './ActionMenu';
import { resolvePathToken } from './file-path-links.mjs';
import { MarkdownActions } from './markdown-actions';

type FileApp = { name: string; path: string; icon?: string };

export function MarkdownPathLink({ path, children }: { path: string; children: ReactNode }) {
  const { cwd, openFile, openLocalFile } = useContext(MarkdownActions);
  const [menu, setMenu] = useState<{ x: number; y: number; apps: FileApp[] } | null>(null);
  const target = resolvePathToken(path, cwd);

  async function openMenu(x: number, y: number) {
    setMenu({ x, y, apps: [] });
    try {
      const source = target.startsWith('/') || target.startsWith('~/') ? 'external' : 'workspace';
      const result = await window.piApi.fileActions({ cwd, path: target, source });
      setMenu((current) => (current ? { ...current, apps: result.apps.slice(0, 6) } : current));
    } catch {
      // Applications are a convenience: keep the menu usable without them.
    }
  }

  const items: MenuAction[] = menu ? [
    { label: '打开预览', run: () => (openLocalFile || openFile)?.(target) },
    { label: '在 Finder 中显示', run: () => { const source = target.startsWith('/') || target.startsWith('~/') ? 'external' : 'workspace'; void window.piApi.revealFile({ cwd, path: target, source }); } },
    ...menu.apps.map((app) => ({
      label: `用 ${app.name} 打开`,
      run: () => { const source = target.startsWith('/') || target.startsWith('~/') ? 'external' : 'workspace'; void window.piApi.openWith({ cwd, path: target, source, appPath: app.path }); },
    })),
    {
      label: '复制路径',
      run: () => {
        void navigator.clipboard?.writeText(target);
      },
    },
  ] : [];

  return <>
    <a
      className="md-path-link"
      href="#"
      title={target}
      onClick={(event) => {
        event.preventDefault();
        (openLocalFile || openFile)?.(target);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        void openMenu(event.clientX, event.clientY);
      }}
    >{children}</a>
    {menu && items.length > 0 && (
      <ActionMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
    )}
  </>;
}

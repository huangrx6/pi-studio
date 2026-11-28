import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import { Files } from 'lucide-react';
import { BranchIcon } from '../../features/git/git-icons';
import GitWorkspacePage from '../../features/git/GitWorkspacePage';
import { restoreDismissedFocus } from '../../shared/keyboard-navigation';
import { WorkspaceFiles } from './WorkspaceFiles';
import type { SessionWorkbench } from './useAppWorkbench';

export function WorkbenchPane({
  controller,
  toggleRef,
  gitSessionId,
  openGitFile,
}: {
  controller: SessionWorkbench;
  toggleRef: RefObject<HTMLButtonElement>;
  gitSessionId?: string;
  openGitFile: (root: string, path: string) => void;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | undefined>(undefined);
  const { layout, closePanel, panelWidth, panelMaxWidth, panelOverlay, resizePanel } = controller;
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('dialog[open],[role=dialog],[role=menu]')
      )
        return;
      if (
        panelOverlay ||
        (event.target instanceof Element && event.target.closest('.file-panel'))
      ) {
        event.preventDefault();
        closePanel();
        if (event.target instanceof Element && event.target.closest('.file-panel'))
          restoreDismissedFocus(toggleRef.current);
      }
    }
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [panelOverlay, closePanel, toggleRef]);
  return (
    <>
      {panelOverlay && (
        <button className="file-panel-backdrop" aria-label="关闭右侧面板" onClick={closePanel} />
      )}
      <aside
        id="workspace-side-panel"
        className={'file-panel is-open' + (panelOverlay ? ' is-overlay' : '')}
        style={{ '--panel-w': panelWidth + 'px' } as CSSProperties}
        aria-label="工作区侧栏"
      >
        <nav className="workspace-side-modes" aria-label="工作区视图">
          <button aria-pressed={layout.side === 'files'} onClick={controller.openFilesTab}>
            <Files />
            文件
          </button>
          {gitSessionId && (
            <button aria-pressed={layout.side === 'git'} onClick={() => controller.openGitTab()}>
              <BranchIcon aria-hidden="true" />
              Git
            </button>
          )}
        </nav>
        <div
          className="panel-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧面板宽度"
          tabIndex={0}
          aria-valuenow={panelWidth}
          aria-valuemin={320}
          aria-valuemax={panelMaxWidth}
          onPointerDown={(e) => {
            if (e.button !== 0 || drag.current) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { pointerId: e.pointerId, x: e.clientX, width: panelWidth };
          }}
          onPointerMove={(e) => {
            if (drag.current?.pointerId === e.pointerId) resizePanel(drag.current.width + drag.current.x - e.clientX);
          }}
          onLostPointerCapture={(e) => {
            if (drag.current?.pointerId === e.pointerId) drag.current = undefined;
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              resizePanel(panelWidth + (e.key === 'ArrowLeft' ? 24 : -24));
            }
          }}
        />
        <div className="file-panel-inner">
          <div className="panel-body">
            {layout.side === 'git' && gitSessionId ? (
                <GitWorkspacePage
                  sessionId={gitSessionId}
                  tab={layout.gitPage}
                  onTab={controller.openGitTab}
                  openFile={openGitFile}
                  onOpenDiff={controller.openGitDiff}
                />
              ) : (
                <WorkspaceFiles
                  key={JSON.stringify([controller.owner, controller.cwd])}
                  selected={controller.activeTab?.kind === 'file' && controller.activeTab.source === 'workspace' && controller.activeTab.cwd === controller.cwd ? controller.activeTab.path : undefined}
                  cwd={controller.cwd}
                  state={layout.files}
                  update={controller.updateFiles}
                  actions={controller.treeActions}
                  open={(path, preview, line) =>
                    void controller.openFile(path, undefined, 'workspace', { preview, line })
                  }
                />
              )}
          </div>
        </div>
      </aside>
    </>
  );
}

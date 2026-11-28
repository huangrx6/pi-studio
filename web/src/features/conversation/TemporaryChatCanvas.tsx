import { ShellHeader } from '../../shell/ShellLayout';
import { TemporaryChat } from './TemporaryChat';

export function TemporaryChatCanvas({ id, tabs, layout, onManage, onExpandSidebar }: {
  layout: import('../../shell/right-panel/useAppWorkbench').SessionWorkbench;
  tabs?: import('react').ReactNode;
  id: string;
  onManage: () => void;
  onExpandSidebar?: () => void;
}) {
  return <>
    <ShellHeader className="chat-header" onExpandSidebar={onExpandSidebar}>
      {tabs}
    </ShellHeader>
    <main className="main shell-canvas temporary-main-canvas" aria-label="临时对话">
      <TemporaryChat key={id} id={id} savedScroll={layout.layout.chatScroll} layoutReady={layout.ready} onScrollPosition={top=>layout.scroll('chat',top)} onManage={onManage} />
    </main>
  </>;
}

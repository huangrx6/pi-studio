import { lazy, memo, Suspense, useMemo, type ReactNode } from 'react';
import { LoadingState } from '../../shared/LoadingState';
import type { Preferences } from '../../shared/preferences';
import type { PanelTab } from '../app-types';
import type { GitTab } from '../../types/git-types';
import type { ModelSelection } from '../../types/model-types';
import type { SessionStateForPersistence } from '../../features/conversation/useMessageDelivery';
import type { useSubagentWorkspace } from '../../features/subagents/useSubagentWorkspace';
import { buildTraceSummary } from '../../features/conversation/trace-model';
import { TodoHistory } from '../../features/conversation/TodoHistory';
import { ExtensionSlot } from '../../features/extensions/ExtensionSlot';
import {
  ExtensionViewPanel,
  type ExtensionViewWorkspace,
  type OpenTemporaryChatOptions,
} from '../../features/extensions/ExtensionViewPanel';
import type { ExtensionPanelPickerProps } from '../../features/extensions/ExtensionPanelPicker';
import { ConversationTracePage } from '../ConversationTracePage';

const GitWorkspacePage = lazy(() => import('../../features/git/GitWorkspacePage'));
const ConversationTasksPage = lazy(() => import('../../features/conversation/ConversationTasksPage'));
const SubagentOverview = lazy(async () => {
  const { SubagentOverview } = await import('../../features/subagents/SubagentViews');
  return { default: SubagentOverview };
});
const SubagentTranscriptView = lazy(async () => {
  const { SubagentTranscriptView } = await import('../../features/subagents/SubagentViews');
  return { default: SubagentTranscriptView };
});

export type SessionWorkbenchPanelProps = {
  tab: PanelTab;
  session: SessionStateForPersistence;
  preferences: Preferences;
  workspaces: ExtensionViewWorkspace[];
  modelSelection: ModelSelection;
  progress: ReactNode;
  trace: Parameters<typeof buildTraceSummary>[0];
  subagents: ReturnType<typeof useSubagentWorkspace>;
  extensions: ExtensionPanelPickerProps;
  onOpenTemporaryChat: (options?: OpenTemporaryChatOptions) => void;
  onOpenProgress: (page?: PanelTab['progressPage']) => void;
  onOpenGit: (page?: GitTab) => void;
  onOpenGitFile: (root: string, path: string) => void;
  onOpenFile: (path: string) => void;
  onFocusConversation: () => void;
};

const TracePanel = memo(function TracePanel({ trace }: Pick<SessionWorkbenchPanelProps, 'trace'>) {
  const summary = useMemo(() => buildTraceSummary(trace), [trace]);
  return <ConversationTracePage summary={summary} />;
});

export const SessionWorkbenchPanel = memo(function SessionWorkbenchPanel({
  tab, session, preferences, workspaces, modelSelection, progress, trace, subagents, extensions,
  onOpenTemporaryChat, onOpenProgress, onOpenGit, onOpenGitFile, onOpenFile, onFocusConversation,
}: SessionWorkbenchPanelProps) {
  if (tab.kind === 'extension' && tab.extensionPanel) {
    const { surface, cwd, sessionId, modelRef, onOpenSettings, onSendPrompt, onNotify } = extensions;
    const panels = extensions.groups.find(group => group.panels[0].extensionId === tab.extensionPanel?.extensionId)?.panels ?? [];
    const selected = panels.find(panel => panel.id === tab.extensionPanel?.panelId);
    if (selected?.view) {
      return <div className="extension-workbench-panel is-view">
        {panels.length > 1 && <nav className="extension-workbench-tabs" aria-label="扩展面板">
          {panels.map(panel => <button key={panel.id} type="button" aria-current={panel.id === tab.extensionPanel?.panelId ? 'page' : undefined}
            onClick={() => extensions.onOpenPanel(panel.id)}>{panel.title}</button>)}
        </nav>}
        <ExtensionViewPanel
          view={selected.view}
          title={selected.title}
          cwd={cwd}
          sessionId={sessionId}
          workspaces={workspaces}
          generation={surface.syncedAt}
          onSendPrompt={onSendPrompt}
          onOpenTemporaryChat={onOpenTemporaryChat}
          onNotify={onNotify}
        />
      </div>;
    }
    return <div className="extension-workbench-panel">
      {panels.length > 1 && <nav className="extension-workbench-tabs" aria-label="扩展面板">
        {panels.map(panel => <button key={panel.id} type="button" aria-current={panel.id === tab.extensionPanel?.panelId ? 'page' : undefined}
          onClick={() => extensions.onOpenPanel(panel.id)}>{panel.title}</button>)}
      </nav>}
      <ExtensionSlot slot="panel.side" presentation="page" snapshot={surface} selectedItemId={tab.extensionPanel.panelId}
        cwd={cwd} sessionId={sessionId} modelRef={modelRef} onOpenSettings={onOpenSettings}
        onSendPrompt={onSendPrompt} onNotify={onNotify} onOpenPanel={extensions.onOpenPanel} />
    </div>;
  }
  if (!session) return null;
  if (tab.kind === 'progress') {
    if (!tab.progressPage || tab.progressPage === 'summary') return progress;
    const detail = { sessionId: session.id, goalUpdatedAt: session.longTask?.updatedAt, onBack: () => onOpenProgress('summary') };
    return tab.progressPage === 'tasks' ? <Suspense fallback={<LoadingState variant="panel">正在读取任务…</LoadingState>}>
      <ConversationTasksPage {...detail} />
    </Suspense> : <TodoHistory {...detail} />;
  }
  if (tab.kind === 'trace') return preferences.showCodeView ? <TracePanel trace={trace} /> : null;
  if (tab.kind === 'git') return <Suspense fallback={<LoadingState variant="panel">正在读取 Git…</LoadingState>}>
    <GitWorkspacePage sessionId={session.id} tab={tab.gitPage ?? 'changes'} onTab={onOpenGit}
      diffPreferences={preferences} openFile={onOpenGitFile} />
  </Suspense>;
  if (tab.kind === 'subagents') {
    const child = subagents.activeChild;
    return <div className="agent-workspace">
      <Suspense fallback={<LoadingState variant="panel">正在加载子智能体…</LoadingState>}>
        <SubagentOverview hidden={Boolean(child)} children={subagents.subagentChildren} budget={subagents.subagentBudget}
          selection={modelSelection} refreshing={subagents.subagentRefreshing} error={subagents.subagentListError}
          onRefresh={() => void subagents.refreshSubagentChildren(true)} onOpenChild={subagents.openAgentTranscript}
          onDeleteChild={child => void subagents.deleteSubagent(child)} onReplyChild={subagents.replySubagentSupervisor}
          deletingChildKey={subagents.subagentDeletingKey || undefined} replyingChildKey={subagents.subagentReplyingKey || undefined}
          onReturnMain={onFocusConversation} mode={subagents.subagentOverviewMode} onModeChange={subagents.setSubagentOverviewMode} />
        {child && <SubagentTranscriptView key={child.key} child={child}
          transcript={subagents.subagentTranscript} loading={subagents.subagentLoading} error={subagents.subagentError}
          onRetry={() => subagents.openAgentTranscript(child)} stepDisplay={preferences.stepDisplay}
          stepCollapse={preferences.stepCollapse} showCodeView={preferences.showCodeView}
          onBackMain={onFocusConversation} onOverview={subagents.openAgentOverview} onOpenFile={onOpenFile} />}
      </Suspense>
    </div>;
  }
  return null;
});

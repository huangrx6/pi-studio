import type { Inspection } from './session-inspection';
import { lazy, memo, Suspense, useMemo, type ReactNode } from 'react';
import { Activity, ListChecks, Users } from 'lucide-react';
import { LoadingState } from '../shared/LoadingState';
import type { Preferences } from '../shared/preferences';
import type { InspectorTab } from './app-types';
import type { ModelSelection } from '../types/model-types';
import type { SessionStateForPersistence } from '../features/conversation/useMessageDelivery';
import type { useSubagentWorkspace } from '../features/subagents/useSubagentWorkspace';
import { buildTraceSummary } from '../features/conversation/trace-model';
import { TodoHistory } from '../features/conversation/TodoHistory';
import { ConversationTracePage } from './ConversationTracePage';

const ConversationTasksPage = lazy(() => import('../features/conversation/ConversationTasksPage'));
const SubagentOverview = lazy(async () => {
  const { SubagentOverview } = await import('../features/subagents/SubagentViews');
  return { default: SubagentOverview };
});
const SubagentTranscriptView = lazy(async () => {
  const { SubagentTranscriptView } = await import('../features/subagents/SubagentViews');
  return { default: SubagentTranscriptView };
});

const TraceView = memo(function TraceView({ trace }: { trace: Parameters<typeof buildTraceSummary>[0] }) {
  const summary = useMemo(() => buildTraceSummary(trace), [trace]);
  return <ConversationTracePage summary={summary} />;
});

export type SessionInspectorPanelProps = {
  view: Inspection;
  session: NonNullable<SessionStateForPersistence>;
  preferences: Preferences;
  modelSelection: ModelSelection;
  progress: ReactNode;
  trace: Parameters<typeof buildTraceSummary>[0];
  subagents: ReturnType<typeof useSubagentWorkspace>;
  onSelectTab: (next: InspectorTab) => void;
  onOpenProgress: (page?: Inspection['progressPage']) => void;
  onOpenFile: (path: string) => void;
  onFocusConversation: () => void;
};

export const SessionInspectorPanel = memo(function SessionInspectorPanel({
  view,
  session,
  preferences,
  modelSelection,
  progress,
  trace,
  subagents,
  onSelectTab,
  onOpenProgress,
  onOpenFile,
  onFocusConversation,
}: SessionInspectorPanelProps) {
  const runningSubagents = subagents.subagentChildren.filter((child) => child.status === 'running' || child.status === 'pending').length;
  const availableTabs: Array<{ id: InspectorTab; label: string; icon: ReactNode; badge?: number }> = [
    { id: 'progress', label: '进展', icon: <ListChecks aria-hidden="true" /> },
    ...(preferences.showCodeView ? [{ id: 'trace' as const, label: '轨迹', icon: <Activity aria-hidden="true" /> }] : []),
    {
      id: 'subagents',
      label: '子智能体',
      icon: <Users aria-hidden="true" />,
      badge: runningSubagents > 0 ? runningSubagents : undefined,
    },
  ];

  const requested = view.tab;
  const activeTab: InspectorTab = availableTabs.some((item) => item.id === requested)
    ? requested
    : availableTabs[0].id;


  return (
    <div className="session-inspector">
      <nav className="session-inspector-tabs" role="tablist" aria-label="会话检视视图">
        {availableTabs.map((item) => {
          const selected = item.id === activeTab;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`session-inspector-tab${selected ? ' is-active' : ''}`}
              onClick={() => onSelectTab(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.badge !== undefined && <small className="session-inspector-badge">{item.badge}</small>}
            </button>
          );
        })}
      </nav>

      <div className="session-inspector-body" role="tabpanel">
        {activeTab === 'progress' && (() => {
          if (!view.progressPage || view.progressPage === 'summary') return progress;
          const detail = {
            sessionId: session.id,
            goalUpdatedAt: session.longTask?.updatedAt,
            onBack: () => onOpenProgress('summary'),
          };
          return view.progressPage === 'tasks' ? (
            <Suspense fallback={<LoadingState variant="panel">正在读取任务…</LoadingState>}>
              <ConversationTasksPage {...detail} />
            </Suspense>
          ) : (
            <TodoHistory {...detail} />
          );
        })()}

        {activeTab === 'trace' && preferences.showCodeView && <TraceView trace={trace} />}

        {activeTab === 'subagents' && (() => {
          const child = subagents.activeChild;
          return (
            <div className="agent-workspace">
              <Suspense fallback={<LoadingState variant="panel">正在加载子智能体…</LoadingState>}>
                <SubagentOverview
                  hidden={Boolean(child)}
                  children={subagents.subagentChildren}
                  budget={subagents.subagentBudget}
                  selection={modelSelection}
                  refreshing={subagents.subagentRefreshing}
                  error={subagents.subagentListError}
                  onRefresh={() => void subagents.refreshSubagentChildren(true)}
                  onOpenChild={subagents.openAgentTranscript}
                  onDeleteChild={(target) => void subagents.deleteSubagent(target)}
                  onReplyChild={subagents.replySubagentSupervisor}
                  deletingChildKey={subagents.subagentDeletingKey || undefined}
                  replyingChildKey={subagents.subagentReplyingKey || undefined}
                  onReturnMain={onFocusConversation}
                  mode={subagents.subagentOverviewMode}
                  onModeChange={subagents.setSubagentOverviewMode}
                />
                {child && (
                  <SubagentTranscriptView
                    key={child.key}
                    child={child}
                    transcript={subagents.subagentTranscript}
                    loading={subagents.subagentLoading}
                    error={subagents.subagentError}
                    onRetry={() => subagents.openAgentTranscript(child)}
                    stepDisplay={preferences.stepDisplay}
                    stepCollapse={preferences.stepCollapse}
                    showCodeView={preferences.showCodeView}
                    onBackMain={onFocusConversation}
                    onOverview={subagents.openAgentOverview}
                    onOpenFile={onOpenFile}
                  />
                )}
              </Suspense>
            </div>
          );
        })()}

      </div>
    </div>
  );
});

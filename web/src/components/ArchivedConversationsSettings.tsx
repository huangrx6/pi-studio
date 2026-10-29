import { useState } from 'react';
import {
  ArchiveRestore,
  Clock3,
  Folder,
  MessageSquareText,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type { ConversationSummary } from '../types/durable-types';
import { SettingsPageHeader } from './SettingsPageHeader';
import {
  SettingsResourceCard,
  SettingsResourceCardBody,
  SettingsResourceCardFooter,
  SettingsResourceCardIcon,
  SettingsResourceCardMain,
} from './SettingsResourceCard';

type ArchivedWorkspace = {
  cwd: string;
  name: string;
  sessions: ConversationSummary[];
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function updatedLabel(value: number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function ArchivedConversationsSettings({
  workspaces,
  onRestore,
  onDelete,
}: {
  workspaces: ArchivedWorkspace[];
  onRestore: (session: ConversationSummary) => Promise<void>;
  onDelete: (session: ConversationSummary) => Promise<void>;
}) {
  const [pending, setPending] = useState('');
  const [error, setError] = useState<string | null>(null);
  const groups = workspaces
    .map((workspace) => ({
      ...workspace,
      sessions: workspace.sessions.filter((session) => session.archived),
    }))
    .filter((workspace) => workspace.sessions.length > 0);
  const total = groups.reduce((sum, workspace) => sum + workspace.sessions.length, 0);

  async function run(session: ConversationSummary, action: 'restore' | 'delete') {
    const key = `${session.id}:${action}`;
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      if (action === 'restore') await onRestore(session);
      else await onDelete(session);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending('');
    }
  }

  return <div className="settings-sections archived-conversations-settings">
    <SettingsPageHeader
      icon={<ArchiveRestore />}
      title="归档会话"
      meta={<span className="count-badge">{total}</span>}
      description="归档会话仍完整保存在 Pi Studio 的本地数据库中。恢复后会回到对应工作区；永久删除会同时清理子智能体、消息、任务、附件和关联设置。"
    />

    {error && <div className="settings-error" role="alert">{error}</div>}

    {groups.length === 0
      ? <div className="archive-settings-empty">
        <span><ArchiveRestore /></span>
        <strong>没有归档会话</strong>
        <p>在侧边栏归档的会话会集中显示在这里，方便日后恢复或永久删除。</p>
      </div>
      : groups.map((workspace) => <section className="archive-workspace-section" key={workspace.cwd}>
        <header className="archive-workspace-heading">
          <span><Folder /><strong>{workspace.name}</strong></span>
          <span>{workspace.sessions.length} 个归档会话</span>
        </header>
        <div className="archive-session-list">
          {workspace.sessions.map((session) => {
            const restoring = pending === `${session.id}:restore`;
            const deleting = pending === `${session.id}:delete`;
            const busy = Boolean(pending);
            return <SettingsResourceCard className="archive-session-card" key={session.id}>
              <SettingsResourceCardMain className="archive-session-main">
                <SettingsResourceCardIcon className="archive-session-icon">
                  <MessageSquareText />
                </SettingsResourceCardIcon>
                <SettingsResourceCardBody className="archive-session-body">
                  <strong>{session.title || '未命名会话'}</strong>
                  <span className="archive-session-path" title={workspace.cwd}><code>{workspace.cwd}</code></span>
                  <span className="archive-session-meta">
                    <span className={`archive-session-kind is-${session.kind}`}>{session.kind === 'durable' ? '长期任务' : '对话'}</span>
                    <span><Clock3 />{updatedLabel(session.updatedAt)}</span>
                    {session.pinned && <span>已置顶</span>}
                  </span>
                </SettingsResourceCardBody>
              </SettingsResourceCardMain>
              <SettingsResourceCardFooter>
                <span className="archive-session-id" title={session.id}>ID {session.id.slice(0, 8)}</span>
                <button
                  type="button"
                  className="settings-outline archive-restore-button"
                  disabled={busy}
                  onClick={() => void run(session, 'restore')}
                >
                  {restoring ? <RotateCcw className="spin" /> : <ArchiveRestore />}
                  {restoring ? '恢复中' : '恢复会话'}
                </button>
                <button
                  type="button"
                  className="archive-delete-button"
                  disabled={busy}
                  onClick={() => void run(session, 'delete')}
                >
                  <Trash2 />
                  {deleting ? '删除中' : '永久删除'}
                </button>
              </SettingsResourceCardFooter>
            </SettingsResourceCard>;
          })}
        </div>
      </section>)}
  </div>;
}

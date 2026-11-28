import { memo, type ReactNode } from 'react';
import {
  ArrowUp, Download,
} from 'lucide-react';
import { LoadingIndicator } from '../shared/LoadingState';
import { ShellHeader } from './ShellLayout';

export type UpdateEntryState = 'available' | 'downloading' | 'downloaded';

type ConversationHeaderProps = {
  tabs?: ReactNode;
  update?: {
    state: UpdateEntryState;
    latestVersion?: string;
    /** 0–100；下载中用于环形进度。未知时不传。 */
    progress?: number | null;
    onOpen: () => void;
  } | null;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  isNewConversation: boolean;
  title: string;

};

function ConversationHeaderComponent({
  tabs, sidebarCollapsed,
  onExpandSidebar,
  isNewConversation,
  title,
  update,
}: ConversationHeaderProps) {
  return (
      <ShellHeader className="chat-header" onExpandSidebar={sidebarCollapsed ? onExpandSidebar : undefined}>
        {(tabs || !isNewConversation) && <div className="chat-heading">
          {tabs ?? <h1 title={title}>{title}</h1>}
        </div>}
        <div className="chat-actions">
          {update && <button
            type="button"
            className={`icon-button update-entry is-${update.state}`}
            aria-label={update.state === 'downloaded'
              ? '更新已下载，点击安装'
              : update.state === 'downloading'
                ? '正在下载更新，点击查看进度'
                : `有新版本${update.latestVersion ? ` v${update.latestVersion}` : ''}，点击查看`}
            title={update.state === 'downloaded'
              ? '更新已下载，点击安装'
              : update.state === 'downloading'
                ? '正在下载更新'
                : `发现新版本${update.latestVersion ? ` v${update.latestVersion}` : ''}`}
            onClick={update.onOpen}
          >
            {update.state === 'downloading' && (
              <svg className="update-entry-ring" viewBox="0 0 32 32" aria-hidden="true">
                <circle className="update-entry-ring-track" cx="16" cy="16" r="13" />
                <circle
                  className="update-entry-ring-value"
                  cx="16"
                  cy="16"
                  r="13"
                  style={{
                    strokeDasharray: `${2 * Math.PI * 13}`,
                    strokeDashoffset: `${2 * Math.PI * 13 * (1 - Math.min(1, Math.max(0, (update.progress ?? 8) / 100)))}`,
                  }}
                />
              </svg>
            )}
            {update.state === 'downloading' ? <LoadingIndicator /> : update.state === 'downloaded' ? <ArrowUp /> : <Download />}
          </button>}
        </div>
      </ShellHeader>
  );
}

/** Stable chrome while only the composer or transcript updates underneath. */
export const ConversationHeader = memo(ConversationHeaderComponent);

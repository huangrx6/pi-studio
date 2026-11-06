import { FolderOpen, SlidersHorizontal } from 'lucide-react';
import './new-conversation-welcome.css';

type NewConversationWelcomeProps = {
  hasWorkspace: boolean;
  loading: boolean;
  hasModel: boolean;
  hasDraft: boolean;
  onConfigureModel: () => void;
  onChooseWorkspace: () => void;
  onSelectPrompt: (prompt: string) => void;
};

const SUGGESTIONS = [
  { label: '了解项目', prompt: '请阅读这个项目，说明它的用途、代码结构和主要运行方式。' },
  { label: '检查问题', prompt: '请检查这个项目，找出有代码依据的问题，按影响排序并给出改进建议。' },
  { label: '运行验证', prompt: '请先阅读项目说明，确认合适的验证命令，再运行检查并报告结果。' },
];

/** Only show setup actions that are still needed; selecting a prompt never submits it. */
export function NewConversationWelcome({
  hasWorkspace, loading, hasModel, hasDraft,
  onConfigureModel, onChooseWorkspace, onSelectPrompt,
}: NewConversationWelcomeProps) {
  return <section className="new-conversation-welcome" aria-label="开始新会话">
    <h1>开始一个新会话</h1>
    {loading ? <p role="status">正在载入…</p> : <>
      {(!hasWorkspace || !hasModel) && <div className="new-conversation-setup">
        {!hasWorkspace && <button type="button" className="new-conversation-setup-action is-primary" onClick={onChooseWorkspace}><FolderOpen aria-hidden="true" />选择工作区</button>}
        {!hasModel && <button type="button" className="new-conversation-setup-action new-conversation-model-warning" onClick={onConfigureModel}><SlidersHorizontal aria-hidden="true" />配置模型</button>}
      </div>}
      {!hasDraft && hasWorkspace && <div className="new-conversation-suggestions" aria-label="任务示例">
        {SUGGESTIONS.map(({ label, prompt }) => <button
          type="button" className="new-conversation-suggestion" key={label}
          onClick={() => onSelectPrompt(prompt)}
        >{label}</button>)}
      </div>}
    </>}
  </section>;
}

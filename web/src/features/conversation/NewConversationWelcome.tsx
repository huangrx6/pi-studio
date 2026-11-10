import './new-conversation-welcome.css';

type NewConversationWelcomeProps = {
  hasWorkspace: boolean;
  loading: boolean;
  hasDraft: boolean;
  onSelectPrompt: (prompt: string) => void;
};

const SUGGESTIONS = [
  { label: '先认识这个项目', prompt: '请阅读这个项目，说明它的用途、代码结构和主要运行方式。' },
  { label: '找找哪里有问题', prompt: '请检查这个项目，找出有代码依据的问题，按影响排序并给出改进建议。' },
  { label: '跑一遍验证', prompt: '请先阅读项目说明，确认合适的验证命令，再运行检查并报告结果。' },
];

/**
 * 新会话欢迎区。
 *
 * 这里只负责「说点什么」：工作区与模型的选择入口都在输入框里，
 * 缺少配置时由输入框提示，不再在空状态堆一排设置按钮。
 */
export function NewConversationWelcome({
  hasWorkspace, loading, hasDraft, onSelectPrompt,
}: NewConversationWelcomeProps) {
  return <section className="new-conversation-welcome" aria-label="开始新会话">
    <span className="new-conversation-rule" aria-hidden="true" />
    <h1>今天想做点什么？</h1>
    {loading
      ? <p role="status">正在载入…</p>
      : <p className="new-conversation-lede">说个目标就行 —— Pi 自己读代码、跑命令，再把结果交给你。</p>}
    {!loading && !hasDraft && hasWorkspace && <div className="new-conversation-suggestions" aria-label="任务示例">
      {SUGGESTIONS.map(({ label, prompt }) => <button
        type="button" className="new-conversation-suggestion" key={label}
        onClick={() => onSelectPrompt(prompt)}
      >{label}</button>)}
    </div>}
  </section>;
}

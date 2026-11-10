import './new-conversation-welcome.css';

type NewConversationWelcomeProps = {
  loading: boolean;
};

/**
 * 新会话欢迎区。
 *
 * 只留一条短线和一句话：工作区与模型的选择入口都在输入框里，
 * 说明文字与任务示例此前占了整块高度，与「把高度还给内容」相冲突。
 */
export function NewConversationWelcome({ loading }: NewConversationWelcomeProps) {
  return <section className="new-conversation-welcome" aria-label="开始新会话">
    <span className="new-conversation-rule" aria-hidden="true" />
    <h1>今天想做点什么？</h1>
    {loading && <p role="status">正在载入…</p>}
  </section>;
}

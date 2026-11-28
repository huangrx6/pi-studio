import { LoadingState } from '../../shared/LoadingState';
import './styles/welcome-art.css';
import './styles/new-conversation-welcome.css';

type NewConversationWelcomeProps = {
  loading: boolean;
  /** 可选注入时间，供测试按固定时刻验证问候语。 */
  now?: Date;
};

/** 按本地时段返回克制自然的问候语。 */
export function resolveWelcomeGreeting(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 9) return '早安，今天从哪件事开始？';
  if (hour >= 9 && hour < 12) return '上午好，准备推进哪件事？';
  if (hour >= 12 && hour < 14) return '午间小憩，也可以随手记下想法';
  if (hour >= 14 && hour < 18) return '下午好，手头的事随时交给我';
  if (hour >= 18 && hour < 22) return '晚上好，还有什么需要收尾？';
  return '夜深了，记得早点休息';
}

export function NewConversationWelcome({ loading, now }: NewConversationWelcomeProps) {
  const greeting = resolveWelcomeGreeting(now);
  return (
    <section className="new-conversation-welcome" aria-label="开始新会话">
      <span className="welcome-art" aria-hidden="true" />
      <h1>{greeting}</h1>
      {loading && <LoadingState>正在载入…</LoadingState>}
    </section>
  );
}

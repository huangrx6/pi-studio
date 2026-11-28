import { Fragment } from 'react';
import { tokenLabel } from '../../shared/token-units';
import type { ModelOption } from '../../types/model-types';

export function ModelCapabilities({ item }: { item: Pick<ModelOption, 'contextWindow' | 'maxTokens' | 'supportsImages' | 'reasoning' | 'thinkingLevels'> }) {
  const specs: Array<{ key: string; text: string; title?: string }> = [];
  if (item.contextWindow) {
    specs.push({
      key: 'ctx',
      text: `${tokenLabel(item.contextWindow)} 上下文`,
      title: `${item.contextWindow.toLocaleString()} tokens`,
    });
  }
  if (item.maxTokens) {
    specs.push({
      key: 'out',
      text: `${tokenLabel(item.maxTokens)} 输出`,
      title: `${item.maxTokens.toLocaleString()} tokens`,
    });
  }
  if (item.supportsImages) {
    specs.push({ key: 'img', text: '图片' });
  }
  if (item.reasoning) {
    specs.push({
      key: 'reason',
      text: item.thinkingLevels?.length ? `推理 · ${item.thinkingLevels.length} 档` : '推理',
    });
  }
  if (!specs.length) return null;
  return <span className="model-settings-capabilities">
    {specs.map((spec, index) => <Fragment key={spec.key}>
      {index > 0 && <span className="model-spec-sep" aria-hidden="true">/</span>}
      <span title={spec.title}>{spec.text}</span>
    </Fragment>)}
  </span>;
}

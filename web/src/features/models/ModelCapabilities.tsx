import { tokenLabel } from '../../shared/token-units';
import type { ModelOption } from '../../types/model-types';

export function ModelCapabilities({ item }: { item: Pick<ModelOption, 'contextWindow' | 'maxTokens' | 'supportsImages' | 'reasoning' | 'thinkingLevels'> }) {
  return <span className="model-settings-capabilities">
    {Boolean(item.contextWindow) && <span title={`${item.contextWindow!.toLocaleString()} tokens`}>{tokenLabel(item.contextWindow!)} 上下文</span>}
    {Boolean(item.maxTokens) && <span title={`${item.maxTokens!.toLocaleString()} tokens`}>{tokenLabel(item.maxTokens!)} 输出</span>}
    {item.supportsImages && <span>图片</span>}
    {item.reasoning && <span>{item.thinkingLevels?.length ? `推理 · ${item.thinkingLevels.length} 档` : '推理'}</span>}
  </span>;
}

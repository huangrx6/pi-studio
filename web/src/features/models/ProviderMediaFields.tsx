import { Images, Mic } from 'lucide-react';
import { Select } from '../../shared/Select';
import type { MediaModelCandidate, ProviderMediaModels } from './model-settings-types';

export function ProviderMediaFields({ models, catalog, onChange }: {
  models: ProviderMediaModels; catalog: MediaModelCandidate[]; onChange: (models: ProviderMediaModels) => void;
}) {
  const candidates = new Map<string, string>();
  for (const value of [...models.image, ...models.speech]) {
    const id = value.trim();
    if (id) candidates.set(id, id);
  }
  for (const item of catalog) candidates.set(item.id, item.name || item.id);
  return <section className="provider-media-fields field-wide" aria-label="媒体生成模型">
    <h3>媒体生成模型</h3>
    <p className="provider-editor-note">分镜使用此来源的服务地址和 API Key。每行填写一个兼容 OpenAI 媒体接口的模型 ID。对话用途可在对话模型目录中单独管理。</p>
    <div className="provider-media-columns">{(['speech', 'image'] as const).map(kind => {
      const speech = kind === 'speech';
      const title = speech ? '语音合成' : '图像生成';
      const Icon = speech ? Mic : Images;
      const ids = models[kind];
      const assigned = new Set(ids.map(id => id.trim()));
      const options = [...candidates].filter(([id]) => !assigned.has(id)).map(([id, name]) => ({
        value: id, label: name, description: name !== id ? id : undefined,
      }));
      return <div className="provider-media-kind" key={kind}>
        <label><span><Icon aria-hidden />{title}</span>
          <textarea aria-label={title + '模型 ID'} rows={2} spellCheck={false} value={ids.join('\n')}
            placeholder={speech ? '语音合成模型 ID' : '图像生成模型 ID'}
            onChange={event => onChange({ ...models, [kind]: event.target.value.split('\n') })} /></label>
        {options.length > 0 && <Select label={title + ' · 从已有模型选择'} value="" options={[
          { value: '', label: '从已有模型选择', disabled: true }, ...options,
        ]} onChange={id => onChange({ ...models, [kind]: [...ids.map(value => value.trim()).filter(Boolean), id] })} />}
      </div>;
    })}</div>
  </section>;
}

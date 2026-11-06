import { useState, type Dispatch, type SetStateAction } from 'react';
import { InfoHint } from '../../shared/InfoHint';
import { Select, type SelectOption } from '../../shared/Select';
import './provider-editor.css';

export type ProviderEditorDraft = {
  providerId: string; name: string; baseUrl: string; api: string;
  apiKey: string; icon: string; modelsUrl: string;
};

export function ProviderEditorFields({ draft, setDraft, editing, apiTypeOptions, settingsBusy = false }: {
  draft: ProviderEditorDraft;
  setDraft: Dispatch<SetStateAction<ProviderEditorDraft>>;
  editing: boolean;
  apiTypeOptions: SelectOption[];
  settingsBusy?: boolean;
}) {
  const configured = Boolean(draft.modelsUrl || draft.icon);
  const [advancedOpen, setAdvancedOpen] = useState(configured);
  const update = (key: keyof ProviderEditorDraft, value: string) => setDraft(current => ({ ...current, [key]: value }));
  const options = apiTypeOptions.some(option => option.value === draft.api)
    ? apiTypeOptions : [...apiTypeOptions, { value: draft.api, label: draft.api }];
  return <div className="settings-form-grid provider-editor-fields">
    <p className="provider-editor-note field-wide">全局模型来源 · 所有工作区共享连接配置与凭据。</p>
    <div className="settings-field">
      <span className="settings-field-heading"><label htmlFor="provider-id">来源 ID</label><InfoHint label="用于区分模型来源和凭据，创建后不能修改。" /></span>
      <input id="provider-id" autoFocus={!editing} required disabled={editing || settingsBusy} value={draft.providerId} onChange={event => update('providerId', event.target.value)} placeholder="my-provider" />
    </div>
    <label>显示名称<input required value={draft.name} onChange={event => update('name', event.target.value)} placeholder="例如 My Gateway" /></label>
    <div className="settings-field"><span>API 类型</span><Select label="API 类型" disabled={settingsBusy} value={draft.api} onChange={value => update('api', value)} options={options} /></div>
    <label>服务地址<input autoFocus={editing} required type="url" value={draft.baseUrl} onChange={event => update('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" /></label>
    <div className="settings-field field-wide">
      <span className="settings-field-heading"><label htmlFor="provider-api-key">API Key</label><InfoHint label="只填写密钥值。Studio 使用自己的加密凭据库，并把环境变量名、shell 命令等按普通文本处理。" /></span>
      <input id="provider-api-key" aria-describedby={editing ? 'provider-api-key-note' : undefined} type="password" autoComplete="new-password" value={draft.apiKey} onChange={event => update('apiKey', event.target.value)} placeholder={editing ? '输入新 API Key' : '粘贴 API Key'} />
      {editing && <small id="provider-api-key-note" className="provider-editor-note">留空保留已保存的 API Key，不会清除凭据。</small>}
    </div>
    <details className="provider-editor-advanced field-wide" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}
      onInvalidCapture={event => {
        // Open synchronously before native form validation tries to focus a field.
        event.currentTarget.open = true;
        setAdvancedOpen(true);
      }}>
      <summary>高级选项{configured && <span>已配置</span>}</summary>
      <div className="settings-form-grid">
        <div className="settings-field">
          <span className="settings-field-heading"><label htmlFor="provider-models-url">模型列表地址</label><InfoHint label="支持常见的 OpenAI /models 响应。保存来源后可获取并预览模型。" /></span>
          <input id="provider-models-url" type="url" value={draft.modelsUrl} onChange={event => update('modelsUrl', event.target.value)} placeholder="默认使用服务地址/models" />
        </div>
        <label>图标 URL<input value={draft.icon} onChange={event => update('icon', event.target.value)} placeholder="可选，URL 或 data:image/…" /></label>
      </div>
    </details>
  </div>;
}

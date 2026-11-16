import { useEffect, useId, useRef, useState } from 'react';
import { Gauge, Plus, Trash2 } from 'lucide-react';
import { LoadingState } from '../../shared/LoadingState';
import { Select } from '../../shared/Select';
import { errorText } from '../../shared/error-text';
import { emptyQuotaField, type ProviderQuotaConfig, type QuotaField, type QuotaFieldSuggestion, type QuotaMetric } from '../../types/provider-quota';

const formats = [
  { value: 'number', label: '数值或余额' }, { value: 'percent', label: '百分比（0–100）' },
  { value: 'fraction', label: '比例（0–1）' }, { value: 'enum', label: '状态翻译' },
  { value: 'time', label: '日期时间' },
];
const authOptions = [
  { value: 'none', label: '无需凭据' }, { value: 'bearer', label: '来源 API Key · Bearer' },
  { value: 'x-api-key', label: '来源 API Key · x-api-key' },
];
function originOf(url: string) {
  try { return new URL(url).origin; } catch { return ''; }
}

export function ProviderQuotaFields({ config, providerId, apiKey, onChange }: {
  config: ProviderQuotaConfig; providerId: string; apiKey: string; onChange: (value: ProviderQuotaConfig) => void;
}) {
  const section = useId();
  return <section className="quota-editor field-wide" aria-label="来源额度监控">
    <div className="quota-editor-heading">
      <Gauge aria-hidden="true" />
      <div><strong>额度监控</strong><p>此来源的模型共享额度规则，可在会话工作区查看。</p></div>
      <button type="button" className={`switch ${config.enabled ? 'is-on' : ''}`} role="switch" aria-label="开启额度监控"
        aria-checked={config.enabled} aria-controls={section} onClick={() => onChange({ ...config, enabled: !config.enabled })}><span /></button>
    </div>
    {config.enabled && <div id={section} className="quota-editor-body">
      <div className="quota-connection">
        <label>额度接口（GET）<input type="url" required maxLength={2048} placeholder="https://api.example.com/usage" value={config.endpoint}
          onChange={e => onChange({ ...config, endpoint: e.target.value, auth: originOf(config.endpoint) === originOf(e.target.value) ? config.auth : 'none' })} /></label>
        <div className="settings-field"><span>接口认证</span><Select label="额度接口认证" options={authOptions} value={config.auth}
          onChange={auth => onChange({ ...config, auth: auth as ProviderQuotaConfig['auth'] })} />
          {config.auth !== 'none' && <small>查询时将向 {originOf(config.endpoint) || '所填接口'} 发送此来源的 API Key。</small>}
        </div>
      </div>
      <QuotaMappingFields key={JSON.stringify([providerId, config.endpoint, config.auth])} providerId={providerId} apiKey={apiKey}
        config={config} onChange={fields => onChange({ ...config, fields })} />
    </div>}
  </section>;
}

function QuotaMappingFields({ config, providerId, apiKey, onChange }: {
  config: ProviderQuotaConfig; providerId: string; apiKey: string; onChange: (fields: QuotaField[]) => void;
}) {
  const { fields } = config;
  const summaryCount = fields.filter(field => field.summary).length;
  const fieldListId = useId();
  const [suggestions, setSuggestions] = useState<QuotaFieldSuggestion[]>([]);
  const [inspecting, setInspecting] = useState(false);
  const [inspectMessage, setInspectMessage] = useState('');
  const [sample, setSample] = useState('');
  const [preview, setPreview] = useState<QuotaMetric[] | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const revision = useRef(0);
  const probeRevision = useRef(0);
  useEffect(() => {
    setSuggestions([]); setInspectMessage(''); setInspecting(false);
    return () => { probeRevision.current++; };
  }, [apiKey]);
  useEffect(() => {
    setPreview(null); setPreviewError(''); setPreviewBusy(false);
    return () => { revision.current++; };
  }, [fields, sample]);
  const update = (index: number, patch: Partial<QuotaField>) => onChange(fields.map((field, i) => i === index ? { ...field, ...patch } : field));

  async function inspect() {
    const request = ++probeRevision.current;
    setInspecting(true); setInspectMessage(''); setSuggestions([]);
    try {
      const found = await window.piApi.providerQuotaFields({ providerId, endpoint: config.endpoint, auth: config.auth, apiKey });
      if (request !== probeRevision.current) return;
      setSuggestions(found);
      setInspectMessage(found.length ? `已读取 ${found.length} 个字段，可选择填入映射。` : '接口未返回可映射的字段。');
    } catch (error) { if (request === probeRevision.current) setInspectMessage(errorText(error)); }
    finally { if (request === probeRevision.current) setInspecting(false); }
  }
  async function checkSample() {
    const request = ++revision.current;
    setPreviewBusy(true); setPreviewError(''); setPreview(null);
    try {
      const metrics = await window.piApi.previewQuotaMapping({ fields, sample });
      if (request === revision.current) setPreview(metrics);
    } catch (error) { if (request === revision.current) setPreviewError(errorText(error)); }
    finally { if (request === revision.current) setPreviewBusy(false); }
  }

  function selectSuggestion(path: string) {
    const item = suggestions.find(option => option.path === path);
    if (!item) return;
    const blank = fields.findIndex(field => !field.path);
    if (blank >= 0) update(blank, item);
    else if (fields.length < 24) onChange([...fields, { ...emptyQuotaField(summaryCount < 2), ...item }]);
  }

  return <>
    <div className="quota-mapping-heading"><strong>显示字段</strong>
      <button type="button" className="settings-outline" disabled={inspecting || !providerId.trim() || !config.endpoint.trim()} onClick={inspect}>读取接口字段</button>
    </div>
    <p className="provider-editor-note">每个周期单独添加一项，例如「5 小时剩余」或「本周已用」。数组可按下标取值，或用 <code>limits[period=week].remaining</code> 匹配周期。多个条件可用 <code>&amp;</code> 连接。</p>
    {inspecting && <LoadingState>正在读取接口字段</LoadingState>}
    {inspectMessage && <small role="status">{inspectMessage}</small>}
    {suggestions.length > 0 && <Select label="选择接口返回字段" placeholder="选择接口返回字段…" value="" options={suggestions.map(item => ({ value: item.path, label: item.path }))}
      disabled={fields.length >= 24 && fields.every(field => field.path)} onChange={selectSuggestion} />}
    <datalist id={fieldListId}>{suggestions.map(item => <option key={item.path} value={item.path} />)}</datalist>
    <div className="quota-mapping-list">
      {fields.map((field, i) => <div key={i} className="quota-mapping" role="group" aria-label={`额度字段 ${i + 1}`}>
        <div className="quota-mapping-name"><label>显示名称<input required maxLength={48} placeholder="本周剩余" value={field.label} onChange={e => update(i, { label: e.target.value })} /></label>
          <button type="button" className="icon-button" title="移除此字段" aria-label={`移除额度字段 ${i + 1}`} disabled={fields.length === 1} onClick={() => onChange(fields.filter((_, n) => n !== i))}><Trash2 /></button></div>
        <label>返回字段路径<input className="quota-path" required list={fieldListId} maxLength={256} placeholder="usage.week.remaining" value={field.path} onChange={e => update(i, { path: e.target.value })} /></label>
        <div className="quota-mapping-options">
          <div className="settings-field"><span>显示格式</span><Select label={`额度字段 ${i + 1} 的显示格式`} value={field.format} options={formats} onChange={format => update(i, { format: format as QuotaField['format'] })} /></div>
          {field.format === 'number' && <label>单位（可选）<input maxLength={16} placeholder="次、元、USD…" value={field.unit} onChange={e => update(i, { unit: e.target.value })} /></label>}
        </div>
        {field.format === 'enum' && <label>值翻译<textarea required rows={2} maxLength={2048} value={field.translations} placeholder={'active=可用\nexhausted=已用尽'} onChange={e => update(i, { translations: e.target.value })} /><small>每行填写一个「接口值=中文含义」。</small></label>}
        {field.format === 'time' && <small>支持 ISO 日期、秒或毫秒时间戳，按本地时区显示。</small>}
        <label className="quota-summary-option">
          <input type="checkbox" checked={field.summary} disabled={!field.summary && summaryCount >= 2} onChange={e => update(i, { summary: e.target.checked })} />
          显示在会话摘要 <small>最多两项</small>
        </label>
      </div>)}
    </div>
    <button type="button" className="settings-text-button quota-add-field" disabled={fields.length >= 24} onClick={() => onChange([...fields, emptyQuotaField(summaryCount < 2)])}><Plus />添加额度字段</button>
    <details className="quota-sample"><summary>用返回样例预览</summary>
      <label>JSON 返回样例<textarea rows={3} maxLength={65536} placeholder={'{"usage":{"week":{"remaining":120}}}'} value={sample} onChange={e => setSample(e.target.value)} /></label>
      <div className="quota-preview-actions"><small>样例仅用于本次预览。</small><button type="button" className="settings-outline" disabled={!sample.trim() || previewBusy} onClick={checkSample}>预览映射</button></div>
      {previewBusy && <LoadingState>正在预览</LoadingState>}
      {previewError && <p role="alert">{previewError}</p>}
      {preview && <dl aria-label="映射预览" className="quota-preview-list">{preview.map((m, i) => <div key={i}><dt>{m.label}</dt><dd>{m.value ?? m.issue}</dd></div>)}</dl>}
    </details>
  </>;
}

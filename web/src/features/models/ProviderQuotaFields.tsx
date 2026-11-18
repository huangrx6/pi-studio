import { Accordion } from '../../shared/Accordion';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { InfoHint } from '../../shared/InfoHint';
import { LoadingState } from '../../shared/LoadingState';
import { Select } from '../../shared/Select';
import { errorText } from '../../shared/error-text';
import { QuotaMetricList, quotaSummary } from './ProviderQuotaView';
import { emptyQuotaField, type ProviderQuotaConfig, type QuotaField, type QuotaFieldSuggestion, type QuotaMetric } from '../../types/provider-quota';

const formats = [
  { value: 'number', label: '数值或余额' }, { value: 'percent', label: '百分比（0–100）' },
  { value: 'fraction', label: '比例（0–1）' }, { value: 'enum', label: '状态翻译' },
  { value: 'time', label: '日期时间' },
];
const authOptions = [
  { value: 'none', label: '无需凭据' }, { value: 'bearer', label: '来源 API Key · Bearer' },
  { value: 'authorization', label: '来源 API Key · 原始 Authorization', description: '直接发送密钥，不加 Bearer；适用于 BigModel 额度接口。' },
  { value: 'x-api-key', label: '来源 API Key · x-api-key', description: '常见于 Anthropic 等接口。' },
  { value: 'api-key', label: '来源 API Key · api-key', description: '常见于 Azure 接口。' },
  { value: 'x-goog-api-key', label: '来源 API Key · x-goog-api-key', description: '常见于 Google 接口。' },
  { value: 'custom-header', label: '来源 API Key · 自定义请求头', description: '例如 Ocp-Apim-Subscription-Key、X-Auth-Token。' },
  { value: 'query', label: '来源 API Key · 查询参数', description: '仅在接口要求时使用；密钥由主进程添加到请求地址。' },
];
const metadataHeaders = ['anthropic-version', 'anthropic-beta', 'openai-organization', 'openai-project', 'x-goog-user-project', 'new-api-user'];
const exampleFields: QuotaField[] = [{ ...emptyQuotaField(), label: '本周剩余', path: 'usage.week.remaining', unit: '次' }];
function originOf(url: string) {
  try { return new URL(url).origin; } catch { return ''; }
}

export function ProviderQuotaFields({ config, providerId, apiKey, onChange }: {
  config: ProviderQuotaConfig; providerId: string; apiKey: string; onChange: (value: ProviderQuotaConfig) => void;
}) {
  const section = useId();
  return <section className="settings-form-section provider-editor-section quota-editor" aria-label="来源额度监控">
    <div className="quota-editor-heading">
      <div><h3>额度监控</h3><p>查询此来源的余额或用量，在会话中查看。</p></div>
      <button type="button" className={`switch ${config.enabled ? 'is-on' : ''}`} role="switch" aria-label="开启额度监控"
        aria-checked={config.enabled} aria-controls={section} onClick={() => onChange({ ...config, enabled: !config.enabled })}><span /></button>
    </div>
    {config.enabled && <div id={section} className="quota-editor-body">
      <section className="quota-editor-group" aria-label="额度接口设置">
        <h4>接口设置</h4>
        <div className="quota-connection">
          <label>额度接口（GET）<input type="url" required maxLength={2048} placeholder="https://api.example.com/usage" value={config.endpoint}
            onChange={e => onChange({ ...config, endpoint: e.target.value, auth: originOf(config.endpoint) === originOf(e.target.value) ? config.auth : 'none' })} /></label>
          <div className="settings-field"><span>接口认证</span><Select label="额度接口认证" options={authOptions} value={config.auth}
            onChange={auth => onChange({ ...config, auth: auth as ProviderQuotaConfig['auth'], authName: auth === 'query' ? 'key' : '' })} />
            {config.auth !== 'none' && <small>查询时将向 {originOf(config.endpoint) || '所填接口'} 发送此来源的 API Key。</small>}
          </div>
          {(config.auth === 'custom-header' || config.auth === 'query') && <label>
            {config.auth === 'query' ? '认证查询参数名称' : '认证请求头名称'}
            <input required maxLength={80} value={config.authName ?? ''}
              placeholder={config.auth === 'query' ? 'key' : 'Ocp-Apim-Subscription-Key'}
              onChange={e => onChange({ ...config, authName: e.target.value })} />
            <small>这里只填名称，密钥自动使用此来源的 API Key。</small>
          </label>}
        </div>
        <Accordion compact className="quota-request-options" defaultOpen={Boolean(config.headers?.length)} summary="附加请求头" badge={config.headers?.length || undefined}>
          <p className="provider-editor-note">仅填写版本、组织、项目或用户标识，密钥使用上方认证设置。</p>
          {(config.headers ?? []).map((header, index) => <div className="quota-request-header" key={index} role="group" aria-label={`附加请求头 ${index + 1}`}>
            <Select label={`附加请求头 ${index + 1} 的名称`} value={header.name}
              options={metadataHeaders.map(name => ({ value: name, label: name, disabled: name !== header.name && config.headers?.some(row => row.name === name) }))}
              onChange={name => onChange({ ...config, headers: config.headers!.map((row, i) => i === index ? { ...row, name } : row) })} />
            <input required aria-label={`附加请求头 ${index + 1} 的值`} maxLength={256} value={header.value} placeholder="按厂商文档填写"
              onChange={e => onChange({ ...config, headers: config.headers!.map((row, i) => i === index ? { ...row, value: e.target.value } : row) })} />
            <button type="button" className="icon-button" aria-label={`移除附加请求头 ${index + 1}`}
              onClick={() => onChange({ ...config, headers: config.headers!.filter((_, i) => i !== index) })}><Trash2 /></button>
          </div>)}
          <button type="button" className="quota-add-field" disabled={(config.headers?.length ?? 0) >= metadataHeaders.length}
            onClick={() => onChange({ ...config, headers: [...(config.headers ?? []), { name: metadataHeaders.find(name => !config.headers?.some(row => row.name === name))!, value: '' }] })}><Plus />添加请求头</button>
        </Accordion>
      </section>
      <QuotaMappingFields key={JSON.stringify([providerId, config.endpoint, config.auth, config.authName, config.headers])} providerId={providerId} apiKey={apiKey}
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
  const probeRevision = useRef(0);
  useEffect(() => {
    setSuggestions([]); setInspectMessage(''); setInspecting(false);
    return () => { probeRevision.current++; };
  }, [apiKey]);
  const update = (index: number, patch: Partial<QuotaField>) => onChange(fields.map((field, i) => i === index ? { ...field, ...patch } : field));

  async function inspect() {
    const request = ++probeRevision.current;
    setInspecting(true); setInspectMessage(''); setSuggestions([]);
    try {
      const found = await window.piApi.providerQuotaFields({ providerId, endpoint: config.endpoint, auth: config.auth, authName: config.authName, headers: config.headers, apiKey });
      if (request !== probeRevision.current) return;
      setSuggestions(found);
      setInspectMessage(found.length ? `已读取 ${found.length} 个字段，可选择填入映射。` : '接口未返回可映射的字段。');
    } catch (error) { if (request === probeRevision.current) setInspectMessage(errorText(error)); }
    finally { if (request === probeRevision.current) setInspecting(false); }
  }
  function selectSuggestion(path: string) {
    const item = suggestions.find(option => option.path === path);
    if (!item) return;
    const blank = fields.findIndex(field => !field.path);
    if (blank >= 0) update(blank, item);
    else if (fields.length < 24) onChange([...fields, { ...emptyQuotaField(summaryCount < 2), ...item }]);
  }

  return <section className="quota-editor-group quota-display-group" aria-label="额度显示字段">
    <div className="quota-mapping-heading"><div className="settings-field-heading"><h4>显示字段</h4>
      <InfoHint label="每个余额或周期单独添加一项。返回字段路径支持数组下标，或用 limits[period=week].remaining 匹配周期，多个条件用 & 连接。" /></div>
      <button type="button" className="settings-outline" disabled={inspecting || !providerId.trim() || !config.endpoint.trim()} onClick={inspect}>读取接口字段</button>
    </div>
    <p className="provider-editor-note">每个余额或周期添加一项，最多选择两项显示在会话摘要。</p>
    {inspecting && <LoadingState>正在读取接口字段</LoadingState>}
    {inspectMessage && <small role="status">{inspectMessage}</small>}
    {suggestions.length > 0 && <Select label="选择接口返回字段" placeholder="选择接口返回字段…" value="" options={suggestions.map(item => ({ value: item.path, label: item.path }))}
      disabled={fields.length >= 24 && fields.every(field => field.path)} onChange={selectSuggestion} />}
    <datalist id={fieldListId}>{suggestions.map(item => <option key={item.path} value={item.path} />)}</datalist>
    <div className="quota-mapping-list">
      {fields.map((field, i) => <div key={i} className="quota-mapping" role="group" aria-label={`额度字段 ${i + 1}`}>
        <div className="quota-mapping-fields">
          <label>显示名称<input required maxLength={48} placeholder="本周剩余" value={field.label} onChange={e => update(i, { label: e.target.value })} /></label>
          <label>返回字段路径<input className="quota-path" required list={fieldListId} maxLength={256} placeholder="usage.week.remaining" value={field.path} onChange={e => update(i, { path: e.target.value })} /></label>
          <div className="quota-mapping-options">
            <div className="settings-field"><span>显示格式</span><Select label={`额度字段 ${i + 1} 的显示格式`} value={field.format} options={formats} onChange={format => update(i, { format: format as QuotaField['format'] })} /></div>
            {field.format === 'number' && <label>单位（可选）<input maxLength={16} placeholder="次、元、USD…" value={field.unit} onChange={e => update(i, { unit: e.target.value })} /></label>}
          </div>
          {field.format === 'enum' && <label>值翻译<textarea required rows={2} maxLength={2048} value={field.translations} placeholder={'active=可用\nexhausted=已用尽'} onChange={e => update(i, { translations: e.target.value })} /><small>每行填写一个「接口值=中文含义」。</small></label>}
          {field.format === 'time' && <small>支持 ISO 日期、秒或毫秒时间戳，按本地时区显示。</small>}
        </div>
        <div className="quota-field-footer"><label className="quota-summary-option">
          <input type="checkbox" checked={field.summary} disabled={!field.summary && summaryCount >= 2} onChange={e => update(i, { summary: e.target.checked })} />
          显示在会话摘要（最多两项）
        </label><button type="button" className="icon-button" title="移除此字段" aria-label={`移除额度字段 ${i + 1}`} disabled={fields.length === 1} onClick={() => onChange(fields.filter((_, n) => n !== i))}><Trash2 /></button></div>
      </div>)}
    </div>
    <button type="button" className="settings-text-button quota-add-field" disabled={fields.length >= 24} onClick={() => onChange([...fields, emptyQuotaField(summaryCount < 2)])}><Plus />添加额度字段</button>
    <QuotaSample fields={fields} />
  </section>;
}

const sampleLimit = 65536;
const initialSample = JSON.stringify({ usage: { week: { remaining: 120 } } }, null, 2);

// Re-indent the original tokens so large integers, duplicate keys and string escapes survive.
function formatSample(source: string) {
  try { JSON.parse(source); } catch { return null; }
  const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  let formatted = '';
  let depth = 0;
  let previous = '';
  for (const token of tokens) {
    const closing = token === '}' || token === ']';
    const afterOpen = previous === '{' || previous === '[';
    if (closing) depth--;
    if ((afterOpen && !closing) || (closing && !afterOpen) || previous === ',') {
      formatted += '\n' + '  '.repeat(depth);
    } else if (previous === ':') {
      formatted += ' ';
    }
    formatted += token;
    if (formatted.length > sampleLimit) return null;
    if (token === '{' || token === '[') depth++;
    previous = token;
  }
  return formatted;
}

function QuotaSample({ fields }: { fields: QuotaField[] }) {
  const sampleId = useId();
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState(initialSample);
  const [result, setResult] = useState<{ metrics?: QuotaMetric[]; error?: string }>();
  const [pending, setPending] = useState(false);
  const formatted = useMemo(() => open ? formatSample(sample) : null, [open, sample]);
  const example = fields.every(field => !field.path.trim() && !field.label.trim());
  useEffect(() => {
    if (!open || !sample.trim()) {
      setResult(undefined);
      setPending(false);
      return;
    }
    let active = true;
    setPending(true);
    const timer = window.setTimeout(() => {
      void window.piApi.previewQuotaMapping({ fields: example ? exampleFields : fields, sample }).then(
        metrics => { if (active) setResult({ metrics }); },
        cause => { if (active) setResult({ error: errorText(cause) }); },
      ).finally(() => { if (active) setPending(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [open, sample, fields, example]);
  return <Accordion compact className="quota-sample" onToggle={e => setOpen(e.currentTarget.open)} summary="额度预览">
    <div className="quota-sample-columns">
      <div className="quota-sample-source">
        <div className="quota-sample-toolbar">
          <label htmlFor={sampleId}>JSON 返回样例</label>
          <button type="button" className="settings-text-button" aria-label="格式化 JSON" disabled={formatted === null || formatted === sample}
            onClick={() => { if (formatted !== null) setSample(formatted); }}>格式化</button>
        </div>
        <textarea id={sampleId} className="quota-sample-input" rows={Math.max(6, sample.split('\n', 12).length)} wrap="off"
          maxLength={sampleLimit} spellCheck={false} autoCapitalize="off"
          value={sample} onChange={e => setSample(e.target.value)} />
      </div>
      <section className="quota-preview-list" aria-label="映射预览" aria-live="polite" aria-busy={pending}>
        <h4 className="quota-sample-toolbar">会话摘要</h4>
        {result?.metrics ? <>
          <p className="quota-preview-summary">{quotaSummary(result.metrics)}</p>
          <h4 className="quota-preview-detail-title">额度详情</h4>
          <QuotaMetricList metrics={result.metrics} />
        </> : result?.error ? <p role="alert">{result.error}</p> : <p>{sample.trim() ? '正在预览…' : '输入 JSON 后查看显示效果。'}</p>}
      </section>
    </div>
    {example && <p className="quota-sample-hint">填写显示字段前，以「本周剩余」为例。</p>}
  </Accordion>;
}

import { useEffect, useId, useMemo, useState } from 'react';
import { Accordion } from '../../shared/Accordion';
import { SettingsTabs } from '../../shared/SettingsTabs';
import { errorText } from '../../shared/error-text';
import type { QuotaField, QuotaMetric, QuotaPreviewInput } from '../../types/provider-quota';
import { QuotaMetricList, quotaSummary } from './ProviderQuotaView';
import { quotaExampleInput } from './quota-example';

const sampleLimit = 65536;
const modes = [{ value: 'example', label: '显示示例' }, { value: 'json', label: '验证 JSON' }] as const;
type PreviewMode = typeof modes[number]['value'];
type PreviewResult = { request: QuotaPreviewInput; metrics?: QuotaMetric[]; error?: string };

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

export function QuotaMappingPreview({ fields }: { fields: QuotaField[] }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PreviewMode>('example');
  const [sample, setSample] = useState('');
  const [result, setResult] = useState<PreviewResult>();
  const manual = mode === 'json';
  const readyFields = useMemo(() => fields.filter(field =>
    field.label.trim() && field.path.trim() && (field.format !== 'enum' || field.translations.trim())), [fields]);
  const request = useMemo<QuotaPreviewInput | null>(() => {
    if (!open || !readyFields.length) return null;
    if (!manual) return quotaExampleInput(readyFields);
    return sample.trim() ? { fields: readyFields, sample } : null;
  }, [open, readyFields, manual, sample]);
  const formatted = useMemo(() => open && manual ? formatSample(sample) : null, [open, manual, sample]);

  useEffect(() => {
    if (!request) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void window.piApi.previewQuotaMapping(request).then(
        metrics => { if (active) setResult({ request, metrics }); },
        cause => { if (active) setResult({ request, error: errorText(cause) }); },
      );
    }, manual ? 180 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [request, manual]);

  const current = result?.request === request ? result : undefined;
  const metrics = current?.metrics;
  const matched = metrics?.filter(metric => metric.value !== null) ?? [];
  const issues = metrics?.flatMap((metric, i) => metric.issue ? [{ ...metric, path: readyFields[i].path }] : []) ?? [];
  const pending = Boolean(request && !current);
  const pendingFields = fields.length - readyFields.length;

  return <Accordion compact className="quota-sample" summary="额度预览" onToggle={event => setOpen(event.currentTarget.open)}>
    <SettingsTabs id={id} label="额度预览方式" tabs={modes} value={mode} onChange={setMode} />
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${mode}`} className={`quota-sample-columns${manual ? ' has-json' : ''}`}>
      {manual && <div className="quota-sample-source">
        <div className="quota-sample-toolbar">
          <label htmlFor={`${id}-sample`}>JSON 返回样例</label>
          <button type="button" className="settings-text-button" aria-label="格式化 JSON" disabled={formatted === null || formatted === sample}
            onClick={() => { if (formatted !== null) setSample(formatted); }}>格式化</button>
        </div>
        <textarea id={`${id}-sample`} className="quota-sample-input" rows={Math.max(6, sample.split('\n', 12).length)} wrap="off"
          maxLength={sampleLimit} spellCheck={false} autoCapitalize="off" placeholder="粘贴额度接口返回的 JSON…"
          value={sample} onChange={event => setSample(event.target.value)} />
      </div>}
      <section className="quota-preview-list" aria-label="映射预览" aria-live="polite" aria-busy={pending}>
        <div className="quota-sample-toolbar">
          <h4>{matched.length || !manual ? '卡片摘要' : '验证结果'}</h4>
          {manual ? metrics && <small>已匹配 {matched.length} / {metrics.length} 项</small> : <small>示例数据</small>}
        </div>
        {metrics && matched.length > 0 && <>
          <p className="quota-preview-summary">{quotaSummary(metrics)}</p>
          <h4 className="quota-preview-detail-title">额度详情</h4>
          <QuotaMetricList metrics={matched} />
        </>}
        {metrics && !matched.length && <p>没有匹配到额度字段，请核对返回路径和显示格式。</p>}
        {issues.length > 0 && <Accordion compact className="quota-preview-issues" summary={`查看 ${issues.length} 个字段问题`}>
          <ul>{issues.map((issue, i) => <li key={i}><span>{issue.label} · {issue.issue}</span><code>{issue.path}</code></li>)}</ul>
        </Accordion>}
        {current?.error && <p role="alert">{current.error}</p>}
        {!request && <p>{readyFields.length ? '输入 JSON 后查看显示效果。' : '填好字段名称、返回路径及所需的值翻译后即可预览。'}</p>}
        {pending && <p>正在预览…</p>}
        {pendingFields > 0 && readyFields.length > 0 && <p className="quota-incomplete-fields">另有 {pendingFields} 个字段待填写。</p>}
      </section>
    </div>
  </Accordion>;
}

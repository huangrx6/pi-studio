import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorText } from '../../shared/error-text';
import { LoadingState } from '../../shared/LoadingState';
import type { PlanCursor, PlanHistory, PlanRun } from '../../types/plans';
import { runStatus, stamp, timeLabel } from './plan-display';

export function PlanRuns({ revision, filter, workspaceName, onStop, onOpen }: {
  revision: number; filter: string; workspaceName: (cwd: string) => string;
  onStop: (id: string) => void; onOpen: (run: PlanRun) => void;
}) {
  const [pages, setPages] = useState<PlanCursor[]>([]);
  const [data, setData] = useState<PlanHistory | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const cursor = pages.at(-1);
  useEffect(() => {
    let live = true;
    void window.piApi.planHistory(cursor, filter || undefined).then(result => {
      if (live) { setData(result); setError(''); }
    }).catch(cause => { if (live) setError(errorText(cause)); });
    return () => { live = false; };
  }, [revision, cursor, retry, filter]);

  if (error) return <div className="plans-notice" role="alert">{error}<button onClick={() => setRetry(n => n + 1)}>重试</button></div>;
  if (!data) return <LoadingState>正在读取运行记录…</LoadingState>;
  return <>
    {!data.items.length ? <div className="plans-empty-log"><History /><h2>暂无运行记录</h2>
      <p>计划到点执行或手动运行后，可以在这里查看结果。</p></div> :
      <div className="plan-log" aria-label="执行日志">{data.items.map(run => {
        const live = run.status === 'running' || run.status === 'queued';
        return <details className="plan-log-entry" key={run.id}>
          <summary><span className={`plan-state state-${run.status}`}>{runStatus[run.status]}</span>
            <span className="plan-log-name"><strong>{run.name}</strong><small>{workspaceName(run.workspace)} · {run.trigger === 'manual' ? '手动运行' : '定时执行'}</small></span>
            <time dateTime={new Date(run.queuedAt).toISOString()}>{stamp(run.queuedAt)}</time><ChevronDown size={15} />
          </summary>
          <div className="plan-log-detail">
            <div className="plan-log-times">
              <span>{run.trigger === 'manual' ? '提交' : '原定执行'} {stamp(run.dueAt)}</span>
              {run.startedAt && <span>开始 {stamp(run.startedAt)}</span>}
              {run.finishedAt && <span>结束 {timeLabel(run.finishedAt)}</span>}
            </div>
            {run.detail && <p>{run.detail}</p>}
            <div className="plan-log-actions">
              {live && <button className="secondary-button" onClick={() => onStop(run.id)}>停止运行</button>}
              {!live && run.sessionId && <button className="secondary-button" onClick={() => onOpen(run)}>查看完整会话 <ExternalLink size={14} /></button>}
            </div>
          </div>
        </details>;
      })}</div>}
    {(cursor || data.cursor) && <div className="plan-pagination">
      <button disabled={!cursor} onClick={() => { setData(null); setPages(current => current.slice(0, -1)); }}><ChevronLeft />上一页</button>
      <span>第 {pages.length + 1} 页</span>
      <button disabled={!data.cursor} onClick={() => { const next = data.cursor; if (next) { setData(null); setPages(current => [...current, next]); } }}>下一页<ChevronRight /></button>
    </div>}
  </>;
}

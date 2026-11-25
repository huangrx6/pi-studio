import { useMemo, useRef, useState } from 'react';
import { ControlledBoard, type KanbanBoard, type OnDragEndNotification } from '@caldwell619/react-kanban';
import { CalendarClock, ChevronLeft, ChevronRight, Flag, GripVertical, ListChecks, Plus, RefreshCw } from 'lucide-react';
import { DatePicker } from '../../shared/DatePicker';
import { LoadingState } from '../../shared/LoadingState';
import { errorText } from '../../shared/error-text';
import type { ExtensionContributionId } from '../../types/extension-types';
import type { TaskBoardMutation, TaskBoardQuery, TaskBoardStatus, TaskBoardTask } from '../../types/task-board';
import { TaskBoardEditor } from './TaskBoardEditor';
import { localDate, TASK_PRIORITY_LABELS, TASK_STATUS_ICONS, TASK_STATUS_LABELS } from './task-board-fields';
import { useExtensionDataView } from './use-extension-data-view';
import './styles/task-board.css';

const PAGE_SIZE = 48;
const STATUSES = Object.keys(TASK_STATUS_LABELS) as TaskBoardStatus[];
const dueDate = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function TaskCard({ task, dragging, onEdit }: { task: TaskBoardTask; dragging: boolean; onEdit: () => void }) {
  const planned = task.plannedEndAt ?? task.plannedStartAt;
  return <article className="task-board-card" data-dragging={dragging || undefined}>
    <div className="task-board-card-heading">
      <button type="button" className="task-board-card-title" onClick={onEdit}>{task.title}</button>
      <GripVertical className="task-board-card-grip" aria-hidden="true" />
    </div>
    {task.details && <p className="task-board-card-details">{task.details}</p>}
    <div className="task-board-card-meta">
      <span className="task-board-priority" data-priority={task.priority}>
        <Flag aria-hidden="true" />
        <span className="sr-only">优先级 </span>{TASK_PRIORITY_LABELS[task.priority]}
      </span>
      {planned && <time dateTime={planned} title={task.plannedEndAt ? '计划结束时间' : '计划开始时间'}>
        <CalendarClock aria-hidden="true" />{dueDate.format(new Date(planned))}
      </time>}
    </div>
  </article>;
}

type ConnectionProps = {
  sourceId: ExtensionContributionId;
  query: TaskBoardQuery;
  day: string;
  offset: number;
  onDay: (day: string) => void;
  onOffset: (offset: number) => void;
};

function TaskBoardConnection({ sourceId, query, day, offset, onDay, onOffset }: ConnectionProps) {
  const writeRef = useRef<{ subscriptionId: string; pending: Promise<TaskBoardTask> }>();
  const { owned, error, loading, retry } = useExtensionDataView({ sourceId, taskBoardQuery: query },
    id => writeRef.current?.subscriptionId === id ? writeRef.current.pending : undefined);
  const [editor, setEditor] = useState<{ task?: TaskBoardTask; status: TaskBoardStatus }>();
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState('');
  const [movedTask, setMovedTask] = useState<TaskBoardTask>();
  const snapshot = owned?.snapshot.taskBoard;
  const writable = !error && owned?.snapshot.taskBoardWritable === true;
  const globallyEmpty = snapshot?.total === 0 && !day;
  const today = localDate(new Date());
  const board: KanbanBoard<TaskBoardTask> = {
    columns: STATUSES.map(status => ({
      id: status,
      title: TASK_STATUS_LABELS[status],
      cards: (snapshot?.tasks ?? [])
        .map(task => movedTask?.id === task.id && movedTask.revision >= task.revision ? movedTask : task)
        .filter(task => task.status === status),
    })),
  };

  async function write(mutation: TaskBoardMutation) {
    if (!owned || !writable || writeRef.current) throw new Error('任务看板暂时无法保存');
    const { subscriptionId } = owned;
    setWriting(true);
    setWriteError('');
    const pending = window.piApi.writeExtensionTaskBoard({ subscriptionId, mutation });
    writeRef.current = { subscriptionId, pending };
    try {
      return await pending;
    } finally {
      writeRef.current = undefined;
      setWriting(false);
    }
  }

  const move: OnDragEndNotification<TaskBoardTask> = (task, _source, destination) => {
    const status = STATUSES.find(value => value === destination?.toColumnId);
    if (!status || status === task.status || !writable || writeRef.current) return;
    setMovedTask({ ...task, status });
    void write({ action: 'update', id: task.id, revision: task.revision, fields: { status } })
      .then(setMovedTask)
      .catch(reason => { setMovedTask(undefined); setWriteError(errorText(reason)); });
  };

  const addButton = <button className="task-board-add" type="button" disabled={!writable || writing}
    onClick={() => setEditor({ status: 'todo' })}><Plus aria-hidden="true" />新增任务</button>;

  return <section className="task-board-panel" aria-label="全局任务看板">
    <header className="task-board-toolbar">
      <div className="task-board-heading">
        <h2>全局任务</h2>
        {snapshot && <span className="task-board-total">{snapshot.total} 项</span>}
      </div>
      {!globallyEmpty && <>
        <div className="task-board-date-filter">
          <div className="task-board-date-segments" role="group" aria-label="按创建日期筛选">
            <button type="button" disabled={writing} aria-pressed={!day} onClick={() => onDay('')}>全部</button>
            <button type="button" disabled={writing} aria-pressed={day === today} onClick={() => onDay(today)}>今天</button>
          </div>
          <DatePicker label="创建日期" placeholder="日期" value={day === today ? '' : day}
            disabled={writing} onChange={onDay} />
        </div>
        {addButton}
      </>}
    </header>
    {error && <div className="task-board-feedback" role="status">
      <span>任务看板暂时无法读取</span>
      <button type="button" className="icon-button" aria-label="重新连接任务看板" onClick={retry}><RefreshCw aria-hidden /></button>
    </div>}
    {writeError && <div className="task-board-feedback" role="alert">{writeError}</div>}
    {loading && !snapshot && <LoadingState variant="panel">正在读取任务…</LoadingState>}
    {snapshot?.total === 0 && <div className="task-board-empty">
      <div className="task-board-empty-mark"><ListChecks aria-hidden="true" /></div>
      <h3>{globallyEmpty ? '还没有任务' : '当天没有新增任务'}</h3>
      {globallyEmpty ? addButton : <button type="button" className="task-board-show-all"
        onClick={() => onDay('')}>查看全部任务</button>}
    </div>}
    {snapshot && snapshot.total > 0 && <div className="task-board-columns">
      <ControlledBoard disableColumnDrag disableCardDrag={!writable || writing}
        allowAddColumn={false} allowRenameColumn={false} allowRemoveColumn={false} allowAddCard={false} allowRemoveCard={false}
        onCardDragEnd={move} renderColumnHeader={column => {
          const status = column.id as TaskBoardStatus;
          const StatusIcon = TASK_STATUS_ICONS[status];
          const addLabel = '新增' + column.title + '任务';
          return <div className="task-board-column-header" data-task-status={status}>
            <StatusIcon className="task-board-status-icon" aria-hidden="true" />
            <h3>{column.title}</h3>
            <span className="task-board-column-count">{column.cards.length}</span>
            <button type="button" className="icon-button" disabled={!writable || writing}
              aria-label={addLabel} title={addLabel} onClick={() => setEditor({ status })}><Plus aria-hidden="true" /></button>
          </div>;
        }}
        renderCard={(task, { dragging }) => <TaskCard task={task} dragging={dragging}
          onEdit={() => setEditor({ task, status: task.status })} />}>
        {board}
      </ControlledBoard>
    </div>}
    {snapshot && (offset > 0 || snapshot.nextOffset !== null) && <footer className="task-board-pagination">
      <button type="button" className="icon-button" aria-label="上一页" disabled={offset === 0 || writing}
        onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft aria-hidden /></button>
      <span>第 {Math.floor(offset / PAGE_SIZE) + 1} 页</span>
      <button type="button" className="icon-button" aria-label="下一页" disabled={snapshot.nextOffset === null || writing}
        onClick={() => { if (snapshot.nextOffset !== null) onOffset(snapshot.nextOffset); }}><ChevronRight aria-hidden /></button>
    </footer>}
    {editor && <TaskBoardEditor task={editor.task} initialStatus={editor.status} busy={writing} onSave={write} onClose={() => setEditor(undefined)} />}
  </section>;
}

export default function TaskBoardPanel({ sourceId, generation }: { sourceId: ExtensionContributionId; generation: number }) {
  const [day, setDay] = useState('');
  const [offset, setOffset] = useState(0);
  const query = useMemo(() => ({ offset, limit: PAGE_SIZE, ...(day ? { from: day, to: day } : {}) }), [day, offset]);
  return <TaskBoardConnection key={generation} sourceId={sourceId} query={query}
    day={day} offset={offset} onDay={value => { setDay(value); setOffset(0); }} onOffset={setOffset} />;
}

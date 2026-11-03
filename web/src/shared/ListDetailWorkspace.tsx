import type { ReactNode } from 'react';
import './list-detail-workspace.css';

/** Keep the list mounted so filters and scroll survive narrow-screen navigation. */
export function ListDetailWorkspace({ list, detail, label }: { list: ReactNode; detail?: ReactNode; label: string }) {
  return <section className={`list-detail-workspace${detail ? ' has-detail' : ''}`} aria-label={label}>
    <div className="list-detail-layout">
      <div className="list-detail-master">{list}</div>
      {detail && <div className="list-detail-pane">{detail}</div>}
    </div>
  </section>;
}

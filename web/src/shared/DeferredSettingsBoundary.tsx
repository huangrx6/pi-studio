import { Component, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { LoadingState } from './LoadingState';
import './styles/deferred-settings-boundary.css';

type DeferredSettingsBoundaryProps = {
  children: ReactNode;
  onOpenGeneral: () => void;
  isGeneral: boolean;
};

function SettingsUnavailable({
  onOpenGeneral,
  isGeneral,
}: Omit<DeferredSettingsBoundaryProps, 'children'>) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);

  return <div className="deferred-settings-state" role="alert">
    <h2 ref={heading} tabIndex={-1}>这个设置页暂时无法打开</h2>
    <p>可以切换到其他设置。保存工作后重启应用可重新加载此页。</p>
    {!isGeneral && <button type="button" className="secondary-button" onClick={onOpenGeneral}>打开通用设置</button>}
  </div>;
}

/**
 * Keep failed/suspended settings local: App, conversation drafts and navigation
 * remain mounted. The caller keys this boundary by page so another page works.
 * Do not reset a rejected React.lazy as a "retry": its rejected import is cached.
 * Full-window reload is deliberately absent because drafts live in App memory.
 */
export class DeferredSettingsBoundary extends Component<DeferredSettingsBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <SettingsUnavailable
        onOpenGeneral={this.props.onOpenGeneral}
        isGeneral={this.props.isGeneral}
      />;
    }
    return <Suspense fallback={
      <div className="settings-page-frame">
        <div className="settings-loading-panel">
          <LoadingState variant="panel">正在打开设置…</LoadingState>
        </div>
      </div>
    }>{this.props.children}</Suspense>;
  }
}

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Info, RotateCw } from 'lucide-react';
import type { UpdateSnapshot } from '../../types/update-types';
import { errorText } from '../../shared/error-text';
import '../../shared/settings-page-header.css';
import './about-settings.css';

export function AboutSettings({ snapshot, paths, onOpenUpdates }: {
  snapshot: UpdateSnapshot;
  paths: { databasePath: string; skillsPath: string; extensionsPath: string };
  onOpenUpdates: () => void;
}) {
  const [linkError, setLinkError] = useState<string | null>(null);
  const active = useRef(false);
  const request = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; request.current++; }; }, []);
  async function openLink(url: string) {
    const id = ++request.current;
    setLinkError(null);
    try { await window.piApi.openExternal(url); }
    catch (cause) { if (active.current && id === request.current) setLinkError(errorText(cause)); }
  }
  const updateLabel = snapshot.state === 'downloaded' ? '重启与更新'
    : snapshot.state === 'downloading' ? '查看下载进度'
      : snapshot.state === 'available' ? snapshot.updateKind === 'same-version' ? '查看新构建' : '查看更新'
        : snapshot.state === 'checking' ? '正在检查更新' : '检查更新';
  return <div className="about-page">
    <header className="settings-page-header">
      <div className="settings-page-header-copy">
        <div className="settings-page-header-title">
          <span className="settings-page-header-icon" aria-hidden="true"><Info /></span>
          <h1>Pi Studio</h1>
          <span>{snapshot.currentVersion ? `v${snapshot.currentVersion}` : '版本信息尚未加载'}</span>
        </div>
      </div>
      <div className="settings-page-header-actions">
        <button type="button" className="settings-outline" onClick={onOpenUpdates}><RotateCw aria-hidden="true" />{updateLabel}</button>
      </div>
    </header>
    <nav className="about-links" aria-label="资源与支持">
      {[
        ['使用文档', 'https://huangrx6.github.io/pi-studio/'],
        ['源代码', 'https://github.com/huangrx6/pi-studio'],
        ['问题反馈', 'https://github.com/huangrx6/pi-studio/issues'],
      ].map(([label, url]) => <button type="button" key={url} onClick={() => void openLink(url)}>{label}<ExternalLink aria-hidden="true" /></button>)}
    </nav>
    {linkError && <p className="about-link-error" role="alert">{linkError}</p>}
    <dl className="about-facts">
      <div><dt>作者</dt><dd><button type="button" onClick={() => void openLink('https://github.com/huangrx6')}>huangrx6<ExternalLink aria-hidden="true" /></button></dd></div>
      <div><dt>运行引擎</dt><dd>Pi Durable</dd></div>
      <div><dt>许可</dt><dd><button type="button" onClick={() => void openLink('https://github.com/huangrx6/pi-studio/blob/main/LICENSE')}>MIT License<ExternalLink aria-hidden="true" /></button></dd></div>
    </dl>
    <details className="about-diagnostics">
      <summary>本地存储与诊断信息</summary>
      <dl className="about-facts">
        {snapshot.currentBuildId && <div><dt>构建标识</dt><dd><code>{snapshot.currentBuildId}</code></dd></div>}
        <div><dt>SQLite 数据库</dt><dd><code>{paths.databasePath}</code></dd></div>
        <div><dt>技能目录</dt><dd><code>{paths.skillsPath}</code></dd></div>
        <div><dt>扩展目录</dt><dd><code>{paths.extensionsPath}</code></dd></div>
      </dl>
    </details>
  </div>;
}

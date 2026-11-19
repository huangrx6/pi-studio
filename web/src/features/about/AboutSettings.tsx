import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Info, RotateCw } from 'lucide-react';
import type { UpdateSnapshot } from '../../types/update-types';
import type { StudioRuntimeVersions } from '../../types/runtime-types';
import { errorText } from '../../shared/error-text';
import { revealFileLabel } from '../../shared/desktop-platform';
import '../../shared/styles/settings-page-header.css';
import './styles/about-settings.css';

export function AboutSettings({ snapshot, paths, runtime, onOpenUpdates }: {
  snapshot: UpdateSnapshot;
  paths: { attachmentsPath: string; backupsPath: string; databasePath: string; skillsPath: string; extensionsPath: string };
  runtime?: StudioRuntimeVersions;
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
  async function revealPath(target: string) {
    const id = ++request.current;
    setLinkError(null);
    try {
      await window.piApi.revealFile({ path: target, source: 'external' });
    } catch (cause) {
      if (active.current && id === request.current) setLinkError(errorText(cause));
    }
  }
  async function copyPath(target: string) {
    const id = ++request.current;
    setLinkError(null);
    try {
      await navigator.clipboard.writeText(target);
    } catch (cause) {
      if (active.current && id === request.current) setLinkError(errorText(cause));
    }
  }
  const updateLabel = snapshot.state === 'downloaded' ? '重启与更新'
    : snapshot.state === 'downloading' ? '查看下载进度'
      : snapshot.state === 'available' ? snapshot.updateKind === 'same-version' ? '查看新构建' : '查看更新'
        : snapshot.state === 'checking' ? '正在检查更新' : '检查更新';
  const platformNames: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  const versions = runtime ? [
    ['Pi Durable', runtime.durable], ['Electron', runtime.electron], ['Chromium', runtime.chromium],
    ['Node.js', runtime.node], ['SQLite', runtime.sqlite], ['运行平台', `${platformNames[runtime.platform] || runtime.platform} · ${runtime.arch}`],
  ] : [];
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
    <div className="about-meta">
      <nav className="about-links" aria-label="资源与支持">
        {[
          ['使用文档', 'https://huangrx6.github.io/pi-studio/'],
          ['源代码', 'https://github.com/huangrx6/pi-studio'],
          ['问题反馈', 'https://github.com/huangrx6/pi-studio/issues'],
        ].map(([label, url]) => <button type="button" key={url} onClick={() => void openLink(url)}>{label}<ExternalLink aria-hidden="true" /></button>)}
      </nav>
      <dl className="about-credits">
        <div><dt>作者</dt><dd><button type="button" onClick={() => void openLink('https://github.com/huangrx6')}>huangrx6<ExternalLink aria-hidden="true" /></button></dd></div>
        <div><dt>许可</dt><dd><button type="button" onClick={() => void openLink('https://github.com/huangrx6/pi-studio/blob/main/LICENSE')}>MIT License<ExternalLink aria-hidden="true" /></button></dd></div>
      </dl>
    </div>
    {linkError && <p className="about-link-error" role="alert">{linkError}</p>}
    <section className="about-section" aria-labelledby="about-runtime-title">
      <h2 id="about-runtime-title">运行环境</h2>
      {runtime ? <dl className="about-versions">{versions.map(([label, value]) => <div key={label}>
        <dt>{label}</dt><dd>{value || '未提供'}</dd>
      </div>)}</dl> : <p>运行环境信息尚未加载</p>}
    </section>
    <section className="about-section about-diagnostics" aria-labelledby="about-storage-title">
      <h2 id="about-storage-title">本地存储与诊断信息</h2>
      <dl className="about-facts">
        {snapshot.currentBuildId && <div><dt>构建标识</dt><dd><code>{snapshot.currentBuildId}</code></dd></div>}
        {([
          ['SQLite 数据库', paths.databasePath],
          ['会话附件与输出', paths.attachmentsPath],
          ['数据库升级备份', paths.backupsPath],
          ['技能目录', paths.skillsPath],
          ['扩展目录', paths.extensionsPath],
        ] as const).map(([label, target]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="about-path-row">
              <code title={target}>{target}</code>
              <span className="about-path-actions">
                <button type="button" className="settings-text-button" onClick={() => void copyPath(target)}>复制</button>
                <button type="button" className="settings-text-button" onClick={() => void revealPath(target)}>{revealFileLabel()}</button>
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  </div>;
}

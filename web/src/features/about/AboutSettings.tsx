import { useEffect, useRef } from 'react';
import { BookOpen, Code2, ExternalLink, MessageSquare, RotateCw } from 'lucide-react';
import appIcon from '../../../../assets/icon.png';
import type { UpdateSnapshot } from '../../types/update-types';
import type { StudioRuntimeVersions } from '../../types/runtime-types';
import { useSettingsToast } from '../../shared/SettingsToast';
import { errorText } from '../../shared/error-text';
import { revealFileLabel } from '../../shared/desktop-platform';
import { PreferenceGroup, PreferenceRow } from '../../shared/PreferenceGroup';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import './styles/about-settings.css';

export function AboutSettings({ snapshot, paths, runtime, onOpenUpdates, onOpenBrowserSettings }: {
  snapshot: UpdateSnapshot;
  paths: { attachmentsPath: string; backupsPath: string; databasePath: string; skillsPath: string; extensionsPath: string };
  runtime?: StudioRuntimeVersions;
  onOpenUpdates: () => void;
  onOpenBrowserSettings?: () => void;
}) {
  const showToast = useSettingsToast();
  const active = useRef(false);
  const request = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; request.current++; }; }, []);
  async function openLink(url: string) {
    const id = ++request.current;
    try { await window.piApi.openExternal(url); }
    catch (cause) { if (active.current && id === request.current) showToast(errorText(cause), 'error'); }
  }
  async function revealPath(target: string) {
    const id = ++request.current;
    try {
      await window.piApi.revealFile({ path: target, source: 'external' });
    } catch (cause) {
      if (active.current && id === request.current) showToast(errorText(cause), 'error');
    }
  }

  async function copyPath(target: string, label: string) {
    const id = ++request.current;
    try {
      await navigator.clipboard.writeText(target);
      if (active.current && id === request.current) showToast(`已复制${label}路径`);
    } catch (cause) {
      if (active.current && id === request.current) showToast(errorText(cause), 'error');
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
  const quickLinks = [
    { label: '使用文档', url: 'https://huangrx6.github.io/pi-studio/', Icon: BookOpen },
    { label: '源代码', url: 'https://github.com/huangrx6/pi-studio', Icon: Code2 },
    { label: '问题反馈', url: 'https://github.com/huangrx6/pi-studio/issues', Icon: MessageSquare },
  ] as const;
  return <div className="settings-preference-page about-page">
    <SettingsPageHeader icon={<img src={appIcon} alt="" />} iconPosition="end"
      title="Pi Studio" meta="基于 Pi Durable 的桌面智能体工作台。" />
    <div className="settings-preference-groups">
      <PreferenceGroup title="版本与支持" description={snapshot.currentVersion ? `当前版本 v${snapshot.currentVersion}` : '版本信息尚未加载'}
        actions={<button type="button" className="settings-outline" onClick={onOpenUpdates}><RotateCw aria-hidden="true" />{updateLabel}</button>}>
        <nav className="about-links" aria-label="资源与支持">
          {quickLinks.map(({ label, url, Icon }) => <button type="button" key={url} onClick={() => void openLink(url)}>
            <Icon className="about-link-icon" aria-hidden="true" />{label}<ExternalLink className="about-link-external" aria-hidden="true" />
          </button>)}
        </nav>
        <dl className="about-credits">
          <div><dt>作者</dt><dd><button type="button" onClick={() => void openLink('https://github.com/huangrx6')}>huangrx6<ExternalLink aria-hidden="true" /></button></dd></div>
          <div><dt>许可</dt><dd><button type="button" onClick={() => void openLink('https://github.com/huangrx6/pi-studio/blob/main/LICENSE')}>MIT License<ExternalLink aria-hidden="true" /></button></dd></div>
        </dl>
      </PreferenceGroup>
      <PreferenceGroup title="运行环境">
        {runtime ? <dl className="about-versions">{versions.map(([label, value]) => <div key={label}>
          <dt>{label}</dt><dd>{value || '未提供'}</dd>
        </div>)}</dl> : <p className="about-unavailable">运行环境信息尚未加载</p>}
        {onOpenBrowserSettings && <PreferenceRow title="内嵌浏览器" description="管理工作台浏览器的站点数据、历史和权限。"
          control={<button type="button" className="settings-outline" onClick={onOpenBrowserSettings}>浏览器设置</button>} />}
      </PreferenceGroup>
      <PreferenceGroup title="本地存储与诊断信息">
        <dl className="about-facts">
          {snapshot.currentBuildId && <div><dt>构建标识</dt><dd><code className="about-path-code">{snapshot.currentBuildId}</code></dd></div>}
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
                <code className="about-path-code" title={target}>{target}</code>
                <span className="about-path-actions">
                  <button type="button" disabled={!target} className="settings-text-button about-copy-path" aria-label={`复制${label}路径`}
                    onClick={() => void copyPath(target, label)}>复制</button>
                  <button type="button" disabled={!target} className="settings-text-button" aria-label={`${revealFileLabel()} ${label}`} onClick={() => void revealPath(target)}>{revealFileLabel()}</button>
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </PreferenceGroup>
    </div>
  </div>;
}

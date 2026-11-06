import { useId, type ReactNode } from 'react';
import {
  LayoutPanelTop,
  LoaderCircle,
  MessageSquareText,
  Monitor,
  Moon,
  Palette,
  Settings,
  Sun,
} from 'lucide-react';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { Select } from '../../shared/Select';
import { RangeControl } from '../../shared/RangeControl';
import { InfoHint } from '../../shared/InfoHint';
import { PALETTE_PRESETS, type Preferences } from '../../shared/preferences';
import { BackgroundMediaPreview } from '../../shell/BackgroundLayer';
import './general-settings.css';

type Props = {
  preferences: Preferences;
  onChange: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  backgroundBusy: boolean;
  backgroundError: string | null;
  onChooseBackground: () => void;
  onRemoveBackground: () => void;
  onBackgroundUnavailable: (url: string) => void;
  menuBar: { available: boolean; enabled: boolean };
  menuBarBusy: boolean;
  onMenuBarChange: (enabled: boolean) => void;
};

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="general-setting-row"><span className="general-setting-label">{label}</span><div className="general-setting-control">{children}</div></div>;
}

/** Preference persistence and native media operations remain owned by App. */
export function GeneralSettings({ preferences, onChange, backgroundBusy, backgroundError, onChooseBackground, onRemoveBackground, onBackgroundUnavailable, menuBar, menuBarBusy, onMenuBarChange }: Props) {
  const paletteName = useId();
  const media = preferences.backgroundMedia;
  return <>
    <SettingsPageHeader
      icon={<Settings />}
      title="通用"
      meta={<span className="general-page-summary">界面偏好与应用行为</span>}
    />
    <div className="general-settings">
    <section className="general-settings-section" aria-labelledby={`${paletteName}-appearance`}>
      <h2 id={`${paletteName}-appearance`}>
        <span className="general-section-icon"><Palette aria-hidden="true" /></span>
        <span>外观</span>
        <small>主题、配色与背景</small>
      </h2>
      <SettingRow label="界面模式">
        <div className="general-theme-options" role="group" aria-label="界面模式">
          {([
            { value: 'light', label: '浅色', icon: Sun },
            { value: 'dark', label: '深色', icon: Moon },
            { value: 'system', label: '跟随系统', icon: Monitor },
          ] as const).map(({ value, label, icon: Icon }) => <button type="button" key={value} aria-pressed={preferences.theme === value} onClick={() => onChange('theme', value)}><Icon aria-hidden="true" />{label}</button>)}
        </div>
      </SettingRow>
      <SettingRow label="强调色">
        <div className="general-palette-options" role="radiogroup" aria-label="全局配色方案">
          {PALETTE_PRESETS.map(preset => <label key={preset.id} className="general-palette-option" data-palette-choice={preset.id}>
            <input type="radio" name={paletteName} value={preset.id} checked={preferences.palette === preset.id} onChange={() => onChange('palette', preset.id)} />
            <span className="general-palette-swatch" aria-hidden="true" />
            <span>{preset.label}</span>
          </label>)}
        </div>
      </SettingRow>
      <SettingRow label="圆角风格"><Select label="圆角风格" value={preferences.radiusStyle} onChange={value => onChange('radiusStyle', value as Preferences['radiusStyle'])} options={[{ value: 'square', label: '直角' }, { value: 'compact', label: '紧凑' }, { value: 'standard', label: '标准' }, { value: 'soft', label: '圆润' }]} /></SettingRow>
      <SettingRow label="背景">
        <InfoHint align="end" label="支持 PNG、JPEG、WebP、GIF、AVIF、MP4、MOV、M4V、WebM，最大 2 GB。视频会静音循环；MOV 与 WebM 取决于编码格式。" />
        <button type="button" className="settings-outline" disabled={backgroundBusy} onClick={onChooseBackground}>{backgroundBusy && <LoaderCircle className="spin" />}{media ? '更换媒体' : '选择媒体'}</button>
        {media && <button type="button" className="settings-outline" disabled={backgroundBusy} onClick={onRemoveBackground}>移除</button>}
      </SettingRow>
      {backgroundError && <div className="background-setting-error" role="alert">{backgroundError}</div>}
      {media && <div className="general-background-settings">
        <p className="general-background-name" title={media.name}>{media.name}</p>
        <details>
          <summary>调整背景</summary>
          <div className="general-background-adjustments">
            <BackgroundMediaPreview media={media} onError={() => onBackgroundUnavailable(media.url)} />
            <div>
              <RangeControl id="background-opacity" label="背景透明度" value={preferences.backgroundOpacity} onChange={value => onChange('backgroundOpacity', value)} />
              <RangeControl id="background-blur" label="柔化程度" value={preferences.backgroundBlur} onChange={value => onChange('backgroundBlur', value)} />
              <RangeControl id="background-surface" label="界面遮挡" value={preferences.backgroundSurfaceOpacity} onChange={value => onChange('backgroundSurfaceOpacity', value)} />
            </div>
          </div>
        </details>
      </div>}
    </section>
    <section className="general-settings-section" aria-labelledby={`${paletteName}-conversation`}>
      <h2 id={`${paletteName}-conversation`}>
        <span className="general-section-icon"><MessageSquareText aria-hidden="true" /></span>
        <span>对话</span>
        <small>阅读与执行节奏</small>
      </h2>
      <SettingRow label="对话字号"><Select label="字号大小" value={String(preferences.fontSize)} onChange={value => onChange('fontSize', Number(value))} options={[12, 13, 14, 15, 16, 17].map(size => ({ value: String(size), label: `${size} px` }))} /></SettingRow>
      <SettingRow label="工作步骤展示"><Select label="工作步骤展示" value={preferences.stepDisplay} onChange={value => onChange('stepDisplay', value as Preferences['stepDisplay'])} options={[{ value: 'compact', label: '精简' }, { value: 'standard', label: '标准' }, { value: 'detailed', label: '详细' }]} /></SettingRow>
      <SettingRow label="工作步骤收起时机"><Select label="工作步骤收起时机" value={preferences.stepCollapse} onChange={value => onChange('stepCollapse', value as Preferences['stepCollapse'])} options={[{ value: 'after-answer', label: '回答结束后' }, { value: 'keep-open', label: '保持展开' }, { value: 'manual', label: '手动控制' }]} /></SettingRow>
      <SettingRow label="回答后显示代码改动"><button type="button" className={`switch ${preferences.showCodeView ? 'is-on' : ''}`} role="switch" aria-checked={preferences.showCodeView} aria-label="回答后显示代码改动" onClick={() => onChange('showCodeView', !preferences.showCodeView)}><span /></button></SettingRow>
    </section>
    <section className="general-settings-section" aria-labelledby={`${paletteName}-application`}>
      <h2 id={`${paletteName}-application`}>
        <span className="general-section-icon"><LayoutPanelTop aria-hidden="true" /></span>
        <span>应用</span>
        <small>窗口与链接行为</small>
      </h2>
      <SettingRow label="菜单栏图标"><button type="button" className={`switch ${menuBar.enabled ? 'is-on' : ''}`} role="switch" aria-checked={menuBar.enabled} disabled={!menuBar.available || menuBarBusy} aria-label={menuBar.enabled ? '隐藏菜单栏图标' : '显示菜单栏图标'} title={menuBar.available ? undefined : '当前平台不支持菜单栏图标'} onClick={() => onMenuBarChange(!menuBar.enabled)}><span /></button></SettingRow>
      <SettingRow label="网页链接打开方式"><Select label="网页链接打开方式" value={preferences.linkOpen} onChange={value => onChange('linkOpen', value as Preferences['linkOpen'])} options={[{ value: 'external', label: '系统浏览器' }, { value: 'window', label: '应用内窗口' }]} /></SettingRow>
    </section>
    </div>
  </>;
}

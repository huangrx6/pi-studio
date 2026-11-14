import { useId, type ReactNode } from 'react';
import {
  ChevronDown,
  LoaderCircle,
  Monitor,
  Moon,
  Settings,
  Sun,
} from 'lucide-react';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { Select } from '../../shared/Select';
import { Stepper } from '../../shared/Stepper';
import { RangeControl } from '../../shared/RangeControl';
import { InfoHint } from '../../shared/InfoHint';
import { PALETTE_PRESETS, type Preferences } from '../../shared/preferences';
import { BackgroundMediaPreview } from '../../shell/BackgroundLayer';
import { TERMINAL_THEMES, STUDIO_TERMINAL_THEME } from '../terminal/terminal-themes';
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

/** 常用等宽字体；空值表示跟随系统。字体不在机器上时浏览器会自动回退。 */
const TERMINAL_FONT_OPTIONS = [
  { value: '', label: '系统等宽' },
  { value: 'SF Mono', label: 'SF Mono' },
  { value: 'Menlo', label: 'Menlo' },
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
  { value: 'Fira Code', label: 'Fira Code' },
  { value: 'Berkeley Mono', label: 'Berkeley Mono' },
  { value: 'IBM Plex Mono', label: 'IBM Plex Mono' },
];

function SettingRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return <div className="general-setting-row">
    <span className="general-setting-label">
      {label}
      {description && <small className="general-setting-description">{description}</small>}
    </span>
    <div className="general-setting-control">{children}</div>
  </div>;
}

function SectionHeading({ id, title }: { id: string; title: string }) {
  return <h2 id={id}><strong>{title}</strong></h2>;
}

/** Preference persistence and native media operations remain owned by App. */
export function GeneralSettings({ preferences, onChange, backgroundBusy, backgroundError, onChooseBackground, onRemoveBackground, onBackgroundUnavailable, menuBar, menuBarBusy, onMenuBarChange }: Props) {
  const sectionId = useId();
  const media = preferences.backgroundMedia;
  return <>
    <SettingsPageHeader
      icon={<Settings />}
      title="通用"
    />
    <div className="general-settings">
    <section className="general-settings-section" aria-labelledby={`${sectionId}-appearance`}>
      <SectionHeading id={`${sectionId}-appearance`} title="外观" />
      <div className="general-settings-card">
      <SettingRow label="界面模式">
        <div className="general-theme-options general-theme-modes" role="group" aria-label="界面模式">
          {([
            { value: 'light', label: '浅色', icon: Sun },
            { value: 'dark', label: '深色', icon: Moon },
            { value: 'system', label: '跟随系统', icon: Monitor },
          ] as const).map(({ value, label, icon: Icon }) => <button type="button" key={value} aria-pressed={preferences.theme === value} onClick={() => onChange('theme', value)}><Icon aria-hidden="true" />{label}</button>)}
        </div>
      </SettingRow>
      <SettingRow label="强调色" description="只影响操作强调和选中状态。">
        <div className="general-palette-options" role="radiogroup" aria-label="强调色">
          {PALETTE_PRESETS.map((preset) => <label key={preset.id} className="general-palette-option" data-palette-choice={preset.id} title={preset.description}>
            <input type="radio" name="palette" value={preset.id} checked={preferences.palette === preset.id} onChange={() => onChange('palette', preset.id)} />
            <span className="general-palette-swatch" aria-hidden="true" />
            <span>{preset.label}</span>
          </label>)}
        </div>
      </SettingRow>
      <SettingRow label="圆角风格" description="统一影响卡片、输入框和按钮。">
        <div className="general-theme-options general-radius-options" role="group" aria-label="圆角风格">
          {([
            { value: 'square', label: '直角' },
            { value: 'compact', label: '紧凑' },
            { value: 'standard', label: '标准' },
            { value: 'soft', label: '柔和' },
          ] as const).map(({ value, label }) => <button type="button" key={value} aria-pressed={preferences.radiusStyle === value} onClick={() => onChange('radiusStyle', value)}>{label}</button>)}
        </div>
      </SettingRow>
      <SettingRow label="背景">
        <InfoHint align="end" label="支持 PNG、JPEG、WebP、GIF、AVIF、MP4、MOV、M4V、WebM，最大 2 GB。视频会静音循环；MOV 与 WebM 取决于编码格式。" />
        <button type="button" className="settings-outline" disabled={backgroundBusy} onClick={onChooseBackground}>{backgroundBusy && <LoaderCircle className="spin" />}{media ? '更换媒体' : '选择媒体'}</button>
        {media && <button type="button" className="settings-outline" disabled={backgroundBusy} onClick={onRemoveBackground}>移除</button>}
      </SettingRow>
      {backgroundError && <div className="background-setting-error" role="alert">{backgroundError}</div>}
      {media && <details className="general-background-settings" open>
        <summary className="general-background-summary">
          <span className="general-background-name" title={media.name}>{media.name}</span>
          <small>{media.kind === 'video' ? '视频背景' : '图片背景'}</small>
          <ChevronDown aria-hidden="true" />
        </summary>
        <div className="general-background-adjustments">
          <BackgroundMediaPreview media={media} onError={() => onBackgroundUnavailable(media.url)} />
          <div className="general-background-ranges">
            <RangeControl id="background-opacity" label="背景透明度" value={preferences.backgroundOpacity} onChange={value => onChange('backgroundOpacity', value)} />
            <RangeControl id="background-blur" label="柔化程度" value={preferences.backgroundBlur} onChange={value => onChange('backgroundBlur', value)} />
            <RangeControl id="background-surface" label="遮罩强度" value={preferences.backgroundSurfaceOpacity} onChange={value => onChange('backgroundSurfaceOpacity', value)} />
            <RangeControl id="background-inside" label="窗口内可见度" value={preferences.backgroundInsideVisibility} onChange={value => onChange('backgroundInsideVisibility', value)} />
          </div>
        </div>
      </details>}
      </div>
    </section>
    <section className="general-settings-section" aria-labelledby={`${sectionId}-conversation`}>
      <SectionHeading id={`${sectionId}-conversation`} title="对话" />
      <div className="general-settings-card">
      <SettingRow label="对话字号"><Stepper label="字号" value={preferences.fontSize} min={12} max={18} unit=" px" onChange={value => onChange('fontSize', value)} /></SettingRow>
      <SettingRow label="工作步骤展示"><div className="general-theme-options" role="group" aria-label="工作步骤展示">
        {([
          { value: 'compact', label: '精简' },
          { value: 'standard', label: '标准' },
          { value: 'detailed', label: '详细' },
        ] as const).map(({ value, label }) => <button type="button" key={value} aria-pressed={preferences.stepDisplay === value} onClick={() => onChange('stepDisplay', value)}>{label}</button>)}
      </div></SettingRow>
      <SettingRow label="工作步骤收起时机"><Select label="工作步骤收起时机" value={preferences.stepCollapse} onChange={value => onChange('stepCollapse', value as Preferences['stepCollapse'])} options={[{ value: 'after-answer', label: '回答结束后' }, { value: 'keep-open', label: '保持展开' }, { value: 'manual', label: '手动控制' }]} /></SettingRow>
      <SettingRow label="显示代码工作视图" description="开启后显示轨迹页与本轮代码差异；关闭后只保留回答和工具步骤。">
        <button type="button" className={`switch ${preferences.showCodeView ? 'is-on' : ''}`} role="switch" aria-checked={preferences.showCodeView} aria-label="显示代码工作视图" title={preferences.showCodeView ? '隐藏轨迹与代码差异' : '显示轨迹与代码差异'} onClick={() => onChange('showCodeView', !preferences.showCodeView)}><span /></button>
      </SettingRow>
      </div>
    </section>
    <section className="general-settings-section" aria-labelledby={`${sectionId}-terminal`}>
      <SectionHeading id={`${sectionId}-terminal`} title="终端" />
      <div className="general-settings-card">
      <SettingRow label="配色主题" description="选一套独立配色，终端就和窗口其余部分分开；默认跟随界面明暗。">
        <div className="terminal-theme-grid" role="group" aria-label="终端配色主题">
          {[{ id: STUDIO_TERMINAL_THEME, label: '跟随界面' }, ...TERMINAL_THEMES].map((theme) => <button
            type="button"
            key={theme.id}
            aria-pressed={preferences.terminalTheme === theme.id}
            onClick={() => onChange('terminalTheme', theme.id)}
          >
            {/* 色板自己套主题属性，直接由 palette.css 里那组变量上色 */}
            <span className="terminal-theme-swatch" aria-hidden="true" data-terminal-theme={theme.id} />
            {theme.label}
          </button>)}
        </div>
      </SettingRow>
      <SettingRow label="终端字体"><Select label="终端字体" value={preferences.terminalFontFamily} onChange={value => onChange('terminalFontFamily', value)} options={TERMINAL_FONT_OPTIONS} /></SettingRow>
      <SettingRow label="终端字号"><Stepper label="终端字号" value={preferences.terminalFontSize} min={11} max={20} unit=" px" onChange={value => onChange('terminalFontSize', value)} /></SettingRow>
      <SettingRow label="行高"><Stepper label="终端行高" value={preferences.terminalLineHeight} min={1} max={1.8} step={0.05} unit="" onChange={value => onChange('terminalLineHeight', value)} /></SettingRow>
      <SettingRow label="Shell 集成" description="让 zsh 标记每条命令的起点与退出码，用于失败定位与命令间跳转；只在 Studio 自己的目录写钩子，不改你的 ~/.zshrc。开启后新建或重连终端生效。">
        <button type="button" className={`switch ${preferences.terminalShellIntegration ? 'is-on' : ''}`} role="switch" aria-checked={preferences.terminalShellIntegration} aria-label="Shell 集成" onClick={() => onChange('terminalShellIntegration', !preferences.terminalShellIntegration)}><span /></button>
      </SettingRow>
      <SettingRow label="光标形状">
        <div className="general-theme-options" role="group" aria-label="终端光标形状">
          {([
            { value: 'bar', label: '竖线' },
            { value: 'block', label: '方块' },
            { value: 'underline', label: '下划线' },
          ] as const).map(({ value, label }) => <button type="button" key={value} aria-pressed={preferences.terminalCursorStyle === value} onClick={() => onChange('terminalCursorStyle', value)}>{label}</button>)}
        </div>
      </SettingRow>
      </div>
    </section>
    <section className="general-settings-section" aria-labelledby={`${sectionId}-application`}>
      <SectionHeading id={`${sectionId}-application`} title="应用" />
      <div className="general-settings-card">
      <SettingRow label="菜单栏图标"><button type="button" className={`switch ${menuBar.enabled ? 'is-on' : ''}`} role="switch" aria-checked={menuBar.enabled} disabled={!menuBar.available || menuBarBusy} aria-label={menuBar.enabled ? '隐藏菜单栏图标' : '显示菜单栏图标'} title={menuBar.available ? undefined : '当前平台不支持菜单栏图标'} onClick={() => onMenuBarChange(!menuBar.enabled)}><span /></button></SettingRow>
      <SettingRow label="网页链接打开方式"><Select label="网页链接打开方式" value={preferences.linkOpen} onChange={value => onChange('linkOpen', value as Preferences['linkOpen'])} options={[{ value: 'external', label: '系统浏览器' }, { value: 'window', label: '应用内窗口' }]} /></SettingRow>
      </div>
    </section>
    </div>
  </>;
}

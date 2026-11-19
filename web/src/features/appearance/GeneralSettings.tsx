import { Accordion } from '../../shared/Accordion';
import { useId, type ReactNode } from 'react';
import {
  Monitor,
  Moon,
  Settings,
  Sun,
} from 'lucide-react';
import { LoadingIndicator } from '../../shared/LoadingState';
import { desktopPlatform } from '../../shared/desktop-platform';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { Select } from '../../shared/Select';
import { Stepper } from '../../shared/Stepper';
import { RangeControl } from '../../shared/RangeControl';
import { DEFAULT_PREFERENCES, PALETTE_PRESETS, type Preferences } from '../../shared/preferences';
import { BackgroundMediaPreview } from '../../shell/BackgroundLayer';
import { TERMINAL_THEMES, STUDIO_TERMINAL_THEME } from '../terminal/terminal-themes';
import './styles/general-settings.css';

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
  ...(desktopPlatform() === 'win32' ? ['Cascadia Mono', 'Consolas'].map(value => ({ value, label: value })) : []),
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

function SectionHeading({ id, title, description }: { id: string; title: string; description?: string }) {
  return <header className="general-section-head">
    <h2 id={id}><strong>{title}</strong></h2>
    {description && <p className="general-section-description">{description}</p>}
  </header>;
}

function SegmentedOptions<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; icon?: typeof Sun }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return <div className={`general-theme-options ${className}`.trim()} role="group" aria-label={label}>
    {options.map(({ value: option, label: optionLabel, icon: Icon }) => (
      <button type="button" key={option} aria-pressed={value === option} onClick={() => onChange(option)}>
        {Icon && <Icon aria-hidden="true" />}
        {optionLabel}
      </button>
    ))}
  </div>;
}

/** Preference persistence and native media operations remain owned by App. */
export function GeneralSettings({
  preferences,
  onChange,
  backgroundBusy,
  backgroundError,
  onChooseBackground,
  onRemoveBackground,
  onBackgroundUnavailable,
  menuBar,
  menuBarBusy,
  onMenuBarChange,
}: Props) {
  const sectionId = useId();
  const media = preferences.backgroundMedia;
  const windows = desktopPlatform() === 'win32';
  const trayLabel = windows ? '系统托盘图标' : '菜单栏图标';
  const backgroundAdjusted = Boolean(media) && (
    preferences.backgroundOpacity !== DEFAULT_PREFERENCES.backgroundOpacity
    || preferences.backgroundBlur !== DEFAULT_PREFERENCES.backgroundBlur
    || preferences.backgroundSurfaceOpacity !== DEFAULT_PREFERENCES.backgroundSurfaceOpacity
    || preferences.backgroundInsideVisibility !== DEFAULT_PREFERENCES.backgroundInsideVisibility
  );

  function resetBackgroundAdjustments() {
    onChange('backgroundOpacity', DEFAULT_PREFERENCES.backgroundOpacity);
    onChange('backgroundBlur', DEFAULT_PREFERENCES.backgroundBlur);
    onChange('backgroundSurfaceOpacity', DEFAULT_PREFERENCES.backgroundSurfaceOpacity);
    onChange('backgroundInsideVisibility', DEFAULT_PREFERENCES.backgroundInsideVisibility);
  }

  return <>
    <SettingsPageHeader
      icon={<Settings />}
      title="通用"
      meta={<span className="general-page-lead">主题、背景、对话阅读与终端</span>}
    />
    <div className="general-settings">
      <section className="general-settings-section" aria-labelledby={`${sectionId}-appearance`}>
        <SectionHeading id={`${sectionId}-appearance`} title="外观" description="先定整体氛围，再细调背景与对话阅读。" />
        <div className="general-settings-card">
          <SettingRow label="界面模式">
            <SegmentedOptions
              label="界面模式"
              className="general-theme-modes"
              value={preferences.theme}
              onChange={(value) => onChange('theme', value)}
              options={[
                { value: 'light', label: '浅色', icon: Sun },
                { value: 'dark', label: '深色', icon: Moon },
                { value: 'system', label: '跟随系统', icon: Monitor },
              ]}
            />
          </SettingRow>
          <SettingRow label="强调色" description="影响按钮、开关和选中态，不改变正文颜色。">
            <div className="general-palette-options" role="radiogroup" aria-label="强调色">
              {PALETTE_PRESETS.map((preset) => (
                <label key={preset.id} className="general-palette-option" data-palette-choice={preset.id} title={preset.description}>
                  <input
                    type="radio"
                    name="palette"
                    value={preset.id}
                    checked={preferences.palette === preset.id}
                    onChange={() => onChange('palette', preset.id)}
                  />
                  <span className="general-palette-swatch" aria-hidden="true" />
                  <span>{preset.label}</span>
                </label>
              ))}
            </div>
          </SettingRow>
          <SettingRow label="圆角风格" description="卡片、输入框和按钮统一使用同一圆角档位。">
            <SegmentedOptions
              label="圆角风格"
              className="general-radius-options"
              value={preferences.radiusStyle}
              onChange={(value) => onChange('radiusStyle', value)}
              options={[
                { value: 'square', label: '直角' },
                { value: 'compact', label: '紧凑' },
                { value: 'standard', label: '标准' },
                { value: 'soft', label: '柔和' },
              ]}
            />
          </SettingRow>
        </div>
      </section>

      <section className="general-settings-section" aria-labelledby={`${sectionId}-background`}>
        <SectionHeading
          id={`${sectionId}-background`}
          title="背景"
          description="支持图片与静音循环视频。透明度、柔化和遮罩作用在窗口留白；窗口内可见度同时影响侧栏、顶栏与对话区。"
        />
        <div className="general-settings-card">
          <SettingRow
            label="媒体文件"
            description="PNG、JPEG、WebP、GIF、AVIF、MP4、MOV、M4V、WebM，最大 2 GB。MOV / WebM 取决于编码。"
          >
            <button type="button" className="settings-outline" disabled={backgroundBusy} onClick={onChooseBackground}>
              {backgroundBusy && <LoadingIndicator />}
              {media ? '更换' : '选择媒体'}
            </button>
            {media && (
              <button type="button" className="settings-outline" disabled={backgroundBusy} onClick={onRemoveBackground}>
                移除
              </button>
            )}
          </SettingRow>
          {backgroundError && <div className="background-setting-error" role="alert">{backgroundError}</div>}
          {media && (
            <div className="general-background-panel">
              <Accordion
                className="general-background-settings"
                defaultOpen
                summary={<span className="general-background-name" title={media.name}>{media.name}</span>}
                badge={media.kind === 'video' ? '视频' : '图片'}
                summaryClassName="general-background-summary"
              >
                <div className="general-background-adjustments">
                  <BackgroundMediaPreview media={media} onError={() => onBackgroundUnavailable(media.url)} />
                  <div className="general-background-ranges">
                    <div className="general-background-range-head">
                      <span>调节</span>
                      {backgroundAdjusted && (
                        <button
                          type="button"
                          className="settings-text-button"
                          onClick={resetBackgroundAdjustments}
                        >
                          恢复默认
                        </button>
                      )}
                    </div>
                    <div className="general-background-range-grid">
                      <RangeControl
                        id="background-opacity"
                        label="透明度"
                        description="四周留白里的背景浓度"
                        value={preferences.backgroundOpacity}
                        onChange={(value) => onChange('backgroundOpacity', value)}
                      />
                      <RangeControl
                        id="background-blur"
                        label="柔化"
                        description="背景模糊程度"
                        value={preferences.backgroundBlur}
                        onChange={(value) => onChange('backgroundBlur', value)}
                      />
                      <RangeControl
                        id="background-surface"
                        label="遮罩"
                        description="内容背后的遮罩强度"
                        value={preferences.backgroundSurfaceOpacity}
                        onChange={(value) => onChange('backgroundSurfaceOpacity', value)}
                      />
                      <RangeControl
                        id="background-inside"
                        label="窗口内"
                        description="侧栏与对话区透出的背景"
                        value={preferences.backgroundInsideVisibility}
                        onChange={(value) => onChange('backgroundInsideVisibility', value)}
                      />
                    </div>
                  </div>
                </div>
              </Accordion>
            </div>
          )}
        </div>
      </section>

      <section className="general-settings-section" aria-labelledby={`${sectionId}-conversation`}>
        <SectionHeading id={`${sectionId}-conversation`} title="对话" description="阅读字号与工作步骤的展示方式。" />
        <div className="general-settings-card">
          <SettingRow label="对话字号">
            <Stepper label="字号" value={preferences.fontSize} min={12} max={18} unit=" px" onChange={(value) => onChange('fontSize', value)} />
          </SettingRow>
          <SettingRow label="工作步骤" description="精简只保留关键步骤，详细展示更多过程信息。">
            <SegmentedOptions
              label="工作步骤展示"
              value={preferences.stepDisplay}
              onChange={(value) => onChange('stepDisplay', value)}
              options={[
                { value: 'compact', label: '精简' },
                { value: 'standard', label: '标准' },
                { value: 'detailed', label: '详细' },
              ]}
            />
          </SettingRow>
          <SettingRow label="步骤收起">
            <Select
              label="工作步骤收起时机"
              value={preferences.stepCollapse}
              onChange={(value) => onChange('stepCollapse', value as Preferences['stepCollapse'])}
              options={[
                { value: 'after-answer', label: '回答结束后' },
                { value: 'keep-open', label: '保持展开' },
                { value: 'manual', label: '手动控制' },
              ]}
            />
          </SettingRow>
          <SettingRow label="代码工作视图" description="开启后显示轨迹页与本轮代码差异；关闭后只保留回答和工具步骤。">
            <button
              type="button"
              className={`switch ${preferences.showCodeView ? 'is-on' : ''}`}
              role="switch"
              aria-checked={preferences.showCodeView}
              aria-label="显示代码工作视图"
              title={preferences.showCodeView ? '隐藏轨迹与代码差异' : '显示轨迹与代码差异'}
              onClick={() => onChange('showCodeView', !preferences.showCodeView)}
            >
              <span />
            </button>
          </SettingRow>
        </div>
      </section>

      <section className="general-settings-section" aria-labelledby={`${sectionId}-terminal`}>
        <SectionHeading id={`${sectionId}-terminal`} title="终端" description="终端可使用独立配色，与窗口其余部分分开。" />
        <div className="general-settings-card">
          <SettingRow label="配色主题" description="默认跟随界面明暗；也可选一套终端专用配色。">
            <div className="terminal-theme-grid" role="group" aria-label="终端配色主题">
              {[{ id: STUDIO_TERMINAL_THEME, label: '跟随界面' }, ...TERMINAL_THEMES].map((theme) => (
                <button
                  type="button"
                  key={theme.id}
                  aria-pressed={preferences.terminalTheme === theme.id}
                  onClick={() => onChange('terminalTheme', theme.id)}
                >
                  <span className="terminal-theme-swatch" aria-hidden="true" data-terminal-theme={theme.id} />
                  {theme.label}
                </button>
              ))}
            </div>
          </SettingRow>
          <SettingRow label="字体">
            <Select
              label="终端字体"
              value={preferences.terminalFontFamily}
              onChange={(value) => onChange('terminalFontFamily', value)}
              options={TERMINAL_FONT_OPTIONS}
            />
          </SettingRow>
          <SettingRow label="字号">
            <Stepper label="终端字号" value={preferences.terminalFontSize} min={11} max={20} unit=" px" onChange={(value) => onChange('terminalFontSize', value)} />
          </SettingRow>
          <SettingRow label="行高">
            <Stepper label="终端行高" value={preferences.terminalLineHeight} min={1} max={1.8} step={0.05} unit="" onChange={(value) => onChange('terminalLineHeight', value)} />
          </SettingRow>
          <SettingRow label="光标形状">
            <SegmentedOptions
              label="终端光标形状"
              value={preferences.terminalCursorStyle}
              onChange={(value) => onChange('terminalCursorStyle', value)}
              options={[
                { value: 'bar', label: '竖线' },
                { value: 'block', label: '方块' },
                { value: 'underline', label: '下划线' },
              ]}
            />
          </SettingRow>
          {!windows && (
            <SettingRow
              label="Shell 集成"
              description="在 Studio 自有目录写入 zsh 钩子，标记命令起点与退出码，便于失败定位。不改 ~/.zshrc；新建或重连终端后生效。"
            >
              <button
                type="button"
                className={`switch ${preferences.terminalShellIntegration ? 'is-on' : ''}`}
                role="switch"
                aria-checked={preferences.terminalShellIntegration}
                aria-label="Shell 集成"
                onClick={() => onChange('terminalShellIntegration', !preferences.terminalShellIntegration)}
              >
                <span />
              </button>
            </SettingRow>
          )}
        </div>
      </section>

      <section className="general-settings-section" aria-labelledby={`${sectionId}-application`}>
        <SectionHeading id={`${sectionId}-application`} title="应用" description="窗口行为与外链打开方式。" />
        <div className="general-settings-card">
          <SettingRow
            label={trayLabel}
            description={windows ? '开启后，关闭主窗口会收起到托盘，后台任务可继续运行。' : '在菜单栏显示 Studio 图标，便于快速回到会话。'}
          >
            <button
              type="button"
              className={`switch ${menuBar.enabled ? 'is-on' : ''}`}
              role="switch"
              aria-checked={menuBar.enabled}
              disabled={!menuBar.available || menuBarBusy}
              aria-label={`${menuBar.enabled ? '隐藏' : '显示'}${trayLabel}`}
              title={menuBar.available ? undefined : `当前平台不支持${trayLabel}`}
              onClick={() => onMenuBarChange(!menuBar.enabled)}
            >
              <span />
            </button>
          </SettingRow>
          <SettingRow label="网页链接" description="对话与设置中的外链默认打开位置。">
            <Select
              label="网页链接打开方式"
              value={preferences.linkOpen}
              onChange={(value) => onChange('linkOpen', value as Preferences['linkOpen'])}
              options={[
                { value: 'external', label: '系统浏览器' },
                { value: 'window', label: '应用内窗口' },
              ]}
            />
          </SettingRow>
        </div>
      </section>
    </div>
  </>;
}

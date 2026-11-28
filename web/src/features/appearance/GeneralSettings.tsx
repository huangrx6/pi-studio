import { useRef, useState, type ReactNode } from 'react';
import { PreferenceGroup, PreferenceRow } from '../../shared/PreferenceGroup';
import { Accordion } from '../../shared/Accordion';
import { LoadingIndicator } from '../../shared/LoadingState';
import { desktopPlatform } from '../../shared/desktop-platform';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { Select } from '../../shared/Select';
import { Stepper } from '../../shared/Stepper';
import { RangeControl } from '../../shared/RangeControl';
import { CHAT_FONT_SIZE_RANGE, DEFAULT_PREFERENCES, PALETTE_PRESETS, type BackgroundMedia, type Preferences } from '../../shared/preferences';
import { BackgroundMediaPreview } from '../../shell/BackgroundLayer';
import { TERMINAL_THEMES, STUDIO_TERMINAL_THEME } from '../terminal/terminal-themes';
import { ThemeModePicker } from './ThemeModePicker';
import './styles/general-settings.css';

type Props = {
  preferences: Preferences;
  onChange: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  backgroundBusy: boolean;
  onChooseBackground: () => void;
  onRemoveBackground: () => void;
  onBackgroundUnavailable: (url: string) => void;
  menuBar: { available: boolean; enabled: boolean };
  menuBarBusy: boolean;
  onMenuBarChange: (enabled: boolean) => void;
  /** Jump to Settings → Browser open-target controls. */
  onOpenBrowserSettings?: () => void;
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
  return <PreferenceRow title={label} description={description} control={children}
    className="general-setting-row" copyClassName="general-setting-label"
    descriptionClassName="general-setting-description" controlClassName="general-setting-control" />;
}

const STEP_DISPLAY_OPTIONS = [
  { value: 'compact', label: '精简' },
  { value: 'standard', label: '标准' },
  { value: 'detailed', label: '详细' },
] as const;

const TERMINAL_THEME_OPTIONS = [
  { value: STUDIO_TERMINAL_THEME, label: '跟随界面' },
  ...TERMINAL_THEMES.map(theme => ({ value: theme.id, label: theme.label })),
];

function SegmentedOptions<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return <div className={`settings-segments ${className}`.trim()} role="group" aria-label={label}>
    {options.map(({ value: option, label: optionLabel }) => (
      <button type="button" key={option} aria-pressed={value === option} onClick={() => onChange(option)}>
        {optionLabel}
      </button>
    ))}
  </div>;
}

function BackgroundAdjustments({ media, initiallyOpen, onUnavailable, children }: {
  media: BackgroundMedia;
  initiallyOpen: boolean;
  onUnavailable: (url: string) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return <Accordion className="general-background-settings" open={open}
    onToggle={event => setOpen(event.currentTarget.open)}
    summary={<>
      <span className="general-background-label">调节背景</span>
      <span className="general-background-file">
        <span className="general-background-name" dir="auto" title={media.name}>{media.name}</span>
        <span className="pi-accordion-badge">{media.kind === 'video' ? '视频' : '图片'}</span>
      </span>
    </>}
    summaryClassName="general-background-summary">
    {open && <div className="general-background-adjustments">
      <BackgroundMediaPreview media={media} onError={() => onUnavailable(media.url)} />
      {children}
    </div>}
  </Accordion>;
}

/** Preference persistence and native media operations remain owned by App. */
export function GeneralSettings({
  preferences,
  onChange,
  backgroundBusy,
  onChooseBackground,
  onRemoveBackground,
  onBackgroundUnavailable,
  menuBar,
  menuBarBusy,
  onMenuBarChange,
  onOpenBrowserSettings,
}: Props) {
  const media = preferences.backgroundMedia;
  const defaultChatFontSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--text-body'));
  const chatFontSize = preferences.fontSize ?? defaultChatFontSize;
  const initialMediaUrl = useRef(media?.url);
  const windows = desktopPlatform() === 'win32';
  const trayLabel = windows ? '系统托盘图标' : '菜单栏图标';
  const stepDisplay = STEP_DISPLAY_OPTIONS.find(option => option.value === preferences.stepDisplay)?.label ?? '标准';
  const terminalTheme = TERMINAL_THEME_OPTIONS.find(option => option.value === preferences.terminalTheme)?.label ?? '跟随界面';
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

  return <div className="settings-preference-page general-settings-page">
    <SettingsPageHeader
      className="general-page-header"
      iconPosition="end"
      icon={
        <svg className="general-tuning-mark" viewBox="0 0 32 32" fill="none" stroke="currentColor"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M1 10h18m6 0h6M1 22h6m6 0h18" />
          <rect className="general-tuning-accent" x="19" y="6" width="6" height="8" rx="2.5" />
          <rect x="7" y="18" width="6" height="8" rx="2.5" />
        </svg>
      }
      title="通用"
      meta="调整窗口外观、对话阅读和终端偏好。"
    />
    <div className="settings-preference-groups general-settings">
      <PreferenceGroup title="外观">
        <ThemeModePicker value={preferences.theme} onChange={value => onChange('theme', value)} />
        <SettingRow label="强调色" description="用于按钮、开关和选中项。">
          <div className="settings-segments" role="radiogroup" aria-label="强调色">
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
        <SettingRow label="圆角风格" description="应用于卡片、输入框和按钮。">
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
      </PreferenceGroup>

      <PreferenceGroup
        title="背景"
        description="可使用图片或静音循环视频，最大 2 GB。"
        actions={<>
          <button type="button" className="settings-outline" disabled={backgroundBusy} onClick={onChooseBackground}
            title="PNG、JPEG、WebP、GIF、AVIF、MP4、MOV、M4V、WebM。MOV 和 WebM 的播放取决于编码。">
            {backgroundBusy && <LoadingIndicator />}
            {media ? '更换媒体' : '选择媒体'}
          </button>
          {media && (
            <button type="button" className="settings-outline" disabled={backgroundBusy} onClick={onRemoveBackground}>
              移除
            </button>
          )}
        </>}
      >
        {media && (
          <BackgroundAdjustments key={media.url} media={media}
            initiallyOpen={media.url !== initialMediaUrl.current} onUnavailable={onBackgroundUnavailable}>
            <div className="general-background-ranges">
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
                  description="窗口四周壁纸的模糊程度"
                  value={preferences.backgroundBlur}
                  onChange={(value) => onChange('backgroundBlur', value)}
                />
                <RangeControl
                  id="background-surface"
                  label="遮罩"
                  description="窗口四周壁纸上的遮罩强度"
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
              <div className="general-background-range-foot">
                <button type="button" className="settings-outline" disabled={!backgroundAdjusted} onClick={resetBackgroundAdjustments}>
                  恢复默认
                </button>
              </div>
            </div>
          </BackgroundAdjustments>
        )}
      </PreferenceGroup>

      <PreferenceGroup title="对话" summary={`${chatFontSize} px · ${stepDisplay}步骤`} defaultOpen>
        <SettingRow label="对话字号">
          <Stepper label="字号" value={chatFontSize} {...CHAT_FONT_SIZE_RANGE} unit=" px"
            onChange={(value) => onChange('fontSize', value === defaultChatFontSize ? null : value)} />
        </SettingRow>
        <SettingRow label="工作步骤" description="选择对话中显示多少过程信息。">
          <SegmentedOptions
            label="工作步骤展示"
            value={preferences.stepDisplay}
            onChange={(value) => onChange('stepDisplay', value)}
            options={STEP_DISPLAY_OPTIONS}
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
        <SettingRow label="代码工作视图" description="显示对话轨迹和本轮代码差异。">
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
      </PreferenceGroup>

      <PreferenceGroup title="终端" summary={`${terminalTheme} · ${preferences.terminalFontSize} px`} defaultOpen>
        <figure className="general-terminal-preview" data-terminal-theme={preferences.terminalTheme}>
          <figcaption className="general-terminal-chrome">
            <span className="general-terminal-dots" aria-hidden="true"><i /><i /><i /></span>
            <span className="general-terminal-caption">终端预览</span>
            <span className="general-terminal-meta">{terminalTheme} · {preferences.terminalFontSize}px</span>
          </figcaption>
          <samp style={{
            fontFamily: preferences.terminalFontFamily ? `"${preferences.terminalFontFamily.replaceAll('"', '')}", var(--mono)` : 'var(--mono)',
            fontSize: preferences.terminalFontSize,
            lineHeight: preferences.terminalLineHeight,
          }}>
            <span><b aria-hidden="true">❯ </b>echo "Pi Studio"</span>
            <span>Pi Studio</span>
            <span aria-hidden="true"><b>❯ </b><i className="general-terminal-cursor" data-shape={preferences.terminalCursorStyle} /></span>
          </samp>
        </figure>
        <div className="general-terminal-grid">
          <label className="general-terminal-field">
            <span>配色主题</span>
            <Select label="终端配色主题" value={preferences.terminalTheme} options={TERMINAL_THEME_OPTIONS}
              onChange={value => onChange('terminalTheme', value)} />
          </label>
          <label className="general-terminal-field">
            <span>字体</span>
            <Select
              label="终端字体"
              value={preferences.terminalFontFamily}
              onChange={(value) => onChange('terminalFontFamily', value)}
              options={TERMINAL_FONT_OPTIONS}
            />
          </label>
          <div className="general-terminal-field">
            <span>字号</span>
            <Stepper label="终端字号" value={preferences.terminalFontSize} min={11} max={20} unit=" px" onChange={(value) => onChange('terminalFontSize', value)} />
          </div>
          <div className="general-terminal-field">
            <span>行高</span>
            <Stepper label="终端行高" value={preferences.terminalLineHeight} min={1} max={1.8} step={0.05} unit="" onChange={(value) => onChange('terminalLineHeight', value)} />
          </div>
        </div>
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
            description="在 Studio 目录写入 zsh 钩子，标记命令起点与退出码。新建或重连终端后生效。"
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
      </PreferenceGroup>

      <PreferenceGroup title="应用" summary={menuBar.available ? `${trayLabel}${menuBar.enabled ? '已开启' : '已关闭'}` : '链接打开位置'} defaultOpen>
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
        <SettingRow
          label="链接打开位置"
          description="选择在工作台或系统应用中打开网页与本地链接。"
        >
          {onOpenBrowserSettings ? (
            <button type="button" className="settings-outline" onClick={onOpenBrowserSettings}>
              浏览器设置
            </button>
          ) : (
            <span className="general-setting-description">请打开设置 → 浏览器</span>
          )}
        </SettingRow>
      </PreferenceGroup>
    </div>
  </div>;
}

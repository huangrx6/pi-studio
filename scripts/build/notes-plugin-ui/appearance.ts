import type { CSSProperties } from 'react';
import spec from '../../../assets/official-plugins/packages/notes-library/extension/appearance.json';

export type Scheme = 'light' | 'dark';
export type Appearance = { theme: string; outlineWidth: number };
type Palette = {
  scheme: Scheme;
  serif?: boolean;
  bg: string;
  surface: string;
  floating: string;
  text: string;
  muted: string;
  heading?: string;
  accent: string;
  action: string;
  code: string;
  inlineFg?: string;
  quoteBg?: string;
  keyword: string;
  string: string;
  number: string;
};
type Preset = { id: string; title: string } & (Palette | { scheme?: undefined });

export const presets = spec.themes as Preset[];
export const OUTLINE = spec.outline;
export const DEFAULT_APPEARANCE: Appearance = { theme: spec.defaultTheme, outlineWidth: OUTLINE.initial };

export function notesTheme(id: string, studioScheme: Scheme) {
  const preset = presets.find(value => value.id === id) ?? presets[0];
  const scheme = preset.scheme ?? studioScheme;
  const style: CSSProperties = preset.scheme ? {
    colorScheme: scheme,
    '--bg': preset.bg,
    '--surface': preset.surface,
    '--chrome-surface': preset.surface,
    '--surface-floating': preset.floating,
    '--text': preset.text,
    '--muted': preset.muted,
    '--reading-heading': preset.heading ?? preset.text,
    '--accent': preset.accent,
    '--button-bg': preset.action,
    '--reading-code': preset.code,
    ...(preset.inlineFg && { '--reading-inline-fg': preset.inlineFg }),
    ...(preset.quoteBg && { '--reading-quote-bg': preset.quoteBg }),
    '--code-keyword': preset.keyword,
    '--code-string': preset.string,
    '--code-number': preset.number,
    ...(preset.serif && { '--reading-font': '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, var(--font)' }),
  } as CSSProperties : { colorScheme: scheme };
  return { id: preset.id, scheme, isCustom: Boolean(preset.scheme), style };
}

export function previewColor(element: Element, scheme: Scheme) {
  const css = getComputedStyle(element);
  return {
    scheme,
    background: css.getPropertyValue('--reading-bg').trim(),
    foreground: css.getPropertyValue('--reading-text').trim(),
  };
}

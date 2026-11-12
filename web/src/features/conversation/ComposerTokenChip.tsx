/**
 * 输入框里的引用徽章。
 *
 * 气泡里的 `.ref-chip` 会替换成短标签，但输入框不能这么做：高亮层必须与
 * textarea 的文字逐字符对齐，所以这里保留 token 原文，只用背景、描边和
 * 图标提升辨识度。图标的宽度用负外边距抵消，布局宽度因此和纯文本一致。
 */
import { Folder, Sparkles, SquareTerminal } from 'lucide-react';
import { attachmentVisual } from '../../shared/AttachmentIcon';
import type { ComposerSegment } from './references';

type TokenSegment = Extract<ComposerSegment, { kind: 'token' }>;

/** 按 token 目标挑图标：目录、技能、命令各一枚，其余交给附件类型表。 */
function tokenVisual(segment: TokenSegment) {
  if (segment.tokenKind === 'command') return { Icon: SquareTerminal };
  if (segment.tokenKind === 'skill') return { Icon: Sparkles };
  const path = segment.reference?.location ?? '';
  if (/[/\\]$/u.test(path)) return { Icon: Folder };
  const name = path.split(/[/\\]/u).filter(Boolean).pop() || path;
  return { Icon: attachmentVisual(name).Icon };
}

export function ComposerTokenChip({ segment }: { segment: TokenSegment }) {
  const { Icon } = tokenVisual(segment);
  const classes = [`composer-token`, `is-${segment.tokenKind}`];
  if (segment.gapBefore) classes.push('has-icon');
  if (segment.lineStart) classes.push('is-line-start');
  return <span className={classes.join(' ')}>
    {segment.gapBefore && <Icon className="composer-token-icon" aria-hidden="true" />}
    <span className="composer-token-prefix">{segment.text.slice(0, 1)}</span>
    {segment.text.slice(1)}
  </span>;
}

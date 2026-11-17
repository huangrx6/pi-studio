import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Pencil } from 'lucide-react';
import { messageClipboardHtml } from './message-copy';
import { formatTime } from './message-content';

/** 写入剪贴板；Clipboard API 不可用时退回 execCommand。 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 富文本剪贴板：正文 + 内联图片；主进程不可用时退回纯文本。 */
async function writeRichClipboard(text: string, html: string): Promise<boolean> {
  try {
    await window.piApi.copyRichText({ text, html });
    return true;
  } catch {
    return writeClipboard(text);
  }
}

/** 复制按钮：点击后短暂切换成对勾，避免额外弹提示。 */
function CopyButton({ text, images, label }: { text: string; images?: readonly string[]; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  async function copy() {
    const html = images && images.length > 0 ? messageClipboardHtml({ text, images }) : '';
    if (!text.trim() && !html) return;
    if (!(html ? await writeRichClipboard(text, html) : await writeClipboard(text))) return;
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }
  return <button
    type="button"
    className={`message-action ${copied ? 'is-copied' : ''}`}
    aria-label={copied ? '已复制' : label}
    title={copied ? '已复制' : label}
    onClick={() => void copy()}
  >{copied ? <Check /> : <Copy />}</button>;
}

/** 消息下方的悬浮操作行：复制、编辑与时间；没有内容时整行隐藏。 */
export function MessageActions({ text, images, time, label, children, align = 'start', onEdit, editDisabled = false }: {
  text: string;
  images?: readonly string[];
  time?: number;
  label: string;
  children?: ReactNode;
  align?: 'start' | 'end';
  onEdit?: () => void;
  editDisabled?: boolean;
}) {
  const hasImages = Boolean(images && images.length > 0);
  if (!text.trim() && !hasImages && !time && !children) return null;
  return <div className={`message-actions is-${align}`}>
    {(text.trim() || hasImages) && <CopyButton text={text} images={images} label={label} />}
    {onEdit && <button
      type="button"
      className="message-action"
      aria-label="编辑消息"
      title={editDisabled ? '回答结束后可编辑消息' : '编辑消息'}
      disabled={editDisabled}
      onClick={onEdit}
    ><Pencil /></button>}
    {children}
    {time ? <time className="message-action-time">{formatTime(time)}</time> : null}
  </div>;
}

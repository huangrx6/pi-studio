import { AttachmentIcon } from '../../shared/AttachmentIcon';
import { previewExtension } from '../../shared/file-preview';
import { formatFileSize } from '../../shared/filesize';
import type { ChatAttachment } from '../../types/chat-types';

type FileDetails = Pick<ChatAttachment, 'name' | 'mime' | 'bytes'> & { lines?: number };

export function AttachmentFileDetails({ attachment }: { attachment: FileDetails }) {
  const { name, mime, bytes, lines } = attachment;
  const metadata = [previewExtension(name).toUpperCase(), formatFileSize(bytes)].filter(Boolean).join(' · ');
  return <>
    <AttachmentIcon name={name} mime={mime} />
    <span className="attachment-file-caption">
      <strong>{name}</strong>
      <small title={lines ? `${metadata} · ${lines.toLocaleString('zh-CN')} 行` : undefined}>{metadata}</small>
    </span>
  </>;
}

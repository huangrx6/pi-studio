export type ArchivePreviewData =
  | { format: 'zip'; count: number; entries: { name: string; size: number }[] }
  | { format: 'docx' | 'xlsx' | 'pptx'; parts: Record<string, string>; clipped: boolean };

/** Renderer-safe payload for a read-only file preview. */
export type FilePreviewResult = {
  path: string;
  /** Process-local identity for change notifications on a live file. */
  changeKey?: string;
  name: string;
  size: number;
  mimeType: string;
  kind: 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'binary' | 'archive';
  archive?: ArchivePreviewData;
  text?: string;
  dataUrl?: string;
  truncated?: boolean;
  unavailableReason?: string;
  byteSample?: string;
};

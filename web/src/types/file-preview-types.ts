/** Renderer-safe payload for a read-only file preview. */
export type FilePreviewResult = {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  kind: 'text' | 'image' | 'audio' | 'video' | 'binary';
  text?: string;
  dataUrl?: string;
  truncated?: boolean;
  unavailableReason?: string;
};

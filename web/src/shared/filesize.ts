/** Format byte counts consistently across file browsers, previews and attachments. */
export function formatFileSize(size: number | undefined, zeroLabel = '0 B'): string {
  if (!size || size < 0) return zeroLabel;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / (1024 * 1024) * 10) / 10} MB`;
}

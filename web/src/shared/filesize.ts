/** Format byte counts consistently across file browsers, previews and attachments. */
export function formatFileSize(size: number | undefined, zeroLabel = '0 B'): string {
  if (!size || size < 0) return zeroLabel;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  if (size < 1024 ** 3) return `${Math.round(size / 1024 ** 2 * 10) / 10} MB`;
  if (size < 1024 ** 4) return `${Math.round(size / 1024 ** 3 * 10) / 10} GB`;
  return `${Math.round(size / 1024 ** 4 * 10) / 10} TB`;
}

const { inspectZipEntries } = require('../core/extension-archive.cjs');

const MAX_ARCHIVE_BYTES = 8_000_000;
const formats = new Set(['.docx', '.xlsx', '.pptx', '.zip']);
const documentParts = {
  '.docx': /^word\/document\.xml$/,
  '.xlsx': /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/,
  '.pptx': /^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/[^/]+\.xml)$/,
};

// Only bounded metadata and document XML leave the main process. Nothing is extracted to disk.
function archivePreview(extension, buffer) {
  const files = inspectZipEntries(buffer, { stripWrapper: false, limits: {
    maxArchiveBytes: MAX_ARCHIVE_BYTES, maxFileBytes: 8_000_000, maxExtractedBytes: 16_000_000, maxEntries: 2048,
  } });
  if (extension === '.zip') {
    return { format: 'zip', count: files.size, entries: [...files].slice(0, 240).map(([name, entry]) => ({ name, size: entry.content.length })) };
  }
  const parts = {};
  let remaining = 3_000_000;
  let clipped = false;
  // Read the document index and strings before slide or sheet content.
  const names = [...files.keys()].filter(name => documentParts[extension].test(name))
    .sort((a, b) => Number(/\/(?:slides|worksheets)\//.test(a)) - Number(/\/(?:slides|worksheets)\//.test(b)) || a.localeCompare(b, 'en', { numeric: true }));
  for (const name of names) {
    const { content } = files.get(name);
    if (content.length > remaining || Object.keys(parts).length >= 40) { clipped = true; continue; }
    remaining -= content.length;
    parts[name] = content.toString('utf8');
  }
  return { format: extension.slice(1), parts, clipped };
}

module.exports = { MAX_ARCHIVE_BYTES, archivePreview, archiveFormats: formats };

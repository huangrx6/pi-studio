/** Fork-aware keyset paging. Never split an entry using a mutable page offset. */
const PAGE_BYTES = 2 * 1024 * 1024;

function position(message) {
  return { entryId: message.sourceIndex, offset: message.sourceOffset ?? 0 };
}

function validatePosition(value) {
  if (!value || !Number.isSafeInteger(value.entryId) || value.entryId <= 0
    || !Number.isSafeInteger(value.offset) || value.offset < -1) throw new Error('历史消息位置无效');
  return { entryId: value.entryId, offset: value.offset };
}

async function readHistoryPage({ readEntries, project, order = 'descending', boundary, limit = 200, turnLimit, maxBytes = PAGE_BYTES }) {
  if (boundary) validatePosition(boundary);
  const ascending = order === 'ascending';
  const query = { order, ...(boundary ? { [ascending ? 'minEntryId' : 'maxEntryId']: boundary.entryId } : {}) };
  const picked = [];
  const rounds = turnLimit === undefined ? null : Math.max(1, Math.min(20, Math.floor(Number(turnLimit) || 1)));
  let turns = 0;
  let bytes = 0;
  let cursor;
  let hasMore = false;
  let done = false;
  do {
    const page = await readEntries(query, Math.min(64, limit + 1), cursor);
    for (const entry of page.items) {
      const projected = project(entry).map((message, sourceOffset) => ({ ...message, sourceOffset }));
      const candidates = ascending ? projected : projected.reverse();
      for (const message of candidates) {
        if (boundary && Number(entry.id) === boundary.entryId
          && (ascending ? message.sourceOffset <= boundary.offset : message.sourceOffset >= boundary.offset)) continue;
        const size = Buffer.byteLength(JSON.stringify(message), 'utf8');
        // One oversized message remains whole; never silently truncate transcript content.
        // Round mode only stops between complete user-led rounds. A single
        // oversized round stays intact; bytes are a soft budget in this mode.
        const roundBoundary = ascending ? message.role === 'user' : picked.at(-1)?.role === 'user';
        const full = rounds === null
          ? picked.length >= limit || bytes + size > maxBytes
          : roundBoundary && (turns >= rounds || bytes >= maxBytes);
        if (picked.length && full) {
          hasMore = true;
          done = true;
          break;
        }
        if (ascending ? message.role === 'user' || picked.length === 0 : message.role === 'user') turns += 1;
        picked.push(message);
        bytes += size;
      }
      if (done) break;
    }
    if (done || !page.next) break;
    if (page.next === cursor) throw new Error('历史分页游标未推进');
    cursor = page.next;
  } while (true);
  const messages = ascending ? picked : picked.reverse();
  return { messages, hasMore, first: messages.length ? position(messages[0]) : undefined, last: messages.length ? position(messages.at(-1)) : undefined };
}

module.exports = { readHistoryPage, validatePosition, PAGE_BYTES };

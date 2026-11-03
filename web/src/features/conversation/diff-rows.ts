export type DiffLine = { text: string; number: number; changed?: boolean };
export type DiffPair = { left?: DiffLine; right?: DiffLine; gap?: string };
/** Pair contiguous deletion/addition runs; hunk numbers remain authoritative. */
export function splitPatch(patch: string): DiffPair[] {
  const rows: DiffPair[] = [];
  let old = 0, next = 0, end = 0, inHunk = false;
  let removed: DiffLine[] = [], added: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({ left: removed[i], right: added[i] });
    removed = []; added = [];
  };
  for (const line of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (match) {
      flush(); old = +match[1]; next = +match[2];
      const skipped = old - end - 1;
      if (skipped > 0) rows.push({ gap: `省略 ${skipped} 行未改动内容` });
      inHunk = true; continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('-')) { removed.push({text:line.slice(1),number:old++,changed:true}); end = old-1; }
    else if (line.startsWith('+')) added.push({text:line.slice(1),number:next++,changed:true});
    else if (line.startsWith(' ')) { flush(); rows.push({left:{text:line.slice(1),number:old++},right:{text:line.slice(1),number:next++}}); end = old-1; }
  }
  flush(); return rows;
}
export function changedRange(text: string, other?: string): [number, number] | null {
  if (other === undefined) return null;
  let start = 0, end = text.length, otherEnd = other.length;
  while (start < end && start < otherEnd && text[start] === other[start]) start++;
  while (end > start && otherEnd > start && text[end-1] === other[otherEnd-1]) { end--; otherEnd--; }
  return start < end ? [start, end] : null;
}

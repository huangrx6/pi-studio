/** A compact first line, with the complete cleaned reason available on demand. */
export function conversationErrorPresentation(error: string) {
  const message = error.trim() || '操作未完成';
  const lines = message.split(/\r?\n/).filter(line => line.trim());
  const first = lines[0] || '操作未完成';
  const summary = first.length > 180 ? `${first.slice(0, 180)}…` : first;
  return { summary, details: lines.length > 1 || first.length > 180 ? message : null };
}

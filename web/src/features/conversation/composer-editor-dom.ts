/** DOM ↔ raw prompt mapping. Reference labels never replace the underlying token. */
export function readEditorText(node: Node): string {
  if (node.nodeType === 3) return node.textContent || '';
  if (node instanceof Element) {
    if (node.hasAttribute('data-editor-tail')) return '';
    const token = node.getAttribute('data-reference-token');
    if (token !== null) return token;
    if (node.tagName === 'BR') return '\n';
  }
  let text = '';
  for (const child of Array.from(node.childNodes)) {
    // Chromium can introduce block wrappers for native multiline insertion.
    if (child instanceof Element && /^(DIV|P)$/.test(child.tagName) && child.previousSibling && !text.endsWith('\n')) text += '\n';
    text += readEditorText(child);
  }
  return text;
}

export function editorSelection(root: HTMLElement): [number, number] {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
    const end = readEditorText(root).length;
    return [end, end];
  }
  const selected = selection.getRangeAt(0);
  const offset = (node: Node, position: number) => {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, position);
    return readEditorText(range.cloneContents()).length;
  };
  return [offset(selected.startContainer, selected.startOffset), offset(selected.endContainer, selected.endOffset)];
}

export function setEditorSelection(root: HTMLElement, start: number, end = start) {
  const point = (offset: number): [Node, number] => {
    let remaining = Math.max(0, offset);
    const nodes = Array.from(root.childNodes);
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      const length = readEditorText(node).length;
      if (node.nodeType === 3 && remaining <= length) return [node, remaining];
      if (remaining === 0) return [root, index];
      if (remaining < length) return [root, index + 1]; // Tokens are atomic.
      remaining -= length;
    }
    return [root, nodes.length];
  };
  const range = document.createRange();
  range.setStart(...point(start));
  range.setEnd(...point(end));
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

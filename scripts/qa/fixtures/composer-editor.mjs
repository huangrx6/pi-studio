/** Read the editor's transport text rather than its abbreviated visual labels. */
export async function composerValue(locator) {
  return locator.evaluate(root => {
    const read = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.hasAttribute('data-editor-tail')) return '';
        if (node.hasAttribute('data-reference-token')) return node.getAttribute('data-reference-token');
        if (node.tagName === 'BR') return '\n';
      }
      return Array.from(node.childNodes, read).join('');
    };
    return read(root);
  });
}

export async function selectComposerRange(locator, start, end = start) {
  await locator.evaluate((root, [start, end]) => {
    root.focus();
    const point = offset => {
      for (let index = 0; index < root.childNodes.length; index++) {
        const node = root.childNodes[index];
        const length = node.nodeType === Node.TEXT_NODE ? node.textContent.length : (node.getAttribute('data-reference-token') || '').length;
        if (node.nodeType === Node.TEXT_NODE && offset <= length) return [node, offset];
        if (offset === 0) return [root, index];
        if (offset < length) return [root, index + 1];
        offset -= length;
      }
      return [root, root.childNodes.length];
    };
    const range = document.createRange();
    range.setStart(...point(start)); range.setEnd(...point(end));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }, [start, end]);
}

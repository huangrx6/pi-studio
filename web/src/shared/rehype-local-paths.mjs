/**
 * Rehype plugin: turn local paths in rendered markdown into file links.
 *
 * Handles two shapes the model actually produces:
 *   - inline code, e.g. `travel/一周旅游计划.md` — the whole span is a path;
 *   - plain prose tokens such as 见 travel/notes.md — the token alone is a path.
 *
 * Code blocks (`pre`), existing links (`a`) and non-path prose are untouched.
 * The link carries `dataPath` so the renderer can open a preview instead of
 * navigating the window.
 */
import { pathToken } from './file-path-links.mjs';

function linkFor(value, properties = {}) {
  return {
    type: 'element',
    tagName: 'a',
    properties: { dataPath: value, className: ['md-path-link'], ...properties },
    children: [{ type: 'text', value }],
  };
}

function splitText(value) {
  const parts = [];
  for (const chunk of value.split(/(\s+)/)) {
    if (!chunk) continue;
    if (/^\s+$/.test(chunk)) {
      parts.push({ type: 'text', value: chunk });
      continue;
    }
    const path = pathToken(chunk);
    parts.push(path ? linkFor(path) : { type: 'text', value: chunk });
  }
  return parts;
}

function hasElementParent(ancestors, tagName) {
  return ancestors.some((node) => node.type === 'element' && node.tagName === tagName);
}

function transform(node, ancestors) {
  if (!Array.isArray(node.children)) return;
  const next = [];
  for (const child of node.children) {
    if (child.type === 'text') {
      const insideProtected = hasElementParent(ancestors, 'pre')
        || hasElementParent(ancestors, 'code')
        || hasElementParent(ancestors, 'a');
      next.push(...(insideProtected ? [child] : splitText(child.value)));
      continue;
    }
    if (child.type === 'element') {
      const text = child.children?.length === 1 && child.children[0].type === 'text'
        ? child.children[0].value
        : '';
      if (child.tagName === 'code' && text && !hasElementParent(ancestors, 'pre')) {
        const path = pathToken(text);
        if (path) {
          next.push({
            ...linkFor(path),
            children: [child],
          });
          continue;
        }
      }
      transform(child, [...ancestors, child]);
    }
    next.push(child);
  }
  node.children = next;
}

export default function rehypeLocalPaths() {
  return (tree) => {
    tree.children = tree.children || [];
    transform(tree, []);
  };
}

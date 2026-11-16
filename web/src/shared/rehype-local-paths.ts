import { localHrefPath, pathToken, WINDOWS_DRIVE_ROOT } from './file-path-links.ts';
import type { Element, ElementContent, Root, RootContent } from 'hast';

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

function linkFor(value: string): Element {
  return {
    type: 'element',
    tagName: 'a',
    properties: { dataPath: value, className: ['md-path-link'] },
    children: [{ type: 'text', value }],
  };
}

function splitText(value: string) {
  const parts: ElementContent[] = [];
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

function hasElementParent(ancestors: Element[], tagName: string) {
  return ancestors.some((node) => node.type === 'element' && node.tagName === tagName);
}

function transform(node: Root | Element, ancestors: Element[]) {
  if (!Array.isArray(node.children)) return;
  const next: RootContent[] = [];
  for (const child of node.children) {
    if (child.type === 'text') {
      const insideProtected = hasElementParent(ancestors, 'pre')
        || hasElementParent(ancestors, 'code')
        || hasElementParent(ancestors, 'a');
      next.push(...(insideProtected ? [child] : splitText(child.value)));
      continue;
    }
    if (child.type === 'element') {
      if (child.tagName === 'a' && typeof child.properties.href === 'string') {
        // Markdown's URL filter treats a drive letter as a URL scheme.
        const local = localHrefPath(child.properties.href);
        if (local && WINDOWS_DRIVE_ROOT.test(local)) child.properties.dataPath = local;
      }
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
  if (node.type === 'root') node.children = next;
  else node.children = next.filter(child => child.type !== 'doctype');
}

export default function rehypeLocalPaths() {
  return (tree: Root) => {
    tree.children = tree.children || [];
    transform(tree, []);
  };
}

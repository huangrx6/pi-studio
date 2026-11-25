import { request, type LocalAsset } from './bridge';
import type { previewColor } from './appearance';

const DATA_IMAGE = /^data:image\/(?:png|gif|jpeg|webp|avif|svg\+xml)[;,]/i;
const OFFLINE = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";

/** Resolve only local assets and build a scriptless, network-free document. */
export async function htmlPreview(source: string, from: string, library: string, { background, foreground, scheme }: ReturnType<typeof previewColor>) {
  const document = new DOMParser().parseFromString(source, 'text/html');
  document.querySelectorAll('script, iframe, frame, frameset, object, embed, base, meta, form, template')
    .forEach(node => node.remove());
  document.querySelectorAll('[srcset], [poster], [background], [ping], [target], [autofocus]').forEach(node => {
    for (const attribute of ['srcset', 'poster', 'background', 'ping', 'target', 'autofocus']) node.removeAttribute(attribute);
  });
  document.querySelectorAll('a[href], area[href], svg [href], svg [xlink\\:href]').forEach(node => {
    if (!node.getAttribute('href')?.startsWith('#')) node.removeAttribute('href');
    node.removeAttribute('xlink:href');
  });

  let remaining = 12 * 1024 * 1024;
  const assets = new Map<string, Promise<LocalAsset | null>>();
  function local(href: string, base = from) {
    if (!href || /^[a-z][a-z\d+.-]*:|^\//i.test(href)) return Promise.resolve(null);
    const key = base + '\n' + href;
    if (!assets.has(key) && assets.size < 36) {
      assets.set(key, request<LocalAsset>('asset', { from: base, href, library }).then(asset => {
        remaining -= asset.dataUrl?.length ?? asset.css?.length ?? 0;
        return remaining >= 0 ? asset : null;
      }).catch(() => null));
    }
    return assets.get(key) ?? Promise.resolve(null);
  }
  async function css(text: string, base: string) {
    const withoutImports = text.replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/gi, '');
    const urls = [...withoutImports.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi)];
    const replacements = await Promise.all(urls.map(async match => {
      const href = match[1] ?? match[2] ?? match[3];
      if (DATA_IMAGE.test(href)) return match[0];
      const asset = await local(href, base);
      return asset?.dataUrl ? 'url("' + asset.dataUrl + '")' : 'none';
    }));
    let index = 0;
    return withoutImports.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi, () => replacements[index++]);
  }
  await Promise.all([
    ...[...document.querySelectorAll('img[src]')].map(async image => {
      const href = image.getAttribute('src') ?? '';
      if (DATA_IMAGE.test(href)) return;
      image.removeAttribute('src');
      const asset = await local(href);
      if (asset?.dataUrl) image.setAttribute('src', asset.dataUrl);
    }),
    ...[...document.querySelectorAll('link')].map(async link => {
      if (link.rel.toLowerCase() === 'stylesheet') {
        const asset = await local(link.getAttribute('href') ?? '');
        if (asset?.css) {
          const style = document.createElement('style');
          style.textContent = (await css(asset.css, asset.path)).replace(/<\/style/gi, '<\\/style');
          link.replaceWith(style);
          return;
        }
      }
      link.remove();
    }),
    ...[...document.querySelectorAll('style')].map(async style => {
      style.textContent = (await css(style.textContent ?? '', from)).replace(/<\/style/gi, '<\\/style');
    }),
    ...[...document.querySelectorAll('[style]')].map(async element => {
      element.setAttribute('style', await css(element.getAttribute('style') ?? '', from));
    }),
  ]);
  const defaults = document.createElement('style');
  defaults.textContent = 'html{color-scheme:' + scheme + ';background:' + background + ';color:' + foreground
    + '}body{margin:24px;font-family:system-ui,sans-serif;line-height:1.65}img,video{max-width:100%;height:auto}pre{overflow:auto}';
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = OFFLINE;
  const charset = document.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  document.head.prepend(charset, policy, defaults);
  return '<!doctype html>\n' + document.documentElement.outerHTML;
}

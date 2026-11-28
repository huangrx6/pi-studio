import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const renderer = fileURLToPath(new URL('./web/src/', import.meta.url));

export default {
  plugins: [{
    postcssPlugin: 'studio-focus-visible',
    Once(root) {
      // Keep the same specificity for rings on controls, their pseudo-elements,
      // and wrappers using :has(). Hover, selection and editing styles still apply.
      root.walkRules(/:focus-visible/, rule => {
        const file = rule.source?.input.file;
        if (!file || !resolve(file).startsWith(renderer)) return;
        rule.selector = rule.selector.replaceAll(':focus-visible', ':focus-visible:where(:not([data-pointer-dismiss]))');
      });
    },
  }],
};

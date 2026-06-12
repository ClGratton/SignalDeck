export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'grtlabs-theme';
export const DEFAULT_THEME: Theme = 'light';

/** localStorage key for the debug-tunable background canvas blur (e.g. "6px"). */
export const CANVAS_BLUR_STORAGE_KEY = 'grtlabs-canvas-blur';

// Runs before paint to set the theme attribute (avoiding a flash of the wrong
// theme) and to apply any persisted canvas-blur tuning. Kept tiny and
// dependency-free because it is inlined into the document.
export const themeInitScript = `(function(){try{var d=document.documentElement;var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t!=='light'&&t!=='dark'){t='${DEFAULT_THEME}';}d.dataset.theme=t;d.style.colorScheme=t;var b=localStorage.getItem('${CANVAS_BLUR_STORAGE_KEY}');if(b)d.style.setProperty('--canvas-blur',b);}catch(e){document.documentElement.dataset.theme='${DEFAULT_THEME}';}})();`;

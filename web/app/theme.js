// web/app/theme.js: the light or dark choice, before first paint (this page and the join page).
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// Set the theme before first paint so there's no flash. Default: light.
// Storage can throw (a private window, site data blocked): the page still paints.
let theme = 'light'; try { theme = localStorage.getItem('theme') || 'light'; } catch {}
document.documentElement.dataset.theme = theme;

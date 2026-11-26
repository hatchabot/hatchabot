// web/upgraded.js: what a page from before an upgrade gets for a script it
// names by an older release's digest (HB-0894; src/api/machine/pageRoutes.ts,
// registerPageRoutes). The page's scripts are one release's, named by their
// bytes; the server holds only its own, so rather than mix the two it answers
// this, sent no-store, for each script it no longer has. It says so once,
// however many of the page's scripts it stands in for, and reloads only when
// asked: a reload in the middle of something would lose it.
//
// One fixed file, the same for every request (nothing of the request is in
// it), and valid both as a classic script and as a module: no import or
// export, nothing strict mode refuses, and nothing declared outside the
// function, so it can clash with none of the page's own names.
(function () {
  var ID = 'hatchabot-upgraded';
  function show() {
    if (!document.body || document.getElementById(ID)) return;
    var bar = document.createElement('div');
    bar.id = ID;
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px 14px;'
      + 'padding:12px 16px;background:var(--panel,#fff);color:var(--text,#1a1c20);border-bottom:1px solid var(--line,#e2e5ea);'
      + 'box-shadow:0 2px 10px rgba(0,0,0,.18);font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif';
    var words = document.createElement('span');
    words.textContent = 'Hatchabot was just upgraded. Reload to finish.';
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Reload';
    button.style.cssText = 'font:inherit;font-weight:600;padding:7px 16px;border:0;border-radius:8px;cursor:pointer;'
      + 'background:var(--accent,#e8a33d);color:var(--accent-ink,#14161a)';
    button.addEventListener('click', function () { location.reload(); });
    bar.appendChild(words);
    bar.appendChild(button);
    document.body.appendChild(bar);
  }
  // A script in the head runs before there is a body: the banner waits for it.
  if (document.body) show();
  else document.addEventListener('DOMContentLoaded', show);
})();

/** Shows the running server's version next to the app name — pulled live
 * from /api/app-info (backed by package.json, the single source of truth;
 * see server.js) rather than hard-coded here, so it can never drift out of
 * sync with what's actually running. */
(() => {
  const el = document.getElementById("brandVersion");
  if (!el) return;

  fetch("/api/app-info")
    .then((res) => res.json())
    .then((data) => {
      if (!data.version) return;
      el.textContent = `v${data.version}`;
      el.title = `Playlist Exporter v${data.version}`;
    })
    .catch(() => {
      // Non-essential UI chrome — silently leave it blank rather than
      // showing an error banner over a missing version number.
    });
})();

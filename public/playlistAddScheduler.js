(() => {
  const pending = new WeakMap();

  function schedule(select, callback, delayMs = 2000) {
    const previous = pending.get(select);
    if (previous) clearTimeout(previous);
    if (!select.value) {
      pending.delete(select);
      return;
    }

    const selectedPlaylistId = select.value;
    const timer = setTimeout(() => {
      pending.delete(select);
      if (select.value === selectedPlaylistId) callback(selectedPlaylistId);
    }, delayMs);
    pending.set(select, timer);
  }

  const api = { schedule };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.PlaylistExporterPlaylistAdd = api;
})();

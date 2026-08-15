(() => {
  const LARGE_PLAYLIST_TRACK_LIMIT = 400; // don't auto-scan huge playlists (e.g. the full library)
  const PREFETCH_CONCURRENCY = 2; // gentle on Music.app, which may be actively playing/in use
  const CACHE_KEY = "ple.cache.v1";
  const BACKGROUND_SYNC_INTERVAL_MS = 15 * 60 * 1000;

  let playlists = [];               // [{id, name, trackCount}]
  const selectedIds = new Set();
  const trackCache = new Map();     // id -> tracks[] (classified)
  const trackSyncedAt = new Map();  // id -> ms timestamp of that playlist's last successful sync
  const errorCache = new Map();     // id -> error message string
  const restoreState = new Map();   // id -> { running, result: {fixed,needsReview,downloading,unsupported,libraryIndexAvailable}|null, error }
  const fetching = new Set();       // ids currently being fetched (foreground — shows "checking…")
  const backgroundRefreshing = new Set(); // ids currently being silently refreshed — never shown as "checking…"
  let searchQuery = "";
  let sortMode = "name";            // "name" | "newest" | "oldest"
  let destination = null;
  let prefetchDone = 0;
  let prefetchTotal = 0;
  let prefetchRunning = false;
  let playlistsSyncedAt = null;     // ms timestamp of the last successful full playlist-list sync

  const el = (id) => document.getElementById(id);
  const listEl = el("playlistList");
  const statStripEl = el("statStrip");
  const trackBodyEl = el("trackBody");
  const actionTitleEl = el("actionTitle");
  const actionSubEl = el("actionSub");
  const exportBtn = el("exportBtn");
  const selectedCountEl = el("selectedCount");
  const searchInput = el("searchInput");
  const sortSelect = el("sortSelect");
  const prefetchStatusEl = el("prefetchStatus");
  const errorBanner = el("errorBanner");
  const nasStatus = el("nasStatus");
  const nasStatusText = el("nasStatusText");
  const destPathEl = el("destPath");
  const destFreeEl = el("destFree");

  function showError(message, hint) {
    errorBanner.style.display = "flex";
    errorBanner.innerHTML = `⚠ ${message}${hint ? `<br><code>${hint}</code>` : ""}`;
    nasStatus.querySelector(".dot").classList.add("warn");
    nasStatusText.textContent = "not connected";
  }

  /** Persisted so the app has something to show immediately on load without
   * waiting on Music.app — see hydrateFromCache()/refreshPlaylists() below. */
  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveCache() {
    try {
      const tracks = {};
      trackCache.forEach((tracksForId, id) => {
        tracks[id] = { tracks: tracksForId, syncedAt: trackSyncedAt.get(id) || null };
      });
      localStorage.setItem(CACHE_KEY, JSON.stringify({ playlists, playlistsSyncedAt, tracks }));
    } catch {
      // Storage disabled/full — caching is a nice-to-have, never block the app on it.
    }
  }

  /** Loads whatever was cached from a previous run, if any. Returns whether
   * there was anything to show. */
  function hydrateFromCache() {
    const cache = loadCache();
    if (!cache || !Array.isArray(cache.playlists) || cache.playlists.length === 0) return false;
    playlists = cache.playlists;
    playlistsSyncedAt = cache.playlistsSyncedAt || null;
    Object.entries(cache.tracks || {}).forEach(([id, entry]) => {
      trackCache.set(id, entry.tracks);
      trackSyncedAt.set(id, entry.syncedAt || null);
    });
    return true;
  }

  function formatRelativeTime(ms) {
    if (!ms) return null;
    const deltaSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (deltaSec < 10) return "just now";
    if (deltaSec < 60) return `${deltaSec}s ago`;
    const deltaMin = Math.round(deltaSec / 60);
    if (deltaMin < 60) return `${deltaMin}m ago`;
    const deltaHour = Math.round(deltaMin / 60);
    if (deltaHour < 24) return `${deltaHour}h ago`;
    const deltaDay = Math.round(deltaHour / 24);
    return `${deltaDay}d ago`;
  }

  /** Fetches the current playlist list from Music.app and updates the cache.
   * With `silent`, a failure never blanks out already-showing data — the
   * whole point of caching is that stale-but-available beats blank. */
  async function refreshPlaylists({ silent = false } = {}) {
    try {
      const res = await fetch("/api/playlists");
      const data = await res.json();
      if (!res.ok) {
        const message = data.error || "Failed to load playlists";
        throw new Error(data.hint ? `${message}\n${data.hint}` : message);
      }
      playlists = data;
      playlistsSyncedAt = Date.now();
      saveCache();
      nasStatus.querySelector(".dot").classList.remove("warn");
      nasStatusText.textContent =
        `${playlists.length} playlist${playlists.length === 1 ? "" : "s"} found` +
        ` · synced ${formatRelativeTime(playlistsSyncedAt)}`;
      errorBanner.style.display = "none";
      renderSidebar();
      renderMain();
      backgroundPrefetch();
    } catch (err) {
      if (playlists.length === 0) {
        showError("Couldn't read your Music.app playlists.", err.message);
      } else {
        // Already have something on screen (from cache or an earlier sync) —
        // note the failed refresh quietly rather than hiding good data.
        nasStatus.querySelector(".dot").classList.add("warn");
        nasStatusText.textContent =
          `${playlists.length} playlist${playlists.length === 1 ? "" : "s"}` +
          ` · last synced ${formatRelativeTime(playlistsSyncedAt) || "never"} (refresh failed)`;
      }
    }
  }

  /** Re-fetches a playlist's tracks in the background without ever clearing
   * what's already cached — a failed silent refresh just leaves the old,
   * still-valid data and timestamp in place. */
  async function refreshTracksFor(id) {
    if (fetching.has(id) || backgroundRefreshing.has(id)) return;
    backgroundRefreshing.add(id);
    try {
      const data = await fetchTracksOnce(id);
      trackCache.set(id, data);
      trackSyncedAt.set(id, Date.now());
      errorCache.delete(id);
      saveCache();
      renderSidebar();
      renderMain();
    } catch {
      // keep last-known-good data
    } finally {
      backgroundRefreshing.delete(id);
    }
  }

  async function backgroundSync() {
    await refreshPlaylists({ silent: true });
    const candidates = playlists.filter((p) => p.trackCount <= LARGE_PLAYLIST_TRACK_LIMIT);
    let cursor = 0;
    async function worker() {
      while (cursor < candidates.length) {
        const p = candidates[cursor];
        cursor += 1;
        await refreshTracksFor(p.id);
      }
    }
    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
  }

  function scheduleBackgroundSync() {
    setInterval(backgroundSync, BACKGROUND_SYNC_INTERVAL_MS);
    // Keeps "synced Xm ago" labels ticking even when nothing else changes.
    setInterval(() => {
      renderSidebar();
    }, 60_000);
  }

  function counts(tracks) {
    const ready = tracks.filter((t) => t.status === "ready").length;
    const protectedCount = tracks.filter((t) => t.status === "protected").length;
    const missing = tracks.filter((t) => t.status === "missing").length;
    return { total: tracks.length, ready, protectedCount, missing };
  }

  const CLIENT_RETRY_ATTEMPTS = 3;
  const CLIENT_RETRY_DELAYS_MS = [600, 1800]; // between attempts 1→2 and 2→3
  const MAX_AUTO_HEAL_SWEEPS = 6; // ~2 minutes of periodic retries at 20s each
  const autoHealAttempts = new Map(); // id -> sweep count since it first errored

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchTracksOnce(id) {
    let res;
    try {
      res = await fetch(`/api/playlists/${encodeURIComponent(id)}/tracks`);
    } catch {
      // fetch() itself throws (TypeError) when the server can't be reached at
      // all — much more useful to say so than surface "Failed to fetch".
      throw new Error("Couldn't reach the app's local server — is it still running?");
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load tracks");
    return data;
  }

  async function fetchTracksFor(id) {
    if (trackCache.has(id) || fetching.has(id)) return;
    fetching.add(id);
    renderSidebar();

    let lastError = null;
    for (let attempt = 1; attempt <= CLIENT_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const data = await fetchTracksOnce(id);
        trackCache.set(id, data);
        trackSyncedAt.set(id, Date.now());
        errorCache.delete(id);
        autoHealAttempts.delete(id);
        lastError = null;
        saveCache();
        break;
      } catch (err) {
        lastError = err;
        if (attempt < CLIENT_RETRY_ATTEMPTS) await sleep(CLIENT_RETRY_DELAYS_MS[attempt - 1]);
      }
    }

    if (lastError) {
      // Keep the real reason around instead of silently treating this as an
      // empty/exportless playlist — the sidebar and preview both surface it.
      errorCache.set(id, lastError.message);
    }

    fetching.delete(id);
    renderSidebar();
    renderMain();
  }

  function retryFetch(id) {
    errorCache.delete(id);
    trackCache.delete(id);
    autoHealAttempts.delete(id);
    fetchTracksFor(id);
  }

  // ---------- Restore missing tracks ----------
  // The first feature in this app that writes to the user's real Music.app
  // library rather than just reading from it: for a playlist's missing
  // tracks, an exact local-index match is auto-applied (imported into the
  // library, added to the playlist, the broken entry removed) without
  // asking; an ambiguous match is left here for the user to pick or skip;
  // no local match at all gets an automatic Music.app download attempt.

  async function restorePlaylistTracks(id) {
    restoreState.set(id, { running: true, result: null, error: null });
    renderMain();
    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(id)}/restore`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Restore failed");
      restoreState.set(id, { running: false, result: data, error: null });
    } catch (err) {
      restoreState.set(id, { running: false, result: null, error: err.message });
    }
    // The playlist's contents may have changed (tracks added/removed) —
    // force a real refetch rather than trusting the now-stale cached list.
    trackCache.delete(id);
    errorCache.delete(id);
    await fetchTracksFor(id);
    renderMain();
  }

  async function applyRestoreCandidate(playlistId, musicAppId, fileId) {
    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/restore/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId, trackMusicAppId: musicAppId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't apply that match");
    } catch (err) {
      showError("Couldn't apply that match.", err.message);
      return;
    }
    dismissReviewItem(playlistId, musicAppId);
    trackCache.delete(playlistId);
    errorCache.delete(playlistId);
    await fetchTracksFor(playlistId);
    renderMain();
  }

  function dismissReviewItem(playlistId, musicAppId) {
    const state = restoreState.get(playlistId);
    if (state?.result) {
      state.result.needsReview = state.result.needsReview.filter((r) => r.musicAppId !== musicAppId);
    }
  }

  function bindRestoreButtons(container) {
    container.querySelectorAll("[data-restore-playlist]").forEach((btn) => {
      btn.addEventListener("click", () => restorePlaylistTracks(btn.dataset.restorePlaylist));
    });
    container.querySelectorAll(".restore-use-btn[data-restore-use]").forEach((btn) => {
      btn.addEventListener("click", () => {
        applyRestoreCandidate(btn.dataset.playlistId, btn.dataset.trackId || null, parseInt(btn.dataset.fileId, 10));
      });
    });
    container.querySelectorAll(".restore-skip-btn[data-restore-skip]").forEach((btn) => {
      btn.addEventListener("click", () => {
        dismissReviewItem(btn.dataset.playlistId, btn.dataset.trackId || null);
        renderMain();
      });
    });
  }

  function restoreResultHtml(playlistId, state) {
    if (!state) return "";
    if (state.running) {
      return `<tr class="restore-status-row"><td colspan="5" class="restore-status">Restoring missing tracks…</td></tr>`;
    }
    if (state.error) {
      return `<tr class="restore-status-row"><td colspan="5" class="restore-status error">Restore failed: ${escapeAttr(state.error)}</td></tr>`;
    }
    const r = state.result;
    if (!r) return "";

    const parts = [];
    if (r.fixed.length) parts.push(`${r.fixed.length} fixed`);
    if (r.downloading.length) parts.push(`${r.downloading.length} downloading via Apple Music`);
    if (r.unsupported.length) parts.push(`${r.unsupported.length} couldn't be downloaded`);
    if (r.needsReview.length) parts.push(`${r.needsReview.length} need your input`);
    const summary = parts.length ? parts.join(" · ") : "No missing tracks matched locally or needed a download.";

    const reviewHtml = r.needsReview
      .map((item) => {
        const candidateButtons = item.candidates
          .map(
            (c) =>
              `<button type="button" class="link-btn restore-use-btn" data-restore-use data-playlist-id="${playlistId}" data-track-id="${escapeAttr(item.musicAppId || "")}" data-file-id="${c.id}">Use "${escapeAttr(c.title || "")}"${c.artist ? ` — ${escapeAttr(c.artist)}` : ""}</button>`
          )
          .join(" ");
        return `
        <div class="restore-review-item">
          <span class="restore-review-title">${item.title || "(untitled)"}<span class="restore-review-artist">${item.artist || ""}</span></span>
          <span class="restore-review-candidates">
            ${candidateButtons}
            <button type="button" class="link-btn restore-skip-btn" data-restore-skip data-playlist-id="${playlistId}" data-track-id="${escapeAttr(item.musicAppId || "")}">Skip</button>
          </span>
        </div>`;
      })
      .join("");

    const unsupportedHtml = r.unsupported
      .map((item) => `<div class="restore-unsupported-item">${item.title || "(untitled)"} — ${escapeAttr(item.reason || "couldn't download")}</div>`)
      .join("");

    return `<tr class="restore-status-row"><td colspan="5">
      <div class="restore-summary">${summary}</div>
      ${reviewHtml ? `<div class="restore-review-list">${reviewHtml}</div>` : ""}
      ${unsupportedHtml ? `<div class="restore-unsupported-list">${unsupportedHtml}</div>` : ""}
    </td></tr>`;
  }

  /** Every 20s, quietly retries anything still in errorCache — playlists that
   * failed because Music.app was momentarily busy heal on their own instead
   * of requiring a manual click. Gives up after MAX_AUTO_HEAL_SWEEPS. */
  function scheduleAutoHeal() {
    setInterval(() => {
      errorCache.forEach((_message, id) => {
        const attempts = autoHealAttempts.get(id) || 0;
        if (attempts >= MAX_AUTO_HEAL_SWEEPS || fetching.has(id)) return;
        autoHealAttempts.set(id, attempts + 1);
        fetchTracksFor(id);
      });
    }, 20_000);
  }

  /**
   * Walks every playlist in the background (a few at a time) so the sidebar
   * can group "ready to export" vs "nothing to export" without the user
   * having to click through each one first. Very large playlists (the full
   * library, etc.) are skipped — they're scanned on demand if selected.
   */
  async function backgroundPrefetch() {
    const candidates = playlists.filter(
      (p) => p.trackCount <= LARGE_PLAYLIST_TRACK_LIMIT && !trackCache.has(p.id) && !errorCache.has(p.id)
    );
    if (candidates.length === 0) return;

    prefetchRunning = true;
    prefetchTotal = candidates.length;
    prefetchDone = 0;
    renderSidebar();

    let cursor = 0;
    async function worker() {
      while (cursor < candidates.length) {
        const p = candidates[cursor];
        cursor += 1;
        if (!trackCache.has(p.id) && !fetching.has(p.id)) {
          await fetchTracksFor(p.id);
        }
        prefetchDone += 1;
        renderPrefetchStatus();
      }
    }

    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
    prefetchRunning = false;
    renderPrefetchStatus();
  }

  function renderPrefetchStatus() {
    if (!prefetchRunning) {
      prefetchStatusEl.style.display = "none";
      return;
    }
    prefetchStatusEl.style.display = "block";
    prefetchStatusEl.textContent = `Checking playlists… ${prefetchDone} of ${prefetchTotal}`;
  }

  function sortPlaylists(list) {
    const sorted = [...list];
    if (sortMode === "newest") {
      // Music.app doesn't expose a playlist creation date via scripting;
      // the internal numeric id reliably increases with creation order.
      sorted.sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10));
    } else if (sortMode === "oldest") {
      sorted.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted;
  }

  function escapeAttr(str) {
    return String(str).replace(/"/g, "&quot;");
  }

  /** A play button next to a title, wired up to the shared mini-player
   * (public/audioPlayer.js) — disabled with no url when there's nothing
   * playable (protected/missing tracks). */
  function playButtonHtml(url, label) {
    if (!url) return `<button type="button" class="play-btn" disabled title="Not available to preview">▶</button>`;
    return `<button type="button" class="play-btn" data-play-url="${escapeAttr(url)}" data-play-label="${escapeAttr(label)}" title="Play">▶</button>`;
  }

  function bindPlayButtons(container) {
    container.querySelectorAll(".play-btn[data-play-url]").forEach((btn) => {
      btn.addEventListener("click", () => {
        window.PlaylistExporterAudio.toggle(btn.dataset.playUrl, btn.dataset.playLabel);
      });
    });
    window.PlaylistExporterAudio.sync();
  }

  /** "Show in Finder" next to the play button — available whenever a track
   * has a location on disk at all, even one the play button can't preview
   * (e.g. protected tracks still have a real file worth revealing). */
  function revealButtonHtml(location) {
    if (!location) return `<button type="button" class="reveal-btn" disabled title="Not available">📂</button>`;
    return `<button type="button" class="reveal-btn" data-reveal-path="${escapeAttr(location)}" title="Show in Finder">📂</button>`;
  }

  function bindRevealButtons(container) {
    container.querySelectorAll(".reveal-btn[data-reveal-path]").forEach((btn) => {
      btn.addEventListener("click", () => {
        fetch("/api/reveal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: btn.dataset.revealPath }),
        }).catch(() => {});
      });
    });
  }

  function buildPlaylistItem(p) {
    const checked = selectedIds.has(p.id);
    const item = document.createElement("label");
    item.className = "playlist-item" + (checked ? " checked" : "");

    let metaExtra = "";
    if (fetching.has(p.id)) {
      metaExtra = ` · <span class="meta-flag loading">checking…</span>`;
    } else if (errorCache.has(p.id)) {
      const reason = escapeAttr(errorCache.get(p.id));
      metaExtra = ` · <span class="meta-flag error" title="${reason}">couldn't load ⓘ</span> · <button type="button" class="retry-link" data-retry="${p.id}">Retry</button>`;
    } else if (trackCache.has(p.id)) {
      const c = counts(trackCache.get(p.id));
      const flags = [];
      if (c.protectedCount) flags.push(`<span class="meta-flag danger">${c.protectedCount} protected</span>`);
      if (c.missing) flags.push(`<span class="meta-flag">${c.missing} missing</span>`);
      metaExtra = flags.length ? " · " + flags.join(" · ") : "";
    }

    const syncedAt = trackSyncedAt.get(p.id);
    if (!fetching.has(p.id) && syncedAt) {
      metaExtra += ` · <span class="meta-flag sync-time" title="${escapeAttr(new Date(syncedAt).toLocaleString())}">synced ${formatRelativeTime(syncedAt)}</span>`;
    }

    item.innerHTML = `
      <input type="checkbox" class="playlist-checkbox" ${checked ? "checked" : ""} />
      <span class="playlist-text">
        <span class="playlist-name">${p.name}</span>
        <span class="playlist-meta">${p.trackCount} tracks${metaExtra}</span>
      </span>
    `;
    item.querySelector(".playlist-checkbox").addEventListener("change", (e) => {
      if (e.target.checked) {
        selectedIds.add(p.id);
        fetchTracksFor(p.id);
      } else {
        selectedIds.delete(p.id);
      }
      renderSidebar();
      renderMain();
    });
    const retryBtn = item.querySelector("[data-retry]");
    if (retryBtn) {
      retryBtn.addEventListener("click", (e) => {
        e.preventDefault();
        retryFetch(p.id);
      });
    }
    return item;
  }

  function renderSidebar() {
    const query = searchQuery.trim().toLowerCase();
    const visible = playlists.filter((p) => p.name.toLowerCase().includes(query));

    listEl.innerHTML = "";

    if (playlists.length === 0) {
      listEl.innerHTML = `<div class="empty-sidebar">No playlists found.</div>`;
      selectedCountEl.textContent = "0 selected";
      renderPrefetchStatus();
      return;
    }

    const exportable = [];
    const blocked = [];
    const unchecked = [];
    visible.forEach((p) => {
      if (trackCache.has(p.id)) {
        (counts(trackCache.get(p.id)).ready > 0 ? exportable : blocked).push(p);
      } else {
        unchecked.push(p);
      }
    });

    const addSection = (label, className, list) => {
      if (list.length === 0) return;
      const heading = document.createElement("div");
      heading.className = `section-heading ${className}`;
      heading.innerHTML = `${label} <span class="section-count">— ${list.length}</span>`;
      listEl.appendChild(heading);
      sortPlaylists(list).forEach((p) => listEl.appendChild(buildPlaylistItem(p)));
    };

    addSection("Ready to export", "exportable", exportable);
    addSection("Nothing to export", "blocked", blocked);
    addSection("Not checked yet", "", unchecked);

    if (visible.length === 0) {
      listEl.innerHTML = `<div class="empty-sidebar">No playlists match "${searchQuery}".</div>`;
    }

    selectedCountEl.textContent = `${selectedIds.size} selected`;
    renderPrefetchStatus();
  }

  function statusPill(t) {
    if (t.status === "ready") return `<span class="pill pill-ready"><span class="pill-dot"></span>Ready</span>`;
    if (t.status === "protected") return `<span class="pill pill-protected"><span class="pill-dot"></span>Protected</span>`;
    return `<span class="pill pill-missing"><span class="pill-dot"></span>Missing</span>`;
  }

  function renderMain() {
    const selected = playlists.filter((p) => selectedIds.has(p.id));

    if (selected.length === 0) {
      statStripEl.innerHTML = "";
      trackBodyEl.innerHTML = `<tr><td colspan="5" class="empty-state">Select one or more playlists on the left to preview what will be exported.</td></tr>`;
      actionTitleEl.textContent = "Export Playlists";
      actionSubEl.textContent = "No playlists selected";
      exportBtn.disabled = true;
      return;
    }

    const loaded = selected.filter((p) => trackCache.has(p.id));
    const errored = selected.filter((p) => errorCache.has(p.id));
    const totals = loaded.reduce(
      (acc, p) => {
        const c = counts(trackCache.get(p.id));
        acc.total += c.total;
        acc.ready += c.ready;
        acc.protectedCount += c.protectedCount;
        acc.missing += c.missing;
        return acc;
      },
      { total: 0, ready: 0, protectedCount: 0, missing: 0 }
    );

    statStripEl.innerHTML = `
      <div class="stat-tile"><span class="stat-value">${totals.total}</span><span class="stat-caption">Total tracks</span></div>
      <div class="stat-tile ready"><span class="stat-value">${totals.ready}</span><span class="stat-caption">Ready to export</span></div>
      <div class="stat-tile protected"><span class="stat-value">${totals.protectedCount}</span><span class="stat-caption">Protected (blocked)</span></div>
      <div class="stat-tile missing"><span class="stat-value">${totals.missing}</span><span class="stat-caption">Missing on NAS</span></div>
    `;

    trackBodyEl.innerHTML = selected
      .map((p) => {
        if (errorCache.has(p.id)) {
          return `<tr class="group-row"><td colspan="5">${p.name} <span class="group-count">— couldn't load</span></td></tr>
            <tr><td colspan="5" class="empty-state error-state">${errorCache.get(p.id)}
              <button type="button" class="retry-link" data-retry-main="${p.id}">Retry</button>
            </td></tr>`;
        }
        if (!trackCache.has(p.id)) {
          return `<tr class="group-row"><td colspan="5">${p.name} <span class="group-count">— checking…</span></td></tr>`;
        }
        const tracks = trackCache.get(p.id);
        const pc = counts(tracks);
        const rows = tracks
          .map(
            (t) => `
          <tr class="${t.status !== "ready" ? "status-" + t.status : ""}">
            <td class="col-pos">${String(t.position).padStart(2, "0")}</td>
            <td>
              <div class="title-cell">
                ${playButtonHtml(t.status === "ready" ? `/api/audio?path=${encodeURIComponent(t.location)}` : null, t.title || t.artist || "Track")}
                ${revealButtonHtml(t.location)}
                <span>
                  <div class="track-title">${t.title || "(untitled)"}</div>
                  <div class="track-sub">${t.artist || ""}${t.reason ? ` · <span class="reason">${t.reason}</span>` : ""}</div>
                </span>
              </div>
            </td>
            <td>${t.album || ""}</td>
            <td class="col-format">${t.extension ? "." + t.extension : "—"}</td>
            <td>${statusPill(t)}</td>
          </tr>`
          )
          .join("");
        const restoreBtnState = restoreState.get(p.id);
        const restoreBtnHtml =
          pc.missing > 0
            ? `<button type="button" class="restore-btn" data-restore-playlist="${p.id}" ${restoreBtnState?.running ? "disabled" : ""}>${
                restoreBtnState?.running ? "Restoring…" : `Restore missing tracks (${pc.missing})`
              }</button>`
            : "";
        return `<tr class="group-row"><td colspan="5">${p.name} <span class="group-count">— ${pc.ready} of ${pc.total} exportable</span>${restoreBtnHtml}</td></tr>${rows}${restoreResultHtml(p.id, restoreBtnState)}`;
      })
      .join("");

    trackBodyEl.querySelectorAll("[data-retry-main]").forEach((btn) => {
      btn.addEventListener("click", () => retryFetch(btn.dataset.retryMain));
    });
    bindPlayButtons(trackBodyEl);
    bindRevealButtons(trackBodyEl);
    bindRestoreButtons(trackBodyEl);

    const settled = selected.length - loaded.length - errored.length === 0;
    const stillLoading = !settled;
    actionTitleEl.textContent =
      selected.length === 1
        ? `Export ${totals.ready} of ${totals.total} tracks`
        : `Export ${selected.length} playlists · ${totals.ready} of ${totals.total} tracks`;

    const skipped = totals.protectedCount + totals.missing;
    if (stillLoading) {
      actionSubEl.textContent = "Loading track details…";
    } else if (errored.length) {
      actionSubEl.textContent = `${errored.length} playlist${errored.length === 1 ? "" : "s"} couldn't be checked — see the error above`;
    } else if (!destination) {
      actionSubEl.textContent = "Choose a destination to continue";
    } else if (skipped) {
      actionSubEl.textContent = `${skipped} track${skipped === 1 ? "" : "s"} will be skipped — protected or not found on the NAS`;
    } else {
      actionSubEl.textContent = "All tracks in the selected playlists can be exported";
    }

    exportBtn.disabled = stillLoading || totals.ready === 0 || !destination;

    const title = selected.length === 1 ? `Exporting "${selected[0].name}"…` : `Exporting ${selected.length} playlists…`;
    el("progressTitle").textContent = title;
  }

  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderSidebar();
  });

  sortSelect.addEventListener("change", (e) => {
    sortMode = e.target.value;
    renderSidebar();
  });

  el("selectAllBtn").addEventListener("click", () => {
    playlists.forEach((p) => {
      selectedIds.add(p.id);
      fetchTracksFor(p.id);
    });
    renderSidebar();
    renderMain();
  });

  el("clearSelectionBtn").addEventListener("click", () => {
    selectedIds.clear();
    renderSidebar();
    renderMain();
  });

  // ---------- Destination: native macOS folder picker ----------
  // No custom in-app browser — this opens the real Finder "choose folder"
  // dialog, so the destination is always clicked, never typed.
  const changeDestBtn = el("changeDestBtn");

  changeDestBtn.addEventListener("click", async () => {
    changeDestBtn.disabled = true;
    changeDestBtn.textContent = "Waiting for Finder…";
    try {
      const res = await fetch("/api/choose-folder", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't open the folder picker");
      if (data.path) {
        destination = data.path;
        destPathEl.textContent = destination;
        destPathEl.classList.remove("placeholder");
        destFreeEl.textContent = data.free || "";
        renderMain();
      }
      // data.path === null means the user clicked Cancel — leave things as they were.
    } catch (err) {
      showError("Couldn't open the folder picker.", err.message);
    } finally {
      changeDestBtn.disabled = false;
      changeDestBtn.textContent = "Choose Folder…";
    }
  });

  // ---------- Export + progress ----------
  const progressOverlay = el("progressOverlay");
  const progressFill = el("progressFill");
  const progressStatus = el("progressStatus");
  const progressPct = el("progressPct");
  const progressEta = el("progressEta");
  const progressLog = el("progressLog");
  const progressSummary = el("progressSummary");

  function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "ETA —";
    if (seconds < 60) return `ETA ~${Math.round(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `ETA ~${m}m ${s}s`;
  }

  let currentSource = null;

  exportBtn.addEventListener("click", async () => {
    const selected = playlists.filter((p) => selectedIds.has(p.id));
    if (selected.length === 0 || !destination) return;

    progressLog.innerHTML = "";
    progressFill.style.width = "0%";
    progressPct.textContent = "0%";
    progressStatus.textContent = "Starting…";
    progressEta.textContent = "ETA —";
    progressSummary.style.display = "none";
    progressOverlay.classList.add("open");

    let startTime = Date.now();

    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playlistIds: selected.map((p) => p.id), destination }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Export failed to start");

      if (currentSource) currentSource.close();
      currentSource = new EventSource(`/api/export/${data.jobId}/stream`);
      startTime = Date.now();

      currentSource.onmessage = (event) => {
        const payload = JSON.parse(event.data);

        if (payload.type === "start") {
          progressStatus.textContent = `Copying file 0 of ${payload.total} `;
          progressStatus.appendChild(progressPct);
          return;
        }

        if (payload.type === "file") {
          const pct = Math.round((payload.index / payload.total) * 100);
          progressFill.style.width = `${pct}%`;
          progressPct.textContent = `${pct}%`;
          progressStatus.textContent = `Copying file ${payload.index} of ${payload.total} `;
          progressStatus.appendChild(progressPct);

          const elapsedSec = (Date.now() - startTime) / 1000;
          const avgPerFile = elapsedSec / payload.index;
          progressEta.textContent = formatEta(avgPerFile * (payload.total - payload.index));

          const row = document.createElement("div");
          row.className = "log-row" + (payload.ok ? "" : " log-error");
          const icon = payload.ok ? `<span class="log-check">✓</span>` : `<span class="log-cross">✕</span>`;
          const prefix = selected.length > 1 ? `<span class="log-playlist">${payload.playlist} /</span> ` : "";
          row.innerHTML = `${icon} ${prefix}${payload.fileName}${payload.error ? ` — ${payload.error}` : ""}`;
          progressLog.appendChild(row);
          progressLog.scrollTop = progressLog.scrollHeight;
          return;
        }

        if (payload.type === "done") {
          progressEta.textContent = "Done";
          progressSummary.style.display = "block";
          progressSummary.innerHTML = payload.failed
            ? `<strong>${payload.copied}</strong> of <strong>${payload.total}</strong> files copied — <strong>${payload.failed}</strong> failed`
            : `<strong>${payload.copied}</strong> of <strong>${payload.total}</strong> files copied successfully`;
          currentSource.close();
          currentSource = null;
        }
      };

      currentSource.onerror = () => {
        if (currentSource) {
          currentSource.close();
          currentSource = null;
        }
      };
    } catch (err) {
      progressStatus.textContent = `Export failed: ${err.message}`;
    }
  });

  el("closeProgressBtn").addEventListener("click", () => {
    progressOverlay.classList.remove("open");
    if (currentSource) {
      currentSource.close();
      currentSource = null;
    }
  });

  function init() {
    const hadCache = hydrateFromCache();
    if (hadCache) {
      nasStatusText.textContent =
        `${playlists.length} playlist${playlists.length === 1 ? "" : "s"} found` +
        ` · synced ${formatRelativeTime(playlistsSyncedAt) || "a while ago"} (cached)`;
      renderSidebar();
      renderMain();
    }
    refreshPlaylists({ silent: hadCache });
    scheduleAutoHeal();
    scheduleBackgroundSync();
  }

  init();
})();

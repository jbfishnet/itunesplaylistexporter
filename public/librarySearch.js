(() => {
  const el = (id) => document.getElementById(id);

  const tabButtons = document.querySelectorAll(".tab-btn");
  const statStripEl = el("libraryStatStrip");
  const metaEl = el("libraryMeta");
  const rescanBtn = el("rescanNowBtn");
  const searchInput = el("librarySearchInput");
  const resultsBody = el("libraryResultsBody");
  const foldersListEl = el("foldersList");
  const folderAddBtn = el("folderAddBtn");

  let statusPollTimer = null;
  let statusPollInFlight = false;
  let searchDebounceTimer = null;
  let lastQuery = "";

  function formatRelativeTime(isoString) {
    if (!isoString) return "never";
    const diffMs = Date.now() - new Date(isoString).getTime();
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin === 1) return "1 minute ago";
    if (diffMin < 60) return `${diffMin} minutes ago`;
    const diffHr = Math.round(diffMin / 60);
    return diffHr === 1 ? "1 hour ago" : `${diffHr} hours ago`;
  }

  function formatFutureTime(isoString) {
    if (!isoString) return "—";
    const diffMs = new Date(isoString).getTime() - Date.now();
    if (diffMs <= 0) return "any moment now";
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) return "under a minute";
    if (diffMin < 60) return `in ${diffMin} min`;
    const diffHr = Math.round(diffMin / 60);
    return diffHr === 1 ? "in 1 hour" : `in ${diffHr} hours`;
  }

  async function loadStatus() {
    if (statusPollInFlight) return;
    statusPollInFlight = true;
    try {
      const res = await fetch("/api/library/status");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load library status");
      renderStatus(data);
    } catch {
      metaEl.textContent = "Couldn't load library status.";
    } finally {
      statusPollInFlight = false;
    }
  }

  function renderStatus(data) {
    const enriched = data.enrichmentCounts?.enriched || 0;

    statStripEl.innerHTML = `
      <div class="stat-tile"><span class="stat-value">${data.totalFiles}</span><span class="stat-caption">Files indexed</span></div>
      <div class="stat-tile ready"><span class="stat-value">${enriched}</span><span class="stat-caption">Enriched</span></div>
      <div class="stat-tile missing"><span class="stat-value">${data.enrichmentBacklogSize}</span><span class="stat-caption">Enrichment backlog</span></div>
      <div class="stat-tile"><span class="stat-value">${data.scanRunning ? "●" : "—"}</span><span class="stat-caption">${data.scanRunning ? "Scanning…" : "Idle"}</span></div>
    `;

    if (data.scanRunning) {
      let progress = "starting…";
      if (data.scanPhase === "walking") {
        progress = `found ${data.filesFound} audio files so far (${data.dirsScanned} folders scanned)`;
      } else if (data.filesTotal > 0) {
        progress = `tagging ${data.filesProcessed} / ${data.filesTotal} files`;
      }
      metaEl.textContent = `Scan in progress — ${progress}`;
    } else if (data.lastScanResult === "root_missing") {
      metaEl.textContent = "Last scan couldn't find the NAS folder — is the share mounted? Existing index is untouched.";
    } else if (data.lastScanResult === "error") {
      metaEl.textContent = `Last scan finished with some errors ${formatRelativeTime(data.lastScanAt)} — next scan ${formatFutureTime(data.nextScanAt)}.`;
    } else {
      metaEl.textContent = `Last scan ${formatRelativeTime(data.lastScanAt)} · next scan ${formatFutureTime(data.nextScanAt)}.`;
    }

    rescanBtn.disabled = data.scanRunning;
    rescanBtn.textContent = data.scanRunning ? "Scanning…" : "Rescan now";
  }

  async function loadFolders() {
    try {
      const res = await fetch("/api/library/roots");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load library folders");
      renderFolders(data.roots);
    } catch {
      foldersListEl.innerHTML = `<div class="folder-empty">Couldn't load the folder list.</div>`;
    }
  }

  function renderFolders(roots) {
    if (roots.length === 0) {
      foldersListEl.innerHTML = `<div class="folder-empty">No folders configured yet — add one below.</div>`;
      return;
    }
    foldersListEl.innerHTML = roots
      .map(
        (r) => `
      <div class="folder-row${r.mounted ? "" : " missing"}">
        <span class="dot" style="background:${r.color};box-shadow:0 0 0 3px ${r.color}33" title="This folder's color, shown on its duplicate files too"></span>
        <span class="folder-path">${r.path}</span>
        ${r.mounted ? "" : `<span class="pill pill-not-found"><span class="pill-dot"></span>not mounted</span>`}
        <button type="button" class="link-btn" style="color:var(--danger)" data-remove-root="${escapeAttr(r.path)}">Remove</button>
      </div>`
      )
      .join("");

    foldersListEl.querySelectorAll("[data-remove-root]").forEach((btn) => {
      btn.addEventListener("click", () => removeFolder(btn.dataset.removeRoot));
    });
  }

  async function addFolder() {
    folderAddBtn.disabled = true;
    folderAddBtn.textContent = "Waiting for Finder…";
    try {
      const pickRes = await fetch("/api/choose-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Choose a folder to add to your music library" }),
      });
      const pickData = await pickRes.json();
      if (!pickRes.ok) throw new Error(pickData.error || "Couldn't open the folder picker");
      if (!pickData.path) return; // user clicked Cancel

      const res = await fetch("/api/library/roots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pickData.path }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't add that folder");
      renderFolders(data.roots);
      loadStatus();
    } catch (err) {
      metaEl.textContent = err.message;
    } finally {
      folderAddBtn.disabled = false;
      folderAddBtn.textContent = "Add Folder…";
    }
  }

  async function removeFolder(rootPath) {
    if (!confirm(`Remove "${rootPath}" from the library? Its files will drop out of the index (nothing is deleted from disk).`)) return;
    try {
      const res = await fetch("/api/library/roots", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: rootPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't remove that folder");
      renderFolders(data.roots);
      loadStatus();
    } catch (err) {
      metaEl.textContent = err.message;
    }
  }

  folderAddBtn.addEventListener("click", addFolder);

  rescanBtn.addEventListener("click", async () => {
    rescanBtn.disabled = true;
    try {
      await fetch("/api/library/rescan", { method: "POST" });
    } catch {
      // loadStatus() on the next poll will reflect whatever actually happened
    }
    loadStatus();
  });

  function escapeAttr(str) {
    return String(str).replace(/"/g, "&quot;");
  }

  function playButtonHtml(result) {
    if (result.protected) return `<button type="button" class="play-btn" disabled title="DRM-protected — can't preview">▶</button>`;
    const url = `/api/library/audio/${result.id}`;
    const label = result.title || result.artist || "Track";
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

  function revealButtonHtml(result) {
    return `<button type="button" class="reveal-btn" data-reveal-id="${result.id}" title="Show in Finder">📂</button>`;
  }

  function bindRevealButtons(container) {
    container.querySelectorAll(".reveal-btn[data-reveal-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        fetch(`/api/library/reveal/${btn.dataset.revealId}`, { method: "POST" }).catch(() => {});
      });
    });
  }

  function statusBadges(result) {
    const badges = [];
    if (result.protected) badges.push(`<span class="pill pill-protected"><span class="pill-dot"></span>Protected</span>`);
    if (result.enrichmentStatus === "enriched") badges.push(`<span class="pill pill-enriched"><span class="pill-dot"></span>Enriched</span>`);
    else if (result.enrichmentStatus === "not_found") badges.push(`<span class="pill pill-not-found"><span class="pill-dot"></span>Not found online</span>`);
    else if (result.enrichmentStatus === "skipped_had_tags") badges.push(`<span class="pill pill-local-only"><span class="pill-dot"></span>Local tags</span>`);
    else badges.push(`<span class="pill pill-local-only"><span class="pill-dot"></span>Not checked yet</span>`);
    return badges.join(" ");
  }

  async function runSearch(query) {
    lastQuery = query;
    if (!query.trim()) {
      resultsBody.innerHTML = `<tr><td colspan="6" class="empty-state">Type to search your indexed music library.</td></tr>`;
      return;
    }
    try {
      const res = await fetch(`/api/library/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (query !== lastQuery) return; // a newer keystroke's request already landed
      if (!res.ok) throw new Error(data.error || "Search failed");

      if (data.results.length === 0) {
        resultsBody.innerHTML = `<tr><td colspan="6" class="empty-state">No matches for "${query}".</td></tr>`;
        return;
      }

      resultsBody.innerHTML = data.results
        .map(
          (r) => `
        <tr>
          <td><div class="title-cell">${playButtonHtml(r)}${revealButtonHtml(r)}<span><div class="track-title">${r.title || "(untitled)"}</div><div class="track-sub">${r.path}</div></span></div></td>
          <td>${r.artist || ""}</td>
          <td>${r.album || ""}</td>
          <td>${r.genre || ""}</td>
          <td class="col-format">${r.extension ? "." + r.extension : "—"}</td>
          <td>${statusBadges(r)}</td>
        </tr>`
        )
        .join("");
      bindPlayButtons(resultsBody);
      bindRevealButtons(resultsBody);
    } catch {
      resultsBody.innerHTML = `<tr><td colspan="6" class="empty-state error-state">Search failed — try again.</td></tr>`;
    }
  }

  searchInput.addEventListener("input", (e) => {
    const query = e.target.value;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => runSearch(query), 300);
  });

  function activateTab(tabName) {
    tabButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tabName));
    document.querySelectorAll(".tab-view").forEach((view) => {
      view.classList.toggle("active", view.id === `${tabName}View`);
    });

    if (tabName === "search") {
      loadStatus();
      loadFolders();
      if (!statusPollTimer) statusPollTimer = setInterval(loadStatus, 4000);
    } else if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }

    // Other tab scripts (e.g. libraryBrowse.js) hook into their own tab
    // without this file needing to know they exist.
    document.dispatchEvent(new CustomEvent("ple:tab-activated", { detail: { tabName } }));
  }

  tabButtons.forEach((btn) => btn.addEventListener("click", () => activateTab(btn.dataset.tab)));
})();

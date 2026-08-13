/** The "Queue" tab — a live view of exactly the files the background
 * enrichment queue (src/enrichmentQueue.js) hasn't gotten to yet, in the
 * same order it'll process them (ascending id — see BROWSE_SORT_COLUMNS in
 * src/libraryDb.js), so the list visibly drains as items get enriched. */
(() => {
  const el = (id) => document.getElementById(id);

  const statStripEl = el("queueStatStrip");
  const metaEl = el("queueMeta");
  const resultsBody = el("queueResultsBody");

  const QUEUE_PREVIEW_SIZE = 100;
  let pollTimer = null;

  function escapeAttr(str) {
    return String(str).replace(/"/g, "&quot;");
  }

  function playButtonHtml(row) {
    if (row.protected) return `<button type="button" class="play-btn" disabled title="DRM-protected — can't preview">▶</button>`;
    const url = `/api/library/audio/${row.id}`;
    const label = row.title || row.artist || "Track";
    return `<button type="button" class="play-btn" data-play-url="${escapeAttr(url)}" data-play-label="${escapeAttr(label)}" title="Play">▶</button>`;
  }

  function revealButtonHtml(row) {
    return `<button type="button" class="reveal-btn" data-reveal-id="${row.id}" title="Show in Finder">📂</button>`;
  }

  function bindRevealButtons(container) {
    container.querySelectorAll(".reveal-btn[data-reveal-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        fetch(`/api/library/reveal/${btn.dataset.revealId}`, { method: "POST" }).catch(() => {});
      });
    });
  }

  function bindPlayButtons(container) {
    container.querySelectorAll(".play-btn[data-play-url]").forEach((btn) => {
      btn.addEventListener("click", () => {
        window.PlaylistExporterAudio.toggle(btn.dataset.playUrl, btn.dataset.playLabel);
      });
    });
    window.PlaylistExporterAudio.sync();
  }

  function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "any moment now";
    if (seconds < 60) return `~${Math.round(seconds)}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `~${minutes} min`;
    const hours = (minutes / 60).toFixed(1);
    return `~${hours} hr`;
  }

  async function loadQueue() {
    try {
      const [statusRes, browseRes] = await Promise.all([
        fetch("/api/library/status"),
        fetch(`/api/library/browse?status=pending&sort=id&dir=asc&limit=${QUEUE_PREVIEW_SIZE}`),
      ]);
      const status = await statusRes.json();
      const browse = await browseRes.json();
      if (!statusRes.ok) throw new Error(status.error || "Failed to load queue status");
      if (!browseRes.ok) throw new Error(browse.error || "Failed to load queue contents");

      renderStats(status);
      renderRows(browse.rows, browse.total);
    } catch (err) {
      metaEl.textContent = `Couldn't load the queue — ${err.message}`;
    }
  }

  function renderStats(status) {
    const backlog = status.enrichmentBacklogSize || 0;
    const etaSeconds = backlog * ((status.enrichmentIntervalMs || 1750) / 1000);

    statStripEl.innerHTML = `
      <div class="stat-tile missing"><span class="stat-value">${backlog}</span><span class="stat-caption">Waiting to be checked</span></div>
      <div class="stat-tile ready"><span class="stat-value">${status.enrichmentEnriched || 0}</span><span class="stat-caption">Enriched this session</span></div>
      <div class="stat-tile"><span class="stat-value">${status.enrichmentNotFound || 0}</span><span class="stat-caption">Not found this session</span></div>
      <div class="stat-tile"><span class="stat-value">${formatEta(etaSeconds)}</span><span class="stat-caption">Est. time to clear current backlog</span></div>
    `;

    if (backlog === 0) {
      metaEl.textContent = "Nothing waiting — every file has been checked.";
    } else {
      metaEl.textContent =
        `Checking one file roughly every ${Math.round((status.enrichmentIntervalMs || 1750) / 100) / 10}s` +
        (status.enrichmentLastError ? ` · last attempt hit an error: ${status.enrichmentLastError}` : "");
    }
  }

  function renderRows(rows, total) {
    if (rows.length === 0) {
      resultsBody.innerHTML = `<tr><td colspan="5" class="empty-state">Nothing waiting — every file has been checked.</td></tr>`;
      return;
    }

    resultsBody.innerHTML = rows
      .map(
        (r, i) => `
      <tr>
        <td class="col-pos">${i + 1}</td>
        <td><div class="title-cell">${playButtonHtml(r)}${revealButtonHtml(r)}<span><div class="track-title">${r.title || "(untitled)"}</div><div class="track-sub">${r.path}</div></span></div></td>
        <td>${r.artist || ""}</td>
        <td>${r.album || ""}</td>
        <td class="col-format">${r.extension ? "." + r.extension : "—"}</td>
      </tr>`
      )
      .join("");

    if (total > rows.length) {
      const moreRow = document.createElement("tr");
      moreRow.innerHTML = `<td colspan="5" class="empty-state">…and ${total - rows.length} more waiting behind these.</td>`;
      resultsBody.appendChild(moreRow);
    }

    bindPlayButtons(resultsBody);
    bindRevealButtons(resultsBody);
  }

  document.addEventListener("ple:tab-activated", (e) => {
    if (e.detail.tabName === "queue") {
      loadQueue();
      if (!pollTimer) pollTimer = setInterval(loadQueue, 3000);
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
})();

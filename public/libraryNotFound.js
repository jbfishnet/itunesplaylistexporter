/** The "Not Found" tab — files that had missing/sparse local tags (no
 * artist, album, or genre) *and* couldn't be matched against the iTunes
 * Search API either, so nothing could fill the gap. This status is terminal
 * (src/enrichmentQueue.js never retries it), so unlike the Queue tab this
 * list doesn't drain on its own — it's a plain paginated/filterable browse
 * of enrichment_status = 'not_found', reusing /api/library/browse. */
(() => {
  const el = (id) => document.getElementById(id);

  const metaEl = el("notfoundMeta");
  const resultsBody = el("notfoundResultsBody");
  const pageInfoEl = el("notfoundPageInfo");
  const prevBtn = el("notfoundPrevBtn");
  const nextBtn = el("notfoundNextBtn");
  const titleInput = el("notfoundFilterTitle");
  const retryAllBtn = el("notfoundRetryAllBtn");

  const PAGE_SIZE = 100;
  let offset = 0;
  let requestSeq = 0;
  let filterDebounceTimer = null;

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

  async function loadNotFound() {
    const mySeq = ++requestSeq;
    const params = new URLSearchParams({ status: "not_found", limit: PAGE_SIZE, offset });
    const title = titleInput.value.trim();
    if (title) params.set("title", title);

    try {
      const res = await fetch(`/api/library/browse?${params.toString()}`);
      const data = await res.json();
      if (mySeq !== requestSeq) return; // superseded by a newer filter/page change
      if (!res.ok) throw new Error(data.error || "Failed to load");
      renderRows(data.rows, data.total);
    } catch (err) {
      if (mySeq !== requestSeq) return;
      resultsBody.innerHTML = `<tr><td colspan="5" class="empty-state error-state">${err.message}</td></tr>`;
      metaEl.textContent = "Couldn't load the list.";
    }
  }

  function renderRows(rows, total) {
    if (rows.length === 0) {
      resultsBody.innerHTML = `<tr><td colspan="5" class="empty-state">Nothing here — every file either has good tags or was matched online.</td></tr>`;
    } else {
      resultsBody.innerHTML = rows
        .map(
          (r) => `
        <tr>
          <td><div class="title-cell">${playButtonHtml(r)}${revealButtonHtml(r)}<span><div class="track-title">${r.title || "(untitled)"}</div><div class="track-sub">${r.path}</div></span></div></td>
          <td>${r.artist || ""}</td>
          <td>${r.album || ""}</td>
          <td>${r.genre || ""}</td>
          <td class="col-format">${r.extension ? "." + r.extension : "—"}</td>
        </tr>`
        )
        .join("");
      bindPlayButtons(resultsBody);
      bindRevealButtons(resultsBody);
    }

    const from = total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + PAGE_SIZE, total);
    pageInfoEl.textContent = `${from}–${to} of ${total}`;
    metaEl.textContent = `${total} file${total === 1 ? "" : "s"} have missing tags and couldn't be matched online.`;
    prevBtn.disabled = offset === 0;
    nextBtn.disabled = to >= total;
  }

  titleInput.addEventListener("input", () => {
    offset = 0;
    clearTimeout(filterDebounceTimer);
    filterDebounceTimer = setTimeout(loadNotFound, 300);
  });

  retryAllBtn.addEventListener("click", async () => {
    retryAllBtn.disabled = true;
    retryAllBtn.textContent = "Queuing…";
    try {
      const res = await fetch("/api/library/requeue-not-found", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to requeue");
      metaEl.textContent = `Queued ${data.requeued} file${data.requeued === 1 ? "" : "s"} for another attempt — check the Queue tab for progress.`;
      offset = 0;
      loadNotFound();
    } catch (err) {
      metaEl.textContent = `Couldn't requeue — ${err.message}`;
    } finally {
      retryAllBtn.disabled = false;
      retryAllBtn.textContent = "Retry all with improved matching";
    }
  });

  prevBtn.addEventListener("click", () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    loadNotFound();
  });
  nextBtn.addEventListener("click", () => {
    offset += PAGE_SIZE;
    loadNotFound();
  });

  document.addEventListener("ple:tab-activated", (e) => {
    if (e.detail.tabName === "notfound") loadNotFound();
  });
})();

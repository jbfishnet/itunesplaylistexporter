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
  const selectAllEl = el("notfoundSelectAll");
  const selectedCountEl = el("notfoundSelectedCount");
  const deleteSelectedBtn = el("notfoundDeleteSelectedBtn");
  const editSelectedBtn = el("notfoundEditSelectedBtn");

  const metadataEditOverlay = el("metadataEditOverlay");
  const metadataEditTitle = el("metadataEditTitle");
  const metadataEditSub = el("metadataEditSub");
  const metadataEditCancelBtn = el("metadataEditCancelBtn");
  const metadataEditSaveBtn = el("metadataEditSaveBtn");
  const metaFieldTitle = el("metaFieldTitle");
  const metaFieldArtist = el("metaFieldArtist");
  const metaFieldAlbum = el("metaFieldAlbum");
  const metaFieldGenre = el("metaFieldGenre");
  const metaFieldYear = el("metaFieldYear");

  const PAGE_SIZE = 100;
  let offset = 0;
  let requestSeq = 0;
  let filterDebounceTimer = null;
  // Selection is per page, not global — a file leaves the list the moment
  // it's deleted, so there's no meaningful "selected across every page" any
  // list mutation wouldn't immediately invalidate. Cleared on every reload.
  const selectedIds = new Set();

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

  function formatDuration(seconds) {
    if (!seconds || !Number.isFinite(seconds)) return "—";
    const total = Math.round(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  function deleteButtonHtml(row) {
    return `<button type="button" class="delete-file-btn" data-trash-id="${row.id}" title="Move to Trash">🗑</button>`;
  }

  function editButtonHtml(row) {
    return `<button type="button" class="reveal-btn" data-edit-id="${row.id}" title="Edit metadata">✎</button>`;
  }

  /** Unlike the Duplicates tab's permanent delete (safe because a
   * byte-identical copy is guaranteed to exist elsewhere), a Not Found file
   * usually has no such guarantee — moved to the actual macOS Trash instead
   * of unlinked outright, so a wrong call is still recoverable. */
  async function trashFile(id) {
    const res = await fetch(`/api/library/not-found-files/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Delete failed");
    return data;
  }

  function updateSelectionUI() {
    const count = selectedIds.size;
    selectedCountEl.style.display = count > 0 ? "" : "none";
    selectedCountEl.textContent = count > 0 ? `${count} selected` : "";
    deleteSelectedBtn.style.display = count > 0 ? "" : "none";
    editSelectedBtn.style.display = count > 0 ? "" : "none";
    const rowCheckboxes = resultsBody.querySelectorAll(".notfound-row-checkbox");
    selectAllEl.checked = rowCheckboxes.length > 0 && Array.from(rowCheckboxes).every((cb) => cb.checked);
    selectAllEl.indeterminate = count > 0 && !selectAllEl.checked;
  }

  function bindRowSelection(container) {
    container.querySelectorAll(".notfound-row-checkbox").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.rowId;
        if (cb.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        updateSelectionUI();
      });
    });
  }

  function bindDeleteButtons(container) {
    container.querySelectorAll(".delete-file-btn[data-trash-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.trashId;
        const row = btn.closest("tr");
        const title = row.querySelector(".track-title")?.textContent || "this file";
        if (!confirm(`Move "${title}" to the Trash?`)) return;
        btn.disabled = true;
        try {
          await trashFile(id);
          selectedIds.delete(id);
          row.remove();
          updateSelectionUI();
          metaEl.textContent = `Moved "${title}" to the Trash.`;
        } catch (err) {
          btn.disabled = false;
          metaEl.textContent = `Couldn't move "${title}" to the Trash: ${err.message}`;
        }
      });
    });
  }

  // ---------- Manual metadata entry (single track or multiselect) ----------
  // Overwrites existing values without asking — a deliberate human
  // correction, not an automated guess, so it doesn't follow enrichment's
  // fill-only-if-empty rule. Writes both the index and the actual file, then
  // re-queues the track for another online lookup with the corrected
  // details (server-side: enrichment_status resets to 'pending').

  let editingIds = [];

  function openMetadataEdit(ids, singleRow) {
    editingIds = ids;
    const single = ids.length === 1 && singleRow;
    metadataEditTitle.textContent = ids.length === 1 ? "Edit metadata" : `Edit metadata for ${ids.length} tracks`;
    metadataEditSub.textContent = single
      ? singleRow.title || singleRow.path || "(untitled)"
      : "Blank fields are left unchanged on every track; filled-in fields apply to all of them identically.";
    metaFieldTitle.value = single ? singleRow.title || "" : "";
    metaFieldArtist.value = single ? singleRow.artist || "" : "";
    metaFieldAlbum.value = single ? singleRow.album || "" : "";
    metaFieldGenre.value = single ? singleRow.genre || "" : "";
    metaFieldYear.value = single ? singleRow.year || "" : "";
    metadataEditOverlay.classList.add("open");
    metaFieldTitle.focus();
  }

  function closeMetadataEdit() {
    metadataEditOverlay.classList.remove("open");
    editingIds = [];
  }

  function bindEditButtons(container, rows) {
    container.querySelectorAll("[data-edit-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = rows.find((r) => String(r.id) === String(btn.dataset.editId));
        openMetadataEdit([btn.dataset.editId], row);
      });
    });
  }

  editSelectedBtn.addEventListener("click", () => {
    if (selectedIds.size === 0) return;
    openMetadataEdit(Array.from(selectedIds), null);
  });

  metadataEditCancelBtn.addEventListener("click", closeMetadataEdit);
  metadataEditOverlay.addEventListener("click", (e) => {
    if (e.target === metadataEditOverlay) closeMetadataEdit();
  });

  metadataEditSaveBtn.addEventListener("click", async () => {
    const metadata = {
      title: metaFieldTitle.value,
      artist: metaFieldArtist.value,
      album: metaFieldAlbum.value,
      genre: metaFieldGenre.value,
      year: metaFieldYear.value,
    };
    if (!Object.values(metadata).some((v) => String(v).trim())) {
      metadataEditSub.textContent = "Enter at least one field before saving.";
      return;
    }

    metadataEditSaveBtn.disabled = true;
    metadataEditSaveBtn.textContent = "Saving…";
    try {
      const res = await fetch("/api/library/not-found-files/manual-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: editingIds, metadata }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      closeMetadataEdit();
      selectedIds.clear();
      metaEl.textContent = `Updated ${data.requeued} track${data.requeued === 1 ? "" : "s"} — re-queued for another online lookup with the new details.`;
      loadNotFound();
    } catch (err) {
      metadataEditSub.textContent = `Couldn't save: ${err.message}`;
    } finally {
      metadataEditSaveBtn.disabled = false;
      metadataEditSaveBtn.textContent = "Save & Re-check";
    }
  });

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
      selectedIds.clear(); // a reload means a new page/filter — old selection no longer applies
      renderRows(data.rows, data.total);
    } catch (err) {
      if (mySeq !== requestSeq) return;
      resultsBody.innerHTML = `<tr><td colspan="8" class="empty-state error-state">${err.message}</td></tr>`;
      metaEl.textContent = "Couldn't load the list.";
    }
  }

  function renderRows(rows, total) {
    if (rows.length === 0) {
      resultsBody.innerHTML = `<tr><td colspan="8" class="empty-state">Nothing here — every file either has good tags or was matched online.</td></tr>`;
    } else {
      resultsBody.innerHTML = rows
        .map(
          (r) => `
        <tr>
          <td class="col-select"><input type="checkbox" class="notfound-row-checkbox" data-row-id="${r.id}" /></td>
          <td><div class="title-cell">${playButtonHtml(r)}${revealButtonHtml(r)}<span><div class="track-title">${r.title || "(untitled)"}</div><div class="track-sub">${r.path}</div></span></div></td>
          <td>${r.artist || ""}</td>
          <td>${r.album || ""}</td>
          <td>${r.genre || ""}</td>
          <td class="col-format">${r.extension ? "." + r.extension : "—"}</td>
          <td class="col-format">${formatDuration(r.duration_sec)}</td>
          <td>${editButtonHtml(r)}${deleteButtonHtml(r)}</td>
        </tr>`
        )
        .join("");
      bindPlayButtons(resultsBody);
      bindRevealButtons(resultsBody);
      bindRowSelection(resultsBody);
      bindDeleteButtons(resultsBody);
      bindEditButtons(resultsBody, rows);
    }

    updateSelectionUI();

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

  selectAllEl.addEventListener("change", () => {
    resultsBody.querySelectorAll(".notfound-row-checkbox").forEach((cb) => {
      cb.checked = selectAllEl.checked;
      if (selectAllEl.checked) selectedIds.add(cb.dataset.rowId);
      else selectedIds.delete(cb.dataset.rowId);
    });
    updateSelectionUI();
  });

  deleteSelectedBtn.addEventListener("click", async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Move ${ids.length} file${ids.length === 1 ? "" : "s"} to the Trash?`)) return;

    deleteSelectedBtn.disabled = true;
    let failed = 0;
    for (let i = 0; i < ids.length; i += 1) {
      deleteSelectedBtn.textContent = `Moving to Trash… ${i + 1}/${ids.length}`;
      try {
        await trashFile(ids[i]);
        selectedIds.delete(ids[i]);
        resultsBody.querySelector(`[data-row-id="${ids[i]}"]`)?.closest("tr")?.remove();
      } catch {
        failed += 1;
      }
    }
    deleteSelectedBtn.textContent = "Move Selected to Trash";
    deleteSelectedBtn.disabled = false;
    metaEl.textContent =
      failed > 0
        ? `Moved ${ids.length - failed} of ${ids.length} files to the Trash — ${failed} failed.`
        : `Moved ${ids.length} file${ids.length === 1 ? "" : "s"} to the Trash.`;
    updateSelectionUI();
    loadNotFound(); // refresh totals/pagination now that some rows are gone
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

(() => {
  const el = (id) => document.getElementById(id);

  const metaEl = el("browseMeta");
  const resultsBody = el("browseResultsBody");
  const pageInfoEl = el("browsePageInfo");
  const prevBtn = el("browsePrevBtn");
  const nextBtn = el("browseNextBtn");
  const clearFiltersBtn = el("browseClearFiltersBtn");

  const titleInput = el("browseFilterTitle");
  const artistInput = el("browseFilterArtist");
  const albumInput = el("browseFilterAlbum");
  const genreSelect = el("browseFilterGenre");
  const yearSelect = el("browseFilterYear");
  const formatSelect = el("browseFilterFormat");
  const statusSelect = el("browseFilterStatus");
  const protectedSelect = el("browseFilterProtected");

  const PAGE_SIZE = 100;
  let offset = 0;
  let sortColumn = "title";
  let sortDir = "asc";
  let requestSeq = 0;

  const STATUS_LABELS = {
    enriched: "Enriched",
    not_found: "Not found online",
    skipped_had_tags: "Local tags",
    pending: "Not checked yet",
  };

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

  function statusBadgeClass(status) {
    if (status === "enriched") return "pill-enriched";
    if (status === "not_found") return "pill-not-found";
    return "pill-local-only";
  }

  function statusBadge(status) {
    const label = STATUS_LABELS[status] || status || "Unknown";
    return `<span class="pill ${statusBadgeClass(status)}"><span class="pill-dot"></span>${label}</span>`;
  }

  async function loadFacets() {
    try {
      const res = await fetch("/api/library/facets");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load filter options");

      fillOptions(genreSelect, data.genres, "Genre: All");
      fillOptions(formatSelect, data.extensions, "Format: All", (ext) => `.${ext}`);
      fillOptions(yearSelect, data.years, "Year: All");
      fillOptions(
        statusSelect,
        data.statuses,
        "Status: All",
        (s) => STATUS_LABELS[s] || s
      );
    } catch {
      metaEl.textContent = "Couldn't load filter options.";
    }
  }

  function fillOptions(selectEl, values, allLabel, formatLabel) {
    const previous = selectEl.value;
    selectEl.innerHTML = `<option value="">${allLabel}</option>`;
    (values || []).forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = formatLabel ? formatLabel(v) : String(v);
      selectEl.appendChild(opt);
    });
    if (previous && (values || []).some((v) => String(v) === previous)) selectEl.value = previous;
  }

  function currentFilters() {
    return {
      title: titleInput.value.trim(),
      artist: artistInput.value.trim(),
      album: albumInput.value.trim(),
      genre: genreSelect.value,
      year: yearSelect.value,
      extension: formatSelect.value,
      status: statusSelect.value,
      protected: protectedSelect.value,
    };
  }

  function updateSortIndicators() {
    document.querySelectorAll('#browseView th[data-sort]').forEach((th) => {
      th.classList.toggle("sorted-asc", th.dataset.sort === sortColumn && sortDir === "asc");
      th.classList.toggle("sorted-desc", th.dataset.sort === sortColumn && sortDir === "desc");
    });
  }

  async function loadBrowse() {
    const mySeq = ++requestSeq;
    const filters = currentFilters();
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    params.set("limit", PAGE_SIZE);
    params.set("offset", offset);
    params.set("sort", sortColumn);
    params.set("dir", sortDir);

    updateSortIndicators();

    try {
      const res = await fetch(`/api/library/browse?${params.toString()}`);
      const data = await res.json();
      if (mySeq !== requestSeq) return; // a newer filter change already superseded this request
      if (!res.ok) throw new Error(data.error || "Failed to load library index");

      renderRows(data.rows, data.total);
    } catch (err) {
      if (mySeq !== requestSeq) return;
      resultsBody.innerHTML = `<tr><td colspan="7" class="empty-state error-state">${err.message}</td></tr>`;
      metaEl.textContent = "Couldn't load the library index.";
    }
  }

  function renderRows(rows, total) {
    if (rows.length === 0) {
      resultsBody.innerHTML = `<tr><td colspan="7" class="empty-state">No files match these filters.</td></tr>`;
    } else {
      resultsBody.innerHTML = rows
        .map(
          (r) => `
        <tr>
          <td><div class="title-cell">${playButtonHtml(r)}${revealButtonHtml(r)}<span><div class="track-title">${r.title || "(untitled)"}</div><div class="track-sub">${r.path}</div></span></div></td>
          <td>${r.artist || ""}</td>
          <td>${r.album || ""}</td>
          <td>${r.genre || ""}</td>
          <td>${r.year || ""}</td>
          <td class="col-format">${r.extension ? "." + r.extension : "—"}</td>
          <td>${statusBadge(r.enrichmentStatus)}${r.protected ? ` <span class="pill pill-protected"><span class="pill-dot"></span>Protected</span>` : ""}</td>
        </tr>`
        )
        .join("");
      bindPlayButtons(resultsBody);
      bindRevealButtons(resultsBody);
    }

    const from = total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + PAGE_SIZE, total);
    pageInfoEl.textContent = `${from}–${to} of ${total}`;
    metaEl.textContent = `${total} file${total === 1 ? "" : "s"} in the index match these filters.`;
    prevBtn.disabled = offset === 0;
    nextBtn.disabled = to >= total;
  }

  let filterDebounceTimer = null;
  function onFilterChange({ debounce = false } = {}) {
    offset = 0;
    if (debounce) {
      clearTimeout(filterDebounceTimer);
      filterDebounceTimer = setTimeout(loadBrowse, 300);
    } else {
      loadBrowse();
    }
  }

  [titleInput, artistInput, albumInput].forEach((input) => {
    input.addEventListener("input", () => onFilterChange({ debounce: true }));
  });
  [genreSelect, yearSelect, formatSelect, statusSelect, protectedSelect].forEach((select) => {
    select.addEventListener("change", () => onFilterChange());
  });

  clearFiltersBtn.addEventListener("click", () => {
    [titleInput, artistInput, albumInput].forEach((input) => (input.value = ""));
    [genreSelect, yearSelect, formatSelect, statusSelect, protectedSelect].forEach((select) => (select.value = ""));
    onFilterChange();
  });

  prevBtn.addEventListener("click", () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    loadBrowse();
  });
  nextBtn.addEventListener("click", () => {
    offset += PAGE_SIZE;
    loadBrowse();
  });

  document.querySelectorAll('#browseView th[data-sort]').forEach((th) => {
    th.addEventListener("click", () => {
      if (sortColumn === th.dataset.sort) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortColumn = th.dataset.sort;
        sortDir = "asc";
      }
      offset = 0;
      loadBrowse();
    });
  });

  document.addEventListener("ple:tab-activated", (e) => {
    if (e.detail.tabName !== "browse") return;
    loadFacets();
    loadBrowse();
  });
})();

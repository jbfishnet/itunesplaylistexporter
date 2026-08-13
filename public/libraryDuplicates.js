/** The "Duplicates" tab — groups of byte-identical files (see
 * src/duplicateFinder.js), each with a checkbox per extra copy so deletion
 * is always an explicit, reviewable choice. The first file in every group is
 * always shown as "kept" with its checkbox disabled — this view never lets
 * you select every copy in a group, so it's structurally impossible to wipe
 * a song out of the library entirely from here. */
(() => {
  const el = (id) => document.getElementById(id);

  const groupCountEl = el("dupGroupCount");
  const extraCountEl = el("dupExtraCount");
  const reclaimableEl = el("dupReclaimable");
  const metaEl = el("dupMeta");
  const groupsEl = el("dupGroups");
  const pageInfoEl = el("dupPageInfo");
  const prevBtn = el("dupPrevBtn");
  const nextBtn = el("dupNextBtn");
  const deleteAllBtn = el("dupDeleteAllBtn");

  const similarMetaEl = el("similarMeta");
  const similarGroupsEl = el("similarGroups");
  const similarPageInfoEl = el("similarPageInfo");
  const similarPrevBtn = el("similarPrevBtn");
  const similarNextBtn = el("similarNextBtn");

  const PAGE_SIZE = 20;
  const BULK_FETCH_PAGE_SIZE = 100;
  let offset = 0;
  let similarOffset = 0;

  const FIELD_LABELS = {
    artist: "Artist",
    album: "Album",
    genre: "Genre",
    year: "Year",
    extension: "Format",
    size: "Size",
    durationSec: "Duration",
  };

  function escapeAttr(str) {
    return String(str).replace(/"/g, "&quot;");
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 MB";
    const mb = bytes / (1024 * 1024);
    if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
    if (mb < 1000) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
  }

  function playButtonHtml(file) {
    const url = `/api/library/audio/${file.id}`;
    const label = file.title || file.artist || "Track";
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

  function revealButtonHtml(file) {
    return `<button type="button" class="reveal-btn" data-reveal-id="${file.id}" title="Show in Finder">📂</button>`;
  }

  function bindRevealButtons(container) {
    container.querySelectorAll(".reveal-btn[data-reveal-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        fetch(`/api/library/reveal/${btn.dataset.revealId}`, { method: "POST" }).catch(() => {});
      });
    });
  }

  /** The folder-color dot from the Library Folders panel, repeated here so
   * you can tell at a glance which physical folder each copy lives in
   * without reading the full path. */
  function folderSwatchHtml(file) {
    if (!file.folderColor) return `<span class="folder-swatch" style="background:transparent" title="Folder no longer configured"></span>`;
    return `<span class="folder-swatch" style="background:${file.folderColor}" title="Folder color"></span>`;
  }

  async function loadDuplicates() {
    try {
      const res = await fetch(`/api/library/duplicates?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load duplicates");
      renderSummary(data);
      renderGroups(data.groups);
    } catch (err) {
      groupsEl.innerHTML = `<div class="dup-group"><div class="dup-empty">${err.message}</div></div>`;
    }
  }

  function renderSummary(data) {
    groupCountEl.textContent = data.total;
    extraCountEl.textContent = data.extraFiles;
    reclaimableEl.textContent = formatBytes(data.reclaimableBytes);
    metaEl.textContent =
      data.total === 0
        ? "Hashing runs automatically in the background — only exact byte-identical files are ever flagged."
        : "Only exact byte-identical files are flagged — the first file in each group is always kept.";

    deleteAllBtn.disabled = data.extraFiles === 0;

    const from = data.total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + PAGE_SIZE, data.total);
    pageInfoEl.textContent = `${from}–${to} of ${data.total}`;
    prevBtn.disabled = offset === 0;
    nextBtn.disabled = to >= data.total;
  }

  function fileRowHtml(file, { kept }) {
    return `
      <div class="dup-file-row${kept ? " kept" : ""}" data-file-id="${file.id}">
        ${playButtonHtml(file)}
        ${revealButtonHtml(file)}
        ${folderSwatchHtml(file)}
        <input type="checkbox" class="dup-check" ${kept ? "disabled" : ""} />
        <span class="dup-file-path">${file.path}</span>
        ${kept ? `<span class="keep-badge">kept</span>` : ""}
        <span class="dup-file-size">${formatBytes(file.size)}</span>
      </div>`;
  }

  function renderGroups(groups) {
    if (groups.length === 0) {
      groupsEl.innerHTML = `<div class="dup-group"><div class="dup-empty">No duplicates found (yet) — nothing to clean up.</div></div>`;
      return;
    }

    groupsEl.innerHTML = groups
      .map((group) => {
        const [first, ...rest] = group.files;
        const label = first.title || first.artist || "(untitled)";
        const sub = first.title && first.artist ? ` · ${first.artist}` : "";
        return `
        <div class="dup-group" data-hash="${escapeAttr(group.contentHash)}">
          <div class="dup-group-head">
            <span class="dup-group-title">${label}${sub}</span>
            <span class="dup-group-sub">${group.fileCount} identical copies · ${formatBytes(group.size)} each</span>
          </div>
          ${fileRowHtml(first, { kept: true })}
          ${rest.map((f) => fileRowHtml(f, { kept: false })).join("")}
          <div class="dup-group-actions">
            <span class="sel-count">0 selected</span>
            <button type="button" class="btn-danger" disabled>Delete selected</button>
          </div>
        </div>`;
      })
      .join("");

    bindPlayButtons(groupsEl);
    bindRevealButtons(groupsEl);
    groupsEl.querySelectorAll(".dup-group").forEach(bindGroup);
  }

  function bindGroup(groupEl) {
    const checks = groupEl.querySelectorAll(".dup-check:not(:disabled)");
    const selCountEl = groupEl.querySelector(".sel-count");
    const deleteBtn = groupEl.querySelector(".btn-danger");

    function refreshCount() {
      const n = groupEl.querySelectorAll(".dup-check:checked").length;
      selCountEl.textContent = `${n} selected`;
      deleteBtn.textContent = n ? `Delete selected (${n})` : "Delete selected";
      deleteBtn.disabled = n === 0;
    }
    checks.forEach((c) => c.addEventListener("change", refreshCount));

    deleteBtn.addEventListener("click", async () => {
      const rows = [...groupEl.querySelectorAll(".dup-check:checked")].map((c) => c.closest(".dup-file-row"));
      const count = rows.length;
      if (count === 0) return;
      if (!confirm(`Delete ${count} file${count === 1 ? "" : "s"} from disk? This cannot be undone.`)) return;

      deleteBtn.disabled = true;
      deleteBtn.textContent = "Deleting…";
      const failures = [];
      for (const row of rows) {
        const id = row.dataset.fileId;
        try {
          const res = await fetch(`/api/library/files/${id}`, { method: "DELETE" });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Delete failed");
          row.remove();
        } catch (err) {
          failures.push(`${row.querySelector(".dup-file-path").textContent}: ${err.message}`);
        }
      }
      if (failures.length) {
        metaEl.textContent = `Some deletions failed: ${failures.join("; ")}`;
      }
      loadDuplicates(); // refresh totals/pagination and drop any now-singleton groups
    });
  }

  /** Every extra (non-kept) file across every group, on every page — the
   * per-group "Delete selected" only ever sees the current page, but
   * "Delete All" means everything. */
  async function fetchAllExtraFileIds() {
    const ids = [];
    let cursor = 0;
    let total = Infinity;
    while (cursor < total) {
      const res = await fetch(`/api/library/duplicates?limit=${BULK_FETCH_PAGE_SIZE}&offset=${cursor}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load duplicates");
      total = data.total;
      if (data.groups.length === 0) break;
      for (const group of data.groups) {
        const [, ...extras] = group.files; // skip the first (kept) file
        ids.push(...extras.map((f) => f.id));
      }
      cursor += BULK_FETCH_PAGE_SIZE;
    }
    return ids;
  }

  deleteAllBtn.addEventListener("click", async () => {
    const extraCount = extraCountEl.textContent;
    const reclaimable = reclaimableEl.textContent;
    if (!confirm(`Delete all ${extraCount} duplicate files (freeing ~${reclaimable}) from disk? This cannot be undone.`)) return;

    deleteAllBtn.disabled = true;
    try {
      const ids = await fetchAllExtraFileIds();
      let failed = 0;
      for (let i = 0; i < ids.length; i += 1) {
        deleteAllBtn.textContent = `Deleting ${i + 1}/${ids.length}…`;
        try {
          const res = await fetch(`/api/library/files/${ids[i]}`, { method: "DELETE" });
          if (!res.ok) failed += 1;
        } catch {
          failed += 1;
        }
      }
      const plural = ids.length === 1 ? "" : "s";
      metaEl.textContent =
        failed > 0
          ? `Deleted ${ids.length - failed} of ${ids.length} files — ${failed} failed.`
          : `Deleted ${ids.length} file${plural}.`;
    } catch (err) {
      metaEl.textContent = `Couldn't delete all duplicates: ${err.message}`;
    } finally {
      deleteAllBtn.textContent = "Delete All Duplicates";
      offset = 0;
      loadDuplicates();
    }
  });

  prevBtn.addEventListener("click", () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    loadDuplicates();
  });
  nextBtn.addEventListener("click", () => {
    offset += PAGE_SIZE;
    loadDuplicates();
  });

  function formatFieldValue(field, file) {
    const value = file[field];
    if (field === "size") return formatBytes(value);
    if (field === "extension") return value ? `.${value}` : "—";
    if (field === "durationSec") return value ? `${Math.round(value)}s` : "—";
    return value || "—";
  }

  async function loadSimilar() {
    try {
      const res = await fetch(`/api/library/similar?limit=${PAGE_SIZE}&offset=${similarOffset}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load similar titles");
      renderSimilar(data);
    } catch (err) {
      similarGroupsEl.innerHTML = `<div class="dup-group"><div class="dup-empty">${err.message}</div></div>`;
    }
  }

  function renderSimilar(data) {
    const titlePlural = data.total === 1 ? "" : "s";
    similarMetaEl.textContent =
      data.total === 0
        ? "Nothing here — every shared title is either an exact duplicate (see above) or fully consistent."
        : `${data.total} title${titlePlural} shared by files that differ in some other way.`;

    const from = data.total === 0 ? 0 : similarOffset + 1;
    const to = Math.min(similarOffset + PAGE_SIZE, data.total);
    similarPageInfoEl.textContent = `${from}–${to} of ${data.total}`;
    similarPrevBtn.disabled = similarOffset === 0;
    similarNextBtn.disabled = to >= data.total;

    if (data.groups.length === 0) {
      similarGroupsEl.innerHTML = "";
      return;
    }

    similarGroupsEl.innerHTML = data.groups
      .map((group) => {
        const fieldLabels = group.diffFields.map((f) => FIELD_LABELS[f] || f).join(", ");
        const rows = group.files
          .map((file) => {
            const metaParts = group.diffFields.map(
              (field) => `<span class="diff">${FIELD_LABELS[field] || field}: ${formatFieldValue(field, file)}</span>`
            );
            return `
            <div class="dup-file-row">
              ${playButtonHtml(file)}
              ${revealButtonHtml(file)}
              ${folderSwatchHtml(file)}
              <span class="dup-file-path">${file.path}</span>
              <span class="dup-file-meta">${metaParts.join("")}</span>
            </div>`;
          })
          .join("");
        return `
        <div class="dup-group">
          <div class="dup-group-head">
            <span class="dup-group-title">${group.title}</span>
            <span class="dup-group-sub">${group.files.length} files · differs in ${fieldLabels}</span>
          </div>
          ${rows}
        </div>`;
      })
      .join("");

    bindPlayButtons(similarGroupsEl);
    bindRevealButtons(similarGroupsEl);
  }

  similarPrevBtn.addEventListener("click", () => {
    similarOffset = Math.max(0, similarOffset - PAGE_SIZE);
    loadSimilar();
  });
  similarNextBtn.addEventListener("click", () => {
    similarOffset += PAGE_SIZE;
    loadSimilar();
  });

  document.addEventListener("ple:tab-activated", (e) => {
    if (e.detail.tabName === "duplicates") {
      loadDuplicates();
      loadSimilar();
    }
  });
})();

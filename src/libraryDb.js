const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  path              TEXT UNIQUE NOT NULL,
  size              INTEGER NOT NULL,
  mtime_ms          INTEGER NOT NULL,
  extension         TEXT,
  title             TEXT,
  artist            TEXT,
  album             TEXT,
  genre             TEXT,
  year              INTEGER,
  track_no          INTEGER,
  duration_sec      REAL,
  protected         INTEGER NOT NULL DEFAULT 0,
  parse_status      TEXT NOT NULL DEFAULT 'pending',
  enrichment_status TEXT NOT NULL DEFAULT 'pending',
  enriched_at       INTEGER,
  content_hash      TEXT,
  hash_status       TEXT NOT NULL DEFAULT 'pending',
  last_seen_scan_id INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_enrichment_status ON files(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_files_last_seen_scan ON files(last_seen_scan_id);

-- Deliberately NOT an external-content ("content=files") FTS5 table: that mode
-- requires the FTS5 column names to exactly match real columns on the content
-- table (files has no filename/folder columns, only path) and requires a
-- strict delete-before-update ordering to avoid corrupting the index. A
-- standalone table stores its own copy of the small amount of searchable
-- text and has none of those failure modes — verified empirically while
-- building this: the external-content approach corrupted the database both
-- on a delete-before-any-insert and on an update-then-delete ordering.
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  title, artist, album, genre, filename, folder
);

CREATE TABLE IF NOT EXISTS scan_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

/** `CREATE TABLE IF NOT EXISTS` only handles brand-new databases — an
 * existing on-disk database (like the real ~19,600-row one already in daily
 * use) keeps whatever columns it had when first created, so adding a column
 * to the schema string above does nothing for it without an explicit
 * `ALTER TABLE` here, run once, guarded by checking what's already there. */
function migrate(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(files)").all().map((c) => c.name));
  if (!columns.has("content_hash")) {
    db.exec("ALTER TABLE files ADD COLUMN content_hash TEXT");
  }
  if (!columns.has("hash_status")) {
    db.exec("ALTER TABLE files ADD COLUMN hash_status TEXT NOT NULL DEFAULT 'pending'");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_files_size ON files(size)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash)");
}

function ftsColumnsFor(record) {
  return {
    title: record.title || "",
    artist: record.artist || "",
    album: record.album || "",
    genre: record.genre || "",
    filename: path.basename(record.path),
    folder: path.dirname(record.path),
  };
}

/**
 * Opens (creating if needed) a library index database at dbPath, or an
 * in-memory one if dbPath is ":memory:". Returns a small set of typed
 * operations — no caller ever touches files_fts directly, so the files/
 * files_fts pair can never drift out of sync.
 */
function openLibraryDb(dbPath) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  migrate(db);

  // browse()'s WHERE/ORDER BY shape varies with which filters are active,
  // so it can't be one of the fixed statements below — but the same handful
  // of shapes recur constantly (e.g. the Queue tab polls the exact same
  // browse query every 3s), so caching by SQL text avoids re-preparing an
  // identical statement on every one of those polls.
  const dynamicStmtCache = new Map();
  function preparedFor(sql) {
    let stmt = dynamicStmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      dynamicStmtCache.set(sql, stmt);
    }
    return stmt;
  }

  // getStats()/getFacets() cache their (cheap-but-not-free) aggregate query
  // results briefly — invalidated on every write below, so a change is
  // reflected on the very next read. The TTL only protects against several
  // reads landing in the same instant (concurrent tabs polling status), never
  // against staleness after a mutation this process itself just made.
  let statsCache = null;
  let facetsCache = null;
  function invalidateAggregateCaches() {
    statsCache = null;
    facetsCache = null;
  }

  const stmts = {
    getIdByPath: db.prepare("SELECT id FROM files WHERE path = ?"),
    getFileByPath: db.prepare("SELECT * FROM files WHERE path = ?"),
    // content_hash/hash_status aren't bound params — a brand-new row always
    // starts unhashed, and an updated row's old hash is for its *previous*
    // bytes, so both cases collapse to the same fixed reset.
    insertFile: db.prepare(`
      INSERT INTO files (
        path, size, mtime_ms, extension, title, artist, album, genre, year, track_no,
        duration_sec, protected, parse_status, enrichment_status, enriched_at,
        content_hash, hash_status, last_seen_scan_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?)
    `),
    updateFile: db.prepare(`
      UPDATE files SET
        size = ?, mtime_ms = ?, extension = ?, title = ?, artist = ?, album = ?, genre = ?,
        year = ?, track_no = ?, duration_sec = ?, protected = ?, parse_status = ?,
        enrichment_status = ?, enriched_at = ?, content_hash = NULL, hash_status = 'pending',
        last_seen_scan_id = ?, updated_at = ?
      WHERE id = ?
    `),
    deleteFts: db.prepare("DELETE FROM files_fts WHERE rowid = ?"),
    insertFts: db.prepare(
      "INSERT INTO files_fts (rowid, title, artist, album, genre, filename, folder) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ),
    touchSeen: db.prepare("UPDATE files SET last_seen_scan_id = ?, updated_at = ? WHERE id = ?"),
    staleIds: db.prepare("SELECT id FROM files WHERE last_seen_scan_id != ?"),
    deleteFileById: db.prepare("DELETE FROM files WHERE id = ?"),
    search: db.prepare(`
      SELECT files.* FROM files_fts
      JOIN files ON files.id = files_fts.rowid
      WHERE files_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `),
    countAll: db.prepare("SELECT COUNT(*) AS n FROM files"),
    countByEnrichment: db.prepare("SELECT enrichment_status, COUNT(*) AS n FROM files GROUP BY enrichment_status"),
    enrichmentBacklog: db.prepare(
      "SELECT id, path, title, artist, album, genre, year, extension, protected FROM files WHERE enrichment_status = 'pending' ORDER BY id ASC LIMIT ?"
    ),
    markEnriched: db.prepare(`
      UPDATE files SET title = ?, artist = ?, album = ?, genre = ?, year = ?,
        enrichment_status = 'enriched', enriched_at = ?, updated_at = ? WHERE id = ?
    `),
    markStatus: db.prepare("UPDATE files SET enrichment_status = ?, updated_at = ? WHERE id = ?"),
    requeueNotFound: db.prepare("UPDATE files SET enrichment_status = 'pending', updated_at = ? WHERE enrichment_status = 'not_found'"),
    getById: db.prepare("SELECT * FROM files WHERE id = ?"),
    setMeta: db.prepare("INSERT INTO scan_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    getMeta: db.prepare("SELECT value FROM scan_meta WHERE key = ?"),

    // --- duplicate detection ---
    hashCandidates: db.prepare("SELECT id, path, size FROM files WHERE hash_status = 'pending' ORDER BY id ASC LIMIT ?"),
    countOtherFilesWithSize: db.prepare("SELECT COUNT(*) AS c FROM files WHERE size = ? AND id != ?"),
    setHashDone: db.prepare("UPDATE files SET content_hash = ?, hash_status = 'done', updated_at = ? WHERE id = ?"),
    setHashStatus: db.prepare("UPDATE files SET hash_status = ?, updated_at = ? WHERE id = ?"),
    duplicateGroupPage: db.prepare(`
      SELECT content_hash, COUNT(*) AS file_count, MIN(size) AS size
      FROM files WHERE hash_status = 'done'
      GROUP BY content_hash HAVING file_count > 1
      ORDER BY content_hash
      LIMIT ? OFFSET ?
    `),
    duplicateGroupTotal: db.prepare(`
      SELECT COUNT(*) AS groups, COALESCE(SUM(file_count), 0) AS totalFiles,
        COALESCE(SUM(file_count - 1), 0) AS extraFiles, COALESCE(SUM((file_count - 1) * size), 0) AS reclaimableBytes
      FROM (
        SELECT COUNT(*) AS file_count, MIN(size) AS size
        FROM files WHERE hash_status = 'done'
        GROUP BY content_hash HAVING file_count > 1
      )
    `),
    filesForHash: db.prepare("SELECT id, path, title, artist, size FROM files WHERE content_hash = ? ORDER BY id ASC"),
    countDoneWithHash: db.prepare("SELECT COUNT(*) AS c FROM files WHERE content_hash = ? AND hash_status = 'done'"),
    deleteFileRow: db.prepare("DELETE FROM files WHERE id = ?"),
  };

  function syncFts(id, record) {
    const cols = ftsColumnsFor(record);
    stmts.insertFts.run(id, cols.title, cols.artist, cols.album, cols.genre, cols.filename, cols.folder);
  }

  /** Insert a new file row or update an existing one (matched by path), keeping FTS in sync. Returns the row id. */
  function upsertFile(record) {
    invalidateAggregateCaches();
    const now = Date.now();
    const existing = stmts.getIdByPath.get(record.path);

    if (existing) {
      const id = existing.id;
      stmts.deleteFts.run(id);
      stmts.updateFile.run(
        record.size,
        record.mtimeMs,
        record.extension || null,
        record.title || null,
        record.artist || null,
        record.album || null,
        record.genre || null,
        record.year || null,
        record.trackNo || null,
        record.durationSec || null,
        record.protected ? 1 : 0,
        record.parseStatus || "pending",
        record.enrichmentStatus || "pending",
        record.enrichedAt || null,
        record.scanId,
        now,
        id
      );
      syncFts(id, record);
      return id;
    }

    const result = stmts.insertFile.run(
      record.path,
      record.size,
      record.mtimeMs,
      record.extension || null,
      record.title || null,
      record.artist || null,
      record.album || null,
      record.genre || null,
      record.year || null,
      record.trackNo || null,
      record.durationSec || null,
      record.protected ? 1 : 0,
      record.parseStatus || "pending",
      record.enrichmentStatus || "pending",
      record.enrichedAt || null,
      record.scanId,
      now,
      now
    );
    const id = Number(result.lastInsertRowid);
    syncFts(id, record);
    return id;
  }

  /** Cheap path for an unchanged file: just stamp that this scan still saw it. */
  function markSeen(id, scanId) {
    stmts.touchSeen.run(scanId, Date.now(), id);
  }

  /** Removes every file not stamped with the given scanId (i.e. no longer found on disk), and their FTS entries. */
  function deleteFilesNotSeenInScan(scanId) {
    const stale = stmts.staleIds.all(scanId);
    if (stale.length > 0) invalidateAggregateCaches();
    for (const row of stale) {
      stmts.deleteFts.run(row.id);
      stmts.deleteFileById.run(row.id);
    }
    return stale.length;
  }

  /** FTS5 query syntax is picky about bare punctuation/special tokens — wrap each
   * whitespace-separated term in double quotes and OR them together so a raw,
   * messy user query never throws a syntax error. */
  function buildMatchQuery(query) {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term.replace(/"/g, '""')}"*`);
    return terms.join(" OR ");
  }

  function search(query, limit = 200) {
    const matchQuery = buildMatchQuery(query);
    if (!matchQuery) return [];
    return stmts.search.all(matchQuery, limit);
  }

  // getStats() is polled every 3-4s by the Search and Queue tabs (more often
  // still with both open at once) purely to report counts that don't move
  // meaningfully within a couple of seconds — a short cache collapses those
  // into one aggregate query without the reported numbers ever visibly lagging.
  function getStats() {
    if (statsCache && Date.now() < statsCache.expiresAt) return statsCache.value;

    const total = stmts.countAll.get().n;
    const byStatus = {};
    for (const row of stmts.countByEnrichment.all()) byStatus[row.enrichment_status] = row.n;
    const value = {
      totalFiles: total,
      enrichmentCounts: byStatus,
      lastScanStartedAt: stmts.getMeta.get("last_scan_started_at")?.value || null,
      lastScanFinishedAt: stmts.getMeta.get("last_scan_finished_at")?.value || null,
      lastScanResult: stmts.getMeta.get("last_scan_result")?.value || null,
    };
    statsCache = { value, expiresAt: Date.now() + 1500 };
    return value;
  }

  function getEnrichmentBacklog(limit = 1) {
    return stmts.enrichmentBacklog.all(limit);
  }

  function markEnriched(id, tags) {
    const existing = stmts.getById.get(id);
    if (!existing) return;
    invalidateAggregateCaches();
    stmts.markEnriched.run(
      tags.title || null,
      tags.artist || null,
      tags.album || null,
      tags.genre || null,
      tags.year || null,
      Date.now(),
      Date.now(),
      id
    );
    stmts.deleteFts.run(id);
    syncFts(id, { ...tags, path: existing.path });
  }

  function markNotFound(id) {
    invalidateAggregateCaches();
    stmts.markStatus.run("not_found", Date.now(), id);
  }

  /** Puts every terminal "not_found" row back into the pending backlog —
   * used after an enrichment-matching improvement ships, so files that
   * failed under the old logic get a fresh attempt under the new one.
   * Returns how many rows were requeued. */
  function requeueNotFound() {
    invalidateAggregateCaches();
    return stmts.requeueNotFound.run(Date.now()).changes;
  }

  // --- Duplicate detection (byte-identical files only — see duplicateFinder.js) ---

  /** Up to `limit` files still needing a hash decision, in the order they
   * were indexed. Includes files that will turn out to be unique by size —
   * the caller (duplicateFinder.js) checks that cheaply before ever reading
   * the file, via hasOtherFileWithSameSize(). */
  function getHashCandidates(limit = 5) {
    return stmts.hashCandidates.all(limit);
  }

  /** Cheap pre-check with no file I/O: is there any *other* row with this
   * exact size? A file with a unique size can't be a byte-identical
   * duplicate of anything, so it never needs to actually be hashed. */
  function hasOtherFileWithSameSize(id, size) {
    return stmts.countOtherFilesWithSize.get(size, id).c > 0;
  }

  function setHashDone(id, contentHash) {
    invalidateAggregateCaches();
    stmts.setHashDone.run(contentHash, Date.now(), id);
  }

  /** For a file that turned out unique by size ('not_needed') or that
   * failed to hash ('error') — either way, settles it out of the backlog so
   * getHashCandidates() stops returning it. */
  function setHashStatus(id, status) {
    stmts.setHashStatus.run(status, Date.now(), id);
  }

  /** Paginated duplicate groups — each group is 2+ files with the same
   * content_hash (and therefore, by construction, the same size). Fetches
   * member files per group rather than one large join so each group's
   * files arrive together, ready to render. */
  function getDuplicateGroups({ limit = 20, offset = 0 } = {}) {
    const hashRows = stmts.duplicateGroupPage.all(limit, offset);
    const groups = hashRows.map((row) => ({
      contentHash: row.content_hash,
      fileCount: row.file_count,
      size: row.size,
      files: stmts.filesForHash.all(row.content_hash),
    }));
    const totals = stmts.duplicateGroupTotal.get();
    return { groups, total: totals.groups, totalFiles: totals.totalFiles, extraFiles: totals.extraFiles, reclaimableBytes: totals.reclaimableBytes };
  }

  /** Safety guard for deletion: refuses unless the file is *currently*
   * confirmed to have at least one byte-identical twin still in the index —
   * never trusts a client-supplied "yes this is a duplicate" claim. */
  function isPartOfDuplicateGroup(id) {
    const row = stmts.getById.get(id);
    if (!row || !row.content_hash || row.hash_status !== "done") return false;
    return stmts.countDoneWithHash.get(row.content_hash).c > 1;
  }

  /** Removes the index row + FTS entry for a file — the caller is
   * responsible for actually deleting the file from disk first, and for
   * only calling this once that succeeded (see DELETE /api/library/files/:id
   * in server.js) — this never touches the filesystem itself. */
  function deleteFileRow(id) {
    invalidateAggregateCaches();
    stmts.deleteFts.run(id);
    stmts.deleteFileRow.run(id);
  }

  // --- Same-title, not-necessarily-identical groups ("Similar Titles") ---
  // A second, gentler detection method alongside the byte-identical one
  // above: files that share a title but differ in some other field (artist
  // spelling, album, format, size, ...) — could be a real near-duplicate, or
  // could be a legitimately different recording (a live version, a cover),
  // so this is purely informational (no delete affordance) — it lists what's
  // different and leaves the judgment call to whoever's looking at it.
  const SIMILAR_COMPARE_FIELDS = ["artist", "album", "genre", "year", "extension", "size", "duration_sec"];

  function normalizeForCompare(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim().toLowerCase();
  }

  /** Which of SIMILAR_COMPARE_FIELDS actually differ across these rows —
   * an empty result means the rows are identical in everything but id/path,
   * which is exactly what the byte-identical detector above already covers,
   * so the caller skips those rather than showing the same story twice. */
  function fieldsThatDiffer(rows) {
    return SIMILAR_COMPARE_FIELDS.filter((field) => {
      const distinctValues = new Set(rows.map((r) => normalizeForCompare(r[field])));
      return distinctValues.size > 1;
    });
  }

  /** Every title shared by 2+ files, each with which fields differ between
   * those files — computed in JS rather than pure SQL because "which fields
   * differ" needs the actual rows, and how many titles qualify (some get
   * filtered out as fully-identical) isn't knowable until then either, so
   * pagination is applied after filtering, on the qualifying list. Title
   * groups are typically a small fraction of the whole library, so scanning
   * all of them per request is cheap in practice. */
  function getSimilarTitleGroups({ limit = 20, offset = 0 } = {}) {
    const titleRows = db
      .prepare(
        `SELECT title FROM files WHERE title IS NOT NULL AND title != '' GROUP BY title COLLATE NOCASE HAVING COUNT(*) > 1 ORDER BY title COLLATE NOCASE`
      )
      .all();

    const membersStmt = preparedFor("SELECT * FROM files WHERE title = ? COLLATE NOCASE ORDER BY id ASC");
    const qualifying = [];
    for (const { title } of titleRows) {
      const rows = membersStmt.all(title);
      const diffFields = fieldsThatDiffer(rows);
      if (diffFields.length > 0) qualifying.push({ title, files: rows, diffFields });
    }

    return { total: qualifying.length, groups: qualifying.slice(offset, offset + limit) };
  }

  const BROWSE_SORT_COLUMNS = new Set([
    "id", "title", "artist", "album", "genre", "year", "extension", "enrichment_status", "updated_at", "enriched_at",
  ]);

  /**
   * Filterable, paginated listing of the whole index — the "browse" view is
   * deliberately separate from search(): search() is FTS relevance ranking
   * over free text, this is exact/contains filtering per column (status,
   * genre, format, ...) for a spreadsheet-like table. Column names in
   * ORDER BY can't be parameterized, so sortColumn is checked against an
   * allow-list rather than interpolated directly.
   */
  function browse({
    title, artist, album, genre, extension, status, protected: protectedFilter, year,
    limit = 100, offset = 0, sortColumn = "title", sortDir = "asc",
  } = {}) {
    const conditions = [];
    const params = [];

    const addContains = (column, value) => {
      if (value && String(value).trim()) {
        conditions.push(`${column} LIKE ? ESCAPE '\\'`);
        params.push(`%${String(value).trim().replace(/[%_]/g, "\\$&")}%`);
      }
    };
    const addExact = (column, value) => {
      if (value !== undefined && value !== null && value !== "") {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    };

    addContains("title", title);
    addContains("artist", artist);
    addContains("album", album);
    addExact("genre", genre);
    addExact("extension", extension);
    addExact("enrichment_status", status);
    addExact("year", year);
    if (protectedFilter === "yes") conditions.push("protected = 1");
    else if (protectedFilter === "no") conditions.push("protected = 0");

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const column = BROWSE_SORT_COLUMNS.has(sortColumn) ? sortColumn : "title";
    const direction = sortDir === "desc" ? "DESC" : "ASC";

    const total = preparedFor(`SELECT COUNT(*) AS n FROM files ${whereClause}`).get(...params).n;
    const rows = preparedFor(
      `SELECT * FROM files ${whereClause} ORDER BY ${column} COLLATE NOCASE ${direction}, id ASC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    return { rows, total };
  }

  /** Distinct values for the browse view's filter dropdowns — always drawn
   * from the whole table (not the current filters), so dropdown options
   * never shrink out from under the user as they narrow their filters.
   * These are 4 full-table scans, and dropdown options only ever change
   * after a scan or an enrichment write — not worth redoing on every single
   * Browse-tab activation, hence the short cache. */
  function getFacets() {
    if (facetsCache && Date.now() < facetsCache.expiresAt) return facetsCache.value;

    const genres = preparedFor(
      "SELECT DISTINCT genre FROM files WHERE genre IS NOT NULL AND genre != '' ORDER BY genre COLLATE NOCASE"
    )
      .all()
      .map((r) => r.genre);
    const extensions = preparedFor(
      "SELECT DISTINCT extension FROM files WHERE extension IS NOT NULL AND extension != '' ORDER BY extension COLLATE NOCASE"
    )
      .all()
      .map((r) => r.extension);
    const years = preparedFor("SELECT DISTINCT year FROM files WHERE year IS NOT NULL ORDER BY year DESC")
      .all()
      .map((r) => r.year);
    const statuses = preparedFor("SELECT DISTINCT enrichment_status FROM files ORDER BY enrichment_status")
      .all()
      .map((r) => r.enrichment_status);

    const value = { genres, extensions, years, statuses };
    facetsCache = { value, expiresAt: Date.now() + 30_000 };
    return value;
  }

  function setMeta(key, value) {
    stmts.setMeta.run(key, String(value));
  }

  function getMeta(key) {
    return stmts.getMeta.get(key)?.value || null;
  }

  /** The configured library folders, stored as a JSON array under a
   * scan_meta key rather than a dedicated table — it's a short, rarely-
   * written list, and scan_meta already exists for exactly this shape of
   * data. Returns null (not []) when never set, so callers can tell "no
   * roots configured yet" apart from "explicitly configured as empty" and
   * seed a sensible default only for the former. */
  function getLibraryRoots() {
    const raw = getMeta("library_roots");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function setLibraryRoots(roots) {
    setMeta("library_roots", JSON.stringify(roots));
  }

  function close() {
    db.close();
  }

  return {
    upsertFile,
    markSeen,
    deleteFilesNotSeenInScan,
    search,
    browse,
    getFacets,
    getStats,
    getEnrichmentBacklog,
    markEnriched,
    markNotFound,
    requeueNotFound,
    setMeta,
    getMeta,
    getLibraryRoots,
    setLibraryRoots,
    getHashCandidates,
    hasOtherFileWithSameSize,
    setHashDone,
    setHashStatus,
    getDuplicateGroups,
    isPartOfDuplicateGroup,
    deleteFileRow,
    getSimilarTitleGroups,
    getIdByPath: (p) => stmts.getIdByPath.get(p)?.id ?? null,
    getFileByPath: (p) => stmts.getFileByPath.get(p),
    getById: (id) => stmts.getById.get(id),
    close,
    _raw: db, // escape hatch for tests only
  };
}

module.exports = { openLibraryDb };

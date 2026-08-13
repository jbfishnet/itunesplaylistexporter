const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { openLibraryDb } = require("../src/libraryDb");

function freshDb(t) {
  const db = openLibraryDb(":memory:");
  t.after(() => db.close());
  return db;
}

test("search matches by title, artist, and filename-only rows (no tags at all)", (t) => {
  const db = freshDb(t);

  db.upsertFile({
    path: "/music/Killers/Hot Fuss/02 Mr. Brightside.m4a",
    size: 1,
    mtimeMs: 1,
    extension: "m4a",
    title: "Mr. Brightside",
    artist: "The Killers",
    album: "Hot Fuss",
    scanId: 1,
  });
  db.upsertFile({
    path: "/music/Avril Lavigne/Unknown Album/01 Complicated.mp3",
    size: 1,
    mtimeMs: 1,
    extension: "mp3",
    scanId: 1, // no tags at all — must still be findable by filename
  });

  assert.equal(db.search("Brightside").length, 1);
  assert.equal(db.search("Killers").length, 1);
  assert.equal(db.search("Complicated").length, 1, "filename-only file should be searchable");
  assert.equal(db.search("nothing matches this").length, 0);
});

test("search handles messy/punctuation-heavy queries without throwing", (t) => {
  const db = freshDb(t);
  db.upsertFile({ path: "/x.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "Don't Tell Me", scanId: 1 });
  assert.doesNotThrow(() => db.search('AND OR "unterminated quote'));
  assert.doesNotThrow(() => db.search(""));
  assert.deepEqual(db.search(""), []);
});

test("upsertFile updates an existing row (matched by path) instead of duplicating it", (t) => {
  const db = freshDb(t);
  const id1 = db.upsertFile({ path: "/a.mp3", size: 100, mtimeMs: 1, extension: "mp3", title: "Starlight", scanId: 1 });
  const id2 = db.upsertFile({ path: "/a.mp3", size: 200, mtimeMs: 2, extension: "mp3", title: "Nocturne", scanId: 2 });

  assert.equal(id1, id2, "same path should reuse the same row id");
  assert.equal(db.getStats().totalFiles, 1);
  assert.equal(db.search("Nocturne").length, 1);
  assert.equal(db.search("Starlight").length, 0, "stale FTS entry must not survive an update");
});

test("deleteFilesNotSeenInScan removes only rows stamped with an older scan id", (t) => {
  const db = freshDb(t);
  const keptId = db.upsertFile({ path: "/keep.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "Alive", scanId: 5 });
  db.upsertFile({ path: "/gone.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "Vanished", scanId: 5 });

  // A later scan only re-confirms "keep.mp3" (e.g. "gone.mp3" was deleted from disk).
  db.markSeen(keptId, 6);
  const removed = db.deleteFilesNotSeenInScan(6);

  assert.equal(removed, 1);
  assert.equal(db.search("Alive").length, 1);
  assert.equal(db.search("Vanished").length, 0);
  assert.equal(db.getStats().totalFiles, 1);
});

test("enrichment lifecycle: backlog -> markEnriched fills fields and clears the backlog", (t) => {
  const db = freshDb(t);
  const id = db.upsertFile({
    path: "/sparse.mp3",
    size: 1,
    mtimeMs: 1,
    extension: "mp3",
    album: "Unknown Album",
    enrichmentStatus: "pending",
    scanId: 1,
  });

  assert.equal(db.getEnrichmentBacklog(10).length, 1);

  db.markEnriched(id, { title: "Complicated", artist: "Avril Lavigne", album: "Let Go", genre: "Pop Rock", year: 2002 });

  assert.equal(db.getEnrichmentBacklog(10).length, 0);
  assert.equal(db.search("Lavigne").length, 1);
  assert.equal(db.getStats().enrichmentCounts.enriched, 1);
});

test("markNotFound is terminal (does not reappear in the pending backlog)", (t) => {
  const db = freshDb(t);
  const id = db.upsertFile({ path: "/x.mp3", size: 1, mtimeMs: 1, extension: "mp3", enrichmentStatus: "pending", scanId: 1 });
  db.markNotFound(id);
  assert.equal(db.getEnrichmentBacklog(10).length, 0);
  assert.equal(db.getStats().enrichmentCounts.not_found, 1);
});

test("requeueNotFound puts every not_found row back into the pending backlog, leaving other statuses alone", (t) => {
  const db = freshDb(t);
  const notFoundId = db.upsertFile({ path: "/a.mp3", size: 1, mtimeMs: 1, extension: "mp3", enrichmentStatus: "pending", scanId: 1 });
  db.markNotFound(notFoundId);
  db.upsertFile({ path: "/b.mp3", size: 1, mtimeMs: 1, extension: "mp3", enrichmentStatus: "enriched", scanId: 1 });
  db.upsertFile({ path: "/c.mp3", size: 1, mtimeMs: 1, extension: "mp3", enrichmentStatus: "skipped_had_tags", scanId: 1 });

  const requeued = db.requeueNotFound();

  assert.equal(requeued, 1);
  assert.equal(db.getEnrichmentBacklog(10).length, 1);
  assert.equal(db.getStats().enrichmentCounts.not_found || 0, 0);
  assert.equal(db.getStats().enrichmentCounts.enriched, 1, "an already-enriched row must not be touched");
  assert.equal(db.getStats().enrichmentCounts.skipped_had_tags, 1, "a well-tagged row must not be touched");
});

test("enrichmentBacklog rows carry everything the enrichment queue and tag writer need (extension, year, protected)", (t) => {
  const db = freshDb(t);
  db.upsertFile({
    path: "/a.mp3", size: 1, mtimeMs: 1, extension: "mp3", year: 1999, protected: true,
    enrichmentStatus: "pending", scanId: 1,
  });
  const [row] = db.getEnrichmentBacklog(10);
  assert.equal(row.extension, "mp3");
  assert.equal(row.year, 1999);
  assert.equal(row.protected, 1);
});

test("getFileByPath returns the full row, or undefined when absent", (t) => {
  const db = freshDb(t);
  db.upsertFile({ path: "/a.mp3", size: 42, mtimeMs: 99, extension: "mp3", title: "Song", scanId: 1 });
  const row = db.getFileByPath("/a.mp3");
  assert.equal(row.size, 42);
  assert.equal(row.mtime_ms, 99);
  assert.equal(db.getFileByPath("/nope.mp3"), undefined);
});

test("scan_meta getMeta/setMeta round-trip", (t) => {
  const db = freshDb(t);
  assert.equal(db.getMeta("last_scan_result"), null);
  db.setMeta("last_scan_result", "ok");
  assert.equal(db.getMeta("last_scan_result"), "ok");
  db.setMeta("last_scan_result", "root_missing");
  assert.equal(db.getMeta("last_scan_result"), "root_missing", "setMeta should overwrite, not duplicate");
});

test("browse filters by status, genre, format, and protected, combinable", (t) => {
  const db = freshDb(t);
  db.upsertFile({
    path: "/a.m4a", size: 1, mtimeMs: 1, extension: "m4a", title: "Song A", artist: "Artist A",
    genre: "Rock", year: 2001, enrichmentStatus: "enriched", scanId: 1,
  });
  db.upsertFile({
    path: "/b.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "Song B", artist: "Artist B",
    genre: "Pop", year: 2002, enrichmentStatus: "pending", scanId: 1,
  });
  db.upsertFile({
    path: "/c.m4p", size: 1, mtimeMs: 1, extension: "m4p", title: "Song C", artist: "Artist A",
    genre: "Rock", year: 2003, enrichmentStatus: "enriched", protected: true, scanId: 1,
  });

  assert.equal(db.browse({ status: "enriched" }).total, 2);
  assert.equal(db.browse({ genre: "Pop" }).total, 1);
  assert.equal(db.browse({ extension: "m4p" }).total, 1);
  assert.equal(db.browse({ protected: "yes" }).total, 1);
  assert.equal(db.browse({ protected: "no" }).total, 2);
  assert.equal(db.browse({ status: "enriched", genre: "Rock" }).total, 2);
  assert.equal(db.browse({ status: "enriched", genre: "Rock", protected: "yes" }).total, 1);
  assert.equal(db.browse({ artist: "Artist A" }).total, 2, "artist filter is a contains match");
  assert.equal(db.browse({}).total, 3, "no filters returns everything");
});

test("browse paginates and sorts, falling back to title for an unknown sort column", (t) => {
  const db = freshDb(t);
  db.upsertFile({ path: "/1.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "Bravo", scanId: 1 });
  db.upsertFile({ path: "/2.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "alpha", scanId: 1 });
  db.upsertFile({ path: "/3.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "Charlie", scanId: 1 });

  const page1 = db.browse({ limit: 2, offset: 0 });
  assert.equal(page1.total, 3);
  assert.deepEqual(page1.rows.map((r) => r.title), ["alpha", "Bravo"], "case-insensitive title sort");

  const page2 = db.browse({ limit: 2, offset: 2 });
  assert.deepEqual(page2.rows.map((r) => r.title), ["Charlie"]);

  const unsorted = db.browse({ sortColumn: "'; DROP TABLE files; --" });
  assert.equal(unsorted.rows[0].title, "alpha", "unknown/malicious sort column falls back to title");
});

test("browse's LIKE filters treat % and _ literally instead of as wildcards", (t) => {
  const db = freshDb(t);
  db.upsertFile({ path: "/1.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "100% Pure", scanId: 1 });
  db.upsertFile({ path: "/2.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "100X Pure", scanId: 1 });

  assert.equal(db.browse({ title: "100%" }).total, 1, "% in the filter should not match every title");
  assert.equal(db.browse({ title: "100_ Pure" }).total, 0, "_ in the filter should not match any single character");
});

test("getFacets returns sorted distinct values, ignoring nulls/blanks", (t) => {
  const db = freshDb(t);
  db.upsertFile({ path: "/1.mp3", size: 1, mtimeMs: 1, extension: "mp3", genre: "Rock", year: 2005, enrichmentStatus: "enriched", scanId: 1 });
  db.upsertFile({ path: "/2.m4a", size: 1, mtimeMs: 1, extension: "m4a", genre: "Pop", year: 2001, enrichmentStatus: "pending", scanId: 1 });
  db.upsertFile({ path: "/3.mp3", size: 1, mtimeMs: 1, extension: "mp3", scanId: 1 }); // no genre/year at all

  const facets = db.getFacets();
  assert.deepEqual(facets.genres, ["Pop", "Rock"]);
  assert.deepEqual(facets.extensions, ["m4a", "mp3"]);
  assert.deepEqual(facets.years, [2005, 2001]);
  assert.deepEqual(facets.statuses.slice().sort(), ["enriched", "pending"]);
});

test("getStats/getFacets cache briefly for repeated polling, but never return stale data after a write this same process just made", (t) => {
  const db = freshDb(t);
  db.upsertFile({ path: "/a.mp3", size: 1, mtimeMs: 1, extension: "mp3", genre: "Rock", enrichmentStatus: "pending", scanId: 1 });

  assert.equal(db.getStats().totalFiles, 1);
  assert.deepEqual(db.getFacets().genres, ["Rock"]);

  // Two rapid repeat reads with no write between them may legitimately share
  // a cached result — that's the whole point — but must still agree with
  // each other and with the write that already happened above.
  assert.equal(db.getStats().totalFiles, 1);

  db.upsertFile({ path: "/b.mp3", size: 1, mtimeMs: 1, extension: "mp3", genre: "Jazz", enrichmentStatus: "pending", scanId: 1 });

  // Immediately after a write, even milliseconds later, stats/facets must
  // reflect it — this is what an unconditional TTL cache would get wrong.
  assert.equal(db.getStats().totalFiles, 2);
  assert.deepEqual(db.getFacets().genres, ["Jazz", "Rock"]);
});

test("getSimilarTitleGroups finds same-title files that differ in some other field, and lists which fields", (t) => {
  const db = freshDb(t);
  db.upsertFile({
    path: "/a.mp3", size: 100, mtimeMs: 1, extension: "mp3", title: "Holiday",
    artist: "Madonna", album: "The Immaculate Collection", genre: "Pop", year: 1990, scanId: 1,
  });
  db.upsertFile({
    path: "/b.mp3", size: 200, mtimeMs: 1, extension: "mp3", title: "holiday", // case-insensitive title match
    artist: "Madonna", album: "Kuschelrock 5", genre: "Pop", year: 1990, scanId: 1,
  });

  const { total, groups } = db.getSimilarTitleGroups();

  assert.equal(total, 1);
  assert.equal(groups[0].title, "Holiday");
  assert.deepEqual(groups[0].diffFields.sort(), ["album", "size"]);
  assert.equal(groups[0].files.length, 2);
});

test("getSimilarTitleGroups excludes same-title files that are identical in every other comparable field too", (t) => {
  const db = freshDb(t);
  db.upsertFile({
    path: "/a.mp3", size: 100, mtimeMs: 1, extension: "mp3", title: "Same Everything",
    artist: "Band", album: "Album", genre: "Rock", year: 2000, scanId: 1,
  });
  db.upsertFile({
    path: "/b.mp3", size: 100, mtimeMs: 1, extension: "mp3", title: "Same Everything",
    artist: "Band", album: "Album", genre: "Rock", year: 2000, scanId: 1,
  });

  const { total, groups } = db.getSimilarTitleGroups();
  assert.equal(total, 0, "identical-in-everything-else pairs are already covered by exact-duplicate detection");
  assert.deepEqual(groups, []);
});

test("getSimilarTitleGroups ignores blank/null titles (never groups every untitled file together)", (t) => {
  const db = freshDb(t);
  db.upsertFile({ path: "/a.mp3", size: 100, mtimeMs: 1, extension: "mp3", title: null, scanId: 1 });
  db.upsertFile({ path: "/b.mp3", size: 200, mtimeMs: 1, extension: "mp3", title: null, scanId: 1 });

  const { total } = db.getSimilarTitleGroups();
  assert.equal(total, 0);
});

test("getSimilarTitleGroups paginates the (post-filter) qualifying groups", (t) => {
  const db = freshDb(t);
  for (let i = 0; i < 3; i += 1) {
    db.upsertFile({ path: `/a${i}.mp3`, size: 100, mtimeMs: 1, extension: "mp3", title: `Title ${i}`, artist: "X", scanId: 1 });
    db.upsertFile({ path: `/b${i}.mp3`, size: 200 + i, mtimeMs: 1, extension: "mp3", title: `Title ${i}`, artist: "X", scanId: 1 });
  }

  const page1 = db.getSimilarTitleGroups({ limit: 2, offset: 0 });
  assert.equal(page1.total, 3);
  assert.equal(page1.groups.length, 2);

  const page2 = db.getSimilarTitleGroups({ limit: 2, offset: 2 });
  assert.equal(page2.groups.length, 1);
});

test("works against a real on-disk file, creating parent directories as needed", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ple-libdb-"));
  const dbPath = path.join(dir, "nested", "library.sqlite3");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const db = openLibraryDb(dbPath);
  db.upsertFile({ path: "/a.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "On Disk", scanId: 1 });
  assert.equal(db.search("Disk").length, 1);
  db.close();

  assert.ok(fs.existsSync(dbPath));
});

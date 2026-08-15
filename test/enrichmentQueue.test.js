const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseFile } = require("music-metadata");

const { openLibraryDb } = require("../src/libraryDb");
const {
  createEnrichmentQueue,
  buildSearchTerm,
  filenameToSearchTerm,
  parseFilenameHints,
  looksLikeGarbage,
  pickBestMatch,
} = require("../src/enrichmentQueue");

const FIXTURES = path.join(__dirname, "fixtures");

function freshDb(t) {
  const db = openLibraryDb(":memory:");
  t.after(() => db.close());
  return db;
}

function fakeItunesResponse(results) {
  return { ok: true, status: 200, json: async () => ({ resultCount: results.length, results }) };
}

function tempCopy(t, fixtureName, destName = fixtureName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ple-enrichqueue-"));
  const dest = path.join(dir, destName);
  fs.copyFileSync(path.join(FIXTURES, fixtureName), dest);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dest;
}

test("filenameToSearchTerm cleans up separator-mangled filenames and strips a leading track number", () => {
  assert.equal(filenameToSearchTerm("/x/01 Don_t Tell Me.mp3"), "Don t Tell Me");
  assert.equal(filenameToSearchTerm("/x/Complicated_-_Avril.mp3"), "Complicated Avril");
  assert.equal(filenameToSearchTerm("/x/already clean.mp3"), "already clean");
});

test("parseFilenameHints strips a leading year+tracknum prefix, a trailing dupe-suffix digit, and pulls out the year", () => {
  const { cleaned, year } = parseFilenameHints(
    "/Volumes/jb/.../Unknown Artist/http___zap.to_canna/1980_02_ANOTHER BRICK IN THE WALL - PINK FLOYD 1.MP3"
  );
  assert.equal(cleaned, "ANOTHER BRICK IN THE WALL PINK FLOYD");
  assert.equal(year, 1980);
});

test("parseFilenameHints leaves an ordinary filename alone (no false-positive stripping)", () => {
  assert.equal(parseFilenameHints("/x/Complicated.mp3").cleaned, "Complicated");
  assert.equal(parseFilenameHints("/x/Complicated.mp3").year, null);
});

test("looksLikeGarbage flags spam/tracker text often found in old rips' artist tags", () => {
  assert.equal(looksLikeGarbage("http://zap.to/canna"), true);
  assert.equal(looksLikeGarbage("rapidshare.com/users/SK01Q6"), true);
  assert.equal(looksLikeGarbage("www.some-scene-group.to"), true);
  assert.equal(looksLikeGarbage(""), true);
  assert.equal(looksLikeGarbage(null), true);
  assert.equal(looksLikeGarbage("Pink Floyd"), false);
});

test("buildSearchTerm prefers a trustworthy artist+title, but falls back to filename hints (+ year) when the artist tag is empty or garbage", () => {
  assert.equal(buildSearchTerm({ artist: "Avril Lavigne", title: "Complicated", path: "/x.mp3" }), "Avril Lavigne Complicated");
  assert.equal(buildSearchTerm({ artist: "Avril Lavigne", title: null, path: "/01_Complicated.mp3" }), "Avril Lavigne Complicated");
  assert.equal(buildSearchTerm({ artist: null, title: null, path: "/01_Complicated.mp3" }), "Complicated");
  assert.equal(
    buildSearchTerm({ artist: "http://zap.to/canna", title: null, path: "/1980_02_ANOTHER BRICK IN THE WALL - PINK FLOYD 1.mp3" }),
    "ANOTHER BRICK IN THE WALL PINK FLOYD 1980"
  );
});

test("pickBestMatch prefers the candidate whose release year is closest to the filename's year hint", () => {
  const row = { artist: null, title: null, path: "/1980_Another Brick In The Wall - Pink Floyd.mp3" };
  const farYear = { artistName: "Pink Floyd", trackName: "Another Brick In The Wall", collectionName: "Live 1994", releaseDate: "1994-01-01" };
  const closeYear = { artistName: "Pink Floyd", trackName: "Another Brick In The Wall", collectionName: "The Wall", releaseDate: "1979-11-30" };
  assert.equal(pickBestMatch(row, [farYear, closeYear]), closeYear);
});

test("a matching result enriches the row and fills in the missing fields", async (t) => {
  const db = freshDb(t);
  const id = db.upsertFile({
    path: "/Avril Lavigne/Unknown Album/01 Complicated.mp3",
    size: 1,
    mtimeMs: 1,
    extension: "mp3",
    artist: "Avril Lavigne",
    title: "Complicated",
    enrichmentStatus: "pending",
    scanId: 1,
  });

  const fetchFn = async () =>
    fakeItunesResponse([
      { artistName: "Avril Lavigne", trackName: "Complicated", collectionName: "Let Go", primaryGenreName: "Pop", releaseDate: "2002-03-11T08:00:00Z" },
    ]);

  const queue = createEnrichmentQueue({ db, fetchFn });
  const result = await queue.processOne();

  assert.equal(result.matched, true);
  const row = db.getFileByPath("/Avril Lavigne/Unknown Album/01 Complicated.mp3");
  assert.equal(row.album, "Let Go");
  assert.equal(row.genre, "Pop");
  assert.equal(row.year, 2002);
  assert.equal(row.enrichment_status, "enriched");
  assert.equal(db.getEnrichmentBacklog(10).length, 0);
});

test("no matching artist in the results marks the row not_found (terminal)", async (t) => {
  const db = freshDb(t);
  db.upsertFile({
    path: "/x.mp3",
    size: 1,
    mtimeMs: 1,
    extension: "mp3",
    artist: "Some Totally Obscure Local Band",
    title: "Untitled Demo",
    enrichmentStatus: "pending",
    scanId: 1,
  });

  const fetchFn = async () =>
    fakeItunesResponse([{ artistName: "A Completely Different Artist", trackName: "Unrelated Song", collectionName: "X" }]);

  const queue = createEnrichmentQueue({ db, fetchFn });
  const result = await queue.processOne();

  assert.equal(result.matched, false);
  assert.equal(db.getStats().enrichmentCounts.not_found, 1);
  assert.equal(db.getEnrichmentBacklog(10).length, 0, "not_found is terminal, must not stay in the backlog");
});

test("a network failure leaves the row pending for a later retry, not falsely terminal", async (t) => {
  const db = freshDb(t);
  db.upsertFile({ path: "/x.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "Song", enrichmentStatus: "pending", scanId: 1 });

  const fetchFn = async () => {
    throw new Error("network blip");
  };

  const queue = createEnrichmentQueue({ db, fetchFn });
  const result = await queue.processOne();

  assert.equal(result.processed, false);
  assert.equal(result.error, "network blip");
  assert.equal(db.getEnrichmentBacklog(10).length, 1, "row must remain pending after a transient failure");
});

test("an HTTP error status also leaves the row pending rather than marking not_found", async (t) => {
  const db = freshDb(t);
  db.upsertFile({ path: "/x.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "Song", enrichmentStatus: "pending", scanId: 1 });

  const fetchFn = async () => ({ ok: false, status: 403, json: async () => ({}) });

  const queue = createEnrichmentQueue({ db, fetchFn });
  await queue.processOne();

  assert.equal(db.getEnrichmentBacklog(10).length, 1);
  assert.equal(db.getStats().enrichmentCounts.not_found || 0, 0);
});

test("getState().lastError clears itself on the next successful search, rather than showing a transient hiccup forever", async (t) => {
  const db = freshDb(t);
  db.upsertFile({ path: "/x.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "Song A", enrichmentStatus: "pending", scanId: 1 });
  db.upsertFile({ path: "/y.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "Song B", enrichmentStatus: "pending", scanId: 1 });

  let call = 0;
  const fetchFn = async () => {
    call += 1;
    if (call === 1) throw new Error("network blip");
    return fakeItunesResponse([]);
  };

  const queue = createEnrichmentQueue({ db, fetchFn });
  await queue.processOne();
  assert.equal(queue.getState().lastError, "network blip");

  await queue.processOne();
  assert.equal(queue.getState().lastError, null, "a later successful search must clear the earlier error");
});

test("a well-tagged (skipped_had_tags) row is never passed to fetch at all", async (t) => {
  const db = freshDb(t);
  db.upsertFile({
    path: "/well-tagged.mp3",
    size: 1,
    mtimeMs: 1,
    extension: "mp3",
    title: "Song",
    artist: "Artist",
    album: "Album",
    genre: "Genre",
    enrichmentStatus: "skipped_had_tags",
    scanId: 1,
  });

  let called = false;
  const fetchFn = async () => {
    called = true;
    return fakeItunesResponse([]);
  };

  const queue = createEnrichmentQueue({ db, fetchFn });
  const result = await queue.processOne();

  assert.equal(result.processed, false, "nothing in the backlog to process");
  assert.equal(called, false);
});

test("processOne is a no-op with an empty backlog", async (t) => {
  const db = freshDb(t);
  let called = false;
  const queue = createEnrichmentQueue({ db, fetchFn: async () => ((called = true), fakeItunesResponse([])) });
  const result = await queue.processOne();
  assert.equal(result.processed, false);
  assert.equal(called, false);
});

test("getState reports backlog size and running totals", async (t) => {
  const db = freshDb(t);
  db.upsertFile({ path: "/a.mp3", size: 1, mtimeMs: 1, extension: "mp3", enrichmentStatus: "pending", scanId: 1 });
  db.upsertFile({ path: "/b.mp3", size: 1, mtimeMs: 1, extension: "mp3", enrichmentStatus: "pending", scanId: 1 });

  const fetchFn = async () => fakeItunesResponse([{ artistName: "X", trackName: "Y" }]);
  const queue = createEnrichmentQueue({ db, fetchFn });

  assert.equal(queue.getState().backlogSize, 2);
  await queue.processOne();
  assert.equal(queue.getState().backlogSize, 1);
  assert.equal(queue.getState().processed, 1);
});

test("getState reports the configured pace, so clients can compute an ETA", (t) => {
  const db = freshDb(t);
  const queue = createEnrichmentQueue({ db, fetchFn: async () => fakeItunesResponse([]), intervalMs: 2500 });
  assert.equal(queue.getState().intervalMs, 2500);
});

test("a successful match is actually written into the file on disk, not just the index", async (t) => {
  const db = freshDb(t);
  const filePath = tempCopy(t, "untagged.mp3");
  db.upsertFile({
    path: filePath,
    size: 1,
    mtimeMs: 1,
    extension: "mp3",
    artist: "Avril Lavigne",
    title: "Complicated",
    enrichmentStatus: "pending",
    scanId: 1,
  });

  const fetchFn = async () =>
    fakeItunesResponse([{ artistName: "Avril Lavigne", trackName: "Complicated", collectionName: "Let Go", primaryGenreName: "Pop" }]);

  const queue = createEnrichmentQueue({ db, fetchFn });
  await queue.processOne();

  const row = db.getFileByPath(filePath);
  assert.equal(row.enrichment_status, "enriched");
  assert.equal(row.tag_write_status, "written");

  // Artist/title were already set on the row (used to trigger a direct
  // match above) so writeTagsForRow correctly leaves them alone — album is
  // the field that was actually empty going in, so it's the one that
  // proves the result landed in the file's own tags, not just the index.
  const onDisk = await parseFile(filePath);
  assert.equal(onDisk.common.album, "Let Go", "the enrichment result must land in the file's own tags");
});

test("a write-back failure is tracked (tag_write_status='failed') without crashing the queue or losing the index match", async (t) => {
  const db = freshDb(t);
  // A path that doesn't exist on disk — the search succeeds, the write can't.
  db.upsertFile({
    path: "/nonexistent/dir/track.mp3",
    size: 1,
    mtimeMs: 1,
    extension: "mp3",
    artist: "X",
    title: "Y",
    enrichmentStatus: "pending",
    scanId: 1,
  });

  // collectionName gives writeTagsForRow an actually-missing field (album)
  // to attempt writing — title/artist alone would resolve to "nothing to
  // write" and never touch the filesystem at all.
  const fetchFn = async () => fakeItunesResponse([{ artistName: "X", trackName: "Y", collectionName: "Z" }]);
  const queue = createEnrichmentQueue({ db, fetchFn });
  const result = await queue.processOne();

  assert.equal(result.matched, true);
  const row = db.getFileByPath("/nonexistent/dir/track.mp3");
  assert.equal(row.enrichment_status, "enriched", "the index match is kept even though the file write failed");
  assert.equal(row.tag_write_status, "failed");
  assert.match(queue.getState().lastError, /Tag write-back failed/);
  assert.equal(queue.getState().tagWriteFailures, 1);
});

test("retryFailedWrites re-reads the file fresh and succeeds once the file is actually writable, without another API call", async (t) => {
  const db = freshDb(t);
  const filePath = tempCopy(t, "untagged.mp3");
  const id = db.upsertFile({ path: filePath, size: 1, mtimeMs: 1, extension: "mp3", enrichmentStatus: "pending", scanId: 1 });

  let searchCalls = 0;
  const fetchFn = async () => {
    searchCalls += 1;
    return fakeItunesResponse([{ artistName: "Avril Lavigne", trackName: "Complicated", collectionName: "Let Go" }]);
  };
  const queue = createEnrichmentQueue({ db, fetchFn });

  // Simulate a write that failed even though the row (from an earlier
  // successful lookup) already holds the right target metadata.
  db.markEnriched(id, { title: "Complicated", artist: "Avril Lavigne", album: "Let Go", genre: "Pop", year: 2002 });
  db.setTagWriteStatus(id, "failed");

  const summary = await queue.retryFailedWrites();
  assert.deepEqual(summary, { attempted: 1, written: 1, stillFailed: 0 });
  assert.equal(searchCalls, 0, "retrying a write must never repeat the iTunes lookup");

  const row = db.getFileByPath(filePath);
  assert.equal(row.tag_write_status, "written");
  const onDisk = await parseFile(filePath);
  assert.equal(onDisk.common.artist, "Avril Lavigne");
});

test("retryFailedWrites leaves a vanished file as still-failed rather than throwing", async (t) => {
  const db = freshDb(t);
  const id = db.upsertFile({
    path: "/gone/track.mp3",
    size: 1,
    mtimeMs: 1,
    extension: "mp3",
    enrichmentStatus: "enriched",
    scanId: 1,
  });
  db.setTagWriteStatus(id, "failed");

  const queue = createEnrichmentQueue({ db, fetchFn: async () => fakeItunesResponse([]) });
  const summary = await queue.retryFailedWrites();

  assert.deepEqual(summary, { attempted: 1, written: 0, stillFailed: 1 });
  assert.equal(db.getFileByPath("/gone/track.mp3").tag_write_status, "failed");
});

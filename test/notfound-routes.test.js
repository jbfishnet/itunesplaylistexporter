// Covers DELETE /api/library/not-found-files/:id — the Not Found tab's
// per-track/multiselect delete, added because unlike the Duplicates tab
// there's no confirmed second copy backing the deletion, so it moves the
// file to the actual Trash (via src/fileTrash.js) rather than unlinking it
// outright. Real Finder automation needs Automation/TCC consent no CI
// runner has, so this points PLE_TEST_FILE_TRASH at a fake that still
// really removes the file from its original path (just not via Finder),
// which is what these tests need to assert against.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FIXTURES = path.join(__dirname, "fixtures");
const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-notfound-root-"));
const dbPath = path.join(os.tmpdir(), `ple-notfound-test-${Date.now()}.sqlite3`);

process.env.PORT = process.env.PORT || "4201";
process.env.PLE_NO_OPEN = "1";
process.env.PLE_LIBRARY_ROOT = libraryRoot;
process.env.PLE_LIBRARY_DB = dbPath;
process.env.PLE_TEST_FILE_TRASH = path.join(__dirname, "fixtures", "fakeFileTrash.js");
const server = require("../server");
const { openLibraryDb } = require("../src/libraryDb");
const fakeFileTrash = require("./fixtures/fakeFileTrash");

const BASE_URL = `http://localhost:${process.env.PORT}`;

/** Seeds a row directly as terminal enrichment_status='not_found' — bypasses
 * the real scan-then-fail-lookup flow (which needs a live network call)
 * entirely, the same way other route tests seed state that would otherwise
 * require driving a background process. No rescan happens during this file's
 * run (the library root is empty and nothing triggers one), so a direct seed
 * like this isn't at risk of being overwritten by the scanner mid-test. */
function seedNotFoundFile(name) {
  const filePath = path.join(libraryRoot, name);
  fs.writeFileSync(filePath, `fake-content-${name}`);
  const db = openLibraryDb(dbPath);
  const id = db.upsertFile({
    path: filePath,
    size: fs.statSync(filePath).size,
    mtimeMs: Date.now(),
    extension: "mp3",
    title: null,
    artist: null,
    enrichmentStatus: "not_found",
    scanId: 1,
  });
  db.close();
  return { id, filePath };
}

/** Seeds a not_found row backed by a real (parseable) MP3 fixture, for the
 * manual-metadata tests — writeTagsOverwrite really writes ID3 tags via
 * node-id3, which needs actual MP3 file structure, unlike the delete tests
 * above where the file's content is irrelevant. */
function seedNotFoundFileFromFixture(destName, seedFields = {}) {
  const filePath = path.join(libraryRoot, destName);
  fs.copyFileSync(path.join(FIXTURES, "untagged.mp3"), filePath);
  const db = openLibraryDb(dbPath);
  const id = db.upsertFile({
    path: filePath,
    size: fs.statSync(filePath).size,
    mtimeMs: Date.now(),
    extension: "mp3",
    title: null,
    artist: null,
    album: null,
    genre: null,
    enrichmentStatus: "not_found",
    scanId: 1,
    ...seedFields,
  });
  db.close();
  return { id, filePath };
}

test.after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(libraryRoot, { recursive: true, force: true });
  fs.rmSync(dbPath, { force: true });
});

test.beforeEach(() => fakeFileTrash.__reset());

test("DELETE /api/library/not-found-files/:id moves the file to the Trash and removes it from the index", async () => {
  const { id, filePath } = seedNotFoundFile("gone1.mp3");
  assert.ok(fs.existsSync(filePath));

  const res = await fetch(`${BASE_URL}/api/library/not-found-files/${id}`, { method: "DELETE" });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.deleted, true);
  assert.equal(fs.existsSync(filePath), false, "file must actually be gone");
  assert.deepEqual(fakeFileTrash.__calls, [filePath]);

  const browseRes = await fetch(`${BASE_URL}/api/library/browse?status=not_found`);
  const browseData = await browseRes.json();
  assert.ok(!browseData.rows.some((r) => r.id === id), "deleted row must be gone from the index");
});

test("DELETE /api/library/not-found-files/:id refuses a file that isn't in the Not Found list", async () => {
  const filePath = path.join(libraryRoot, "enriched.mp3");
  fs.writeFileSync(filePath, "fake-content-enriched");
  const db = openLibraryDb(dbPath);
  const id = db.upsertFile({
    path: filePath,
    size: fs.statSync(filePath).size,
    mtimeMs: Date.now(),
    extension: "mp3",
    title: "A Real Song",
    artist: "A Real Artist",
    album: "A Real Album",
    genre: "Rock",
    enrichmentStatus: "skipped_had_tags",
    scanId: 1,
  });
  db.close();

  const res = await fetch(`${BASE_URL}/api/library/not-found-files/${id}`, { method: "DELETE" });
  assert.equal(res.status, 409);
  assert.ok(fs.existsSync(filePath), "file must survive — it was never eligible for this route");
  assert.equal(fakeFileTrash.__calls.length, 0);
});

test("DELETE /api/library/not-found-files/:id 404s for an unknown id", async () => {
  const res = await fetch(`${BASE_URL}/api/library/not-found-files/999999999`, { method: "DELETE" });
  assert.equal(res.status, 404);
});

test("multiselect flow: several Not Found files delete in sequence, none blocking the others", async () => {
  const seeded = [seedNotFoundFile("bulk1.mp3"), seedNotFoundFile("bulk2.mp3"), seedNotFoundFile("bulk3.mp3")];

  let failed = 0;
  for (const { id } of seeded) {
    const res = await fetch(`${BASE_URL}/api/library/not-found-files/${id}`, { method: "DELETE" });
    if (!res.ok) failed += 1;
  }
  assert.equal(failed, 0);

  for (const { filePath } of seeded) {
    assert.equal(fs.existsSync(filePath), false);
  }
  assert.equal(fakeFileTrash.__calls.length, 3);
});

test("POST manual-metadata: fills in the blank tags on disk and requeues the row for another lookup", async () => {
  const { id, filePath } = seedNotFoundFileFromFixture("manual1.mp3");

  const res = await fetch(`${BASE_URL}/api/library/not-found-files/manual-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id], metadata: { title: "Corrected Title", artist: "Corrected Artist" } }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(data.appliedFields, ["title", "artist"]);
  assert.equal(data.results[0].ok, true);
  assert.equal(data.results[0].written, true);

  const browseRes = await fetch(`${BASE_URL}/api/library/browse?title=${encodeURIComponent("Corrected Title")}`);
  const browseData = await browseRes.json();
  const row = browseData.rows.find((r) => r.id === id);
  assert.ok(row, "the row must be found by its new title");
  assert.equal(row.artist, "Corrected Artist");
  assert.equal(row.enrichmentStatus, "pending", "must be requeued for another lookup, not left terminal");

  const { parseFile } = require("music-metadata");
  const onDisk = await parseFile(filePath);
  assert.equal(onDisk.common.title, "Corrected Title", "the file's own tag must be updated, not just the index");
  assert.equal(onDisk.common.artist, "Corrected Artist");
});

test("POST manual-metadata: overwrites an existing (wrong) value without asking — unlike enrichment's fill-only-if-empty rule", async () => {
  const { id } = seedNotFoundFileFromFixture("manual2.mp3", { artist: "Definitely Wrong Artist" });

  const res = await fetch(`${BASE_URL}/api/library/not-found-files/manual-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id], metadata: { artist: "The Real Artist" } }),
  });
  assert.equal(res.status, 200);

  const browseRes = await fetch(`${BASE_URL}/api/library/browse?artist=${encodeURIComponent("The Real Artist")}`);
  const browseData = await browseRes.json();
  assert.ok(browseData.rows.some((r) => r.id === id), "the wrong existing value must be overwritten, not preserved");
});

test("POST manual-metadata: a blank field in the form is left untouched, not cleared", async () => {
  const { id } = seedNotFoundFileFromFixture("manual3.mp3", { album: "Keep This Album" });

  await fetch(`${BASE_URL}/api/library/not-found-files/manual-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id], metadata: { artist: "New Artist", album: "" } }),
  });

  const browseRes = await fetch(`${BASE_URL}/api/library/browse?artist=${encodeURIComponent("New Artist")}`);
  const browseData = await browseRes.json();
  const row = browseData.rows.find((r) => r.id === id);
  assert.equal(row.album, "Keep This Album", "blank 'album' in the request must not clear the existing value");
});

test("POST manual-metadata: multiselect applies the same field values to every selected track", async () => {
  const a = seedNotFoundFileFromFixture("multi-a.mp3");
  const b = seedNotFoundFileFromFixture("multi-b.mp3");
  const c = seedNotFoundFileFromFixture("multi-c.mp3");

  const res = await fetch(`${BASE_URL}/api/library/not-found-files/manual-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [a.id, b.id, c.id], metadata: { album: "Shared Album", genre: "Rock" } }),
  });
  const data = await res.json();
  assert.equal(data.requeued, 3);

  for (const { id } of [a, b, c]) {
    const browseRes = await fetch(`${BASE_URL}/api/library/browse?album=${encodeURIComponent("Shared Album")}`);
    const browseData = await browseRes.json();
    const row = browseData.rows.find((r) => r.id === id);
    assert.ok(row, `track ${id} must have the shared album applied`);
    assert.equal(row.genre, "Rock");
  }
});

test("POST manual-metadata: rejects an empty ids array and an all-blank metadata object", async () => {
  const emptyIds = await fetch(`${BASE_URL}/api/library/not-found-files/manual-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [], metadata: { title: "X" } }),
  });
  assert.equal(emptyIds.status, 400);

  const { id } = seedNotFoundFileFromFixture("manual4.mp3");
  const blankFields = await fetch(`${BASE_URL}/api/library/not-found-files/manual-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id], metadata: { title: "", artist: "  " } }),
  });
  assert.equal(blankFields.status, 400);
});

test("POST manual-metadata: skips (doesn't error the whole batch for) a track no longer in the Not Found list", async () => {
  const stillNotFound = seedNotFoundFileFromFixture("manual5.mp3");
  const alreadyEnriched = seedNotFoundFileFromFixture("manual6.mp3", { enrichmentStatus: "skipped_had_tags" });

  const res = await fetch(`${BASE_URL}/api/library/not-found-files/manual-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [stillNotFound.id, alreadyEnriched.id], metadata: { artist: "Batch Artist" } }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);

  const okResult = data.results.find((r) => r.id === stillNotFound.id);
  const skippedResult = data.results.find((r) => r.id === alreadyEnriched.id);
  assert.equal(okResult.ok, true);
  assert.equal(skippedResult.ok, false);
  assert.equal(data.requeued, 1);
});

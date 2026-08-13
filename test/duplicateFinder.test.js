const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { openLibraryDb } = require("../src/libraryDb");
const { createDuplicateFinder, hashFile } = require("../src/duplicateFinder");

const FIXTURES = path.join(__dirname, "fixtures");

function freshDb(t) {
  const db = openLibraryDb(":memory:");
  t.after(() => db.close());
  return db;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ple-dupfinder-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a file with a unique size is settled as 'not_needed' without ever being read", async (t) => {
  const db = freshDb(t);
  const dir = tempDir(t);
  const filePath = path.join(dir, "unique.mp3");
  fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), filePath);
  const size = fs.statSync(filePath).size;

  db.upsertFile({ path: filePath, size, mtimeMs: 1, extension: "mp3", scanId: 1 });

  const finder = createDuplicateFinder({ db, batchSize: 10 });
  await finder.processBatch();

  const row = db.getFileByPath(filePath);
  assert.equal(row.hash_status, "not_needed");
  assert.equal(row.content_hash, null);
  assert.equal(finder.getState().skipped, 1);
  assert.equal(finder.getState().hashed, 0);
});

test("two byte-identical files sharing a size both get hashed and land in the same duplicate group", async (t) => {
  const db = freshDb(t);
  const dir = tempDir(t);
  const pathA = path.join(dir, "a.mp3");
  const pathB = path.join(dir, "b.mp3");
  fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), pathA);
  fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), pathB);
  const size = fs.statSync(pathA).size;

  db.upsertFile({ path: pathA, size, mtimeMs: 1, extension: "mp3", title: "Copy A", scanId: 1 });
  db.upsertFile({ path: pathB, size, mtimeMs: 1, extension: "mp3", title: "Copy B", scanId: 1 });

  const finder = createDuplicateFinder({ db, batchSize: 10 });
  await finder.processBatch();

  const rowA = db.getFileByPath(pathA);
  const rowB = db.getFileByPath(pathB);
  assert.equal(rowA.hash_status, "done");
  assert.equal(rowB.hash_status, "done");
  assert.equal(rowA.content_hash, rowB.content_hash, "byte-identical files must hash identically");
  assert.equal(finder.getState().hashed, 2);

  const { groups, total } = db.getDuplicateGroups();
  assert.equal(total, 1);
  assert.equal(groups[0].fileCount, 2);
  assert.deepEqual(groups[0].files.map((f) => f.title).sort(), ["Copy A", "Copy B"]);
});

test("two files with the same size but different content are hashed but never grouped as duplicates", async (t) => {
  const db = freshDb(t);
  const dir = tempDir(t);
  const pathA = path.join(dir, "a.mp3");
  const pathB = path.join(dir, "b.mp3");
  // tagged.mp3 and retagged.mp3 are same-ish size fixtures with different content
  fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), pathA);
  const contentA = fs.readFileSync(pathA);
  fs.writeFileSync(pathB, Buffer.concat([contentA.slice(1), contentA.slice(0, 1)])); // same size, different bytes

  const size = fs.statSync(pathA).size;
  db.upsertFile({ path: pathA, size, mtimeMs: 1, extension: "mp3", scanId: 1 });
  db.upsertFile({ path: pathB, size, mtimeMs: 1, extension: "mp3", scanId: 1 });

  const finder = createDuplicateFinder({ db, batchSize: 10 });
  await finder.processBatch();

  const { total } = db.getDuplicateGroups();
  assert.equal(total, 0, "same size but different bytes must not be flagged as duplicates");
});

test("an unreadable/vanished candidate is settled as 'error' instead of blocking the rest of the batch forever", async (t) => {
  const db = freshDb(t);
  const dir = tempDir(t);
  const missingPath = path.join(dir, "gone.mp3");
  const realPathA = path.join(dir, "a.mp3");
  const realPathB = path.join(dir, "b.mp3");
  fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), realPathA);
  fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), realPathB);
  const size = fs.statSync(realPathA).size;

  // A row referencing a file that no longer exists, but sized to collide
  // with the two real duplicates so it actually reaches the hashing step.
  db.upsertFile({ path: missingPath, size, mtimeMs: 1, extension: "mp3", scanId: 1 });
  db.upsertFile({ path: realPathA, size, mtimeMs: 1, extension: "mp3", scanId: 1 });
  db.upsertFile({ path: realPathB, size, mtimeMs: 1, extension: "mp3", scanId: 1 });

  const finder = createDuplicateFinder({ db, batchSize: 10 });
  const result = await finder.processBatch();

  assert.equal(result.processed, true);
  assert.equal(db.getFileByPath(missingPath).hash_status, "error");
  assert.equal(db.getFileByPath(realPathA).hash_status, "done");
  assert.equal(db.getFileByPath(realPathB).hash_status, "done");
  assert.equal(finder.getState().errors, 1);
  assert.equal(finder.getState().hashed, 2);
});

test("hashFile produces a stable sha256 for real file content", async (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "x.mp3");
  fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), filePath);
  const h1 = await hashFile(filePath);
  const h2 = await hashFile(filePath);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

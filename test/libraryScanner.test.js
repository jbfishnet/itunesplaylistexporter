const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { openLibraryDb } = require("../src/libraryDb");
const { runScan } = require("../src/libraryScanner");
const { readTags } = require("../src/tagReader");

const FIXTURES_DIR = path.join(__dirname, "fixtures");

function spyReadTags() {
  let calls = 0;
  const fn = async (filePath) => {
    calls += 1;
    return readTags(filePath);
  };
  fn.callCount = () => calls;
  return fn;
}

function makeLibrary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ple-scan-lib-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, "Artist A", "Album One"), { recursive: true });
  fs.mkdirSync(path.join(root, "Artist B", "Unknown Album"), { recursive: true });

  fs.copyFileSync(path.join(FIXTURES_DIR, "tagged.mp3"), path.join(root, "Artist A", "Album One", "01 Tagged.mp3"));
  fs.copyFileSync(
    path.join(FIXTURES_DIR, "untagged.mp3"),
    path.join(root, "Artist B", "Unknown Album", "Sparse Track.mp3")
  );
  // A non-audio file sitting alongside — must be ignored entirely.
  fs.writeFileSync(path.join(root, "Artist A", "Album One", "cover.jpg"), "not audio");

  const db = openLibraryDb(":memory:");
  t.after(() => db.close());

  return { root, db };
}

function makeSecondLibrary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ple-scan-lib2-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "Artist C"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "tagged.m4a"), path.join(root, "Artist C", "01 Tagged.m4a"));
  return root;
}

test("first scan indexes every audio file as new, ignoring non-audio files", async (t) => {
  const { root, db } = makeLibrary(t);
  const result = await runScan({ roots: [root], db, readTags: spyReadTags() });

  assert.equal(result.result, "ok");
  assert.equal(result.filesTotal, 2, "cover.jpg must not be counted");
  assert.equal(result.filesNew, 2);
  assert.equal(result.filesRemoved, 0);
  assert.equal(db.getStats().totalFiles, 2);

  const tagged = db.getFileByPath(path.join(root, "Artist A", "Album One", "01 Tagged.mp3"));
  assert.equal(tagged.title, "Test Track");
  assert.equal(tagged.enrichment_status, "skipped_had_tags", "fully-tagged file should not need enrichment");

  const sparse = db.getFileByPath(path.join(root, "Artist B", "Unknown Album", "Sparse Track.mp3"));
  assert.equal(sparse.title, null);
  assert.equal(sparse.enrichment_status, "pending", "untagged file should be queued for enrichment");
});

test("a second scan with no changes on disk re-tags nothing", async (t) => {
  const { root, db } = makeLibrary(t);
  await runScan({ roots: [root], db, readTags: spyReadTags() });

  const spy = spyReadTags();
  const result = await runScan({ roots: [root], db, readTags: spy });

  assert.equal(result.filesNew, 0);
  assert.equal(result.filesChanged, 0);
  assert.equal(result.filesUnchanged, 2);
  assert.equal(spy.callCount(), 0, "unchanged files must not be re-parsed");
  assert.equal(db.getStats().totalFiles, 2);
});

test("a modified file is re-tagged; everything else is left alone", async (t) => {
  const { root, db } = makeLibrary(t);
  await runScan({ roots: [root], db, readTags: spyReadTags() });

  const taggedPath = path.join(root, "Artist A", "Album One", "01 Tagged.mp3");
  // Replace its content (same format, different size/tags) simulating a real edit.
  fs.copyFileSync(path.join(FIXTURES_DIR, "retagged.mp3"), taggedPath);
  fs.utimesSync(taggedPath, new Date(), new Date(Date.now() + 5000));

  const spy = spyReadTags();
  const result = await runScan({ roots: [root], db, readTags: spy });

  assert.equal(result.filesChanged, 1);
  assert.equal(result.filesUnchanged, 1);
  assert.equal(spy.callCount(), 1, "only the modified file should be re-parsed");

  const updated = db.getFileByPath(taggedPath);
  assert.equal(updated.title, "Retagged Track", "row should reflect the new file's tags");
});

test("a file deleted from disk is removed from the index on the next scan", async (t) => {
  const { root, db } = makeLibrary(t);
  await runScan({ roots: [root], db, readTags: spyReadTags() });
  assert.equal(db.getStats().totalFiles, 2);

  fs.rmSync(path.join(root, "Artist B", "Unknown Album", "Sparse Track.mp3"));

  const result = await runScan({ roots: [root], db, readTags: spyReadTags() });
  assert.equal(result.filesRemoved, 1);
  assert.equal(db.getStats().totalFiles, 1);
  assert.equal(db.search("Sparse").length, 0);
});

test("a missing/unmounted root leaves a pre-seeded index completely untouched", async (t) => {
  const db = openLibraryDb(":memory:");
  t.after(() => db.close());

  db.upsertFile({ path: "/pretend/track.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "Untouched", scanId: 1 });

  const result = await runScan({ roots: ["/definitely/does/not/exist/anywhere"], db, readTags: spyReadTags() });

  assert.equal(result.result, "root_missing");
  assert.equal(db.getStats().totalFiles, 1, "index must not be wiped just because the NAS wasn't mounted");
  assert.equal(db.search("Untouched").length, 1);
});

test("a subdirectory read error skips the deletion sweep instead of wiping matching rows", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ple-scan-err-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unreadableDir = path.join(root, "Locked");
  fs.mkdirSync(unreadableDir);
  fs.copyFileSync(path.join(FIXTURES_DIR, "tagged.mp3"), path.join(unreadableDir, "song.mp3"));

  const db = openLibraryDb(":memory:");
  t.after(() => db.close());
  await runScan({ roots: [root], db, readTags: spyReadTags() });
  assert.equal(db.getStats().totalFiles, 1);

  fs.chmodSync(unreadableDir, 0o000);

  const result = await runScan({ roots: [root], db, readTags: spyReadTags() });

  // Restore permissions immediately (before any cleanup hooks run, regardless
  // of their registration order) so the root temp dir can actually be removed.
  fs.chmodSync(unreadableDir, 0o755);

  assert.equal(result.result, "error");
  assert.ok(result.errors.length > 0);
  assert.equal(db.getStats().totalFiles, 1, "row for the now-unreadable file must survive, not be swept as deleted");
});

test("scanning multiple roots combines files from all of them into one index, sharing a single scanId", async (t) => {
  const { root: rootA, db } = makeLibrary(t);
  const rootB = makeSecondLibrary(t);

  const result = await runScan({ roots: [rootA, rootB], db, readTags: spyReadTags() });

  assert.equal(result.result, "ok");
  assert.equal(result.filesTotal, 3, "2 files from root A + 1 from root B");
  assert.equal(db.getStats().totalFiles, 3);
  assert.ok(db.getFileByPath(path.join(rootB, "Artist C", "01 Tagged.m4a")), "root B's file must be indexed too");
});

test("one root missing while another is healthy still indexes the healthy one, but skips the deletion sweep entirely", async (t) => {
  const { root: rootA, db } = makeLibrary(t);
  await runScan({ roots: [rootA], db, readTags: spyReadTags() });

  const rootB = makeSecondLibrary(t);
  const missingRoot = "/definitely/does/not/exist/anywhere";

  // Also delete a file from rootA — if the sweep ran, this would remove it.
  fs.rmSync(path.join(rootA, "Artist B", "Unknown Album", "Sparse Track.mp3"));

  const result = await runScan({ roots: [rootA, rootB, missingRoot], db, readTags: spyReadTags() });

  assert.equal(result.result, "partial_root_missing");
  assert.ok(db.getFileByPath(path.join(rootB, "Artist C", "01 Tagged.m4a")), "the healthy new root must still get indexed");
  assert.ok(
    db.getFileByPath(path.join(rootA, "Artist B", "Unknown Album", "Sparse Track.mp3")),
    "deletion sweep must be skipped for the WHOLE cycle, not just the missing root's files"
  );
});

test("an empty roots list leaves a pre-seeded index completely untouched (must not sweep everything as 'unseen')", async (t) => {
  const db = openLibraryDb(":memory:");
  t.after(() => db.close());
  db.upsertFile({ path: "/pretend/track.mp3", size: 1, mtimeMs: 1, extension: "mp3", title: "Untouched", scanId: 1 });

  const result = await runScan({ roots: [], db, readTags: spyReadTags() });

  assert.equal(result.result, "no_roots_configured");
  assert.equal(result.filesRemoved, 0);
  assert.equal(db.getStats().totalFiles, 1, "no configured roots must never be treated as 'everything was deleted'");
});

test("removing a root from the list causes its files to be swept on the next (all-healthy) scan", async (t) => {
  const { root: rootA, db } = makeLibrary(t);
  const rootB = makeSecondLibrary(t);
  await runScan({ roots: [rootA, rootB], db, readTags: spyReadTags() });
  assert.equal(db.getStats().totalFiles, 3);

  // rootB is no longer configured at all (simulating the user removing it
  // from Library Folders) — scan only rootA from now on.
  const result = await runScan({ roots: [rootA], db, readTags: spyReadTags() });

  assert.equal(result.result, "ok");
  assert.equal(db.getStats().totalFiles, 2, "files under the removed root should be swept, same as any deleted file");
  assert.equal(db.getFileByPath(path.join(rootB, "Artist C", "01 Tagged.m4a")), undefined);
});

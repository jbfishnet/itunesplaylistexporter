const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { openLibraryDb } = require("../src/libraryDb");
const { createScheduler } = require("../src/libraryScheduler");

const FIXTURES_DIR = path.join(__dirname, "fixtures");

function makeRoot(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ple-sched-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.join(FIXTURES_DIR, "tagged.mp3"), path.join(root, "song.mp3"));
  return root;
}

async function waitUntilIdle(scheduler) {
  for (let i = 0; i < 200; i += 1) {
    if (!scheduler.getState().running) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("scheduler never went idle");
}

test("the scheduler reads the CURRENT library roots from the db on every run, not a fixed value from creation time", async (t) => {
  const db = openLibraryDb(":memory:");
  t.after(() => db.close());
  const rootA = makeRoot(t, "a");
  const rootB = makeRoot(t, "b");

  db.setLibraryRoots([rootA]);
  const scheduler = createScheduler({ db, intervalMs: 60_000 });
  t.after(() => scheduler.stop());

  scheduler.triggerNow();
  await waitUntilIdle(scheduler);
  assert.equal(db.getStats().totalFiles, 1, "only rootA was configured for this run");

  // Add a second root *after* the scheduler already exists — no restart.
  db.setLibraryRoots([rootA, rootB]);
  scheduler.triggerNow();
  await waitUntilIdle(scheduler);

  assert.equal(db.getStats().totalFiles, 2, "the newly-added root must be picked up on the very next run");
});

test("with no library roots configured yet, the scheduler runs without crashing and indexes nothing", async (t) => {
  const db = openLibraryDb(":memory:");
  t.after(() => db.close());
  // getLibraryRoots() returns null when never set — the scheduler must treat that as "nothing to scan," not throw.

  const scheduler = createScheduler({ db, intervalMs: 60_000 });
  t.after(() => scheduler.stop());

  scheduler.triggerNow();
  await waitUntilIdle(scheduler);

  assert.equal(db.getStats().totalFiles, 0);
  assert.equal(scheduler.getState().lastResult.result, "no_roots_configured");
});

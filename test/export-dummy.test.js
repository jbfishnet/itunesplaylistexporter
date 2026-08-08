// End-to-end test of the export pipeline against a fabricated "library" —
// no Music.app / AppleScript involved. This is the "dummy export to a local
// folder" smoke test: fake dummy source files stand in for real tracks, and
// everything is copied into a throwaway destination folder.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const exporter = require("../src/exporter");
const { sanitizeSegment } = exporter;

function makeDummySourceFile(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function waitForJobDone(job, timeoutMs = 5000) {
  if (job.done) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Export job did not finish in time")), timeoutMs);
    const onEvent = (event) => {
      if (event.type === "done") {
        clearTimeout(timer);
        job.emitter.off("event", onEvent);
        resolve();
      }
    };
    job.emitter.on("event", onEvent);
  });
}

test("dummy export: copies ready tracks, skips protected/missing, resolves collisions, reports a mid-copy failure", async (t) => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ple-dummy-source-"));
  const destRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-dummy-dest-"));
  t.after(() => {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(destRoot, { recursive: true, force: true });
  });

  const fileA = makeDummySourceFile(sourceDir, "a.m4a", "dummy-audio-A");
  const fileB = makeDummySourceFile(sourceDir, "b.m4a", "dummy-audio-B");
  const fileC = makeDummySourceFile(sourceDir, "c.mp3", "dummy-audio-C");
  // Deliberately never created: simulates a track that looked "ready" during
  // preview but whose file vanished (e.g. NAS unmounted) by export time.
  const vanishedPath = path.join(sourceDir, "does-not-exist.m4a");

  const playlistName = 'Dummy Test: "Summer" / Mix?';
  const tracks = [
    { position: 1, title: "Duplicate", location: fileA, extension: "m4a", status: "ready" },
    { position: 1, title: "Duplicate", location: fileB, extension: "m4a", status: "ready" }, // same name -> collision
    { position: 2, title: "Second Song", location: fileC, extension: "mp3", status: "ready" },
    { position: 3, title: "Old Purchase", location: null, extension: "m4p", status: "protected" }, // must be skipped
    { position: 4, title: "Cloud Only", location: null, extension: null, status: "missing" }, // must be skipped
    { position: 5, title: "Vanished", location: vanishedPath, extension: "m4a", status: "ready" }, // copy fails
  ];

  const jobId = exporter.startExportJob({
    playlists: [{ name: playlistName, tracks }],
    destinationRoot: destRoot,
  });

  const job = exporter.getJob(jobId);
  assert.ok(job, "job should be registered immediately");
  await waitForJobDone(job);

  const fileEvents = job.events.filter((e) => e.type === "file");
  const doneEvent = job.events.find((e) => e.type === "done");

  // Only the 4 "ready" tracks are queued; protected/missing never appear.
  assert.equal(fileEvents.length, 4);
  assert.equal(doneEvent.total, 4);
  assert.equal(doneEvent.copied, 3);
  assert.equal(doneEvent.failed, 1);

  assert.deepEqual(
    fileEvents.map((e) => e.ok),
    [true, true, true, false]
  );

  const failedEvent = fileEvents[3];
  assert.equal(failedEvent.fileName, "Vanished");
  assert.ok(failedEvent.error && failedEvent.error.length > 0, "failed event should carry a reason");

  const destDir = path.join(destRoot, sanitizeSegment(playlistName));
  const written = fs.readdirSync(destDir).sort();
  assert.deepEqual(written, ["01 - Duplicate (2).m4a", "01 - Duplicate.m4a", "02 - Second Song.mp3"]);

  // The right source content landed under the right (collision-resolved) name.
  assert.equal(fs.readFileSync(path.join(destDir, "01 - Duplicate.m4a"), "utf8"), "dummy-audio-A");
  assert.equal(fs.readFileSync(path.join(destDir, "01 - Duplicate (2).m4a"), "utf8"), "dummy-audio-B");
  assert.equal(fs.readFileSync(path.join(destDir, "02 - Second Song.mp3"), "utf8"), "dummy-audio-C");

  // Nothing named after the protected/missing/vanished tracks was ever created.
  written.forEach((name) => {
    assert.ok(!name.includes("Old Purchase"));
    assert.ok(!name.includes("Cloud Only"));
    assert.ok(!name.includes("Vanished"));
  });
});

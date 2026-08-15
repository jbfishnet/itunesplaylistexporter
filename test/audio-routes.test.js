// Covers the two audio-preview endpoints added for the "play button next to
// every title" feature: /api/audio (path-based, for Music.app playlist
// tracks) and /api/library/audio/:id (id-based, for indexed library rows).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FIXTURES = path.join(__dirname, "fixtures");
const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-audio-root-"));
fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), path.join(libraryRoot, "tagged.mp3"));
fs.copyFileSync(path.join(FIXTURES, "protected.m4p"), path.join(libraryRoot, "protected.m4p"));

process.env.PORT = process.env.PORT || "4197";
process.env.PLE_NO_OPEN = "1";
process.env.PLE_LIBRARY_ROOT = libraryRoot;
process.env.PLE_LIBRARY_DB = ":memory:";
const server = require("../server");

const BASE_URL = `http://localhost:${process.env.PORT}`;

async function waitForScanToFinish() {
  for (let i = 0; i < 100; i += 1) {
    const res = await fetch(`${BASE_URL}/api/library/status`);
    const data = await res.json();
    if (!data.scanRunning && data.totalFiles > 0) return data;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("scan never finished");
}

test.after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(libraryRoot, { recursive: true, force: true });
});

test("GET /api/app-info reports the version from package.json, the single source of truth", async () => {
  const res = await fetch(`${BASE_URL}/api/app-info`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.version, require("../package.json").version);
});

test("GET /api/audio serves a real audio file by absolute path", async () => {
  const res = await fetch(`${BASE_URL}/api/audio?path=${encodeURIComponent(path.join(libraryRoot, "tagged.mp3"))}`);
  assert.equal(res.status, 200);
  const body = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(body, fs.readFileSync(path.join(libraryRoot, "tagged.mp3")));
});

test("GET /api/audio rejects a DRM-protected .m4p extension", async () => {
  const res = await fetch(`${BASE_URL}/api/audio?path=${encodeURIComponent(path.join(libraryRoot, "protected.m4p"))}`);
  assert.equal(res.status, 400);
});

test("GET /api/audio 404s for a path that doesn't exist on disk", async () => {
  const res = await fetch(`${BASE_URL}/api/audio?path=${encodeURIComponent(path.join(libraryRoot, "nope.mp3"))}`);
  assert.equal(res.status, 404);
});

test("GET /api/audio rejects a missing or relative path", async () => {
  assert.equal((await fetch(`${BASE_URL}/api/audio`)).status, 400);
  assert.equal((await fetch(`${BASE_URL}/api/audio?path=relative/tagged.mp3`)).status, 400);
});

test("GET /api/library/audio/:id serves the file for an indexed, non-protected row", async () => {
  await waitForScanToFinish();
  const browseRes = await fetch(`${BASE_URL}/api/library/browse?extension=mp3`);
  const { rows } = await browseRes.json();
  const row = rows.find((r) => r.path.endsWith("tagged.mp3"));
  assert.ok(row, "the scanned tagged.mp3 should be in the index");

  const res = await fetch(`${BASE_URL}/api/library/audio/${row.id}`);
  assert.equal(res.status, 200);
  const body = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(body, fs.readFileSync(path.join(libraryRoot, "tagged.mp3")));
});

test("GET /api/library/audio/:id refuses a DRM-protected indexed row", async () => {
  await waitForScanToFinish();
  const browseRes = await fetch(`${BASE_URL}/api/library/browse?extension=m4p`);
  const { rows } = await browseRes.json();
  const row = rows.find((r) => r.path.endsWith("protected.m4p"));
  assert.ok(row, "the scanned protected.m4p should be in the index");
  assert.equal(row.protected, true);

  const res = await fetch(`${BASE_URL}/api/library/audio/${row.id}`);
  assert.equal(res.status, 403);
});

test("GET /api/library/audio/:id 404s for an unknown id", async () => {
  const res = await fetch(`${BASE_URL}/api/library/audio/999999999`);
  assert.equal(res.status, 404);
});

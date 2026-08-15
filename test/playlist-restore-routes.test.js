// Covers POST /api/playlists/:id/restore and /restore/apply end to end
// against a real (temporary) filesystem index and a fake musicLibrary (see
// test/fixtures/fakeMusicLibrary.js) — the real musicLibrary module shells
// out to a live Music.app via AppleScript, which a test suite can't drive.
// This is the app's first write path into the user's Music library, so what
// matters most here is that each bucket (exact match / ambiguous / no local
// match) results in exactly the write calls it should, and nothing more.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const NodeID3 = require("node-id3");

const FIXTURES = path.join(__dirname, "fixtures");
const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-restore-root-"));

fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), path.join(libraryRoot, "exact.mp3"));
NodeID3.update({ title: "Exact Match Song", artist: "Artist X" }, path.join(libraryRoot, "exact.mp3"));

fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), path.join(libraryRoot, "ambiguous.mp3"));
NodeID3.update({ title: "Ambiguous Title", artist: "Some Other Artist" }, path.join(libraryRoot, "ambiguous.mp3"));

process.env.PORT = process.env.PORT || "4198";
process.env.PLE_NO_OPEN = "1";
process.env.PLE_LIBRARY_ROOT = libraryRoot;
process.env.PLE_LIBRARY_DB = ":memory:";
process.env.PLE_TEST_MUSIC_LIBRARY = path.join(__dirname, "fixtures", "fakeMusicLibrary.js");
const server = require("../server");
const fakeMusicLibrary = require("./fixtures/fakeMusicLibrary");

const BASE_URL = `http://localhost:${process.env.PORT}`;
const PLAYLIST_ID = "1";

async function waitFor(checkFn, description) {
  for (let i = 0; i < 200; i += 1) {
    if (await checkFn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

test.before(async () => {
  await waitFor(async () => {
    const res = await fetch(`${BASE_URL}/api/library/browse?title=${encodeURIComponent("Exact Match Song")}`);
    const data = await res.json();
    return data.rows.length === 1;
  }, "exact.mp3 to be indexed");
  await waitFor(async () => {
    const res = await fetch(`${BASE_URL}/api/library/browse?title=${encodeURIComponent("Ambiguous Title")}`);
    const data = await res.json();
    return data.rows.length === 1;
  }, "ambiguous.mp3 to be indexed");
});

test.after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(libraryRoot, { recursive: true, force: true });
});

test.beforeEach(() => {
  fakeMusicLibrary.__reset();
  fakeMusicLibrary.__setTracks(PLAYLIST_ID, [
    { position: 1, musicAppId: "100", title: "Already Ready", artist: "X", album: "", kind: "MP3", location: path.join(libraryRoot, "exact.mp3") },
    { position: 2, musicAppId: "101", title: "Exact Match Song", artist: "Artist X", album: "", kind: "", location: null },
    { position: 3, musicAppId: "102", title: "Ambiguous Title", artist: "Someone Else Entirely", album: "", kind: "", location: null },
    { position: 4, musicAppId: "103", title: "No Match Anywhere XYZ", artist: "Nobody", album: "", kind: "", location: null },
    { position: 5, musicAppId: "104", title: "Also No Match ABC", artist: "Nobody Two", album: "", kind: "", location: null },
  ]);
  fakeMusicLibrary.__setDownloadShouldFail("104");
});

test("POST /api/playlists/:id/restore buckets tracks and only writes for the tracks that need it", async () => {
  const res = await fetch(`${BASE_URL}/api/playlists/${PLAYLIST_ID}/restore`, { method: "POST" });
  const data = await res.json();
  assert.equal(res.status, 200);

  assert.equal(data.fixed.length, 1);
  assert.equal(data.fixed[0].position, 2);
  assert.ok(data.fixed[0].matchedPath.endsWith("exact.mp3"));

  assert.equal(data.needsReview.length, 1);
  assert.equal(data.needsReview[0].position, 3);
  assert.equal(data.needsReview[0].candidates.length, 1);
  assert.ok(data.needsReview[0].candidates[0].path.endsWith("ambiguous.mp3"));

  assert.equal(data.downloading.length, 1);
  assert.equal(data.downloading[0].position, 4);

  assert.equal(data.unsupported.length, 1);
  assert.equal(data.unsupported[0].position, 5);
  assert.ok(data.unsupported[0].reason);

  // Exact match: imported + added to the playlist, then the broken entry removed.
  assert.equal(fakeMusicLibrary.__calls.addFileToPlaylist.length, 1);
  assert.ok(fakeMusicLibrary.__calls.addFileToPlaylist[0].filePath.endsWith("exact.mp3"));
  assert.equal(fakeMusicLibrary.__calls.removeTrackFromPlaylist.length, 1);
  assert.equal(fakeMusicLibrary.__calls.removeTrackFromPlaylist[0].musicAppTrackId, "101");

  // Download attempted only for the two tracks with no local match at all —
  // never for the ready track, the exact match, or the ambiguous one.
  assert.deepEqual(
    fakeMusicLibrary.__calls.attemptDownload.map((c) => c.musicAppTrackId).sort(),
    ["103", "104"]
  );
});

test("POST /api/playlists/:id/restore/apply applies a chosen candidate and removes the old entry", async () => {
  const restoreRes = await fetch(`${BASE_URL}/api/playlists/${PLAYLIST_ID}/restore`, { method: "POST" });
  const restoreData = await restoreRes.json();
  const review = restoreData.needsReview[0];
  fakeMusicLibrary.__calls.addFileToPlaylist.length = 0; // /restore itself already wrote the exact match above
  fakeMusicLibrary.__calls.removeTrackFromPlaylist.length = 0;

  const res = await fetch(`${BASE_URL}/api/playlists/${PLAYLIST_ID}/restore/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId: review.candidates[0].id, trackMusicAppId: review.musicAppId }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.applied, true);
  assert.ok(data.path.endsWith("ambiguous.mp3"));

  assert.equal(fakeMusicLibrary.__calls.addFileToPlaylist.length, 1);
  assert.equal(fakeMusicLibrary.__calls.removeTrackFromPlaylist.length, 1);
  assert.equal(fakeMusicLibrary.__calls.removeTrackFromPlaylist[0].musicAppTrackId, "102");
});

test("POST /api/playlists/:id/restore/apply rejects a missing fileId", async () => {
  const res = await fetch(`${BASE_URL}/api/playlists/${PLAYLIST_ID}/restore/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("POST /api/playlists/:id/restore/apply 404s for an unknown fileId", async () => {
  const res = await fetch(`${BASE_URL}/api/playlists/${PLAYLIST_ID}/restore/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId: 999999999 }),
  });
  assert.equal(res.status, 404);
});

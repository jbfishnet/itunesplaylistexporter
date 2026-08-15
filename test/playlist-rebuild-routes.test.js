// Covers POST /api/playlists/:id/rebuild and DELETE /api/playlists/:id end
// to end against a real (temporary) filesystem index and a fake
// musicLibrary (see test/fixtures/fakeMusicLibrary.js) — the real
// musicLibrary module shells out to a live Music.app via AppleScript, which
// a test suite can't drive. What matters most here: the new playlist ends
// up with the right tracks in the right order, and the original playlist is
// never touched.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const NodeID3 = require("node-id3");

const FIXTURES = path.join(__dirname, "fixtures");
const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-rebuild-root-"));

fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), path.join(libraryRoot, "exact.mp3"));
NodeID3.update({ title: "Exact Match Song", artist: "Artist X" }, path.join(libraryRoot, "exact.mp3"));

process.env.PORT = process.env.PORT || "4200";
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
});

test.after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(libraryRoot, { recursive: true, force: true });
});

test.beforeEach(() => {
  fakeMusicLibrary.__reset();
  fakeMusicLibrary.__setPlaylists([{ id: PLAYLIST_ID, name: "Summer Mix", trackCount: 4 }]);
  fakeMusicLibrary.__setTracks(PLAYLIST_ID, [
    { position: 1, musicAppId: "100", title: "Already Ready", artist: "X", album: "", kind: "MP3", location: path.join(libraryRoot, "exact.mp3") },
    { position: 2, musicAppId: "101", title: "Exact Match Song", artist: "Artist X", album: "", kind: "", location: null },
    { position: 3, musicAppId: "102", title: "No Match Anywhere XYZ", artist: "Nobody", album: "", kind: "", location: null },
    { position: 4, musicAppId: "103", title: "Also Ready", artist: "Y", album: "", kind: "MP3", location: path.join(libraryRoot, "exact.mp3") },
  ]);
});

test("POST /api/playlists/:id/rebuild creates a new playlist with correct order and a matched track fixed", async () => {
  const res = await fetch(`${BASE_URL}/api/playlists/${PLAYLIST_ID}/rebuild`, { method: "POST" });
  const data = await res.json();
  assert.equal(res.status, 200);

  assert.equal(data.newPlaylistName, "Summer Mix (Enriched)");
  assert.equal(data.summary.total, 4);
  assert.equal(data.summary.keptReady, 2);
  assert.equal(data.summary.fixed, 1);
  assert.equal(data.summary.stillMissing, 1);
  assert.deepEqual(data.failed, []);

  const newTracks = await fakeMusicLibrary.getPlaylistTracks(data.newPlaylistId);
  assert.equal(newTracks.length, 4);
  assert.equal(newTracks[0].title, "Already Ready");
  assert.ok(newTracks[1].location.endsWith("exact.mp3"), "position 2's missing track should be replaced by the matched local file");
  assert.equal(newTracks[2].title, "No Match Anywhere XYZ", "unresolved track preserved in its original slot, not dropped");
  assert.equal(newTracks[3].title, "Also Ready");

  // The original playlist's tracks are completely untouched.
  const originalTracks = await fakeMusicLibrary.getPlaylistTracks(PLAYLIST_ID);
  assert.equal(originalTracks.length, 4);
  assert.equal(fakeMusicLibrary.__calls.removeTrackFromPlaylist.length, 0);
});

test("POST /api/playlists/:id/rebuild avoids a playlist-name collision with a prior rebuild", async () => {
  fakeMusicLibrary.__setPlaylists([
    { id: PLAYLIST_ID, name: "Summer Mix", trackCount: 4 },
    { id: "777", name: "Summer Mix (Enriched)", trackCount: 4 },
  ]);
  const res = await fetch(`${BASE_URL}/api/playlists/${PLAYLIST_ID}/rebuild`, { method: "POST" });
  const data = await res.json();
  assert.equal(data.newPlaylistName, "Summer Mix (Enriched) 2");
});

test("POST /api/playlists/:id/rebuild on an already-perfect playlist just copies it, nothing to fix", async () => {
  fakeMusicLibrary.__setTracks(PLAYLIST_ID, [
    { position: 1, musicAppId: "200", title: "All Good", artist: "X", album: "", kind: "MP3", location: path.join(libraryRoot, "exact.mp3") },
  ]);
  const res = await fetch(`${BASE_URL}/api/playlists/${PLAYLIST_ID}/rebuild`, { method: "POST" });
  const data = await res.json();
  assert.equal(data.summary.fixed, 0);
  assert.equal(data.summary.keptReady, 1);
  assert.equal(data.summary.stillMissing, 0);
});

test("DELETE /api/playlists/:id deletes the playlist", async () => {
  const res = await fetch(`${BASE_URL}/api/playlists/${PLAYLIST_ID}`, { method: "DELETE" });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.deleted, true);
  assert.ok(fakeMusicLibrary.__wasDeleted(PLAYLIST_ID));
});

test("DELETE /api/playlists/:id surfaces a Music.app error instead of pretending it succeeded", async () => {
  const originalDelete = fakeMusicLibrary.deletePlaylist;
  fakeMusicLibrary.deletePlaylist = () => Promise.reject(new Error("Music got an error: playlist not found"));
  try {
    const res = await fetch(`${BASE_URL}/api/playlists/${PLAYLIST_ID}`, { method: "DELETE" });
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.match(data.error, /not found/);
  } finally {
    fakeMusicLibrary.deletePlaylist = originalDelete;
  }
});

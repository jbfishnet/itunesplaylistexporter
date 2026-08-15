const test = require("node:test");
const assert = require("node:assert/strict");

const { planRebuild, chooseRebuildName, executeRebuild } = require("../src/playlistRebuilder");
const fakeMusicLibrary = require("./fixtures/fakeMusicLibrary");

/** Same minimal fake as playlistRestorer.test.js — shaped like libraryDb's
 * public surface (browse), nothing more. */
function fakeLibraryDb(files) {
  return {
    browse({ title }) {
      const needle = String(title || "").trim().toLowerCase();
      return { rows: files.filter((f) => f.title.toLowerCase().includes(needle)), total: files.length };
    },
  };
}

// --- planRebuild -----------------------------------------------------------

test("planRebuild: a ready track is kept as-is via duplicate, reason 'ready'", () => {
  const tracks = [{ position: 1, musicAppId: "1", title: "Fine", artist: "X", status: "ready" }];
  const { plan, summary } = planRebuild({ tracks, libraryDb: fakeLibraryDb([]) });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "duplicate");
  assert.equal(plan[0].reason, "ready");
  assert.equal(summary.keptReady, 1);
  assert.equal(summary.fixed, 0);
  assert.equal(summary.stillMissing, 0);
});

test("planRebuild: a protected track is kept as-is via duplicate, reason 'protected' (not mislabeled 'ready')", () => {
  const tracks = [{ position: 1, musicAppId: "1", title: "DRM Track", artist: "X", status: "protected" }];
  const { plan, summary } = planRebuild({ tracks, libraryDb: fakeLibraryDb([]) });
  assert.equal(plan[0].action, "duplicate");
  assert.equal(plan[0].reason, "protected");
  assert.equal(summary.keptReady, 0);
  assert.equal(summary.keptOther, 1);
});

test("planRebuild: a missing track with exactly one title+artist match becomes 'addFile'", () => {
  const db = fakeLibraryDb([{ id: 1, title: "Complicated", artist: "Avril Lavigne", path: "/x/Complicated.mp3" }]);
  const tracks = [{ position: 1, musicAppId: "1", title: "Complicated", artist: "Avril Lavigne", status: "missing" }];
  const { plan, summary } = planRebuild({ tracks, libraryDb: db });
  assert.equal(plan[0].action, "addFile");
  assert.equal(plan[0].file.path, "/x/Complicated.mp3");
  assert.equal(summary.fixed, 1);
  assert.equal(summary.stillMissing, 0);
});

test("planRebuild: a missing track with 2+ candidates is preserved as still-missing, reason 'ambiguous'", () => {
  const db = fakeLibraryDb([
    { id: 1, title: "Hello", artist: "Adele" },
    { id: 2, title: "Hello", artist: "Adele" },
  ]);
  const tracks = [{ position: 1, musicAppId: "1", title: "Hello", artist: "Adele", status: "missing" }];
  const { plan, summary } = planRebuild({ tracks, libraryDb: db });
  assert.equal(plan[0].action, "duplicate");
  assert.equal(plan[0].reason, "ambiguous");
  assert.equal(summary.fixed, 0);
  assert.equal(summary.stillMissing, 1);
});

test("planRebuild: a missing track with no local match is preserved as still-missing, reason 'no-match'", () => {
  const db = fakeLibraryDb([{ id: 1, title: "Unrelated", artist: "Nobody" }]);
  const tracks = [{ position: 1, musicAppId: "1", title: "Totally Different Song", artist: "Someone Else", status: "missing" }];
  const { plan, summary } = planRebuild({ tracks, libraryDb: db });
  assert.equal(plan[0].action, "duplicate");
  assert.equal(plan[0].reason, "no-match");
  assert.equal(summary.stillMissing, 1);
});

test("planRebuild: with no library index configured at all, every missing track is preserved, reason 'no-library-index'", () => {
  const tracks = [{ position: 1, musicAppId: "1", title: "Whatever", artist: "X", status: "missing" }];
  const { plan, summary } = planRebuild({ tracks, libraryDb: null });
  assert.equal(plan[0].action, "duplicate");
  assert.equal(plan[0].reason, "no-library-index");
  assert.equal(summary.stillMissing, 1);
});

test("planRebuild: preserves original track order in the plan regardless of mixed outcomes", () => {
  const db = fakeLibraryDb([{ id: 1, title: "Fixable", artist: "Artist", path: "/fixable.mp3" }]);
  const tracks = [
    { position: 1, musicAppId: "1", title: "Ready One", artist: "X", status: "ready" },
    { position: 2, musicAppId: "2", title: "Fixable", artist: "Artist", status: "missing" },
    { position: 3, musicAppId: "3", title: "Unfixable", artist: "Y", status: "missing" },
    { position: 4, musicAppId: "4", title: "Ready Two", artist: "Z", status: "ready" },
  ];
  const { plan, summary } = planRebuild({ tracks, libraryDb: db });
  assert.deepEqual(
    plan.map((p) => p.track.position),
    [1, 2, 3, 4]
  );
  assert.deepEqual(
    plan.map((p) => p.action),
    ["duplicate", "addFile", "duplicate", "duplicate"]
  );
  assert.equal(summary.total, 4);
  assert.equal(summary.keptReady, 2);
  assert.equal(summary.fixed, 1);
  assert.equal(summary.stillMissing, 1);
});

test("planRebuild: an empty playlist produces an empty plan", () => {
  const { plan, summary } = planRebuild({ tracks: [], libraryDb: fakeLibraryDb([]) });
  assert.deepEqual(plan, []);
  assert.equal(summary.total, 0);
});

// --- chooseRebuildName -------------------------------------------------------

test("chooseRebuildName: no collision, just appends '(Enriched)'", () => {
  assert.equal(chooseRebuildName("Summer Mix", []), "Summer Mix (Enriched)");
});

test("chooseRebuildName: one collision appends a counter", () => {
  assert.equal(chooseRebuildName("Summer Mix", ["Summer Mix (Enriched)"]), "Summer Mix (Enriched) 2");
});

test("chooseRebuildName: multiple prior rebuilds keep counting up", () => {
  const existing = ["Summer Mix (Enriched)", "Summer Mix (Enriched) 2", "Summer Mix (Enriched) 3"];
  assert.equal(chooseRebuildName("Summer Mix", existing), "Summer Mix (Enriched) 4");
});

test("chooseRebuildName: an unrelated playlist sharing a substring doesn't cause a false collision", () => {
  assert.equal(chooseRebuildName("Mix", ["Summer Mix (Enriched)"]), "Mix (Enriched)");
});

// --- executeRebuild (against the fake musicLibrary) -------------------------

test.beforeEach(() => fakeMusicLibrary.__reset());

test("executeRebuild: creates a new playlist and applies the plan in order", async () => {
  fakeMusicLibrary.__setTracks("500", [
    { position: 1, musicAppId: "1", title: "Ready One", location: "/library/ready1.mp3" },
    { position: 2, musicAppId: "2", title: "Still Missing", location: null },
  ]);

  const plan = [
    { action: "duplicate", track: { position: 1, musicAppId: "1", title: "Ready One" }, reason: "ready" },
    { action: "addFile", track: { position: 2, musicAppId: "2", title: "Fixed Track" }, file: { path: "/nas/fixed.mp3" } },
  ];

  const { newPlaylistId, results } = await executeRebuild({
    musicLibrary: fakeMusicLibrary,
    sourcePlaylistId: "500",
    newPlaylistName: "Summer Mix (Enriched)",
    plan,
  });

  assert.equal(fakeMusicLibrary.__calls.createPlaylist.length, 1);
  assert.equal(fakeMusicLibrary.__calls.createPlaylist[0].name, "Summer Mix (Enriched)");

  assert.deepEqual(fakeMusicLibrary.__calls.duplicateTrackToPlaylist, [
    { sourcePlaylistId: "500", trackId: "1", destPlaylistId: newPlaylistId },
  ]);
  assert.deepEqual(fakeMusicLibrary.__calls.addFileToPlaylist, [{ playlistId: newPlaylistId, filePath: "/nas/fixed.mp3" }]);

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));

  // The whole point: the new playlist's actual resulting order/content.
  const finalTracks = await fakeMusicLibrary.getPlaylistTracks(newPlaylistId);
  assert.equal(finalTracks.length, 2);
  assert.equal(finalTracks[0].title, "Ready One");
  assert.equal(finalTracks[0].location, "/library/ready1.mp3");
  assert.equal(finalTracks[1].location, "/nas/fixed.mp3");
});

test("executeRebuild: a single failed item is recorded but doesn't abort the rest of the rebuild", async () => {
  fakeMusicLibrary.__setTracks("501", [{ position: 1, musicAppId: "1", title: "Exists" }]);
  // No track "999" in playlist 501 — duplicateTrackToPlaylist will reject for it (see fakeMusicLibrary).

  const plan = [
    { action: "duplicate", track: { position: 1, musicAppId: "999", title: "Broken Reference" }, reason: "ready" },
    { action: "duplicate", track: { position: 2, musicAppId: "1", title: "Exists" }, reason: "ready" },
  ];

  const { newPlaylistId, results } = await executeRebuild({
    musicLibrary: fakeMusicLibrary,
    sourcePlaylistId: "501",
    newPlaylistName: "Broken Mix (Enriched)",
    plan,
  });

  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /999/);
  assert.equal(results[1].ok, true);

  // The second item still landed correctly despite the first one failing.
  const finalTracks = await fakeMusicLibrary.getPlaylistTracks(newPlaylistId);
  assert.equal(finalTracks.length, 1);
  assert.equal(finalTracks[0].title, "Exists");
});

test("executeRebuild: an empty plan still creates the (empty) playlist", async () => {
  const { newPlaylistId, results } = await executeRebuild({
    musicLibrary: fakeMusicLibrary,
    sourcePlaylistId: "502",
    newPlaylistName: "Empty Mix (Enriched)",
    plan: [],
  });
  assert.equal(results.length, 0);
  const finalTracks = await fakeMusicLibrary.getPlaylistTracks(newPlaylistId);
  assert.deepEqual(finalTracks, []);
});

test("executeRebuild: the original source playlist is never modified", async () => {
  const originalTracks = [
    { position: 1, musicAppId: "1", title: "Untouched", location: "/a.mp3" },
    { position: 2, musicAppId: "2", title: "Also Untouched", location: null },
  ];
  fakeMusicLibrary.__setTracks("503", originalTracks);

  const plan = [
    { action: "duplicate", track: { position: 1, musicAppId: "1", title: "Untouched" }, reason: "ready" },
    { action: "addFile", track: { position: 2, musicAppId: "2", title: "Also Untouched" }, file: { path: "/nas/fixed.mp3" } },
  ];
  await executeRebuild({ musicLibrary: fakeMusicLibrary, sourcePlaylistId: "503", newPlaylistName: "Copy (Enriched)", plan });

  const sourceAfter = await fakeMusicLibrary.getPlaylistTracks("503");
  assert.deepEqual(sourceAfter, originalTracks);
  assert.equal(fakeMusicLibrary.__calls.removeTrackFromPlaylist.length, 0, "rebuild must never remove anything from the source");
});

// --- end-to-end: plan a realistic mixed playlist, then execute it -----------

test("end-to-end: a mixed playlist rebuilds into a new playlist with correct order, matching exactly what planRebuild decided", async () => {
  const db = fakeLibraryDb([{ id: 1, title: "Pikalar - Live (192  kbps)", artist: "Anika Nilles", path: "/nas/pikalar-live.mp3" }]);
  const tracks = [
    { position: 1, musicAppId: "10", title: "Pikalar - Live (192  kbps)", artist: "Anika Nilles", status: "missing" },
    { position: 2, musicAppId: "11", title: "Hypnotized", artist: "Purple Disco Machine", status: "ready", location: "/lib/hypnotized.m4a" },
    { position: 3, musicAppId: "12", title: "Wild Boy", artist: "Anika Nilles", status: "missing" }, // no candidate in this fake db -> "no-match"
  ];

  fakeMusicLibrary.__setTracks("504", tracks);

  const { plan, summary } = planRebuild({ tracks, libraryDb: db });
  assert.equal(summary.fixed, 1);
  assert.equal(summary.keptReady, 1);
  assert.equal(summary.stillMissing, 1);

  const { newPlaylistId } = await executeRebuild({
    musicLibrary: fakeMusicLibrary,
    sourcePlaylistId: "504",
    newPlaylistName: chooseRebuildName("Christine's Playlist", []),
    plan,
  });

  const finalTracks = await fakeMusicLibrary.getPlaylistTracks(newPlaylistId);
  assert.equal(finalTracks.length, 3);
  // Position 1: was missing, now the matched local file, in the original slot.
  assert.equal(finalTracks[0].location, "/nas/pikalar-live.mp3");
  // Position 2: was already ready, preserved via duplicate.
  assert.equal(finalTracks[1].title, "Hypnotized");
  // Position 3: still missing (no candidate), preserved via duplicate — order intact, nothing dropped.
  assert.equal(finalTracks[2].title, "Wild Boy");
});

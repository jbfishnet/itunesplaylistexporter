// Stand-in for src/musicLibrary.js used only by
// test/playlist-restore-routes.test.js (via PLE_TEST_MUSIC_LIBRARY) — the
// real module shells out to a live Music.app via AppleScript, which isn't
// something a test suite can drive. Same function names/shapes as the real
// module; state is configured directly by the test and every write call is
// recorded so the test can assert on what the route actually did.

let state = { tracksByPlaylist: {}, downloadShouldFail: new Set() };
const calls = { addFileToPlaylist: [], removeTrackFromPlaylist: [], attemptDownload: [] };

function listPlaylists() {
  return Promise.resolve([]);
}

function getPlaylistTracks(playlistId) {
  const tracks = state.tracksByPlaylist[String(playlistId)] || [];
  return Promise.resolve(tracks.map((t) => ({ ...t })));
}

function addFileToPlaylist(playlistId, filePath) {
  calls.addFileToPlaylist.push({ playlistId: String(playlistId), filePath });
  return Promise.resolve();
}

function removeTrackFromPlaylist(playlistId, musicAppTrackId) {
  calls.removeTrackFromPlaylist.push({ playlistId: String(playlistId), musicAppTrackId: String(musicAppTrackId) });
  return Promise.resolve();
}

function attemptDownload(playlistId, musicAppTrackId) {
  calls.attemptDownload.push({ playlistId: String(playlistId), musicAppTrackId: String(musicAppTrackId) });
  if (state.downloadShouldFail.has(String(musicAppTrackId))) {
    return Promise.reject(new Error("Music got an error: download isn't supported here"));
  }
  return Promise.resolve();
}

module.exports = {
  listPlaylists,
  getPlaylistTracks,
  addFileToPlaylist,
  removeTrackFromPlaylist,
  attemptDownload,
  __setTracks(playlistId, tracks) {
    state.tracksByPlaylist[String(playlistId)] = tracks;
  },
  __setDownloadShouldFail(musicAppTrackId) {
    state.downloadShouldFail.add(String(musicAppTrackId));
  },
  __calls: calls,
  __reset() {
    state = { tracksByPlaylist: {}, downloadShouldFail: new Set() };
    calls.addFileToPlaylist.length = 0;
    calls.removeTrackFromPlaylist.length = 0;
    calls.attemptDownload.length = 0;
  },
};

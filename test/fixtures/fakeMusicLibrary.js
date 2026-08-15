// Stand-in for src/musicLibrary.js used only by
// test/playlist-restore-routes.test.js and test/playlist-rebuild-routes.test.js
// (via PLE_TEST_MUSIC_LIBRARY) — the real module shells out to a live
// Music.app via AppleScript, which isn't something a test suite can drive.
// Same function names/shapes as the real module; state is configured
// directly by the test and every write call is recorded so a test can
// assert on what the route actually did. addFileToPlaylist/
// duplicateTrackToPlaylist also simulate the resulting playlist content (not
// just log the call), so a test can call getPlaylistTracks() afterward and
// assert on the real end state — important for rebuild, where order is the
// whole point.

const path = require("path");

let state = {
  tracksByPlaylist: {},
  downloadShouldFail: new Set(),
  deletedPlaylistIds: new Set(),
  nextId: 90000,
  playlists: [],
};
const calls = {
  addFileToPlaylist: [],
  removeTrackFromPlaylist: [],
  attemptDownload: [],
  createPlaylist: [],
  duplicateTrackToPlaylist: [],
  deletePlaylist: [],
};

function nextId() {
  state.nextId += 1;
  return String(state.nextId);
}

function listPlaylists() {
  return Promise.resolve(state.playlists.map((p) => ({ ...p })));
}

function getPlaylistTracks(playlistId) {
  const tracks = state.tracksByPlaylist[String(playlistId)] || [];
  return Promise.resolve(tracks.map((t) => ({ ...t })));
}

function addFileToPlaylist(playlistId, filePath) {
  calls.addFileToPlaylist.push({ playlistId: String(playlistId), filePath });
  const key = String(playlistId);
  const list = state.tracksByPlaylist[key] || (state.tracksByPlaylist[key] = []);
  list.push({
    position: list.length + 1,
    musicAppId: nextId(),
    title: path.basename(filePath, path.extname(filePath)),
    artist: null,
    album: null,
    kind: "MPEG-Audiodatei",
    location: filePath,
  });
  return Promise.resolve();
}

function removeTrackFromPlaylist(playlistId, musicAppTrackId) {
  calls.removeTrackFromPlaylist.push({ playlistId: String(playlistId), musicAppTrackId: String(musicAppTrackId) });
  const key = String(playlistId);
  const list = state.tracksByPlaylist[key];
  if (list) {
    state.tracksByPlaylist[key] = list
      .filter((t) => String(t.musicAppId) !== String(musicAppTrackId))
      .map((t, i) => ({ ...t, position: i + 1 }));
  }
  return Promise.resolve();
}

function attemptDownload(playlistId, musicAppTrackId) {
  calls.attemptDownload.push({ playlistId: String(playlistId), musicAppTrackId: String(musicAppTrackId) });
  if (state.downloadShouldFail.has(String(musicAppTrackId))) {
    return Promise.reject(new Error("Music got an error: download isn't supported here"));
  }
  return Promise.resolve();
}

function createPlaylist(name) {
  calls.createPlaylist.push({ name });
  const id = nextId();
  state.tracksByPlaylist[id] = [];
  state.playlists.push({ id, name, trackCount: 0 });
  return Promise.resolve(id);
}

function duplicateTrackToPlaylist(sourcePlaylistId, trackId, destPlaylistId) {
  calls.duplicateTrackToPlaylist.push({
    sourcePlaylistId: String(sourcePlaylistId),
    trackId: String(trackId),
    destPlaylistId: String(destPlaylistId),
  });
  const sourceList = state.tracksByPlaylist[String(sourcePlaylistId)] || [];
  const source = sourceList.find((t) => String(t.musicAppId) === String(trackId));
  if (!source) return Promise.reject(new Error(`Music got an error: can't find track id ${trackId} in the source playlist`));

  const destKey = String(destPlaylistId);
  const destList = state.tracksByPlaylist[destKey] || (state.tracksByPlaylist[destKey] = []);
  destList.push({ ...source, musicAppId: nextId(), position: destList.length + 1 });
  return Promise.resolve();
}

function deletePlaylist(playlistId) {
  calls.deletePlaylist.push({ playlistId: String(playlistId) });
  state.deletedPlaylistIds.add(String(playlistId));
  delete state.tracksByPlaylist[String(playlistId)];
  return Promise.resolve();
}

module.exports = {
  listPlaylists,
  getPlaylistTracks,
  addFileToPlaylist,
  removeTrackFromPlaylist,
  attemptDownload,
  createPlaylist,
  duplicateTrackToPlaylist,
  deletePlaylist,
  __setTracks(playlistId, tracks) {
    state.tracksByPlaylist[String(playlistId)] = tracks;
  },
  __setDownloadShouldFail(musicAppTrackId) {
    state.downloadShouldFail.add(String(musicAppTrackId));
  },
  __wasDeleted(playlistId) {
    return state.deletedPlaylistIds.has(String(playlistId));
  },
  __setPlaylists(playlists) {
    state.playlists = playlists;
  },
  __calls: calls,
  __reset() {
    state = { tracksByPlaylist: {}, downloadShouldFail: new Set(), deletedPlaylistIds: new Set(), nextId: 90000, playlists: [] };
    for (const key of Object.keys(calls)) calls[key].length = 0;
  },
};

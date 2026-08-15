const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Rare control characters used as field/record separators so track titles,
// artists, etc. (which could contain tabs or commas) never corrupt parsing.
const FS = "";
const RS = "";

// Apple Event error numbers that are typically transient — Music.app was
// busy (e.g. actively playing/being used interactively) rather than the
// query itself being wrong. Worth a quiet retry before surfacing an error.
const TRANSIENT_ERROR_CODES = ["-1712", "-600", "-609", "-1728"];

function isTransientAppleScriptError(message) {
  return TRANSIENT_ERROR_CODES.some((code) => message.includes(`(${code})`));
}

// Music.app's scripting bridge can be very slow to enumerate playlists when
// it's doing iCloud Music Library / Apple Music matching in the background —
// observed taking well over a minute on a ~100-playlist library. A short
// timeout here misreports as "Automation permission denied" (see below), so
// it's set generously rather than tightened for snappier failure.
const APPLESCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

function runAppleScriptOnce(script) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(
      os.tmpdir(),
      `ple-${Date.now()}-${Math.random().toString(36).slice(2)}.applescript`
    );
    fs.writeFileSync(tmpFile, script, "utf8");
    execFile(
      "osascript",
      [tmpFile],
      { maxBuffer: 1024 * 1024 * 64, timeout: APPLESCRIPT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        fs.unlink(tmpFile, () => {});
        if (err) {
          if (err.killed && err.signal === "SIGTERM") {
            reject(
              new Error(
                `Music.app didn't respond within ${APPLESCRIPT_TIMEOUT_MS / 1000}s ` +
                  "(it may be busy syncing with iCloud Music Library) — try again."
              )
            );
            return;
          }
          reject(new Error(stderr?.trim() || err.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function runAppleScript(script, attempt = 1) {
  try {
    return await runAppleScriptOnce(script);
  } catch (err) {
    const maxAttempts = 3;
    if (attempt < maxAttempts && isTransientAppleScriptError(err.message)) {
      await new Promise((r) => setTimeout(r, attempt * 400));
      return runAppleScript(script, attempt + 1);
    }
    throw err;
  }
}

// Multiple open tabs/windows (e.g. the native app plus a browser tab, or
// several stale tabs left open) each poll independently and can easily land
// on Music.app at the same moment — observed spawning 4 concurrent osascript
// processes in practice, which appears to be what pushes Music.app's Apple
// Event handling into the timeouts this whole module works around. Sharing
// one in-flight call across concurrent callers (keyed by playlist id for
// track fetches) removes that pile-up regardless of how many clients are open.
let listPlaylistsInFlight = null;
const trackFetchesInFlight = new Map();

/**
 * Lists user-created playlists (regular + smart), excluding the built-in
 * Library/Music sources and folder playlists (which don't hold tracks directly).
 */
async function listPlaylists() {
  if (listPlaylistsInFlight) return listPlaylistsInFlight;
  listPlaylistsInFlight = listPlaylistsUncached().finally(() => {
    listPlaylistsInFlight = null;
  });
  return listPlaylistsInFlight;
}

async function listPlaylistsUncached() {
  const script = `
tell application "Music"
  set output to ""
  repeat with p in every playlist
    if (class of p) is user playlist then
      set output to output & (id of p as string) & "${FS}" & (name of p) & "${FS}" & (count of tracks of p) & "${RS}"
    end if
  end repeat
  return output
end tell
`;
  const raw = await runAppleScript(script);
  return raw
    .split(RS)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [id, name, count] = line.split(FS);
      return { id, name, trackCount: parseInt(count, 10) || 0 };
    });
}

/**
 * Returns every track in a playlist, in playlist order, with the metadata
 * needed to decide whether it can be exported (location on disk + kind).
 */
async function getPlaylistTracks(playlistId) {
  const key = String(playlistId);
  if (trackFetchesInFlight.has(key)) return trackFetchesInFlight.get(key);
  const promise = getPlaylistTracksUncached(playlistId).finally(() => {
    trackFetchesInFlight.delete(key);
  });
  trackFetchesInFlight.set(key, promise);
  return promise;
}

async function getPlaylistTracksUncached(playlistId) {
  const numericId = parseInt(playlistId, 10);
  if (!Number.isFinite(numericId)) {
    throw new Error(`Invalid playlist id: ${playlistId}`);
  }

  // Playlists commonly mix locally-stored "file track"s with cloud-matched
  // "shared track"s (Apple Music tracks not downloaded locally). Bulk
  // "property of every track" fails outright on such mixed-class lists, so
  // each track's properties are fetched individually and defensively.
  //
  // Also captures each entry's `id` (Music.app's persistent id for this
  // specific playlist entry, not just its transient position) — needed by
  // removeTrackFromPlaylist/attemptDownload below, since a position becomes
  // stale the moment any entry before it is removed.
  const script = `
tell application "Music"
  set thePlaylist to (first playlist whose id is ${numericId})
  set theTracks to every track of thePlaylist
  set output to ""
  set i to 0
  repeat with t in theTracks
    set i to i + 1
    set theId to ""
    try
      set theId to (id of t as string)
    end try
    set theName to ""
    try
      set theName to (name of t)
    end try
    set theArtist to ""
    try
      set theArtist to (artist of t)
    end try
    set theAlbum to ""
    try
      set theAlbum to (album of t)
    end try
    set theKind to ""
    try
      set theKind to (kind of t)
    end try
    set theLoc to "MISSING"
    try
      set theAlias to location of t
      set theLoc to POSIX path of theAlias
    end try
    set output to output & i & "${FS}" & theId & "${FS}" & theName & "${FS}" & theArtist & "${FS}" & theAlbum & "${FS}" & theKind & "${FS}" & theLoc & "${RS}"
  end repeat
  return output
end tell
`;
  const raw = await runAppleScript(script);
  return raw
    .split(RS)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [pos, musicAppId, title, artist, album, kind, location] = line.split(FS);
      return {
        position: parseInt(pos, 10),
        musicAppId: musicAppId || null,
        title,
        artist,
        album,
        kind,
        location: location === "MISSING" ? null : location,
      };
    });
}

// Embeds an arbitrary string (a filesystem path, in practice) into an
// AppleScript double-quoted literal — escapes backslashes and quotes so a
// path containing either can't break out of the literal or corrupt the script.
function escapeAppleScriptString(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Imports a local file into the user's Music library and adds it to the
 * given playlist in one step — Music.app's `add` command does both. This is
 * the first write path into the user's real Music library this module has
 * ever had; only ever called for a file the caller has already independently
 * confirmed exists on disk.
 */
async function addFileToPlaylist(playlistId, filePath) {
  const numericId = parseInt(playlistId, 10);
  if (!Number.isFinite(numericId)) throw new Error(`Invalid playlist id: ${playlistId}`);
  const script = `
tell application "Music"
  set thePlaylist to (first playlist whose id is ${numericId})
  add (POSIX file "${escapeAppleScriptString(filePath)}") to thePlaylist
end tell
`;
  await runAppleScript(script);
}

/**
 * Removes one specific entry from a playlist, addressed by the persistent
 * per-entry id captured in getPlaylistTracks (never by position — positions
 * shift as soon as any earlier entry is removed).
 */
async function removeTrackFromPlaylist(playlistId, musicAppTrackId) {
  const numericPlaylistId = parseInt(playlistId, 10);
  if (!Number.isFinite(numericPlaylistId)) throw new Error(`Invalid playlist id: ${playlistId}`);
  if (!musicAppTrackId) throw new Error("Missing track id");
  const script = `
tell application "Music"
  set thePlaylist to (first playlist whose id is ${numericPlaylistId})
  delete (some track of thePlaylist whose id is ${parseInt(musicAppTrackId, 10)})
end tell
`;
  await runAppleScript(script);
}

/**
 * Sends Music.app's `download` command for one cloud/matched track that has
 * no local file yet. NOT verified to work on every macOS/Music.app version —
 * callers should treat a thrown error here as "download isn't supported on
 * this setup" rather than a transient failure worth retrying.
 */
async function attemptDownload(playlistId, musicAppTrackId) {
  const numericPlaylistId = parseInt(playlistId, 10);
  if (!Number.isFinite(numericPlaylistId)) throw new Error(`Invalid playlist id: ${playlistId}`);
  if (!musicAppTrackId) throw new Error("Missing track id");
  const script = `
tell application "Music"
  set thePlaylist to (first playlist whose id is ${numericPlaylistId})
  set theTrack to (some track of thePlaylist whose id is ${parseInt(musicAppTrackId, 10)})
  download theTrack
end tell
`;
  await runAppleScript(script);
}

module.exports = {
  listPlaylists,
  getPlaylistTracks,
  addFileToPlaylist,
  removeTrackFromPlaylist,
  attemptDownload,
};

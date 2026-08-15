// Builds a full, correctly-ordered copy of a playlist instead of restoring
// missing tracks in place. Restoring in place (playlistRestorer.js) has a
// real, unfixable limitation: Music.app's AppleScript dictionary has no way
// to insert or reposition a track at a specific index within a playlist
// (verified empirically — move only repositions whole playlists, add's
// documented location-specifier support doesn't work in practice, and
// duplicate-to-a-location silently no-ops), so a restored track always lands
// at the end. Rebuilding as a brand-new playlist sidesteps that entirely:
// every track — fixed or not — is placed by simple call order into a fresh
// playlist, which is the one thing Music.app's `add`/`duplicate` reliably do
// get right.
//
// The original playlist is never touched. A rebuild that fails partway
// through leaves an incomplete *copy* sitting alongside an untouched
// original — never a damaged original.

const { findCandidates } = require("./playlistRestorer");

/**
 * Decides, in original order, what should happen to every track in a
 * rebuild. Pure — no Music.app/filesystem I/O, so it's fully testable
 * without a live app. Three outcomes per track:
 *  - "duplicate": already-fine ("ready") tracks, kept exactly as they are.
 *  - "addFile": a missing track with exactly one confident local-index
 *    match — same "exact" bar as playlistRestorer, resolved automatically.
 *  - "duplicate" (again): a missing track that's ambiguous or has no local
 *    match at all — preserved as still-missing, in its correct position,
 *    rather than silently dropped from the copy. Nothing a rebuild can't
 *    resolve is ever lost; it just stays exactly as broken as it was.
 */
function planRebuild({ tracks, libraryDb }) {
  const plan = tracks.map((track) => {
    // Anything that isn't "missing" (ready, protected, ...) is kept exactly
    // as-is — reason mirrors the track's own status, so a protected track is
    // reported as "protected" rather than misleadingly labeled "ready".
    if (track.status !== "missing") {
      return { action: "duplicate", track, reason: track.status };
    }
    if (!libraryDb) {
      return { action: "duplicate", track, reason: "no-library-index" };
    }
    const { confidence, candidates } = findCandidates(track, libraryDb);
    if (confidence === "exact") {
      return { action: "addFile", track, file: candidates[0] };
    }
    return { action: "duplicate", track, reason: confidence === "ambiguous" ? "ambiguous" : "no-match" };
  });

  const stillMissingReasons = new Set(["ambiguous", "no-match", "no-library-index"]);
  const summary = {
    total: plan.length,
    keptReady: plan.filter((p) => p.reason === "ready").length,
    keptOther: plan.filter((p) => p.action === "duplicate" && p.reason !== "ready" && !stillMissingReasons.has(p.reason)).length,
    fixed: plan.filter((p) => p.action === "addFile").length,
    stillMissing: plan.filter((p) => stillMissingReasons.has(p.reason)).length,
  };

  return { plan, summary };
}

/**
 * Picks a name for the rebuilt copy that won't collide with an existing
 * playlist — Music.app itself doesn't enforce unique playlist names, but a
 * second playlist silently named identically to the first would be
 * confusing to tell apart afterward.
 */
function chooseRebuildName(originalName, existingNames) {
  const existing = new Set(existingNames);
  const base = `${originalName} (Enriched)`;
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * Executes a rebuild plan against a real (or fake, for tests) musicLibrary:
 * creates the new playlist, then walks the plan in order performing each
 * track's action. A single track's failure is recorded and skipped rather
 * than aborting the whole rebuild — one bad AppleScript call shouldn't cost
 * every track after it its correct position.
 */
async function executeRebuild({ musicLibrary, sourcePlaylistId, newPlaylistName, plan }) {
  const newPlaylistId = await musicLibrary.createPlaylist(newPlaylistName);

  const results = [];
  for (const item of plan) {
    try {
      if (item.action === "addFile") {
        await musicLibrary.addFileToPlaylist(newPlaylistId, item.file.path);
      } else {
        await musicLibrary.duplicateTrackToPlaylist(sourcePlaylistId, item.track.musicAppId, newPlaylistId);
      }
      results.push({ position: item.track.position, title: item.track.title, action: item.action, ok: true });
    } catch (err) {
      results.push({ position: item.track.position, title: item.track.title, action: item.action, ok: false, error: err.message });
    }
  }

  return { newPlaylistId, results };
}

module.exports = { planRebuild, chooseRebuildName, executeRebuild };

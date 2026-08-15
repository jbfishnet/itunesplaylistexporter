// Matches a playlist's missing tracks against the local library index
// (src/libraryDb.js) — pure matching/bucketing logic, deliberately free of
// any Music.app/AppleScript I/O so it's testable without a live app or a
// real database. The caller (server.js) is responsible for actually acting
// on the buckets this returns (adding a fixed match to the playlist,
// attempting a download for a track with no local match).

function normalize(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase();
}

/**
 * When title+artist both matched but 2+ physical copies exist (e.g. the same
 * file present in more than one NAS snapshot/backup — a common, otherwise
 * unavoidable source of "ambiguous" results), auto-resolve to "exact" if
 * exactly one of them lives under the user's designated main library (see
 * libraryDb.js's getMainLibraryRoot) — the same preference the Duplicates
 * tab already uses for "which copy to keep" when deleting. Deliberately
 * narrow: only collapses a tie that's purely about *which physical copy*,
 * never applied to the weaker title-only match below (where whether it's
 * even the right song, not just which copy, is the open question — a main-
 * library preference has nothing useful to say about that). Returns null
 * (no auto-pick) whenever 0 or 2+ candidates are under the main library, or
 * no main library is configured at all — those are still genuinely ambiguous.
 */
function resolveByMainLibrary(candidates, libraryDb) {
  const mainRoot = libraryDb.getMainLibraryRoot?.();
  if (!mainRoot) return null;
  const inMain = candidates.filter((f) => f.path.startsWith(mainRoot));
  return inMain.length === 1 ? inMain[0] : null;
}

/**
 * Looks up local-index candidates for one missing playlist track.
 * - "exact": exactly one indexed file shares this track's title AND artist
 *   (case/whitespace-insensitive) — safe to auto-apply without asking. Also
 *   reached when 2+ copies exist but the main library breaks the tie (see
 *   resolveByMainLibrary).
 * - "ambiguous": 2+ candidates the main library doesn't resolve, or only the
 *   title matched (artist missing/different) — could be a cover/live
 *   version/mix-up, needs a human pick.
 * - "none": nothing in the index looks like this track at all.
 */
function findCandidates(track, libraryDb) {
  const title = normalize(track.title);
  if (!title) return { confidence: "none", candidates: [] };
  const artist = normalize(track.artist);

  // browse()'s title filter is a substring match, not exact — cast a
  // reasonably wide net, then narrow to real matches here in JS.
  const { rows: broad } = libraryDb.browse({ title: track.title, limit: 50 });
  const exactTitleArtist = broad.filter(
    (f) => normalize(f.title) === title && artist !== "" && normalize(f.artist) === artist
  );
  if (exactTitleArtist.length === 1) return { confidence: "exact", candidates: exactTitleArtist };
  if (exactTitleArtist.length > 1) {
    const autoPicked = resolveByMainLibrary(exactTitleArtist, libraryDb);
    if (autoPicked) return { confidence: "exact", candidates: [autoPicked] };
    return { confidence: "ambiguous", candidates: exactTitleArtist };
  }

  const titleOnly = broad.filter((f) => normalize(f.title) === title);
  if (titleOnly.length > 0) return { confidence: "ambiguous", candidates: titleOnly };

  // Deliberately no fuzzier fallback (e.g. free-text FTS over the title):
  // tried that first and it matched on single shared common words (a track
  // titled "No Match Anywhere" matched an unrelated "Exact Match Song" on
  // the word "Match") — a false "ambiguous" is worse than a clean "none",
  // since "none" is what triggers a Music.app download attempt further down.
  return { confidence: "none", candidates: [] };
}

/**
 * Buckets a playlist's currently-missing tracks by match confidence.
 * Doesn't touch Music.app or the filesystem — just decides what should
 * happen to each track; the caller applies "fixed" and "noLocalMatch".
 */
function restorePlaylist({ tracks, libraryDb }) {
  const missing = tracks.filter((t) => t.status === "missing");
  const fixed = [];
  const needsReview = [];
  const noLocalMatch = [];

  for (const track of missing) {
    if (!libraryDb) {
      noLocalMatch.push(track);
      continue;
    }
    const { confidence, candidates } = findCandidates(track, libraryDb);
    if (confidence === "exact") fixed.push({ track, file: candidates[0] });
    else if (confidence === "ambiguous") needsReview.push({ track, candidates });
    else noLocalMatch.push(track);
  }

  return { fixed, needsReview, noLocalMatch };
}

module.exports = { normalize, findCandidates, restorePlaylist };

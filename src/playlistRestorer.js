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
 * Looks up local-index candidates for one missing playlist track.
 * - "exact": exactly one indexed file shares this track's title AND artist
 *   (case/whitespace-insensitive) — safe to auto-apply without asking.
 * - "ambiguous": 2+ candidates, or only the title matched (artist missing/
 *   different) — could be a cover/live version/mix-up, needs a human pick.
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
  if (exactTitleArtist.length > 1) return { confidence: "ambiguous", candidates: exactTitleArtist };

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

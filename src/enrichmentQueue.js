const path = require("path");
const { identifyByFingerprint } = require("./acoustId");
const { writeTagsForRow } = require("./tagWriter");

const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";

// A middle-of-the-road pace within the "roughly 1.5-2s between requests"
// range this app deliberately stays under — Apple's public search endpoint
// has no published personal-use quota, but bursts are known to draw
// transient 403s, and this is a background process with nowhere to be.
const DEFAULT_INTERVAL_MS = 1750;

// Old file-sharing/scene rips frequently have spam baked directly into the
// artist tag itself (a tracker URL, a rapidshare link, ...) rather than
// missing data — trusting that tag guarantees a failed search every time
// ("http://zap.to/canna Another Brick In The Wall" matches nothing), so it's
// treated the same as if the tag were empty and the filename is used instead.
const GARBAGE_TEXT_PATTERN = /https?:\/\/|www\.|\.(?:to|cjb\.net)\b|rapidshare|zap\.to|@/i;

function looksLikeGarbage(str) {
  if (!str || !str.trim()) return true;
  return GARBAGE_TEXT_PATTERN.test(str);
}

function hasTrustedArtist(row) {
  return Boolean(row.artist && row.artist.trim() && !looksLikeGarbage(row.artist));
}

/**
 * Pulls whatever signal a messy filename actually has: a leading track
 * number/year prefix ("1980_02_...") stripped off but the year kept, a
 * trailing lone digit ("... 1") that's almost always a rip's de-dupe suffix
 * rather than part of the title, and separator characters normalized to
 * spaces. Deliberately doesn't try to label which remaining word is the
 * artist vs. the title — iTunes's own search ranking handles word order
 * fine once the noise around the real words is gone.
 */
function parseFilenameHints(filePath) {
  let base = path.basename(filePath, path.extname(filePath));

  // Not `\b(19|20)\d{2}\b`: \b is a \w/\W boundary, and an underscore is a
  // \w character, so "1980_02" would never match at the trailing edge — a
  // digit-based lookaround boundary instead of \b handles that separator.
  let year = null;
  const yearMatch = base.match(/(?<!\d)(19|20)\d{2}(?!\d)/);
  if (yearMatch) year = parseInt(yearMatch[0], 10);

  // Strip up to two leading numeric groups (track number, and/or a leading
  // year+tracknum pair like "1980_02_") separated by _/-/./space.
  for (let i = 0; i < 2; i += 1) {
    base = base.replace(/^\s*\d{1,4}[_\-.\s]+/, "");
  }
  // A lone 1-2 digit trailing token is almost always a duplicate/part marker
  // a ripper appended, not part of the title.
  base = base.replace(/[_\-\s]+\d{1,2}$/, "");

  const cleaned = base
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { cleaned, year };
}

function filenameToSearchTerm(filePath) {
  return parseFilenameHints(filePath).cleaned;
}

function buildSearchTerm(row) {
  if (hasTrustedArtist(row)) {
    return `${row.artist} ${row.title || filenameToSearchTerm(row.path)}`.trim();
  }
  const { cleaned, year } = parseFilenameHints(row.path);
  return year ? `${cleaned} ${year}` : cleaned;
}

function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Simple, pragmatic match: not a fuzzy-match library, just a case/punctuation
 * -insensitive substring check either direction — deliberately loose, since
 * this only ever fills in *missing* data (never overwrites a real local tag),
 * so a slightly-off genre/album is lower stakes than being too strict and
 * leaving everything unenriched. */
function isGoodMatch(row, result) {
  if (hasTrustedArtist(row)) {
    const localArtist = normalize(row.artist);
    const resultArtist = normalize(result.artistName);
    if (!resultArtist) return false;
    return resultArtist.includes(localArtist) || localArtist.includes(resultArtist);
  }
  // Word-based rather than one contiguous slice: a filename like "Title -
  // Artist" and an API result ordered artist/track/album have the same
  // words in a different order, so requiring one unbroken substring match
  // (spanning across that reordering) would almost never hit. Requiring
  // most individual words to appear somewhere is order-independent.
  const { cleaned } = parseFilenameHints(row.path);
  const words = cleaned
    .split(/\s+/)
    .map(normalize)
    .filter((w) => w.length > 1);
  if (words.length === 0) return false;
  const candidate = normalize(`${result.artistName || ""}${result.trackName || ""}${result.collectionName || ""}`);
  const matched = words.filter((w) => candidate.includes(w)).length;
  return matched / words.length >= 0.6;
}

/** Among several results that all pass isGoodMatch, prefer the one whose
 * release year is closest to a year pulled from the filename — cheap
 * disambiguation for compilation re-releases, greatest-hits reissues, etc. */
function pickBestMatch(row, results) {
  const candidates = results.filter((result) => isGoodMatch(row, result));
  if (candidates.length <= 1) return candidates[0];

  const { year: hintYear } = parseFilenameHints(row.path);
  if (!hintYear) return candidates[0];

  return candidates.reduce((best, candidate) => {
    const candidateYear = candidate.releaseDate ? new Date(candidate.releaseDate).getFullYear() : null;
    const bestYear = best.releaseDate ? new Date(best.releaseDate).getFullYear() : null;
    if (!Number.isFinite(candidateYear)) return best;
    if (!Number.isFinite(bestYear)) return candidate;
    return Math.abs(candidateYear - hintYear) < Math.abs(bestYear - hintYear) ? candidate : best;
  }, candidates[0]);
}

function resultToTags(result) {
  let year = null;
  if (result.releaseDate) {
    const parsedYear = new Date(result.releaseDate).getFullYear();
    if (Number.isFinite(parsedYear)) year = parsedYear;
  }
  return {
    title: result.trackName || null,
    artist: result.artistName || null,
    album: result.collectionName || null,
    genre: result.primaryGenreName || null,
    year,
  };
}

/**
 * Continuously drains rows with enrichment_status = 'pending' at a slow,
 * fixed pace. The `files` table itself is the queue (no separate structure
 * needed, and it survives restarts for free). fetchFn is injectable so tests
 * never make a real network call.
 */
function createEnrichmentQueue({ db, fetchFn = globalThis.fetch, intervalMs = DEFAULT_INTERVAL_MS }) {
  const state = { processed: 0, enriched: 0, notFound: 0, lastError: null };
  let timer = null;
  let busy = false;

  async function searchITunes(term) {
    const url = `${ITUNES_SEARCH_URL}?media=music&entity=song&limit=5&term=${encodeURIComponent(term)}`;
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`iTunes Search API returned ${response.status}`);
    const data = await response.json();
    return Array.isArray(data.results) ? data.results : [];
  }

  async function processOne() {
    if (busy) return { processed: false };
    busy = true;
    try {
      const [row] = db.getEnrichmentBacklog(1);
      if (!row) return { processed: false };

      let results;
      try {
        results = await searchITunes(buildSearchTerm(row));
      } catch (err) {
        // Network-level failure — leave it pending for a later retry rather
        // than burning a terminal "not_found" on a transient problem.
        state.lastError = err.message;
        return { processed: false, error: err.message };
      }

      // Reaching here means the search itself succeeded — clear out any
      // earlier transient failure rather than leaving it displayed forever.
      state.lastError = null;

      let match = pickBestMatch(row, results);
      let tags = match ? resultToTags(match) : null;

      // Text search found nothing — try identifying the actual audio via
      // AcoustID fingerprinting instead, if it's configured (see acoustId.js;
      // a no-op with no API key/fpcalc installed, same as today's behavior).
      if (!tags) {
        tags = await identifyByFingerprint(row.path);
      }

      state.processed += 1;
      if (tags) {
        db.markEnriched(row.id, tags);
        state.enriched += 1;
        writeTagsForRow(row, tags).catch((err) => {
          state.lastError = `Tag write-back failed for ${row.path}: ${err.message}`;
        });
      } else {
        db.markNotFound(row.id);
        state.notFound += 1;
      }
      return { processed: true, matched: Boolean(tags) };
    } finally {
      busy = false;
    }
  }

  function start() {
    timer = setInterval(processOne, intervalMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  function getState() {
    return { ...state, backlogSize: db.getStats().enrichmentCounts.pending || 0, intervalMs };
  }

  return { start, stop, processOne, getState };
}

module.exports = {
  createEnrichmentQueue,
  buildSearchTerm,
  filenameToSearchTerm,
  parseFilenameHints,
  looksLikeGarbage,
  isGoodMatch,
  pickBestMatch,
  resultToTags,
};

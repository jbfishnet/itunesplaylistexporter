const path = require("path");
const mm = require("music-metadata");

/**
 * Reads embedded audio tags from a file. Isolates the music-metadata
 * dependency behind this module — nothing else in the codebase imports it
 * directly, same reason src/musicLibrary.js is the only place that knows
 * about AppleScript.
 *
 * Never throws: a missing/unreadable/corrupt file resolves to
 * `{ ok: false, error }` rather than rejecting, so one bad file in a library
 * scan can never abort the whole batch — the caller still indexes the file
 * by its path/filename with parse_status "unreadable".
 */
async function readTags(filePath) {
  const extension = path.extname(filePath).replace(".", "").toLowerCase();
  // .m4p is Apple's FairPlay-DRM audio container — the audio stream itself
  // is encrypted, but the file is never worth attempting to play/export, so
  // it's flagged protected purely by extension, same signal src/trackStatus.js
  // treats as authoritative (kind strings are localized and unreliable; a
  // raw filesystem crawl has no "kind" string available at all anyway).
  const protectedByExtension = extension === "m4p";

  try {
    const meta = await mm.parseFile(filePath, { duration: true, skipCovers: true });
    const common = meta.common || {};
    return {
      ok: true,
      error: null,
      title: common.title || null,
      artist: common.artist || null,
      album: common.album || null,
      genre: Array.isArray(common.genre) ? common.genre[0] || null : common.genre || null,
      year: common.year || null,
      trackNo: (common.track && common.track.no) || null,
      durationSec: (meta.format && meta.format.duration) || null,
      protected: protectedByExtension,
      extension,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      title: null,
      artist: null,
      album: null,
      genre: null,
      year: null,
      trackNo: null,
      durationSec: null,
      protected: protectedByExtension,
      extension,
    };
  }
}

module.exports = { readTags };

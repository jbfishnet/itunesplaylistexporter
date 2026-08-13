const fs = require("fs");
const crypto = require("crypto");

// Local disk/NAS I/O + CPU hashing, not a rate-limited external API — no
// reason to throttle as gently as the enrichment queue does for Apple's
// search endpoint. Still paced a little so a big backlog after a fresh scan
// doesn't peg the NAS link the enrichment queue and playlist AppleScript
// calls are also sharing.
const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_BATCH_SIZE = 3;

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Continuously settles every file's hash_status: a file whose size doesn't
 * collide with any other file's can't be a byte-identical duplicate of
 * anything, so it's marked 'not_needed' without ever being read; only
 * files that DO share a size with something else get actually hashed. The
 * `files` table is the queue (hash_status = 'pending'), same pattern as
 * enrichmentQueue.js.
 */
function createDuplicateFinder({ db, intervalMs = DEFAULT_INTERVAL_MS, batchSize = DEFAULT_BATCH_SIZE }) {
  const state = { hashed: 0, skipped: 0, errors: 0, lastError: null };
  let timer = null;
  let busy = false;

  async function processBatch() {
    if (busy) return { processed: false };
    busy = true;
    try {
      const candidates = db.getHashCandidates(batchSize);
      if (candidates.length === 0) return { processed: false };

      for (const row of candidates) {
        if (!db.hasOtherFileWithSameSize(row.id, row.size)) {
          db.setHashStatus(row.id, "not_needed");
          state.skipped += 1;
          continue;
        }
        try {
          const hash = await hashFile(row.path);
          db.setHashDone(row.id, hash);
          state.hashed += 1;
        } catch (err) {
          // Unreadable/vanished file — settle it as 'error' rather than
          // retrying it forever and starving every other candidate behind
          // it; a future scan will either remove the row (file gone) or
          // reset it back to 'pending' (file changed) on its own.
          db.setHashStatus(row.id, "error");
          state.errors += 1;
          state.lastError = `${row.path}: ${err.message}`;
        }
      }
      return { processed: true, count: candidates.length };
    } finally {
      busy = false;
    }
  }

  function start() {
    timer = setInterval(processBatch, intervalMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  function getState() {
    return { ...state };
  }

  return { start, stop, processBatch, getState };
}

module.exports = { createDuplicateFinder, hashFile };

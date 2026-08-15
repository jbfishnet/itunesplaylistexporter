const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { readTags: defaultReadTags } = require("./tagReader");
const { isPlaceholderAlbum } = require("./metadataPlaceholders");

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "m4p", "flac", "wav", "aiff", "aif", "ogg"]);

// A NAS share over SMB has real per-file round-trip latency, so scanning one
// file at a time wastes huge wall-clock time on a library with tens of
// thousands of files. Wide enough to hide that latency, conservative enough
// not to hammer a consumer NAS's SMB daemon — same reasoning as the
// PREFETCH_CONCURRENCY constant in public/app.js.
const SCAN_CONCURRENCY = 4;

/** Does this file's metadata look sparse enough to be worth an internet lookup? */
function decideNeedsEnrichment(tags) {
  const artist = (tags.artist || "").trim();
  const album = (tags.album || "").trim();
  const genre = (tags.genre || "").trim();
  if (!artist) return true;
  if (!album || isPlaceholderAlbum(album)) return true;
  if (!genre) return true;
  return false;
}

function isAudioFile(name) {
  const ext = path.extname(name).replace(".", "").toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

/**
 * Directory walk collecting every audio file path under root, with up to
 * `concurrency` directory reads in flight at once. A real NAS archive can
 * have thousands of top-level folders (this one has ~2,500 artist folders),
 * and a purely sequential walk over SMB — each readdir() waiting on the
 * previous one — turned out in practice to take minutes with zero visible
 * progress before a single file was even found. Overlapping directory reads
 * the same way tag-reading already overlaps file reads fixes that.
 *
 * A subdirectory that can't be read (permissions, a transient SMB hiccup) is
 * recorded as an error and skipped rather than aborting the whole walk — one
 * bad folder shouldn't block indexing everything else.
 */
function walkAudioFiles(root, { concurrency = SCAN_CONCURRENCY, onProgress = () => {} } = {}) {
  const files = [];
  const errors = [];
  const stack = [root];
  let pending = 0;
  let dirsScanned = 0;

  return new Promise((resolve) => {
    function finishIfDone() {
      if (stack.length === 0 && pending === 0) resolve({ files, errors });
    }

    function spawnMore() {
      while (stack.length > 0 && pending < concurrency) {
        const dir = stack.pop();
        pending += 1;
        fsPromises
          .readdir(dir, { withFileTypes: true })
          .then((entries) => {
            for (const entry of entries) {
              if (entry.name.startsWith(".")) continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) stack.push(fullPath);
              else if (entry.isFile() && isAudioFile(entry.name)) files.push(fullPath);
            }
          })
          .catch((err) => {
            errors.push({ path: dir, message: err.message });
          })
          .finally(() => {
            pending -= 1;
            dirsScanned += 1;
            onProgress({ phase: "walking", dirsScanned, filesFound: files.length });
            spawnMore();
            finishIfDone();
          });
      }
    }

    spawnMore();
    finishIfDone(); // covers the (rare) case root itself was never pushed/immediately empty
  });
}

/** Walks and diffs a single root against the index, tagging new/changed
 * files — everything runScan() does for one folder, without touching
 * scan_meta or the cross-root deletion sweep (runScan owns those, since
 * they apply once per *cycle*, not once per root). */
async function scanOneRoot(root, { db, readTags, concurrency, onProgress, scanId }) {
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    rootStat = null;
  }
  if (!rootStat?.isDirectory()) {
    return { result: "root_missing", filesTotal: 0, filesNew: 0, filesChanged: 0, filesUnchanged: 0, errors: [] };
  }

  const { files, errors } = await walkAudioFiles(root, { concurrency, onProgress });
  onProgress({ phase: "walked", filesTotal: files.length, filesProcessed: 0 });

  // Async + concurrency-bounded rather than a plain for-loop of statSync:
  // stat-ing thousands of files one at a time, synchronously, blocked the
  // Node event loop for the whole diffing phase — any concurrent request (a
  // status/browse poll from an open tab) would just queue up behind it.
  let filesUnchanged = 0;
  const toTag = [];
  {
    let statCursor = 0;
    async function statWorker() {
      while (statCursor < files.length) {
        const filePath = files[statCursor];
        statCursor += 1;

        let stat;
        try {
          stat = await fsPromises.stat(filePath);
        } catch (err) {
          errors.push({ path: filePath, message: err.message });
          continue;
        }
        const existing = db.getFileByPath(filePath);
        if (!existing) {
          toTag.push({ filePath, stat, isNew: true });
        } else if (existing.size !== stat.size || existing.mtime_ms !== stat.mtimeMs) {
          toTag.push({ filePath, stat, isNew: false });
        } else {
          db.markSeen(existing.id, scanId);
          filesUnchanged += 1;
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, statWorker));
  }

  let filesNew = 0;
  let filesChanged = 0;
  let processed = filesUnchanged;
  onProgress({ phase: "tagging", filesTotal: files.length, filesProcessed: processed });

  let cursor = 0;
  async function worker() {
    while (cursor < toTag.length) {
      const item = toTag[cursor];
      cursor += 1;

      const tags = await readTags(item.filePath);
      db.upsertFile({
        path: item.filePath,
        size: item.stat.size,
        mtimeMs: item.stat.mtimeMs,
        extension: tags.extension,
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        genre: tags.genre,
        year: tags.year,
        trackNo: tags.trackNo,
        durationSec: tags.durationSec,
        protected: tags.protected,
        parseStatus: tags.ok ? "ok" : "unreadable",
        enrichmentStatus: decideNeedsEnrichment(tags) ? "pending" : "skipped_had_tags",
        scanId,
      });

      if (item.isNew) filesNew += 1;
      else filesChanged += 1;
      processed += 1;
      onProgress({ phase: "tagging", filesTotal: files.length, filesProcessed: processed });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  return {
    result: errors.length > 0 ? "error" : "ok",
    filesTotal: files.length,
    filesNew,
    filesChanged,
    filesUnchanged,
    errors,
  };
}

/**
 * Runs one incremental scan of every configured root into `db`, sharing a
 * single scanId across all of them — a file is only "not seen this cycle"
 * (and therefore eligible for deletion) once every configured root has been
 * walked, not just one. `roots`/`db` are always passed in explicitly (never
 * read from environment/globals inside this module) so tests can point this
 * at fabricated temp directories instead of a real NAS mount.
 *
 * Safety invariant: if ANY root is missing/unmounted, or ANY root has a
 * subdirectory that failed to read, the deletion sweep is skipped entirely
 * for this whole cycle — a temporarily-unmounted NAS folder must never look
 * like "every file under it was deleted," and skipping the sweep only when
 * *that* root had trouble would still wrongly sweep its own files (the
 * sweep isn't scoped per-root, so this errs conservative instead).
 */
async function runScan({ roots, db, readTags = defaultReadTags, concurrency = SCAN_CONCURRENCY, onProgress = () => {} }) {
  const scanId = Date.now();
  db.setMeta("last_scan_started_at", new Date().toISOString());

  const perRoot = [];
  for (const root of roots) {
    const result = await scanOneRoot(root, {
      db,
      readTags,
      concurrency,
      onProgress: (progress) => onProgress({ ...progress, root }),
      scanId,
    });
    perRoot.push({ root, ...result });
  }

  const anyRootMissing = perRoot.some((r) => r.result === "root_missing");
  const allErrors = perRoot.flatMap((r) => r.errors);
  const hadErrors = allErrors.length > 0;
  // No roots configured at all is the same kind of "can't verify anything"
  // situation as a missing root, not "the whole library is now empty" — an
  // empty scanId match-set would otherwise sweep every existing row.
  const skipDeletionSweep = roots.length === 0 || anyRootMissing || hadErrors;

  const filesRemoved = skipDeletionSweep ? 0 : db.deleteFilesNotSeenInScan(scanId);

  let overallResult;
  if (roots.length === 0) overallResult = "no_roots_configured";
  else if (perRoot.every((r) => r.result === "root_missing")) overallResult = "root_missing";
  else if (anyRootMissing) overallResult = "partial_root_missing";
  else if (hadErrors) overallResult = "error";
  else overallResult = "ok";

  db.setMeta("last_scan_result", overallResult);
  db.setMeta("last_scan_finished_at", new Date().toISOString());

  return {
    result: overallResult,
    filesTotal: perRoot.reduce((sum, r) => sum + r.filesTotal, 0),
    filesNew: perRoot.reduce((sum, r) => sum + r.filesNew, 0),
    filesChanged: perRoot.reduce((sum, r) => sum + r.filesChanged, 0),
    filesUnchanged: perRoot.reduce((sum, r) => sum + r.filesUnchanged, 0),
    filesRemoved,
    errors: allErrors,
    roots: perRoot.map(({ root, result }) => ({ root, result })),
  };
}

module.exports = { runScan, decideNeedsEnrichment, AUDIO_EXTENSIONS };

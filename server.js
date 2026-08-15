const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// Local secrets (e.g. ACOUSTID_API_KEY) live in a gitignored .env file rather
// than being duplicated across npm start / the LaunchAgent plist / the native
// app's Process environment — every one of those just runs `node server.js`
// from this directory, so loading it here covers all of them from one place.
// Deliberately not a real parser (no quoting/escaping/multiline support) —
// KEY=value per line is all this app has ever needed.
try {
  const envContent = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
  }
} catch {
  // no .env file — fine, nothing to load
}

// Swappable only for tests (see test/playlist-restore-routes.test.js): the
// restore routes below are the only code in this app that writes to the
// user's real Music.app library, and that can't be exercised against a real
// Music.app in CI — a test fixture can point this at a fake implementation
// instead via PLE_TEST_MUSIC_LIBRARY. Every other route keeps talking to the
// real musicLibrary module exactly as before.
const musicLibrary = process.env.PLE_TEST_MUSIC_LIBRARY
  ? require(path.resolve(process.env.PLE_TEST_MUSIC_LIBRARY))
  : require("./src/musicLibrary");
const trackStatus = require("./src/trackStatus");
const folderPicker = require("./src/folderPicker");
const exporter = require("./src/exporter");
const playlistRestorer = require("./src/playlistRestorer");
const { openLibraryDb } = require("./src/libraryDb");
const { createScheduler } = require("./src/libraryScheduler");
const { createEnrichmentQueue } = require("./src/enrichmentQueue");
const { createDuplicateFinder } = require("./src/duplicateFinder");

const LIBRARY_ROOT = process.env.PLE_LIBRARY_ROOT || "/Volumes/jb/iTunes4TB/iTunes Media/Music";
const LIBRARY_DB_PATH = process.env.PLE_LIBRARY_DB || path.join(__dirname, "data", "library.sqlite3");

// Last-resort safety net: this is a local utility app meant to run
// unattended through a whole export, so one overlooked edge case (a broken
// pipe, a stray rejection) should never take the entire process down. Log it
// and keep serving instead of crashing.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] keeping server alive:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection] keeping server alive:", err);
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/** Runs `fn` over `items` with at most `concurrency` in flight at once,
 * returning results in the same order as `items` regardless of which
 * finishes first. */
async function mapWithConcurrencyPreservingOrder(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function classifiedTracks(rawTracks) {
  return rawTracks.map((t) => {
    const { status, reason, extension } = trackStatus.classifyTrack(t);
    return { ...t, status, reason, extension };
  });
}

function isAutomationPermissionError(message) {
  return message.includes("-1743") || /not authorized/i.test(message);
}

app.get("/api/playlists", async (req, res) => {
  try {
    const playlists = await musicLibrary.listPlaylists();
    res.json(playlists);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      hint: isAutomationPermissionError(err.message)
        ? "Make sure Music.app is running and this app has been granted Automation " +
          "permission in System Settings > Privacy & Security > Automation."
        : undefined,
    });
  }
});

// Extensions a browser's <audio> element can actually play — deliberately
// excludes .m4p: those are DRM-protected and would just fail silently, so
// they're rejected here rather than handed to the client to discover.
const PLAYABLE_EXTENSIONS = new Set(["mp3", "m4a", "flac", "wav", "aiff", "aif", "ogg"]);

// Playlist tracks come from Music.app (via AppleScript), not the library
// index, so there's no row id to look up — just the absolute path Music.app
// reported. Validated by extension + actually existing as a regular file;
// the export feature already reads arbitrary paths Music.app hands us, so
// this isn't a new trust boundary for this local, single-user tool.
app.get("/api/audio", (req, res) => {
  const rawPath = req.query.path;
  if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) {
    return res.status(400).json({ error: "A valid absolute path is required" });
  }
  const resolved = path.normalize(rawPath);
  const ext = path.extname(resolved).slice(1).toLowerCase();
  if (!PLAYABLE_EXTENSIONS.has(ext)) {
    return res.status(400).json({ error: "This file type can't be previewed" });
  }
  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      res.status(404).json({ error: "File not found on disk" });
      return;
    }
    res.sendFile(resolved, (sendErr) => {
      if (sendErr && !res.headersSent) res.status(404).json({ error: "File not found on disk" });
    });
  });
});

// "Show in Finder" for a playlist track — path-based like /api/audio above,
// same absolute-path validation, but no extension allow-list: revealing a
// file's location doesn't read its contents, so any real file is fine.
app.post("/api/reveal", (req, res) => {
  const rawPath = req.body?.path;
  if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) {
    return res.status(400).json({ error: "A valid absolute path is required" });
  }
  const resolved = path.normalize(rawPath);
  fs.stat(resolved, (statErr) => {
    if (statErr) return res.status(404).json({ error: "File not found on disk" });
    folderPicker
      .revealInFinder(resolved)
      .then(() => res.json({ ok: true }))
      .catch((err) => res.status(500).json({ error: err.message }));
  });
});

app.get("/api/playlists/:id/tracks", async (req, res) => {
  try {
    const rawTracks = await musicLibrary.getPlaylistTracks(req.params.id);
    res.json(classifiedTracks(rawTracks));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function trackSummary(track, extra = {}) {
  return { position: track.position, musicAppId: track.musicAppId, title: track.title, artist: track.artist, ...extra };
}

function candidateSummary(file) {
  return { id: file.id, path: file.path, title: file.title, artist: file.artist, album: file.album };
}

// The first write path into the user's real Music library this app has ever
// had. For every currently-missing track: an exact (title+artist) local-index
// match is auto-applied (imported into the library + added to the playlist,
// then the broken entry removed) without asking; an ambiguous match is left
// for the client to resolve via /restore/apply; no local match at all gets an
// automatic Music.app download attempt, which may not be supported on every
// macOS/Music.app version (see musicLibrary.attemptDownload).
app.post("/api/playlists/:id/restore", async (req, res) => {
  const playlistId = req.params.id;
  try {
    const rawTracks = await musicLibrary.getPlaylistTracks(playlistId);
    const tracks = classifiedTracks(rawTracks);
    const { fixed, needsReview, noLocalMatch } = playlistRestorer.restorePlaylist({ tracks, libraryDb });

    const fixedResults = [];
    const needsReviewResults = needsReview.map(({ track, candidates }) =>
      trackSummary(track, { candidates: candidates.map(candidateSummary) })
    );

    for (const { track, file } of fixed) {
      try {
        await musicLibrary.addFileToPlaylist(playlistId, file.path);
        if (track.musicAppId) await musicLibrary.removeTrackFromPlaylist(playlistId, track.musicAppId);
        fixedResults.push(trackSummary(track, { matchedPath: file.path }));
      } catch (err) {
        // The write failed (Music.app busy, file went away, etc.) — fall back
        // to surfacing it as reviewable rather than silently dropping it.
        needsReviewResults.push(trackSummary(track, { candidates: [candidateSummary(file)], error: err.message }));
      }
    }

    const downloading = [];
    const unsupported = [];
    for (const track of noLocalMatch) {
      if (!track.musicAppId) {
        unsupported.push(trackSummary(track, { reason: "No Music.app track reference available" }));
        continue;
      }
      try {
        await musicLibrary.attemptDownload(playlistId, track.musicAppId);
        downloading.push(trackSummary(track));
      } catch (err) {
        unsupported.push(trackSummary(track, { reason: err.message }));
      }
    }

    res.json({
      fixed: fixedResults,
      needsReview: needsReviewResults,
      downloading,
      unsupported,
      libraryIndexAvailable: Boolean(libraryDb),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Applies a specific candidate the user picked for one ambiguous match from
// the /restore response above.
app.post("/api/playlists/:id/restore/apply", async (req, res) => {
  const playlistId = req.params.id;
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });

  const fileId = parseInt(req.body?.fileId, 10);
  const trackMusicAppId = req.body?.trackMusicAppId;
  if (!Number.isFinite(fileId)) return res.status(400).json({ error: "fileId is required" });

  const file = libraryDb.getById(fileId);
  if (!file) return res.status(404).json({ error: "File not found in the index" });

  try {
    await musicLibrary.addFileToPlaylist(playlistId, file.path);
    if (trackMusicAppId) await musicLibrary.removeTrackFromPlaylist(playlistId, trackMusicAppId);
    res.json({ applied: true, path: file.path });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/choose-folder", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").toString().trim() || "Choose where to export your playlists";
    const chosenPath = await folderPicker.chooseFolder(prompt);
    if (!chosenPath) {
      res.json({ path: null }); // user clicked Cancel
      return;
    }
    const free = await folderPicker.freeSpaceLabel(chosenPath);
    res.json({ path: chosenPath, free });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/export", async (req, res) => {
  try {
    const { playlistIds, destination } = req.body;
    if (!Array.isArray(playlistIds) || playlistIds.length === 0) {
      return res.status(400).json({ error: "playlistIds is required" });
    }
    if (!destination || typeof destination !== "string") {
      return res.status(400).json({ error: "destination is required" });
    }

    const allPlaylists = await musicLibrary.listPlaylists();
    const byId = new Map(allPlaylists.map((p) => [p.id, p]));
    const knownIds = playlistIds.filter((id) => byId.has(String(id)));

    // Fetched with a small concurrency cap rather than serially — each
    // playlist's tracks is its own AppleScript round-trip (seconds to
    // minutes), so exporting several playlists no longer means waiting out
    // every one of those round-trips back-to-back before the export even
    // starts. Capped rather than fully parallel: too many concurrent
    // AppleScript calls is what overloads Music.app in the first place (see
    // the in-flight coalescing in musicLibrary.js) — 2 mirrors the same cap
    // already used for background track prefetching in public/app.js.
    const playlists = await mapWithConcurrencyPreservingOrder(knownIds, 2, async (id) => {
      const meta = byId.get(String(id));
      const rawTracks = await musicLibrary.getPlaylistTracks(id);
      return { name: meta.name, tracks: classifiedTracks(rawTracks) };
    });

    const jobId = exporter.startExportJob({ playlists, destinationRoot: destination });
    res.json({ jobId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/export/:jobId/stream", (req, res) => {
  const job = exporter.getJob(req.params.jobId);
  if (!job) {
    res.status(404).end();
    return;
  }

  // Defensive: if a client disconnects mid-stream and res.write() ever fails
  // (some Node versions/conditions throw, or emit an unhandled "error" with
  // no listener attached), that would crash the whole process since this
  // runs inside an EventEmitter callback with nothing above it to catch it.
  const safeWrite = (chunk) => {
    try {
      res.write(chunk);
      return true;
    } catch {
      job.emitter.off("event", onEvent);
      return false;
    }
  };
  res.on("error", () => job.emitter.off("event", onEvent));

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Replay whatever already happened before this client subscribed — a fast
  // export can finish before the SSE connection is even opened.
  for (const event of job.events) {
    if (!safeWrite(`data: ${JSON.stringify(event)}\n\n`)) break;
  }
  if (job.done) {
    res.end();
    return;
  }

  function onEvent(event) {
    if (!safeWrite(`data: ${JSON.stringify(event)}\n\n`)) return;
    if (event.type === "done") {
      job.emitter.off("event", onEvent);
      res.end();
    }
  }

  job.emitter.on("event", onEvent);
  req.on("close", () => job.emitter.off("event", onEvent));
});

// The library index/scan/enrichment are independent of Music.app/playlists —
// fully additive, and guarded so tests that only need the export/SSE routes
// don't also trigger a real filesystem crawl and hourly timers on require().
let libraryDb = null;
let libraryScheduler = null;
let enrichmentQueue = null;
let duplicateFinder = null;

if (!process.env.PLE_NO_LIBRARY_SCAN) {
  libraryDb = openLibraryDb(LIBRARY_DB_PATH);

  // First-ever run of this app version: seed the persisted roots list from
  // the old single-path env var so upgrading doesn't silently stop indexing
  // anything. Once set, the DB (editable via the Library Folders UI) is the
  // only source of truth — LIBRARY_ROOT is never consulted again after this.
  if (libraryDb.getLibraryRoots() === null) {
    libraryDb.setLibraryRoots([LIBRARY_ROOT]);
  }

  libraryScheduler = createScheduler({ db: libraryDb });
  enrichmentQueue = createEnrichmentQueue({ db: libraryDb });
  duplicateFinder = createDuplicateFinder({ db: libraryDb });
  libraryScheduler.start();
  enrichmentQueue.start();
  duplicateFinder.start();
}

app.get("/api/library/search", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  const q = (req.query.q || "").toString();
  if (!q.trim()) return res.status(400).json({ error: "q is required" });
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 200);
  try {
    const results = libraryDb.search(q, limit).map((row) => ({
      id: row.id,
      title: row.title,
      artist: row.artist,
      album: row.album,
      genre: row.genre,
      year: row.year,
      path: row.path,
      extension: row.extension,
      protected: Boolean(row.protected),
      enrichmentStatus: row.enrichment_status,
    }));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/library/browse", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const year = req.query.year ? parseInt(req.query.year, 10) : undefined;

    const { rows, total } = libraryDb.browse({
      title: req.query.title,
      artist: req.query.artist,
      album: req.query.album,
      genre: req.query.genre,
      extension: req.query.extension,
      status: req.query.status,
      protected: req.query.protected,
      year,
      limit,
      offset,
      sortColumn: req.query.sort,
      sortDir: req.query.dir,
    });

    res.json({
      total,
      limit,
      offset,
      rows: rows.map((row) => ({
        id: row.id,
        title: row.title,
        artist: row.artist,
        album: row.album,
        genre: row.genre,
        year: row.year,
        path: row.path,
        extension: row.extension,
        protected: Boolean(row.protected),
        enrichmentStatus: row.enrichment_status,
        enrichedAt: row.enriched_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/library/audio/:id", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid file id" });

  const row = libraryDb.getById(id);
  if (!row) return res.status(404).json({ error: "File not found in the index" });
  if (row.protected) return res.status(403).json({ error: "This file is DRM-protected and can't be previewed" });

  fs.stat(row.path, (err, stat) => {
    if (err || !stat.isFile()) {
      res.status(404).json({ error: "File no longer exists on disk — try rescanning" });
      return;
    }
    res.sendFile(row.path, (sendErr) => {
      if (sendErr && !res.headersSent) res.status(404).json({ error: "File not found on disk" });
    });
  });
});

// "Show in Finder" for an indexed row — id-based like the audio route above,
// no path from the client at all. Not gated on `protected`: revealing a
// DRM file's location is harmless, it just doesn't read the file.
app.post("/api/library/reveal/:id", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid file id" });

  const row = libraryDb.getById(id);
  if (!row) return res.status(404).json({ error: "File not found in the index" });

  fs.stat(row.path, (statErr) => {
    if (statErr) return res.status(404).json({ error: "File no longer exists on disk — try rescanning" });
    folderPicker
      .revealInFinder(row.path)
      .then(() => res.json({ ok: true }))
      .catch((err) => res.status(500).json({ error: err.message }));
  });
});

app.get("/api/library/facets", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  try {
    res.json(libraryDb.getFacets());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/library/status", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  const stats = libraryDb.getStats();
  const scanState = libraryScheduler.getState();
  const enrichState = enrichmentQueue.getState();
  res.json({
    totalFiles: stats.totalFiles,
    enrichmentCounts: stats.enrichmentCounts,
    lastScanAt: scanState.lastScanAt,
    lastScanResult: scanState.lastResult?.result || stats.lastScanResult,
    nextScanAt: scanState.nextScanAt,
    scanRunning: scanState.running,
    scanPhase: scanState.phase,
    dirsScanned: scanState.dirsScanned,
    filesFound: scanState.filesFound,
    filesTotal: scanState.filesTotal,
    filesProcessed: scanState.filesProcessed,
    enrichmentBacklogSize: enrichState.backlogSize,
    enrichmentProcessed: enrichState.processed,
    enrichmentEnriched: enrichState.enriched,
    enrichmentNotFound: enrichState.notFound,
    enrichmentIntervalMs: enrichState.intervalMs,
    enrichmentLastError: enrichState.lastError,
    duplicatesHashed: duplicateFinder?.getState().hashed || 0,
  });
});

app.post("/api/library/rescan", (req, res) => {
  if (!libraryScheduler) return res.status(503).json({ error: "Library index is disabled" });
  res.json(libraryScheduler.triggerNow());
});

app.post("/api/library/requeue-not-found", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  const requeued = libraryDb.requeueNotFound();
  res.json({ requeued });
});

// A basic categorical palette for telling library folders apart at a
// glance (Library Folders panel, and which folder a duplicate copy lives
// in) — deliberately distinct hues from the semantic colors already in use
// elsewhere (--accent orange, --success green, --warning gold, --danger
// red), so a folder's color is never mistaken for a status indicator.
const FOLDER_COLORS = ["#5b8dd6", "#a56bd6", "#d65b93", "#4f9bb0", "#6b7ad6", "#5bb0a0"];

function colorForRootIndex(index) {
  return FOLDER_COLORS[index % FOLDER_COLORS.length];
}

/** Which configured root (by index) a file path lives under, or -1 if none
 * match — e.g. a file whose root was just removed but not yet swept by the
 * next scan. Prefix-matched on a path separator boundary so a root like
 * "/a/b" doesn't wrongly match a sibling folder "/a/bc". */
function findRootIndexForPath(filePath, roots) {
  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i];
    if (filePath === root || filePath.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
      return i;
    }
  }
  return -1;
}

function rootsWithMountStatus() {
  const roots = libraryDb.getLibraryRoots() || [];
  return roots.map((root, index) => {
    let mounted = false;
    try {
      mounted = fs.statSync(root).isDirectory();
    } catch {
      mounted = false;
    }
    return { path: root, mounted, color: colorForRootIndex(index) };
  });
}

app.get("/api/library/roots", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  res.json({ roots: rootsWithMountStatus() });
});

app.post("/api/library/roots", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  const newRoot = (req.body?.path || "").toString().trim();
  if (!newRoot) return res.status(400).json({ error: "path is required" });
  if (!path.isAbsolute(newRoot)) return res.status(400).json({ error: "path must be absolute" });

  const roots = libraryDb.getLibraryRoots() || [];
  if (roots.includes(newRoot)) return res.status(409).json({ error: "That folder is already in the list" });

  libraryDb.setLibraryRoots([...roots, newRoot]);
  libraryScheduler?.triggerNow(); // pick up the new folder right away rather than waiting for the hourly scan
  res.json({ roots: rootsWithMountStatus() });
});

app.delete("/api/library/roots", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  const targetRoot = (req.body?.path || "").toString().trim();
  if (!targetRoot) return res.status(400).json({ error: "path is required" });

  const roots = libraryDb.getLibraryRoots() || [];
  const updated = roots.filter((r) => r !== targetRoot);
  if (updated.length === roots.length) return res.status(404).json({ error: "That folder isn't in the list" });

  libraryDb.setLibraryRoots(updated);
  libraryScheduler?.triggerNow(); // sweeps files under the removed folder out of the index promptly
  res.json({ roots: rootsWithMountStatus() });
});

app.get("/api/library/duplicates", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { groups, total, totalFiles, extraFiles, reclaimableBytes } = libraryDb.getDuplicateGroups({ limit, offset });
  const roots = libraryDb.getLibraryRoots() || [];
  res.json({
    total,
    totalFiles,
    extraFiles,
    reclaimableBytes,
    limit,
    offset,
    groups: groups.map((g) => ({
      contentHash: g.contentHash,
      fileCount: g.fileCount,
      size: g.size,
      files: g.files.map((f) => {
        const rootIndex = findRootIndexForPath(f.path, roots);
        return {
          id: f.id,
          path: f.path,
          title: f.title,
          artist: f.artist,
          size: f.size,
          folderColor: rootIndex >= 0 ? colorForRootIndex(rootIndex) : null,
        };
      }),
    })),
  });
});

// The gentler, informational second detection method (see
// getSimilarTitleGroups in libraryDb.js): same title, but something else is
// different — no delete affordance here on purpose, since these aren't
// confirmed identical and could be a genuinely different recording.
app.get("/api/library/similar", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { total, groups } = libraryDb.getSimilarTitleGroups({ limit, offset });
  const roots = libraryDb.getLibraryRoots() || [];

  res.json({
    total,
    limit,
    offset,
    groups: groups.map((g) => ({
      title: g.title,
      diffFields: g.diffFields,
      files: g.files.map((f) => {
        const rootIndex = findRootIndexForPath(f.path, roots);
        return {
          id: f.id,
          path: f.path,
          title: f.title,
          artist: f.artist,
          album: f.album,
          genre: f.genre,
          year: f.year,
          extension: f.extension,
          size: f.size,
          durationSec: f.duration_sec,
          protected: Boolean(f.protected),
          folderColor: rootIndex >= 0 ? colorForRootIndex(rootIndex) : null,
        };
      }),
    })),
  });
});

// Deletes a file from disk AND the index — only ever for a file this
// process itself has independently confirmed still has a byte-identical
// twin in the index right now (see isPartOfDuplicateGroup), regardless of
// what the client claims. The disk delete happens first; the index row is
// only removed once that actually succeeds, so a failed unlink never
// leaves the index out of sync with what's really on disk.
app.delete("/api/library/files/:id", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid file id" });

  const row = libraryDb.getById(id);
  if (!row) return res.status(404).json({ error: "File not found in the index" });
  if (!libraryDb.isPartOfDuplicateGroup(id)) {
    return res.status(409).json({ error: "This file is no longer confirmed as a duplicate — refresh and try again" });
  }

  fs.unlink(row.path, (err) => {
    if (err && err.code !== "ENOENT") {
      res.status(500).json({ error: `Couldn't delete the file from disk: ${err.message}` });
      return;
    }
    // ENOENT (already gone) is fine — the index row is stale either way and should go.
    libraryDb.deleteFileRow(id);
    res.json({ deleted: true, path: row.path });
  });
});

// Similar Titles' delete path: unlike the exact-duplicate route above, these
// files were never confirmed byte-identical, so the guard here isn't "does
// a twin exist" but "is this NOT the keeper" — libraryDb.isDeletableSimilarFile
// re-derives the keeper (protected path, else oldest-indexed) from the
// current DB state on every call, same never-trust-the-client posture.
app.delete("/api/library/similar-files/:id", (req, res) => {
  if (!libraryDb) return res.status(503).json({ error: "Library index is disabled" });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid file id" });

  const row = libraryDb.getById(id);
  if (!row) return res.status(404).json({ error: "File not found in the index" });
  if (!libraryDb.isDeletableSimilarFile(id)) {
    return res.status(409).json({ error: "This file is the protected/kept copy, or no longer part of a similar-titles group — refresh and try again" });
  }

  fs.unlink(row.path, (err) => {
    if (err && err.code !== "ENOENT") {
      res.status(500).json({ error: `Couldn't delete the file from disk: ${err.message}` });
      return;
    }
    libraryDb.deleteFileRow(id);
    res.json({ deleted: true, path: row.path });
  });
});

const PORT = process.env.PORT || 4173;
const server = app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Playlist Exporter running at ${url}`);
  if (process.platform === "darwin" && !process.env.PLE_NO_OPEN) {
    execFile("open", [url], () => {});
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use — is another copy of this app already running?\n` +
        `Check with: lsof -i :${PORT}\n`
    );
    process.exit(1);
  }
  throw err;
});

module.exports = server;

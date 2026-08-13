const { runScan } = require("./libraryScanner");

const HOUR_MS = 60 * 60 * 1000;

/**
 * Owns the recurring hourly scan + its in-memory progress state, and
 * guarantees the hourly timer and a manual "rescan now" trigger can never
 * overlap and race each other's deletion sweep.
 *
 * Deliberately takes no fixed root/roots at construction time — it reads
 * db.getLibraryRoots() fresh at the start of every run, so adding or
 * removing a folder from the Library Folders UI takes effect on the very
 * next scan (hourly or manually triggered) without needing a server restart.
 */
function createScheduler({ db, intervalMs = HOUR_MS }) {
  const state = {
    running: false,
    phase: null,
    dirsScanned: 0,
    filesFound: 0,
    filesTotal: 0,
    filesProcessed: 0,
    lastScanAt: null,
    lastResult: null,
    nextScanAt: null,
  };

  let timer = null;

  async function runOnce() {
    if (state.running) return { started: false };
    state.running = true;
    state.phase = "starting";
    state.dirsScanned = 0;
    state.filesFound = 0;
    state.filesTotal = 0;
    state.filesProcessed = 0;

    try {
      const roots = db.getLibraryRoots() || [];
      const result = await runScan({
        roots,
        db,
        // "walking" progress reports dirsScanned/filesFound (still discovering
        // the file list); "tagging" progress reports filesTotal/filesProcessed
        // (list is final, working through it) — keep whichever fields a given
        // event actually carries rather than overwriting with undefined.
        onProgress: (progress) => {
          state.phase = progress.phase;
          if (progress.dirsScanned !== undefined) state.dirsScanned = progress.dirsScanned;
          if (progress.filesFound !== undefined) state.filesFound = progress.filesFound;
          if (progress.filesTotal !== undefined) state.filesTotal = progress.filesTotal;
          if (progress.filesProcessed !== undefined) state.filesProcessed = progress.filesProcessed;
        },
      });
      state.lastResult = result;
    } catch (err) {
      state.lastResult = { result: "error", errors: [{ path: "(scheduler)", message: err.message }] };
    } finally {
      state.running = false;
      state.phase = null;
      state.lastScanAt = new Date().toISOString();
      state.nextScanAt = new Date(Date.now() + intervalMs).toISOString();
    }
    return { started: true };
  }

  function start() {
    setImmediate(runOnce);
    timer = setInterval(runOnce, intervalMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  function triggerNow() {
    if (state.running) return { started: false, reason: "already running" };
    runOnce(); // fire and forget — caller polls getState() for progress
    return { started: true };
  }

  function getState() {
    return { ...state };
  }

  return { start, stop, triggerNow, getState };
}

module.exports = { createScheduler };

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");

// Characters forbidden on exFAT/FAT32 (the common formats for car head-unit
// SD/USB media), plus trailing dots/spaces which exFAT also rejects.
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

function sanitizeSegment(name) {
  const cleaned = name.replace(INVALID_CHARS, "-").trim().replace(/[.\s]+$/, "");
  return cleaned || "Untitled";
}

function buildBaseFilename(position, title, extension) {
  const prefix = String(position).padStart(2, "0");
  return `${prefix} - ${sanitizeSegment(title)}.${extension}`;
}

/** Appends " (2)", " (3)", ... before the extension until the name is free. */
function resolveCollision(usedNamesLowercase, baseName) {
  if (!usedNamesLowercase.has(baseName.toLowerCase())) {
    usedNamesLowercase.add(baseName.toLowerCase());
    return baseName;
  }
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, -ext.length);
  let n = 2;
  let candidate;
  do {
    candidate = `${stem} (${n}).${ext.replace(".", "")}`;
    n += 1;
  } while (usedNamesLowercase.has(candidate.toLowerCase()));
  usedNamesLowercase.add(candidate.toLowerCase());
  return candidate;
}

const jobs = new Map(); // jobId -> { emitter, events, done }

function getJob(jobId) {
  return jobs.get(jobId);
}

/**
 * playlists: [{ name, tracks: [{ position, title, location, extension, status }] }]
 * Only tracks with status "ready" are copied. Each playlist gets its own
 * folder directly under destinationRoot, named after the playlist.
 */
function startExportJob({ playlists, destinationRoot }) {
  const jobId = crypto.randomUUID();
  const emitter = new EventEmitter();
  const job = { emitter, events: [], done: false };
  jobs.set(jobId, job);

  const emit = (event) => {
    job.events.push(event);
    emitter.emit("event", event);
  };

  const queue = [];
  playlists.forEach((playlist) => {
    const folderName = sanitizeSegment(playlist.name);
    const readyTracks = playlist.tracks.filter((t) => t.status === "ready");
    readyTracks.forEach((track) => {
      queue.push({ playlistName: playlist.name, folderName, track });
    });
  });

  const total = queue.length;

  // Run asynchronously so the caller can return jobId immediately and the
  // client can subscribe to the SSE stream before the first event fires.
  setImmediate(async () => {
    emit({ type: "start", total });

    let copied = 0;
    let failed = 0;
    const usedNamesByFolder = new Map(); // folderName -> Set of lowercase filenames

    for (let i = 0; i < queue.length; i += 1) {
      const { playlistName, folderName, track } = queue[i];
      const destDir = path.join(destinationRoot, folderName);

      try {
        fs.mkdirSync(destDir, { recursive: true });
        if (!usedNamesByFolder.has(folderName)) {
          usedNamesByFolder.set(folderName, new Set());
        }
        const baseName = buildBaseFilename(track.position, track.title, track.extension);
        const finalName = resolveCollision(usedNamesByFolder.get(folderName), baseName);
        const destPath = path.join(destDir, finalName);

        await fs.promises.copyFile(track.location, destPath);
        copied += 1;

        emit({
          type: "file",
          index: i + 1,
          total,
          playlist: playlistName,
          fileName: finalName,
          ok: true,
        });
      } catch (err) {
        failed += 1;
        emit({
          type: "file",
          index: i + 1,
          total,
          playlist: playlistName,
          fileName: track.title,
          ok: false,
          error: err.message,
        });
      }
    }

    emit({ type: "done", total, copied, failed });
    job.done = true;
    // Give slow SSE consumers a moment to receive the final events, then clean up.
    setTimeout(() => jobs.delete(jobId), 60_000).unref();
  });

  return jobId;
}

module.exports = { startExportJob, getJob, sanitizeSegment, buildBaseFilename, resolveCollision };

const express = require("express");
const path = require("path");
const { execFile } = require("child_process");

const musicLibrary = require("./src/musicLibrary");
const trackStatus = require("./src/trackStatus");
const folderPicker = require("./src/folderPicker");
const exporter = require("./src/exporter");

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

function classifiedTracks(rawTracks) {
  return rawTracks.map((t) => {
    const { status, reason, extension } = trackStatus.classifyTrack(t);
    return { ...t, status, reason, extension };
  });
}

app.get("/api/playlists", async (req, res) => {
  try {
    const playlists = await musicLibrary.listPlaylists();
    res.json(playlists);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      hint:
        "Make sure Music.app is running and this app has been granted Automation " +
        "permission in System Settings > Privacy & Security > Automation.",
    });
  }
});

app.get("/api/playlists/:id/tracks", async (req, res) => {
  try {
    const rawTracks = await musicLibrary.getPlaylistTracks(req.params.id);
    res.json(classifiedTracks(rawTracks));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/choose-folder", async (req, res) => {
  try {
    const chosenPath = await folderPicker.chooseFolder("Choose where to export your playlists");
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

    const playlists = [];
    for (const id of playlistIds) {
      const meta = byId.get(String(id));
      if (!meta) continue;
      const rawTracks = await musicLibrary.getPlaylistTracks(id);
      playlists.push({ name: meta.name, tracks: classifiedTracks(rawTracks) });
    }

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

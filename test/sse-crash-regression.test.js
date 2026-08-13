// Regression test for the real bug behind "Application not running anymore":
// a client (browser tab, Safari's EventSource) disconnecting mid-export used
// to crash the *entire* Node process, because res.write() on a dead socket
// throws/emits "error" with nothing listening for it — an unhandled error
// that takes the whole server down, not just that one request.
//
// This starts the real server and proves a dropped SSE connection no longer
// kills it: the process must still answer requests afterwards.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.PORT = process.env.PORT || "4199";
process.env.PLE_NO_OPEN = "1"; // don't pop open a browser tab for a test run
process.env.PLE_NO_LIBRARY_SCAN = "1"; // this test only needs the export/SSE routes
const server = require("../server");

const exporter = require("../src/exporter");

const BASE_URL = `http://localhost:${process.env.PORT}`;

test("a client disconnecting mid-export-stream does not crash the server", async (t) => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ple-crash-source-"));
  const destRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-crash-dest-"));
  t.after(() => {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(destRoot, { recursive: true, force: true });
  });

  // Enough files that the job is still emitting events well after the first
  // one arrives client-side, giving us a real window to drop the connection
  // *during* the export rather than racing a fixed timer.
  const tracks = Array.from({ length: 20 }, (_, i) => {
    const filePath = path.join(sourceDir, `track-${i}.m4a`);
    fs.writeFileSync(filePath, `dummy-audio-${i}`);
    return { position: i + 1, title: `Track ${i + 1}`, location: filePath, extension: "m4a", status: "ready" };
  });

  const jobId = exporter.startExportJob({
    playlists: [{ name: "Crash Regression Test", tracks }],
    destinationRoot: destRoot,
  });

  const controller = new AbortController();
  const res = await fetch(`${BASE_URL}/api/export/${jobId}/stream`, { signal: controller.signal });
  const reader = res.body.getReader();
  await reader.read(); // wait for the "start" event — the job is now definitely still running

  controller.abort(); // simulate the browser tab/connection vanishing mid-export

  // Let the (still-running, server-side) export job keep emitting into the
  // now-dead connection for a bit — this is exactly what used to crash it.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const job = exporter.getJob(jobId);
  assert.ok(job, "export job should have kept running server-side after the client vanished");

  // The real assertion: the server process is still alive and serving.
  const healthCheck = await fetch(`${BASE_URL}/api/export/not-a-real-job-id/stream`);
  assert.equal(healthCheck.status, 404, "server should still respond normally after the dropped connection");
});

test.after(() => {
  server.closeAllConnections();
  server.close();
});

// Covers validation for the two "Show in Finder" endpoints. Deliberately
// does NOT exercise the real success path (folderPicker.revealInFinder
// actually shells out to `open -R`, which pops a real Finder window on this
// machine) — that's verified manually instead of on every test run.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FIXTURES = path.join(__dirname, "fixtures");
const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-reveal-root-"));
fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), path.join(libraryRoot, "tagged.mp3"));

process.env.PORT = process.env.PORT || "4195";
process.env.PLE_NO_OPEN = "1";
process.env.PLE_LIBRARY_ROOT = libraryRoot;
process.env.PLE_LIBRARY_DB = ":memory:";
const server = require("../server");

const BASE_URL = `http://localhost:${process.env.PORT}`;

test.after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(libraryRoot, { recursive: true, force: true });
});

test("POST /api/reveal rejects a missing or relative path", async () => {
  assert.equal((await fetch(`${BASE_URL}/api/reveal`, { method: "POST" })).status, 400);
  assert.equal(
    (
      await fetch(`${BASE_URL}/api/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "relative/tagged.mp3" }),
      })
    ).status,
    400
  );
});

test("POST /api/reveal 404s for a path that doesn't exist on disk", async () => {
  const res = await fetch(`${BASE_URL}/api/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: path.join(libraryRoot, "nope.mp3") }),
  });
  assert.equal(res.status, 404);
});

test("POST /api/library/reveal/:id rejects a non-numeric id and 404s for an unknown one", async () => {
  assert.equal((await fetch(`${BASE_URL}/api/library/reveal/not-a-number`, { method: "POST" })).status, 400);
  assert.equal((await fetch(`${BASE_URL}/api/library/reveal/999999999`, { method: "POST" })).status, 404);
});

// Covers the Not Found tab's AI-guess routes:
//   POST /api/library/not-found-files/:id/guess-metadata   (single file, never writes)
//   POST /api/library/not-found-files/guess-metadata       (bulk — auto-applies "high" confidence only)
//
// The real src/llmMetadataExtractor.js calls the Anthropic API, which a CI
// run has neither a key nor network access for — PLE_TEST_LLM_EXTRACTOR
// points at test/fixtures/fakeLlmMetadataExtractor.js instead, same
// dependency-injection pattern as PLE_TEST_MUSIC_LIBRARY / PLE_TEST_FILE_TRASH.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FIXTURES = path.join(__dirname, "fixtures");
const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-guess-root-"));
const dbPath = path.join(os.tmpdir(), `ple-guess-test-${Date.now()}.sqlite3`);

process.env.PORT = process.env.PORT || "4202";
process.env.PLE_NO_OPEN = "1";
process.env.PLE_LIBRARY_ROOT = libraryRoot;
process.env.PLE_LIBRARY_DB = dbPath;
process.env.PLE_TEST_LLM_EXTRACTOR = path.join(__dirname, "fixtures", "fakeLlmMetadataExtractor.js");
const server = require("../server");
const { openLibraryDb } = require("../src/libraryDb");
const fakeLlm = require("./fixtures/fakeLlmMetadataExtractor");

const BASE_URL = `http://localhost:${process.env.PORT}`;

// One long-lived connection for all seeding, reused across every test and
// closed only at the very end, rather than opening/closing a fresh one per
// seed call.
const seedDb = openLibraryDb(dbPath);

async function waitFor(checkFn, description) {
  for (let i = 0; i < 200; i += 1) {
    if (await checkFn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

function seedNotFoundFileFromFixture(destName, seedFields = {}) {
  const filePath = path.join(libraryRoot, destName);
  fs.copyFileSync(path.join(FIXTURES, "untagged.mp3"), filePath);
  const id = seedDb.upsertFile({
    path: filePath,
    size: fs.statSync(filePath).size,
    mtimeMs: Date.now(),
    extension: "mp3",
    title: null,
    artist: null,
    album: null,
    genre: null,
    enrichmentStatus: "not_found",
    scanId: 1,
    ...seedFields,
  });
  return { id, filePath };
}

// libraryScheduler runs one scan of PLE_LIBRARY_ROOT immediately on server
// startup (via setImmediate — see src/libraryScheduler.js), independent of
// its hourly timer. That scan's own completion sweep
// (deleteFilesNotSeenInScan) removes any row not stamped with *its* scanId
// — including rows this file seeds directly, if they're written while that
// first scan is still in flight. Waiting for it to finish once, before any
// seeding happens, avoids the race entirely: the scanner never runs again
// within this file's lifetime (next run is an hour out).
test.before(async () => {
  await waitFor(async () => {
    const res = await fetch(`${BASE_URL}/api/library/status`);
    const data = await res.json();
    return data.lastScanAt !== null;
  }, "the startup library scan to finish");
});

test.after(() => {
  server.closeAllConnections();
  server.close();
  seedDb.close();
  fs.rmSync(libraryRoot, { recursive: true, force: true });
  fs.rmSync(dbPath, { force: true });
});

test.beforeEach(() => fakeLlm.__reset());

test("POST .../:id/guess-metadata returns a suggestion without writing anything", async () => {
  const { id, filePath } = seedNotFoundFileFromFixture("guess1.mp3");
  fakeLlm.__setResult("guess1.mp3", {
    ok: true,
    suggestion: { title: "Guessed Title", artist: "Guessed Artist", album: "", genre: "", year: "", confidence: "high", reasoning: "test" },
  });

  const res = await fetch(`${BASE_URL}/api/library/not-found-files/${id}/guess-metadata`, { method: "POST" });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.suggestion.title, "Guessed Title");
  assert.deepEqual(fakeLlm.__calls, [filePath]);

  // Nothing should have been written — status is still not_found, and the
  // index still has no title, since this route only surfaces a suggestion.
  const row = seedDb.getById(id);
  assert.equal(row.enrichment_status, "not_found");
  assert.equal(row.title, null);
});

test("POST .../:id/guess-metadata 409s for a file no longer in the Not Found list", async () => {
  const { id } = seedNotFoundFileFromFixture("guess2.mp3", { enrichmentStatus: "skipped_had_tags" });
  const res = await fetch(`${BASE_URL}/api/library/not-found-files/${id}/guess-metadata`, { method: "POST" });
  assert.equal(res.status, 409);
  assert.equal(fakeLlm.__calls.length, 0);
});

test("POST .../:id/guess-metadata 404s for an unknown id", async () => {
  const res = await fetch(`${BASE_URL}/api/library/not-found-files/999999999/guess-metadata`, { method: "POST" });
  assert.equal(res.status, 404);
});

test("POST .../:id/guess-metadata surfaces an extractor error (e.g. no API key configured) as a clean HTTP error, not a crash", async () => {
  const { id } = seedNotFoundFileFromFixture("guess3.mp3");
  fakeLlm.__setResult("guess3.mp3", { ok: false, error: "not_configured", errorMessage: "No ANTHROPIC_API_KEY configured" });

  const res = await fetch(`${BASE_URL}/api/library/not-found-files/${id}/guess-metadata`, { method: "POST" });
  const data = await res.json();
  assert.equal(res.status, 503);
  assert.match(data.error, /ANTHROPIC_API_KEY/);
});

test("POST .../guess-metadata (bulk): a 'high' confidence guess is auto-applied and requeued; 'low' confidence is left untouched", async () => {
  const confident = seedNotFoundFileFromFixture("bulk-guess-high.mp3");
  const unsure = seedNotFoundFileFromFixture("bulk-guess-low.mp3");

  fakeLlm.__setResult("bulk-guess-high.mp3", {
    ok: true,
    suggestion: { title: "Confident Title", artist: "Confident Artist", album: "", genre: "Rock", year: "2001", confidence: "high", reasoning: "clear pattern" },
  });
  fakeLlm.__setResult("bulk-guess-low.mp3", {
    ok: true,
    suggestion: { title: "Maybe Title", artist: "", album: "", genre: "", year: "", confidence: "low", reasoning: "no clear structure" },
  });

  const res = await fetch(`${BASE_URL}/api/library/not-found-files/guess-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [confident.id, unsure.id] }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.appliedCount, 1);
  assert.equal(data.needsReviewCount, 1);

  // Verified through the same live connection the write went through (the
  // server's own libraryDb, via its HTTP API) rather than a freshly-opened
  // raw connection to the db file — node:sqlite's WAL mode has shown rare
  // cross-connection visibility lag under rapid connection churn in this
  // test file, and every other route test in this repo already reads back
  // through /api/library/browse for exactly this reason.
  const confidentBrowse = await fetch(`${BASE_URL}/api/library/browse?title=${encodeURIComponent("Confident Title")}`);
  const confidentData = await confidentBrowse.json();
  const confidentRow = confidentData.rows.find((r) => r.id === confident.id);
  assert.ok(confidentRow, "the auto-applied guess must be findable by its new title");
  assert.equal(confidentRow.artist, "Confident Artist");
  assert.equal(confidentRow.genre, "Rock");
  assert.equal(confidentRow.year, 2001);
  assert.equal(confidentRow.enrichmentStatus, "pending", "auto-applied guess must be re-queued, not left terminal");

  const unsureBrowse = await fetch(`${BASE_URL}/api/library/browse?status=not_found`);
  const unsureData = await unsureBrowse.json();
  const unsureRow = unsureData.rows.find((r) => r.id === unsure.id);
  assert.ok(unsureRow, "a low-confidence guess must leave the track exactly where it was");
  assert.equal(unsureRow.title, null, "a low-confidence guess must never be written automatically");

  const { parseFile } = require("music-metadata");
  const onDisk = await parseFile(confident.filePath);
  assert.equal(onDisk.common.title, "Confident Title", "the auto-applied guess must also be written to the actual file tags");
});

test("POST .../guess-metadata (bulk): rejects an empty ids array", async () => {
  const res = await fetch(`${BASE_URL}/api/library/not-found-files/guess-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(res.status, 400);
});

test("POST .../guess-metadata (bulk): one track's extractor error doesn't block the rest of the batch", async () => {
  const ok = seedNotFoundFileFromFixture("bulk-guess-ok.mp3");
  const broken = seedNotFoundFileFromFixture("bulk-guess-broken.mp3");

  fakeLlm.__setResult("bulk-guess-ok.mp3", {
    ok: true,
    suggestion: { title: "Fine Title", artist: "Fine Artist", album: "", genre: "", year: "", confidence: "high", reasoning: "" },
  });
  fakeLlm.__setResult("bulk-guess-broken.mp3", new Error("network blip"));

  const res = await fetch(`${BASE_URL}/api/library/not-found-files/guess-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [ok.id, broken.id] }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.appliedCount, 1);

  const okResult = data.results.find((r) => r.id === ok.id);
  const brokenResult = data.results.find((r) => r.id === broken.id);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.applied, true);
  assert.equal(brokenResult.ok, false);
  assert.match(brokenResult.error, /network blip/);
});

test("POST .../guess-metadata (bulk): skips a track no longer in the Not Found list without erroring the batch", async () => {
  const stillNotFound = seedNotFoundFileFromFixture("bulk-guess-stays.mp3");
  const alreadyEnriched = seedNotFoundFileFromFixture("bulk-guess-gone.mp3", { enrichmentStatus: "skipped_had_tags" });

  fakeLlm.__setResult("bulk-guess-stays.mp3", {
    ok: true,
    suggestion: { title: "Whatever", artist: "Whoever", album: "", genre: "", year: "", confidence: "high", reasoning: "" },
  });

  const res = await fetch(`${BASE_URL}/api/library/not-found-files/guess-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [stillNotFound.id, alreadyEnriched.id] }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.appliedCount, 1);
  assert.equal(fakeLlm.__calls.length, 1, "the already-enriched track must never reach the extractor");

  const skippedResult = data.results.find((r) => r.id === alreadyEnriched.id);
  assert.equal(skippedResult.ok, false);
});

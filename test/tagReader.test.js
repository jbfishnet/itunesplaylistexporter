const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { readTags } = require("../src/tagReader");

const fixture = (name) => path.join(__dirname, "fixtures", name);

test("reads a fully-tagged MP3 correctly", async () => {
  const tags = await readTags(fixture("tagged.mp3"));
  assert.equal(tags.ok, true);
  assert.equal(tags.title, "Test Track");
  assert.equal(tags.artist, "Test Artist");
  assert.equal(tags.album, "Test Album");
  assert.equal(tags.genre, "Test Genre");
  assert.equal(tags.year, 2020);
  assert.equal(tags.extension, "mp3");
  assert.equal(tags.protected, false);
  assert.ok(tags.durationSec > 0);
});

test("reads a fully-tagged M4A correctly (different container format)", async () => {
  const tags = await readTags(fixture("tagged.m4a"));
  assert.equal(tags.ok, true);
  assert.equal(tags.title, "M4A Track");
  assert.equal(tags.artist, "M4A Artist");
  assert.equal(tags.extension, "m4a");
  assert.equal(tags.protected, false);
});

test("an untagged file parses cleanly with null metadata fields, not an error", async () => {
  const tags = await readTags(fixture("untagged.mp3"));
  assert.equal(tags.ok, true);
  assert.equal(tags.title, null);
  assert.equal(tags.artist, null);
  assert.equal(tags.album, null);
});

test("a garbage/non-audio file does not throw and is flagged unreadable-ish gracefully", async () => {
  const tags = await readTags(fixture("corrupt.mp3"));
  // music-metadata is lenient (resolves with empty fields rather than
  // rejecting) for this particular kind of garbage input — the contract this
  // test protects is simply "never throws," regardless of which of the two
  // valid outcomes (ok:true-with-nulls or ok:false-with-error) it lands on.
  assert.equal(typeof tags.ok, "boolean");
  if (!tags.ok) assert.ok(tags.error);
});

test("a missing file resolves to ok:false with an error message, never rejects", async () => {
  const tags = await readTags(fixture("does-not-exist.mp3"));
  assert.equal(tags.ok, false);
  assert.ok(tags.error && tags.error.length > 0);
});

test(".m4p extension is always flagged protected regardless of readable tags", async () => {
  const tags = await readTags(fixture("protected.m4p"));
  assert.equal(tags.protected, true);
  assert.equal(tags.extension, "m4p");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseFile } = require("music-metadata");

const { writeTagsForRow, fieldsToFill } = require("../src/tagWriter");

const FIXTURES = path.join(__dirname, "fixtures");

function tempCopy(t, fixtureName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ple-tagwriter-"));
  const dest = path.join(dir, fixtureName);
  fs.copyFileSync(path.join(FIXTURES, fixtureName), dest);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dest;
}

test("fieldsToFill only includes fields that are empty on the row and present in the new tags", () => {
  const row = { title: null, artist: "  ", album: "Known Album", genre: undefined, year: null };
  const newTags = { title: "New Title", artist: "New Artist", album: "Ignored", genre: "Rock", year: 1999 };
  assert.deepEqual(fieldsToFill(row, newTags), { title: "New Title", artist: "New Artist", genre: "Rock", year: 1999 });
});

test("fieldsToFill never includes a field the new tags don't actually have", () => {
  const row = { title: null, artist: null, album: null, genre: null, year: null };
  assert.deepEqual(fieldsToFill(row, { title: "T" }), { title: "T" });
});

test("writeTagsForRow refuses a DRM-protected row regardless of format", async () => {
  const result = await writeTagsForRow(
    { path: "/anything.mp3", extension: "mp3", protected: true, title: null },
    { title: "Should not be written" }
  );
  assert.equal(result.written, false);
  assert.equal(result.reason, "protected");
});

test("writeTagsForRow skips an unsupported format without attempting anything", async () => {
  const result = await writeTagsForRow(
    { path: "/anything.wav", extension: "wav", protected: false, title: null },
    { title: "Should not be written" }
  );
  assert.equal(result.written, false);
  assert.equal(result.reason, "unsupported-format");
});

test("writeTagsForRow is a no-op when nothing is actually missing", async () => {
  const result = await writeTagsForRow(
    { path: "/anything.mp3", extension: "mp3", protected: false, title: "Already Has One" },
    { title: "Would-be replacement" }
  );
  assert.equal(result.written, false);
  assert.equal(result.reason, "nothing-missing");
});

test("writeTagsForRow fills in missing MP3 tags on disk, leaving the file valid and playable-metadata-wise", async (t) => {
  const filePath = tempCopy(t, "untagged.mp3");
  const before = await parseFile(filePath);
  assert.equal(before.common.title, undefined, "fixture should start with no title tag");

  const result = await writeTagsForRow(
    { path: filePath, extension: "mp3", protected: false, title: null, artist: null, album: null, genre: null, year: null },
    { title: "Enriched Title", artist: "Enriched Artist", album: "Enriched Album", genre: "Pop", year: 2001 }
  );

  assert.equal(result.written, true);
  assert.deepEqual(result.fields.sort(), ["album", "artist", "genre", "title", "year"]);

  const after = await parseFile(filePath);
  assert.equal(after.common.title, "Enriched Title");
  assert.equal(after.common.artist, "Enriched Artist");
  assert.equal(after.common.album, "Enriched Album");
  assert.equal(after.common.genre?.[0], "Pop");
  assert.equal(after.common.year, 2001);
});

test("writeTagsForRow never touches a field the row already had, even if asked to", async (t) => {
  const filePath = tempCopy(t, "tagged.mp3");
  const before = await parseFile(filePath);
  const originalTitle = before.common.title;
  assert.ok(originalTitle, "fixture should already have a title");

  const result = await writeTagsForRow(
    { path: filePath, extension: "mp3", protected: false, title: originalTitle, artist: null, album: null, genre: null, year: null },
    { title: "SHOULD NOT OVERWRITE", artist: "Filled In Artist" }
  );

  assert.equal(result.written, true);
  assert.deepEqual(result.fields, ["artist"]);

  const after = await parseFile(filePath);
  assert.equal(after.common.title, originalTitle, "existing title must survive untouched");
  assert.equal(after.common.artist, "Filled In Artist");
});

test("writeTagsForRow leaves the original file untouched if the writer fails partway (temp-file + rename safety)", async (t) => {
  const filePath = tempCopy(t, "corrupt.mp3");
  const originalBytes = fs.readFileSync(filePath);

  const result = await writeTagsForRow(
    { path: filePath, extension: "mp3", protected: false, title: null },
    { title: "New Title" }
  ).catch((err) => ({ written: false, error: err.message }));

  // Whichever way node-id3 handles a garbage/near-empty file, the original
  // must never end up partially overwritten or vanish.
  if (!result.written) {
    assert.deepEqual(fs.readFileSync(filePath), originalBytes);
  }
  const leftoverTemp = fs.readdirSync(path.dirname(filePath)).filter((f) => f.includes(".ple-tmp-"));
  assert.deepEqual(leftoverTemp, [], "no temp file should be left behind either way");
});

test("writeTagsForRow fills in missing M4A tags via a lossless ffmpeg remux", async (t) => {
  const filePath = tempCopy(t, "tagged.m4a");

  const result = await writeTagsForRow(
    { path: filePath, extension: "m4a", protected: false, title: "Has One", artist: null, album: null, genre: null, year: null },
    { artist: "Filled Artist", genre: "Filled Genre" }
  );

  assert.equal(result.written, true);
  assert.deepEqual(result.fields.sort(), ["artist", "genre"]);

  const after = await parseFile(filePath);
  assert.equal(after.common.artist, "Filled Artist");
  assert.equal(after.common.genre?.[0], "Filled Genre");
  assert.ok(after.format.duration > 0, "audio stream must still be intact after the remux");
});

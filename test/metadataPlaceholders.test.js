const test = require("node:test");
const assert = require("node:assert/strict");

const { isPlaceholderAlbum } = require("../src/metadataPlaceholders");

test("isPlaceholderAlbum recognizes known sentinel values, case/whitespace-insensitively", () => {
  assert.equal(isPlaceholderAlbum("Unknown Album"), true);
  assert.equal(isPlaceholderAlbum("  unknown album  "), true);
  assert.equal(isPlaceholderAlbum("UNKNOWN"), true);
  assert.equal(isPlaceholderAlbum(""), true);
  assert.equal(isPlaceholderAlbum(null), true);
  assert.equal(isPlaceholderAlbum(undefined), true);
});

test("isPlaceholderAlbum leaves a real album alone, even one that contains 'unknown'", () => {
  assert.equal(isPlaceholderAlbum("The Wall"), false);
  assert.equal(isPlaceholderAlbum("Somewhat Unknown Origins"), false);
});

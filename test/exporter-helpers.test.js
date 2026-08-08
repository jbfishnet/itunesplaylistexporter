const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeSegment, buildBaseFilename, resolveCollision } = require("../src/exporter");

test("sanitizeSegment strips characters forbidden on exFAT/FAT32", () => {
  assert.equal(sanitizeSegment('Track: "Live" / Radio Edit?'), "Track- -Live- - Radio Edit-");
});

test("sanitizeSegment trims trailing dots and spaces (exFAT rejects them)", () => {
  assert.equal(sanitizeSegment("Weird Name.. "), "Weird Name");
});

test("sanitizeSegment falls back to 'Untitled' for a blank/dots-only name", () => {
  assert.equal(sanitizeSegment("   "), "Untitled");
  assert.equal(sanitizeSegment("..."), "Untitled");
});

test("buildBaseFilename zero-pads the position and appends the extension", () => {
  assert.equal(buildBaseFilename(1, "Mr. Brightside", "m4a"), "01 - Mr. Brightside.m4a");
  assert.equal(buildBaseFilename(23, "Track", "mp3"), "23 - Track.mp3");
});

test("resolveCollision leaves the first occurrence of a name untouched", () => {
  const used = new Set();
  assert.equal(resolveCollision(used, "01 - Intro.m4a"), "01 - Intro.m4a");
});

test("resolveCollision appends (2), (3)... for repeated names, case-insensitively", () => {
  const used = new Set();
  assert.equal(resolveCollision(used, "01 - Intro.m4a"), "01 - Intro.m4a");
  assert.equal(resolveCollision(used, "01 - INTRO.m4a"), "01 - INTRO (2).m4a");
  assert.equal(resolveCollision(used, "01 - intro.m4a"), "01 - intro (3).m4a");
});

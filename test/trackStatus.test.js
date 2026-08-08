const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { classifyTrack } = require("../src/trackStatus");

function withTempFile(t, name, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ple-trackstatus-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "dummy audio bytes");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return run(filePath);
}

test("a track with a real local .m4a file is ready", (t) => {
  withTempFile(t, "song.m4a", (filePath) => {
    const result = classifyTrack({ location: filePath, kind: "Purchased AAC audio file" });
    assert.equal(result.status, "ready");
    assert.equal(result.reason, null);
    assert.equal(result.extension, "m4a");
  });
});

test("no location at all (cloud/matched track) is missing", () => {
  const result = classifyTrack({ location: null, kind: "" });
  assert.equal(result.status, "missing");
  assert.match(result.reason, /downloaded locally/i);
});

test("a location that doesn't exist on disk is missing (e.g. NAS not mounted)", () => {
  const result = classifyTrack({
    location: "/Volumes/definitely-not-mounted/Music/song.m4a",
    kind: "Purchased AAC audio file",
  });
  assert.equal(result.status, "missing");
  assert.match(result.reason, /NAS share mounted/i);
});

test(".m4p extension is always protected, regardless of kind text", (t) => {
  withTempFile(t, "song.m4p", (filePath) => {
    const result = classifyTrack({ location: filePath, kind: "AAC audio file" });
    assert.equal(result.status, "protected");
  });
});

test("English 'Protected' kind text is detected", (t) => {
  withTempFile(t, "song.m4a", (filePath) => {
    const result = classifyTrack({ location: filePath, kind: "Protected AAC audio file" });
    assert.equal(result.status, "protected");
  });
});

test("German localized 'Geschützte' kind text is detected (Music.app returns localized strings)", (t) => {
  withTempFile(t, "song.m4a", (filePath) => {
    const result = classifyTrack({ location: filePath, kind: "Geschützte AAC-Audiodatei" });
    assert.equal(result.status, "protected");
  });
});

test("an ordinary purchased/MPEG track (German kind strings) is ready", (t) => {
  withTempFile(t, "song.mp3", (filePath) => {
    const readyKinds = ["Gekaufte AAC-Audiodatei", "MPEG-Audiodatei"];
    readyKinds.forEach((kind) => {
      const result = classifyTrack({ location: filePath, kind });
      assert.equal(result.status, "ready", `expected ready for kind "${kind}"`);
    });
  });
});

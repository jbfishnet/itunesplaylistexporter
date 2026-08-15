const test = require("node:test");
const assert = require("node:assert/strict");

const { findCandidates, restorePlaylist } = require("../src/playlistRestorer");

/** A minimal fake shaped like libraryDb's public surface (browse/search),
 * so the matching logic is testable without a real SQLite index. */
function fakeLibraryDb(files) {
  return {
    browse({ title }) {
      const needle = String(title || "").trim().toLowerCase();
      return { rows: files.filter((f) => f.title.toLowerCase().includes(needle)), total: files.length };
    },
    search(query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      return files.filter((f) => {
        const haystack = `${f.title} ${f.artist || ""}`.toLowerCase();
        return terms.some((t) => haystack.includes(t));
      });
    },
  };
}

test("findCandidates: exact single title+artist match", () => {
  const db = fakeLibraryDb([{ id: 1, title: "Mr. Brightside", artist: "The Killers" }]);
  const result = findCandidates({ title: "Mr. Brightside", artist: "The Killers" }, db);
  assert.equal(result.confidence, "exact");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 1);
});

test("findCandidates: exact match is case/whitespace-insensitive", () => {
  const db = fakeLibraryDb([{ id: 1, title: "mr. brightside", artist: "the killers" }]);
  const result = findCandidates({ title: " Mr. Brightside ", artist: " The Killers " }, db);
  assert.equal(result.confidence, "exact");
});

test("findCandidates: 2+ title+artist matches are ambiguous, not auto-applied", () => {
  const db = fakeLibraryDb([
    { id: 1, title: "Holiday", artist: "Madonna" },
    { id: 2, title: "Holiday", artist: "Madonna" },
  ]);
  const result = findCandidates({ title: "Holiday", artist: "Madonna" }, db);
  assert.equal(result.confidence, "ambiguous");
  assert.equal(result.candidates.length, 2);
});

test("findCandidates: title matches but artist differs is ambiguous, not a match", () => {
  const db = fakeLibraryDb([{ id: 1, title: "Holiday", artist: "Scorpions" }]);
  const result = findCandidates({ title: "Holiday", artist: "Madonna" }, db);
  assert.equal(result.confidence, "ambiguous");
  assert.equal(result.candidates[0].id, 1);
});

test("findCandidates: track has no artist at all falls back to title-only ambiguous match", () => {
  const db = fakeLibraryDb([{ id: 1, title: "Holiday", artist: "Madonna" }]);
  const result = findCandidates({ title: "Holiday", artist: "" }, db);
  assert.equal(result.confidence, "ambiguous");
});

test("findCandidates: a title typo with no substring match is 'none', not a fuzzy guess", () => {
  const db = fakeLibraryDb([{ id: 1, title: "Complicated", artist: "Avril Lavigne" }]);
  const result = findCandidates({ title: "Complikated", artist: "Avril Lavigne" }, db);
  assert.equal(result.confidence, "none");
});

test("findCandidates: sharing one common word with an unrelated track is 'none', not a false 'ambiguous'", () => {
  const db = fakeLibraryDb([{ id: 1, title: "Exact Match Song", artist: "Artist X" }]);
  const result = findCandidates({ title: "No Match Anywhere", artist: "Nobody" }, db);
  assert.equal(result.confidence, "none");
});

test("findCandidates: nothing found anywhere is 'none'", () => {
  const db = fakeLibraryDb([{ id: 1, title: "Something Else", artist: "Someone Else" }]);
  const result = findCandidates({ title: "Totally Unrelated Track", artist: "Nobody" }, db);
  assert.equal(result.confidence, "none");
  assert.deepEqual(result.candidates, []);
});

test("findCandidates: blank title is 'none' without querying", () => {
  const db = fakeLibraryDb([{ id: 1, title: "Anything", artist: "Anyone" }]);
  const result = findCandidates({ title: "", artist: "Anyone" }, db);
  assert.equal(result.confidence, "none");
});

test("restorePlaylist buckets missing tracks by match confidence and leaves ready/protected tracks alone", () => {
  const db = fakeLibraryDb([
    { id: 1, title: "Exact Match", artist: "Artist A" },
    { id: 2, title: "Ambiguous Title", artist: "Someone" },
    { id: 3, title: "Ambiguous Title", artist: "Someone Else" },
  ]);
  const tracks = [
    { position: 1, title: "Already Ready", artist: "X", status: "ready" },
    { position: 2, title: "DRM Track", artist: "X", status: "protected" },
    { position: 3, title: "Exact Match", artist: "Artist A", status: "missing" },
    { position: 4, title: "Ambiguous Title", artist: "Whoever", status: "missing" },
    { position: 5, title: "Nothing Like This Exists", artist: "Nobody", status: "missing" },
  ];

  const { fixed, needsReview, noLocalMatch } = restorePlaylist({ tracks, libraryDb: db });

  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].track.position, 3);
  assert.equal(fixed[0].file.id, 1);

  assert.equal(needsReview.length, 1);
  assert.equal(needsReview[0].track.position, 4);
  assert.equal(needsReview[0].candidates.length, 2);

  assert.equal(noLocalMatch.length, 1);
  assert.equal(noLocalMatch[0].position, 5);
});

test("restorePlaylist treats every missing track as needing a download attempt when no library index is configured", () => {
  const tracks = [
    { position: 1, title: "Whatever", artist: "X", status: "missing" },
    { position: 2, title: "Fine", artist: "Y", status: "ready" },
  ];
  const { fixed, needsReview, noLocalMatch } = restorePlaylist({ tracks, libraryDb: null });
  assert.equal(fixed.length, 0);
  assert.equal(needsReview.length, 0);
  assert.equal(noLocalMatch.length, 1);
  assert.equal(noLocalMatch[0].position, 1);
});

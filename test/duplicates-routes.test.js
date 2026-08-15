// Covers the new multi-root + duplicate-detection routes end to end against
// a real (temporary) filesystem and a real running server — especially the
// deletion safety guard, since DELETE /api/library/files/:id is destructive
// and irreversible on real files.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const NodeID3 = require("node-id3");

const FIXTURES = path.join(__dirname, "fixtures");
const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-dup-root-"));
// Two byte-identical copies (a real duplicate pair) + one unrelated unique file.
fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), path.join(libraryRoot, "copy1.mp3"));
fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), path.join(libraryRoot, "copy2.mp3"));
fs.copyFileSync(path.join(FIXTURES, "untagged.mp3"), path.join(libraryRoot, "unique.mp3"));
// Same title, different album/bytes — a "similar" pair, not byte-identical.
fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), path.join(libraryRoot, "similarA.mp3"));
fs.copyFileSync(path.join(FIXTURES, "tagged.mp3"), path.join(libraryRoot, "similarB.mp3"));
NodeID3.update({ title: "Shared Title", album: "Album One" }, path.join(libraryRoot, "similarA.mp3"));
NodeID3.update({ title: "Shared Title", album: "Album Two" }, path.join(libraryRoot, "similarB.mp3"));

process.env.PORT = process.env.PORT || "4196";
process.env.PLE_NO_OPEN = "1";
process.env.PLE_LIBRARY_ROOT = libraryRoot;
process.env.PLE_LIBRARY_DB = ":memory:";
const server = require("../server");

const BASE_URL = `http://localhost:${process.env.PORT}`;

async function waitFor(checkFn, description) {
  for (let i = 0; i < 200; i += 1) {
    if (await checkFn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

test.after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(libraryRoot, { recursive: true, force: true });
});

test("GET /api/library/roots reflects the seeded default root, with its mount status and an assigned color", async () => {
  const res = await fetch(`${BASE_URL}/api/library/roots`);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.roots.length, 1);
  assert.equal(data.roots[0].path, libraryRoot);
  assert.equal(data.roots[0].mounted, true);
  assert.ok(data.roots[0].color, "a color must be assigned");
});

test("POST /api/library/roots rejects a relative path, adds a valid absolute one, and rejects a duplicate add", async () => {
  const relative = await fetch(`${BASE_URL}/api/library/roots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "not/absolute" }),
  });
  assert.equal(relative.status, 400);

  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-dup-root2-"));
  const added = await fetch(`${BASE_URL}/api/library/roots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: secondRoot }),
  });
  const addedData = await added.json();
  assert.equal(added.status, 200);
  assert.deepEqual(
    addedData.roots.map((r) => r.path).sort(),
    [libraryRoot, secondRoot].sort()
  );

  const dupeAdd = await fetch(`${BASE_URL}/api/library/roots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: secondRoot }),
  });
  assert.equal(dupeAdd.status, 409);

  const removed = await fetch(`${BASE_URL}/api/library/roots`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: secondRoot }),
  });
  const removedData = await removed.json();
  assert.equal(removed.status, 200);
  assert.equal(removedData.roots.length, 1);
  assert.equal(removedData.roots[0].path, libraryRoot);
  assert.equal(removedData.roots[0].mounted, true);
  fs.rmSync(secondRoot, { recursive: true, force: true });
});

test("duplicates are detected automatically in the background and exposed via GET /api/library/duplicates", async () => {
  await waitFor(async () => {
    const res = await fetch(`${BASE_URL}/api/library/duplicates`);
    const data = await res.json();
    return data.total >= 1;
  }, "the duplicate pair to be hashed and grouped");

  const res = await fetch(`${BASE_URL}/api/library/duplicates`);
  const data = await res.json();
  const group = data.groups.find((g) => g.fileCount === 2);
  assert.ok(group, "the two identical copies should form a group");
  const names = group.files.map((f) => path.basename(f.path)).sort();
  assert.deepEqual(names, ["copy1.mp3", "copy2.mp3"]);
  assert.equal(data.extraFiles, 1);

  // Both copies live under the same (only) configured root, so they must
  // share a folder color, and it must match that root's color from
  // GET /api/library/roots.
  const rootsRes = await fetch(`${BASE_URL}/api/library/roots`);
  const rootsData = await rootsRes.json();
  const [fileA, fileB] = group.files;
  assert.ok(fileA.folderColor);
  assert.equal(fileA.folderColor, fileB.folderColor);
  assert.equal(fileA.folderColor, rootsData.roots[0].color);
});

test("each library root gets its own distinct color, and duplicate files are attributed to the correct root", async (t) => {
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-dup-root3-"));
  t.after(() => fs.rmSync(secondRoot, { recursive: true, force: true }));
  fs.copyFileSync(path.join(FIXTURES, "tagged.m4a"), path.join(secondRoot, "copyA.m4a"));
  fs.copyFileSync(path.join(FIXTURES, "tagged.m4a"), path.join(secondRoot, "copyB.m4a"));

  const addRes = await fetch(`${BASE_URL}/api/library/roots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: secondRoot }),
  });
  const addData = await addRes.json();
  assert.equal(addRes.status, 200);
  const [rootAInfo, rootBInfo] = addData.roots;
  assert.notEqual(rootAInfo.color, rootBInfo.color, "each root must get a distinct color");

  await waitFor(async () => {
    const res = await fetch(`${BASE_URL}/api/library/duplicates?limit=50`);
    const data = await res.json();
    return data.groups.some((g) => g.files.some((f) => f.path.startsWith(secondRoot)));
  }, "the second root's duplicate pair to be hashed and grouped");

  const dupRes = await fetch(`${BASE_URL}/api/library/duplicates?limit=50`);
  const dupData = await dupRes.json();
  const groupFromRootA = dupData.groups.find((g) => g.files.some((f) => f.path.startsWith(libraryRoot)));
  const groupFromRootB = dupData.groups.find((g) => g.files.some((f) => f.path.startsWith(secondRoot)));

  assert.equal(groupFromRootA.files[0].folderColor, rootAInfo.color);
  assert.equal(groupFromRootB.files[0].folderColor, rootBInfo.color);
  assert.notEqual(groupFromRootA.files[0].folderColor, groupFromRootB.files[0].folderColor);

  // Clean up: remove the second root again so later tests' assumptions
  // about "the" duplicate group (singular) still hold.
  await fetch(`${BASE_URL}/api/library/roots`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: secondRoot }),
  });
  await waitFor(async () => {
    const res = await fetch(`${BASE_URL}/api/library/duplicates?limit=50`);
    const data = await res.json();
    return !data.groups.some((g) => g.files.some((f) => f.path.startsWith(secondRoot)));
  }, "the second root's files to be swept back out after removal");
});

test("GET /api/library/similar finds same-title files with a real difference, and lists which fields differ", async () => {
  await waitFor(async () => {
    const res = await fetch(`${BASE_URL}/api/library/similar`);
    const data = await res.json();
    return data.total >= 1;
  }, "the similar-title pair to be indexed");

  const res = await fetch(`${BASE_URL}/api/library/similar`);
  const data = await res.json();
  const group = data.groups.find((g) => g.title === "Shared Title");
  assert.ok(group, "the two same-title, different-album files should form a group");
  assert.ok(group.diffFields.includes("album"));

  const albums = group.files.map((f) => f.album).sort();
  assert.deepEqual(albums, ["Album One", "Album Two"]);

  // Exact byte-identical duplicates (copy1/copy2) must NOT also show up
  // here — that story is already told by /api/library/duplicates.
  assert.ok(!data.groups.some((g) => g.files.some((f) => f.path.endsWith("copy1.mp3"))));
});

test("DELETE /api/library/files/:id refuses a file that isn't a confirmed duplicate", async () => {
  await waitFor(async () => {
    const res = await fetch(`${BASE_URL}/api/library/browse?title=unique`);
    const data = await res.json();
    return data.rows.length === 1 && data.rows[0].enrichmentStatus !== undefined;
  }, "the unique file to be indexed");

  const browseRes = await fetch(`${BASE_URL}/api/library/browse?title=unique`);
  const { rows } = await browseRes.json();
  const uniqueFile = rows[0];

  const res = await fetch(`${BASE_URL}/api/library/files/${uniqueFile.id}`, { method: "DELETE" });
  assert.equal(res.status, 409);
  assert.ok(fs.existsSync(path.join(libraryRoot, "unique.mp3")), "the file must survive on disk");
});

test("DELETE /api/library/files/:id deletes a confirmed duplicate from disk and the index", async () => {
  const dupRes = await fetch(`${BASE_URL}/api/library/duplicates`);
  const dupData = await dupRes.json();
  const group = dupData.groups.find((g) => g.fileCount === 2);
  const toDelete = group.files[0];
  const toKeep = group.files[1];

  assert.ok(fs.existsSync(toDelete.path));

  const res = await fetch(`${BASE_URL}/api/library/files/${toDelete.id}`, { method: "DELETE" });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.deleted, true);
  assert.equal(fs.existsSync(toDelete.path), false, "file must actually be gone from disk");
  assert.ok(fs.existsSync(toKeep.path), "the other copy must be untouched");

  const browseRes = await fetch(`${BASE_URL}/api/library/browse?title=${encodeURIComponent(toDelete.title || "")}`);
  const browseData = await browseRes.json();
  assert.ok(!browseData.rows.some((r) => r.id === toDelete.id), "deleted file's row must be gone from the index");
});

test("DELETE /api/library/similar-files/:id deletes the non-keeper copy (no file under the protected path, so the oldest-indexed one is kept)", async () => {
  const simRes = await fetch(`${BASE_URL}/api/library/similar`);
  const simData = await simRes.json();
  const group = simData.groups.find((g) => g.title === "Shared Title");
  const [keeper, extra] = group.files; // ordered by id ASC — files[0] is the fallback keeper

  assert.ok(fs.existsSync(extra.path));

  const res = await fetch(`${BASE_URL}/api/library/similar-files/${extra.id}`, { method: "DELETE" });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.deleted, true);
  assert.equal(fs.existsSync(extra.path), false, "the deleted copy must actually be gone from disk");
  assert.ok(fs.existsSync(keeper.path), "the keeper must be untouched");
});

test("DELETE /api/library/similar-files/:id refuses to delete the keeper itself", async () => {
  await waitFor(async () => {
    const res = await fetch(`${BASE_URL}/api/library/browse?title=unique`);
    const data = await res.json();
    return data.rows.length === 1;
  }, "the unique file to be indexed");

  const browseRes = await fetch(`${BASE_URL}/api/library/browse?title=unique`);
  const { rows } = await browseRes.json();
  const uniqueFile = rows[0];

  const res = await fetch(`${BASE_URL}/api/library/similar-files/${uniqueFile.id}`, { method: "DELETE" });
  assert.equal(res.status, 409, "a file with no similar-title siblings at all must be refused");
  assert.ok(fs.existsSync(path.join(libraryRoot, "unique.mp3")));
});

test("DELETE /api/library/similar-files/:id 404s for an unknown id", async () => {
  const res = await fetch(`${BASE_URL}/api/library/similar-files/999999999`, { method: "DELETE" });
  assert.equal(res.status, 404);
});

test("DELETE /api/library/files/:id 404s for an unknown id", async () => {
  const res = await fetch(`${BASE_URL}/api/library/files/999999999`, { method: "DELETE" });
  assert.equal(res.status, 404);
});

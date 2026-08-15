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
  assert.equal(data.roots[0].main, false, "a temp test root must never be implicitly 'main' via the historical hard-coded default");
});

test("POST /api/library/roots/main designates a root as main (only one at a time), and path:null clears it", async (t) => {
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-dup-mainroot-"));
  t.after(() => fs.rmSync(secondRoot, { recursive: true, force: true }));
  await fetch(`${BASE_URL}/api/library/roots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: secondRoot }),
  });
  t.after(async () => {
    await fetch(`${BASE_URL}/api/library/roots`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: secondRoot }),
    });
  });

  const setRes = await fetch(`${BASE_URL}/api/library/roots/main`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: secondRoot }),
  });
  const setData = await setRes.json();
  assert.equal(setRes.status, 200);
  assert.deepEqual(
    setData.roots.map((r) => ({ path: r.path, main: r.main })).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: libraryRoot, main: false },
      { path: secondRoot, main: true },
    ].sort((a, b) => a.path.localeCompare(b.path))
  );

  const clearRes = await fetch(`${BASE_URL}/api/library/roots/main`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: null }),
  });
  const clearData = await clearRes.json();
  assert.ok(clearData.roots.every((r) => r.main === false), "no root should be main after clearing");
});

test("POST /api/library/roots/main 404s for a path that isn't a configured root", async () => {
  const res = await fetch(`${BASE_URL}/api/library/roots/main`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/not/a/configured/root" }),
  });
  assert.equal(res.status, 404);
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

test("bulk 'Delete All Duplicates' flow: paginated fetch-then-sequential-delete removes every extra copy across every group, keeping one of each", async (t) => {
  // A dedicated root with 3 separate duplicate pairs (6 files, 3 extras) —
  // enough to exercise "gather ids from every page, then delete them one by
  // one" as a real sequence, not just a single DELETE call. This mirrors
  // exactly what public/libraryDuplicates.js's deleteAllBtn handler does:
  // fetchAllExtraFileIds() first (paginated GETs), then a delete loop.
  const bulkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ple-dup-bulk-"));
  t.after(() => fs.rmSync(bulkRoot, { recursive: true, force: true }));

  // Distinct content per pair — reusing the same source fixture for all 3
  // (e.g. tagged.mp3 for everything) would make every file byte-identical to
  // every other, collapsing what's meant to be 3 separate 2-file groups into
  // one giant group instead. Duplicate detection is pure content-hash based,
  // so plain distinct text content (still under a .mp3 name so the scanner
  // picks it up) is enough — it doesn't need to be real audio.
  for (const n of [1, 2, 3]) {
    const content = `fake-bulk-pair-${n}-content-${"x".repeat(200)}`;
    fs.writeFileSync(path.join(bulkRoot, `bulk${n}-keep.mp3`), content);
    fs.writeFileSync(path.join(bulkRoot, `bulk${n}-extra.mp3`), content);
  }

  const addRes = await fetch(`${BASE_URL}/api/library/roots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: bulkRoot }),
  });
  assert.equal(addRes.status, 200);
  t.after(async () => {
    await fetch(`${BASE_URL}/api/library/roots`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: bulkRoot }),
    });
  });

  await waitFor(async () => {
    const res = await fetch(`${BASE_URL}/api/library/duplicates?limit=50`);
    const data = await res.json();
    return data.groups.filter((g) => g.files.some((f) => f.path.startsWith(bulkRoot))).length === 3;
  }, "all 3 bulk-root pairs to be hashed and grouped");

  // fetchAllExtraFileIds(), ported: walk every page, collect every group's
  // non-first (extra) file — deliberately using a page size smaller than the
  // total group count so this genuinely spans multiple requests, the same
  // way it does for real once a library has more than 100 duplicate groups.
  async function fetchAllExtraFiles(pageSize) {
    const files = [];
    let cursor = 0;
    let total = Infinity;
    while (cursor < total) {
      const res = await fetch(`${BASE_URL}/api/library/duplicates?limit=${pageSize}&offset=${cursor}`);
      const data = await res.json();
      total = data.total;
      if (data.groups.length === 0) break;
      for (const group of data.groups) {
        const [, ...extras] = group.files;
        files.push(...extras);
      }
      cursor += pageSize;
    }
    return files;
  }

  const beforeExtras = await fetchAllExtraFiles(1); // page size 1 forces several real requests worth of paging
  const bulkExtraIds = beforeExtras.filter((f) => f.path.startsWith(bulkRoot)).map((f) => f.id);
  assert.equal(bulkExtraIds.length, 3, "exactly the 3 extra copies from the bulk root, not the keepers");

  // The delete loop itself: sequential, one at a time, exactly like the UI.
  let failed = 0;
  for (const id of bulkExtraIds) {
    const res = await fetch(`${BASE_URL}/api/library/files/${id}`, { method: "DELETE" });
    if (!res.ok) failed += 1;
  }
  assert.equal(failed, 0, "every extra copy must delete successfully, none should fail partway through the sequence");

  // Which specific file of a pair ends up "kept" (files[0], whichever the
  // concurrent scanner happened to index first — see libraryScanner.js)
  // isn't something this test can predict by filename; the real invariant is
  // just "exactly one of each pair survives", not which one.
  for (const n of [1, 2, 3]) {
    const survivors = [`bulk${n}-keep.mp3`, `bulk${n}-extra.mp3`].filter((name) =>
      fs.existsSync(path.join(bulkRoot, name))
    );
    assert.equal(survivors.length, 1, `exactly one file from pair ${n} must survive, got: ${survivors.join(", ") || "none"}`);
  }

  const afterRes = await fetch(`${BASE_URL}/api/library/duplicates?limit=50`);
  const afterData = await afterRes.json();
  assert.ok(
    !afterData.groups.some((g) => g.files.some((f) => f.path.startsWith(bulkRoot))),
    "no group from the bulk root should remain — each is down to a single (kept) file"
  );
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

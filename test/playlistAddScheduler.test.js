const test = require("node:test");
const assert = require("node:assert/strict");
const { schedule } = require("../public/playlistAddScheduler");

function createSelect(value) {
  return { value };
}

test("a selected playlist is auto-added only after the configured delay", async () => {
  const select = createSelect("42");
  let addedPlaylistId = null;
  schedule(select, (playlistId) => { addedPlaylistId = playlistId; }, 30);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(addedPlaylistId, null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(addedPlaylistId, "42");
});

test("changing or clearing the selection cancels the previous scheduled add", async () => {
  const select = createSelect("42");
  const added = [];
  schedule(select, (playlistId) => added.push(playlistId), 20);
  select.value = "43";
  schedule(select, (playlistId) => added.push(playlistId), 20);
  await new Promise((resolve) => setTimeout(resolve, 30));

  select.value = "44";
  schedule(select, (playlistId) => added.push(playlistId), 20);
  select.value = "";
  schedule(select, () => {}, 20);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(added, ["43"]);
});

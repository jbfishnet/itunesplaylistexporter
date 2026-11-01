const test = require("node:test");
const assert = require("node:assert/strict");
const { playAfterPausing } = require("../public/playbackControl");

test("preview playback starts even when pausing Music.app fails", async () => {
  const calls = [];
  const pausePlayback = async () => {
    calls.push("pause");
    throw new Error("Music.app automation is unavailable");
  };
  const startPlayback = async () => {
    calls.push("play");
    return "playing";
  };
  const warnings = [];

  const result = await playAfterPausing(
    pausePlayback,
    startPlayback,
    (message, error) => warnings.push({ message, error })
  );

  assert.equal(result, "playing");
  assert.deepEqual(calls, ["pause", "play"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].error.message, /automation is unavailable/);
});

test("preview playback still surfaces an actual audio playback failure", async () => {
  await assert.rejects(
    playAfterPausing(async () => {}, async () => {
      throw new Error("audio file is unreadable");
    }),
    /audio file is unreadable/
  );
});

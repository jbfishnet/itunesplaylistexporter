(() => {
  async function playAfterPausing(pausePlayback, startPlayback, onPauseError = console.warn) {
    try {
      await pausePlayback();
    } catch (err) {
      onPauseError("Couldn't pause Music.app before preview playback:", err);
    }
    return startPlayback();
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { playAfterPausing };
  } else {
    window.PlaylistExporterPlayback = { playAfterPausing };
  }
})();

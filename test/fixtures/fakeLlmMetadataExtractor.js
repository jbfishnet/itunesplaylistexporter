// Stand-in for src/llmMetadataExtractor.js used only by tests (via
// PLE_TEST_LLM_EXTRACTOR) — the real module calls the Anthropic API, which
// needs a configured key and real network access neither of which a CI test
// run has. Results are queued per-call in FIFO order so a test can script
// exactly what each successive guess should return.

const calls = [];
let queue = [];

function extractMetadataFromFilename(filePath) {
  calls.push(filePath);
  const next = queue.shift();
  if (next === undefined) {
    return Promise.resolve({
      ok: true,
      suggestion: { title: "", artist: "", album: "", genre: "", year: "", confidence: "low", reasoning: "" },
    });
  }
  return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
}

module.exports = {
  extractMetadataFromFilename,
  __calls: calls,
  __queueResult(result) {
    queue.push(result);
  },
  __reset() {
    queue = [];
    calls.length = 0;
  },
};

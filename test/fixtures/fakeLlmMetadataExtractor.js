// Stand-in for src/llmMetadataExtractor.js used only by tests (via
// PLE_TEST_LLM_EXTRACTOR) — the real module calls the Anthropic API, which
// needs a configured key and real network access neither of which a CI test
// run has. Results are keyed by filename (basename of the path passed in),
// not by call order — node:test's default concurrency can interleave
// multiple tests' HTTP requests within the same file, so a shared FIFO
// queue (consumed in whatever order requests actually arrive) is a race;
// keying by filename is race-proof as long as each test uses distinct
// filenames, which every test here already does.

const path = require("path");

const calls = [];
let byFilename = new Map();

function extractMetadataFromFilename(filePath) {
  calls.push(filePath);
  const next = byFilename.get(path.basename(filePath));
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
  __setResult(filename, result) {
    byFilename.set(filename, result);
  },
  __reset() {
    byFilename = new Map();
    calls.length = 0;
  },
};

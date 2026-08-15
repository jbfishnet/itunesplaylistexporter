// Unit tests for src/llmMetadataExtractor.js — never talks to the real
// Anthropic API. A fake `anthropicClient` (shaped like the one bit of the
// SDK this module actually calls: client.messages.create) is injected
// directly, same dependency-injection approach as acoustId.js's fetchFn.

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractMetadataFromFilename } = require("../src/llmMetadataExtractor");

function fakeClient(handler) {
  return { messages: { create: handler } };
}

function jsonResponse(obj, overrides = {}) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn", ...overrides };
}

test("extractMetadataFromFilename: no-op (never calls the client) when ANTHROPIC_API_KEY is unset", async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    let called = false;
    const client = fakeClient(() => {
      called = true;
      return Promise.resolve(jsonResponse({}));
    });
    const result = await extractMetadataFromFilename("/x/Some Song.mp3", { anthropicClient: client });
    assert.equal(result.ok, false);
    assert.equal(result.error, "not_configured");
    assert.equal(called, false);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test("extractMetadataFromFilename: parses a successful structured-output response", async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    let receivedFilename;
    const client = fakeClient((params) => {
      receivedFilename = params.messages[0].content;
      return Promise.resolve(
        jsonResponse({
          title: "Stubborn Love",
          artist: "Josh Kumra",
          album: "",
          genre: "",
          year: "",
          confidence: "high",
          reasoning: "Filename follows 'Artist - Title' with video/quality tags stripped.",
        })
      );
    });

    const result = await extractMetadataFromFilename(
      "/Volumes/jb/iTunes4TB/iTunes Media/Music/Unknown Artist/Unknown Album/Josh Kumra - Stubborn Love (Artwork Video) (192 kbps).mp3",
      { anthropicClient: client }
    );

    assert.equal(result.ok, true);
    assert.equal(result.suggestion.title, "Stubborn Love");
    assert.equal(result.suggestion.artist, "Josh Kumra");
    assert.equal(result.suggestion.confidence, "high");
    assert.match(receivedFilename, /Josh Kumra - Stubborn Love/);
    assert.doesNotMatch(receivedFilename, /Unknown Artist/, "only the filename should be sent, not the whole path");
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

test("extractMetadataFromFilename: an unrecognized confidence value defaults to 'low', never 'high'", async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const client = fakeClient(() =>
      Promise.resolve(jsonResponse({ title: "X", artist: "Y", album: "", genre: "", year: "", confidence: "sort-of", reasoning: "" }))
    );
    const result = await extractMetadataFromFilename("/x/whatever.mp3", { anthropicClient: client });
    assert.equal(result.ok, true);
    assert.equal(result.suggestion.confidence, "low");
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

test("extractMetadataFromFilename: surfaces an API error instead of throwing", async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const client = fakeClient(() => Promise.reject(new Error("rate limited")));
    const result = await extractMetadataFromFilename("/x/whatever.mp3", { anthropicClient: client });
    assert.equal(result.ok, false);
    assert.equal(result.error, "api_error");
    assert.match(result.errorMessage, /rate limited/);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

test("extractMetadataFromFilename: a refusal stop_reason is surfaced, not treated as a parse error", async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const client = fakeClient(() => Promise.resolve({ content: [], stop_reason: "refusal", stop_details: { category: null } }));
    const result = await extractMetadataFromFilename("/x/whatever.mp3", { anthropicClient: client });
    assert.equal(result.ok, false);
    assert.equal(result.error, "refused");
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

test("extractMetadataFromFilename: malformed JSON in the response is reported, not thrown", async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const client = fakeClient(() => Promise.resolve({ content: [{ type: "text", text: "not json" }], stop_reason: "end_turn" }));
    const result = await extractMetadataFromFilename("/x/whatever.mp3", { anthropicClient: client });
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_response");
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");

const { identifyByFingerprint } = require("../src/acoustId");

function withApiKey(key, fn) {
  const previous = process.env.ACOUSTID_API_KEY;
  process.env.ACOUSTID_API_KEY = key;
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.ACOUSTID_API_KEY;
    else process.env.ACOUSTID_API_KEY = previous;
  });
}

test("identifyByFingerprint is a cheap no-op with no API key configured — never touches fpcalc or the network", async () => {
  delete process.env.ACOUSTID_API_KEY;
  let fpcalcCalled = false;
  let fetchCalled = false;
  const result = await identifyByFingerprint("/some/file.mp3", {
    fpcalcFn: async () => {
      fpcalcCalled = true;
      return { fingerprint: "x", duration: 200 };
    },
    fetchFn: async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.equal(result, null);
  assert.equal(fpcalcCalled, false);
  assert.equal(fetchCalled, false);
});

test("identifyByFingerprint returns null (not a throw) when fpcalc fails or the file is unreadable", () =>
  withApiKey("test-key", async () => {
    const result = await identifyByFingerprint("/does/not/exist.mp3", {
      fpcalcFn: async () => {
        throw new Error("fpcalc: no such file");
      },
    });
    assert.equal(result, null);
  }));

test("identifyByFingerprint returns null when fpcalc's output is missing a fingerprint or duration", () =>
  withApiKey("test-key", async () => {
    const result = await identifyByFingerprint("/x.mp3", {
      fpcalcFn: async () => ({ duration: 200 }), // no fingerprint field
    });
    assert.equal(result, null);
  }));

test("identifyByFingerprint picks the highest-scoring result and maps it to tags, leaving genre/year null", () =>
  withApiKey("test-key", async () => {
    const result = await identifyByFingerprint("/x.mp3", {
      fpcalcFn: async () => ({ fingerprint: "abc123", duration: 213 }),
      fetchFn: async (url) => {
        assert.match(url, /^https:\/\/api\.acoustid\.org\/v2\/lookup\?/);
        assert.match(url, /client=test-key/);
        assert.match(url, /fingerprint=abc123/);
        // Regression check: URLSearchParams percent-encodes a literal "+" in
        // a value to %2B, but AcoustID silently drops the nested
        // recordings/releasegroups data (while still returning matches!)
        // unless it sees a literal "+" here — easy to miss since the request
        // still "succeeds" without it.
        assert.match(url, /meta=recordings\+releasegroups/);
        assert.doesNotMatch(url, /%2B/);
        return {
          ok: true,
          json: async () => ({
            status: "ok",
            results: [
              { score: 0.4, recordings: [{ title: "Wrong Guess", artists: [{ name: "Nobody" }] }] },
              {
                score: 0.92,
                recordings: [
                  {
                    title: "Another Brick In The Wall, Pt. 2",
                    artists: [{ name: "Pink Floyd" }],
                    releasegroups: [{ title: "The Wall" }],
                  },
                ],
              },
            ],
          }),
        };
      },
    });
    assert.deepEqual(result, {
      title: "Another Brick In The Wall, Pt. 2",
      artist: "Pink Floyd",
      album: "The Wall",
      genre: null,
      year: null,
    });
  }));

test("identifyByFingerprint returns null when AcoustID has no results or no recording data", () =>
  withApiKey("test-key", async () => {
    const noResults = await identifyByFingerprint("/x.mp3", {
      fpcalcFn: async () => ({ fingerprint: "abc", duration: 200 }),
      fetchFn: async () => ({ ok: true, json: async () => ({ status: "ok", results: [] }) }),
    });
    assert.equal(noResults, null);

    const noRecording = await identifyByFingerprint("/x.mp3", {
      fpcalcFn: async () => ({ fingerprint: "abc", duration: 200 }),
      fetchFn: async () => ({ ok: true, json: async () => ({ status: "ok", results: [{ score: 1 }] }) }),
    });
    assert.equal(noRecording, null);
  }));

test("identifyByFingerprint returns null on a network failure or non-OK response, without throwing", () =>
  withApiKey("test-key", async () => {
    const networkDown = await identifyByFingerprint("/x.mp3", {
      fpcalcFn: async () => ({ fingerprint: "abc", duration: 200 }),
      fetchFn: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(networkDown, null);

    const httpError = await identifyByFingerprint("/x.mp3", {
      fpcalcFn: async () => ({ fingerprint: "abc", duration: 200 }),
      fetchFn: async () => ({ ok: false, status: 503 }),
    });
    assert.equal(httpError, null);
  }));

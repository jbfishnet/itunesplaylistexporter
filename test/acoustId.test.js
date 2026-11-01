const test = require("node:test");
const assert = require("node:assert/strict");

const {
  identifyByFingerprint,
  readApiKey,
  getAcoustidStatus,
  checkAcoustidKey,
  getApiError,
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
} = require("../src/acoustId");

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
    apiKeyFn: async () => null,
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

test("readApiKey prefers the environment and falls back to the macOS Keychain", async () => {
  assert.equal(await readApiKey({ env: { ACOUSTID_API_KEY: " env-key " }, platform: "darwin" }), "env-key");
  assert.equal(await readApiKey({ env: {}, platform: "linux" }), null);

  const key = await readApiKey({
    env: {},
    platform: "darwin",
    execFileFn: (command, args, options, callback) => {
      assert.equal(command, "/usr/bin/security");
      assert.deepEqual(args, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
      assert.equal(options.timeout, 5000);
      callback(null, "stored-key\n", "");
    },
  });
  assert.equal(key, "stored-key");
});

test("readApiKey returns null when no Keychain item exists and surfaces other Keychain failures", async () => {
  const missingKey = await readApiKey({
    env: {},
    platform: "darwin",
    execFileFn: (command, args, options, callback) => {
      callback(Object.assign(new Error("not found"), { code: 44 }), "", "The specified item could not be found in the keychain.");
    },
  });
  assert.equal(missingKey, null);

  await assert.rejects(
    readApiKey({
      env: {},
      platform: "darwin",
      execFileFn: (command, args, options, callback) => callback(new Error("Keychain locked"), "", "User interaction is not allowed."),
    }),
    /User interaction is not allowed/
  );
});

test("getAcoustidStatus reports a missing key without returning credentials", async () => {
  const status = await getAcoustidStatus({ apiKeyFn: async () => null });
  assert.equal(status.configured, false);
  assert.equal(status.state, "missing");
  assert.equal(JSON.stringify(status).includes("test-key"), false);
});

test("checkAcoustidKey verifies a key using a local synthetic fingerprint", async () => {
  let fingerprintedPath = "";
  let requestedUrl = "";
  const result = await checkAcoustidKey({
    apiKeyFn: async () => "test-key",
    fpcalcFn: async (filePath) => {
      fingerprintedPath = filePath;
      return { fingerprint: "synthetic-silence", duration: 3 };
    },
    fetchFn: async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ status: "ok", results: [] }) };
    },
  });
  assert.equal(result.configured, true);
  assert.equal(result.valid, true);
  assert.equal(result.state, "valid");
  assert.match(fingerprintedPath, /ple-acoustid-check-/);
  assert.match(requestedUrl, /client=test-key/);
  assert.match(requestedUrl, /fingerprint=synthetic-silence/);
});

test("checkAcoustidKey reports rejected credentials and network errors", async () => {
  const invalid = await checkAcoustidKey({
    apiKeyFn: async () => "bad-key",
    fpcalcFn: async () => ({ fingerprint: "silence", duration: 3 }),
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ status: "error", error: { message: "Invalid client" } }),
    }),
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.state, "invalid");
  assert.match(invalid.message, /Invalid client/);

  const offline = await checkAcoustidKey({
    apiKeyFn: async () => "test-key",
    fpcalcFn: async () => ({ fingerprint: "silence", duration: 3 }),
    fetchFn: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(offline.state, "connection_error");
  assert.match(offline.message, /offline/);
});

test("AcoustID HTTP 400 exposes its invalid-key reason instead of a generic connection error", async () => {
  const result = await checkAcoustidKey({
    apiKeyFn: async () => "bad-key",
    fpcalcFn: async () => ({ fingerprint: "silence", duration: 3 }),
    fetchFn: async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ status: "error", error: { code: 4, message: "invalid API key" } }),
    }),
  });
  assert.equal(result.state, "invalid");
  assert.match(result.message, /HTTP 400/);
  assert.match(result.message, /invalid API key/);
  assert.match(result.message, /Replace it with the application key/);
  assert.doesNotMatch(result.message, /bad-key/);
});

test("AcoustID HTTP 404 is reported as an endpoint error with response details", async () => {
  const result = getApiError({ error: { message: "not found" } }, "", 404);
  assert.equal(result.state, "service_error");
  assert.match(result.message, /HTTP 404/);
  assert.match(result.message, /not found/);
});

test("AcoustID non-JSON HTTP errors retain their response body for diagnosis", async () => {
  const result = await checkAcoustidKey({
    apiKeyFn: async () => "test-key",
    fpcalcFn: async () => ({ fingerprint: "silence", duration: 3 }),
    fetchFn: async () => ({ ok: false, status: 400, text: async () => "invalid fingerprint" }),
  });
  assert.equal(result.state, "request_error");
  assert.match(result.message, /invalid fingerprint/);
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

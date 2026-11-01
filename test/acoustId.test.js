const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  identifyByFingerprint,
  readApiKey,
  getAcoustidStatus,
  checkAcoustidKey,
  getApiError,
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

test("readApiKey prefers an environment key and reads the macOS Application Support fallback", async (t) => {
  const supportDir = await fs.mkdtemp(path.join(os.tmpdir(), "ple-acoustid-key-"));
  t.after(() => fs.rm(supportDir, { recursive: true, force: true }));
  const keyFile = path.join(supportDir, "acoustid-api-key");
  await fs.writeFile(keyFile, "stored-key\n", { mode: 0o600 });
  assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);

  assert.equal(await readApiKey({ env: { ACOUSTID_API_KEY: " env-key " }, platform: "darwin" }), "env-key");
  assert.equal(await readApiKey({ env: {}, platform: "linux" }), null);
  assert.equal(await readApiKey({
    env: { PLE_ACOUSTID_KEY_FILE: keyFile },
    platform: "darwin",
  }), "stored-key");
  assert.equal(await readApiKey({
    env: { ACOUSTID_API_KEY: "override", PLE_ACOUSTID_KEY_FILE: keyFile },
    platform: "darwin",
  }), "override");
});

test("readApiKey handles a missing key file and surfaces other file errors without invoking Keychain", async (t) => {
  const supportDir = await fs.mkdtemp(path.join(os.tmpdir(), "ple-acoustid-key-"));
  t.after(() => fs.rm(supportDir, { recursive: true, force: true }));
  const missingPath = path.join(supportDir, "missing-key");
  const directoryPath = path.join(supportDir, "not-a-key-file");
  await fs.mkdir(directoryPath);
  let securityCliCalled = false;
  const options = {
    platform: "darwin",
    execFileFn: () => { securityCliCalled = true; },
  };
  assert.equal(await readApiKey({
    ...options,
    env: { PLE_ACOUSTID_KEY_FILE: missingPath },
  }), null);
  await assert.rejects(readApiKey({
    ...options,
    env: { PLE_ACOUSTID_KEY_FILE: directoryPath },
  }), /Couldn't read the local AcoustID key file/);
  assert.equal(securityCliCalled, false);
});

test("the saved key survives replacing the app bundle because it lives in Application Support", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ple-acoustid-upgrade-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const supportDir = path.join(home, "Library", "Application Support", "Playlist Exporter");
  const keyFile = path.join(supportDir, "acoustid-api-key");
  const oldApp = path.join(home, "Applications", "Playlist Exporter 1.2.2.app");
  const newApp = path.join(home, "Applications", "Playlist Exporter 1.2.3.app");
  await fs.mkdir(supportDir, { recursive: true });
  await fs.mkdir(oldApp, { recursive: true });
  await fs.writeFile(keyFile, "persistent-key\n", { mode: 0o600 });

  const readFromInstalledApp = () => readApiKey({
    env: { PLE_ACOUSTID_KEY_FILE: keyFile },
    platform: "darwin",
  });
  assert.equal(await readFromInstalledApp(), "persistent-key");
  await fs.rm(oldApp, { recursive: true });
  await fs.mkdir(newApp, { recursive: true });
  assert.equal(await readFromInstalledApp(), "persistent-key");
});

test("getAcoustidStatus identifies the Application Support key source", async (t) => {
  const supportDir = await fs.mkdtemp(path.join(os.tmpdir(), "ple-acoustid-key-"));
  t.after(() => fs.rm(supportDir, { recursive: true, force: true }));
  const keyFile = path.join(supportDir, "acoustid-api-key");
  await fs.writeFile(keyFile, "stored-key\n", { mode: 0o600 });
  const previous = process.env.PLE_ACOUSTID_KEY_FILE;
  process.env.PLE_ACOUSTID_KEY_FILE = keyFile;
  try {
    const status = await getAcoustidStatus();
    assert.equal(status.configured, true);
    assert.equal(status.source, "application_support");
  } finally {
    if (previous === undefined) delete process.env.PLE_ACOUSTID_KEY_FILE;
    else process.env.PLE_ACOUSTID_KEY_FILE = previous;
  }
});

test("getAcoustidStatus reports unreadable local key files instead of treating them as missing", async (t) => {
  const supportDir = await fs.mkdtemp(path.join(os.tmpdir(), "ple-acoustid-key-"));
  t.after(() => fs.rm(supportDir, { recursive: true, force: true }));
  const previous = process.env.PLE_ACOUSTID_KEY_FILE;
  process.env.PLE_ACOUSTID_KEY_FILE = supportDir;
  try {
    const status = await getAcoustidStatus();
    assert.equal(status.configured, false);
    assert.equal(status.state, "error");
    assert.match(status.message, /local AcoustID key file/);
  } finally {
    if (previous === undefined) delete process.env.PLE_ACOUSTID_KEY_FILE;
    else process.env.PLE_ACOUSTID_KEY_FILE = previous;
  }
});

test("getAcoustidStatus reports a missing key without returning credentials", async () => {
  const status = await getAcoustidStatus({ apiKeyFn: async () => null });
  assert.equal(status.configured, false);
  assert.equal(status.state, "missing");
  assert.equal(JSON.stringify(status).includes("test-key"), false);
});

test("checkAcoustidKey uses the saved Application Support key just like the native app", async (t) => {
  const supportDir = await fs.mkdtemp(path.join(os.tmpdir(), "ple-acoustid-key-"));
  t.after(() => fs.rm(supportDir, { recursive: true, force: true }));
  const keyFile = path.join(supportDir, "acoustid-api-key");
  await fs.writeFile(keyFile, "stored-key\n", { mode: 0o600 });
  const previous = process.env.PLE_ACOUSTID_KEY_FILE;
  const previousApiKey = process.env.ACOUSTID_API_KEY;
  delete process.env.ACOUSTID_API_KEY;
  process.env.PLE_ACOUSTID_KEY_FILE = keyFile;
  try {
    let requestedUrl = "";
    const result = await checkAcoustidKey({
      fpcalcFn: async () => ({ fingerprint: "synthetic-silence", duration: 3 }),
      fetchFn: async (url) => {
        requestedUrl = url;
        return { ok: true, json: async () => ({ status: "ok", results: [] }) };
      },
    });
    assert.equal(result.valid, true);
    assert.equal(result.source, "application_support");
    assert.match(requestedUrl, /client=stored-key/);
  } finally {
    if (previous === undefined) delete process.env.PLE_ACOUSTID_KEY_FILE;
    else process.env.PLE_ACOUSTID_KEY_FILE = previous;
    if (previousApiKey === undefined) delete process.env.ACOUSTID_API_KEY;
    else process.env.ACOUSTID_API_KEY = previousApiKey;
  }
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

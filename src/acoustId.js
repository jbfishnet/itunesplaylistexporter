const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const ACOUSTID_LOOKUP_URL = "https://api.acoustid.org/v2/lookup";
const FPCALC_TIMEOUT_MS = 30_000;
let credentialStatus = { state: "unknown", message: null, checkedAt: null };

function updateCredentialStatus(state, message = null) {
  credentialStatus = { state, message, checkedAt: new Date().toISOString() };
}

function getApiKeyFilePath(env = process.env, platform = process.platform) {
  if (env.PLE_ACOUSTID_KEY_FILE?.trim()) return env.PLE_ACOUSTID_KEY_FILE.trim();
  if (platform !== "darwin") return null;
  return path.join(os.homedir(), "Library", "Application Support", "Playlist Exporter", "acoustid-api-key");
}

function getApiKeySource(env = process.env, platform = process.platform) {
  if (env.ACOUSTID_API_KEY?.trim()) return "environment";
  return getApiKeyFilePath(env, platform) ? "application_support" : null;
}

async function readApiKey({ env = process.env, platform = process.platform, keyFilePath } = {}) {
  const environmentKey = env.ACOUSTID_API_KEY?.trim();
  if (environmentKey) return environmentKey;

  const filePath = keyFilePath || getApiKeyFilePath(env, platform);
  if (!filePath) return null;
  try {
    return (await fs.readFile(filePath, "utf8")).trim() || null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`Couldn't read the local AcoustID key file: ${err.message}`);
  }
}

function runFpcalc(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      "fpcalc",
      ["-json", filePath],
      { maxBuffer: 1024 * 1024 * 8, timeout: FPCALC_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

function makeSilenceWav() {
  const sampleRate = 8000;
  const seconds = 3;
  const dataSize = sampleRate * seconds * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

async function getSyntheticFingerprint(fpcalcFn = runFpcalc) {
  const filePath = path.join(os.tmpdir(), `ple-acoustid-check-${process.pid}-${Date.now()}.wav`);
  try {
    await fs.writeFile(filePath, makeSilenceWav(), { flag: "wx" });
    const result = await fpcalcFn(filePath);
    if (!result?.fingerprint || !result?.duration) {
      throw new Error("Chromaprint did not return a fingerprint for the test audio");
    }
    return result;
  } finally {
    await fs.unlink(filePath).catch((err) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}

function apiErrorMessage(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") return error.message || JSON.stringify(error);
  return "AcoustID returned an unspecified error";
}

function getApiError(responseData, responseBody, httpStatus) {
  const error = responseData?.error;
  const code = error?.code;
  const message = apiErrorMessage(error);
  const invalidKey = code === 4 || /invalid api key|invalid client|unknown client/i.test(message);

  if (invalidKey) {
    return {
      state: "invalid",
      message: `AcoustID rejected the application key (HTTP ${httpStatus}): ${message}. Replace it with the application key from your AcoustID account.`,
    };
  }
  if (httpStatus === 404) {
    const detail = responseData?.error
      ? message
      : responseBody;
    return {
      state: "service_error",
      message: `AcoustID's lookup endpoint returned HTTP 404${detail ? `: ${detail}` : ""}. Check the app version or service endpoint.`,
    };
  }
  if (httpStatus) {
    const detail = responseData?.error
      ? message
      : responseBody || `HTTP ${httpStatus}`;
    return {
      state: httpStatus >= 500 ? "service_error" : "request_error",
      message: `AcoustID rejected the lookup request (HTTP ${httpStatus}): ${detail}`,
    };
  }
  return {
    state: "request_error",
    message: `AcoustID rejected the lookup request: ${message}`,
  };
}

async function queryAcoustId(fingerprint, apiKey, fetchFn) {
  const params = new URLSearchParams({
    client: apiKey,
    // URLSearchParams serializes spaces as "+"; AcoustID requires that
    // spelling between meta values to include recording details.
    meta: "recordings releasegroups",
    duration: String(Math.round(fingerprint.duration)),
    fingerprint: fingerprint.fingerprint,
  });

  let response;
  try {
    response = await fetchFn(`${ACOUSTID_LOOKUP_URL}?${params.toString()}`);
  } catch (err) {
    updateCredentialStatus("connection_error", `Couldn't reach AcoustID: ${err.message}`);
    return { ok: false, error: credentialStatus.message };
  }
  let data;
  let responseBody = "";
  try {
    if (typeof response.text === "function") {
      responseBody = await response.text();
      data = responseBody ? JSON.parse(responseBody) : null;
    } else if (typeof response.json === "function") {
      data = await response.json();
      responseBody = JSON.stringify(data);
    } else {
      throw new Error("Response has no readable body");
    }
  } catch (err) {
    const status = response.status || 0;
    if (!response.ok) {
      const { state, message } = getApiError(null, responseBody, status);
      updateCredentialStatus(state, message);
      return { ok: false, error: credentialStatus.message };
    }
    updateCredentialStatus("service_error", `AcoustID returned invalid JSON: ${err.message}`);
    return { ok: false, error: credentialStatus.message };
  }
  if (!response.ok) {
    const { state, message } = getApiError(data, "", response.status);
    updateCredentialStatus(state, message);
    return { ok: false, error: credentialStatus.message };
  }
  if (data.status !== "ok") {
    const { state, message } = getApiError(data, responseBody, response.status);
    updateCredentialStatus(state, message);
    return { ok: false, error: credentialStatus.message };
  }

  updateCredentialStatus("valid");
  return { ok: true, data };
}

async function getAcoustidStatus({ apiKeyFn = readApiKey } = {}) {
  try {
    const apiKey = await apiKeyFn();
    if (!apiKey) {
      credentialStatus = { state: "missing", message: "No AcoustID application key is configured.", checkedAt: null };
    } else if (credentialStatus.state === "missing") {
      credentialStatus = { state: "unknown", message: null, checkedAt: null };
    }
    const source = apiKey ? getApiKeySource() : null;
    return { configured: Boolean(apiKey), source, ...credentialStatus };
  } catch (err) {
    updateCredentialStatus("error", err.message);
    return { configured: false, source: null, ...credentialStatus };
  }
}

async function checkAcoustidKey({ apiKeyFn = readApiKey, fpcalcFn = runFpcalc, fetchFn = globalThis.fetch } = {}) {
  let apiKey;
  try {
    apiKey = await apiKeyFn();
  } catch (err) {
    updateCredentialStatus("error", err.message);
    return { configured: false, valid: false, source: null, ...credentialStatus };
  }
  if (!apiKey) {
    updateCredentialStatus("missing", "No AcoustID application key is configured.");
    return { configured: false, valid: false, source: null, ...credentialStatus };
  }

  let fingerprint;
  try {
    fingerprint = await getSyntheticFingerprint(fpcalcFn);
  } catch (err) {
    updateCredentialStatus("fingerprint_unavailable", `Couldn't create the local test fingerprint: ${err.message}`);
    return { configured: true, valid: false, source: getApiKeySource(), ...credentialStatus };
  }

  const result = await queryAcoustId(fingerprint, apiKey, fetchFn);
  return {
    configured: true,
    valid: result.ok,
    source: getApiKeySource(),
    ...credentialStatus,
  };
}

/**
 * Identifies a track from the audio itself (via chromaprint fingerprinting +
 * the AcoustID/MusicBrainz database) rather than tags or filename — the
 * last resort when text search finds nothing, since it doesn't care how
 * messy the filename or tags are. A deliberate no-op (returns null, cheaply,
 * without ever touching the network or spawning fpcalc) whenever no
 * ACOUSTID_API_KEY or the macOS Application Support key file is configured.
 * The native app stores the key outside the replaceable app bundle; command-line
 * use can still provide the environment variable.
 */
async function identifyByFingerprint(
  filePath,
  { fetchFn = globalThis.fetch, fpcalcFn = runFpcalc, apiKeyFn = readApiKey } = {}
) {
  let apiKey;
  try {
    apiKey = await apiKeyFn();
  } catch (err) {
    updateCredentialStatus("error", err.message);
    return null;
  }
  if (!apiKey) {
    updateCredentialStatus("missing", "No AcoustID application key is configured.");
    return null;
  }

  let fingerprint;
  try {
    fingerprint = await fpcalcFn(filePath);
  } catch {
    // A missing/unreadable file or unavailable fpcalc is not an API-key issue.
    return null;
  }
  if (!fingerprint?.fingerprint || !fingerprint?.duration) return null;

  const lookup = await queryAcoustId(fingerprint, apiKey, fetchFn);
  if (!lookup.ok) return null;
  const { data } = lookup;
  if (!Array.isArray(data.results) || data.results.length === 0) return null;

  const best = data.results.reduce((a, b) => ((b.score || 0) > (a.score || 0) ? b : a));
  const recording = best.recordings?.[0];
  if (!recording) return null;

  const releasegroup = recording.releasegroups?.[0];
  return {
    title: recording.title || null,
    artist: (recording.artists || []).map((a) => a.name).join(", ") || null,
    album: releasegroup?.title || null,
    genre: null,
    year: null,
  };
}

module.exports = {
  identifyByFingerprint,
  readApiKey,
  getAcoustidStatus,
  checkAcoustidKey,
  getApiError,
  getApiKeyFilePath,
  getApiKeySource,
};

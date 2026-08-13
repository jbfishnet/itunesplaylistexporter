const { execFile } = require("child_process");

const ACOUSTID_LOOKUP_URL = "https://api.acoustid.org/v2/lookup";
const FPCALC_TIMEOUT_MS = 30_000;

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

/**
 * Identifies a track from the audio itself (via chromaprint fingerprinting +
 * the AcoustID/MusicBrainz database) rather than tags or filename — the
 * last resort when text search finds nothing, since it doesn't care how
 * messy the filename or tags are. A deliberate no-op (returns null, cheaply,
 * without ever touching the network or spawning fpcalc) whenever
 * ACOUSTID_API_KEY isn't set, so this is inert until a key is configured —
 * see macapp/ or README for how to get one (free, from acoustid.org).
 */
async function identifyByFingerprint(filePath, { fetchFn = globalThis.fetch, fpcalcFn = runFpcalc } = {}) {
  const apiKey = process.env.ACOUSTID_API_KEY;
  if (!apiKey) return null;

  let fingerprint;
  try {
    fingerprint = await fpcalcFn(filePath);
  } catch {
    // fpcalc not installed, unreadable file, timeout, etc. — not fatal, this
    // is just one signal among several; the caller falls back to not_found.
    return null;
  }
  if (!fingerprint?.fingerprint || !fingerprint?.duration) return null;

  const params = new URLSearchParams({
    client: apiKey,
    // A space here, not a literal "+": URLSearchParams percent-encodes a
    // literal "+" in a value to "%2B" (correct per the URL spec, but
    // AcoustID's API specifically wants a literal "+" between meta values)
    // — a space is what URLSearchParams itself serializes *as* "+" in
    // application/x-www-form-urlencoded output, so this is the one spelling
    // that survives being encoded. Verified against the real API: without
    // this, lookups still return matches but silently omit the nested
    // recordings/releasegroups data this whole function depends on.
    meta: "recordings releasegroups",
    duration: String(Math.round(fingerprint.duration)),
    fingerprint: fingerprint.fingerprint,
  });

  let response;
  try {
    response = await fetchFn(`${ACOUSTID_LOOKUP_URL}?${params.toString()}`);
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const data = await response.json();
  if (data.status !== "ok" || !Array.isArray(data.results) || data.results.length === 0) return null;

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

module.exports = { identifyByFingerprint };

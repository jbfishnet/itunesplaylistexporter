const fs = require("fs");
const path = require("path");

/**
 * Decides whether a track can be exported as a plain audio file.
 * Combines what Music.app reports (location, kind) with an actual
 * filesystem check, since the NAS share may not be mounted right now.
 */
function classifyTrack(track) {
  const extension = track.location
    ? path.extname(track.location).replace(".", "").toLowerCase()
    : null;
  const kindLower = (track.kind || "").toLowerCase();

  if (!track.location) {
    return {
      status: "missing",
      reason:
        "Not found in Music.app — likely a cloud/matched track that hasn't been downloaded locally",
      extension,
    };
  }

  // "kind" comes from Music.app localized to the user's system language (e.g.
  // German "Geschützte AAC-Audiodatei"), so the extension is the reliable
  // signal — the kind-string check is only a best-effort supplement.
  const PROTECTED_KIND_HINTS = ["protected", "geschützt", "geschuetzt"];
  const looksProtectedByKind = PROTECTED_KIND_HINTS.some((hint) => kindLower.includes(hint));

  if (extension === "m4p" || looksProtectedByKind) {
    return {
      status: "protected",
      reason: "Protected AAC (FairPlay) — can't be copied",
      extension,
    };
  }

  if (!fs.existsSync(track.location)) {
    return {
      status: "missing",
      reason: "File not found at its expected path — is the NAS share mounted?",
      extension,
    };
  }

  return { status: "ready", reason: null, extension };
}

module.exports = { classifyTrack };

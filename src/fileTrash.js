const { execFile } = require("child_process");

// Same escaping rule as musicLibrary.js's escapeAppleScriptString — this
// embeds an arbitrary filesystem path into an AppleScript string literal.
function escapeAppleScriptString(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Moves a file to the actual macOS Trash (recoverable) rather than unlinking
 * it outright — used for deletions that aren't backed by the same safety
 * net as the Duplicates tab's permanent delete (a confirmed byte-identical
 * copy elsewhere). Finder's own `delete` command is the standard way to
 * trash a file via AppleScript; there's no lower-level POSIX equivalent.
 */
function moveToTrash(filePath) {
  return new Promise((resolve, reject) => {
    const script = `tell application "Finder" to delete POSIX file "${escapeAppleScriptString(filePath)}"`;
    execFile("osascript", ["-e", script], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
        return;
      }
      resolve();
    });
  });
}

module.exports = { moveToTrash };

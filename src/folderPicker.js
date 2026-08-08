const { execFile } = require("child_process");

/**
 * Opens the native macOS "choose folder" dialog so the destination is always
 * picked by clicking through Finder, never typed. Resolves to null if the
 * user cancels rather than rejecting, since that's not an error condition.
 */
function chooseFolder(promptText) {
  return new Promise((resolve, reject) => {
    const escapedPrompt = promptText.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `POSIX path of (choose folder with prompt "${escapedPrompt}")`;
    execFile("osascript", ["-e", script], (err, stdout, stderr) => {
      if (err) {
        const message = stderr?.trim() || err.message;
        if (message.includes("-128")) {
          resolve(null); // user clicked Cancel
          return;
        }
        reject(new Error(message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function freeSpaceLabel(targetPath) {
  return new Promise((resolve) => {
    execFile("df", ["-k", targetPath], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const lines = stdout.trim().split("\n");
      const fields = lines[lines.length - 1].trim().split(/\s+/);
      const availableKb = parseInt(fields[3], 10);
      if (!Number.isFinite(availableKb)) {
        resolve(null);
        return;
      }
      const gb = availableKb / (1024 * 1024);
      resolve(gb >= 1 ? `${gb.toFixed(1)} GB free` : `${Math.round(availableKb / 1024)} MB free`);
    });
  });
}

module.exports = { chooseFolder, freeSpaceLabel };

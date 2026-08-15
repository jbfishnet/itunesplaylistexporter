// Stand-in for src/fileTrash.js used only by tests (via PLE_TEST_FILE_TRASH)
// — the real module shells out to Finder via AppleScript, which needs
// Automation/TCC consent no CI runner has. Actually removes the file from
// its original path (via fs.unlink, not a real move-to-Trash) so a test can
// still assert the file is gone from where it was, which is the part that
// actually matters for exercising the route's own logic.
const fs = require("fs");

let calls = [];

function moveToTrash(filePath) {
  calls.push(filePath);
  return new Promise((resolve, reject) => {
    fs.unlink(filePath, (err) => {
      if (err && err.code !== "ENOENT") {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  moveToTrash,
  __calls: calls,
  __reset() {
    calls.length = 0;
  },
};

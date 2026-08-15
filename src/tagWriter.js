const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const NodeID3 = require("node-id3");
const { isPlaceholderAlbum } = require("./metadataPlaceholders");

// Only formats with a well-supported, safe writer here. .m4p is DRM and must
// never be touched (also excluded by the `protected` check below, but this
// is a second, format-based guard). Anything else (.wav, ...) is silently
// skipped rather than risking a writer this app doesn't actually have.
const WRITABLE_EXTENSIONS = new Set(["mp3", "m4a"]);

const FIELDS = ["title", "artist", "album", "genre", "year"];

/** Only the fields that are currently empty (or, for album, a recognized
 * placeholder like "Unknown Album" — see metadataPlaceholders.js) *and*
 * present in the new tags — this is the entire safety mechanism: a field
 * with any other existing value, correct or not, is never touched. */
function fieldsToFill(row, newTags) {
  const fields = {};
  for (const key of FIELDS) {
    const existing = row[key];
    let isEmpty = existing === null || existing === undefined || String(existing).trim() === "";
    if (!isEmpty && key === "album" && isPlaceholderAlbum(existing)) isEmpty = true;
    if (isEmpty && newTags[key] !== null && newTags[key] !== undefined && String(newTags[key]).trim() !== "") {
      fields[key] = newTags[key];
    }
  }
  return fields;
}

async function writeTagsForRow(row, newTags) {
  if (row.protected) return { written: false, reason: "protected" };

  const ext = (row.extension || "").toLowerCase();
  if (!WRITABLE_EXTENSIONS.has(ext)) return { written: false, reason: "unsupported-format" };

  const fields = fieldsToFill(row, newTags);
  if (Object.keys(fields).length === 0) return { written: false, reason: "nothing-missing" };

  if (ext === "mp3") return writeMp3Tags(row.path, fields);
  return writeMp4Tags(row.path, fields);
}

/** Reads the whole file into memory, merges tags via node-id3 (which
 * preserves every existing frame it isn't asked to change), and only writes
 * back through a temp file + atomic rename — never edited in place — so a
 * crash or a failed write can never leave a half-written file on disk. */
function writeMp3Tags(filePath, fields) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, (readErr, buffer) => {
      if (readErr) {
        reject(readErr);
        return;
      }

      const id3Fields = {};
      if (fields.title) id3Fields.title = fields.title;
      if (fields.artist) id3Fields.artist = fields.artist;
      if (fields.album) id3Fields.album = fields.album;
      if (fields.genre) id3Fields.genre = fields.genre;
      if (fields.year) id3Fields.year = String(fields.year);

      let updated;
      try {
        updated = NodeID3.update(id3Fields, buffer);
      } catch (updateErr) {
        reject(updateErr);
        return;
      }
      if (!Buffer.isBuffer(updated)) {
        reject(new Error("node-id3 did not return an updated buffer"));
        return;
      }

      const tempPath = `${filePath}.ple-tmp-${process.pid}-${Date.now()}`;
      fs.writeFile(tempPath, updated, (writeErr) => {
        if (writeErr) {
          fs.unlink(tempPath, () => {});
          reject(writeErr);
          return;
        }
        fs.rename(tempPath, filePath, (renameErr) => {
          if (renameErr) {
            fs.unlink(tempPath, () => {});
            reject(renameErr);
            return;
          }
          resolve({ written: true, fields: Object.keys(fields) });
        });
      });
    });
  });
}

/** M4A tags live in MP4 container atoms, not ID3 — ffmpeg remuxes losslessly
 * (`-codec copy`, no re-encoding) into a temp file with `-map_metadata 0`
 * carrying over every existing tag, then only the missing fields are
 * overridden. Same temp-file + rename safety as the MP3 path. */
function writeMp4Tags(filePath, fields) {
  return new Promise((resolve, reject) => {
    const tempPath = `${filePath}.ple-tmp-${process.pid}-${Date.now()}${path.extname(filePath)}`;
    const args = ["-y", "-i", filePath, "-map_metadata", "0", "-codec", "copy"];
    if (fields.title) args.push("-metadata", `title=${fields.title}`);
    if (fields.artist) args.push("-metadata", `artist=${fields.artist}`);
    if (fields.album) args.push("-metadata", `album=${fields.album}`);
    if (fields.genre) args.push("-metadata", `genre=${fields.genre}`);
    if (fields.year) args.push("-metadata", `date=${fields.year}`);
    args.push(tempPath);

    execFile("ffmpeg", args, { maxBuffer: 1024 * 1024 * 16 }, (err) => {
      if (err) {
        fs.unlink(tempPath, () => {});
        reject(err);
        return;
      }
      fs.rename(tempPath, filePath, (renameErr) => {
        if (renameErr) {
          fs.unlink(tempPath, () => {});
          reject(renameErr);
          return;
        }
        resolve({ written: true, fields: Object.keys(fields) });
      });
    });
  });
}

module.exports = { writeTagsForRow, fieldsToFill, WRITABLE_EXTENSIONS };

// Sentinel values several rippers/taggers write instead of leaving a field
// genuinely empty. Recognized as "no real data" everywhere a field's
// completeness is judged — both by the scanner (decideNeedsEnrichment, which
// decides whether a file needs an iTunes lookup) and by the tag writer
// (fieldsToFill, which decides whether it's safe to overwrite a field with
// an enrichment result). Those two checks used to live separately and drift
// out of sync: a file whose only gap was album="Unknown Album" was correctly
// flagged as needing enrichment, but the tag writer treated "Unknown Album"
// as a real (if oddly-named) tag and refused to replace it — so the on-disk
// file never actually got fixed, and the same file was flagged as needing
// enrichment again on every future scan, forever. Sharing one definition
// here means that can't happen again.
const PLACEHOLDER_ALBUMS = new Set(["unknown album", "unknown", ""]);

function isPlaceholderAlbum(album) {
  return PLACEHOLDER_ALBUMS.has((album || "").trim().toLowerCase());
}

module.exports = { isPlaceholderAlbum };

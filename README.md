# itunesplaylistexporter

A local macOS web app with several tabs, built around two independent data
sources — Music.app itself (Playlists) and a raw filesystem index of a NAS
archive (Search/Library Index/Duplicates):

- **Playlists** — exports Music.app playlists to a plain folder structure —
  one folder per playlist, containing the actual audio files — so you can
  copy them onto a memory card for a car head unit. DRM-protected purchases
  (`.m4p`) and tracks that aren't available locally are detected and skipped,
  with the reason shown in the UI before you export. Missing tracks can also
  be restored directly in Music.app — see "Restoring missing tracks" below.
- **Search** — indexes a whole NAS music archive directly from disk (not
  through Music.app), so you can search across it by title/artist/album/
  genre/filename. The index rebuilds itself incrementally every hour, and
  sparsely-tagged files get their metadata filled in automatically via a
  background lookup against Apple's iTunes Search API.
- **Duplicates** — surfaces byte-identical files and same-title-but-different
  files found by that same index, with the ability to delete extra copies —
  see "Duplicates tab — how it works" below.

No Apple Developer account is needed — this is a local Node.js server plus a
browser UI, not a signed/notarized app.

## Playlists tab — how it works

- **Reading playlists**: talks to Music.app live via AppleScript (`osascript`).
  Only user-created playlists (regular + smart) are listed — the built-in
  Library/Music sources and playlist folders are excluded.
- **Exportability check**: a track is skipped if it has no local file (e.g. an
  Apple Music match that was never downloaded), if Music.app reports it as
  protected AAC / its extension is `.m4p`, or if the file can't actually be
  found on disk (e.g. your NAS share isn't mounted right now).
- **File layout**: each selected playlist becomes a folder at your chosen
  destination, containing its exportable tracks flat (no Artist/Album
  subfolders), named `NN - Title.ext` where `NN` is the track's position in
  the playlist — so most car head units play them in the right order. Name
  collisions get a `(2)`, `(3)`, … suffix.

### Restoring missing tracks

Each playlist with missing tracks shows a **Restore missing tracks** button.
This is the one feature in this app that writes to your actual Music.app
library, not just reads from it:

- A missing track that exactly matches a file already in the Search tab's
  index (same title and artist) is automatically imported into your Music
  library and added to the playlist in place of the broken entry — no
  confirmation asked, since the match is unambiguous.
- A track that only partially matches (same title, different/missing artist,
  or several plausible files) is left for you to review: pick which file it
  is, or skip it.
- A track with no local match at all gets an automatic Music.app download
  attempt (for Apple Music-matched tracks that were never downloaded). This
  isn't guaranteed to work on every macOS/Music.app version — if it isn't
  supported on your setup, the track is reported as such so you can download
  it manually in Music.app instead, then restore again.

## Setup

```bash
npm install
npm start
```

This opens `http://localhost:4173` in your default browser.

### First run: Automation permission

The first time the app queries Music.app, macOS will show a permission
prompt asking to let your terminal (or whatever runs `node`) control
Music.app. You need to approve this — if you miss it or deny it, re-enable it
under **System Settings > Privacy & Security > Automation**.

### Using NAS-hosted music

If your library's media lives on a network share (e.g.
`smb://fishnetnas/jb/Itunes-Dez-2024/Musik/Media.localized`), make sure it's
mounted in Finder before exporting — otherwise those tracks will show as
"missing" even though Music.app knows about them.

## Search tab — how it works

- **Indexing**: on startup, and then every hour, the app walks
  `/Volumes/jb/iTunes4TB/iTunes Media/Music` (override with the
  `PLE_LIBRARY_ROOT` environment variable) directly on disk — no Music.app
  involved — reading embedded tags (ID3/MP4/FLAC/etc.) from every audio file
  it finds. Rescans are incremental: only new or changed files are re-read;
  unchanged files are skipped, so only the very first scan of a large archive
  is slow. If the NAS isn't mounted when a scan runs, the existing index is
  left untouched rather than being wiped.
- **Search**: full-text search across title/artist/album/genre, and always
  the filename/folder too — so even a completely untagged file is still
  findable.
- **Metadata enrichment**: files with missing or placeholder tags (no artist,
  no genre, an album literally called "Unknown Album", etc.) are queued for a
  background lookup against Apple's iTunes Search API — no signup or API key
  needed. This runs slowly and continuously (roughly one lookup every 1.75s)
  so it never hammers Apple's servers or blocks anything else; a large
  backlog just drains gradually in the background. Well-tagged files are
  never looked up at all.
- **The index** lives at `data/library.sqlite3` (gitignored) — delete that
  file any time to force a full reindex from scratch.
- Protected-file detection here is extension-only (`.m4p`) — unlike the
  Playlists tab, there's no Music.app "kind" string available from a raw
  filesystem scan.

## Duplicates tab — how it works

Built on the same index as the Search tab, this tab has two sections:

- **Exact Duplicates** — files that are byte-identical (same content hash).
  Always safe to delete: one copy per group is kept (whichever was indexed
  first), and the rest can be deleted individually or all at once.
- **Similar Titles** — files that share a title but differ in some other way
  (artist, album, format, size, ...) — not confirmed identical, so this could
  be a real duplicate or a genuinely different recording (a live version, a
  cover, a remix). Deletion here follows one hard rule: **a copy under
  `/Volumes/jb/iTunes4TB/iTunes Media/Music` is never deleted** — it's always
  the one kept. If a group has no copy under that path, the oldest-indexed
  copy is kept instead. Deletes in this section fire immediately (no
  confirmation dialog), per-file, per-group ("Delete other copies"), or for
  every group at once ("Delete All Non-Canonical Copies").

Both sections delete the file from disk permanently (not to the Trash) and
remove it from the index — this can't be undone.

## Notes

- Destination filenames are sanitized for exFAT/FAT32 (the common formats for
  car-audio SD cards/USB drives), so the export folder is safe to use even if
  track titles contain characters like `:` or `/`.
- The Duplicates tab can permanently delete files from your NAS archive (see
  above), and the Playlists tab's "Restore missing tracks" can add tracks to
  and remove tracks from your real Music.app library (see above) — both are
  deliberate, user-triggered exceptions to the rule below.
- Otherwise, nothing is deleted or modified in your Music library or your NAS
  archive — every other action only ever reads files (and, for exporting,
  copies them elsewhere). Metadata enrichment results are stored only in the
  local search index, not written back into the actual audio files.

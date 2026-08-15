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
- A toast confirms what happened as soon as it's done (e.g. "3 fixed, 1 need
  your input"), and the track list itself shows exactly which tracks were
  fixed and which local file each one was matched to — not just a count.

Restoring in place has one real limitation worth knowing: Music.app's
AppleScript dictionary has no way to reposition a track within a playlist
(verified directly against its scripting interface — `move` only repositions
whole playlists, and `add`/`duplicate`'s documented position-specifier
support doesn't actually work), so a restored track always lands at the end
of the playlist, not back in its original spot.

### Right-click a playlist: rebuild as an enriched copy, or delete it

Right-click any playlist in the sidebar for a small options menu, or click the
**⋯** button on the row — right-click's reliability varies across
trackpad/mouse setups inside the native app's WKWebView, so the button is the
guaranteed single-click way in:

- **Rebuild as enriched copy** builds a brand-new playlist (named
  `"Original Name (Enriched)"`) with every track from the original, in the
  *same order* — missing tracks with an exact match are replaced with the
  real file right in their original slot, and anything ambiguous or
  unmatched is preserved exactly as-is rather than dropped. This is the fix
  for the ordering limitation above: instead of trying to reposition a track
  in place (which Music.app's scripting can't do), it builds the whole
  playlist fresh in the right order to begin with. The original playlist is
  never modified — a rebuild is always safe to run.
- **Delete playlist…** asks for confirmation, then deletes the playlist
  itself (not its tracks) — irreversible from this app's side.

Rebuilt copies get their own **Enriched copies** section at the top of the
sidebar (detected by the `(Enriched)` naming convention above, not a
separate flag), so they're easy to find alongside your regular playlists.

## Setup

```bash
npm install
npm start
```

This opens `http://localhost:4173` in your default browser.

### Native app

For a real Mac app instead of a browser tab — Dock icon, its own window,
Cmd+Q/Cmd+W/Cmd+C/Cmd+V, an About panel — build and install
`Playlist Exporter.app`:

```bash
cd macapp
./build.sh
cp -R "dist/Playlist Exporter.app" /Applications/
```

It's a thin native window (Swift + WKWebView) around the same local
server. The build is fully self-contained and relocatable: `build.sh`
copies `server.js`, `src/`, `public/`, and a clean production
`node_modules` into the app bundle itself
(`Contents/Resources/app`), so the built `.app` runs standalone on any
Mac it's copied to — it no longer depends on this git checkout existing
at a fixed path. At launch it locates Node.js itself (checking common
install locations, then the user's shell `PATH`) rather than assuming a
specific install path, and it needs Node.js 24+ to already be installed
on that Mac — if it can't find one, it shows an alert explaining that and
links to nodejs.org rather than failing silently. The search index and
logs live under that user's own `~/Library/Application Support/Playlist
Exporter` and `~/Library/Logs/Playlist Exporter`, not inside the app
bundle (which isn't writable once installed).

Optionally, `macapp/install-autostart.sh` installs a LaunchAgent that runs
the server headlessly at every login (`macapp/uninstall-autostart.sh`
removes it) — the app window works fine with or without this, it just
skips the cold-start delay when the LaunchAgent is already running. It
looks up the installed app and the current user's Node.js at install
time, so it's portable the same way the app itself is.

**Distributing this to other people:** the app is only ad-hoc signed (see
above — no Apple Developer account). Gatekeeper blocks ad-hoc-signed apps
downloaded from the internet on any Mac other than the one that built
them ("[App] is damaged and can't be opened"), until the person opening
it either right-clicks it and chooses **Open** the first time, or runs
`xattr -cr "/Applications/Playlist Exporter.app"` once after copying it
over. Removing that friction for real requires enrolling in the Apple
Developer Program (paid), signing with a Developer ID Application
certificate, and notarizing each build (`xcrun notarytool submit` +
`xcrun stapler staple`) — not set up here, since it's a cost/account
decision rather than a code one.

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
  never looked up at all. A match is written back into the file's own tags
  on disk (MP3 via ID3, M4A via a lossless ffmpeg remux) — never overwriting
  a field that already has a real value, only filling in what was actually
  missing or a recognized placeholder — so the fix is permanent and a
  reindex never needs to re-enrich the same file twice. Protected files and
  formats without a writer (see below) only get the result in the index,
  not the file. If the on-disk write itself fails (ffmpeg missing, a
  permissions error, ...) while the lookup still succeeded, that's tracked
  separately, surfaced in the Queue tab, and automatically retried every few
  minutes without repeating the API lookup — a "Retry failed writes" button
  there triggers an immediate attempt instead of waiting. The search index
  already has the right metadata either way, regardless of whether the file
  write has caught up yet.
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
  cover, a remix). Deletion here follows one hard rule: **a copy under your
  designated main library is never deleted** — it's always the one kept. If a
  group has no copy under it (or no main library is configured), the
  oldest-indexed copy is kept instead. Deletes in this section fire
  immediately (no confirmation dialog), per-file, per-group ("Delete other
  copies"), or for every group at once ("Delete All Non-Canonical Copies").

Both sections delete the file from disk permanently (not to the Trash) and
remove it from the index — this can't be undone.

### Main library

Check **Main library** next to any configured folder in the Search tab's
Library Folders panel to designate it as canonical. This is used in two
places: as the preferred keeper above, and to auto-resolve an otherwise
ambiguous playlist restore/rebuild match (see "Restoring missing tracks"
above) — if the same song exists as 2+ physical copies (e.g. across multiple
NAS snapshots) and exactly one is under the main library, that one is now
auto-applied instead of being left for manual review. Only one folder can be
main at a time; unchecking it clears the preference entirely (both features
fall back to "oldest-indexed"/"still ambiguous" respectively). Defaults to
this developer's own NAS path until explicitly changed, preserving prior
behavior for anyone upgrading.

## Versioning

`package.json`'s `version` field is the single source of truth — nowhere
else hard-codes a version number. To cut a new version, bump it there (plain
[semver](https://semver.org/), `MAJOR.MINOR.PATCH`) in the same commit/PR as
the change it belongs to; everything else picks it up automatically:

- The web UI shows it next to the app name (top-left), fetched live from
  `GET /api/app-info`.
- `macapp/build.sh` reads it into the native app's `Info.plist`
  (`CFBundleVersion`/`CFBundleShortVersionString`), so **About Playlist
  Exporter** and Finder's **Get Info** show it too — rebuild with
  `./build.sh` after bumping to pick up the new number.
- `.github/workflows/ci.yml` reads it into the uploaded build artifact's
  name (`Playlist Exporter-vX.Y.Z`), so old and new builds in the Actions
  run history are distinguishable at a glance.

There's no enforced bump-on-every-PR check — for a single-developer local
tool that's more process than it's worth — so treat it as "bump when the
change is worth a new number," not every commit.

## Notes

- Destination filenames are sanitized for exFAT/FAT32 (the common formats for
  car-audio SD cards/USB drives), so the export folder is safe to use even if
  track titles contain characters like `:` or `/`.
- The Duplicates tab can permanently delete files from your NAS archive (see
  above), the Playlists tab's "Restore missing tracks" can add tracks to and
  remove tracks from your real Music.app library (see above), and background
  metadata enrichment can add missing tags directly into a file on your NAS
  archive (see "Metadata enrichment" above) — these are deliberate,
  behind-the-scenes exceptions to the rule below. Enrichment writes are
  narrowly scoped (only fields that were actually empty or a placeholder,
  never a real existing value) but they do modify files on disk, unprompted,
  in the background — worth knowing if you'd rather your archive's files
  stay byte-for-byte untouched.
- Otherwise, nothing is deleted or modified in your Music library or your NAS
  archive — every other action only ever reads files (and, for exporting,
  copies them elsewhere).

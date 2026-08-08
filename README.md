# itunesplaylistexporter

A local macOS web app that exports Music.app playlists to a plain folder
structure — one folder per playlist, containing the actual audio files — so
you can copy them onto a memory card for a car head unit. DRM-protected
purchases (`.m4p`) and tracks that aren't available locally are detected and
skipped, with the reason shown in the UI before you export.

No Apple Developer account is needed — this is a local Node.js server plus a
browser UI, not a signed/notarized app.

## How it works

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

## Notes

- Destination filenames are sanitized for exFAT/FAT32 (the common formats for
  car-audio SD cards/USB drives), so the export folder is safe to use even if
  track titles contain characters like `:` or `/`.
- Nothing is deleted or modified in your Music library — this only reads
  metadata and copies files.

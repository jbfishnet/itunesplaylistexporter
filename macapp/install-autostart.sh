#!/bin/bash
# Installs a LaunchAgent that runs the Playlist Exporter server in the
# background at every login (headless — no window, no browser tab). Run this
# whenever you decide you want autostart; run uninstall-autostart.sh to
# disable it again. The "Playlist Exporter.app" window always works
# regardless of whether this is installed — it starts the server itself if
# this LaunchAgent isn't running.
set -euo pipefail
cd "$(dirname "$0")"

LABEL="com.janboike.playlistexporter.server"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents"
cp com.janboike.playlistexporter.server.plist "$DEST"

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"

echo "Installed and started: $LABEL"
echo "Logs: /tmp/playlistexporter-launchagent.log"
echo "It will now also start automatically every time you log in."

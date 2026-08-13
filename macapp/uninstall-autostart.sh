#!/bin/bash
# Removes the autostart LaunchAgent installed by install-autostart.sh. The
# app itself still works fine afterward — it just won't run in the
# background until you open it (or a browser tab) again.
set -euo pipefail

LABEL="com.janboike.playlistexporter.server"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$DEST" ]; then
  launchctl unload "$DEST" 2>/dev/null || true
  rm -f "$DEST"
  echo "Removed autostart: $LABEL"
else
  echo "Autostart wasn't installed — nothing to do."
fi

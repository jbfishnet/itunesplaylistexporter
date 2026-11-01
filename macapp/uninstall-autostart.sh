#!/bin/bash
# Removes the autostart LaunchAgent installed by install-autostart.sh. The
# app itself still works fine afterward — it just won't run in the
# background until you open it (or a browser tab) again.
set -euo pipefail

GUI_DOMAIN="gui/$(id -u)"
LABELS=("com.janboike.playlistexporter.app" "com.janboike.playlistexporter.server")

removed=0
for LABEL in "${LABELS[@]}"; do
  DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [ -f "$DEST" ]; then
    launchctl bootout "$GUI_DOMAIN" "$DEST" 2>/dev/null || true
    rm -f "$DEST"
    echo "Removed autostart: $LABEL"
    removed=1
  fi
done

if [ "$removed" -eq 0 ]; then
  echo "Autostart wasn't installed — nothing to do."
fi

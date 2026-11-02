#!/bin/bash
# Installs a LaunchAgent that starts Playlist Exporter in menu-bar-only mode
# at every login. Run uninstall-autostart.sh to disable it.
#
# The plist is generated here rather than checked into git, so this works on
# any Mac the app is installed on: it looks up the installed app's own
# bundled server and the user's own Node.js install rather than assuming a
# specific developer's checkout.
set -euo pipefail

LABEL="com.janboike.playlistexporter.app"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
OLD_LABEL="com.janboike.playlistexporter.server"
OLD_DEST="$HOME/Library/LaunchAgents/$OLD_LABEL.plist"
GUI_DOMAIN="gui/$(id -u)"

APP_BUNDLE=""
for candidate in "/Applications/Playlist Exporter.app" "$(cd "$(dirname "$0")" && pwd)/dist/Playlist Exporter.app"; do
  if [ -d "$candidate" ]; then
    APP_BUNDLE="$candidate"
    break
  fi
done
if [ -z "$APP_BUNDLE" ]; then
  echo "Couldn't find \"Playlist Exporter.app\" in /Applications or macapp/dist — build/install it first (see macapp/build.sh)." >&2
  exit 1
fi

if [ ! -f "$APP_BUNDLE/Contents/MacOS/PlaylistExporter" ]; then
  echo "$APP_BUNDLE doesn't contain the native app executable — rebuild it with macapp/build.sh." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$DEST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-gj</string>
    <string>-a</string>
    <string>$APP_BUNDLE</string>
    <string>--args</string>
    <string>--background</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST

if [ -f "$OLD_DEST" ]; then
  launchctl bootout "$GUI_DOMAIN" "$OLD_DEST" 2>/dev/null || true
  rm -f "$OLD_DEST"
fi
launchctl bootout "$GUI_DOMAIN" "$DEST" 2>/dev/null || true
launchctl bootstrap "$GUI_DOMAIN" "$DEST"

echo "Installed and started: $LABEL"
echo "Playlist Exporter will start in the menu bar at login."

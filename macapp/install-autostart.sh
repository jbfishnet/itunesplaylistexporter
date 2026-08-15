#!/bin/bash
# Installs a LaunchAgent that runs the Playlist Exporter server in the
# background at every login (headless — no window, no browser tab). Run this
# whenever you decide you want autostart; run uninstall-autostart.sh to
# disable it again. The "Playlist Exporter.app" window always works
# regardless of whether this is installed — it starts the server itself if
# this LaunchAgent isn't running.
#
# The plist is generated here rather than checked into git, so this works on
# any Mac the app is installed on: it looks up the installed app's own
# bundled server and the user's own Node.js install rather than assuming a
# specific developer's checkout.
set -euo pipefail

LABEL="com.janboike.playlistexporter.server"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

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

APP_DIR="$APP_BUNDLE/Contents/Resources/app"
if [ ! -f "$APP_DIR/server.js" ]; then
  echo "$APP_BUNDLE doesn't contain a bundled server (Contents/Resources/app/server.js) — rebuild it with macapp/build.sh." >&2
  exit 1
fi

NODE_PATH="$(command -v node || true)"
if [ -z "$NODE_PATH" ]; then
  echo "Node.js wasn't found on your PATH. Install it (nodejs.org or Homebrew) and re-run this script." >&2
  exit 1
fi

DATA_DIR="$HOME/Library/Application Support/Playlist Exporter"
LOG_DIR="$HOME/Library/Logs/Playlist Exporter"
mkdir -p "$DATA_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"

cat > "$DEST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$NODE_PATH")</string>
    <key>PLE_NO_OPEN</key>
    <string>1</string>
    <key>PORT</key>
    <string>4173</string>
    <key>PLE_LIBRARY_DB</key>
    <string>$DATA_DIR/library.sqlite3</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/launchagent.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/launchagent.log</string>
</dict>
</plist>
PLIST

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"

echo "Installed and started: $LABEL"
echo "Logs: $LOG_DIR/launchagent.log"
echo "It will now also start automatically every time you log in."

#!/bin/bash
# Builds "Playlist Exporter.app" into macapp/dist/. Re-run any time main.swift
# or the icon changes. The result is a plain, ad-hoc-signed .app — drag it to
# /Applications (or run it right from dist/) once built.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Playlist Exporter"
BUNDLE="dist/$APP_NAME.app"

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

if [ ! -f AppIcon.icns ]; then
  echo "Generating icon..."
  swift generate_icon.swift
  iconutil -c icns AppIcon.iconset -o AppIcon.icns
fi
cp AppIcon.icns "$BUNDLE/Contents/Resources/AppIcon.icns"

echo "Compiling..."
swiftc main.swift -o "$BUNDLE/Contents/MacOS/PlaylistExporter" -framework Cocoa -framework WebKit

cat > "$BUNDLE/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Playlist Exporter</string>
  <key>CFBundleDisplayName</key><string>Playlist Exporter</string>
  <key>CFBundleIdentifier</key><string>com.janboike.playlistexporter</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>PlaylistExporter</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><false/>
</dict>
</plist>
PLIST

echo "Signing (ad-hoc, local use only)..."
codesign --force --deep --sign - "$BUNDLE"

echo "Built: $(cd "$(dirname "$BUNDLE")" && pwd)/$APP_NAME.app"

const fs = require("fs");
const os = require("os");
const path = require("path");

const EVENT_TYPES = {
  export_success: "Export completed successfully",
  export_failure: "Export completed with failures",
  scan_success: "Library scan completed",
  scan_failure: "Library scan failed",
  playlist_restore: "Playlist restore/rebuild completed",
  playlist_add: "Track added to a playlist",
};
const HISTORY_LIMIT = 100;
const selectedByDefault = Object.fromEntries(Object.keys(EVENT_TYPES).map((type) => [type, true]));
const settingsPath = process.env.PLE_NOTIFICATION_SETTINGS ||
  (process.env.PLE_LIBRARY_DB === ":memory:"
    ? null
    : path.join(
        path.dirname(process.env.PLE_LIBRARY_DB || path.join(__dirname, "..", "data", "library.sqlite3")),
        "notification-settings.json"
      ));

let settings = { ...selectedByDefault };
let settingsLoadError = null;
let nextEventId = Date.now();
const history = [];
const subscribers = new Set();

function readSettings() {
  if (!settingsPath) return;
  try {
    const stored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    settings = Object.fromEntries(
      Object.keys(EVENT_TYPES).map((type) => [type, stored[type] === true])
    );
  } catch (err) {
    if (err.code !== "ENOENT") {
      settingsLoadError = err;
      console.error("[notifications] Couldn't read saved notification settings:", err.message);
    }
  }
}

function writeSettings() {
  if (!settingsPath) return;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmpPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, settingsPath);
}

function getSettings() {
  if (settingsLoadError) throw settingsLoadError;
  return { ...settings };
}

function saveSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Notification settings must be an object");
  }
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(EVENT_TYPES, key));
  if (unknown.length) throw new Error(`Unknown notification type: ${unknown[0]}`);
  if (Object.values(value).some((enabled) => typeof enabled !== "boolean")) {
    throw new Error("Notification selections must be true or false");
  }
  const previous = settings;
  settings = { ...selectedByDefault, ...settings, ...value };
  try {
    writeSettings();
  } catch (err) {
    settings = previous;
    throw err;
  }
  settingsLoadError = null;
  return { ...settings };
}

function writeEvent(res, event) {
  try {
    res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch (err) {
    console.error("[notifications] Couldn't deliver event:", err.message);
    res.end();
    return false;
  }
}

function subscribe(req, res) {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  const lastId = Number(req.get("Last-Event-ID") || req.query.after) || 0;
  for (const event of history) {
    if (event.id > lastId && !writeEvent(res, event)) return;
  }
  subscribers.add(res);
  const heartbeat = setInterval(() => {
    if (!res.write(": keep-alive\n\n")) {
      clearInterval(heartbeat);
      subscribers.delete(res);
    }
  }, 25_000);
  heartbeat.unref();
  req.on("close", () => {
    clearInterval(heartbeat);
    subscribers.delete(res);
  });
}

function publish(type, title, body) {
  if (!Object.hasOwn(EVENT_TYPES, type)) throw new Error(`Unknown notification type: ${type}`);
  if (settingsLoadError) return;
  if (!settings[type]) return;
  const event = { id: nextEventId++, type, title, body, createdAt: new Date().toISOString() };
  history.push(event);
  if (history.length > HISTORY_LIMIT) history.shift();
  for (const subscriber of subscribers) {
    if (!writeEvent(subscriber, event)) subscribers.delete(subscriber);
  }
}

readSettings();

module.exports = { EVENT_TYPES, getSettings, saveSettings, subscribe, publish };

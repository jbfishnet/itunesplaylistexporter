const test = require("node:test");
const assert = require("node:assert/strict");

process.env.PLE_LIBRARY_DB = ":memory:";
const notifications = require("../src/appNotifications");

function createStream() {
  const chunks = [];
  const listeners = {};
  const req = {
    query: {},
    get: () => undefined,
    on: (name, callback) => { listeners[name] = callback; },
  };
  const res = {
    status() { return this; },
    set() { return this; },
    flushHeaders() {},
    write(chunk) { chunks.push(chunk); return true; },
  };
  notifications.subscribe(req, res);
  return { chunks, close: () => listeners.close?.() };
}

test("notification preferences list selectable event types and default to enabled", () => {
  const settings = notifications.getSettings();
  assert.deepEqual(Object.keys(settings), Object.keys(notifications.EVENT_TYPES));
  assert.ok(Object.values(settings).every(Boolean));
});

test("notification stream delivers selected events and suppresses disabled event types", () => {
  const stream = createStream();
  notifications.saveSettings({ playlist_add: false });
  notifications.publish("playlist_add", "Added", "Track");
  assert.equal(stream.chunks.length, 0);

  notifications.publish("export_success", "Exported", "Done");
  assert.equal(stream.chunks.length, 1);
  assert.match(stream.chunks[0], /"type":"export_success"/);
  stream.close();
});

test("notification settings reject unknown event types and non-boolean values", () => {
  assert.throws(() => notifications.saveSettings({ mystery: true }), /Unknown notification type/);
  assert.throws(() => notifications.saveSettings({ export_success: "yes" }), /true or false/);
});

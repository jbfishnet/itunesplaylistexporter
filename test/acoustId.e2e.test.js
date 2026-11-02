const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { getAcoustidStatus, checkAcoustidKey } = require("../src/acoustId");

class EventTargetMock {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
  }
}

class ElementMock extends EventTargetMock {
  dataset = {};
  style = {};
  textContent = "";
  value = "";
  disabled = false;
  clicked = false;
  name = "";

  click() {
    this.clicked = true;
    this.dispatchEvent({ type: "click" });
  }
}

async function runConfigurationFlow(t, key, apiFetch = globalThis.fetch) {
  const supportDir = await fs.mkdtemp(path.join(os.tmpdir(), "ple-acoustid-e2e-"));
  t.after(() => fs.rm(supportDir, { recursive: true, force: true }));
  const binDir = path.join(supportDir, "bin");
  await fs.mkdir(binDir);
  const fakeFpcalcPath = path.join(binDir, "fpcalc");
  await fs.writeFile(fakeFpcalcPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "-json" || !fs.readFileSync(args[1]).subarray(0, 4).equals(Buffer.from("RIFF"))) {
  process.exit(2);
}
process.stdout.write(JSON.stringify({ duration: 3, fingerprint: "e2e-synthetic-fingerprint" }));
`);
  await fs.chmod(fakeFpcalcPath, 0o700);
  const keyFile = path.join(supportDir, "acoustid-api-key");
  const previousKeyFile = process.env.PLE_ACOUSTID_KEY_FILE;
  const previousApiKey = process.env.ACOUSTID_API_KEY;
  const previousPath = process.env.PATH;
  process.env.PLE_ACOUSTID_KEY_FILE = keyFile;
  process.env.PATH = `${binDir}:${previousPath || ""}`;
  delete process.env.ACOUSTID_API_KEY;
  t.after(() => {
    if (previousKeyFile === undefined) delete process.env.PLE_ACOUSTID_KEY_FILE;
    else process.env.PLE_ACOUSTID_KEY_FILE = previousKeyFile;
    if (previousApiKey === undefined) delete process.env.ACOUSTID_API_KEY;
    else process.env.ACOUSTID_API_KEY = previousApiKey;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  const elements = new Map([
    "acoustidApiKey",
    "saveAcoustidApiKeyBtn",
    "checkAcoustidApiKeyBtn",
    "acoustidKeyStatus",
    "acoustidStatusPanel",
    "acoustidStatusTitle",
    "acoustidStatusMessage",
    "acoustidAlert",
    "acoustidAlertText",
    "acoustidAlertConfigBtn",
  ].map((id) => [id, new ElementMock()]));
  const window = new EventTargetMock();
  let connectionResult;
  let saveRequest;
  const connectionRequests = [];

  window.webkit = {
    messageHandlers: {
      pleSaveAcoustidKey: {
        postMessage(value) {
          saveRequest = fs.writeFile(keyFile, value, { mode: 0o600 })
            .then(() => window.dispatchEvent({
              type: "ple:acoustid-key-result",
              detail: { success: true, status: value ? "saved" : "removed" },
            }));
        },
      },
    },
  };
  window.setInterval = () => 0;

  const document = new EventTargetMock();
  document.visibilityState = "visible";
  document.getElementById = (id) => elements.get(id);
  document.querySelector = () => ({ click() {} });

  const appFetch = async (url, options = {}) => {
    if (url === "/api/acoustid/status") {
      return { ok: true, json: async () => getAcoustidStatus() };
    }
    if (url === "/api/acoustid/check" && options.method === "POST") {
      const request = checkAcoustidKey({ fetchFn: apiFetch });
      connectionRequests.push(request);
      connectionResult = await request;
      return { ok: true, json: async () => connectionResult };
    }
    throw new Error(`Unexpected Configuration request: ${url}`);
  };

  const source = await fs.readFile(
    path.join(__dirname, "..", "public", "acoustidSettings.js"),
    "utf8"
  );
  vm.runInNewContext(source, {
    window,
    document,
    fetch: appFetch,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  });

  elements.get("acoustidApiKey").value = key;
  elements.get("saveAcoustidApiKeyBtn").click();
  await saveRequest;
  await connectionRequests[0];

  assert.equal(await fs.readFile(keyFile, "utf8"), key);
  assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);
  assert.equal(elements.get("acoustidApiKey").value, "");

  elements.get("checkAcoustidApiKeyBtn").click();
  await connectionRequests[1];
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(connectionResult, "The Configuration UI must complete its API check.");
  assert.equal(connectionResult.configured, true);
  assert.equal(connectionResult.source, "application_support");
  assert.equal(elements.get("acoustidStatusPanel").dataset.state, connectionResult.state);
  assert.equal(
    elements.get("acoustidKeyStatus").textContent,
    connectionResult.valid ? "Connection test passed." : connectionResult.message
  );

  return connectionResult;
}

test("Configuration enters and saves a key, fingerprints generated audio, and tests AcoustID", async (t) => {
  let checkedUrl;
  const result = await runConfigurationFlow(t, "e2e-test-application-key", async (url) => {
    checkedUrl = new URL(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", results: [] }),
    };
  });
  assert.equal(result.state, "valid");
  assert.equal(checkedUrl.searchParams.get("client"), "e2e-test-application-key");
  assert.equal(checkedUrl.searchParams.get("fingerprint"), "e2e-synthetic-fingerprint");
});

test("Configuration tests the provided live AcoustID key without logging the credential", {
  skip: !process.env.PLE_E2E_ACOUSTID_API_KEY
    ? "Set PLE_E2E_ACOUSTID_API_KEY to run the live AcoustID credential test."
    : false,
}, async (t) => {
  const key = process.env.PLE_E2E_ACOUSTID_API_KEY.trim();
  assert.ok(key, "The live test key must not be blank.");
  const result = await runConfigurationFlow(t, key);
  assert.ok(result.configured);
  assert.ok(["valid", "invalid"].includes(result.state), `Unexpected AcoustID state: ${result.state}`);
  t.diagnostic(`Live AcoustID credential result: ${result.state}`);
});

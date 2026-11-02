(() => {
  const keyInput = document.getElementById("acoustidApiKey");
  const saveButton = document.getElementById("saveAcoustidApiKeyBtn");
  const checkButton = document.getElementById("checkAcoustidApiKeyBtn");
  const feedback = document.getElementById("acoustidKeyStatus");
  const statusPanel = document.getElementById("acoustidStatusPanel");
  const statusTitle = document.getElementById("acoustidStatusTitle");
  const statusMessage = document.getElementById("acoustidStatusMessage");
  const alertEl = document.getElementById("acoustidAlert");
  const alertText = document.getElementById("acoustidAlertText");
  const alertConfigButton = document.getElementById("acoustidAlertConfigBtn");

  const stateText = {
    missing: ["AcoustID key is missing", "Add your application key below to enable audio fingerprint identification."],
    unknown: ["AcoustID key is saved but not tested", "Test the connection to check whether AcoustID accepts this key."],
    valid: ["AcoustID is ready", "The saved key was accepted. Fingerprinting will run after text search finds no match."],
    invalid: ["AcoustID key was rejected", "Replace the saved key with a valid application key and test again."],
    request_error: ["AcoustID rejected the test request", "Check the detailed service response and try again."],
    service_error: ["AcoustID service or endpoint error", "Check the AcoustID service and app version, then try again."],
    connection_error: ["Couldn't reach AcoustID", "Check your network connection, then test again. The key has not been confirmed."],
    fingerprint_unavailable: ["Couldn't run the fingerprint check", "Install Chromaprint (fpcalc), then test the connection again."],
    error: ["AcoustID configuration error", "Check the details below and the app log."],
  };

  function showStatus(data) {
    const [title, message] = stateText[data.state] || stateText.error;
    statusPanel.dataset.state = data.state;
    statusTitle.textContent = title;
    statusMessage.textContent = data.message || message;
    if (data.source === "environment") {
      statusMessage.textContent += " This server uses an environment key; it takes precedence over the saved local key.";
    } else if (data.source === "application_support") {
      statusMessage.textContent += " The key is loaded from this Mac's persistent Application Support folder.";
    }
    const needsAttention = [
      "missing",
      "invalid",
      "request_error",
      "service_error",
      "connection_error",
      "fingerprint_unavailable",
      "error",
    ].includes(data.state);
    alertEl.style.display = needsAttention ? "flex" : "none";
    if (needsAttention) {
      alertText.textContent = data.message || message;
    }
  }

  async function checkStatus(testConnection) {
    const button = testConnection ? checkButton : null;
    if (button) {
      button.disabled = true;
      button.textContent = "Testing…";
      feedback.textContent = "Creating a local silence fingerprint and checking AcoustID…";
    }
    try {
      const response = await fetch(testConnection ? "/api/acoustid/check" : "/api/acoustid/status", {
        method: testConnection ? "POST" : "GET",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Couldn't check AcoustID configuration");
      showStatus(data);
      if (testConnection) {
        feedback.textContent = data.valid ? "Connection test passed." : data.message || "Connection test failed.";
      }
    } catch (err) {
      statusPanel.dataset.state = "error";
      statusTitle.textContent = "Couldn't check AcoustID";
      statusMessage.textContent = err.message;
      if (testConnection) feedback.textContent = err.message;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Test connection";
      }
    }
  }

  saveButton.addEventListener("click", () => {
    const handler = window.webkit?.messageHandlers?.pleSaveAcoustidKey;
    if (!handler) {
      feedback.textContent = "Saving an AcoustID key is available in the native macOS app.";
      return;
    }

    saveButton.disabled = true;
    feedback.textContent = "Saving on this Mac…";
    handler.postMessage(keyInput.value.trim());
  });

  window.addEventListener("ple:acoustid-key-result", (event) => {
    saveButton.disabled = false;
    keyInput.value = "";
    if (event.detail.success) {
      feedback.textContent = event.detail.status === "saved"
        ? "Key saved on this Mac."
        : "Saved AcoustID key removed from this Mac.";
      checkStatus(event.detail.status === "saved");
    } else {
      feedback.textContent = "Couldn't save the local key file. Check the app log and available disk space.";
    }
  });

  checkButton.addEventListener("click", () => checkStatus(true));
  alertConfigButton.addEventListener("click", () => {
    document.querySelector('.tab-btn[data-tab="configuration"]')?.click();
  });
  document.addEventListener("ple:tab-activated", (event) => {
    if (event.detail.tabName === "configuration") checkStatus(false);
  });
  checkStatus(false);
  window.setInterval(() => {
    if (document.visibilityState === "visible") checkStatus(false);
  }, 30_000);
})();

(() => {
  const optionsEl = document.getElementById("notificationOptions");
  const statusEl = document.getElementById("notificationSettingsStatus");
  const saveBtn = document.getElementById("saveNotificationSettingsBtn");
  const permissionBtn = document.getElementById("enableSystemNotificationsBtn");
  const storageKey = "ple.notification.lastEventId";
  let selected = {};
  let eventSource;

  function showNotification(event) {
    if (window.webkit?.messageHandlers?.pleNotifications) {
      window.webkit.messageHandlers.pleNotifications.postMessage({
        title: event.title,
        body: event.body,
      });
    } else if ("Notification" in window && Notification.permission === "granted") {
      new Notification(event.title, { body: event.body });
    }
  }

  function connectEventStream() {
    const lastId = Number(localStorage.getItem(storageKey)) || 0;
    eventSource?.close();
    eventSource = new EventSource(`/api/notifications/stream?after=${lastId}`);
    eventSource.onmessage = (message) => {
      const event = JSON.parse(message.data);
      localStorage.setItem(storageKey, String(event.id));
      showNotification(event);
    };
  }

  async function loadSettings() {
    try {
      const response = await fetch("/api/notifications/settings");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Couldn't load notification settings");
      selected = data.selected;
      optionsEl.replaceChildren();
      for (const [type, label] of Object.entries(data.eventTypes)) {
        const labelEl = document.createElement("label");
        labelEl.className = "notification-option";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = type;
        checkbox.checked = Boolean(selected[type]);
        const text = document.createElement("span");
        text.textContent = label;
        labelEl.append(checkbox, text);
        optionsEl.append(labelEl);
      }
      connectEventStream();
      statusEl.textContent = "";
    } catch (err) {
      statusEl.textContent = err.message;
    }
  }

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    statusEl.textContent = "Saving…";
    const values = Object.fromEntries(
      [...optionsEl.querySelectorAll("input[type=checkbox]")].map((checkbox) => [checkbox.name, checkbox.checked])
    );
    try {
      const response = await fetch("/api/notifications/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected: values }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Couldn't save notification settings");
      selected = data.selected;
      statusEl.textContent = "Notification selections saved.";
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  permissionBtn.addEventListener("click", () => {
    if (window.webkit?.messageHandlers?.pleRequestNotificationPermission) {
      window.webkit.messageHandlers.pleRequestNotificationPermission.postMessage({});
    } else if ("Notification" in window) {
      Notification.requestPermission().then((permission) => {
        statusEl.textContent = permission === "granted"
          ? "macOS notifications are allowed."
          : "macOS notifications were not allowed in browser settings.";
      });
    } else {
      statusEl.textContent = "Native notification permission is available in the macOS app.";
    }
  });

  window.addEventListener("ple:notification-permission", (event) => {
    statusEl.textContent = event.detail.granted
      ? "macOS notifications are allowed."
      : "Notifications are disabled. You can enable them in System Settings.";
  });

  loadSettings();
})();

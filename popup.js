const btn = document.getElementById("go");
const logEl = document.getElementById("log");
const statsEl = document.getElementById("stats");
const statusEl = document.getElementById("status");
const slowModeEl = document.getElementById("slowMode");
const slowSecondsEl = document.getElementById("slowSeconds");
const randomOrderEl = document.getElementById("randomOrder");

const DEFAULT_SETTINGS = {
  slowMode: false,
  slowModeSeconds: 30,
  randomOrder: false,
};

let activeTabId = null;
let savedSettings = { ...DEFAULT_SETTINGS };

function normalizeSettings(settings = {}) {
  return {
    slowMode: Boolean(settings.slowMode),
    slowModeSeconds: Math.max(
      1,
      Math.floor(Number(settings.slowModeSeconds) || DEFAULT_SETTINGS.slowModeSeconds)
    ),
    randomOrder: Boolean(settings.randomOrder),
  };
}

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = cls ? `status ${cls}` : "status";
}

function renderLogEntries(entries) {
  logEl.innerHTML = "";
  for (const entry of entries) {
    const line = document.createElement("div");
    line.textContent = entry.text;
    if (entry.cls) line.className = entry.cls;
    logEl.appendChild(line);
  }
  logEl.style.display = entries.length ? "block" : "none";
  logEl.scrollTop = logEl.scrollHeight;
}

function appendLog(text, cls = "") {
  logEl.style.display = "block";
  const line = document.createElement("div");
  line.textContent = text;
  if (cls) line.className = cls;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderStats(state) {
  statsEl.innerHTML = `
    <span class="stat success">Posted: ${state.posted || 0}</span>
    <span class="stat skip">Skipped: ${state.skipped || 0}</span>
    <span class="stat error">Failed: ${state.failed || 0}</span>
    <span class="stat">Total: ${state.total || 0}</span>
  `;
}

function updateControls(settings, disabled = false) {
  const normalized = normalizeSettings(settings);
  slowModeEl.checked = normalized.slowMode;
  slowSecondsEl.value = String(normalized.slowModeSeconds);
  randomOrderEl.checked = normalized.randomOrder;
  slowModeEl.disabled = disabled;
  slowSecondsEl.disabled = disabled || !normalized.slowMode;
  randomOrderEl.disabled = disabled;
}

function saveSettings(settings) {
  savedSettings = normalizeSettings(settings);
  chrome.storage.local.set(savedSettings);
}

function readSettingsFromForm() {
  return normalizeSettings({
    slowMode: slowModeEl.checked,
    slowModeSeconds: slowSecondsEl.value,
    randomOrder: randomOrderEl.checked,
  });
}

function getEmptyState() {
  return {
    posted: 0,
    skipped: 0,
    failed: 0,
    total: 0,
    logs: [],
  };
}

function getSettingsSummary(settings) {
  const normalized = normalizeSettings(settings);
  const pacingSummary = normalized.slowMode
    ? `Slow mode is selected at ${normalized.slowModeSeconds}s between drafts.`
    : "Fast mode is selected.";
  const orderSummary = normalized.randomOrder
    ? "Randomized publish order is on."
    : "Posting stays in fetched order.";

  return `${pacingSummary} ${orderSummary}`;
}

function applyState(state) {
  renderStats(state);
  renderLogEntries(state.logs || []);

  const stateSettings = {
    slowMode: state.pacing?.slowMode,
    slowModeSeconds: state.pacing?.slowModeSeconds,
    randomOrder: state.randomOrder,
  };

  if (state.isRunning) {
    btn.disabled = true;
    btn.textContent = "Publishing In This Tab...";
    updateControls(stateSettings, true);
    setStatus(
      `Publishing continues in the page even if this popup closes. ${getSettingsSummary(stateSettings)}`,
      "success"
    );
    return;
  }

  btn.disabled = false;
  btn.textContent = "Publish All Drafts";
  updateControls(savedSettings, false);

  if ((state.logs || []).length) {
    setStatus("Last run finished. You can close and reopen this popup without losing the log.", "skip");
  } else {
    setStatus(`Ready. Open sora.chatgpt.com, then start publishing. ${getSettingsSummary(savedSettings)}`);
  }
}

function handleRuntimeMessage(msg) {
  if (msg.type === "log") appendLog(msg.text, msg.cls || "");
  if (msg.type === "stats") renderStats(msg);
  if (msg.type === "done") {
    btn.disabled = false;
    btn.textContent = "Publish All Drafts";
    updateControls(savedSettings, false);
    setStatus("Publishing finished. The log stays here when you reopen the popup.", "success");
  }
}

chrome.runtime.onMessage.addListener(handleRuntimeMessage);

function getActiveSoraTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id || !tab.url?.startsWith("https://sora.chatgpt.com")) {
      activeTabId = null;
      callback(null);
      return;
    }

    activeTabId = tab.id;
    callback(tab);
  });
}

function sendToActiveTab(message, callback) {
  if (!activeTabId) {
    callback(null, new Error("No active Sora tab"));
    return;
  }

  chrome.tabs.sendMessage(activeTabId, message, (response) => {
    if (chrome.runtime.lastError) {
      callback(null, new Error(chrome.runtime.lastError.message));
      return;
    }
    callback(response, null);
  });
}

function syncPopupState() {
  getActiveSoraTab((tab) => {
    if (!tab) {
      btn.disabled = false;
      btn.textContent = "Publish All Drafts";
      renderStats(getEmptyState());
      renderLogEntries([]);
      updateControls(savedSettings, false);
      setStatus("Navigate to sora.chatgpt.com first.", "error");
      return;
    }

    sendToActiveTab({ action: "get_status" }, (state, error) => {
      if (error) {
        renderStats(getEmptyState());
        renderLogEntries([]);
        updateControls(savedSettings, false);
        setStatus("Reload the Sora tab once, then reopen the extension.", "error");
        return;
      }

      applyState(state);
    });
  });
}

function handleSettingsChange() {
  const settings = readSettingsFromForm();
  updateControls(settings, false);
  saveSettings(settings);
}

slowModeEl.addEventListener("change", handleSettingsChange);
slowSecondsEl.addEventListener("change", handleSettingsChange);
randomOrderEl.addEventListener("change", handleSettingsChange);

btn.addEventListener("click", () => {
  getActiveSoraTab((tab) => {
    if (!tab) {
      setStatus("Navigate to sora.chatgpt.com first.", "error");
      return;
    }

    const settings = readSettingsFromForm();
    saveSettings(settings);

    btn.disabled = true;
    btn.textContent = "Starting...";
    updateControls(settings, true);
    setStatus("Starting publish run in this tab...", "skip");

    sendToActiveTab(
      {
        action: "publish_all",
        pacing: settings,
        randomOrder: settings.randomOrder,
      },
      (response, error) => {
        if (error) {
          btn.disabled = false;
          btn.textContent = "Publish All Drafts";
          updateControls(savedSettings, false);
          setStatus("Reload the Sora tab once, then try again.", "error");
          return;
        }

        if (response?.alreadyRunning) {
          applyState(response.state);
          return;
        }

        applyState(response?.state || { ...getEmptyState(), pacing: settings, randomOrder: settings.randomOrder });
        setStatus(
          `Publishing continues in the page even if this popup closes. ${getSettingsSummary(settings)}`,
          "success"
        );
      }
    );
  });
});

chrome.storage.local.get(DEFAULT_SETTINGS, (storedSettings) => {
  savedSettings = normalizeSettings(storedSettings);
  updateControls(savedSettings, false);
  syncPopupState();
});

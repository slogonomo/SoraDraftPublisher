const btn = document.getElementById("go");
const logEl = document.getElementById("log");
const statsEl = document.getElementById("stats");
const statusEl = document.getElementById("status");
const slowModeEl = document.getElementById("slowMode");
const slowSecondsEl = document.getElementById("slowSeconds");

const DEFAULT_PACING = {
  slowMode: false,
  slowModeSeconds: 30,
};

let activeTabId = null;
let savedPacing = { ...DEFAULT_PACING };

function normalizePacingSettings(settings = {}) {
  return {
    slowMode: Boolean(settings.slowMode),
    slowModeSeconds: Math.max(
      1,
      Math.floor(Number(settings.slowModeSeconds) || DEFAULT_PACING.slowModeSeconds)
    ),
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

function updatePacingControls(pacing, disabled = false) {
  const normalized = normalizePacingSettings(pacing);
  slowModeEl.checked = normalized.slowMode;
  slowSecondsEl.value = String(normalized.slowModeSeconds);
  slowModeEl.disabled = disabled;
  slowSecondsEl.disabled = disabled || !normalized.slowMode;
}

function savePacingSettings(pacing) {
  savedPacing = normalizePacingSettings(pacing);
  chrome.storage.local.set(savedPacing);
}

function readPacingFromForm() {
  return normalizePacingSettings({
    slowMode: slowModeEl.checked,
    slowModeSeconds: slowSecondsEl.value,
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

function getPacingSummary(pacing) {
  if (!pacing?.slowMode) {
    return "Fast mode is selected.";
  }

  return `Slow mode is selected at ${pacing.slowModeSeconds}s between drafts.`;
}

function applyState(state) {
  renderStats(state);
  renderLogEntries(state.logs || []);

  if (state.isRunning) {
    btn.disabled = true;
    btn.textContent = "Publishing In This Tab...";
    updatePacingControls(state.pacing || savedPacing, true);
    setStatus(
      `Publishing continues in the page even if this popup closes. ${getPacingSummary(state.pacing)}`,
      "success"
    );
    return;
  }

  btn.disabled = false;
  btn.textContent = "Publish All Drafts";
  updatePacingControls(savedPacing, false);

  if ((state.logs || []).length) {
    setStatus("Last run finished. You can close and reopen this popup without losing the log.", "skip");
  } else {
    setStatus(`Ready. Open sora.chatgpt.com, then start publishing. ${getPacingSummary(savedPacing)}`);
  }
}

function handleRuntimeMessage(msg) {
  if (msg.type === "log") appendLog(msg.text, msg.cls || "");
  if (msg.type === "stats") renderStats(msg);
  if (msg.type === "done") {
    btn.disabled = false;
    btn.textContent = "Publish All Drafts";
    updatePacingControls(savedPacing, false);
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
      updatePacingControls(savedPacing, false);
      setStatus("Navigate to sora.chatgpt.com first.", "error");
      return;
    }

    sendToActiveTab({ action: "get_status" }, (state, error) => {
      if (error) {
        renderStats(getEmptyState());
        renderLogEntries([]);
        updatePacingControls(savedPacing, false);
        setStatus("Reload the Sora tab once, then reopen the extension.", "error");
        return;
      }

      applyState(state);
    });
  });
}

slowModeEl.addEventListener("change", () => {
  const pacing = readPacingFromForm();
  updatePacingControls(pacing, false);
  savePacingSettings(pacing);
});

slowSecondsEl.addEventListener("change", () => {
  const pacing = readPacingFromForm();
  updatePacingControls(pacing, false);
  savePacingSettings(pacing);
});

btn.addEventListener("click", () => {
  getActiveSoraTab((tab) => {
    if (!tab) {
      setStatus("Navigate to sora.chatgpt.com first.", "error");
      return;
    }

    const pacing = readPacingFromForm();
    savePacingSettings(pacing);

    btn.disabled = true;
    btn.textContent = "Starting...";
    updatePacingControls(pacing, true);
    setStatus("Starting publish run in this tab...", "skip");

    sendToActiveTab({ action: "publish_all", pacing }, (response, error) => {
      if (error) {
        btn.disabled = false;
        btn.textContent = "Publish All Drafts";
        updatePacingControls(savedPacing, false);
        setStatus("Reload the Sora tab once, then try again.", "error");
        return;
      }

      if (response?.alreadyRunning) {
        applyState(response.state);
        return;
      }

      applyState(response?.state || { ...getEmptyState(), pacing });
      setStatus(
        `Publishing continues in the page even if this popup closes. ${getPacingSummary(pacing)}`,
        "success"
      );
    });
  });
});

chrome.storage.local.get(DEFAULT_PACING, (storedSettings) => {
  savedPacing = normalizePacingSettings(storedSettings);
  updatePacingControls(savedPacing, false);
  syncPopupState();
});

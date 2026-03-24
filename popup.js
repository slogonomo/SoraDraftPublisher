const btn = document.getElementById("go");
const logEl = document.getElementById("log");
const statsEl = document.getElementById("stats");

function log(msg, cls) {
  logEl.style.display = "block";
  const line = document.createElement("div");
  line.textContent = msg;
  if (cls) line.className = cls;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  logEl.innerHTML = "";
  logEl.style.display = "block";
  log("Starting...");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://sora.chatgpt.com")) {
    log("Navigate to sora.chatgpt.com first!", "error");
    btn.disabled = false;
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: "publish_all" }, (response) => {
    // content script streams progress via a port instead
  });

  // Listen for progress from content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "log") log(msg.text, msg.cls || "");
    if (msg.type === "stats") {
      statsEl.innerHTML = `
        <span class="stat success">✓ ${msg.posted}</span>
        <span class="stat skip">⊘ ${msg.skipped}</span>
        <span class="stat error">✗ ${msg.failed}</span>
        <span class="stat">Total: ${msg.total}</span>
      `;
    }
    if (msg.type === "done") btn.disabled = false;
  });
});
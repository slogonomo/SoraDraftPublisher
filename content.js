(() => {
  // Config
  const DRAFTS_LIMIT = 30;
  const FAST_POST_DELAY_MS = 4000;
  const FAST_RATE_LIMIT_BASE_DELAY_MS = 15000;
  const SERVER_RETRY_DELAY_MS = 5000;
  const MAX_RETRIES = 3;
  const MAX_RATE_LIMIT_DELAY_MS = 600000;
  const MAX_POST_TEXT_LENGTH = 1999;
  const LOG_HISTORY_LIMIT = 250;
  const DEFAULT_SLOW_MODE_SECONDS = 30;

  let accessToken = null;
  const runState = createInitialRunState();

  function createDefaultPacing() {
    return {
      slowMode: false,
      slowModeSeconds: DEFAULT_SLOW_MODE_SECONDS,
    };
  }

  function normalizePacingSettings(settings = {}) {
    const normalizedSeconds = Math.max(
      1,
      Math.floor(Number(settings.slowModeSeconds) || DEFAULT_SLOW_MODE_SECONDS)
    );

    return {
      slowMode: Boolean(settings.slowMode),
      slowModeSeconds: normalizedSeconds,
    };
  }

  function getConfiguredBaseDelayMs(pacing = runState.pacing) {
    if (!pacing.slowMode) {
      return FAST_POST_DELAY_MS;
    }

    return Math.max(FAST_POST_DELAY_MS, pacing.slowModeSeconds * 1000);
  }

  function getRecommendedRateLimitBackoffMs(attempt, pacing = runState.pacing) {
    const fastBackoffMs = Math.min(
      MAX_RATE_LIMIT_DELAY_MS,
      FAST_RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1)
    );

    if (!pacing.slowMode) {
      return fastBackoffMs;
    }

    const slowBackoffMs = Math.min(
      MAX_RATE_LIMIT_DELAY_MS,
      getConfiguredBaseDelayMs(pacing) * 2 ** attempt
    );

    return Math.max(fastBackoffMs, slowBackoffMs);
  }

  function createInitialRunState() {
    return {
      isRunning: false,
      posted: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      logs: [],
      startedAt: null,
      finishedAt: null,
      pacing: createDefaultPacing(),
      postDelayMs: FAST_POST_DELAY_MS,
      cooldownUntil: 0,
    };
  }

  // Helpers

  function send(type, data = {}) {
    chrome.runtime.sendMessage({ type, ...data }, () => {
      void chrome.runtime.lastError;
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getSerializableState() {
    return {
      isRunning: runState.isRunning,
      posted: runState.posted,
      skipped: runState.skipped,
      failed: runState.failed,
      total: runState.total,
      logs: runState.logs.slice(),
      startedAt: runState.startedAt,
      finishedAt: runState.finishedAt,
      pacing: { ...runState.pacing },
      postDelayMs: runState.postDelayMs,
      cooldownUntil: runState.cooldownUntil,
    };
  }

  function resetRunState(pacingSettings) {
    const pacing = normalizePacingSettings(pacingSettings);

    Object.assign(runState, createInitialRunState(), {
      isRunning: true,
      startedAt: Date.now(),
      pacing,
      postDelayMs: getConfiguredBaseDelayMs(pacing),
    });
  }

  function emitLog(text, cls = "") {
    runState.logs.push({ text, cls });
    if (runState.logs.length > LOG_HISTORY_LIMIT) {
      runState.logs.shift();
    }
    send("log", { text, cls });
  }

  function emitStats() {
    send("stats", {
      posted: runState.posted,
      skipped: runState.skipped,
      failed: runState.failed,
      total: runState.total,
    });
  }

  function finishRun() {
    runState.isRunning = false;
    runState.finishedAt = Date.now();
    send("done");
  }

  function describePacing(pacing = runState.pacing) {
    if (!pacing.slowMode) {
      return "Fast mode: 4s between drafts, with 429 retries at 15s, 30s, then 60s.";
    }

    return (
      `Slow mode: ${pacing.slowModeSeconds}s between drafts, with 429 retries at ` +
      `${Math.ceil(getRecommendedRateLimitBackoffMs(1, pacing) / 1000)}s, ` +
      `${Math.ceil(getRecommendedRateLimitBackoffMs(2, pacing) / 1000)}s, then ` +
      `${Math.ceil(getRecommendedRateLimitBackoffMs(3, pacing) / 1000)}s.`
    );
  }

  function parseRetryAfterMs(retryAfterHeader) {
    if (!retryAfterHeader) return null;

    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }

    const retryDate = Date.parse(retryAfterHeader);
    if (Number.isNaN(retryDate)) {
      return null;
    }

    return Math.max(0, retryDate - Date.now());
  }

  async function waitForCooldown() {
    const waitMs = runState.cooldownUntil - Date.now();

    if (waitMs > 0) {
      emitLog(`Cooling down for ${Math.ceil(waitMs / 1000)}s before the next post...`, "skip");
      await sleep(waitMs);
    }
  }

  function noteSuccessfulPost() {
    runState.cooldownUntil = 0;
    runState.postDelayMs = Math.max(
      getConfiguredBaseDelayMs(),
      Math.floor(runState.postDelayMs * 0.85)
    );
  }

  function noteRateLimit(res, attempt) {
    const retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After")) || 0;
    const recommendedMs = getRecommendedRateLimitBackoffMs(attempt);
    const backoffMs = Math.min(
      MAX_RATE_LIMIT_DELAY_MS,
      Math.max(retryAfterMs, recommendedMs)
    );

    runState.cooldownUntil = Date.now() + backoffMs;
    runState.postDelayMs = Math.min(
      MAX_RATE_LIMIT_DELAY_MS,
      Math.max(
        getConfiguredBaseDelayMs(),
        runState.postDelayMs * 2,
        recommendedMs,
        retryAfterMs
      )
    );

    return backoffMs;
  }

  async function getToken() {
    const res = await fetch("/api/auth/session", { credentials: "include" });
    if (!res.ok) throw new Error("Auth session failed: " + res.status);
    const data = await res.json();
    if (!data.accessToken) throw new Error("No accessToken in session");
    accessToken = data.accessToken;
    return accessToken;
  }

  function authHeaders() {
    return {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
    };
  }

  function shortenPostText(text) {
    const normalizedText = typeof text === "string" ? text.trim() : "";

    if (normalizedText.length <= MAX_POST_TEXT_LENGTH) {
      return {
        text: normalizedText,
        shortened: false,
        originalLength: normalizedText.length,
      };
    }

    const suffix = "...";
    const hardLimit = MAX_POST_TEXT_LENGTH - suffix.length;
    let shortenedText = normalizedText.slice(0, hardLimit);
    const lastWhitespace = shortenedText.search(/\s\S*$/);

    if (lastWhitespace >= Math.floor(hardLimit * 0.6)) {
      shortenedText = shortenedText.slice(0, lastWhitespace);
    }

    shortenedText = shortenedText.trimEnd();

    return {
      text: shortenedText + suffix,
      shortened: true,
      originalLength: normalizedText.length,
    };
  }

  // Fetch all draft pages

  async function fetchAllDrafts() {
    let cursor = null;
    let allItems = [];
    let page = 0;

    while (true) {
      page++;
      let url = `/backend/project_y/profile/drafts/v2?limit=${DRAFTS_LIMIT}`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

      emitLog(`Fetching drafts page ${page}...`);

      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) {
        if (res.status === 401) {
          emitLog("Token expired, refreshing...", "skip");
          await getToken();
          continue;
        }
        throw new Error("Drafts fetch failed: " + res.status);
      }

      const data = await res.json();
      if (!data.items || data.items.length === 0) break;

      allItems = allItems.concat(data.items);
      emitLog(`  Got ${data.items.length} drafts (${allItems.length} total)`);

      if (!data.cursor) break;
      cursor = data.cursor;
    }

    return allItems;
  }

  // Post a single draft

  async function postDraft(draft, attempt = 1) {
    await waitForCooldown();

    let generationId;
    let kind;
    let sourceText;

    if (draft.kind === "sora_draft") {
      generationId = draft.generation_id || draft.id;
      kind = "sora";
      sourceText = draft.prompt || draft.title || "";
    } else if (!draft.kind && draft.assets) {
      generationId = draft.id;
      kind = "sora_edit";
      sourceText = draft.caption || "";
    } else {
      return { status: "skip", reason: draft.kind || "unknown" };
    }

    const postText = shortenPostText(sourceText);

    const body = {
      attachments_to_create: [{ generation_id: generationId, kind }],
      post_text: postText.text,
    };

    const res = await fetch("/backend/project_y/post", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });

    if (res.ok) {
      noteSuccessfulPost();
      return {
        status: "ok",
        shortened: postText.shortened,
        originalLength: postText.originalLength,
      };
    }

    if (res.status === 401 && attempt <= MAX_RETRIES) {
      emitLog("  Token expired, refreshing...", "skip");
      await getToken();
      return postDraft(draft, attempt + 1);
    }

    if (res.status === 429 && attempt <= MAX_RETRIES) {
      const wait = noteRateLimit(res, attempt);
      emitLog(
        `  Rate limited, waiting ${Math.ceil(wait / 1000)}s (retry ${attempt}/${MAX_RETRIES})...`,
        "skip"
      );
      await sleep(wait);
      return postDraft(draft, attempt + 1);
    }

    if (res.status >= 500 && attempt <= MAX_RETRIES) {
      const wait = Math.max(getConfiguredBaseDelayMs(), SERVER_RETRY_DELAY_MS * attempt);
      emitLog(
        `  Server error ${res.status}, retrying in ${Math.ceil(wait / 1000)}s (${attempt}/${MAX_RETRIES})...`,
        "skip"
      );
      await sleep(wait);
      return postDraft(draft, attempt + 1);
    }

    let errMsg = res.status.toString();
    try {
      const errBody = await res.json();
      errMsg += " - " + (errBody.error?.message || JSON.stringify(errBody));
    } catch {}
    return { status: "fail", reason: errMsg };
  }

  // Main flow

  async function publishAll(pacingSettings) {
    if (runState.isRunning) {
      return false;
    }

    resetRunState(pacingSettings);

    try {
      emitStats();
      emitLog("Authenticating...");
      emitLog(`Pacing: ${describePacing()}`);
      await getToken();
      emitLog("Fetching all drafts...");

      const drafts = await fetchAllDrafts();
      runState.total = drafts.length;
      emitLog(`Found ${runState.total} drafts.`);
      emitStats();

      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i];
        const label = (draft.prompt || draft.caption || draft.id).substring(0, 50);

        if (draft.kind === "sora_content_violation") {
          emitLog(`[${i + 1}/${runState.total}] SKIP (violation): ${label}`, "skip");
          runState.skipped++;
          emitStats();
          continue;
        }

        emitLog(`[${i + 1}/${runState.total}] Posting: ${label}`);
        const result = await postDraft(draft);

        if (result.status === "ok") {
          emitLog("  Posted.", "success");
          if (result.shortened) {
            emitLog(
              `  Shortened caption from ${result.originalLength} to ${MAX_POST_TEXT_LENGTH} characters.`,
              "skip"
            );
          }
          runState.posted++;
        } else if (result.status === "skip") {
          emitLog(`  Skipped (${result.reason})`, "skip");
          runState.skipped++;
        } else {
          emitLog(`  Failed: ${result.reason}`, "error");
          runState.failed++;
        }

        emitStats();

        if (i < drafts.length - 1) {
          await sleep(runState.postDelayMs);
        }
      }

      emitLog(
        `\nDone! Posted: ${runState.posted}, Skipped: ${runState.skipped}, Failed: ${runState.failed}`,
        "success"
      );
    } catch (error) {
      emitLog("Fatal error: " + error.message, "error");
    } finally {
      finishRun();
    }

    return true;
  }

  // Listen for popup messages

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "publish_all") {
      if (runState.isRunning) {
        sendResponse({ started: false, alreadyRunning: true, state: getSerializableState() });
        return;
      }

      publishAll(msg.pacing);
      sendResponse({ started: true, state: getSerializableState() });
      return;
    }

    if (msg.action === "get_status") {
      sendResponse(getSerializableState());
    }
  });
})();

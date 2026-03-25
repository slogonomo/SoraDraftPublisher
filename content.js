(() => {
  // Config
  const DRAFTS_LIMIT = 30;
  const FAST_POST_DELAY_MS = 4000;
  const FAST_RATE_LIMIT_BASE_DELAY_MS = 15000;
  const SERVER_RETRY_DELAY_MS = 5000;
  const MAX_AUTH_RETRIES = 3;
  const MAX_SERVER_RETRIES = 3;
  const MAX_RATE_LIMIT_RETRIES = 8;
  const MAX_RATE_LIMIT_DELAY_MS = 600000;
  const MAX_POST_TEXT_LENGTH = 1999;
  const LOG_HISTORY_LIMIT = 250;
  const DEFAULT_SLOW_MODE_SECONDS = 30;
  const DRAFT_CACHE_STORAGE_KEY = "draftQueueCache";
  const DRAFT_CACHE_VERSION = 1;

  let accessToken = null;
  let cacheWarningShown = false;
  const runState = createInitialRunState();

  function createDefaultPacing() {
    return {
      slowMode: false,
      slowModeSeconds: DEFAULT_SLOW_MODE_SECONDS,
    };
  }

  function normalizePublishOptions(options = {}) {
    return {
      pacing: normalizePacingSettings(options.pacing || options),
      randomOrder: Boolean(options.randomOrder),
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
      randomOrder: false,
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

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  }

  function storageSet(items) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(items, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
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
      randomOrder: runState.randomOrder,
      postDelayMs: runState.postDelayMs,
      cooldownUntil: runState.cooldownUntil,
    };
  }

  function resetRunState(options) {
    const publishOptions = normalizePublishOptions(options);
    cacheWarningShown = false;

    Object.assign(runState, createInitialRunState(), {
      isRunning: true,
      startedAt: Date.now(),
      pacing: publishOptions.pacing,
      randomOrder: publishOptions.randomOrder,
      postDelayMs: getConfiguredBaseDelayMs(publishOptions.pacing),
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

  function noteCacheWarning(message) {
    if (cacheWarningShown) {
      return;
    }

    cacheWarningShown = true;
    emitLog(message, "error");
  }

  function describePacing(pacing = runState.pacing) {
    if (!pacing.slowMode) {
      return "Fast mode: 4s between drafts, with 429 retries growing from 15s up to a 10 minute cap.";
    }

    return (
      `Slow mode: ${pacing.slowModeSeconds}s between drafts, with 429 retries at ` +
      `${Math.ceil(getRecommendedRateLimitBackoffMs(1, pacing) / 1000)}s, ` +
      `${Math.ceil(getRecommendedRateLimitBackoffMs(2, pacing) / 1000)}s, then ` +
      `${Math.ceil(getRecommendedRateLimitBackoffMs(3, pacing) / 1000)}s before continuing to double up to a 10 minute cap.`
    );
  }

  function describeOrder() {
    return runState.randomOrder
      ? "Random order is enabled for this run."
      : "Posting drafts in the fetched order.";
  }

  function formatAge(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));

    if (minutes < 60) {
      return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }

    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
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

  function normalizeDraftForPublish(draft) {
    return {
      id: draft.id,
      kind: draft.kind || null,
      generation_id: draft.generation_id || null,
      prompt: typeof draft.prompt === "string" ? draft.prompt : "",
      title: typeof draft.title === "string" ? draft.title : "",
      caption: typeof draft.caption === "string" ? draft.caption : "",
      assets: Boolean(draft.assets),
    };
  }

  function getDraftLabel(draft) {
    return (draft.prompt || draft.caption || draft.title || draft.id || "untitled").substring(0, 50);
  }

  async function fetchAllDrafts() {
    let cursor = null;
    let allItems = [];
    let page = 0;
    let usedPartialResults = false;

    while (true) {
      page++;
      let url = `/backend/project_y/profile/drafts/v2?limit=${DRAFTS_LIMIT}`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

      emitLog(`Fetching drafts page ${page}...`);

      let res;
      try {
        res = await fetch(url, { headers: authHeaders() });
      } catch (error) {
        if (allItems.length) {
          usedPartialResults = true;
          emitLog(
            `Draft fetch stopped after ${allItems.length} drafts (${error.message}). Continuing with the saved partial queue.`,
            "skip"
          );
          break;
        }
        throw error;
      }

      if (!res.ok) {
        if (res.status === 401) {
          emitLog("Token expired, refreshing...", "skip");
          await getToken();
          continue;
        }
        if (allItems.length) {
          usedPartialResults = true;
          emitLog(
            `Draft fetch stopped with ${res.status} after ${allItems.length} drafts. Continuing with the saved partial queue.`,
            "skip"
          );
          break;
        }
        throw new Error("Drafts fetch failed: " + res.status);
      }

      const data = await res.json();
      if (!data.items || data.items.length === 0) break;

      allItems = allItems.concat(data.items.map(normalizeDraftForPublish));
      await saveDraftCache(allItems);
      emitLog(`  Got ${data.items.length} drafts (${allItems.length} total)`);

      if (!data.cursor) break;
      cursor = data.cursor;
    }

    return {
      drafts: allItems,
      usedPartialResults,
    };
  }

  function shuffleDrafts(items) {
    const shuffledItems = items.slice();

    for (let i = shuffledItems.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledItems[i], shuffledItems[j]] = [shuffledItems[j], shuffledItems[i]];
    }

    return shuffledItems;
  }

  async function loadDraftCache() {
    try {
      const result = await storageGet(DRAFT_CACHE_STORAGE_KEY);
      const cache = result[DRAFT_CACHE_STORAGE_KEY];

      if (
        !cache ||
        cache.version !== DRAFT_CACHE_VERSION ||
        !Array.isArray(cache.remainingDrafts) ||
        cache.remainingDrafts.length === 0
      ) {
        return null;
      }

      return cache;
    } catch (error) {
      noteCacheWarning("Couldn't read the local draft cache, so this run will refetch from Sora.");
      return null;
    }
  }

  async function saveDraftCache(remainingDrafts) {
    try {
      if (!remainingDrafts.length) {
        await storageRemove(DRAFT_CACHE_STORAGE_KEY);
        return true;
      }

      await storageSet({
        [DRAFT_CACHE_STORAGE_KEY]: {
          version: DRAFT_CACHE_VERSION,
          updatedAt: Date.now(),
          remainingDrafts,
        },
      });
      return true;
    } catch (error) {
      noteCacheWarning("Couldn't save the local draft cache, so resume may require a refetch.");
      return false;
    }
  }

  async function clearDraftCache() {
    try {
      await storageRemove(DRAFT_CACHE_STORAGE_KEY);
    } catch (error) {
      noteCacheWarning("Couldn't clear the local draft cache after finishing the run.");
    }
  }

  async function getDraftsForRun() {
    const cachedQueue = await loadDraftCache();

    if (cachedQueue) {
      const cacheAge = Date.now() - cachedQueue.updatedAt;
      emitLog(
        `Using cached draft queue with ${cachedQueue.remainingDrafts.length} remaining drafts from ${formatAge(cacheAge)} ago.`,
        "skip"
      );

      const drafts = runState.randomOrder
        ? shuffleDrafts(cachedQueue.remainingDrafts)
        : cachedQueue.remainingDrafts.slice();

      if (runState.randomOrder) {
        emitLog("Randomized cached draft order for this run.");
        await saveDraftCache(drafts);
      }

      return drafts;
    }

    emitLog("Fetching all drafts...");
    const fetchResult = await fetchAllDrafts();
    const drafts = runState.randomOrder ? shuffleDrafts(fetchResult.drafts) : fetchResult.drafts;

    if (runState.randomOrder) {
      emitLog("Randomized draft order for this run.");
    }

    const cacheSaved = await saveDraftCache(drafts);
    if (cacheSaved) {
      emitLog(`Saved ${drafts.length} drafts to the local resume cache.`, "skip");
    }
    if (fetchResult.usedPartialResults) {
      emitLog(
        "Continuing with a partial draft queue because the full draft fetch did not complete.",
        "skip"
      );
    }

    return drafts;
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

    if (res.status === 401 && attempt <= MAX_AUTH_RETRIES) {
      emitLog("  Token expired, refreshing...", "skip");
      await getToken();
      return postDraft(draft, attempt + 1);
    }

    if (res.status === 429) {
      const wait = noteRateLimit(res, attempt);

      if (attempt <= MAX_RATE_LIMIT_RETRIES) {
        emitLog(
          `  Rate limited, waiting ${Math.ceil(wait / 1000)}s (retry ${attempt}/${MAX_RATE_LIMIT_RETRIES})...`,
          "skip"
        );
        await sleep(wait);
        return postDraft(draft, attempt + 1);
      }
    }

    if (res.status >= 500 && attempt <= MAX_SERVER_RETRIES) {
      const wait = Math.max(getConfiguredBaseDelayMs(), SERVER_RETRY_DELAY_MS * attempt);
      emitLog(
        `  Server error ${res.status}, retrying in ${Math.ceil(wait / 1000)}s (${attempt}/${MAX_SERVER_RETRIES})...`,
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

  async function publishAll(options) {
    if (runState.isRunning) {
      return false;
    }

    resetRunState(options);

    try {
      emitStats();
      emitLog("Authenticating...");
      emitLog(`Pacing: ${describePacing()}`);
      emitLog(`Order: ${describeOrder()}`);
      await getToken();
      const drafts = await getDraftsForRun();
      runState.total = drafts.length;
      emitLog(`Found ${runState.total} drafts.`);
      emitStats();

      let deferredFailedDrafts = [];

      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i];
        const label = getDraftLabel(draft);

        if (draft.kind === "sora_content_violation") {
          emitLog(`[${i + 1}/${runState.total}] SKIP (violation): ${label}`, "skip");
          runState.skipped++;
          await saveDraftCache(drafts.slice(i + 1).concat(deferredFailedDrafts));
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
          deferredFailedDrafts.push(draft);
        }

        const remainingDrafts = drafts.slice(i + 1).concat(deferredFailedDrafts);
        await saveDraftCache(remainingDrafts);
        emitStats();

        if (i < drafts.length - 1) {
          await sleep(runState.postDelayMs);
        }
      }

      emitLog(
        `\nDone! Posted: ${runState.posted}, Skipped: ${runState.skipped}, Failed: ${runState.failed}`,
        "success"
      );
      if (deferredFailedDrafts.length) {
        await saveDraftCache(deferredFailedDrafts);
        emitLog(
          `Kept ${deferredFailedDrafts.length} failed drafts in the local resume cache for the next run.`,
          "skip"
        );
      } else {
        await clearDraftCache();
      }
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

      publishAll({
        pacing: msg.pacing,
        randomOrder: msg.randomOrder,
      });
      sendResponse({ started: true, state: getSerializableState() });
      return;
    }

    if (msg.action === "get_status") {
      sendResponse(getSerializableState());
    }
  });
})();

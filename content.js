(() => {
  // Config
  const DRAFTS_LIMIT = 30;
  const POST_DELAY_MS = 1500;    // delay between posts to be nice to the API
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 5000;
  const MAX_POST_TEXT_LENGTH = 1999;

  let accessToken = null;

  // ── Helpers ──────────────────────────────────────────────

  function send(type, data = {}) {
    chrome.runtime.sendMessage({ type, ...data });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

  // ── Fetch all draft pages ───────────────────────────────

  async function fetchAllDrafts() {
    let cursor = null;
    let allItems = [];
    let page = 0;

    while (true) {
      page++;
      let url = `/backend/project_y/profile/drafts/v2?limit=${DRAFTS_LIMIT}`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

      send("log", { text: `Fetching drafts page ${page}...` });

      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) {
        // If 401, try refreshing token once
        if (res.status === 401) {
          send("log", { text: "Token expired, refreshing...", cls: "skip" });
          await getToken();
          continue; // retry same page
        }
        throw new Error("Drafts fetch failed: " + res.status);
      }

      const data = await res.json();
      if (!data.items || data.items.length === 0) break;

      allItems = allItems.concat(data.items);
      send("log", {
        text: `  Got ${data.items.length} drafts (${allItems.length} total)`,
      });

      if (!data.cursor) break;
      cursor = data.cursor;
    }

    return allItems;
  }

  // ── Post a single draft ─────────────────────────────────

  async function postDraft(draft, attempt = 1) {
    // Determine the generation_id and kind for the post call
    let generationId, kind, sourceText;

    if (draft.kind === "sora_draft") {
      generationId = draft.generation_id || draft.id;
      kind = "sora";
      sourceText = draft.prompt || draft.title || "";
    } else if (!draft.kind && draft.assets) {
      // Edited/project item — use the project id with kind "sora_edit"
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
      return {
        status: "ok",
        shortened: postText.shortened,
        originalLength: postText.originalLength,
      };
    }

    // Handle retries
    if (res.status === 401 && attempt <= MAX_RETRIES) {
      send("log", { text: "  Token expired, refreshing...", cls: "skip" });
      await getToken();
      return postDraft(draft, attempt + 1);
    }

    if (res.status === 429 && attempt <= MAX_RETRIES) {
      const wait = RETRY_DELAY_MS * attempt;
      send("log", {
        text: `  Rate limited, waiting ${wait / 1000}s (retry ${attempt}/${MAX_RETRIES})...`,
        cls: "skip",
      });
      await sleep(wait);
      return postDraft(draft, attempt + 1);
    }

    if (res.status >= 500 && attempt <= MAX_RETRIES) {
      const wait = RETRY_DELAY_MS * attempt;
      send("log", {
        text: `  Server error ${res.status}, retrying in ${wait / 1000}s (${attempt}/${MAX_RETRIES})...`,
        cls: "skip",
      });
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

  // ── Main flow ───────────────────────────────────────────

  async function publishAll() {
    let posted = 0,
      skipped = 0,
      failed = 0,
      total = 0;

    try {
      send("log", { text: "Authenticating..." });
      await getToken();
      send("log", { text: "Fetching all drafts..." });

      const drafts = await fetchAllDrafts();
      total = drafts.length;
      send("log", { text: `Found ${total} drafts.` });
      send("stats", { posted, skipped, failed, total });

      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i];
        const label = (draft.prompt || draft.caption || draft.id).substring(0, 50);

        if (draft.kind === "sora_content_violation") {
          send("log", { text: `[${i + 1}/${total}] SKIP (violation): ${label}`, cls: "skip" });
          skipped++;
          send("stats", { posted, skipped, failed, total });
          continue;
        }

        send("log", { text: `[${i + 1}/${total}] Posting: ${label}` });
        const result = await postDraft(draft);

        if (result.status === "ok") {
          send("log", { text: `  ✓ Posted!`, cls: "success" });
          if (result.shortened) {
            send("log", {
              text: `  Shortened caption from ${result.originalLength} to ${MAX_POST_TEXT_LENGTH} characters.`,
              cls: "skip",
            });
          }
          posted++;
        } else if (result.status === "skip") {
          send("log", { text: `  ⊘ Skipped (${result.reason})`, cls: "skip" });
          skipped++;
        } else {
          send("log", { text: `  ✗ Failed: ${result.reason}`, cls: "error" });
          failed++;
        }

        send("stats", { posted, skipped, failed, total });

        // Polite delay between posts
        if (i < drafts.length - 1 && result.status === "ok") {
          await sleep(POST_DELAY_MS);
        }
      }

      send("log", {
        text: `\nDone! Posted: ${posted}, Skipped: ${skipped}, Failed: ${failed}`,
        cls: "success",
      });
    } catch (e) {
      send("log", { text: "Fatal error: " + e.message, cls: "error" });
    }

    send("done");
  }

  // ── Listen for trigger from popup ───────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "publish_all") {
      publishAll();
      sendResponse({ started: true });
    }
  });
})();

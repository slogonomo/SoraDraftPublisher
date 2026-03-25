# Sora Bulk Publisher

Chrome extension for publishing all visible Sora drafts from `sora.chatgpt.com`, while trimming any outgoing caption text to stay under 2000 characters.

## Important

- Strongly recommended: enable slow mode and use a large delay, such as `300` seconds or more, if you want the lowest chance of getting throttled.
- If you start seeing lots of `429 Too Many Requests` messages, refreshing or closing the Sora tab will stop the run. That is the recommended way to stop immediately and give the account time to cool down.

## Download

Current packaged build: [SoraDraftPublisher-v1.8.zip](./SoraDraftPublisher-v1.8.zip)

## Decompress

1. Download [SoraDraftPublisher-v1.8.zip](./SoraDraftPublisher-v1.8.zip).
2. Double-click the zip file in Finder to extract it, or run `unzip SoraDraftPublisher-v1.8.zip -d SoraDraftPublisher-v1.8`.
3. In Chrome, load the extracted folder with **Load unpacked**.

## Install

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the folder `/Users/john/Documents/SoraDraftPublisher`.

## Use

1. Open `https://sora.chatgpt.com` and sign in.
2. Open the extension popup.
3. Click **Publish All Drafts**.
4. If you close the popup by accident, reopen it on the same Sora tab to reconnect to the current run and see the saved log.
5. Refreshing or closing the Sora tab itself will stop the run. That is recommended if you are seeing a heavy stream of throttling messages.

## Notes

- Content-violation drafts are skipped.
- Draft captions longer than 1999 characters are shortened automatically before posting.
- The current run stays attached to the active Sora tab, so reloading that tab will interrupt the in-progress publish job.
- The publisher now slows itself down after `429 Too Many Requests` responses and keeps a longer cooldown before continuing.
- Slow mode can be enabled from the popup with a custom per-draft delay. At the default 30 seconds, `429` retries back off to at least 60, 120, and 240 seconds.
- For the safest pacing, use slow mode with a much larger delay, such as 5 minutes or more between drafts.
- Randomize publish order can be enabled from the popup so grouped drafts are mixed before posting.
- The remaining draft queue is cached locally during a run, so restarting after an interruption resumes from the saved queue instead of refetching every draft again.
- If the full draft fetch fails after some pages have already loaded, the extension keeps that partial queue and continues posting from it instead of throwing the whole run away.
- `429 Too Many Requests` now uses a longer capped exponential retry schedule, while `5xx` and auth retries stay on the shorter path.

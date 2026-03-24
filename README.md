# Sora Bulk Publisher

Chrome extension for publishing all visible Sora drafts from `sora.chatgpt.com`, while trimming any outgoing caption text to stay under 2000 characters.

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

## Notes

- Content-violation drafts are skipped.
- Draft captions longer than 1999 characters are shortened automatically before posting.
- The current run stays attached to the active Sora tab, so reloading that tab will interrupt the in-progress publish job.
- The publisher now slows itself down after `429 Too Many Requests` responses and keeps a longer cooldown before continuing.

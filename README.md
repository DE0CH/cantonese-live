# Cantonese live

Live transcription of Cantonese (mixed with Mandarin and English), as spoken, in Hong Kong Traditional characters, as a
web page, and a page that transcribes a recorded file. Nothing is kept. The live page uses Soniox (`stt-rt-v5`) through
the relay. The iOS app, which runs its model on the phone, is its own repo: [DE0CH/cantonese-live-ios](https://github.com/DE0CH/cantonese-live-ios).

Network drops are invisible: the page keeps the audio Soniox hasn't finalized, reconnects at once and replays it, and
splits a long backlog onto its own connection so live subtitles never lag (see `relay/src/index.js`). On desktop,
「彈出視窗」 moves the subtitles into a narrow always-on-top window (Document Picture-in-Picture in Chrome/Edge, a plain
popup elsewhere).

`/file` transcribes a recording or video instead: Uppy's Dashboard uploads it straight from the browser into the
private R2 bucket `cantonese-files` (S3 multipart in 10 MB parts over URLs the Worker signs, so any size and pause or
resume), Soniox's async model (`stt-async-v6`, up to 300 minutes) fetches it from a signed link, and the page shows
one row per sentence with its start time and, when there is more than one, the speaker. The recording and Soniox's copy
are deleted as soon as the transcript is read; the bucket's lifecycle rule removes anything left after a day. The page
remembers a running job and its result in the browser, so a reload or a sleeping phone carries on.

- `relay/`: a Cloudflare Worker at `cantonese.deyaochen.com` (behind Cloudflare Access) that serves the web pages,
  relays 16 kHz PCM from the clients to Soniox over WebSockets (holding the keys), converts the text to Hong Kong
  Traditional with OpenCC. `src/file.js` is the `/file` API, `src/rows.js` turns Soniox's tokens into rows,
  `web/file.js` the page's script (built by `build.mjs` before every deploy), `r2/` the bucket's CORS and lifecycle.
- `scripts/relay-test.mjs`: streams `testdata/cantonese-16k.wav` through the live relay.
- `scripts/file-test.mjs`: a browser walk of `/file` (the clip as one upload, a 30 MB video in parts).
- `scripts/cloudflare-access/`: the Access app (Deyao's email, and the `cantonese-live-ci` service token for the live
  tests); a Rust tool, built by the `tools` workflow (its binary is the run's artifact).

CI (`.github/workflows/relay.yml`) runs the unit tests and the `/file` browser walk on a local Worker (real R2 and
Soniox) on every push; on main it applies the bucket's settings, deploys the Worker with the keys from GitHub secrets
and runs both live tests through Access.

Secrets (GitHub Actions only, never in git): `CLOUDFLARE_API_TOKEN` (Workers deploy), `CLOUDFLARE_R2_TOKEN` (R2 Storage
Write: the bucket's settings), `SONIOX_API_KEY`, `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (an S3 key confined to the
bucket), `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (the `cantonese-live-ci` service token).

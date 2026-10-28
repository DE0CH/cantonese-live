# Cantonese live

Live transcription of Cantonese (mixed with Mandarin and English), as spoken, in Hong Kong Traditional characters, as a
web page. Nothing is stored. It uses Soniox (`stt-rt-v5`) through the relay. The iOS app, which runs its model on the
phone, is its own repo: [DE0CH/cantonese-live-ios](https://github.com/DE0CH/cantonese-live-ios).

Network drops are invisible: the page keeps the audio Soniox hasn't finalized, reconnects at once and replays it, and
splits a long backlog onto its own connection so live subtitles never lag (see `relay/src/index.js`). On desktop,
「彈出視窗」 moves the subtitles into a narrow always-on-top window (Document Picture-in-Picture in Chrome/Edge, a plain
popup elsewhere).

- `relay/`: a Cloudflare Worker at `cantonese.deyaochen.com` (behind Cloudflare Access) that serves the web page,
  relays 16 kHz PCM from the clients to Soniox over WebSockets (holding the keys), converts the text to Hong Kong
  Traditional with OpenCC.
- `scripts/relay-test.mjs`: streams `testdata/cantonese-16k.wav` through the live relay.
- `scripts/cloudflare-access.sh`: the Access app (Deyao's email only).

CI (`.github/workflows/relay.yml`) deploys the Worker with the keys from GitHub secrets and runs the live test.

Secrets (GitHub Actions only, never in git): `CLOUDFLARE_API_TOKEN`, `SONIOX_API_KEY`.

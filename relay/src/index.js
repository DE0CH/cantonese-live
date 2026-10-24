// Relay between the clients (web page, iOS app) and Soniox. Cloudflare Access sits in front of the
// whole hostname, so a request that reaches this code is Deyao's browser or the app's service token.
//
// Client protocol (GET /ws, WebSocket):
//   client -> relay: binary frames of 16 kHz mono PCM s16le; the text frame "stop" ends the stream.
//   relay -> client: {"type":"ready"} once Soniox accepts audio,
//                    {"type":"text","commit":"…","pending":"…","final_ms":N} (commit: append for good; pending:
//                    replaces the previous pending text; "\n" in commit ends a line; final_ms: how much of this
//                    stream's audio is finalized), {"type":"ping"} every second, {"type":"error","message":"…"},
//                    {"type":"done"}.
//
// The relay keeps no session. A client that loses its connection opens a new one and replays its audio from the
// last final_ms, so a network drop, a Soniox drop or a relay redeploy loses and repeats nothing.

import * as OpenCC from "opencc-js";

// Soniox may answer in Simplified characters; the app shows Hong Kong Traditional.
const toHK = OpenCC.Converter({ from: "cn", to: "hk" });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      relay(server, env).catch((e) => fail(server, String(e?.message || e)));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/health") return Response.json({ ok: true });
    return env.ASSETS.fetch(request);
  },
};

function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch {}
}

function fail(ws, message) {
  send(ws, { type: "error", message });
  try { ws.close(1011, "speech error"); } catch {}
}

async function upstream(url, headers) {
  const res = await fetch(url, { headers: { Upgrade: "websocket", ...headers } });
  if (!res.webSocket) throw new Error(`Soniox refused the connection (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  res.webSocket.accept();
  return res.webSocket;
}

async function relay(client, env) {
  // Audio that arrives before Soniox is ready is queued, not dropped.
  const queue = [];
  let stream = null, stopped = false;
  // Binary frames may arrive as Blobs; reading them is async, so a chain keeps the audio in order.
  let chain = Promise.resolve();
  client.addEventListener("message", (e) => {
    chain = chain.then(async () => {
      if (typeof e.data === "string") {
        if (e.data === "stop") { stopped = true; stream?.stop(); }
        return;
      }
      const chunk = e.data instanceof Blob ? await e.data.arrayBuffer() : e.data;
      stream ? stream.audio(chunk) : queue.push(chunk);
    });
  });
  client.addEventListener("close", () => { stopped = true; stream?.close(); });
  let finished = false;
  const ping = setInterval(() => send(client, { type: "ping" }), 1000);   // lets the client spot a dead connection
  client.addEventListener("close", () => clearInterval(ping));
  stream = await openSoniox(env, {
    text: (commit, pending, finalMs) => send(client, { type: "text", commit: toHK(commit), pending: toHK(pending), final_ms: finalMs }),
    error: (m) => { clearInterval(ping); fail(client, m); },
    done: () => {
      if (finished) return;
      finished = true;
      clearInterval(ping);
      send(client, { type: "done" });
      try { client.close(1000, "done"); } catch {}
    },
  });
  send(client, { type: "ready" });
  for (const chunk of queue.splice(0)) stream.audio(chunk);
  if (stopped) stream.stop();
}

// Soniox real-time: https://soniox.com/docs/stt/api-reference/websocket-api
async function openSoniox(env, out) {
  const ws = await upstream("https://stt-rt.soniox.com/transcribe-websocket", { Authorization: `Bearer ${env.SONIOX_API_KEY}` });
  ws.send(JSON.stringify({
    model: "stt-rt-v5",
    audio_format: "pcm_s16le",
    sample_rate: 16000,
    num_channels: 1,
    language_hints: ["zh", "en"],
    enable_endpoint_detection: true,
    context: { general: [{ key: "domain", value: "Hong Kong trilingual conversation (Cantonese/English/Mandarin)" }] },
  }));
  let lineStart = true;   // tokens after an endpoint start with a space; a new line shouldn't
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.error_code) return out.error(`Soniox ${m.error_code}: ${m.error_message}`);
    let commit = "", pending = "";
    for (const t of m.tokens || []) {
      if (t.text === "<end>") { if (t.is_final) { commit += "\n"; lineStart = true; } continue; }
      const text = lineStart && !(commit + pending).trim() ? t.text.trimStart() : t.text;
      if (t.is_final) { commit += text; if (text) lineStart = false; } else pending += text;
    }
    if (m.tokens) out.text(commit, pending, m.final_audio_proc_ms ?? 0);
    if (m.finished) out.done();
  });
  ws.addEventListener("close", () => out.done());
  return {
    audio: (chunk) => ws.send(new Uint8Array(chunk)),
    stop: () => ws.send(""),
    close: () => { try { ws.close(); } catch {} },
  };
}

// Relay between the clients (web page, iOS app) and the speech providers. Cloudflare Access sits in front of the
// whole hostname, so a request that reaches this code is Deyao's browser or the app's service token.
//
// Client protocol (GET /ws?provider=soniox|funasr, WebSocket):
//   client -> relay: binary frames of 16 kHz mono PCM s16le; the text frame "stop" ends the stream.
//   relay -> client: {"type":"ready"} once the provider accepts audio,
//                    {"type":"text","commit":"…","pending":"…"} (commit: append for good; pending: replaces the
//                    previous pending text), {"type":"error","message":"…"}, {"type":"done"}.

import * as OpenCC from "opencc-js";

const PROVIDERS = { soniox: openSoniox, funasr: openFunAsr };
// Both engines may answer in Simplified characters; the app shows Hong Kong Traditional.
const toHK = OpenCC.Converter({ from: "cn", to: "hk" });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
      const open = PROVIDERS[url.searchParams.get("provider")];
      if (!open) return new Response("unknown provider", { status: 400 });
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      relay(server, open, env).catch((e) => fail(server, String(e?.message || e)));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/health") return Response.json({ ok: true, providers: Object.keys(PROVIDERS) });
    return env.ASSETS.fetch(request);
  },
};

function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch {}
}

function fail(ws, message) {
  send(ws, { type: "error", message });
  try { ws.close(1011, "provider error"); } catch {}
}

async function upstream(url, headers) {
  const res = await fetch(url, { headers: { Upgrade: "websocket", ...headers } });
  if (!res.webSocket) throw new Error(`provider refused the connection (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  res.webSocket.accept();
  return res.webSocket;
}

async function relay(client, open, env) {
  // Audio that arrives before the provider is ready is queued, not dropped.
  const queue = [];
  let provider = null, stopped = false;
  client.addEventListener("message", (e) => {
    if (typeof e.data === "string") {
      if (e.data === "stop") { stopped = true; provider ? provider.stop() : null; }
      return;
    }
    provider ? provider.audio(e.data) : queue.push(e.data);
  });
  client.addEventListener("close", () => { stopped = true; provider?.close(); });
  provider = await open(env, {
    text: (commit, pending) => send(client, { type: "text", commit: toHK(commit), pending: toHK(pending) }),
    error: (m) => fail(client, m),
    done: () => { send(client, { type: "done" }); try { client.close(1000, "done"); } catch {} },
  });
  send(client, { type: "ready" });
  for (const chunk of queue.splice(0)) provider.audio(chunk);
  if (stopped) provider.stop();
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
    context: { general: [{ key: "domain", value: "Hong Kong Cantonese conversation" }], text: "以粵語口語書寫，例如：佢哋喺度講緊嘢，我哋聽日去咗飲茶。" },
  }));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.error_code) return out.error(`Soniox ${m.error_code}: ${m.error_message}`);
    let commit = "", pending = "";
    for (const t of m.tokens || []) {
      const text = t.text === "<end>" ? "\n" : t.text;
      if (t.is_final) commit += text; else if (t.text !== "<end>") pending += text;
    }
    if (commit || pending || m.tokens?.length === 0) out.text(commit, pending);
    if (m.finished) out.done();
  });
  ws.addEventListener("close", () => out.done());
  return {
    audio: (chunk) => ws.send(chunk),
    stop: () => ws.send(""),
    close: () => { try { ws.close(); } catch {} },
  };
}

// Alibaba Model Studio Fun-ASR realtime: https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api
async function openFunAsr(env, out) {
  const ws = await upstream(env.FUNASR_URL, { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}` });
  const taskId = crypto.randomUUID().replaceAll("-", "");
  let started = false;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      const event = m.header?.event;
      if (event === "task-started") { started = true; resolve(); }
      else if (event === "result-generated") {
        const s = m.payload?.output?.sentence;
        if (!s || s.heartbeat) return;
        s.sentence_end ? out.text(s.text + "\n", "") : out.text("", s.text);
      } else if (event === "task-finished") { out.done(); ws.close(); }
      else if (event === "task-failed") {
        const msg = `Fun-ASR ${m.header.error_code}: ${m.header.error_message}`;
        started ? out.error(msg) : reject(new Error(msg));
      }
    });
  });
  ws.addEventListener("close", () => out.done());
  ws.send(JSON.stringify({
    header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: {
      task_group: "audio", task: "asr", function: "recognition", model: "fun-asr-realtime",
      parameters: { format: "pcm", sample_rate: 16000 },
      input: {},
    },
  }));
  await ready;
  return {
    audio: (chunk) => ws.send(chunk),
    stop: () => ws.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } })),
    close: () => { try { ws.close(); } catch {} },
  };
}

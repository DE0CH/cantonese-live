// Relay between the clients (web page, iOS app) and the speech providers. Cloudflare Access sits in front of the
// whole hostname, so a request that reaches this code is Deyao's browser or the app's service token.
//
// Client protocol (GET /ws?provider=soniox|funasr[&style=written], WebSocket):
//   client -> relay: binary frames of 16 kHz mono PCM s16le; the text frame "stop" ends the stream.
//   relay -> client: {"type":"ready"} once the provider accepts audio,
//                    {"type":"text","commit":"…","pending":"…"} (commit: append for good; pending: replaces the
//                    previous pending text; "\n" in commit ends a line), {"type":"error","message":"…"},
//                    {"type":"done"}. With style=written, each finished line (0-based, counted by the "\n"s in
//                    commit) is rewritten into written Chinese: {"type":"rewrite","line":n,"text":"…"} replaces it.

import * as OpenCC from "opencc-js";

const PROVIDERS = { soniox: openSoniox, funasr: openFunAsr };
// Both engines may answer in Simplified characters; the app shows Hong Kong Traditional.
const toHK = OpenCC.Converter({ from: "cn", to: "hk" });

// 書面語: one line of mixed Cantonese / Mandarin / English speech, rewritten by Qwen through OpenRouter.
const REWRITE_MODEL = "qwen/qwen3.7-plus";
const REWRITE_PROMPT = "你把一行即時語音轉寫改寫成香港書面中文（繁體）。粵語口語改為規範書面語（例如 佢哋→他們、咗→了、嘅→的、唔→不、喺→在、嗰→那、未呀→了嗎、搞掂→完成），" +
  "句子必須讀起來完全是書面語，不留任何粵語字詞；普通話句子保留原意，只轉成繁體；英文單詞和英文句子原樣保留，不翻譯；人名不變。" +
  "不增刪內容，不解釋，只輸出改寫後的一行。";

async function rewrite(env, text) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: REWRITE_MODEL, temperature: 0, reasoning: { enabled: false }, provider: { sort: "latency" },
      messages: [{ role: "system", content: REWRITE_PROMPT }, { role: "user", content: text }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return toHK((await res.json()).choices[0].message.content.trim());
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
      const open = PROVIDERS[url.searchParams.get("provider")];
      if (!open) return new Response("unknown provider", { status: 400 });
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      relay(server, open, env, url.searchParams.get("style") === "written").catch((e) => fail(server, String(e?.message || e)));
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

async function relay(client, open, env, written) {
  // Audio that arrives before the provider is ready is queued, not dropped.
  const queue = [];
  let provider = null, stopped = false;
  // Binary frames may arrive as Blobs; reading them is async, so a chain keeps the audio in order.
  let chain = Promise.resolve();
  client.addEventListener("message", (e) => {
    chain = chain.then(async () => {
      if (typeof e.data === "string") {
        if (e.data === "stop") { stopped = true; provider?.stop(); }
        return;
      }
      const chunk = e.data instanceof Blob ? await e.data.arrayBuffer() : e.data;
      provider ? provider.audio(chunk) : queue.push(chunk);
    });
  });
  client.addEventListener("close", () => { stopped = true; provider?.close(); });
  // style=written: collect each line's committed text and rewrite it once the line ends (and the last one at the end).
  let line = 0, current = "", finished = false;
  const rewrites = [];
  const finishLine = () => {
    const n = line++, text = current.trim();
    current = "";
    if (!written || !/[\u4e00-\u9fff]/.test(text)) return;
    rewrites.push(rewrite(env, text).then((t) => send(client, { type: "rewrite", line: n, text: t }), (e) => send(client, { type: "error", message: String(e.message || e) })));
  };
  provider = await open(env, {
    text: (commit, pending) => {
      commit = toHK(commit);
      send(client, { type: "text", commit, pending: toHK(pending) });
      const parts = commit.split("\n");
      current += parts[0];
      for (const p of parts.slice(1)) { finishLine(); current += p; }
    },
    error: (m) => fail(client, m),
    done: async () => {
      if (finished) return;
      finished = true;
      if (current.trim()) finishLine();
      await Promise.all(rewrites);
      send(client, { type: "done" });
      try { client.close(1000, "done"); } catch {}
    },
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
    if (commit || pending || m.tokens?.length === 0) out.text(commit, pending);
    if (m.finished) out.done();
  });
  ws.addEventListener("close", () => out.done());
  return {
    audio: (chunk) => ws.send(new Uint8Array(chunk)),
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
    audio: (chunk) => ws.send(new Uint8Array(chunk)),
    stop: () => ws.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } })),
    close: () => { try { ws.close(); } catch {} },
  };
}

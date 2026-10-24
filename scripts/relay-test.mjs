// Live check of the deployed relay: streams testdata/cantonese-16k.wav at real-time pace through
// wss://$RELAY_HOST/ws raw (原文) and written (書面語), with the iOS app's Access service token, and
// prints what came back. Fails unless raw keeps 我哋 and written turns every line into 我們-style written Chinese.
// Env: RELAY_HOST, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const WebSocket = createRequire(new URL("../relay/package.json", import.meta.url))("ws");

const pcm = readFileSync(new URL("../testdata/cantonese-16k.wav", import.meta.url)).subarray(44);
const host = process.env.RELAY_HOST || "cantonese.deyaochen.com";

function run(style) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://${host}/ws?style=${style}`, {
      headers: { "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET },
    });
    let text = "", firstText = 0, error = "";
    const rewritten = [];
    const t0 = Date.now();
    const timer = setTimeout(() => { error ||= "timed out"; ws.terminate(); }, 60000);
    ws.on("unexpected-response", (_, res) => { error = `HTTP ${res.statusCode}`; });
    ws.on("open", async () => {
      for (let i = 0; i < pcm.length; i += 3200) {          // 100 ms chunks, real-time pace
        ws.send(pcm.subarray(i, i + 3200));
        await new Promise((r) => setTimeout(r, 100));
      }
      ws.send("stop");
    });
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "text") { if (!firstText && (m.commit || m.pending)) firstText = Date.now() - t0; text += m.commit; }
      if (m.type === "rewrite") rewritten[m.line] = m.text;
      if (m.type === "error") error = m.message;
      if (m.type === "done") ws.close();
    });
    ws.on("close", () => {
      clearTimeout(timer);
      const spoken = text.trim().split("\n");
      resolve({ style, text: spoken.map((l, i) => rewritten[i] ?? l).join("\n"), firstText, error });
    });
    ws.on("error", (e) => { error ||= e.message; });
  });
}

let ok = true;
for (const style of ["raw", "written"]) {
  const r = await run(style);
  const good = !r.error && /[\u4e00-\u9fff]{4,}/.test(r.text) &&
    (style === "raw" ? r.text.includes("我哋") : r.text.includes("我們") && !/[哋咗嘅啲嚟]/.test(r.text));
  ok &&= good;
  console.log(`${good ? "PASS" : "FAIL"} ${style}: first text after ${r.firstText} ms: ${JSON.stringify(r.text)}${r.error ? " error: " + r.error : ""}`);
}
process.exit(ok ? 0 : 1);

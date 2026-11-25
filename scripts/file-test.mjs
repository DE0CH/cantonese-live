// Browser check of the /file page, end to end: picks a file in the real page, Uppy uploads it to R2, Soniox
// transcribes it, the rows appear. Two files: testdata/cantonese-16k.wav (one PUT) and a 30 MB video made with
// ffmpeg from the same clip (S3 multipart in 10 MB parts). Fails unless 蝦餃 comes back for both (the file model writes
// 「我們」 where the live relay says 「我哋」, so that is no check here).
// Also: the first walk starts at /files (the name people type; it must land on /file), and an address with no page
// must answer with the not-found page's links, never an empty page.
// Env: FILE_BASE (default https://cantonese.deyaochen.com), CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET for
// Access (sent on every request of the browser: R2's CORS allows any header).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../relay/package.json", import.meta.url))("playwright");

const base = process.env.FILE_BASE || "https://cantonese.deyaochen.com";
const wav = new URL("../testdata/cantonese-16k.wav", import.meta.url).pathname;
const big = join(mkdtempSync(join(tmpdir(), "file-test-")), "clip.mp4");
// Noise compresses badly, so 30 s of it at 8 Mbit/s makes a 30 MB video; the clip's audio loops under it.
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=640x360:d=30,geq=random(1)*255:128:128",
  "-stream_loop", "-1", "-i", wav, "-t", "30", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "8M", "-maxrate", "8M", "-bufsize", "8M",
  "-c:a", "aac", "-movflags", "+faststart", big]);

const headers = process.env.CF_ACCESS_CLIENT_ID
  ? { "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET }
  : {};
const browser = await chromium.launch();
let failed = false;
{
  const page = await browser.newPage({ extraHTTPHeaders: headers });
  const res = await page.goto(`${base}/no-such-page`);
  const links = await page.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  const ok = res.status() === 404 && links.includes("/") && links.includes("/file");
  console.log(`${ok ? "ok" : "FAIL"} not-found page: HTTP ${res.status()}, links ${JSON.stringify(links)}`);
  failed ||= !ok;
  await page.close();
}
for (const file of [wav, big]) {
  const t0 = Date.now();
  const page = await browser.newPage({ extraHTTPHeaders: headers });
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(`${base}${file === wav ? "/files" : "/file"}`);
  if (new URL(page.url()).pathname !== "/file") { console.log(`FAIL ${page.url()} is not /file`); failed = true; }
  await page.locator(".uppy-Dashboard-input").first().setInputFiles(file);
  const outcome = await Promise.race([
    page.locator("#rows li .tx").first().waitFor({ timeout: 240000 }).then(() => "rows"),
    page.locator("#job-status.bad").waitFor({ timeout: 240000 }).then(() => "failed"),
  ]).catch((e) => `timed out: ${e.message.split("\n")[0]}`);
  const text = outcome === "rows" ? (await page.locator("#rows").innerText()) : await page.locator("main").innerText();
  const mb = (statSync(file).size / 1e6).toFixed(1);
  const ok = outcome === "rows" && text.includes("蝦餃");
  console.log(`${ok ? "ok" : "FAIL"} ${mb} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  failed ||= !ok;
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);

// The /file page's API: a recording uploaded from the browser straight into the private R2 bucket (Uppy's S3
// multipart, with URLs this Worker signs), transcribed by Soniox's async API from a signed link to it, and handed back
// as rows. Nothing is kept: the recording is deleted from R2 and Soniox's transcription deleted once it is read, and
// the bucket's lifecycle rule removes anything left behind after a day.
//
//   POST /api/file/sign        Uppy's request to sign (PutObject or a multipart step) → {url, key?}
//   POST /api/file/transcribe  {key} → {id}
//   GET  /api/file/transcribe/ID?key=KEY → {status: "queued"|"processing"}
//                                        | {status: "completed", rows, speakers, duration_ms} | {status: "error", message}
//
// Env: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (secrets: a key confined to the bucket), R2_BUCKET, R2_ENDPOINT,
// SONIOX_API_KEY.

import { AwsClient } from "aws4fetch";
import { toRows } from "./rows.js";
import { toHK } from "./hk.js";

const SONIOX = "https://api.soniox.com/v1";
const KEY = /^in\/[0-9a-f-]{36}$/;
const CONTEXT = { general: [{ key: "domain", value: "Hong Kong trilingual conversation (Cantonese/English/Mandarin)" }] };

export async function fileApi(request, env, url) {
  try {
    const path = url.pathname.slice("/api/file/".length);
    if (path === "sign" && request.method === "POST") return Response.json(await sign(env, await request.json()));
    if (path === "transcribe" && request.method === "POST") return Response.json(await start(env, await request.json()));
    const m = path.match(/^transcribe\/([\w-]+)$/);
    if (m && request.method === "GET") return Response.json(await poll(env, m[1], url.searchParams.get("key")));
    return new Response("not found", { status: 404 });
  } catch (e) {
    return Response.json({ status: "error", message: String(e?.message || e) }, { status: e.status || 500 });
  }
}

function r2(env) {
  return new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
}

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

async function presign(env, method, key, params = {}, expires = 3600) {
  const u = new URL(`${env.R2_ENDPOINT}/${env.R2_BUCKET}/${key}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("X-Amz-Expires", String(expires));
  const signed = await r2(env).sign(u, { method, aws: { signQuery: true } });
  return signed.url;
}

// Uppy's S3 client asks for one request at a time (see @uppy/aws-s3 s3-client/types). The Worker picks the key of a
// new upload; every later step must name a key it picked.
export async function sign(env, req) {
  const { method, uploadId, partNumber } = req;
  const creating = (method === "PUT" || method === "POST") && uploadId == null;
  const key = creating ? `in/${crypto.randomUUID()}` : req.key;
  if (!KEY.test(key)) throw bad("not an upload of this page");
  if (!["PUT", "POST", "GET", "DELETE"].includes(method)) throw bad(`method ${method}`);
  const params = {};
  if (uploadId != null) params.uploadId = String(uploadId);
  if (partNumber != null) params.partNumber = String(partNumber);
  if (method === "POST" && uploadId == null) params.uploads = "";
  return { url: await presign(env, method, key, params), ...(creating ? { key } : {}) };
}

async function soniox(env, method, path, body) {
  const res = await fetch(SONIOX + path, {
    method,
    headers: { Authorization: `Bearer ${env.SONIOX_API_KEY}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let said = text.slice(0, 300);
    try { said = JSON.parse(text).message || said; } catch {}
    const err = new Error(`Soniox: ${said}`);
    throw Object.assign(err, { status: res.status >= 500 ? 502 : res.status });   // its 4xx: the job is gone for good
  }
  return res.status === 204 ? null : res.json();
}

async function start(env, { key }) {
  if (!KEY.test(key || "")) throw bad("not an upload of this page");
  const t = await soniox(env, "POST", "/transcriptions", {
    model: "stt-async-v6",
    audio_url: await presign(env, "GET", key, {}, 6 * 3600),   // Soniox fetches it when the job starts
    language_hints: ["zh", "en"],
    enable_speaker_diarization: true,
    enable_language_identification: true,
    context: CONTEXT,
  });
  return { id: t.id };
}

async function poll(env, id, key) {
  if (!KEY.test(key || "")) throw bad("not an upload of this page");
  const t = await soniox(env, "GET", `/transcriptions/${id}`).catch((e) => {
    if (e.status === 400 || e.status === 404) throw Object.assign(new Error("Soniox 搵唔到呢個轉寫：可能已經喺另一個視窗讀咗"), { status: 410 });
    throw e;
  });
  if (t.status === "queued" || t.status === "processing") return { status: t.status };
  let out;
  if (t.status === "completed") {
    const { tokens } = await soniox(env, "GET", `/transcriptions/${id}/transcript`);
    out = { status: "completed", ...toRows(tokens, toHK), duration_ms: t.audio_duration_ms ?? tokens.at(-1)?.end_ms ?? 0 };
  } else {
    out = { status: "error", message: t.error_message || `Soniox: ${t.status}` };
  }
  await Promise.allSettled([
    soniox(env, "DELETE", `/transcriptions/${id}`),
    fetch(await presign(env, "DELETE", key), { method: "DELETE" }),
  ]);
  return out;
}

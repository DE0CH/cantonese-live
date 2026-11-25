// The /file page: pick a recording, Uppy uploads it straight to R2 (URLs signed by the Worker), then the Worker has
// Soniox transcribe it and the rows are shown. The page remembers the job (and then its result) in localStorage, so
// a reload or a phone that slept carries on where it was; 「再轉一個」 forgets it.
import Uppy from "@uppy/core";
import Dashboard from "@uppy/dashboard";
import AwsS3 from "@uppy/aws-s3";
import zh_TW from "@uppy/locales/lib/zh_TW.js";

const STORE = "cantonese-file";
const POLL_MS = 3000;
const $ = (id) => document.getElementById(id);

const strings = {
  dropPasteFiles: "將錄音或影片拖到呢度，或者 %{browseFiles}",
  dropPasteImportFiles: "將錄音或影片拖到呢度，或者 %{browseFiles}",
  browseFiles: "揀檔案",
};

const uppy = new Uppy({
  restrictions: { maxNumberOfFiles: 1, allowedFileTypes: ["video/*", "audio/*"] },
  autoProceed: true,
  locale: { strings: { ...zh_TW.strings, ...strings }, pluralize: zh_TW.pluralize },
})
  .use(Dashboard, {
    target: "#pick", inline: true, width: "100%", height: 340, proudlyDisplayPoweredByUppy: false,
    showProgressDetails: true, note: "影片或錄音，最長 300 分鐘",
  })
  .use(AwsS3, {
    shouldUseMultipart: (file) => file.size > 20 * 1024 * 1024,
    getChunkSize: () => 10 * 1024 * 1024,
    signRequest: (req) => api("POST", "/api/file/sign", req),
  });

uppy.on("upload-success", (file, res) => {
  const key = res?.body?.key ?? file.s3Multipart?.key;
  startJob({ name: file.name, size: file.size, key });
});

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ status: "error", message: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(data.message || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function save(state) { state ? localStorage.setItem(STORE, JSON.stringify(state)) : localStorage.removeItem(STORE); }
function load() { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } }

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

function size(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function show(which) {
  $("pick").hidden = which !== "pick";
  $("job").hidden = which !== "job";
  $("result").hidden = which !== "result";
  $("again").hidden = which === "pick";
}

let timer = null;

async function startJob(job) {
  show("job");
  $("job-name").textContent = job.name;
  $("job-size").textContent = size(job.size);
  status("info", "準備緊");
  try {
    const { id } = await api("POST", "/api/file/transcribe", { key: job.key });
    job = { ...job, id, started: Date.now() };
    save({ job });
    follow(job);
  } catch (e) { fail(e.message); }
}

function follow(job) {
  show("job");
  $("job-name").textContent = job.name;
  $("job-size").textContent = size(job.size);
  status("info", "轉寫中");
  const tick = () => { $("job-time").textContent = clock(Date.now() - job.started); };
  tick();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
  const poll = async () => {
    if (load()?.job?.id !== job.id) return;          // 「再轉一個」 was pressed meanwhile
    try {
      const r = await api("GET", `/api/file/transcribe/${job.id}?key=${encodeURIComponent(job.key)}`);
      if (r.status === "completed") {
        const result = { name: job.name, duration_ms: r.duration_ms, rows: r.rows, speakers: r.speakers };
        save({ result });
        return render(result);
      }
      if (r.status === "error") return fail(r.message);
      status("info", r.status === "queued" ? "排緊隊" : "轉寫中");
    } catch (e) {
      if (e.status >= 400 && e.status < 500) return fail(e.message);   // asking again gets the same answer
      status("info", "轉寫中，連唔到伺服器，再試緊");
    }
    setTimeout(poll, POLL_MS);
  };
  poll();
}

function status(kind, word) {
  const el = $("job-status");
  el.className = kind === "bad" ? "status bad" : "status";
  el.firstElementChild.outerHTML = kind === "bad"
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M6 6l12 12M18 6L6 18"/></svg>'
    : '<span class="sq"></span>';
  $("job-word").textContent = word;
}

function fail(message) {
  clearInterval(timer);
  $("job-time").textContent = "";
  status("bad", `轉唔到：${message}`);
  save(null);
  $("again").hidden = false;
}

function render({ name, duration_ms, rows, speakers }) {
  clearInterval(timer);
  show("result");
  $("res-name").textContent = name;
  $("res-len").textContent = clock(duration_ms);
  const list = $("rows");
  list.replaceChildren();
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "聽唔到有人講嘢。";
    list.append(li);
  }
  let last;
  for (const r of rows) {
    const li = document.createElement("li");
    const ts = Object.assign(document.createElement("span"), { className: "ts", textContent: clock(r.start_ms) });
    li.append(ts);
    if (speakers > 1 && r.speaker !== last) {
      li.append(Object.assign(document.createElement("span"), { className: "who", textContent: `講者 ${r.speaker}` }));
    }
    li.append(Object.assign(document.createElement("span"), { className: "tx", textContent: r.text }));
    last = r.speaker;
    list.append(li);
  }
}

$("again-btn").addEventListener("click", () => {
  save(null);
  clearInterval(timer);
  uppy.clear();
  show("pick");
});

const saved = load();
if (saved?.result) render(saved.result);
else if (saved?.job) follow(saved.job);
else show("pick");

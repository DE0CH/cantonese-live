// Soniox's async transcript (a list of tokens) → the rows the /file page shows: one row per sentence, each with its
// start time and speaker. A row ends where a sentence ends or the speaker changes; nothing else splits text.

const SENTENCE_END = /[。！？!?]$|^\.$/;

/** tokens: [{text, start_ms, speaker?}] → {rows: [{start_ms, speaker, text}], speakers: number} */
export function toRows(tokens, convert = (s) => s) {
  const rows = [];
  let cur = null;   // the open row; null after a sentence ends
  for (const t of tokens) {
    const speaker = t.speaker ?? null;
    if (!t.text.trim() && (!cur || speaker !== cur.speaker)) continue;   // a row starts at its first word
    if (!cur || speaker !== cur.speaker) cur = push(rows, t, speaker);
    cur.text += t.text;
    if (SENTENCE_END.test(t.text.trim())) cur = null;
  }
  const out = rows.map((r) => ({ ...r, text: convert(r.text.trim()) })).filter((r) => r.text);
  return { rows: out, speakers: new Set(out.map((r) => r.speaker).filter((s) => s != null)).size };
}

function push(rows, t, speaker) {
  const row = { start_ms: t.start_ms, speaker, text: "" };
  rows.push(row);
  return row;
}

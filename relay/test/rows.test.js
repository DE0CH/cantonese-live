import { test } from "node:test";
import assert from "node:assert/strict";
import { toRows } from "../src/rows.js";

const tok = (text, start_ms, speaker = "1") => ({ text, start_ms, speaker });

test("a sentence end starts a new row at its first word, not at the space before it", () => {
  // Soniox's answer for testdata/cantonese-16k.wav (abridged)
  const tokens = [tok("我", 390), tok("们", 570), tok("饮", 810), tok("茶", 930), tok("。", 1100), tok(" ", 4530),
    tok("佢", 4770), tok("话", 5070), tok("嚟", 6390), tok("。", 7050)];
  assert.deepEqual(toRows(tokens), {
    rows: [{ start_ms: 390, speaker: "1", text: "我们饮茶。" }, { start_ms: 4770, speaker: "1", text: "佢话嚟。" }],
    speakers: 1,
  });
});

test("a change of speaker ends a row mid-sentence", () => {
  const tokens = [tok("你", 0, "1"), tok("好", 200, "1"), tok("係", 500, "2"), tok("呀", 700, "2"), tok("？", 800, "2")];
  const { rows, speakers } = toRows(tokens);
  assert.deepEqual(rows.map((r) => [r.speaker, r.text, r.start_ms]), [["1", "你好", 0], ["2", "係呀？", 500]]);
  assert.equal(speakers, 2);
});

test("English sentences end at a full stop token; the text is converted per row", () => {
  const tokens = [tok("I", 0), tok(" study", 100), tok(" at", 200), tok(" Oxford", 300), tok(".", 400), tok(" 们", 600)];
  const { rows } = toRows(tokens, (s) => s.replace("们", "們"));
  assert.deepEqual(rows.map((r) => r.text), ["I study at Oxford.", "們"]);
});

test("no tokens, no rows", () => {
  assert.deepEqual(toRows([]), { rows: [], speakers: 0 });
});

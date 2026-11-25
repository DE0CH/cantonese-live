import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const pages = { "/": "live", "/file": "file", "/404": "not found" };
const env = { ASSETS: { fetch: async (req) => {
  const path = new URL(req.url ?? req).pathname;
  return path in pages ? new Response(pages[path]) : new Response(null, { status: 404 });
} } };
const get = (path) => worker.fetch(new Request(`https://cantonese.deyaochen.com${path}`), env);

test("the names people type for the file page lead to it", async () => {
  for (const path of ["/files", "/files/", "/Files", "/FILE"]) {
    const res = await get(path);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get("Location"), "https://cantonese.deyaochen.com/file", path);
  }
});

test("an address with no page answers 404 with the not-found page, never an empty body", async () => {
  for (const path of ["/filesx", "/nope", "/file/x"]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), "not found", path);
  }
});

test("a page that exists is the assets' answer", async () => {
  assert.equal(await (await get("/")).text(), "live");
});

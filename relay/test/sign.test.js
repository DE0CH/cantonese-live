import { test } from "node:test";
import assert from "node:assert/strict";
import { sign } from "../src/file.js";

const env = { R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "b", R2_ENDPOINT: "https://acct.r2.example" };

test("a new upload gets a key the Worker picks, whatever the page asked for", async () => {
  for (const req of [{ method: "PUT", key: "../etc/x" }, { method: "POST", key: "mine.mp4" }]) {
    const { url, key } = await sign(env, req);
    assert.match(key, /^in\/[0-9a-f-]{36}$/);
    const u = new URL(url);
    assert.equal(u.pathname, `/b/${key}`);
    assert.equal(u.searchParams.has("uploads"), req.method === "POST");
    assert.ok(u.searchParams.get("X-Amz-Signature"));
    assert.equal(u.searchParams.get("X-Amz-Expires"), "3600");
  }
});

test("a later step must name one of the Worker's keys and carries its upload id and part", async () => {
  const key = "in/123e4567-e89b-42d3-a456-426614174000";
  const { url, key: none } = await sign(env, { method: "PUT", key, uploadId: "U1", partNumber: 3 });
  assert.equal(none, undefined);
  const u = new URL(url);
  assert.equal(u.searchParams.get("uploadId"), "U1");
  assert.equal(u.searchParams.get("partNumber"), "3");
  await assert.rejects(sign(env, { method: "GET", key: "other/thing", uploadId: "U1" }), /not an upload of this page/);
  await assert.rejects(sign(env, { method: "DELETE", key: "in/../../x", uploadId: "U1" }), /not an upload of this page/);
});

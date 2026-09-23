import test from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./helpers.js";

test("健康检查返回 ok", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok" });
});

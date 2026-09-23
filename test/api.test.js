import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.js";

const t1 = "2026-05-01 08:00:00";
const t2 = "2026-05-02 08:00:00";

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ledger-api-"));
  const app = await buildApp(join(dir, "api.db"));
  return app;
}

test("HTTP 全链路：导入→扫描→双方确认→重建/发布/下钻/差异→投递", async () => {
  const app = await setup();

  const post = (url, body) => app.inject({ method: "POST", url, payload: body });
  const get = (url) => app.inject({ method: "GET", url });

  assert.equal((await get("/health")).statusCode, 200);

  for (const id of ["uni-a", "uni-b", "uni-c"]) {
    const r = await post("/institutions", { id, name: id });
    assert.equal(r.statusCode, 201);
  }

  const batchA = await post("/batches", {
    institutionId: "uni-a", sourceKind: "repository", externalBatchRef: "ba",
    harvestedAt: t1, recordedAt: t1,
    records: [{
      externalRef: "rec-1",
      payload: {
        kind: "work", externalRef: "rec-1", title: "开放科学政策评估",
        workType: "report", validFrom: t1,
        identifiers: [{ type: "handle", value: "a/rec-1" }],
        authors: [{ externalRef: "au-1", displayName: "李明", ordinal: 0 }],
      },
    }],
  });
  assert.equal(batchA.statusCode, 201);

  const batchB = await post("/batches", {
    institutionId: "uni-b", sourceKind: "journal", externalBatchRef: "bb",
    harvestedAt: t2, recordedAt: t2,
    records: [{
      externalRef: "rec-2",
      payload: {
        kind: "work", externalRef: "rec-2", title: "开放科学政策评估（终稿）",
        workType: "article", validFrom: t2,
        identifiers: [{ type: "handle", value: "a/rec-1" }],
        authors: [],
      },
    }],
  });
  assert.equal(batchB.statusCode, 201);

  const scan = await post("/candidates/scan", {});
  assert.equal(scan.statusCode, 200);
  const cand = scan.json();
  assert.equal(cand.created.length, 1);
  assert.ok(cand.candidates[0].evidence.signals.some((s) => s.kind === "shared_identifier"));

  const cid = cand.created[0];
  // 尚待双方确认时，无关机构无权介入
  const outsider = await post(`/candidates/${cid}/decisions`, { institutionId: "uni-c", decision: "merge" });
  assert.equal(outsider.statusCode, 403, "非事实提供机构不能参与确认");

  let r = await post(`/candidates/${cid}/decisions`, { institutionId: "uni-a", decision: "merge", at: t2 });
  assert.equal(r.json().status, "pending", "单方确认不生效");
  r = await post(`/candidates/${cid}/decisions`, { institutionId: "uni-b", decision: "merge", at: t2 });
  assert.equal(r.json().status, "confirmed_merged");

  // 已定案候选不能再决定
  const decidedAgain = await post(`/candidates/${cid}/decisions`, { institutionId: "uni-a", decision: "merge" });
  assert.equal(decidedAgain.statusCode, 409);

  const rebuilt = (await get(`/snapshots/rebuild?asOf=${encodeURIComponent(t2)}`)).json();
  assert.equal(rebuilt.totals.visible, 1);

  const pub = (await post("/snapshots", { asOf: t2, label: "结项", createdBy: "科研处" })).json();
  assert.equal(pub.totals.visible, 1);
  const detail = (await get(`/snapshots/${pub.id}/items/${pub.items[0].work_id}/explain`)).json();
  assert.ok(detail.adoptedVersion.payload);
  assert.equal(detail.merges[0].confirmations.length, 2);

  const diff = (await get(`/snapshots/diff?a=${encodeURIComponent(t1)}&b=${encodeURIComponent(t2)}`)).json();
  assert.equal(diff.b.asOf, t2);
  assert.ok(Array.isArray(diff.changes));

  await post("/downstream-targets", { id: "dash", name: "看板", driver: "log" });
  const delivery = (await post("/downstream-targets/dash/deliver", {})).json();
  assert.ok(delivery.sent >= 1);
  const inbox = (await get("/downstream-targets/dash/inbox")).json();
  assert.ok(inbox.inbox.length >= 1);

  await app.close();
});

test("不存在的资源返回 404", async () => {
  const app = await setup();
  assert.equal((await app.inject({ method: "GET", url: "/works/999" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/snapshots/999" })).statusCode, 404);
  await app.close();
});

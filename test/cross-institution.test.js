import test from "node:test";
import assert from "node:assert/strict";
import { addInstitution, auth, makeApp, openBatch, postRecord } from "./helpers.js";

async function setupCrossPair(app) {
  await addInstitution(app, "inst-a");
  await addInstitution(app, "inst-b");
  await addInstitution(app, "inst-c");
  const batchA = await openBatch(app, "inst-a");
  const a = (await postRecord(app, "inst-a", batchA, "a-1", {
    title: "城市热岛效应的遥感评估方法", authors: ["周明"], identifiers: { doi: "10.9000/a.1" },
  })).json();
  const batchB = await openBatch(app, "inst-b", "journal_platform");
  const b = (await postRecord(app, "inst-b", batchB, "b-1", {
    title: "城市热岛效应遥感评估方法", authors: ["周明"], identifiers: { pmid: "12345" },
  })).json();
  const cand = (await app.inject({ method: "GET", url: "/duplicate-candidates?status=pending" })).json()[0];
  return { a, b, cand };
}

test("跨机构归并须双方确认后生效", async () => {
  const { app, setNow } = makeApp("2026-01-05T09:00:00.000Z");
  const { a, b, cand } = await setupCrossPair(app);
  assert.ok(cand);

  // 无关机构不能决议
  const outsider = await app.inject({
    method: "POST",
    url: `/duplicate-candidates/${cand.id}/decisions`,
    headers: auth("inst-c"),
    payload: { decision: "merge", target_work_id: b.work_id, reason: "越权尝试" },
  });
  assert.equal(outsider.statusCode, 403);

  // inst-b 发起合并：进入待确认，需双方
  setNow("2026-01-06T09:00:00.000Z");
  const dec = (await app.inject({
    method: "POST",
    url: `/duplicate-candidates/${cand.id}/decisions`,
    headers: auth("inst-b"),
    payload: { decision: "merge", target_work_id: b.work_id, reason: "同一论文的不同来源记录" },
  })).json();
  assert.equal(dec.status, "pending_confirmations");
  assert.deepEqual([...dec.required_institutions].sort(), ["inst-a", "inst-b"]);
  assert.equal(dec.confirmations.length, 1);
  assert.equal(dec.confirmations[0].institution_id, "inst-b");

  // 双方确认完成前仍各自计数
  const before = (await app.inject({ method: "POST", url: "/snapshots/rebuild", payload: { cutoff_at: "2026-01-31T00:00:00.000Z" } })).json();
  assert.equal(before.metrics.included, 2);

  // 无关机构不能确认；发起方不能重复确认
  const bad = await app.inject({ method: "POST", url: `/merge-decisions/${dec.id}/confirm`, headers: auth("inst-c"), payload: {} });
  assert.equal(bad.statusCode, 403);
  const dup = await app.inject({ method: "POST", url: `/merge-decisions/${dec.id}/confirm`, headers: auth("inst-b"), payload: {} });
  assert.equal(dup.statusCode, 409);

  // inst-a 确认后生效
  setNow("2026-01-07T09:00:00.000Z");
  const done = (await app.inject({
    method: "POST",
    url: `/merge-decisions/${dec.id}/confirm`,
    headers: auth("inst-a"),
    payload: { decided_by: "张老师" },
  })).json();
  assert.equal(done.status, "applied");
  assert.equal(done.confirmations.length, 2);

  const after = (await app.inject({ method: "POST", url: "/snapshots/rebuild", payload: { cutoff_at: "2026-01-31T00:00:00.000Z" } })).json();
  assert.equal(after.metrics.included, 1);
  assert.equal(after.metrics.excluded_by_reason.merged_duplicate, 1);
});

test("机构只能修订自己提供的事实", async () => {
  const { app } = makeApp();
  const { a, b } = await setupCrossPair(app);

  // 冒用他机构的来源记录 → 拒绝
  const stolen = await app.inject({
    method: "POST",
    url: `/works/${a.work_id}/versions`,
    headers: auth("inst-b"),
    payload: { source_record_id: a.record_id, change_reason: "correction", changes: { title: "被篡改的标题" } },
  });
  assert.equal(stolen.statusCode, 403);
  assert.equal(stolen.json().error.code, "fact_ownership");

  // 本机构记录但未关联到该成果 → 拒绝
  const unrelated = await app.inject({
    method: "POST",
    url: `/works/${a.work_id}/versions`,
    headers: auth("inst-b"),
    payload: { source_record_id: b.record_id, change_reason: "correction", changes: { title: "无关修订" } },
  });
  assert.equal(unrelated.statusCode, 403);

  // 本机构记录经共享标识关联到该成果 → 允许修订
  const batchB2 = await openBatch(app, "inst-b", "author_self_report");
  const linked = (await postRecord(app, "inst-b", batchB2, "b-2", {
    title: "城市热岛效应的遥感评估方法", authors: ["周明"], identifiers: { doi: "10.9000/a.1" },
  })).json();
  assert.equal(linked.work_id, a.work_id); // 精确标识自动关联
  const ok = await app.inject({
    method: "POST",
    url: `/works/${a.work_id}/versions`,
    headers: auth("inst-b"),
    payload: { source_record_id: linked.record_id, change_reason: "correction", changes: { title: "城市热岛效应的遥感评估方法（修订）" } },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().recorded_by, "inst-b");
});

import test from "node:test";
import assert from "node:assert/strict";
import { addInstitution, makeApp, openBatch, postRecord } from "./helpers.js";

const PAPER = {
  title: "深度学习模型压缩方法",
  authors: ["张伟", "王芳"],
  identifiers: { doi: "10.1000/j.xyz.1" },
  type: "article",
};

test("批次与来源记录完整保存，可回查原始载荷", async () => {
  const { app } = makeApp();
  await addInstitution(app, "inst-a");
  const batch = await openBatch(app, "inst-a");
  const res = await postRecord(app, "inst-a", batch, "ext-1", PAPER);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.created_work, true);
  assert.equal(body.version.version_no, 1);
  assert.equal(body.version.change_reason, "ingest");

  const got = (await app.inject({ method: "GET", url: `/batches/${batch}` })).json();
  assert.equal(got.records.length, 1);
  assert.equal(got.records[0].matched_work_id, body.work_id);
  assert.ok(got.records[0].record_hash);

  const rec = (await app.inject({ method: "GET", url: `/records/${body.record_id}` })).json();
  assert.deepEqual(rec.payload, PAPER); // 原始载荷原样保存
  assert.equal(rec.institution_id, "inst-a");
});

test("同批次重复 external_id 被拒绝", async () => {
  const { app } = makeApp();
  await addInstitution(app, "inst-a");
  const batch = await openBatch(app, "inst-a");
  const first = await postRecord(app, "inst-a", batch, "ext-1", PAPER);
  assert.equal(first.statusCode, 200);
  const dup = await postRecord(app, "inst-a", batch, "ext-1", PAPER);
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error.code, "duplicate_record");
});

test("下一批次重复投递不产生重复成果；标题改写形成新版本", async () => {
  const { app, setNow } = makeApp("2026-01-05T09:00:00.000Z");
  await addInstitution(app, "inst-a");
  const b1 = await openBatch(app, "inst-a");
  const r1 = (await postRecord(app, "inst-a", b1, "ext-1", PAPER)).json();

  setNow("2026-02-05T09:00:00.000Z");
  const b2 = await openBatch(app, "inst-a");
  const r2 = (await postRecord(app, "inst-a", b2, "ext-1", PAPER)).json();
  assert.equal(r2.work_id, r1.work_id); // 同一 DOI 关联同一成果
  assert.equal(r2.created_work, false);
  let versions = (await app.inject({ method: "GET", url: `/works/${r1.work_id}/versions` })).json();
  assert.equal(versions.length, 1); // 内容相同不新增版本

  const r3 = (await postRecord(app, "inst-a", b2, "ext-2", { ...PAPER, title: "深度学习模型压缩方法（修订版）" })).json();
  assert.equal(r3.work_id, r1.work_id);
  assert.equal(r3.version.version_no, 2);
  assert.equal(r3.version.change_reason, "correction");
  versions = (await app.inject({ method: "GET", url: `/works/${r1.work_id}/versions` })).json();
  assert.equal(versions.length, 2);
  assert.equal(versions[0].title, PAPER.title); // 历史版本保留
});

test("撤回与恢复都形成新版本", async () => {
  const { app, setNow } = makeApp("2026-01-05T09:00:00.000Z");
  await addInstitution(app, "inst-a");
  const batch = await openBatch(app, "inst-a", "journal_platform");
  const r1 = (await postRecord(app, "inst-a", batch, "p-1", PAPER)).json();

  setNow("2026-01-10T09:00:00.000Z");
  const r2 = (await postRecord(app, "inst-a", batch, "p-2", { ...PAPER, status: "retracted" })).json();
  assert.equal(r2.version.change_reason, "retraction");
  assert.equal(r2.version.status, "retracted");

  setNow("2026-01-20T09:00:00.000Z");
  const r3 = (await postRecord(app, "inst-a", batch, "p-3", PAPER)).json();
  assert.equal(r3.version.change_reason, "restoration");
  assert.equal(r3.version.status, "active");

  const versions = (await app.inject({ method: "GET", url: `/works/${r1.work_id}/versions` })).json();
  assert.deepEqual(versions.map((v) => v.change_reason), ["ingest", "retraction", "restoration"]);
});

test("缺少机构身份或写入他机构批次被拒绝", async () => {
  const { app } = makeApp();
  await addInstitution(app, "inst-a");
  await addInstitution(app, "inst-b");
  const batch = await openBatch(app, "inst-a");
  const noAuth = await app.inject({ method: "POST", url: `/batches/${batch}/records`, payload: { external_id: "x", payload: PAPER } });
  assert.equal(noAuth.statusCode, 401);
  const wrong = await postRecord(app, "inst-b", batch, "x", PAPER);
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().error.code, "batch_ownership");
});

import test from "node:test";
import assert from "node:assert/strict";
import { addInstitution, makeApp, openBatch, postRecord } from "./helpers.js";

const W1 = { title: "钙钛矿太阳能电池的稳定性研究", authors: ["陈伟"], identifiers: { doi: "10.1000/s.1" } };
const W2 = { title: "青藏高原冻土碳排放观测", authors: ["刘洋"], identifiers: { doi: "10.1000/s.2" } };
const W3 = { title: "古籍数字化语料构建", authors: ["孙丽"], identifiers: { doi: "10.1000/s.3" }, open_access: false };

async function seed(app) {
  await addInstitution(app, "inst-a");
  const batch = await openBatch(app, "inst-a");
  const w1 = (await postRecord(app, "inst-a", batch, "r-1", W1)).json();
  const w2 = (await postRecord(app, "inst-a", batch, "r-2", W2)).json();
  const w3 = (await postRecord(app, "inst-a", batch, "r-3", W3)).json();
  return { w1, w2, w3 };
}

test("发布快照不可抹改，下钻可见采用版本与排除理由", async () => {
  const { app } = makeApp("2026-01-10T09:00:00.000Z");
  const { w1, w3 } = await seed(app);

  const snap = (await app.inject({ method: "POST", url: "/snapshots", payload: { cutoff_at: "2026-01-31T00:00:00.000Z" } })).json();
  assert.equal(snap.kind, "published");
  assert.equal(snap.metrics.included, 2);
  assert.equal(snap.metrics.excluded, 1);
  assert.equal(snap.metrics.excluded_by_reason.not_open_access, 1);
  assert.equal(snap.metrics.included_by_institution["inst-a"], 2);

  const excluded = (await app.inject({ method: "GET", url: `/snapshots/${snap.id}/entries?included=0` })).json();
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].work_id, w3.work_id);
  assert.equal(excluded[0].exclusion_reason, "not_open_access");
  assert.ok(excluded[0].work_version_id); // 采用的版本可下钻

  const w1Entry = (await app.inject({ method: "GET", url: `/snapshots/${snap.id}/entries?work_id=${w1.work_id}` })).json()[0];
  assert.equal(w1Entry.included, 1);

  // 同一截止时间不能重复发布：已发布统计不可抹改
  const again = await app.inject({ method: "POST", url: "/snapshots", payload: { cutoff_at: "2026-01-31T00:00:00.000Z" } });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.code, "snapshot_exists");
});

test("按任意截止时间重建快照，后续更正形成可比较的差异", async () => {
  const { app, setNow } = makeApp("2026-01-10T09:00:00.000Z");
  const { w1 } = await seed(app);

  // 1 月 20 日发布 1 月 31 日截止的快照
  setNow("2026-01-20T09:00:00.000Z");
  const published = (await app.inject({ method: "POST", url: "/snapshots", payload: { cutoff_at: "2026-01-31T00:00:00.000Z" } })).json();
  assert.equal(published.metrics.included, 2);

  // 2 月 5 日：迟到的撤回通知（生效于 1 月 25 日）与一条即时更正
  setNow("2026-02-05T09:00:00.000Z");
  const batch2 = await openBatch(app, "inst-a", "journal_platform");
  const ret = (await postRecord(app, "inst-a", batch2, "retract-1", { ...W1, status: "retracted", effective_at: "2026-01-25T00:00:00.000Z" })).json();
  assert.equal(ret.version.change_reason, "retraction");
  await postRecord(app, "inst-a", batch2, "corr-1", { ...W2, title: "青藏高原冻土碳排放观测（增订）" });

  // 已发布快照保持原样
  const frozen = (await app.inject({ method: "GET", url: `/snapshots/${published.id}` })).json();
  assert.equal(frozen.metrics.included, 2);

  // 以当前知识重建同一截止时间：撤回生效；截止后生效的更正在 1 月视图中不可见
  const rebuilt = (await app.inject({ method: "POST", url: "/snapshots/rebuild", payload: { cutoff_at: "2026-01-31T00:00:00.000Z" } })).json();
  assert.equal(rebuilt.kind, "rebuilt");
  assert.equal(rebuilt.published_snapshot_id, published.id);
  assert.equal(rebuilt.metrics.included, 1);
  assert.equal(rebuilt.metrics.excluded_by_reason.retracted, 1);

  // 差异比较：W1 由计入变为撤回排除，并给出原因链
  const diff = (await app.inject({ method: "GET", url: `/snapshots/diff?from=${published.id}&to=${rebuilt.id}` })).json();
  assert.equal(diff.metrics_delta.included.delta, -1);
  assert.equal(diff.items.length, 1);
  const item = diff.items[0];
  assert.equal(item.work_id, w1.work_id);
  assert.equal(item.change, "changed");
  assert.equal(item.from.included, true);
  assert.equal(item.to.included, false);
  assert.equal(item.to.exclusion_reason, "retracted");
  assert.ok(item.causes.some((c) => c.type === "version" && c.detail.includes("retraction")));

  // 任意截止时间：撤回生效前 W1 计入；首批摄入前账簿为空
  const early = (await app.inject({ method: "POST", url: "/snapshots/rebuild", payload: { cutoff_at: "2026-01-15T00:00:00.000Z" } })).json();
  assert.equal(early.metrics.included, 2);
  const empty = (await app.inject({ method: "POST", url: "/snapshots/rebuild", payload: { cutoff_at: "2026-01-01T00:00:00.000Z" } })).json();
  assert.equal(empty.metrics.works_total, 0);
});

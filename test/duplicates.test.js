import test from "node:test";
import assert from "node:assert/strict";
import { addInstitution, auth, makeApp, openBatch, postRecord } from "./helpers.js";

const PREPRINT = {
  title: "量子纠错码的代数构造",
  authors: ["李雷"],
  identifiers: { preprint_doi: "10.5555/pre.1" },
  type: "preprint",
};
const PUBLISHED = {
  title: "量子纠错码的代数构造方法",
  authors: ["李雷"],
  identifiers: { doi: "10.6666/j.1" },
  type: "article",
};

async function setupPair(app) {
  await addInstitution(app, "inst-a");
  const batch = await openBatch(app, "inst-a");
  const pre = (await postRecord(app, "inst-a", batch, "r-1", PREPRINT)).json();
  const pub = (await postRecord(app, "inst-a", batch, "r-2", PUBLISHED)).json();
  return { pre, pub };
}

test("预印本转正式发表产生候选重复并给出匹配依据", async () => {
  const { app } = makeApp();
  const { pre, pub } = await setupPair(app);
  assert.notEqual(pre.work_id, pub.work_id);

  const list = (await app.inject({ method: "GET", url: "/duplicate-candidates?status=pending" })).json();
  assert.equal(list.length, 1);
  const cand = list[0];
  assert.ok(cand.score >= 0.5);
  const rules = cand.evidence.map((e) => e.rule);
  assert.ok(rules.includes("title_similar") || rules.includes("title_near_exact"));
  assert.ok(rules.includes("authors_match"));

  const detail = (await app.inject({ method: "GET", url: `/duplicate-candidates/${cand.id}` })).json();
  assert.ok(detail.evidence.every((e) => e.rule && e.detail)); // 每条依据都可读
  assert.deepEqual(detail.work_a.owners, ["inst-a"]);
});

test("人工确认合并：目标保留历史，来源排除并注明理由，标识重定向", async () => {
  const { app, setNow } = makeApp("2026-01-05T09:00:00.000Z");
  const { pre, pub } = await setupPair(app);
  const cand = (await app.inject({ method: "GET", url: "/duplicate-candidates?status=pending" })).json()[0];

  setNow("2026-01-06T09:00:00.000Z");
  const dec = (await app.inject({
    method: "POST",
    url: `/duplicate-candidates/${cand.id}/decisions`,
    headers: auth("inst-a"),
    payload: { decision: "merge", target_work_id: pub.work_id, reason: "预印本已被正式发表取代" },
  })).json();
  assert.equal(dec.status, "applied"); // 同一机构即时生效

  const preWork = (await app.inject({ method: "GET", url: `/works/${pre.work_id}` })).json();
  assert.equal(preWork.merged_into_work_id, pub.work_id);

  const pubVersions = (await app.inject({ method: "GET", url: `/works/${pub.work_id}/versions` })).json();
  assert.equal(pubVersions.at(-1).change_reason, "merge");
  assert.equal(pubVersions.at(-1).identifiers.preprint_doi, "10.5555/pre.1"); // 标识并集

  const resolved = (await app.inject({ method: "GET", url: "/mappings/resolve?scheme=preprint_doi&identifier=10.5555/pre.1" })).json();
  assert.equal(resolved.subject_id, pub.work_id); // 预印本 DOI 重定向到正式成果

  const snap = (await app.inject({ method: "POST", url: "/snapshots", payload: { cutoff_at: "2026-01-31T00:00:00.000Z" } })).json();
  assert.equal(snap.metrics.included, 1);
  assert.equal(snap.metrics.excluded_by_reason.merged_duplicate, 1);
  const entries = (await app.inject({ method: "GET", url: `/snapshots/${snap.id}/entries?included=0` })).json();
  assert.equal(entries[0].work_id, pre.work_id);
  assert.equal(entries[0].exclusion_reason, "merged_duplicate");
  assert.ok(entries[0].work_version_id); // 下钻可见采用的版本
});

test("人工确认拆分：双方保留且候选不被重开", async () => {
  const { app, setNow } = makeApp("2026-01-05T09:00:00.000Z");
  await addInstitution(app, "inst-a");
  const batch = await openBatch(app, "inst-a");
  await postRecord(app, "inst-a", batch, "r-1", {
    title: "基于图神经网络的交通预测", authors: ["王芳"], identifiers: { doi: "10.7000/a.1" },
  });
  await postRecord(app, "inst-a", batch, "r-2", {
    title: "基于图神经网络的电力负荷预测", authors: ["王芳"], identifiers: { doi: "10.7000/a.2" },
  });
  const cand = (await app.inject({ method: "GET", url: "/duplicate-candidates?status=pending" })).json()[0];
  assert.ok(cand);

  const dec = (await app.inject({
    method: "POST",
    url: `/duplicate-candidates/${cand.id}/decisions`,
    headers: auth("inst-a"),
    payload: { decision: "split", reason: "研究对象不同，非同一成果" },
  })).json();
  assert.equal(dec.status, "applied");
  assert.equal((await app.inject({ method: "GET", url: `/duplicate-candidates/${cand.id}` })).json().status, "split");

  // 后续批次重复投递不再重开已决议候选
  setNow("2026-02-05T09:00:00.000Z");
  const batch2 = await openBatch(app, "inst-a");
  await postRecord(app, "inst-a", batch2, "r-1", {
    title: "基于图神经网络的交通预测", authors: ["王芳"], identifiers: { doi: "10.7000/a.1" },
  });
  const all = (await app.inject({ method: "GET", url: "/duplicate-candidates?status=all" })).json();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "split");

  const snap = (await app.inject({ method: "POST", url: "/snapshots", payload: { cutoff_at: "2026-02-28T00:00:00.000Z" } })).json();
  assert.equal(snap.metrics.included, 2); // 拆分后双方各自计数
});

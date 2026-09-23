import test from "node:test";
import assert from "node:assert/strict";
import { addInstitution, makeApp, openBatch, postRecord } from "./helpers.js";

async function statsMap(app) {
  const rows = (await app.inject({ method: "GET", url: "/downstream-stats" })).json();
  return Object.fromEntries(rows.map((r) => [`${r.target}:${r.metric}`, r.value]));
}

test("下游更新幂等应用，失败恢复后不重复计数", async () => {
  const { app, setNow } = makeApp("2026-01-10T09:00:00.000Z");
  await addInstitution(app, "inst-a");
  const batch = await openBatch(app, "inst-a");
  await postRecord(app, "inst-a", batch, "r-1", { title: "论文甲", identifiers: { doi: "10.1/a" } });
  await postRecord(app, "inst-a", batch, "r-2", { title: "论文乙", identifiers: { doi: "10.1/b" } });

  const snap1 = (await app.inject({ method: "POST", url: "/snapshots", payload: { cutoff_at: "2026-01-31T00:00:00.000Z" } })).json();
  assert.equal(snap1.metrics.included, 2);
  const [u1] = (await app.inject({ method: "GET", url: "/downstream-updates?status=pending" })).json();
  assert.ok(u1.idempotency_key.includes(snap1.id));

  // 应用成功 → 计数一次；重复应用不再计数
  const applied = (await app.inject({ method: "POST", url: `/downstream-updates/${u1.id}/apply` })).json();
  assert.equal(applied.update.status, "applied");
  assert.deepEqual(await statsMap(app), { "visibility_report:excluded": 0, "visibility_report:included": 2 });
  const again = (await app.inject({ method: "POST", url: `/downstream-updates/${u1.id}/apply` })).json();
  assert.equal(again.already_applied, true);
  assert.equal((await statsMap(app))["visibility_report:included"], 2);

  // 第二次发布：先失败（不留计数），恢复后恰好补记一次
  setNow("2026-02-10T09:00:00.000Z");
  const batch2 = await openBatch(app, "inst-a");
  await postRecord(app, "inst-a", batch2, "r-3", { title: "论文丙", identifiers: { doi: "10.1/c" } });
  const snap2 = (await app.inject({ method: "POST", url: "/snapshots", payload: { cutoff_at: "2026-02-28T00:00:00.000Z" } })).json();
  assert.equal(snap2.metrics.included, 3);
  const [u2] = (await app.inject({ method: "GET", url: "/downstream-updates?status=pending" })).json();

  const failed = await app.inject({ method: "POST", url: `/downstream-updates/${u2.id}/apply?fail=1` });
  assert.equal(failed.statusCode, 502);
  assert.equal((await statsMap(app))["visibility_report:included"], 2); // 失败不留计数
  const failedRow = (await app.inject({ method: "GET", url: "/downstream-updates?status=failed" })).json()[0];
  assert.equal(failedRow.attempts, 1);

  const recovered = (await app.inject({ method: "POST", url: "/downstream-updates/recover" })).json();
  assert.equal(recovered.recovered_count, 1);
  assert.equal((await statsMap(app))["visibility_report:included"], 5); // 恰好补记一次

  const againRecover = (await app.inject({ method: "POST", url: "/downstream-updates/recover" })).json();
  assert.equal(againRecover.recovered_count, 0);
  assert.equal((await statsMap(app))["visibility_report:included"], 5); // 恢复不重复计数
});

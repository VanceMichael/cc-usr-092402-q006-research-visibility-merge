import test from "node:test";
import assert from "node:assert/strict";
import { addInstitution, auth, makeApp, openBatch, postRecord } from "./helpers.js";

test("作者更名：名称映射带有效期，按时间解析到同一人员", async () => {
  const { app } = makeApp("2026-01-05T09:00:00.000Z");
  await addInstitution(app, "inst-a");
  await addInstitution(app, "inst-b");
  await app.inject({ method: "POST", url: "/persons", headers: auth("inst-a"), payload: { id: "person-1", display_name: "张伟" } });
  const batch = await openBatch(app, "inst-a");
  await postRecord(app, "inst-a", batch, "r-1", {
    title: "作者更名研究",
    authors: [{ name: "张伟", person_id: "person-1" }],
    identifiers: { doi: "10.2/a.1" },
  });

  // inst-b 的记录中未出现过该人员 → 不能断言其标识
  const forbidden = await app.inject({
    method: "POST",
    url: "/mappings",
    headers: auth("inst-b"),
    payload: { subject_type: "person", subject_id: "person-1", scheme: "name_variant", identifier: "张伟" },
  });
  assert.equal(forbidden.statusCode, 403);

  // inst-a 断言旧名（2020 起）与更名（2023-06 起），并关闭旧名有效期
  const m1 = (await app.inject({
    method: "POST",
    url: "/mappings",
    headers: auth("inst-a"),
    payload: { subject_type: "person", subject_id: "person-1", scheme: "name_variant", identifier: "张伟", valid_from: "2020-01-01T00:00:00.000Z" },
  })).json();
  const m2 = (await app.inject({
    method: "POST",
    url: "/mappings",
    headers: auth("inst-a"),
    payload: { subject_type: "person", subject_id: "person-1", scheme: "name_variant", identifier: "张维", valid_from: "2023-06-01T00:00:00.000Z" },
  })).json();
  const closed = (await app.inject({
    method: "POST",
    url: `/mappings/${m1.id}/close`,
    headers: auth("inst-a"),
    payload: { valid_to: "2023-06-01T00:00:00.000Z" },
  })).json();
  assert.equal(closed.valid_to, "2023-06-01T00:00:00.000Z");

  const at = (name, t) => app.inject({
    method: "GET",
    url: `/mappings/resolve?scheme=name_variant&identifier=${encodeURIComponent(name)}&at=${encodeURIComponent(t)}`,
  });
  assert.equal((await at("张伟", "2021-01-01T00:00:00.000Z")).json().subject_id, "person-1");
  assert.equal((await at("张伟", "2024-01-01T00:00:00.000Z")).statusCode, 404); // 旧名已失效
  assert.equal((await at("张维", "2024-01-01T00:00:00.000Z")).json().subject_id, "person-1");
  assert.equal((await at("张维", "2021-01-01T00:00:00.000Z")).statusCode, 404); // 新名尚未生效

  // 他机构不能关闭 inst-a 断言的映射
  const closeForbidden = await app.inject({ method: "POST", url: `/mappings/${m2.id}/close`, headers: auth("inst-b"), payload: {} });
  assert.equal(closeForbidden.statusCode, 403);
});

test("成果标识冲突与所有权", async () => {
  const { app } = makeApp();
  await addInstitution(app, "inst-a");
  await addInstitution(app, "inst-b");
  const batch = await openBatch(app, "inst-a");
  const w = (await postRecord(app, "inst-a", batch, "r-1", { title: "成果甲", identifiers: { doi: "10.3/a.1" } })).json();

  // inst-b 未提供过该成果的事实 → 不能断言其标识
  const forbidden = await app.inject({
    method: "POST",
    url: "/mappings",
    headers: auth("inst-b"),
    payload: { subject_type: "work", subject_id: w.work_id, scheme: "pmid", identifier: "999" },
  });
  assert.equal(forbidden.statusCode, 403);

  // 同一活跃标识不能映射到两个成果
  const batchB = await openBatch(app, "inst-b");
  const w2 = (await postRecord(app, "inst-b", batchB, "r-1", { title: "完全不同的成果", identifiers: { doi: "10.3/b.9" } })).json();
  const conflict = await app.inject({
    method: "POST",
    url: "/mappings",
    headers: auth("inst-b"),
    payload: { subject_type: "work", subject_id: w2.work_id, scheme: "doi", identifier: "10.3/a.1" },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "identifier_conflict");
});

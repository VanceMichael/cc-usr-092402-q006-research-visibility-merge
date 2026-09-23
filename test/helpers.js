import { buildApp } from "../src/app.js";

// 可变时钟：测试按时间线推进，验证任意截止时间的重建能力
export function makeApp(start = "2026-01-05T09:00:00.000Z") {
  let now = start;
  const app = buildApp({ dbPath: ":memory:", now: () => now });
  return {
    app,
    setNow: (iso) => {
      now = iso;
    },
  };
}

export const auth = (institutionId) => ({ "x-institution-id": institutionId });

export async function addInstitution(app, id) {
  const res = await app.inject({ method: "POST", url: "/institutions", payload: { id, name: `机构-${id}` } });
  return res.json();
}

export async function openBatch(app, inst, sourceType = "institutional_repository") {
  const res = await app.inject({ method: "POST", url: "/batches", headers: auth(inst), payload: { source_type: sourceType } });
  return res.json().id;
}

export async function postRecord(app, inst, batchId, externalId, payload) {
  return app.inject({
    method: "POST",
    url: `/batches/${batchId}/records`,
    headers: auth(inst),
    payload: { external_id: externalId, payload },
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate } from "../src/db.js";
import * as d from "../src/domain.js";

const T = {
  t1: "2026-01-01 08:00:00", // 机构库抓到预印本
  t2: "2026-02-01 08:00:00", // 期刊平台抓到正式发表（标题改写）
  t3: "2026-02-05 10:00:00", // 人工双方确认合并生效
  t4: "2026-03-01 09:00:00", // 撤稿
  t5: "2026-03-10 09:00:00", // 撤稿申诉后恢复
  t6: "2026-03-15 09:00:00", // 发现错并，拆分生效
};

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return db;
}

function seedInstitutions(db) {
  d.registerInstitution(db, { id: "repo", name: "机构库" });
  d.registerInstitution(db, { id: "journal", name: "期刊平台" });
  d.registerInstitution(db, { id: "other", name: "无关机构" });
}

const preprintRecord = () => ({
  externalRef: "handle-777",
  payload: {
    kind: "work",
    externalRef: "handle-777",
    title: "量子纠错的实验进展",
    workType: "preprint",
    issuedOn: "2026-01-01",
    validFrom: T.t1,
    identifiers: [{ type: "arxiv", value: "2401.00001" }],
    authors: [{ externalRef: "p-zhang", ordinal: 0 }],
  },
});

const zhangRecord = (name) => ({
  externalRef: "p-zhang",
  payload: {
    kind: "person",
    externalRef: "p-zhang",
    displayName: name,
    validFrom: name === "张威" ? T.t5 : T.t1,
    identifiers: [{ type: "orcid", value: "0000-0002-1825-0097" }],
  },
});

const publishedRecord = () => ({
  externalRef: "art-42",
  payload: {
    kind: "work",
    externalRef: "art-42",
    title: "量子纠错实验进展（正式版）", // 标题改写
    workType: "journal-article",
    issuedOn: "2026-02-01",
    validFrom: T.t2,
    identifiers: [{ type: "doi", value: "10.1234/qec.2026.42" }],
    // 期刊侧声明该正式版对应此前的预印本号
    relations: [{ kind: "version_of", targetType: "arxiv", targetValue: "2401.00001" }],
  },
});

test("完整场景：来源留存、归并复核、撤回恢复、快照重建与下钻、下游不重复", (t) => {
  const db = freshDb();
  seedInstitutions(db);

  // ---- 批次1：机构库，预印本 + 作者（旧名） ----
  const b1 = d.ingestBatch(db, {
    institutionId: "repo",
    sourceKind: "repository",
    externalBatchRef: "batch-01",
    harvestedAt: T.t1,
    recordedAt: T.t1,
    records: [preprintRecord(), zhangRecord("张伟")],
  });
  assert.equal(b1.imported, 2, "批次1导入2条原始记录");

  // ---- 批次2：期刊平台，标题改写的正式发表 ----
  const b2 = d.ingestBatch(db, {
    institutionId: "journal",
    sourceKind: "journal",
    externalBatchRef: "batch-02",
    harvestedAt: T.t2,
    recordedAt: T.t2,
    records: [publishedRecord()],
  });
  assert.equal(b2.imported, 1);

  // 原始载荷与批次完整保存
  const batches = d.listBatches(db);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].sources.length, 2);
  assert.match(batches[0].sources[0].content_hash, /^[0-9a-f]{64}$/);

  // 批次重投幂等：原始记录去重，不产生新版本
  const b1again = d.ingestBatch(db, {
    institutionId: "repo",
    sourceKind: "repository",
    externalBatchRef: "batch-01",
    harvestedAt: T.t1,
    recordedAt: T.t1,
    records: [preprintRecord(), zhangRecord("张伟")],
  });
  assert.equal(b1again.imported, 0);
  assert.equal(b1again.skipped, 2);
  assert.equal(d.listWorks(db)[0].version_count, 1, "重投不得追加成果版本");

  // ---- 候选重复：给出每条匹配依据 ----
  const scan = d.scanCandidates(db);
  assert.equal(scan.created.length, 1);
  const cand = scan.candidates[0];
  const kinds = cand.evidence.signals.map((s) => s.kind);
  assert.ok(kinds.includes("preprint_link"), "应包含预印本关系依据");
  assert.ok(kinds.includes("title_fuzzy") || kinds.includes("title_normalized_equal"), "应包含标题依据");
  assert.equal(cand.status, "pending");

  // 无关机构无权确认
  assert.throws(
    () => d.recordDecision(db, cand.id, { institutionId: "other", decision: "merge" }),
    /只能就自己提供事实/
  );

  // 跨机构：单方确认不够，须双方确认
  const afterOne = d.recordDecision(db, cand.id, {
    institutionId: "repo", decision: "merge", actor: "库管理员", at: T.t3,
  });
  assert.equal(afterOne.status, "pending", "仅一方确认时仍待裁决");
  const afterTwo = d.recordDecision(db, cand.id, {
    institutionId: "journal", decision: "merge", actor: "刊社编辑", at: T.t3,
  });
  assert.equal(afterTwo.status, "confirmed_merged");
  assert.equal(afterTwo.confirmations.length, 2, "双方确认都留痕");

  // ---- 按截止时间重建可见度 ----
  const atT1 = d.buildSnapshot(db, T.t1);
  assert.equal(atT1.totals.visible, 1, "t1 只见到预印本");

  const atT2 = d.buildSnapshot(db, T.t2);
  assert.equal(atT2.totals.visible, 2, "t2 归并前同一成果被记两次");

  const atT3 = d.buildSnapshot(db, T.t3);
  assert.equal(atT3.totals.visible, 1, "t3 归并生效后只计一次");
  assert.equal(atT3.totals.absorbed, 1);
  const absorbed = atT3.items.find((i) => i.role === "absorbed");
  assert.equal(absorbed.excludedReason, `merged_into:${atT3.items.find((i) => i.role === "survivor").workId}`);

  // ---- 结项快照发布即冻结 ----
  const closing = d.publishSnapshot(db, {
    asOf: T.t3, label: "项目中期结项快照", createdBy: "科研处",
  });
  assert.equal(closing.totals.visible, 1);
  assert.throws(
    () => db.prepare("UPDATE snapshot_publish SET label='x' WHERE id=?").run(closing.id),
    /密封/
  );
  assert.throws(
    () => db.prepare("DELETE FROM snapshot_item WHERE publish_id=?").run(closing.id),
    /密封/
  );

  // 下钻：汇总数字 → 采用的版本、原始记录、排除理由与双方确认
  const survivorId = atT3.items.find((i) => i.role === "survivor").workId;
  const drill = d.explainItem(db, closing.id, survivorId);
  assert.equal(drill.adoptedVersion.title, "量子纠错实验进展（正式版）");
  assert.equal(drill.adoptedVersion.payload.externalRef, "art-42", "能回溯到原始载荷");
  assert.equal(drill.merges[0].confirmations.length, 2, "归并依据可复核");
  const drillAbsorbed = d.explainItem(db, closing.id, absorbed.workId);
  assert.match(drillAbsorbed.item.excluded_reason, /^merged_into:/);

  // ---- 撤稿形成新版本；已发布快照不变 ----
  const retract = d.ingestBatch(db, {
    institutionId: "journal",
    sourceKind: "amendment",
    externalBatchRef: "batch-03",
    harvestedAt: T.t4,
    recordedAt: T.t4,
    records: [{
      externalRef: "art-42",
      payload: { ...publishedRecord().payload, state: "retracted", validFrom: T.t4, workType: "journal-article" },
    }],
  });
  assert.equal(retract.imported, 1);
  const wJournal = d.getWork(db, survivorId);
  assert.equal(wJournal.versions.length, 2, "撤稿追加新版本而非覆盖");
  assert.equal(wJournal.versions.at(-1).state, "retracted");

  const atT4 = d.buildSnapshot(db, T.t4);
  assert.equal(atT4.totals.visible, 0);
  assert.equal(atT4.totals.retracted, 1, "撤稿在可见度中排除并说明理由");
  const stillClosing = d.getPublished(db, closing.id);
  assert.equal(stillClosing.totals.visible, 1, "撤稿不得抹掉已发布统计");

  // ---- 撤稿恢复（申诉成功）同样形成新版本 ----
  d.ingestBatch(db, {
    institutionId: "journal",
    sourceKind: "amendment",
    externalBatchRef: "batch-04",
    harvestedAt: T.t5,
    recordedAt: T.t5,
    records: [{
      externalRef: "art-42",
      payload: { ...publishedRecord().payload, state: "active", validFrom: T.t5, workType: "journal-article" },
    }],
  });
  const atT5 = d.buildSnapshot(db, T.t5);
  assert.equal(atT5.totals.visible, 1, "恢复后重新可见");
  assert.equal(d.getWork(db, survivorId).versions.length, 3);

  // ---- 作者更名：带有效期的版本链（账簿到 t5 才知悉） ----
  d.ingestBatch(db, {
    institutionId: "repo",
    sourceKind: "author_report",
    externalBatchRef: "batch-05",
    harvestedAt: T.t5,
    recordedAt: T.t5,
    records: [zhangRecord("张威")],
  });
  const personId = b1.touched.find((x) => x.personId).personId;
  const p = d.getPerson(db, personId);
  assert.equal(p.versions.length, 2, "更名保留两个名字版本");
  assert.equal(p.versions[0].valid_to, T.t5, "旧名有失效时间，历史行仍保留");
  assert.equal(p.versions[1].display_name, "张威");
  // 有效期映射：t1 时点旧名有效，t5 时点新名有效
  const nameAt = (cutoff) =>
    db.prepare(
      "SELECT display_name FROM person_version WHERE person_id=? AND recorded_at<=? ORDER BY seq DESC LIMIT 1"
    ).get(personId, cutoff).display_name;
  assert.equal(nameAt(T.t1), "张伟");
  assert.equal(nameAt(T.t5), "张威");

  // ---- 后续更正差异比较 ----
  const diff = d.diffSnapshots(db, T.t3, T.t4);
  assert.equal(diff.totalsDelta.visible, -1);
  assert.ok(diff.changes.some((c) => c.type === "retracted"), "差异应说明撤稿");
  const diff35 = d.diffSnapshots(db, T.t3, T.t5);
  assert.ok(diff35.changes.some((c) => c.type === "version_changed"), "应检出采用版本变化");

  // ---- 错并拆分：仍需双方确认，生效后历史快照不动 ----
  const mergeRow = db.prepare("SELECT * FROM work_merge LIMIT 1").get();
  const splitReq = d.openSplitCandidate(db, mergeRow.id, { at: T.t6 });
  assert.equal(splitReq.kind, "split");
  const afterOneSplit = d.recordDecision(db, splitReq.id, {
    institutionId: "journal", decision: "split", at: T.t6,
  });
  assert.equal(afterOneSplit.status, "pending", "单方拆分确认不能生效");
  d.recordDecision(db, splitReq.id, { institutionId: "repo", decision: "split", at: T.t6 });
  assert.equal(d.getCandidate(db, splitReq.id).status, "split", "双方确认后拆分生效");
  const atT6 = d.buildSnapshot(db, T.t6);
  assert.equal(atT6.totals.visible, 2, "拆分后两个成果分别计数");
  assert.equal(d.getPublished(db, closing.id).totals.visible, 1, "拆分同样不得改动历史发布");

  // ---- 下游更新：失败→恢复→重试，不重复计数 ----
  const eventCountAtRegister = db.prepare("SELECT COUNT(*) c FROM outbox_event").get().c;
  d.registerTarget(db, { id: "portal", name: "校级门户", driver: "flaky", failRemaining: 100 });
  const run1 = d.deliverPending(db, "portal", { limit: 1000 });
  assert.equal(run1.sent, 0, "中断期间无成功投递");
  assert.equal(run1.failed, eventCountAtRegister, "全部事件尝试失败并留队");
  assert.equal(d.inboxContents(db, "portal").length, 0, "失败未写入下游");
  // 恢复后重放
  d.recoverTarget(db, "portal");
  const run2 = d.deliverPending(db, "portal", { limit: 1000 });
  assert.equal(run2.failed, 0);
  const events = db.prepare("SELECT COUNT(*) c FROM outbox_event").get().c;
  const inbox = d.inboxContents(db, "portal");
  assert.equal(inbox.length, events, "每个事件恰好在下游计数一次");
  const tokens = new Set(inbox.map((i) => i.idempotency_token));
  assert.equal(tokens.size, inbox.length, "幂等令牌唯一");
  // 再跑一轮：队列为空；即使人为把某条投回重放，收件箱也拒收重复
  const run3 = d.deliverPending(db, "portal");
  assert.equal(run3.sent, 0);
  db.prepare("UPDATE delivery SET status='pending' WHERE id=(SELECT id FROM delivery LIMIT 1)").run();
  const run4 = d.deliverPending(db, "portal");
  assert.equal(run4.duplicateBlocks, 1, "重复令牌被下游收件箱识别并忽略");
  assert.equal(d.inboxContents(db, "portal").length, events, "总数不变，不重复计数");
});

test("同机构自行归并只需一方确认；拒绝候选留痕", () => {
  const db = freshDb();
  seedInstitutions(db);
  d.ingestBatch(db, {
    institutionId: "repo", sourceKind: "repository", externalBatchRef: "b-a",
    recordedAt: T.t1, harvestedAt: T.t1,
    records: [{
      externalRef: "h1",
      payload: {
        kind: "work", externalRef: "h1", title: "同一标题的重复条目",
        workType: "report", identifiers: [{ type: "handle", value: "inst/h1" }],
        authors: [{ externalRef: "x1", displayName: "作者甲", ordinal: 0 }],
      },
    }, {
      externalRef: "h2",
      payload: {
        kind: "work", externalRef: "h2", title: "同一标题的重复条目",
        workType: "report", identifiers: [{ type: "handle", value: "inst/h1" }],
        authors: [{ externalRef: "x1", displayName: "作者甲", ordinal: 0 }],
      },
    }],
  });
  const { candidates } = d.scanCandidates(db);
  assert.equal(candidates.length, 1);
  const decided = d.recordDecision(db, candidates[0].id, {
    institutionId: "repo", decision: "reject", at: T.t2,
  });
  assert.equal(decided.status, "rejected_split", "拒绝（判定为不同成果）留痕");
  assert.equal(d.buildSnapshot(db, T.t2).totals.visible, 2, "被拒绝的候选不参与归并");
});

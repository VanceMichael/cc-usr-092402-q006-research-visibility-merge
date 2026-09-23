import { createHash, randomUUID } from "node:crypto";
import { normalizeIdentifier, scorePair } from "./matching.js";

// 模糊匹配进入候选重复的最低得分；精确标识命中直接关联同一成果。
export const CANDIDATE_THRESHOLD = 0.5;

const SOURCE_TYPES = new Set(["institutional_repository", "journal_platform", "author_self_report"]);
const MANUAL_CHANGE_REASONS = new Set(["correction", "retraction", "restoration"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// 下游统计接收方累计的计数器
const DOWNSTREAM_COUNTERS = ["included", "excluded"];

export class LedgerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "LedgerError";
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => {
  throw new LedgerError(status, code, message);
};

const newId = (prefix) => `${prefix}_${randomUUID()}`;

const checkIso = (value, field) => {
  if (!ISO_RE.test(String(value ?? ""))) {
    fail(400, "invalid_time", `${field} 需为 UTC ISO 时间（如 2026-01-31T00:00:00.000Z）`);
  }
};

const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hashPayload = (payload) => createHash("sha256").update(canonical(payload)).digest("hex");

const isConstraint = (e) => String(e?.code ?? "").startsWith("SQLITE_CONSTRAINT");

// ---------------------------------------------------------------------------
// 载荷与行解析
// ---------------------------------------------------------------------------

export function normalizeAuthors(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(400, "invalid_payload", "authors 需为数组");
  return raw.map((a) => {
    if (typeof a === "string") return { name: a };
    if (a && typeof a === "object" && a.name) {
      const out = { name: String(a.name) };
      if (a.person_id) out.person_id = String(a.person_id);
      return out;
    }
    fail(400, "invalid_payload", "authors 元素需为字符串或 {name, person_id?}");
  });
}

const normIds = (ids) =>
  Object.fromEntries(
    Object.entries(ids ?? {})
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([s, v]) => [String(s), normalizeIdentifier(String(s), String(v))])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );

export function normalizePayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(400, "invalid_payload", "payload 需为对象");
  }
  const title = String(raw.title ?? "").trim();
  if (!title) fail(400, "invalid_payload", "payload.title 不能为空");
  if (raw.identifiers !== undefined && (typeof raw.identifiers !== "object" || raw.identifiers === null || Array.isArray(raw.identifiers))) {
    fail(400, "invalid_payload", "payload.identifiers 需为对象");
  }
  const status = raw.status ?? "active";
  if (!["active", "retracted"].includes(status)) {
    fail(400, "invalid_payload", "payload.status 仅支持 active / retracted");
  }
  if (raw.effective_at !== undefined && raw.effective_at !== null) checkIso(raw.effective_at, "payload.effective_at");
  return {
    title,
    authors: normalizeAuthors(raw.authors),
    identifiers: normIds(raw.identifiers),
    status,
    output_type: String(raw.type ?? "article"),
    is_open_access: raw.open_access === undefined ? true : Boolean(raw.open_access),
    published_at: raw.published_at ?? null,
    effective_at: raw.effective_at ?? null,
  };
}

function versionOut(row) {
  if (!row) return null;
  return {
    ...row,
    authors: parseJson(row.authors, []),
    identifiers: parseJson(row.identifiers, {}),
    is_open_access: !!row.is_open_access,
  };
}

function candidateOut(row) {
  if (!row) return null;
  return { ...row, evidence: parseJson(row.evidence, []) };
}

// ---------------------------------------------------------------------------
// 版本选取：在 (cutoff 生效时间, knowledge 入账时间) 下被采用的版本
// ---------------------------------------------------------------------------

export function adoptedVersion(db, workId, cutoff, knowledge) {
  return versionOut(
    db.prepare(
      `SELECT * FROM work_versions
       WHERE work_id = ? AND effective_at <= ? AND recorded_at <= ?
       ORDER BY effective_at DESC, version_no DESC
       LIMIT 1`,
    ).get(workId, cutoff, knowledge),
  );
}

function insertVersion(db, { workId, payload, status, changeReason, sourceRecordId = null, mergeDecisionId = null, recordedBy, recordedAt, effectiveAt }) {
  const versionNo = db.prepare(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM work_versions WHERE work_id = ?`).get(workId).n;
  const id = newId("wv");
  db.prepare(
    `INSERT INTO work_versions
       (id, work_id, version_no, title, authors, identifiers, output_type, is_open_access,
        status, change_reason, source_record_id, merge_decision_id, recorded_by, recorded_at, effective_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, workId, versionNo, payload.title, JSON.stringify(payload.authors ?? []), JSON.stringify(normIds(payload.identifiers)),
    payload.output_type ?? "article", (payload.is_open_access ?? true) ? 1 : 0, status, changeReason,
    sourceRecordId, mergeDecisionId, recordedBy, recordedAt, effectiveAt,
  );
  return versionOut(db.prepare(`SELECT * FROM work_versions WHERE id = ?`).get(id));
}

function getWorkRow(db, workId) {
  const w = db.prepare(`SELECT * FROM works WHERE id = ?`).get(workId);
  if (!w) fail(404, "work_not_found", `成果 ${workId} 不存在`);
  return w;
}

// ---------------------------------------------------------------------------
// 机构与人员
// ---------------------------------------------------------------------------

export function createInstitution(ctx, { id, name }) {
  const iid = id ?? newId("inst");
  if (!name || !String(name).trim()) fail(400, "invalid_institution", "name 不能为空");
  try {
    ctx.db.prepare(`INSERT INTO institutions (id, name, created_at) VALUES (?,?,?)`).run(iid, String(name).trim(), ctx.now());
  } catch (e) {
    if (isConstraint(e)) fail(409, "institution_exists", `机构 ${iid} 已存在`);
    throw e;
  }
  return ctx.db.prepare(`SELECT * FROM institutions WHERE id = ?`).get(iid);
}

export function createPerson(ctx, { id, displayName, display_name }) {
  const pid = id ?? newId("person");
  const name = displayName ?? display_name;
  if (!name || !String(name).trim()) fail(400, "invalid_person", "display_name 不能为空");
  try {
    ctx.db.prepare(`INSERT INTO persons (id, display_name, created_at) VALUES (?,?,?)`).run(pid, String(name).trim(), ctx.now());
  } catch (e) {
    if (isConstraint(e)) fail(409, "person_exists", `人员 ${pid} 已存在`);
    throw e;
  }
  return ctx.db.prepare(`SELECT * FROM persons WHERE id = ?`).get(pid);
}

// ---------------------------------------------------------------------------
// 抓取批次与来源记录
// ---------------------------------------------------------------------------

export function createBatch(ctx, { institutionId, sourceType, fetchedAt, note }) {
  if (!SOURCE_TYPES.has(sourceType)) {
    fail(400, "invalid_source_type", `source_type 需为 ${[...SOURCE_TYPES].join(" / ")}`);
  }
  const at = fetchedAt ?? ctx.now();
  checkIso(at, "fetched_at");
  const id = newId("batch");
  ctx.db.prepare(
    `INSERT INTO fetch_batches (id, institution_id, source_type, fetched_at, note, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(id, institutionId, sourceType, at, note ?? null, ctx.now());
  return getBatch(ctx, id);
}

export function getBatch(ctx, id) {
  const batch = ctx.db.prepare(`SELECT * FROM fetch_batches WHERE id = ?`).get(id);
  if (!batch) fail(404, "batch_not_found", `批次 ${id} 不存在`);
  const records = ctx.db.prepare(
    `SELECT id, external_id, matched_work_id, record_hash, received_at FROM source_records WHERE batch_id = ? ORDER BY received_at, id`,
  ).all(id);
  return { ...batch, records };
}

export function getRecord(ctx, id) {
  const r = ctx.db.prepare(`SELECT * FROM source_records WHERE id = ?`).get(id);
  if (!r) fail(404, "record_not_found", `来源记录 ${id} 不存在`);
  return { ...r, payload: parseJson(r.payload, {}) };
}

// ---------------------------------------------------------------------------
// 标识映射
// ---------------------------------------------------------------------------

function ensureMapping(db, { subjectType, subjectId, scheme, identifier, assertedBy, evidence, now, validFrom }) {
  const value = normalizeIdentifier(scheme, identifier);
  const active = db.prepare(
    `SELECT * FROM identifier_mappings WHERE scheme = ? AND identifier = ? AND valid_to IS NULL`,
  ).get(scheme, value);
  if (active) {
    if (active.subject_type === subjectType && active.subject_id === subjectId) return { mapping: active };
    return { conflict: active };
  }
  const id = newId("map");
  db.prepare(
    `INSERT INTO identifier_mappings (id, subject_type, subject_id, scheme, identifier, valid_from, asserted_by, evidence, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, subjectType, subjectId, scheme, value, validFrom ?? now, assertedBy, evidence ?? null, now);
  return { mapping: db.prepare(`SELECT * FROM identifier_mappings WHERE id = ?`).get(id) };
}

export function addMapping(ctx, { institutionId, subjectType, subjectId, scheme, identifier, validFrom, validTo, evidence }) {
  const db = ctx.db;
  if (!["work", "person"].includes(subjectType)) fail(400, "invalid_subject", "subject_type 需为 work / person");
  if (!scheme || !String(scheme).trim()) fail(400, "invalid_mapping", "scheme 不能为空");
  if (!identifier || !String(identifier).trim()) fail(400, "invalid_mapping", "identifier 不能为空");
  const now = ctx.now();
  const from = validFrom ?? now;
  checkIso(from, "valid_from");
  if (validTo) {
    checkIso(validTo, "valid_to");
    if (validTo <= from) fail(400, "invalid_mapping", "valid_to 需晚于 valid_from");
  }
  // 只能为本机构提供过事实的主体断言标识
  if (subjectType === "work") {
    getWorkRow(db, subjectId);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM source_records WHERE institution_id = ? AND matched_work_id = ?`).get(institutionId, subjectId).n;
    if (n === 0) fail(403, "fact_ownership", "只能为本机构提供过事实的成果断言标识");
  } else {
    const p = db.prepare(`SELECT * FROM persons WHERE id = ?`).get(subjectId);
    if (!p) fail(404, "person_not_found", `人员 ${subjectId} 不存在`);
    const n = db.prepare(
      `SELECT COUNT(*) AS n FROM source_records
       WHERE institution_id = ?
         AND EXISTS (
           SELECT 1 FROM json_each(json_extract(source_records.payload, '$.authors'))
           WHERE json_extract(value, '$.person_id') = ?
         )`,
    ).get(institutionId, subjectId).n;
    if (n === 0) fail(403, "fact_ownership", "只能为本机构记录中出现过的人员断言标识");
  }
  const result = ensureMapping(db, {
    subjectType, subjectId, scheme: String(scheme), identifier: String(identifier),
    assertedBy: institutionId, evidence, now, validFrom: from,
  });
  if (result.conflict) {
    fail(409, "identifier_conflict", `标识已映射到其他${result.conflict.subject_type === "work" ? "成果" : "人员"}：${result.conflict.subject_id}，请先通过候选重复确认归并`);
  }
  if (validTo) db.prepare(`UPDATE identifier_mappings SET valid_to = ? WHERE id = ?`).run(validTo, result.mapping.id);
  return db.prepare(`SELECT * FROM identifier_mappings WHERE id = ?`).get(result.mapping.id);
}

export function closeMapping(ctx, { institutionId, mappingId, validTo }) {
  const db = ctx.db;
  const m = db.prepare(`SELECT * FROM identifier_mappings WHERE id = ?`).get(mappingId);
  if (!m) fail(404, "mapping_not_found", `映射 ${mappingId} 不存在`);
  if (m.asserted_by !== institutionId) fail(403, "fact_ownership", "只能关闭本机构断言的映射");
  if (m.valid_to) fail(409, "mapping_closed", "映射已关闭");
  const at = validTo ?? ctx.now();
  checkIso(at, "valid_to");
  if (at < m.valid_from) fail(400, "invalid_mapping", "valid_to 早于 valid_from");
  db.prepare(`UPDATE identifier_mappings SET valid_to = ? WHERE id = ?`).run(at, mappingId);
  return db.prepare(`SELECT * FROM identifier_mappings WHERE id = ?`).get(mappingId);
}

// 按当前知识解析某时间点有效的映射
export function resolveMapping(ctx, { scheme, identifier, at }) {
  const when = at ?? ctx.now();
  checkIso(when, "at");
  const value = normalizeIdentifier(String(scheme ?? ""), String(identifier ?? ""));
  const m = ctx.db.prepare(
    `SELECT * FROM identifier_mappings
     WHERE scheme = ? AND identifier = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) AND recorded_at <= ?
     ORDER BY recorded_at DESC LIMIT 1`,
  ).get(String(scheme ?? ""), value, when, when, ctx.now());
  if (!m) fail(404, "mapping_not_found", "该时间点没有有效映射");
  return m;
}

// ---------------------------------------------------------------------------
// 摄入：来源记录 → 匹配 → 版本 → 映射 → 候选重复
// ---------------------------------------------------------------------------

function payloadDiffers(payload, v) {
  if (payload.title !== v.title) return true;
  if (payload.status !== v.status) return true;
  if (payload.output_type !== v.output_type) return true;
  if (payload.is_open_access !== !!v.is_open_access) return true;
  if (JSON.stringify(payload.authors) !== JSON.stringify(v.authors)) return true;
  if (JSON.stringify(normIds(payload.identifiers)) !== JSON.stringify(normIds(v.identifiers))) return true;
  return false;
}

function ingestChangeReason(payload, current) {
  if (!current) return "ingest";
  if (payload.status === "retracted" && current.status !== "retracted") return "retraction";
  if (payload.status === "active" && current.status === "retracted") return "restoration";
  return payloadDiffers(payload, current) ? "correction" : null;
}

function upsertCandidate(db, workA, workB, score, evidence, now) {
  const [a, b] = workA < workB ? [workA, workB] : [workB, workA];
  const existing = db.prepare(`SELECT * FROM duplicate_candidates WHERE work_a_id = ? AND work_b_id = ?`).get(a, b);
  if (existing) {
    // 已决议（merged / split）的候选不被重开；待处理的候选在证据更强时刷新依据
    if (existing.status === "pending" && score > existing.score) {
      db.prepare(`UPDATE duplicate_candidates SET score = ?, evidence = ? WHERE id = ?`).run(score, JSON.stringify(evidence), existing.id);
      return candidateOut(db.prepare(`SELECT * FROM duplicate_candidates WHERE id = ?`).get(existing.id));
    }
    return candidateOut(existing);
  }
  const id = newId("cand");
  db.prepare(
    `INSERT INTO duplicate_candidates (id, work_a_id, work_b_id, status, score, evidence, created_at) VALUES (?,?,?,'pending',?,?,?)`,
  ).run(id, a, b, score, JSON.stringify(evidence), now);
  return candidateOut(db.prepare(`SELECT * FROM duplicate_candidates WHERE id = ?`).get(id));
}

function scanFuzzyCandidates(db, workId, payload, now) {
  const out = [];
  const others = db.prepare(`SELECT id FROM works WHERE id != ? AND merged_into_work_id IS NULL`).all(workId);
  for (const { id: otherId } of others) {
    const other = adoptedVersion(db, otherId, now, now);
    if (!other) continue;
    const { score, evidence } = scorePair(
      { title: payload.title, authors: payload.authors, identifiers: payload.identifiers },
      { title: other.title, authors: other.authors, identifiers: other.identifiers },
    );
    if (score >= CANDIDATE_THRESHOLD) out.push(upsertCandidate(db, workId, otherId, score, evidence, now));
  }
  return out;
}

export function ingestRecord(ctx, { institutionId, batchId, externalId, payload: rawPayload }) {
  const db = ctx.db;
  const batch = db.prepare(`SELECT * FROM fetch_batches WHERE id = ?`).get(batchId);
  if (!batch) fail(404, "batch_not_found", `批次 ${batchId} 不存在`);
  if (batch.institution_id !== institutionId) fail(403, "batch_ownership", "只能向本机构的批次写入记录");
  if (!externalId || !String(externalId).trim()) fail(400, "invalid_record", "external_id 不能为空");
  const payload = normalizePayload(rawPayload);
  const now = ctx.now();

  const tx = db.transaction(() => {
    const recordId = newId("rec");
    try {
      db.prepare(
        `INSERT INTO source_records (id, batch_id, institution_id, external_id, payload, record_hash, received_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(recordId, batchId, institutionId, String(externalId), JSON.stringify(rawPayload), hashPayload(payload), now);
    } catch (e) {
      if (isConstraint(e)) fail(409, "duplicate_record", `批次内已存在 external_id=${externalId} 的记录`);
      throw e;
    }

    // 1) 精确标识匹配：任一有效标识映射命中的成果（已归并的沿重定向找到目标）
    const hits = new Map(); // workId -> 共享标识列表
    for (const [scheme, value] of Object.entries(payload.identifiers)) {
      const m = db.prepare(
        `SELECT * FROM identifier_mappings WHERE subject_type = 'work' AND scheme = ? AND identifier = ? AND valid_to IS NULL`,
      ).get(scheme, value);
      if (!m) continue;
      let w = db.prepare(`SELECT * FROM works WHERE id = ?`).get(m.subject_id);
      while (w && w.merged_into_work_id) w = db.prepare(`SELECT * FROM works WHERE id = ?`).get(w.merged_into_work_id);
      if (!w) continue;
      hits.set(w.id, [...(hits.get(w.id) ?? []), `${scheme}:${value}`]);
    }

    let work;
    let version;
    let created = false;
    const candidates = [];
    if (hits.size > 0) {
      const ranked = [...hits.entries()].sort((a, b) => b[1].length - a[1].length);
      work = db.prepare(`SELECT * FROM works WHERE id = ?`).get(ranked[0][0]);
      const current = adoptedVersion(db, work.id, now, now);
      const reason = ingestChangeReason(payload, current);
      version = reason
        ? insertVersion(db, {
            workId: work.id, payload, status: payload.status, changeReason: reason,
            sourceRecordId: recordId, recordedBy: institutionId, recordedAt: now,
            effectiveAt: payload.effective_at ?? now,
          })
        : current;
      // 同一记录的标识命中多个成果 → 互为候选重复，留待人工确认
      for (const [otherId, shared] of ranked.slice(1)) {
        candidates.push(upsertCandidate(db, work.id, otherId, 1, [
          { rule: "identifier_exact", weight: 1, detail: `共享标识 ${shared.join(", ")}` },
        ], now));
      }
    } else {
      const workId = newId("work");
      db.prepare(`INSERT INTO works (id, created_at) VALUES (?,?)`).run(workId, now);
      version = insertVersion(db, {
        workId, payload, status: payload.status, changeReason: "ingest",
        sourceRecordId: recordId, recordedBy: institutionId, recordedAt: now,
        effectiveAt: payload.effective_at ?? now,
      });
      work = db.prepare(`SELECT * FROM works WHERE id = ?`).get(workId);
      created = true;
    }

    // 2) 补齐标识映射（带有效期，断言机构为记录提供方）
    const mappingConflicts = [];
    for (const [scheme, value] of Object.entries(payload.identifiers)) {
      const r = ensureMapping(db, {
        subjectType: "work", subjectId: work.id, scheme, identifier: value,
        assertedBy: institutionId, evidence: `ingest:${recordId}`, now,
      });
      if (r.conflict) mappingConflicts.push(r.conflict);
    }

    // 3) 模糊匹配 → 候选重复（保存匹配依据，等待人工确认）
    for (const cand of scanFuzzyCandidates(db, work.id, payload, now)) candidates.push(cand);

    db.prepare(`UPDATE source_records SET matched_work_id = ? WHERE id = ?`).run(work.id, recordId);
    return {
      record_id: recordId,
      work_id: work.id,
      version,
      created_work: created,
      candidates,
      mapping_conflicts: mappingConflicts,
    };
  });
  return tx();
}

// ---------------------------------------------------------------------------
// 人工修订：更正 / 撤回 / 恢复（只能修订本机构提供的事实）
// ---------------------------------------------------------------------------

function syncWorkIdentifiers(db, { workId, from, to, institutionId, evidence, now }) {
  const before = normIds(from);
  const after = normIds(to);
  for (const [scheme, value] of Object.entries(before)) {
    if (after[scheme] === value) continue;
    const m = db.prepare(`SELECT * FROM identifier_mappings WHERE scheme = ? AND identifier = ? AND valid_to IS NULL`).get(scheme, value);
    // 只能关闭本机构断言的映射；他方断言的映射保持有效
    if (m && m.subject_type === "work" && m.subject_id === workId && m.asserted_by === institutionId) {
      db.prepare(`UPDATE identifier_mappings SET valid_to = ? WHERE id = ?`).run(now, m.id);
    }
  }
  for (const [scheme, value] of Object.entries(after)) {
    if (before[scheme] === value) continue;
    const r = ensureMapping(db, { subjectType: "work", subjectId: workId, scheme, identifier: value, assertedBy: institutionId, evidence, now });
    if (r.conflict) {
      fail(409, "identifier_conflict", `标识 ${scheme}:${value} 已映射到其他成果 ${r.conflict.subject_id}，请先通过候选重复确认归并`);
    }
  }
}

export function addWorkVersion(ctx, { institutionId, workId, sourceRecordId, changeReason, changes = {} }) {
  const db = ctx.db;
  if (!MANUAL_CHANGE_REASONS.has(changeReason)) {
    fail(400, "invalid_change_reason", "change_reason 需为 correction / retraction / restoration");
  }
  const work = getWorkRow(db, workId);
  if (work.merged_into_work_id) {
    fail(409, "work_merged", `成果已并入 ${work.merged_into_work_id}，请对归并目标修订`);
  }
  const rec = sourceRecordId ? db.prepare(`SELECT * FROM source_records WHERE id = ?`).get(sourceRecordId) : null;
  if (!rec) fail(404, "record_not_found", `来源记录 ${sourceRecordId} 不存在`);
  if (rec.institution_id !== institutionId) fail(403, "fact_ownership", "只能修订本机构提供的事实");
  // 修订依据的记录须关联到该成果（沿归并重定向解析）
  let matched = rec.matched_work_id;
  while (matched) {
    const w = db.prepare(`SELECT id, merged_into_work_id FROM works WHERE id = ?`).get(matched);
    if (!w || !w.merged_into_work_id) break;
    matched = w.merged_into_work_id;
  }
  if (matched !== workId) fail(403, "fact_ownership", "该来源记录未关联到此成果，不能作为修订依据");
  if (changes.effective_at !== undefined && changes.effective_at !== null) checkIso(changes.effective_at, "changes.effective_at");
  if (changes.identifiers !== undefined && (typeof changes.identifiers !== "object" || changes.identifiers === null || Array.isArray(changes.identifiers))) {
    fail(400, "invalid_changes", "changes.identifiers 需为对象");
  }
  const now = ctx.now();

  const tx = db.transaction(() => {
    const current = adoptedVersion(db, workId, now, now);
    if (changeReason === "retraction" && current.status === "retracted") fail(409, "already_retracted", "成果已处于撤回状态");
    if (changeReason === "restoration" && current.status !== "retracted") fail(409, "not_retracted", "成果未处于撤回状态");
    const next = {
      title: changes.title ?? current.title,
      authors: changes.authors !== undefined ? normalizeAuthors(changes.authors) : current.authors,
      identifiers: changes.identifiers !== undefined ? normIds(changes.identifiers) : current.identifiers,
      output_type: changes.output_type ?? current.output_type,
      is_open_access: changes.open_access ?? changes.is_open_access ?? current.is_open_access,
    };
    const status = changeReason === "retraction" ? "retracted" : changeReason === "restoration" ? "active" : (changes.status ?? current.status);
    if (changeReason === "correction" && !payloadDiffers({ ...next, status }, { ...current, status: current.status })) {
      fail(400, "no_changes", "未提供任何变更");
    }
    const version = insertVersion(db, {
      workId, payload: next, status, changeReason, sourceRecordId,
      recordedBy: institutionId, recordedAt: now, effectiveAt: changes.effective_at ?? now,
    });
    syncWorkIdentifiers(db, {
      workId, from: current.identifiers, to: next.identifiers,
      institutionId, evidence: `${changeReason}:${sourceRecordId}`, now,
    });
    return version;
  });
  return tx();
}

// ---------------------------------------------------------------------------
// 成果查询
// ---------------------------------------------------------------------------

function workOwners(db, workId) {
  return db.prepare(`SELECT DISTINCT institution_id FROM source_records WHERE matched_work_id = ?`).all(workId).map((r) => r.institution_id);
}

export function getWork(ctx, workId) {
  const db = ctx.db;
  const w = getWorkRow(db, workId);
  const now = ctx.now();
  return {
    ...w,
    current_version: adoptedVersion(db, workId, now, now),
    active_mappings: db.prepare(`SELECT * FROM identifier_mappings WHERE subject_type = 'work' AND subject_id = ? AND valid_to IS NULL`).all(workId),
    owners: workOwners(db, workId),
  };
}

export function listWorkVersions(ctx, workId) {
  getWorkRow(ctx.db, workId);
  return ctx.db.prepare(`SELECT * FROM work_versions WHERE work_id = ? ORDER BY version_no`).all(workId).map(versionOut);
}

// ---------------------------------------------------------------------------
// 候选重复与归并决议
// ---------------------------------------------------------------------------

export function listCandidates(ctx, { status } = {}) {
  const rows = !status || status === "all"
    ? ctx.db.prepare(`SELECT * FROM duplicate_candidates ORDER BY created_at DESC`).all()
    : ctx.db.prepare(`SELECT * FROM duplicate_candidates WHERE status = ? ORDER BY created_at DESC`).all(status);
  return rows.map(candidateOut);
}

export function getCandidate(ctx, id) {
  const db = ctx.db;
  const cand = db.prepare(`SELECT * FROM duplicate_candidates WHERE id = ?`).get(id);
  if (!cand) fail(404, "candidate_not_found", `候选 ${id} 不存在`);
  const now = ctx.now();
  const brief = (wid) => {
    const w = db.prepare(`SELECT * FROM works WHERE id = ?`).get(wid);
    const v = adoptedVersion(db, wid, now, now);
    return {
      work_id: wid,
      title: v?.title ?? null,
      status: v?.status ?? null,
      merged_into_work_id: w?.merged_into_work_id ?? null,
      owners: workOwners(db, wid),
    };
  };
  const decisions = db.prepare(
    `SELECT id, decision, target_work_id, status, reason, created_at, applied_at FROM merge_decisions WHERE candidate_id = ? ORDER BY created_at`,
  ).all(id);
  return { ...candidateOut(cand), work_a: brief(cand.work_a_id), work_b: brief(cand.work_b_id), decisions };
}

export function getDecision(ctx, id) {
  const dec = ctx.db.prepare(`SELECT * FROM merge_decisions WHERE id = ?`).get(id);
  if (!dec) fail(404, "decision_not_found", `决议 ${id} 不存在`);
  return {
    ...dec,
    required_institutions: parseJson(dec.required_institutions, []),
    confirmations: ctx.db.prepare(
      `SELECT institution_id, decided_by, note, decided_at FROM merge_confirmations WHERE decision_id = ? ORDER BY decided_at`,
    ).all(id),
  };
}

function applySplit(db, decisionId, now) {
  const dec = db.prepare(`SELECT * FROM merge_decisions WHERE id = ?`).get(decisionId);
  db.prepare(`UPDATE duplicate_candidates SET status = 'split', resolved_at = ? WHERE id = ?`).run(now, dec.candidate_id);
  db.prepare(`UPDATE merge_decisions SET status = 'applied', applied_at = ? WHERE id = ?`).run(now, decisionId);
}

function applyMerge(db, decisionId, now) {
  const dec = db.prepare(`SELECT * FROM merge_decisions WHERE id = ?`).get(decisionId);
  const cand = db.prepare(`SELECT * FROM duplicate_candidates WHERE id = ?`).get(dec.candidate_id);
  const target = dec.target_work_id;
  const sourceId = cand.work_a_id === target ? cand.work_b_id : cand.work_a_id;
  const source = db.prepare(`SELECT * FROM works WHERE id = ?`).get(sourceId);
  const tgt = db.prepare(`SELECT * FROM works WHERE id = ?`).get(target);
  if (source.merged_into_work_id || tgt.merged_into_work_id) {
    fail(409, "already_merged", "候选一方已并入其他成果，无法按原决议归并");
  }
  const sv = adoptedVersion(db, sourceId, now, now);
  const tv = adoptedVersion(db, target, now, now);
  // 归并版本：目标成果继承双方标识（目标优先）
  const mergedIds = { ...normIds(sv?.identifiers), ...normIds(tv?.identifiers) };
  insertVersion(db, {
    workId: target,
    payload: {
      title: tv.title, authors: tv.authors, identifiers: mergedIds,
      output_type: tv.output_type, is_open_access: !!tv.is_open_access,
    },
    status: tv.status, changeReason: "merge", mergeDecisionId: decisionId,
    recordedBy: dec.initiated_by, recordedAt: now, effectiveAt: now,
  });
  // 源成果的活跃标识映射关闭有效期并重定向到目标
  const active = db.prepare(`SELECT * FROM identifier_mappings WHERE subject_type = 'work' AND subject_id = ? AND valid_to IS NULL`).all(sourceId);
  for (const m of active) {
    const existing = db.prepare(
      `SELECT id FROM identifier_mappings WHERE scheme = ? AND identifier = ? AND valid_to IS NULL AND subject_type = 'work' AND subject_id = ?`,
    ).get(m.scheme, m.identifier, target);
    if (existing) {
      // 目标已持有该标识：仅关闭源映射
      db.prepare(`UPDATE identifier_mappings SET valid_to = ? WHERE id = ?`).run(now, m.id);
      continue;
    }
    // 先关闭源映射再插入重定向映射，保证同一标识任一时刻只有一条活跃映射
    const supersededBy = newId("map");
    db.prepare(`UPDATE identifier_mappings SET valid_to = ?, superseded_by = ? WHERE id = ?`).run(now, supersededBy, m.id);
    db.prepare(
      `INSERT INTO identifier_mappings (id, subject_type, subject_id, scheme, identifier, valid_from, asserted_by, evidence, recorded_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(supersededBy, "work", target, m.scheme, m.identifier, now, dec.initiated_by, `merge:${decisionId}`, now);
  }
  db.prepare(`UPDATE works SET merged_into_work_id = ?, merged_at = ? WHERE id = ?`).run(target, now, sourceId);
  db.prepare(`UPDATE duplicate_candidates SET status = 'merged', resolved_at = ? WHERE id = ?`).run(now, cand.id);
  db.prepare(`UPDATE merge_decisions SET status = 'applied', applied_at = ? WHERE id = ?`).run(now, decisionId);
}

export function decideCandidate(ctx, { institutionId, candidateId, decision, targetWorkId, reason, decidedBy }) {
  const db = ctx.db;
  const cand = db.prepare(`SELECT * FROM duplicate_candidates WHERE id = ?`).get(candidateId);
  if (!cand) fail(404, "candidate_not_found", `候选 ${candidateId} 不存在`);
  if (cand.status !== "pending") fail(409, "candidate_resolved", "候选已处理，不能重复决议");
  if (!["merge", "split"].includes(decision)) fail(400, "invalid_decision", "decision 需为 merge / split");
  if (!reason || !String(reason).trim()) fail(400, "invalid_decision", "需填写处理理由 reason");
  const involved = [...new Set([...workOwners(db, cand.work_a_id), ...workOwners(db, cand.work_b_id)])];
  if (!involved.includes(institutionId)) fail(403, "not_involved", "只有候选相关机构才能决议");
  if (decision === "merge" && ![cand.work_a_id, cand.work_b_id].includes(targetWorkId)) {
    fail(400, "invalid_target", "target_work_id 需为候选双方之一");
  }
  const wa = getWorkRow(db, cand.work_a_id);
  const wb = getWorkRow(db, cand.work_b_id);
  if (decision === "merge" && (wa.merged_into_work_id || wb.merged_into_work_id)) {
    fail(409, "already_merged", "候选一方已并入其他成果，无法按原决议归并");
  }
  const now = ctx.now();
  const tx = db.transaction(() => {
    const decId = newId("dec");
    db.prepare(
      `INSERT INTO merge_decisions (id, candidate_id, decision, target_work_id, reason, initiated_by, required_institutions, status, created_at)
       VALUES (?,?,?,?,?,?,?,'pending_confirmations',?)`,
    ).run(decId, candidateId, decision, decision === "merge" ? targetWorkId : null, String(reason).trim(), institutionId, JSON.stringify(involved), now);
    db.prepare(
      `INSERT INTO merge_confirmations (id, decision_id, institution_id, decided_by, decided_at) VALUES (?,?,?,?,?)`,
    ).run(newId("conf"), decId, institutionId, decidedBy ?? null, now);
    // 拆分由任一方确认即生效；归并须涉及机构全部确认（跨机构即双方确认）
    if (decision === "split") applySplit(db, decId, now);
    else if (involved.length === 1) applyMerge(db, decId, now);
    return getDecision(ctx, decId);
  });
  return tx();
}

export function confirmDecision(ctx, { institutionId, decisionId, decidedBy, note }) {
  const db = ctx.db;
  const dec = db.prepare(`SELECT * FROM merge_decisions WHERE id = ?`).get(decisionId);
  if (!dec) fail(404, "decision_not_found", `决议 ${decisionId} 不存在`);
  if (dec.status !== "pending_confirmations") fail(409, "decision_closed", "决议已生效或关闭");
  const required = parseJson(dec.required_institutions, []);
  if (!required.includes(institutionId)) fail(403, "not_involved", "该机构不在归并双方之内");
  const now = ctx.now();
  const tx = db.transaction(() => {
    try {
      db.prepare(
        `INSERT INTO merge_confirmations (id, decision_id, institution_id, decided_by, note, decided_at) VALUES (?,?,?,?,?,?)`,
      ).run(newId("conf"), decisionId, institutionId, decidedBy ?? null, note ?? null, now);
    } catch (e) {
      if (isConstraint(e)) fail(409, "already_confirmed", "该机构已确认过");
      throw e;
    }
    const done = db.prepare(`SELECT COUNT(DISTINCT institution_id) AS n FROM merge_confirmations WHERE decision_id = ?`).get(decisionId).n;
    if (done >= required.length) {
      if (dec.decision === "merge") applyMerge(db, decisionId, now);
      else applySplit(db, decisionId, now);
    }
    return getDecision(ctx, decisionId);
  });
  return tx();
}

// ---------------------------------------------------------------------------
// 快照：发布 / 重建 / 下钻 / 差异
// ---------------------------------------------------------------------------

function mergedAwayMap(db, knowledge) {
  const map = new Map();
  const rows = db.prepare(
    `SELECT d.id AS decision_id, d.target_work_id, d.applied_at, c.work_a_id, c.work_b_id
     FROM merge_decisions d JOIN duplicate_candidates c ON c.id = d.candidate_id
     WHERE d.status = 'applied' AND d.decision = 'merge' AND d.applied_at <= ?`,
  ).all(knowledge);
  for (const r of rows) {
    const src = r.work_a_id === r.target_work_id ? r.work_b_id : r.work_a_id;
    map.set(src, { target: r.target_work_id, decision_id: r.decision_id, applied_at: r.applied_at });
  }
  return map;
}

// 以当前知识（knowledge = now）计算截止 cutoff 的可见度
export function computeSnapshot(ctx, cutoff) {
  const db = ctx.db;
  const knowledge = ctx.now();
  const merged = mergedAwayMap(db, knowledge);
  const owners = new Map();
  for (const r of db.prepare(
    `SELECT matched_work_id, institution_id FROM source_records WHERE matched_work_id IS NOT NULL ORDER BY received_at ASC, id ASC`,
  ).all()) {
    if (!owners.has(r.matched_work_id)) owners.set(r.matched_work_id, r.institution_id);
  }
  const entries = [];
  for (const w of db.prepare(`SELECT * FROM works ORDER BY created_at, id`).all()) {
    const v = adoptedVersion(db, w.id, cutoff, knowledge);
    if (!v) continue; // 截止时无任何生效版本
    let included = 1;
    let reason = null;
    if (merged.has(w.id)) {
      included = 0;
      reason = "merged_duplicate";
    } else if (v.status === "retracted") {
      included = 0;
      reason = "retracted";
    } else if (!v.is_open_access) {
      included = 0;
      reason = "not_open_access";
    }
    entries.push({
      work_id: w.id,
      work_version_id: v.id,
      included,
      exclusion_reason: reason,
      owner: owners.get(w.id) ?? null,
      output_type: v.output_type,
    });
  }
  const metrics = {
    cutoff_at: cutoff,
    works_total: entries.length,
    included: 0,
    excluded: 0,
    excluded_by_reason: {},
    included_by_institution: {},
    included_by_type: {},
  };
  for (const e of entries) {
    if (e.included) {
      metrics.included += 1;
      const owner = e.owner ?? "unknown";
      metrics.included_by_institution[owner] = (metrics.included_by_institution[owner] ?? 0) + 1;
      metrics.included_by_type[e.output_type] = (metrics.included_by_type[e.output_type] ?? 0) + 1;
    } else {
      metrics.excluded += 1;
      metrics.excluded_by_reason[e.exclusion_reason] = (metrics.excluded_by_reason[e.exclusion_reason] ?? 0) + 1;
    }
  }
  return { metrics, entries };
}

function insertSnapshotEntries(db, snapshotId, entries) {
  const ins = db.prepare(
    `INSERT INTO snapshot_entries (id, snapshot_id, work_id, work_version_id, included, exclusion_reason) VALUES (?,?,?,?,?,?)`,
  );
  for (const e of entries) ins.run(newId("se"), snapshotId, e.work_id, e.work_version_id, e.included, e.exclusion_reason);
}

export function publishSnapshot(ctx, { cutoffAt }) {
  checkIso(cutoffAt, "cutoff_at");
  const db = ctx.db;
  const existing = db.prepare(`SELECT id FROM snapshots WHERE cutoff_at = ? AND kind = 'published'`).get(cutoffAt);
  if (existing) fail(409, "snapshot_exists", "该截止时间已发布统计，不能抹改；可重建视图对比，或发布新的截止时间");
  const { metrics, entries } = computeSnapshot(ctx, cutoffAt);
  const now = ctx.now();
  const sid = newId("snap");
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO snapshots (id, cutoff_at, kind, metrics, created_at) VALUES (?,?, 'published', ?, ?)`)
      .run(sid, cutoffAt, JSON.stringify(metrics), now);
    insertSnapshotEntries(db, sid, entries);
    // 每次发布生成一条带幂等键的下游更新
    db.prepare(
      `INSERT INTO downstream_updates (id, idempotency_key, snapshot_id, target, payload, status, created_at)
       VALUES (?,?,?,?,?,'pending',?)`,
    ).run(newId("du"), `${sid}:visibility_report`, sid, "visibility_report", JSON.stringify({ snapshot_id: sid, cutoff_at: cutoffAt, metrics }), now);
  });
  tx();
  return getSnapshot(ctx, sid);
}

export function rebuildSnapshot(ctx, { cutoffAt }) {
  checkIso(cutoffAt, "cutoff_at");
  const db = ctx.db;
  const { metrics, entries } = computeSnapshot(ctx, cutoffAt);
  const now = ctx.now();
  const tx = db.transaction(() => {
    const old = db.prepare(`SELECT id FROM snapshots WHERE cutoff_at = ? AND kind = 'rebuilt'`).get(cutoffAt);
    if (old) {
      db.prepare(`DELETE FROM snapshot_entries WHERE snapshot_id = ?`).run(old.id);
      db.prepare(`DELETE FROM snapshots WHERE id = ?`).run(old.id);
    }
    const sid = newId("snap");
    db.prepare(`INSERT INTO snapshots (id, cutoff_at, kind, metrics, created_at) VALUES (?,?, 'rebuilt', ?, ?)`)
      .run(sid, cutoffAt, JSON.stringify(metrics), now);
    insertSnapshotEntries(db, sid, entries);
    return sid;
  });
  const sid = tx();
  const snap = getSnapshot(ctx, sid);
  const published = db.prepare(`SELECT id FROM snapshots WHERE cutoff_at = ? AND kind = 'published'`).get(cutoffAt);
  snap.published_snapshot_id = published?.id ?? null;
  return snap;
}

export function listSnapshots(ctx) {
  return ctx.db.prepare(`SELECT * FROM snapshots ORDER BY created_at DESC, id`).all()
    .map((s) => ({ ...s, metrics: parseJson(s.metrics, {}) }));
}

export function getSnapshot(ctx, id) {
  const s = ctx.db.prepare(`SELECT * FROM snapshots WHERE id = ?`).get(id);
  if (!s) fail(404, "snapshot_not_found", `快照 ${id} 不存在`);
  return { ...s, metrics: parseJson(s.metrics, {}) };
}

export function getSnapshotEntries(ctx, id, { included, workId } = {}) {
  getSnapshot(ctx, id);
  let sql = `SELECT * FROM snapshot_entries WHERE snapshot_id = ?`;
  const args = [id];
  if (included === 0 || included === 1) {
    sql += ` AND included = ?`;
    args.push(included);
  }
  if (workId) {
    sql += ` AND work_id = ?`;
    args.push(workId);
  }
  sql += ` ORDER BY work_id`;
  return ctx.db.prepare(sql).all(...args);
}

function explainWork(db, workId, windowFrom, windowTo) {
  const causes = [];
  const w = db.prepare(`SELECT created_at FROM works WHERE id = ?`).get(workId);
  if (w && w.created_at > windowFrom && w.created_at <= windowTo) {
    causes.push({ type: "registered", at: w.created_at, detail: "成果进入账簿" });
  }
  for (const v of db.prepare(
    `SELECT version_no, change_reason, status, recorded_at, source_record_id, merge_decision_id
     FROM work_versions WHERE work_id = ? AND recorded_at > ? AND recorded_at <= ? ORDER BY version_no`,
  ).all(workId, windowFrom, windowTo)) {
    causes.push({
      type: "version",
      at: v.recorded_at,
      detail: `v${v.version_no} ${v.change_reason}${v.status === "retracted" ? "（撤回）" : ""}`,
      source_record_id: v.source_record_id,
      merge_decision_id: v.merge_decision_id,
    });
  }
  for (const d of db.prepare(
    `SELECT d.id, d.decision, d.target_work_id, d.applied_at, c.work_a_id, c.work_b_id
     FROM merge_decisions d JOIN duplicate_candidates c ON c.id = d.candidate_id
     WHERE d.status = 'applied' AND d.applied_at > ? AND d.applied_at <= ? AND (c.work_a_id = ? OR c.work_b_id = ?)`,
  ).all(windowFrom, windowTo, workId, workId)) {
    const other = d.work_a_id === workId ? d.work_b_id : d.work_a_id;
    causes.push({
      type: d.decision,
      at: d.applied_at,
      detail: d.decision === "merge" ? (d.target_work_id === workId ? `吸收 ${other}` : `并入 ${d.target_work_id}`) : "确认非重复",
      decision_id: d.id,
    });
  }
  causes.sort((x, y) => (x.at < y.at ? -1 : 1));
  if (causes.length === 0) causes.push({ type: "cutoff_advance", detail: "截止时间推进导致的差异" });
  return causes;
}

function metricsDelta(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const va = a?.[k];
    const vb = b?.[k];
    if (typeof va === "number" || typeof vb === "number") {
      if ((va ?? 0) !== (vb ?? 0)) out[k] = { from: va ?? 0, to: vb ?? 0, delta: (vb ?? 0) - (va ?? 0) };
    } else if (va && vb && typeof va === "object" && typeof vb === "object") {
      const sub = metricsDelta(va, vb);
      if (Object.keys(sub).length) out[k] = sub;
    } else if (JSON.stringify(va ?? null) !== JSON.stringify(vb ?? null)) {
      out[k] = { from: va ?? null, to: vb ?? null };
    }
  }
  return out;
}

export function diffSnapshots(ctx, { fromId, toId }) {
  if (!fromId || !toId) fail(400, "invalid_diff", "需提供 from 与 to 两个快照 id");
  const db = ctx.db;
  const from = getSnapshot(ctx, fromId);
  const to = getSnapshot(ctx, toId);
  const fromEntries = new Map(getSnapshotEntries(ctx, fromId).map((e) => [e.work_id, e]));
  const toEntries = new Map(getSnapshotEntries(ctx, toId).map((e) => [e.work_id, e]));
  const items = [];
  for (const wid of [...new Set([...fromEntries.keys(), ...toEntries.keys()])].sort()) {
    const a = fromEntries.get(wid);
    const b = toEntries.get(wid);
    if (a && b && a.work_version_id === b.work_version_id && a.included === b.included && a.exclusion_reason === b.exclusion_reason) continue;
    items.push({
      work_id: wid,
      change: !a ? "added" : !b ? "removed" : "changed",
      from: a ? { work_version_id: a.work_version_id, included: !!a.included, exclusion_reason: a.exclusion_reason } : null,
      to: b ? { work_version_id: b.work_version_id, included: !!b.included, exclusion_reason: b.exclusion_reason } : null,
      causes: explainWork(db, wid, from.created_at, to.created_at),
    });
  }
  return {
    from: { id: from.id, cutoff_at: from.cutoff_at, kind: from.kind, created_at: from.created_at },
    to: { id: to.id, cutoff_at: to.cutoff_at, kind: to.kind, created_at: to.created_at },
    metrics_delta: metricsDelta(from.metrics, to.metrics),
    items,
  };
}

// ---------------------------------------------------------------------------
// 下游更新：幂等应用，失败恢复不重复计数
// ---------------------------------------------------------------------------

export function listDownstreamUpdates(ctx, { status } = {}) {
  if (status) return ctx.db.prepare(`SELECT * FROM downstream_updates WHERE status = ? ORDER BY created_at`).all(status);
  return ctx.db.prepare(`SELECT * FROM downstream_updates ORDER BY created_at`).all();
}

export function applyDownstreamUpdate(ctx, { updateId, simulateFailure = false }) {
  const db = ctx.db;
  const now = ctx.now();
  // 计数器与更新状态在同一事务提交：失败不留半成品，恢复重试恰好一次
  const result = db.transaction(() => {
    const u = db.prepare(`SELECT * FROM downstream_updates WHERE id = ?`).get(updateId);
    if (!u) return { notFound: true };
    if (u.status === "applied") return { already: true };
    db.prepare(`UPDATE downstream_updates SET attempts = attempts + 1 WHERE id = ?`).run(updateId);
    if (simulateFailure) {
      db.prepare(`UPDATE downstream_updates SET status = 'failed', last_error = ? WHERE id = ?`).run("下游接口模拟失败", updateId);
      return { failed: true };
    }
    const payload = parseJson(u.payload, {});
    const metrics = payload.metrics ?? {};
    for (const key of DOWNSTREAM_COUNTERS) {
      db.prepare(
        `INSERT INTO downstream_stats (target, metric, value) VALUES (?,?,?)
         ON CONFLICT(target, metric) DO UPDATE SET value = value + excluded.value`,
      ).run(u.target, key, Number(metrics[key] ?? 0));
    }
    db.prepare(`UPDATE downstream_updates SET status = 'applied', applied_at = ?, last_error = NULL WHERE id = ?`).run(now, updateId);
    return { ok: true };
  })();
  if (result.notFound) fail(404, "update_not_found", `下游更新 ${updateId} 不存在`);
  if (result.failed) fail(502, "downstream_failed", "下游更新失败，已记录失败状态；恢复后重试不会重复计数");
  return {
    update: db.prepare(`SELECT * FROM downstream_updates WHERE id = ?`).get(updateId),
    already_applied: !!result.already,
  };
}

export function recoverDownstream(ctx) {
  const failed = ctx.db.prepare(`SELECT id FROM downstream_updates WHERE status = 'failed' ORDER BY created_at`).all();
  const recovered = [];
  for (const { id } of failed) {
    const r = applyDownstreamUpdate(ctx, { updateId: id });
    if (!r.already_applied) recovered.push(id);
  }
  return { recovered_count: recovered.length, recovered };
}

export function getDownstreamStats(ctx) {
  return ctx.db.prepare(`SELECT * FROM downstream_stats ORDER BY target, metric`).all();
}

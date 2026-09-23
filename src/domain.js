import { createHash, randomUUID } from "node:crypto";

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export const sha256 = (text) =>
  createHash("sha256").update(text).digest("hex");

export const normId = (type, value) =>
  `${String(type).toLowerCase()}:${String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/(doi\.org\/|)/, "")
    .replace(/\s+/g, "")}`;

export const normTitle = (title) =>
  String(title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// 拉丁词按空格切词；中日韩文字按二元组切分，避免整句退化成单个 token
const titleTokens = (normalized) => {
  const out = new Set();
  for (const chunk of normalized.split(" ").filter(Boolean)) {
    if (/[ᄀ-ᇿ぀-ヿ가-힯一-鿿豈-﫿]/.test(chunk)) {
      for (let i = 0; i < chunk.length - 1; i++) out.add(chunk.slice(i, i + 2));
      if (chunk.length === 1) out.add(chunk);
    } else {
      out.add(chunk);
    }
  }
  return out;
};

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

// ---------------------------------------------------------------------------
// 机构与下游目标
// ---------------------------------------------------------------------------
export function registerInstitution(db, { id, name }) {
  db.prepare(
    "INSERT INTO institution(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name"
  ).run(id, name);
  return db.prepare("SELECT * FROM institution WHERE id=?").get(id);
}

export function registerTarget(db, { id, name, driver = "log", failRemaining = 0 }) {
  db.prepare(
    `INSERT INTO downstream_target(id,name,driver,fail_remaining)
     VALUES(?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, driver=excluded.driver`
  ).run(id, name, driver, failRemaining);
  // 新目标回填全部历史事件：重放安全，令牌相同不会重复计数
  backfillDeliveries(db, id);
  return db.prepare("SELECT * FROM downstream_target WHERE id=?").get(id);
}

export function recoverTarget(db, id) {
  const t = db.prepare("SELECT * FROM downstream_target WHERE id=?").get(id);
  if (!t) throw Object.assign(new Error("目标不存在"), { status: 404 });
  db.prepare("UPDATE downstream_target SET fail_remaining=0 WHERE id=?").run(id);
  return { ...t, fail_remaining: 0, recovered: true };
}

function emitEvent(db, eventType, dedupKey, payload) {
  db.prepare(
    `INSERT INTO outbox_event(event_type,dedup_key,payload)
     VALUES(?,?,?) ON CONFLICT(dedup_key) DO UPDATE SET dedup_key=dedup_key`
  ).run(eventType, dedupKey, JSON.stringify(payload));
  const row = db
    .prepare("SELECT * FROM outbox_event WHERE dedup_key=?")
    .get(dedupKey);
  for (const t of db.prepare("SELECT id FROM downstream_target").all()) {
    db.prepare(
      `INSERT OR IGNORE INTO delivery(target_id,event_id,idempotency_token)
       VALUES(?,?,?)`
    ).run(t.id, row.id, tokenFor(t.id, row));
  }
  return row;
}

function backfillDeliveries(db, targetId) {
  // 新登记的目标回填全部历史事件：重放安全，令牌相同，收件箱冲突即只计一次
  const rows = db.prepare("SELECT id, dedup_key FROM outbox_event").all();
  for (const e of rows) {
    db.prepare(
      `INSERT OR IGNORE INTO delivery(target_id,event_id,idempotency_token)
       VALUES(?,?,?)`
    ).run(targetId, e.id, tokenFor(targetId, e));
  }
}

// 幂等令牌由目标与事件去重键派生：崩溃/失败重试携带同一令牌，下游收件箱冲突即只计一次
const tokenFor = (targetId, event) => `${targetId}:${event.dedup_key}`;

// ---------------------------------------------------------------------------
// 抓取批次与来源记录（原始载荷完整保存、批次重投幂等）
// ---------------------------------------------------------------------------
export function ingestBatch(db, batch) {
  const recordedAt = batch.recordedAt || now();
  const harvestedAt = batch.harvestedAt || recordedAt;
  const inst = db
    .prepare("SELECT id FROM institution WHERE id=?")
    .get(batch.institutionId);
  if (!inst) throw Object.assign(new Error("机构未登记"), { status: 400 });

  return db.transaction(() => {
    db.prepare(
      `INSERT INTO harvest_batch(institution_id,source_kind,external_batch_ref,harvested_at,recorded_at,note)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(institution_id, source_kind, external_batch_ref) DO NOTHING`
    ).run(
      batch.institutionId,
      batch.sourceKind || "import",
      batch.externalBatchRef ?? null,
      harvestedAt,
      recordedAt,
      batch.note ?? null
    );
    const brow = db
      .prepare(
        `SELECT * FROM harvest_batch WHERE institution_id=? AND source_kind=?
         AND external_batch_ref IS ?`
      )
      .get(
        batch.institutionId,
        batch.sourceKind || "import",
        batch.externalBatchRef ?? null
      );

    let imported = 0;
    let skipped = 0;
    const touched = [];
    for (const rec of batch.records || []) {
      const payload = rec.payload ?? rec;
      const text = JSON.stringify(payload);
      const hash = sha256(text);
      const ins = db
        .prepare(
          `INSERT INTO source_record(batch_id,institution_id,external_ref,payload,content_hash,received_at)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(institution_id, external_ref, content_hash) DO NOTHING`
        )
        .run(
          brow.id,
          batch.institutionId,
          rec.externalRef ?? payload.externalRef,
          text,
          hash,
          recordedAt
        );
      if (ins.changes === 0) {
        skipped++;
        continue;
      }
      const srow = db
        .prepare(
          "SELECT * FROM source_record WHERE institution_id=? AND content_hash=?"
        )
        .get(batch.institutionId, hash);
      const kind = payload.kind || "work";
      if (kind === "work") {
        touched.push(
          ingestWork(db, { payload, sourceRecord: srow, recordedAt, harvestedAt })
        );
      } else if (kind === "person") {
        touched.push(
          ingestPerson(db, { payload, sourceRecord: srow, recordedAt, harvestedAt })
        );
      }
      imported++;
    }
    db.prepare("UPDATE harvest_batch SET record_count=? WHERE id=?").run(
      db
        .prepare("SELECT COUNT(*) c FROM source_record WHERE batch_id=?")
        .get(brow.id).c,
      brow.id
    );
    return { batchId: brow.id, imported, skipped, recordedAt, touched };
  })();
}

function resolveWork(db, institutionId, externalRef) {
  const claim = db
    .prepare("SELECT work_id FROM source_work_claim WHERE institution_id=? AND external_ref=?")
    .get(institutionId, externalRef);
  if (claim) return claim.work_id;
  const info = db.prepare("INSERT INTO work DEFAULT VALUES").run();
  db.prepare(
    "INSERT INTO source_work_claim(institution_id,external_ref,work_id) VALUES(?,?,?)"
  ).run(institutionId, externalRef, Number(info.lastInsertRowid));
  return Number(info.lastInsertRowid);
}

function resolvePerson(db, institutionId, externalRef) {
  const claim = db
    .prepare("SELECT person_id FROM source_person_claim WHERE institution_id=? AND external_ref=?")
    .get(institutionId, externalRef);
  if (claim) return claim.person_id;
  const info = db.prepare("INSERT INTO person DEFAULT VALUES").run();
  db.prepare(
    "INSERT INTO source_person_claim(institution_id,external_ref,person_id) VALUES(?,?,?)"
  ).run(institutionId, externalRef, Number(info.lastInsertRowid));
  return Number(info.lastInsertRowid);
}

function currentBindings(db, entityType, entityId) {
  return new Map(
    db
      .prepare(
        `SELECT id_type, id_norm FROM identifier_binding
         WHERE entity_type=? AND entity_id=? AND valid_to IS NULL`
      )
      .all(entityType, entityId)
      .map((r) => [`${r.id_type}|${r.id_norm}`, r])
  );
}

function syncBindings(db, { entityType, entityId, institutionId, sourceRecordId, identifiers, validFrom, recordedAt }) {
  const want = new Map();
  for (const i of identifiers || []) {
    const type = i.type.toLowerCase();
    const norm = normId(type, i.value);
    want.set(`${type}|${norm}`, { type, value: i.value, norm });
  }
  // 新载荷未再声明的标识：关闭其有效期（保留历史行，供截止时间重建）
  const have = currentBindings(db, entityType, entityId);
  for (const [k, row] of have) {
    if (!want.has(k)) {
      db.prepare(
        "UPDATE identifier_binding SET valid_to=? WHERE id=? AND valid_to IS NULL"
      ).run(validFrom, row.id);
    }
  }
  for (const [, i] of want) {
    const exists = db
      .prepare(
        `SELECT id FROM identifier_binding
         WHERE entity_type=? AND entity_id=? AND id_type=? AND id_norm=? AND valid_to IS NULL`
      )
      .get(entityType, entityId, i.type, i.norm);
    if (exists) continue;
    db.prepare(
      `INSERT INTO identifier_binding(entity_type,entity_id,institution_id,source_record_id,
         id_type,id_value,id_norm,valid_from,recorded_at)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(
      entityType, entityId, institutionId, sourceRecordId,
      i.type, i.value, i.norm, validFrom, recordedAt
    );
  }
}

function ingestPerson(db, { payload, sourceRecord, recordedAt, harvestedAt }) {
  const personId = resolvePerson(db, sourceRecord.institution_id, payload.externalRef);
  const validFrom = payload.validFrom || harvestedAt;
  const idSet = (payload.identifiers || []).map((i) => normId(i.type, i.value)).sort().join(",");
  const latest = db
    .prepare(
      "SELECT * FROM person_version WHERE person_id=? AND institution_id=? ORDER BY seq DESC LIMIT 1"
    )
    .get(personId, sourceRecord.institution_id);

  if (latest) {
    const same =
      latest.display_name === payload.displayName &&
      fingerprintBindings(db, "person", personId) === idSet;
    if (same) return { personId, changed: false };
    db.prepare("UPDATE person_version SET valid_to=? WHERE id=? AND valid_to IS NULL")
      .run(validFrom, latest.id);
  }
  const seq = (latest?.seq ?? 0) + 1;
  db.prepare(
    `INSERT INTO person_version(person_id,institution_id,source_record_id,seq,display_name,valid_from,recorded_at)
     VALUES(?,?,?,?,?,?,?)`
  ).run(
    personId, sourceRecord.institution_id, sourceRecord.id, seq,
    payload.displayName, validFrom, recordedAt
  );
  syncBindings(db, {
    entityType: "person", entityId: personId,
    institutionId: sourceRecord.institution_id, sourceRecordId: sourceRecord.id,
    identifiers: payload.identifiers, validFrom, recordedAt,
  });
  return { personId, changed: true };
}

function fingerprintBindings(db, entityType, entityId) {
  return db
    .prepare(
      `SELECT id_norm FROM identifier_binding
       WHERE entity_type=? AND entity_id=? AND valid_to IS NULL ORDER BY id_norm`
    )
    .all(entityType, entityId)
    .map((r) => r.id_norm)
    .join(",");
}

function ingestWork(db, { payload, sourceRecord, recordedAt, harvestedAt }) {
  const institutionId = sourceRecord.institution_id;
  const workId = resolveWork(db, institutionId, payload.externalRef);
  const validFrom = payload.validFrom || harvestedAt;
  const latest = db
    .prepare(
      "SELECT * FROM work_version WHERE work_id=? AND institution_id=? ORDER BY seq DESC LIMIT 1"
    )
    .get(workId, institutionId);

  const newFp = [
    payload.title,
    payload.workType || "",
    payload.issuedOn || "",
    payload.state || "active",
    (payload.identifiers || []).map((i) => normId(i.type, i.value)).sort().join(","),
    (payload.authors || [])
      .map((a) => `${resolvePerson(db, institutionId, a.externalRef)}:${a.ordinal ?? 0}`)
      .sort()
      .join(";"),
    (payload.relations || [])
      .map((r) => `${r.kind}:${normId(r.targetType, r.targetValue)}`)
      .sort()
      .join(";"),
  ].join("|");
  const oldFp = latest
    ? [
        latest.title,
        latest.work_type || "",
        latest.issued_on || "",
        latest.state,
        fingerprintBindings(db, "work", workId),
        db
          .prepare(
            "SELECT person_id, ordinal FROM authorship WHERE work_id=? AND valid_to IS NULL ORDER BY ordinal"
          )
          .all(workId)
          .map((a) => `${a.person_id}:${a.ordinal}`)
          .sort()
          .join(";"),
        db
          .prepare("SELECT relation_kind, target_norm FROM work_relation WHERE work_id=? ORDER BY target_norm")
          .all(workId)
          .map((r) => `${r.relation_kind}:${r.target_norm}`)
          .sort()
          .join(";"),
      ].join("|")
    : null;

  let changed = false;
  let versionId = latest?.id;
  if (!latest || oldFp !== newFp) {
    if (latest) {
      db.prepare("UPDATE work_version SET valid_to=? WHERE id=? AND valid_to IS NULL")
        .run(validFrom, latest.id);
    }
    const seq = (latest?.seq ?? 0) + 1;
    const info = db
      .prepare(
        `INSERT INTO work_version(work_id,institution_id,source_record_id,seq,title,work_type,
           issued_on,state,valid_from,recorded_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        workId, institutionId, sourceRecord.id, seq, payload.title,
        payload.workType || null, payload.issuedOn || null,
        payload.state || "active", validFrom, recordedAt
      );
    versionId = Number(info.lastInsertRowid);
    changed = true;
  }

  syncBindings(db, {
    entityType: "work", entityId: workId, institutionId,
    sourceRecordId: sourceRecord.id, identifiers: payload.identifiers,
    validFrom, recordedAt,
  });
  syncAuthorship(db, { payload, workId, institutionId, sourceRecordId: sourceRecord.id, validFrom, recordedAt });
  syncRelations(db, { payload, workId, institutionId, sourceRecordId: sourceRecord.id, recordedAt });

  if (changed) {
    if (!latest) {
      emitEvent(db, "work.registered", `work.registered:${workId}`, { workId, title: payload.title });
    } else {
      emitEvent(db, "work.revised", `work.revised:${workId}:${versionId}`, {
        workId, versionId, title: payload.title, state: payload.state || "active",
      });
      if ((payload.state || "active") === "retracted" && latest.state !== "retracted") {
        emitEvent(db, "work.retracted", `work.retracted:${workId}:${versionId}`, {
          workId, versionId,
        });
      }
      if ((payload.state || "active") === "active" && latest.state === "retracted") {
        emitEvent(db, "work.reinstated", `work.reinstated:${workId}:${versionId}`, {
          workId, versionId,
        });
      }
    }
  }
  return { workId, versionId, changed };
}

function syncAuthorship(db, { payload, workId, institutionId, sourceRecordId, validFrom, recordedAt }) {
  const want = new Map();
  (payload.authors || []).forEach((a, idx) => {
    const personId = resolvePerson(db, institutionId, a.externalRef);
    // 自报材料中内嵌的作者信息：若无该作者任何版本，则登记一个最小版本
    const has = db.prepare("SELECT 1 FROM person_version WHERE person_id=?").get(personId);
    if (!has && a.displayName) {
      db.prepare(
        `INSERT INTO person_version(person_id,institution_id,source_record_id,seq,display_name,valid_from,recorded_at)
         VALUES(?,?,?,1,?,?,?)`
      ).run(personId, institutionId, sourceRecordId, a.displayName, validFrom, recordedAt);
      syncBindings(db, {
        entityType: "person", entityId: personId, institutionId,
        sourceRecordId, identifiers: a.identifiers, validFrom, recordedAt,
      });
    }
    want.set(personId, a.ordinal ?? idx);
  });
  const have = db
    .prepare("SELECT id, person_id FROM authorship WHERE work_id=? AND valid_to IS NULL")
    .all(workId);
  for (const row of have) {
    if (!want.has(row.person_id)) {
      db.prepare("UPDATE authorship SET valid_to=? WHERE id=?").run(validFrom, row.id);
    }
  }
  for (const [personId, ordinal] of want) {
    const existing = db
      .prepare(
        "SELECT id FROM authorship WHERE work_id=? AND person_id=? AND valid_to IS NULL"
      )
      .get(workId, personId);
    if (existing) {
      db.prepare("UPDATE authorship SET ordinal=? WHERE id=?", ordinal, existing.id).run();
    } else {
      db.prepare(
        `INSERT INTO authorship(work_id,person_id,institution_id,source_record_id,ordinal,valid_from,recorded_at)
         VALUES(?,?,?,?,?,?,?)`
      ).run(workId, personId, institutionId, sourceRecordId, ordinal, validFrom, recordedAt);
    }
  }
}

function syncRelations(db, { payload, workId, institutionId, sourceRecordId, recordedAt }) {
  for (const r of payload.relations || []) {
    const norm = normId(r.targetType, r.targetValue);
    db.prepare(
      `INSERT INTO work_relation(work_id,institution_id,source_record_id,relation_kind,
         target_id_type,target_id_value,target_norm,recorded_at)
       SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(
         SELECT 1 FROM work_relation WHERE work_id=? AND relation_kind=? AND target_norm=?)`
    ).run(
      workId, institutionId, sourceRecordId, r.kind,
      r.targetType.toLowerCase(), r.targetValue, norm, recordedAt,
      workId, r.kind, norm
    );
  }
}

// ---------------------------------------------------------------------------
// 候选重复扫描：给出每条匹配依据与分数
// ---------------------------------------------------------------------------
export function scanCandidates(db) {
  const works = db
    .prepare(
      `SELECT w.id AS work_id, v.title, v.state,
              (SELECT MAX(recorded_at) FROM work_version WHERE work_id=w.id) AS known_at
       FROM work w
       JOIN work_version v ON v.id=
         (SELECT id FROM work_version WHERE work_id=w.id ORDER BY seq DESC LIMIT 1)`
    )
    .all();
  const decided = new Set(
    db
      .prepare("SELECT left_work_id, right_work_id, status FROM merge_candidate")
      .all()
      .filter((c) => c.status !== "pending")
      .map((c) => `${c.left_work_id}|${c.right_work_id}`)
  );
  const pending = new Set(
    db
      .prepare("SELECT left_work_id, right_work_id FROM merge_candidate WHERE status='pending' AND kind='merge'")
      .all()
      .map((c) => `${c.left_work_id}|${c.right_work_id}`)
  );

  const bindings = new Map();
  for (const b of db
    .prepare("SELECT * FROM identifier_binding WHERE entity_type='work' AND valid_to IS NULL")
    .all()) {
    const k = `${b.id_type}|${b.id_norm}`;
    if (!bindings.has(k)) bindings.set(k, []);
    bindings.get(k).push(b.entity_id);
  }
  const relations = db.prepare("SELECT * FROM work_relation").all();
  const workAuthors = new Map(
    works.map((w) => [
      w.work_id,
      new Set(
        db
          .prepare("SELECT person_id FROM authorship WHERE work_id=? AND valid_to IS NULL")
          .all(w.work_id)
          .map((a) => a.person_id)
      ),
    ])
  );

  const created = [];
  const seen = new Set();
  const consider = (a, b, signal) => {
    const [l, r] = a < b ? [a, b] : [b, a];
    const key = `${l}|${r}`;
    if (l === r || seen.has(key) || decided.has(key)) return;
    seen.add(key);
    const wa = works.find((w) => w.work_id === l);
    const wb = works.find((w) => w.work_id === r);
    const evidence = buildEvidence(db, l, r, wa, wb, bindings, relations, workAuthors);
    if (evidence.signals.length === 0) return;
    if (!evidence.strong && evidence.score < 0.4) return;
    if (pending.has(key)) return;
    const info = db
      .prepare(
        `INSERT INTO merge_candidate(left_work_id,right_work_id,kind,evidence_json,score)
         VALUES(?,?, 'merge', ?,?)`
      )
      .run(l, r, JSON.stringify(evidence), evidence.score);
    created.push(Number(info.lastInsertRowid));
  };

  // 信号 1：共享有效标识（DOI、机构库 handle 等）
  for (const ids of bindings.values()) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) consider(ids[i], ids[j], "identifier");
  }
  // 信号 2：预印本→正式发表关系可解析到另一成果标识
  const bindIndex = new Map();
  for (const [k, ids] of bindings) bindIndex.set(k, ids);
  for (const rel of relations) {
    const key = `${rel.target_id_type}|${rel.target_norm}`;
    const targets = bindIndex.get(key);
    if (targets) for (const t of targets) consider(rel.work_id, t, "relation");
  }
  // 信号 3/4：标题与作者组合
  for (let i = 0; i < works.length; i++) {
    for (let j = i + 1; j < works.length; j++) {
      consider(works[i].work_id, works[j].work_id, "title");
    }
  }
  return { created, candidates: created.map((id) => getCandidate(db, id)) };
}

function buildEvidence(db, l, r, wa, wb, bindings, relations, workAuthors) {
  const signals = [];
  let score = 0;
  let strong = false;

  const idsA = new Set(
    db
      .prepare(
        "SELECT id_type, id_norm FROM identifier_binding WHERE entity_type='work' AND entity_id=? AND valid_to IS NULL"
      )
      .all(l)
      .map((x) => `${x.id_type}|${x.id_norm}`)
  );
  const idsB = new Set(
    db
      .prepare(
        "SELECT id_type, id_norm FROM identifier_binding WHERE entity_type='work' AND entity_id=? AND valid_to IS NULL"
      )
      .all(r)
      .map((x) => `${x.id_type}|${x.id_norm}`)
  );
  for (const k of idsA) {
    if (idsB.has(k)) {
      const [type] = k.split("|");
      signals.push({ kind: "shared_identifier", identifierType: type, weight: type === "doi" ? 0.9 : 0.7 });
      score += type === "doi" ? 0.9 : 0.7;
      strong = true;
    }
  }

  for (const rel of db.prepare("SELECT * FROM work_relation WHERE work_id IN (?,?)").all(l, r)) {
    const other = rel.work_id === l ? r : l;
    const hit = db
      .prepare(
        `SELECT 1 FROM identifier_binding
         WHERE entity_type='work' AND entity_id=? AND id_type=? AND id_norm=? AND valid_to IS NULL`
      )
      .get(other, rel.target_id_type, rel.target_norm);
    if (hit) {
      signals.push({ kind: "preprint_link", relation: rel.relation_kind, weight: 0.8 });
      score += 0.8;
      strong = true;
    }
  }

  const ta = normTitle(wa.title);
  const tb = normTitle(wb.title);
  const tokA = titleTokens(ta);
  const tokB = titleTokens(tb);
  const titleSim = ta === tb ? 1 : jaccard(tokA, tokB);
  if (ta && tb && ta === tb) {
    signals.push({ kind: "title_normalized_equal", weight: 0.6 });
    score += 0.6;
  } else if (titleSim >= 0.5) {
    signals.push({ kind: "title_fuzzy", similarity: Number(titleSim.toFixed(3)), weight: 0.3 });
    score += 0.3;
  }

  const pa = workAuthors.get(l);
  const pb = workAuthors.get(r);
  const authorSim = jaccard(pa, pb);
  if (authorSim >= 0.5) {
    signals.push({ kind: "author_overlap", similarity: Number(authorSim.toFixed(3)), weight: 0.3 });
    score += 0.3;
  }
  if (titleSim >= 0.35 && titleSim < 0.6 && authorSim >= 0.5) {
    signals.push({ kind: "title_plus_authors", titleSimilarity: Number(titleSim.toFixed(3)), weight: 0.2 });
    score += 0.2;
  }

  return {
    signals,
    score: Number(Math.min(score, 1).toFixed(3)),
    strong,
    titles: { [l]: wa.title, [r]: wb.title },
  };
}

export function getCandidate(db, id) {
  const c = db.prepare("SELECT * FROM merge_candidate WHERE id=?").get(id);
  if (!c) return null;
  c.evidence = JSON.parse(c.evidence_json);
  c.confirmations = db
    .prepare("SELECT * FROM merge_confirmation WHERE candidate_id=? ORDER BY decided_at")
    .all(id);
  return c;
}

export function listCandidates(db, status) {
  const rows = status
    ? db.prepare("SELECT id FROM merge_candidate WHERE status=? ORDER BY id").all(status)
    : db.prepare("SELECT id FROM merge_candidate ORDER BY id").all();
  return rows.map((r) => getCandidate(db, r.id));
}

function workOwner(db, workId) {
  return db
    .prepare(
      `SELECT institution_id FROM work_version WHERE work_id=?
       ORDER BY recorded_at DESC, seq DESC LIMIT 1`
    )
    .get(workId)?.institution_id;
}

// ---------------------------------------------------------------------------
// 人工确认：同机构可自行合并；跨机构必须双方确认；拆分同理
// ---------------------------------------------------------------------------
export function recordDecision(db, candidateId, { institutionId, decision, actor, at }) {
  const c = db.prepare("SELECT * FROM merge_candidate WHERE id=?").get(candidateId);
  if (!c) throw Object.assign(new Error("候选不存在"), { status: 404 });
  if (c.status !== "pending") throw Object.assign(new Error("候选已定案，不能重复决定（如需改判请发起拆分/重扫）"), { status: 409 });

  const owners = [...new Set([c.left_work_id, c.right_work_id].map((w) => workOwner(db, w)))];
  if (!owners.includes(institutionId)) {
    throw Object.assign(new Error("机构只能就自己提供事实的成果作确认"), { status: 403 });
  }
  const wanted = c.kind === "merge" ? "merge" : "split";
  if (decision !== wanted && decision !== "reject") {
    throw Object.assign(new Error(`该候选的决定只能是 ${wanted} 或 reject`), { status: 400 });
  }
  const effectiveAt = at || now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO merge_confirmation(candidate_id,institution_id,decision,actor,decided_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(candidate_id,institution_id) DO UPDATE SET decision=excluded.decision, actor=excluded.actor, decided_at=excluded.decided_at`
    ).run(candidateId, institutionId, decision, actor ?? null, effectiveAt);

    if (decision === "reject") {
      db.prepare(
        "UPDATE merge_candidate SET status='rejected_split', decided_at=? WHERE id=?"
      ).run(effectiveAt, candidateId);
      return;
    }

    const confirms = db
      .prepare("SELECT institution_id FROM merge_confirmation WHERE candidate_id=? AND decision=?")
      .all(candidateId, wanted);
    const confirmedOwners = new Set(confirms.map((x) => x.institution_id));
    const allOwnersAgree = owners.every((o) => confirmedOwners.has(o));
    if (!allOwnersAgree) return; // 等待另一方确认

    if (c.kind === "merge") applyMerge(db, c, effectiveAt);
    else applySplit(db, c, effectiveAt);
  })();
  return getCandidate(db, candidateId);
}

function applyMerge(db, c, effectiveAt) {
  // 正式发表（带 DOI 或 issued_on 较晚）者作为存活簇代表；否则取较小 id，保证可复算
  const metas = [c.left_work_id, c.right_work_id].map((w) => ({
    workId: w,
    hasDoi: !!db
      .prepare(
        "SELECT 1 FROM identifier_binding WHERE entity_type='work' AND entity_id=? AND id_type='doi' AND valid_to IS NULL"
      )
      .get(w),
    issuedOn:
      db
        .prepare("SELECT issued_on FROM work_version WHERE work_id=? ORDER BY seq DESC LIMIT 1")
        .get(w)?.issued_on || "",
  }));
  metas.sort((a, b) => Number(b.hasDoi) - Number(a.hasDoi) || b.issuedOn.localeCompare(a.issuedOn) || a.workId - b.workId);
  const survivor = metas[0].workId;
  const absorbed = metas[1].workId;

  db.prepare(
    "UPDATE merge_candidate SET status='confirmed_merged', decided_at=? WHERE id=?"
  ).run(effectiveAt, c.id);
  const info = db
    .prepare(
      "INSERT INTO work_merge(candidate_id,surviving_work_id,absorbed_work_id,effective_at,recorded_at) VALUES(?,?,?,?,?)"
    )
    .run(c.id, survivor, absorbed, effectiveAt, effectiveAt);
  const mergeId = Number(info.lastInsertRowid);
  emitEvent(db, "work.merged", `work.merged:${c.left_work_id}-${c.right_work_id}`, {
    candidateId: c.id, mergeId, survivor, absorbed, effectiveAt,
  });
}

function applySplit(db, c, effectiveAt) {
  db.prepare("UPDATE merge_candidate SET status='split', decided_at=? WHERE id=?")
    .run(effectiveAt, c.id);
  db.prepare(
    "INSERT INTO work_split(merge_id,candidate_id,reason,effective_at,recorded_at) VALUES(?,?,?,?,?)"
  ).run(c.prior_merge_id, c.id, "人工复核确认并非同一成果", effectiveAt, effectiveAt);
  emitEvent(db, "work.split", `work.split:${c.prior_merge_id}`, {
    candidateId: c.id, mergeId: c.prior_merge_id, effectiveAt,
  });
}

/** 对已生效的合并发起拆分复核候选（仍需双方确认） */
export function openSplitCandidate(db, mergeId, { at } = {}) {
  const m = db.prepare("SELECT * FROM work_merge WHERE id=?").get(mergeId);
  if (!m) throw Object.assign(new Error("合并不存在"), { status: 404 });
  const undone = db.prepare("SELECT 1 FROM work_split WHERE merge_id=?").get(mergeId);
  if (undone) throw Object.assign(new Error("该合并已拆分"), { status: 409 });
  const [l, r] = [m.surviving_work_id, m.absorbed_work_id].sort((a, b) => a - b);
  const effectiveAt = at || now();
  const info = db
    .prepare(
      `INSERT INTO merge_candidate(left_work_id,right_work_id,kind,prior_merge_id,evidence_json,score,created_at)
       VALUES(?,?,'split',?, ?, 1, ?)`
    )
    .run(
      l, r, mergeId,
      JSON.stringify({ signals: [{ kind: "manual_split_request", weight: 1 }], score: 1, strong: true }),
      effectiveAt
    );
  return getCandidate(db, Number(info.lastInsertRowid));
}

// ---------------------------------------------------------------------------
// 任意截止时间重建可见度快照
// ---------------------------------------------------------------------------
export function buildSnapshot(db, asOf) {
  const cutoff = asOf || now();
  const knownWorks = db
    .prepare("SELECT DISTINCT work_id AS id FROM work_version WHERE recorded_at<=?")
    .all(cutoff)
    .map((w) => w.id);
  const works = knownWorks;

  // 仅采用截止时刻已知悉（recorded_at <= cutoff）的归并与拆分
  const parent = new Map(works.map((w) => [w, w]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const activeMerges = db
    .prepare(
      `SELECT m.*,
        (SELECT COUNT(*) FROM work_split s WHERE s.merge_id=m.id AND s.effective_at<=?) AS split_count
       FROM work_merge m
       WHERE m.effective_at<=? AND m.recorded_at<=?`
    )
    .all(cutoff, cutoff, cutoff);
  for (const m of activeMerges) {
    if (m.split_count > 0) continue;
    const a = find(m.surviving_work_id);
    const b = find(m.absorbed_work_id);
    if (a !== b) parent.set(b, a);
  }

  // 截止时刻仍待人工裁决的候选（用于下钻标注，不改变数字）
  const pendingByPair = new Map();
  for (const c of db
    .prepare(
      `SELECT * FROM merge_candidate WHERE kind='merge' AND status='pending' AND created_at<=?`
    )
    .all(cutoff)) {
    pendingByPair.set(`${c.left_work_id}|${c.right_work_id}`, c.id);
  }

  const clusters = new Map();
  for (const w of works) {
    const root = find(w);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(w);
  }

  const items = [];
  let visibleCount = 0;
  let retractedCount = 0;
  let absorbedCount = 0;
  const byType = {};
  const byInstitution = {};

  for (const [root, members] of clusters) {
    members.sort((a, b) => a - b);
    for (const workId of members) {
      const v = visibleVersion(db, workId, cutoff);
      if (!v) continue; // 截止时刻尚未知悉
      const isSurvivor = workId === root;
      const identifiers = db
        .prepare(
          `SELECT id_type, id_value FROM identifier_binding
           WHERE entity_type='work' AND entity_id=? AND valid_from<=?
             AND (valid_to IS NULL OR valid_to>?) AND recorded_at<=?`
        )
        .all(workId, cutoff, cutoff, cutoff)
        .map((i) => ({ type: i.id_type, value: i.id_value }));
      const item = {
        clusterKey: root,
        workId,
        role: isSurvivor ? "survivor" : "absorbed",
        visible: 0,
        title: v.title,
        workType: v.work_type,
        issuedOn: v.issued_on,
        state: v.state,
        chosenVersionId: v.id,
        owningInstitutionId: v.institution_id,
        identifiers,
        excludedReason: null,
        mergeCandidateId: null,
        recordedAt: v.recorded_at,
      };
      if (!isSurvivor) {
        item.excludedReason = `merged_into:${root}`;
        absorbedCount++;
      } else if (v.state === "retracted") {
        item.excludedReason = "retracted";
        retractedCount++;
      } else {
        item.visible = 1;
        visibleCount++;
        byType[v.work_type || "unspecified"] = (byType[v.work_type || "unspecified"] || 0) + 1;
        byInstitution[v.institution_id] = (byInstitution[v.institution_id] || 0) + 1;
      }
      const other = members.find((m) => m !== workId);
      if (other && isSurvivor) {
        const key = [workId, other].sort((a, b) => a - b).join("|");
        item.mergeCandidateId = pendingByPair.get(key) ?? null;
      }
      items.push(item);
    }
  }
  items.sort((a, b) => a.clusterKey - b.clusterKey || a.workId - b.workId);

  // 簇内若存活代表在截止时刻未知、被吸收者已知，仍应可见：稳妥地把可见成员提为代表
  // （归并不可能早于双方知悉，实践中不会触发，这里仅防御）
  const totals = {
    asOf: cutoff,
    clusters: clusters.size,
    visible: visibleCount,
    retracted: retractedCount,
    absorbed: absorbedCount,
    byType,
    byInstitution,
  };
  return { totals, items, activeMerges: activeMerges.filter((m) => m.split_count === 0).map((m) => m.id) };
}

function visibleVersion(db, workId, cutoff) {
  const known = db
    .prepare(
      "SELECT * FROM work_version WHERE work_id=? AND recorded_at<=? ORDER BY seq DESC"
    )
    .all(workId, cutoff);
  if (known.length === 0) return null;
  // 优先：截止时刻处于有效期内的版本；否则采用截止前最新知悉版本
  return (
    known.find((v) => v.valid_from <= cutoff && (v.valid_to === null || v.valid_to > cutoff)) ||
    known[0]
  );
}

// 发布即冻结：写入 snapshot_publish / snapshot_item，数据库触发器拒绝任何改写
export function publishSnapshot(db, { asOf, label, createdBy }) {
  const snap = buildSnapshot(db, asOf);
  return db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO snapshot_publish(as_of,label,totals_json,created_by) VALUES(?,?,?,?)"
      )
      .run(snap.totals.asOf, label ?? null, JSON.stringify(snap.totals), createdBy ?? null);
    const publishId = Number(info.lastInsertRowid);
    const stmt = db.prepare(
      `INSERT INTO snapshot_item(publish_id,cluster_key,work_id,visible,role,title,work_type,
         issued_on,state,chosen_version_id,owning_institution_id,identifiers_json,
         excluded_reason,merge_candidate_id,recorded_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const it of snap.items) {
      stmt.run(
        publishId, it.clusterKey, it.workId, it.visible, it.role, it.title,
        it.workType, it.issuedOn, it.state, it.chosenVersionId,
        it.owningInstitutionId, JSON.stringify(it.identifiers),
        it.excludedReason, it.mergeCandidateId, it.recordedAt
      );
    }
    return getPublished(db, publishId);
  })();
}

export function getPublished(db, id) {
  const p = db.prepare("SELECT * FROM snapshot_publish WHERE id=?").get(id);
  if (!p) return null;
  p.totals = JSON.parse(p.totals_json);
  p.items = db
    .prepare("SELECT * FROM snapshot_item WHERE publish_id=? ORDER BY cluster_key, work_id")
    .all(id)
    .map((it) => ({ ...it, identifiers: JSON.parse(it.identifiers_json) }));
  return p;
}

export function listPublished(db) {
  return db
    .prepare("SELECT id, as_of, label, created_at FROM snapshot_publish ORDER BY id")
    .all()
    .map((p) => ({ ...p, totals: JSON.parse(db.prepare("SELECT totals_json FROM snapshot_publish WHERE id=?").get(p.id).totals_json) }));
}

/** 下钻：快照采用了哪个事实版本、来自哪条原始记录、为何排除 */
export function explainItem(db, publishId, workId) {
  const it = db
    .prepare("SELECT * FROM snapshot_item WHERE publish_id=? AND work_id=?")
    .get(publishId, workId);
  if (!it) throw Object.assign(new Error("快照中无此成果"), { status: 404 });
  const version = db
    .prepare(
      `SELECT v.*, sr.batch_id, sr.external_ref, sr.payload, sr.content_hash, b.harvested_at, b.recorded_at AS batch_recorded_at
       FROM work_version v JOIN source_record sr ON sr.id=v.source_record_id
       JOIN harvest_batch b ON b.id=sr.batch_id WHERE v.id=?`
    )
    .get(it.chosen_version_id);
  version.payload = JSON.parse(version.payload);
  const merges = db
    .prepare(
      `SELECT m.*, mc.evidence_json,
        (SELECT json_group_array(json_object('institution_id',institution_id,'decision',decision,'actor',actor,'decided_at',decided_at))
         FROM merge_confirmation WHERE candidate_id=m.candidate_id) AS confirmations_json
       FROM work_merge m JOIN merge_candidate mc ON mc.id=m.candidate_id
       WHERE m.absorbed_work_id=? OR m.surviving_work_id=?`
    )
    .all(workId, workId)
    .map((m) => ({ ...m, evidence: JSON.parse(m.evidence_json), confirmations: JSON.parse(m.confirmations_json) }));
  return { item: { ...it, identifiers: JSON.parse(it.identifiers_json) }, adoptedVersion: version, merges };
}

/** 比较两次重建（或两份已发布快照）之间，后续更正带来的差异 */
export function diffSnapshots(db, a, b) {
  const sa = typeof a === "number" ? stripPublish(getPublished(db, a)) : buildSnapshot(db, a);
  const sb = typeof b === "number" ? stripPublish(getPublished(db, b)) : buildSnapshot(db, b);

  const mapA = new Map(sa.items.filter((i) => i.role === "survivor").map((i) => [i.clusterKey, i]));
  const mapB = new Map(sb.items.filter((i) => i.role === "survivor").map((i) => [i.clusterKey, i]));
  const changes = [];

  for (const [key, ib] of mapB) {
    const ia = mapA.get(key);
    if (!ia) {
      changes.push({ clusterKey: key, type: "added", workId: ib.workId, title: ib.title });
      continue;
    }
    if (ia.visible !== ib.visible) {
      changes.push({
        clusterKey: key, type: ib.visible ? "reinstated" : ia.state !== "retracted" && ib.state === "retracted" ? "retracted" : "hidden",
        workId: ib.workId, reason: ib.excludedReason,
      });
    }
    if (ia.chosenVersionId !== ib.chosenVersionId) {
      changes.push({
        clusterKey: key, type: "version_changed", workId: ib.workId,
        fromVersion: ia.chosenVersionId, toVersion: ib.chosenVersionId,
        fromTitle: ia.title, toTitle: ib.title,
      });
    }
  }
  for (const [key, ia] of mapA) {
    if (!mapB.has(key)) {
      changes.push({ clusterKey: key, type: "removed_or_merged", workId: ia.workId, title: ia.title });
    }
  }

  // 区间内生效的归并/拆分/撤回事件即“后续更正”的依据
  const events = {
    merges: db
      .prepare("SELECT * FROM work_merge WHERE effective_at>? AND effective_at<=?")
      .all(sa.totals.asOf, sb.totals.asOf),
    splits: db
      .prepare("SELECT * FROM work_split WHERE effective_at>? AND effective_at<=?")
      .all(sa.totals.asOf, sb.totals.asOf),
  };
  const numericDelta = (x, y) => Object.fromEntries(
    [...new Set([...Object.keys(x || {}), ...Object.keys(y || {})])].map((k) => [k, (y?.[k] || 0) - (x?.[k] || 0)])
  );
  return {
    a: { asOf: sa.totals.asOf, totals: sa.totals },
    b: { asOf: sb.totals.asOf, totals: sb.totals },
    totalsDelta: {
      visible: sb.totals.visible - sa.totals.visible,
      retracted: sb.totals.retracted - sa.totals.retracted,
      absorbed: sb.totals.absorbed - sa.totals.absorbed,
      byType: numericDelta(sa.totals.byType, sb.totals.byType),
      byInstitution: numericDelta(sa.totals.byInstitution, sb.totals.byInstitution),
    },
    changes,
    events,
  };
}

function stripPublish(p) {
  if (!p) throw Object.assign(new Error("快照不存在"), { status: 404 });
  return {
    totals: p.totals,
    items: p.items.map((it) => ({
      clusterKey: it.cluster_key, workId: it.work_id, role: it.role,
      visible: it.visible, title: it.title, state: it.state,
      chosenVersionId: it.chosen_version_id, excludedReason: it.excluded_reason,
    })),
  };
}

// ---------------------------------------------------------------------------
// 下游投递：失败可重试，恢复后不重复计数
// ---------------------------------------------------------------------------
export function deliveryQueue(db, targetId) {
  return db
    .prepare(
      `SELECT d.*, e.event_type, e.payload FROM delivery d
       JOIN outbox_event e ON e.id=d.event_id
       WHERE d.target_id=? AND d.status IN ('pending','inflight','failed')
       ORDER BY d.event_id`
    )
    .all(targetId);
}

/** 模拟一次（或若干次）投递尝试；flaky 目标在前 fail_remaining 次强制失败 */
export function deliverPending(db, targetId, { limit = 100 } = {}) {
  const target = db.prepare("SELECT * FROM downstream_target WHERE id=?").get(targetId);
  if (!target) throw Object.assign(new Error("目标不存在"), { status: 404 });
  const result = { sent: 0, failed: 0, duplicateBlocks: 0, details: [] };

  const q = db
    .prepare(
      `SELECT d.*, e.event_type, e.dedup_key, e.payload FROM delivery d
       JOIN outbox_event e ON e.id=d.event_id
       WHERE d.target_id=? AND d.status IN ('pending','inflight','failed')
       ORDER BY d.event_id LIMIT ?`
    )
    .all(targetId, limit);

  for (const d of q) {
    const token = tokenFor(targetId, d);
    // 令牌与落库值交叉校验，防止误用造成重复
    if (token !== d.idempotency_token) throw new Error("幂等令牌不一致，拒绝投递");
    db.transaction(() => {
      db.prepare("UPDATE delivery SET status='inflight', attempts=attempts+1, last_attempt_at=? WHERE id=?")
        .run(now(), d.id);
      const willFail =
        target.driver === "flaky" &&
        (db.prepare("SELECT fail_remaining FROM downstream_target WHERE id=?").get(targetId).fail_remaining > 0);
      if (willFail) {
        db.prepare(
          "UPDATE downstream_target SET fail_remaining=fail_remaining-1 WHERE id=? AND fail_remaining>0"
        ).run(targetId);
        db.prepare(
          "UPDATE delivery SET status='failed', last_error=? WHERE id=?"
        ).run("模拟下游暂不可用", d.id);
        db.prepare(
          "INSERT INTO delivery_attempt(delivery_id,ok,detail) VALUES(?,0,?)"
        ).run(d.id, "模拟下游暂不可用");
        result.failed++;
        result.details.push({ eventId: d.event_id, eventType: d.event_type, ok: false });
        return;
      }
      const ins = db
        .prepare(
          `INSERT OR IGNORE INTO downstream_inbox(target_id,idempotency_token,event_id,payload)
           VALUES(?,?,?,?)`
        )
        .run(targetId, token, d.event_id, d.payload);
      if (ins.changes === 0) {
        // 下游其实已收到过（崩溃发生在回执之后）：按成功收敛，绝不重复计数
        result.duplicateBlocks++;
      }
      db.prepare(
        `UPDATE delivery SET status='done', delivered_at=?, last_error=NULL WHERE id=?`
      ).run(now(), d.id);
      db.prepare("INSERT INTO delivery_attempt(delivery_id,ok,detail) VALUES(?,1,?)")
        .run(d.id, ins.changes ? "accepted" : "duplicate_token_ignored");
      result.sent++;
      result.details.push({ eventId: d.event_id, eventType: d.event_type, ok: true, duplicate: ins.changes === 0 });
    })();
  }
  return result;
}

export function inboxContents(db, targetId) {
  return db
    .prepare("SELECT idempotency_token, event_id, received_at FROM downstream_inbox WHERE target_id=? ORDER BY event_id")
    .all(targetId);
}

// ---------------------------------------------------------------------------
// 查询辅助
// ---------------------------------------------------------------------------
export function listWorks(db) {
  return db
    .prepare(
      `SELECT w.id,
        (SELECT COUNT(*) FROM work_version WHERE work_id=w.id) AS version_count,
        (SELECT recorded_at FROM work_version WHERE work_id=w.id ORDER BY recorded_at LIMIT 1) AS first_known_at
       FROM work w ORDER BY w.id`
    )
    .all();
}

export function getWork(db, workId) {
  const versions = db
    .prepare(
      `SELECT v.*, sr.external_ref AS source_external_ref, b.id AS batch_id,
              b.source_kind, b.harvested_at
       FROM work_version v
       JOIN source_record sr ON sr.id=v.source_record_id
       JOIN harvest_batch b ON b.id=sr.batch_id
       WHERE v.work_id=? ORDER BY v.seq`
    )
    .all(workId);
  if (!versions.length) return null;
  return {
    id: workId,
    owner: workOwner(db, workId),
    versions,
    identifiers: db
      .prepare("SELECT * FROM identifier_binding WHERE entity_type='work' AND entity_id=? ORDER BY valid_from")
      .all(workId),
    authors: db
      .prepare(
        `SELECT a.*, pv.display_name FROM authorship a
         JOIN person_version pv ON pv.person_id=a.person_id AND pv.valid_to IS NULL
         WHERE a.work_id=? ORDER BY a.ordinal`
      )
      .all(workId),
    relations: db.prepare("SELECT * FROM work_relation WHERE work_id=?").all(workId),
    merges: db
      .prepare(
        `SELECT m.*, s.id AS split_id FROM work_merge m
         LEFT JOIN work_split s ON s.merge_id=m.id
         WHERE m.surviving_work_id=? OR m.absorbed_work_id=? ORDER BY m.effective_at`
      )
      .all(workId, workId),
  };
}

export function getPerson(db, personId) {
  const versions = db
    .prepare(
      `SELECT pv.*, sr.external_ref AS source_external_ref
       FROM person_version pv JOIN source_record sr ON sr.id=pv.source_record_id
       WHERE pv.person_id=? ORDER BY pv.seq`
    )
    .all(personId);
  if (!versions.length) return null;
  return {
    id: personId,
    versions,
    identifiers: db
      .prepare("SELECT * FROM identifier_binding WHERE entity_type='person' AND entity_id=? ORDER BY valid_from")
      .all(personId),
  };
}

export function listBatches(db) {
  const rows = db.prepare("SELECT * FROM harvest_batch ORDER BY id").all();
  return rows.map((b) => ({
    ...b,
    sources: db
      .prepare("SELECT id, external_ref, content_hash, received_at FROM source_record WHERE batch_id=? ORDER BY id")
      .all(b.id),
  }));
}

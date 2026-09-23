-- 开放成果可见度账簿：归并、版本、快照与投递核心结构
-- 设计约定：
--   * source_record 原样保存来源载荷，永不修改；
--   * work_version / person_version 是机构事实链，追加写，带 [valid_from, valid_to)；
--   * recorded_at 为系统知悉时间（重建快照的截止轴），valid_from/valid_to 为现实有效期；
--   * 合并与拆分均为带时间的边，过期决策只影响其后的快照；
--   * snapshot_publish / snapshot_item 一经写入，触发器拒绝更新与删除。

PRAGMA foreign_keys = ON;

----------------------------------------------------------------------
-- 机构与抓取批次
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institution (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS harvest_batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id TEXT NOT NULL REFERENCES institution(id),
  source_kind TEXT NOT NULL,                         -- repository | journal | author_report | amendment
  external_batch_ref TEXT,
  harvested_at TEXT NOT NULL,                        -- 来源侧声称的抓取时间
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')), -- 本账簿知悉时间（快照截止轴）
  record_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE(institution_id, source_kind, external_batch_ref)
);

CREATE TABLE IF NOT EXISTS source_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES harvest_batch(id),
  institution_id TEXT NOT NULL REFERENCES institution(id),
  external_ref TEXT NOT NULL,                        -- 来源系统内记录号
  payload TEXT NOT NULL,                             -- 原样 JSON 载荷
  content_hash TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(institution_id, external_ref, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_source_record_batch ON source_record(batch_id);

----------------------------------------------------------------------
-- 成果（规范实体）与机构事实版本链
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 每个来源记录号在所属机构下对应唯一 work；不同机构的同一成果先各自成 work，
-- 经人工确认的归并才会合簇。
CREATE TABLE IF NOT EXISTS source_work_claim (
  institution_id TEXT NOT NULL REFERENCES institution(id),
  external_ref TEXT NOT NULL,
  work_id INTEGER NOT NULL REFERENCES work(id),
  PRIMARY KEY (institution_id, external_ref)
);

CREATE TABLE IF NOT EXISTS work_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES work(id),
  institution_id TEXT NOT NULL REFERENCES institution(id),
  source_record_id INTEGER NOT NULL REFERENCES source_record(id),
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  work_type TEXT,
  issued_on TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','retracted')),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(work_id, institution_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_work_version_work ON work_version(work_id, recorded_at);

----------------------------------------------------------------------
-- 作者与更名版本链
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS source_person_claim (
  institution_id TEXT NOT NULL REFERENCES institution(id),
  external_ref TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES person(id),
  PRIMARY KEY (institution_id, external_ref)
);

CREATE TABLE IF NOT EXISTS person_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES person(id),
  institution_id TEXT NOT NULL REFERENCES institution(id),
  source_record_id INTEGER NOT NULL REFERENCES source_record(id),
  seq INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(person_id, institution_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_person_version_person ON person_version(person_id, recorded_at);

----------------------------------------------------------------------
-- 带有效期的标识映射（DOI / 预印本号 / ORCID / 机构库 handle 等）
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identifier_binding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('work','person')),
  entity_id INTEGER NOT NULL,
  institution_id TEXT NOT NULL REFERENCES institution(id),
  source_record_id INTEGER NOT NULL REFERENCES source_record(id),
  id_type TEXT NOT NULL,
  id_value TEXT NOT NULL,
  id_norm TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_binding_entity ON identifier_binding(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_binding_lookup ON identifier_binding(entity_type, id_type, id_norm);

CREATE TABLE IF NOT EXISTS authorship (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES work(id),
  person_id INTEGER NOT NULL REFERENCES person(id),
  institution_id TEXT NOT NULL REFERENCES institution(id),
  source_record_id INTEGER NOT NULL REFERENCES source_record(id),
  ordinal INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_authorship_work ON authorship(work_id);
CREATE INDEX IF NOT EXISTS idx_authorship_person ON authorship(person_id);

-- 来源声明的成果间关系，如预印本转正式发表
CREATE TABLE IF NOT EXISTS work_relation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES work(id),
  institution_id TEXT NOT NULL REFERENCES institution(id),
  source_record_id INTEGER NOT NULL REFERENCES source_record(id),
  relation_kind TEXT NOT NULL,
  target_id_type TEXT NOT NULL,
  target_id_value TEXT NOT NULL,
  target_norm TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_work_relation_work ON work_relation(work_id);

----------------------------------------------------------------------
-- 候选重复、人工确认、归并与拆分（全部追加写，带生效时间）
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merge_candidate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  left_work_id INTEGER NOT NULL REFERENCES work(id),
  right_work_id INTEGER NOT NULL REFERENCES work(id),
  kind TEXT NOT NULL DEFAULT 'merge' CHECK (kind IN ('merge','split')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed_merged','rejected_split','split')),
  prior_merge_id INTEGER REFERENCES work_merge(id), -- split 候选所撤销的合并
  evidence_json TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  CHECK (left_work_id < right_work_id),
  CHECK (left_work_id <> right_work_id)
);

CREATE TABLE IF NOT EXISTS merge_confirmation (
  candidate_id INTEGER NOT NULL REFERENCES merge_candidate(id),
  institution_id TEXT NOT NULL REFERENCES institution(id),
  decision TEXT NOT NULL CHECK (decision IN ('merge','split','reject')),
  actor TEXT,
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (candidate_id, institution_id)
);

CREATE TABLE IF NOT EXISTS work_merge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES merge_candidate(id),
  surviving_work_id INTEGER NOT NULL REFERENCES work(id),
  absorbed_work_id INTEGER NOT NULL REFERENCES work(id),
  effective_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_merge_absorbed ON work_merge(absorbed_work_id);

CREATE TABLE IF NOT EXISTS work_split (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merge_id INTEGER NOT NULL REFERENCES work_merge(id),
  candidate_id INTEGER NOT NULL REFERENCES merge_candidate(id),
  reason TEXT,
  effective_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_split_merge ON work_split(merge_id);

----------------------------------------------------------------------
-- 下游更新：outbox + 每目标单行投递，token 幂等，失败可重试不重复
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS downstream_target (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  driver TEXT NOT NULL DEFAULT 'log' CHECK (driver IN ('log','flaky')),
  fail_remaining INTEGER NOT NULL DEFAULT 0, -- flaky：剩余强制失败次数，用于演练恢复
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 模拟下游收件箱：以幂等令牌为主键，重复投递直接冲突，证明不重复计数
CREATE TABLE IF NOT EXISTS downstream_inbox (
  target_id TEXT NOT NULL REFERENCES downstream_target(id),
  idempotency_token TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (target_id, idempotency_token)
);

CREATE TABLE IF NOT EXISTS outbox_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL REFERENCES downstream_target(id),
  event_id INTEGER NOT NULL REFERENCES outbox_event(id),
  idempotency_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','inflight','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TEXT,
  delivered_at TEXT,
  UNIQUE(target_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery(status);

CREATE TABLE IF NOT EXISTS delivery_attempt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL REFERENCES delivery(id),
  ok INTEGER NOT NULL,
  detail TEXT,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

----------------------------------------------------------------------
-- 已发布统计：冻结的快照与逐簇明细，触发器密封
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snapshot_publish (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of TEXT NOT NULL,
  label TEXT,
  totals_json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS snapshot_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publish_id INTEGER REFERENCES snapshot_publish(id), -- NULL 表示实时重建结果
  cluster_key INTEGER NOT NULL,                       -- 该截止时刻簇代表 work
  work_id INTEGER NOT NULL,
  visible INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('survivor','absorbed')),
  title TEXT,
  work_type TEXT,
  issued_on TEXT,
  state TEXT,
  chosen_version_id INTEGER REFERENCES work_version(id),
  owning_institution_id TEXT,
  identifiers_json TEXT NOT NULL DEFAULT '[]',
  excluded_reason TEXT,
  merge_candidate_id INTEGER,
  recorded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshot_item_publish ON snapshot_item(publish_id, cluster_key);

CREATE TRIGGER IF NOT EXISTS trg_snapshot_publish_no_update
BEFORE UPDATE ON snapshot_publish
BEGIN
  SELECT RAISE(ABORT, '已发布快照已密封，禁止修改');
END;
CREATE TRIGGER IF NOT EXISTS trg_snapshot_publish_no_delete
BEFORE DELETE ON snapshot_publish
BEGIN
  SELECT RAISE(ABORT, '已发布快照已密封，禁止删除');
END;
CREATE TRIGGER IF NOT EXISTS trg_snapshot_item_no_update
BEFORE UPDATE ON snapshot_item
WHEN OLD.publish_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '已发布快照明细已密封，禁止修改');
END;
CREATE TRIGGER IF NOT EXISTS trg_snapshot_item_no_delete
BEFORE DELETE ON snapshot_item
WHEN OLD.publish_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '已发布快照明细已密封，禁止删除');
END;

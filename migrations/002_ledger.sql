-- 002_ledger.sql — 开放成果可见度账簿核心结构
-- 设计要点：
--   * 来源记录与抓取批次不可变保存，同批次内 external_id 唯一；
--   * 成果以追加式版本演进：更正 / 撤回 / 恢复 / 归并都产生新版本，历史永不改写；
--   * 版本携带双时间：recorded_at（入账时间，即账簿何时得知）与 effective_at（事实生效时间），
--     支撑"按任意截止时间 + 当前知识"重建可见度快照；
--   * 作者与成果标识映射带有效期 [valid_from, valid_to)，同一标识任一时刻至多映射一个主体；
--   * 候选重复保存匹配依据，归并决议记录所需机构与双方确认；
--   * 已发布快照（kind='published'）每个截止时间唯一且不可抹改，重建视图（kind='rebuilt'）可刷新；
--   * 下游更新以幂等键保证恰好一次计数。

CREATE TABLE IF NOT EXISTS institutions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  merged_into_work_id TEXT REFERENCES works(id),
  merged_at TEXT
);

CREATE TABLE IF NOT EXISTS fetch_batches (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('institutional_repository','journal_platform','author_self_report')),
  fetched_at TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_records (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES fetch_batches(id),
  institution_id TEXT NOT NULL REFERENCES institutions(id),
  external_id TEXT NOT NULL,
  payload TEXT NOT NULL,            -- 原始载荷 JSON，原样保存
  record_hash TEXT NOT NULL,        -- 规范化载荷的 sha256，便于稽核
  matched_work_id TEXT REFERENCES works(id),  -- 抓取当时匹配到的成果（审计事实，不可变）
  received_at TEXT NOT NULL,
  UNIQUE (batch_id, external_id)
);

CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS duplicate_candidates (
  id TEXT PRIMARY KEY,
  work_a_id TEXT NOT NULL REFERENCES works(id),
  work_b_id TEXT NOT NULL REFERENCES works(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','split')),
  score REAL NOT NULL,
  evidence TEXT NOT NULL,           -- JSON [{rule, weight, detail}] 匹配依据
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (work_a_id, work_b_id)     -- 同一对成果只保留一条候选，人工决议不被重开
);

CREATE TABLE IF NOT EXISTS merge_decisions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES duplicate_candidates(id),
  decision TEXT NOT NULL CHECK (decision IN ('merge','split')),
  target_work_id TEXT REFERENCES works(id),
  reason TEXT NOT NULL,
  initiated_by TEXT NOT NULL REFERENCES institutions(id),
  required_institutions TEXT NOT NULL,  -- JSON [institution_id,...]，归并须全部确认
  status TEXT NOT NULL DEFAULT 'pending_confirmations' CHECK (status IN ('pending_confirmations','applied')),
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS merge_confirmations (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES merge_decisions(id),
  institution_id TEXT NOT NULL REFERENCES institutions(id),
  decided_by TEXT,
  note TEXT,
  decided_at TEXT NOT NULL,
  UNIQUE (decision_id, institution_id)
);

CREATE TABLE IF NOT EXISTS work_versions (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  version_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  authors TEXT NOT NULL,            -- JSON [{name, person_id?}]
  identifiers TEXT NOT NULL,        -- JSON {scheme: 规范化标识}
  output_type TEXT NOT NULL DEFAULT 'article',
  is_open_access INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('active','retracted')),
  change_reason TEXT NOT NULL CHECK (change_reason IN ('ingest','correction','retraction','restoration','merge')),
  source_record_id TEXT REFERENCES source_records(id),
  merge_decision_id TEXT REFERENCES merge_decisions(id),
  recorded_by TEXT NOT NULL REFERENCES institutions(id),
  recorded_at TEXT NOT NULL,        -- 入账时间（事务时间）
  effective_at TEXT NOT NULL,       -- 生效时间（事实时间）
  UNIQUE (work_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_versions_work_time ON work_versions (work_id, effective_at, recorded_at);

CREATE TABLE IF NOT EXISTS identifier_mappings (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('work','person')),
  subject_id TEXT NOT NULL,
  scheme TEXT NOT NULL,             -- doi / preprint_doi / pmid / orcid / name_variant ...
  identifier TEXT NOT NULL,         -- 规范化后的标识
  valid_from TEXT NOT NULL,
  valid_to TEXT,                    -- NULL 表示仍有效
  asserted_by TEXT NOT NULL REFERENCES institutions(id),
  evidence TEXT,
  recorded_at TEXT NOT NULL,
  superseded_by TEXT                -- 若被取代，指向新映射
);
-- 同一标识任一时刻至多映射一个主体
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_identifier ON identifier_mappings (scheme, identifier) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_mappings_subject ON identifier_mappings (subject_type, subject_id);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  cutoff_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('published','rebuilt')),
  metrics TEXT NOT NULL,            -- JSON 汇总数字
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_published_cutoff ON snapshots (cutoff_at) WHERE kind = 'published';
CREATE UNIQUE INDEX IF NOT EXISTS uq_rebuilt_cutoff ON snapshots (cutoff_at) WHERE kind = 'rebuilt';

CREATE TABLE IF NOT EXISTS snapshot_entries (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  work_id TEXT NOT NULL REFERENCES works(id),
  work_version_id TEXT REFERENCES work_versions(id),  -- 采用的版本
  included INTEGER NOT NULL,
  exclusion_reason TEXT,            -- retracted / merged_duplicate / not_open_access
  UNIQUE (snapshot_id, work_id)
);

CREATE TABLE IF NOT EXISTS downstream_updates (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  target TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT
);

-- 模拟下游统计接收方：计数器与更新状态同事务提交，保证恰好一次
CREATE TABLE IF NOT EXISTS downstream_stats (
  target TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (target, metric)
);

INSERT OR IGNORE INTO schema_version(version) VALUES (2);

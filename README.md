# 开放成果可见度账簿

科研管理部门每月从机构库、期刊平台和作者自报材料汇总开放成果。标题改写、预印本转正式发表、作者更名和撤稿会使同一成果被重复统计；本账簿提供**可复核的归并与统计能力**：完整保存来源、留痕每次归并决议、按任意截止时间重建可见度快照，并允许从汇总数字下钻到采用的版本与排除理由。

技术栈：Fastify + SQLite（better-sqlite3），迁移文件幂等可重复执行，服务只依赖本地数据库文件。

## 核心设计

### 不可变来源与批次

- 每次抓取是一个 `fetch_batches`（机构、来源类型、抓取时间）；每条来源是一个 `source_records`（原始载荷 JSON 原样保存 + 规范化载荷的 sha256）。
- 同批次内 `external_id` 唯一；下一批次重复投递同一条目不会产生重复成果，只会留下新的来源记录（审计事实）。

### 追加式版本与双时间

- 成果（`works`）的一切变化——摄入、更正、撤回、恢复、归并——都追加为新的 `work_versions`，历史永不改写。
- 每个版本携带双时间：
  - `recorded_at`：**入账时间**（账簿何时得知，即事务时间）；
  - `effective_at`：**生效时间**（事实何时生效，可由来源载荷显式指定，默认等于入账时间）。
- 快照按"截止时间 + 知识时间"选取采用版本：`effective_at <= cutoff AND recorded_at <= knowledge` 中最新的版本。已发布快照的知识时间冻结在发布时刻；重建视图使用当前知识——迟到的撤回通知（生效日期在过去）因此能正确改变过去截止时间的重建视图，同时不改动已发布数字。

### 带有效期的标识映射

- `identifier_mappings` 同时覆盖成果标识（doi、preprint_doi、pmid…）与作者标识（orcid、name_variant…），有效期 `[valid_from, valid_to)`。
- 同一标识任一时刻至多映射一个主体（部分唯一索引保证）；作者更名 = 关闭旧名映射有效期 + 断言新名映射。
- 归并时，源成果的活跃映射被关闭并重定向到目标成果（`superseded_by` 链接新旧映射）。

### 候选重复与人工决议

- 摄入时先做**精确标识匹配**（命中即关联同一成果），再做**模糊匹配**（标题相似度 + 作者重合度），达到阈值即生成 `duplicate_candidates` 并保存可读的**匹配依据**（`evidence: [{rule, weight, detail}]`）。
- 人工决议（`merge_decisions`）：
  - **拆分**：任一相关机构确认即生效；已决议的候选不会被后续批次重开。
  - **合并**：需候选双方涉及的全部机构确认（**跨机构归并须双方确认**），齐全后原子生效——目标成果追加归并版本（标识取并集），源成果标记 `merged_into_work_id`。
- 同一对成果只保留一条候选；待处理期间若有更强证据会刷新依据。

### 机构事实所有权

- 写操作要求 `x-institution-id` 请求头。
- 机构只能修订**自己提供的事实**：更正/撤回/恢复必须引用一条本机构提供、且关联到该成果的来源记录；标识映射只能为本机构提供过事实的成果/人员断言，只能关闭本机构断言的映射。

### 快照：发布、重建、下钻、差异

- `POST /snapshots` **发布**某截止时间的统计：每个截止时间至多一份已发布快照（`409 snapshot_exists`），**已发布统计不可抹改**。
- `POST /snapshots/rebuild` 以当前知识**重建**同一截止时间的视图（可刷新，不影响已发布）。
- 每份快照保存逐成果的 `snapshot_entries`：采用的版本、是否计入、排除理由（`retracted` / `merged_duplicate` / `not_open_access`）——从汇总数字可直接下钻。
- `GET /snapshots/diff?from=&to=` 比较两份快照：逐项列出新增/移除/变更的成果，并给出原因链（窗口内的新版本、归并决议），以及指标差值。

### 下游更新的恰好一次

- 每次发布生成一条带**幂等键**的 `downstream_updates`。
- 应用时计数器与更新状态在**同一事务**提交：失败不留半成品；重复应用返回 `already_applied` 不再计数；`POST /downstream-updates/recover` 重试全部失败项，恢复后不会重复计数。

## 运行与测试

```bash
npm install
npm test          # node --test，17 个用例覆盖摄入/归并/快照/下游/映射
npm run build     # 语法检查全部源码与测试
npm start         # 默认监听 8080，数据库文件 data/app.db（DB_PATH 可覆盖）
```

Docker：`docker build -t visibility-ledger . && docker run --rm -p 8080:8080 visibility-ledger`

## API 一览

写操作需请求头 `x-institution-id: <机构id>`。时间一律使用 UTC ISO 格式（`2026-01-31T00:00:00.000Z`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/institutions` | 注册机构 `{id?, name}` |
| POST | `/persons` | 注册人员 `{id?, display_name}` |
| POST | `/batches` | 开抓取批次 `{source_type, fetched_at?, note?}` |
| GET | `/batches/:id` | 批次及其来源记录 |
| POST | `/batches/:id/records` | 摄入来源记录 `{external_id, payload}` |
| GET | `/records/:id` | 来源记录原文与哈希 |
| GET | `/works/:id` | 成果当前版本、活跃映射、提供方 |
| GET | `/works/:id/versions` | 全部版本链 |
| POST | `/works/:id/versions` | 人工修订 `{source_record_id, change_reason, changes}` |
| POST | `/mappings` | 断言标识映射 `{subject_type, subject_id, scheme, identifier, valid_from?, valid_to?}` |
| POST | `/mappings/:id/close` | 关闭本机构断言的映射 |
| GET | `/mappings/resolve?scheme=&identifier=&at=` | 解析某时间点有效映射 |
| GET | `/duplicate-candidates?status=` | 候选重复列表（含匹配依据） |
| GET | `/duplicate-candidates/:id` | 候选详情（双方成果、决议） |
| POST | `/duplicate-candidates/:id/decisions` | 决议 `{decision: merge/split, target_work_id?, reason}` |
| POST | `/merge-decisions/:id/confirm` | 归并双方确认 |
| GET | `/merge-decisions/:id` | 决议与确认进度 |
| POST | `/snapshots` | 发布快照 `{cutoff_at}`（每截止时间唯一，不可抹改） |
| POST | `/snapshots/rebuild` | 以当前知识重建 `{cutoff_at}` 视图 |
| GET | `/snapshots` / `/snapshots/:id` | 快照列表 / 详情（含汇总指标） |
| GET | `/snapshots/:id/entries?included=&work_id=` | 下钻：采用版本与排除理由 |
| GET | `/snapshots/diff?from=&to=` | 比较两份快照的差异与原因 |
| GET | `/downstream-updates?status=` | 下游更新列表 |
| POST | `/downstream-updates/:id/apply` | 应用（幂等；`?fail=1` 模拟下游故障） |
| POST | `/downstream-updates/recover` | 恢复全部失败更新（不重复计数） |
| GET | `/downstream-stats` | 下游统计计数器 |

### 来源记录载荷

```json
{
  "title": "成果标题（必填）",
  "authors": ["姓名", {"name": "姓名", "person_id": "person-1"}],
  "identifiers": {"doi": "10.1000/j.xyz.1", "pmid": "12345"},
  "type": "article",
  "open_access": true,
  "status": "active",
  "effective_at": "2026-01-25T00:00:00.000Z"
}
```

- `status: "retracted"` 且当前为在版 → 生成撤回版本；恢复在版 → 生成恢复版本。
- `effective_at` 用于迟到事实（如撤回通知的生效日期），缺省为入账时间。

## 典型流程

1. **月度汇总**：各机构 `POST /batches` 开批次 → 逐条 `POST /batches/:id/records` 摄入；精确标识自动关联，疑似重复进入候选队列。
2. **人工归并**：查看 `GET /duplicate-candidates?status=pending` 的匹配依据 → 发起决议；跨机构合并由双方 `POST /merge-decisions/:id/confirm` 后生效。
3. **结项统计**：`POST /snapshots` 发布截止时间快照（生成幂等下游更新）→ `POST /downstream-updates/:id/apply` 推送下游；失败项用 `/downstream-updates/recover` 恢复。
4. **复核**：`GET /snapshots/:id/entries` 下钻每个数字采用的版本与排除理由；后续更正到达后 `POST /snapshots/rebuild` 重建同一截止时间，用 `GET /snapshots/diff` 对比差异与原因链。

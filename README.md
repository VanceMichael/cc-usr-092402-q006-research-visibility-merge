# 开放成果可见度账簿

面向科研管理部门的开放成果**可复核归并与统计**服务：完整留存机构库、期刊平台、作者自报三类来源的原始记录与抓取批次；以追加写版本链保存事实；对候选重复给出逐条匹配依据并由人工确认合并或拆分；撤回与恢复只产生新版本，已发布统计不可改写；可按任意截止时间重建可见度快照、从汇总数字下钻到采用的版本与排除理由，并比较后续更正差异。下游更新带幂等令牌，失败恢复后重放不会重复计数。

Fastify + better-sqlite3，无外部服务依赖。

## 数据模型要点

| 关注点 | 表 | 说明 |
| --- | --- | --- |
| 来源留存 | `harvest_batch`、`source_record` | 原始 JSON 载荷、内容哈希、抓取/知悉时间，永不修改；批次与记录均按自然键幂等 |
| 事实版本链 | `work_version`、`person_version` | 仅追加；带现实有效期 `[valid_from, valid_to)` 与账簿知悉时间 `recorded_at`（双时态） |
| 标识映射 | `identifier_binding` | DOI、预印本号、ORCID、handle 等，同样带有效期；新载荷撤销的标识关闭有效期但保留行 |
| 候选重复 | `merge_candidate`、`merge_confirmation` | 每条信号（共享标识、预印本关系、标题、作者重叠）附权重与分数；确认逐机构留痕 |
| 归并/拆分 | `work_merge`、`work_split` | 带生效时间，截止时间重建时按时点采信；拆分不删除合并记录 |
| 下游投递 | `outbox_event`、`delivery`、`downstream_inbox` | 事件去重键 → 每目标派生幂等令牌；收件箱以令牌为主键拒收重复 |
| 已发布统计 | `snapshot_publish`、`snapshot_item` | 发布即冻结，触发器拒绝 UPDATE/DELETE |

**权限边界**：机构只能对自己提供过事实版本的成果作归并/拆分确认（`recordDecision` 校验最新版本归属）；同机构重复只需一方确认，跨机构必须双方都确认，候选在双方到齐前保持 `pending`。

## 接口

- `POST /institutions`、`POST /downstream-targets`（`driver: log|flaky`，flaky 可设 `failRemaining` 演练中断恢复）
- `POST /batches`：导入一个抓取批次（载荷里 `kind: work|person`）；重投同批次同内容自动跳过
- `GET /batches`：批次及其原始记录（含哈希）
- `GET /works/:id`、`GET /persons/:id`：版本链、标识有效期、署名、关系、归并史
- `POST /candidates/scan`：扫描候选重复并写入证据
- `GET /candidates?status=pending`、`GET /candidates/:id`
- `POST /candidates/:id/decisions`：`{institutionId, decision: merge|split|reject, at}`
- `POST /merges/:id/split-request`：对已生效合并发起拆分复核（仍需双方确认）
- `GET /snapshots/rebuild?asOf=...`：按任意截止时间实时重建，不写库
- `POST /snapshots`：发布并冻结某截止时刻快照
- `GET /snapshots` / `/snapshots/:id`：列出/读取已发布快照
- `GET /snapshots/:id/items/:workId/explain`：下钻——采用的事实版本、来源批次、原始载荷、归并双方确认、排除理由
- `GET /snapshots/diff?a=...&b=...`：两时点（或两份已发布 ID）差异：新增/撤稿/恢复/版本变化/合并拆分事件与分类计数差
- `POST /downstream-targets/:id/recover`、`POST /downstream-targets/:id/deliver`、`GET .../queue`、`GET .../inbox`

## 典型复核流程

1. 各机构 `POST /batches` 月报；标题改写、预印本转正式发表、作者更名各自产生新版本，不覆盖历史。
2. 科研处 `POST /candidates/scan`，逐条审阅 `evidence.signals` 依据。
3. 跨机构候选等双方确认；误并可在日后由 `split-request` 重新走双方确认，拆分只影响之后的快照。
4. 结项时 `POST /snapshots` 冻结统计；任何撤稿/恢复/更正都不改变它，只在 diff 里呈现差异。
5. 下游中断时投递留在 `failed`；恢复后重放，收件箱按幂等令牌保证恰好一次计数。

## 开发检查

- 安装依赖：`npm install`
- 运行测试：`npm test`（领域端到端 + HTTP 集成，共 5 个用例）
- 编译检查：`npm run build`
- 容器：`docker build -t visibility-ledger . && docker run --rm -p 8080:8080 visibility-ledger`

数据库路径可用 `LEDGER_DB` 覆盖，端口用 `PORT`。迁移位于 `migrations/`，按版本号顺序自动应用且可重复执行。
